import type express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { disconnect, getDatabase, type Database } from "../../src/infrastructure/database/prisma.js";
import { truncateAll } from "../support/database.js";
import { E2E_JWT_CONFIG } from "../support/e2e.js";
import { createExposureRecorder } from "../support/exposure.js";
import { createUserWithRole, TEST_USER_PASSWORD } from "../support/users.js";

const TEST_JWT_CONFIG = E2E_JWT_CONFIG;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}$/;

/**
 * Suite End-to-End del ciclo de vida completo de una Receta (#22, Spec 06.1) sobre la app real
 * (`buildApp({ prisma })`) y PostgreSQL. Recorre el flujo productivo tras #48/ADR-0008: solo el
 * `ADMIN` inicial se siembra; los demás actores se registran por HTTP y el `ADMIN` promueve a los
 * revisores. Cada aprobación usa el `ETag` de la versión revisada (#46).
 */
describe("E2E — ciclo de vida completo de una Receta con auditoría (RN-01 a RN-10)", () => {
  let db: Database;
  let app: express.Express;
  const exposure = createExposureRecorder([TEST_JWT_CONFIG.secret, TEST_USER_PASSWORD]);

  beforeAll(() => {
    db = getDatabase();
    app = buildApp({
      prisma: db.prisma,
      jwt: TEST_JWT_CONFIG,
      publicRateLimit: false,
      authRateLimit: false,
      onLog: () => undefined,
      onError: () => undefined,
    });
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  afterEach(async () => {
    await truncateAll(db);
  });

  afterAll(async () => {
    await disconnect();
  });

  const bearer = (token: string) => `Bearer ${token}`;

  async function register(email: string, firstName: string): Promise<string> {
    const res = await exposure.track(
      request(app)
        .post("/api/v1/auth/register")
        .send({ email, password: TEST_USER_PASSWORD, firstName, lastName: "E2E" }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ email, role: "USER" });
    return String(res.body.data.id);
  }

  async function login(email: string): Promise<string> {
    const res = await exposure.track(
      request(app).post("/api/v1/auth/login").send({ email, password: TEST_USER_PASSWORD }),
    );
    expect(res.status).toBe(200);
    return String(res.body.data.token);
  }

  it("registro → promoción → alta DRAFT → lecturas → APPROVE (CHEF) → RESET_TO_DRAFT → APPROVE (NUTRITIONIST) → DELETE (ADMIN)", { timeout: 30_000 }, async () => {
    // 1. Único actor sembrado: el ADMIN inicial (seed / SQL manual, ADR-0008)
    const admin = await createUserWithRole(db, { email: "admin-e2e@recetaria.com", role: "ADMIN" });
    const adminToken = await login(admin.email);

    // 2. Registro público: siempre USER (RN-08, #48)
    const authorId = await register("autora-e2e@recetaria.com", "Autora");
    const chefId = await register("chef-e2e@recetaria.com", "Chef");
    const nutriId = await register("nutri-e2e@recetaria.com", "Nutri");

    // 3. El ADMIN promueve a los revisores (RN-09); el rol rige de inmediato (ADR-0009)
    for (const [id, role] of [[chefId, "CHEF"], [nutriId, "NUTRITIONIST"]] as const) {
      const res = await exposure.track(
        request(app).patch(`/api/v1/users/${id}/role`).set("Authorization", bearer(adminToken)).send({ role }),
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id, role, isActive: true });
    }

    // 4. Login de cada actor
    const authorToken = await login("autora-e2e@recetaria.com");
    const chefToken = await login("chef-e2e@recetaria.com");
    const nutriToken = await login("nutri-e2e@recetaria.com");

    // 5. Alta en DRAFT con authorId del token y slug automático (RN-01, RN-07)
    const created = await exposure.track(
      request(app)
        .post("/api/v1/recipes")
        .set("Authorization", bearer(authorToken))
        .send({
          title: "Guiso de lentejas sin TACC",
          description: "Lentejas, verduras y especias, apto para celíacos.",
          difficulty: "EASY",
          prepTimeMinutes: 45,
          tags: ["sin-tacc", "vegano"],
          ingredients: [
            { name: "Lentejas", quantity: 250, unit: "g" },
            { name: "Zanahoria", quantity: 2, unit: "u" },
          ],
        }),
    );
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ status: "DRAFT", authorId, reviewedById: null, publishedAt: null });
    expect(created.body.data.slug).toMatch(SLUG_PATTERN);
    const recipeId = String(created.body.data.id);

    // 6. Lecturas pública (catálogo y detalle) y privada (/mine)
    const catalog = await exposure.track(request(app).get("/api/v1/recipes"));
    expect(catalog.status).toBe(200);
    expect(catalog.body.data.items.map((r: { id: string }) => r.id)).toEqual([recipeId]);
    const mine = await exposure.track(request(app).get("/api/v1/recipes/mine").set("Authorization", bearer(authorToken)));
    expect(mine.status).toBe(200);
    expect(mine.body.data.meta).toMatchObject({ total: 1 });
    const mineAsChef = await exposure.track(request(app).get("/api/v1/recipes/mine").set("Authorization", bearer(chefToken)));
    expect(mineAsChef.body.data.meta).toMatchObject({ total: 0 });
    const detailV1 = await exposure.track(request(app).get(`/api/v1/recipes/${recipeId}`));
    expect(detailV1.status).toBe(200);
    const etagV1 = String(detailV1.headers.etag);
    expect(etagV1).toMatch(/^"\d+"$/);

    // 7. Primera aprobación por el CHEF con la versión revisada (RN-04, RN-05, #46)
    const approvedByChef = await exposure.track(
      request(app).put(`/api/v1/recipes/${recipeId}/approve`).set("Authorization", bearer(chefToken)).set("If-Match", etagV1),
    );
    expect(approvedByChef.status).toBe(200);
    expect(approvedByChef.body.data).toMatchObject({ status: "APPROVED", reviewedById: chefId });
    expect(approvedByChef.body.data.publishedAt).not.toBeNull();

    // 8. Edición por la Autora: reinicio a borrador (RN-02)
    const edited = await exposure.track(
      request(app).put(`/api/v1/recipes/${recipeId}`).set("Authorization", bearer(authorToken)).send({ prepTimeMinutes: 50 }),
    );
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ status: "DRAFT", reviewedById: null, publishedAt: null, prepTimeMinutes: 50 });

    // 9. Nueva versión: el ETag viejo ya no sirve (412) y el detalle entrega el vigente
    const stale = await exposure.track(
      request(app).put(`/api/v1/recipes/${recipeId}/approve`).set("Authorization", bearer(nutriToken)).set("If-Match", etagV1),
    );
    expect(stale.status).toBe(412);
    const detailV2 = await exposure.track(request(app).get(`/api/v1/recipes/${recipeId}`));
    const etagV2 = String(detailV2.headers.etag);
    expect(etagV2).not.toBe(etagV1);

    // 10. Segunda aprobación por la NUTRITIONIST
    const approvedByNutri = await exposure.track(
      request(app).put(`/api/v1/recipes/${recipeId}/approve`).set("Authorization", bearer(nutriToken)).set("If-Match", etagV2),
    );
    expect(approvedByNutri.status).toBe(200);
    expect(approvedByNutri.body.data).toMatchObject({ status: "APPROVED", reviewedById: nutriId });

    // 11. Borrado físico por el ADMIN (RN-03)
    const deleted = await exposure.track(request(app).delete(`/api/v1/recipes/${recipeId}`).set("Authorization", bearer(adminToken)));
    expect(deleted.status).toBe(200);
    expect(deleted.body.data).toEqual({ id: recipeId });
    expect((await exposure.track(request(app).get(`/api/v1/recipes/${recipeId}`))).status).toBe(404);

    // 12. Secuencia exacta de auditoría (RN-06): Recipe y User por separado. Las solicitudes son
    // secuenciales y cada transacción confirma antes de la siguiente, así que `createdAt` (NOW() de
    // cada transacción) es estrictamente creciente; `id` solo desempata de forma determinista.
    const recipeLogs = await db.prisma.auditLog.findMany({
      where: { entityName: "Recipe" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(recipeLogs.map((log) => [log.action, log.userId])).toEqual([
      ["APPROVE", chefId],
      ["RESET_TO_DRAFT", authorId],
      ["APPROVE", nutriId],
      ["DELETE", admin.id],
    ]);
    expect(recipeLogs.every((log) => log.entityId === recipeId)).toBe(true);
    const [firstApprove, reset, secondApprove, deletion] = recipeLogs;
    expect(firstApprove?.oldValues).toEqual({ status: "DRAFT", reviewedById: null, publishedAt: null });
    expect(firstApprove?.newValues).toMatchObject({ status: "APPROVED", reviewedById: chefId });
    expect(reset?.oldValues).toMatchObject({ status: "APPROVED", reviewedById: chefId });
    expect(reset?.newValues).toEqual({
      status: "DRAFT",
      reviewedById: null,
      publishedAt: null,
      changedFields: ["prepTimeMinutes"],
    });
    expect(secondApprove?.oldValues).toEqual({ status: "DRAFT", reviewedById: null, publishedAt: null });
    expect(secondApprove?.newValues).toMatchObject({ status: "APPROVED", reviewedById: nutriId });
    expect(deletion?.oldValues).toEqual({ title: "Guiso de lentejas sin TACC", authorId, status: "APPROVED" });
    expect(deletion?.newValues).toBeNull();

    const userLogs = await db.prisma.auditLog.findMany({
      where: { entityName: "User" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(userLogs.map((log) => [log.action, log.entityId, log.userId, log.newValues])).toEqual([
      ["ROLE_CHANGED", chefId, admin.id, { role: "CHEF" }],
      ["ROLE_CHANGED", nutriId, admin.id, { role: "NUTRITIONIST" }],
    ]);

    // Ninguna respuesta del recorrido expuso hashes, credenciales ni stack traces
    expect(exposure.count).toBeGreaterThan(15);
    exposure.assertNoSensitiveExposure();
  });
});
