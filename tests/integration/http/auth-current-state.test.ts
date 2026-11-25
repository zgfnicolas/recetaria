import { randomUUID } from "node:crypto";
import type express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../src/app.js";
import {
  disconnect,
  getDatabase,
  type Database,
} from "../../../src/infrastructure/database/prisma.js";
import type { JwtConfig, UserRole } from "../../../src/modules/auth/index.js";
import { createAuthMiddleware } from "../../../src/middlewares/auth.middleware.js";
import {
  createRecipeRouter,
  INVALID_AUTHOR_MESSAGE,
  RecipeController,
  RecipeRepository,
  RecipeService,
} from "../../../src/modules/recipes/index.js";
import { truncateAll } from "../../support/database.js";
import { createUserWithRole } from "../../support/users.js";

const TEST_JWT_CONFIG: JwtConfig = {
  secret: "test-jwt-secret-".repeat(3),
  expiresIn: "1h",
};

const VALID_RECIPE = {
  title: "Receta de prueba",
  description: "Descripción de prueba del estado vigente.",
  prepTimeMinutes: 10,
  ingredients: [{ name: "Sal", quantity: 1, unit: "g" }],
};

function bearerFor(user: Readonly<{ id: string; role: UserRole }>): string {
  return `Bearer ${jwt.sign({ id: user.id, role: user.role }, TEST_JWT_CONFIG.secret, { algorithm: "HS256", expiresIn: "1h" })}`;
}

/** Espera hasta que `expected` sesiones estén bloqueadas en una consulta que coincida con `pattern`. */
async function waitForLockWaiters(db: Database, pattern: string, expected = 1, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await db.prisma.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE ${pattern}`;
    if ((row?.waiting ?? 0) >= expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No se alcanzaron ${String(expected)} sesiones esperando el lock (${pattern}) a tiempo`);
}

/** Barrera: una transacción externa toma `lockSql` y, al liberarla, ejecuta `beforeCommit`. */
type TransactionClient = Parameters<Parameters<Database["prisma"]["$transaction"]>[0]>[0];

function holdLock(
  db: Database,
  lockSql: (tx: TransactionClient) => Promise<unknown>,
  beforeCommit: (tx: TransactionClient) => Promise<unknown> = () => Promise.resolve(),
) {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markLocked: () => void = () => undefined;
  const locked = new Promise<void>((resolve) => {
    markLocked = resolve;
  });
  const done = db.prisma.$transaction(
    async (tx) => {
      await lockSql(tx);
      markLocked();
      await released;
      await beforeCommit(tx);
    },
    { timeout: 15_000 },
  );
  return { locked, release: () => release(), done };
}

/**
 * Efecto transversal de ADR-0009 (#56): `authMiddleware` impone el estado y rol **vigentes** del
 * actor en la base en toda la API, aunque su JWT siga firmado y sin vencer.
 */
describe("authMiddleware con el estado vigente del actor (ADR-0009, #56, Integración HTTP + PostgreSQL)", () => {
  let db: Database;
  let app: express.Express;

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
    vi.restoreAllMocks();
    await truncateAll(db);
  });

  afterAll(async () => {
    await disconnect();
  });

  async function seedRecipe(authorId: string, slug: string) {
    return db.prisma.recipe.create({ data: { ...VALID_RECIPE, slug, authorId } });
  }

  it("un usuario desactivado con JWT vigente recibe 401 en todas sus operaciones (también las propias)", async () => {
    // Arrange
    const author = await createUserWithRole(db, { email: "autor@recetaria.com", role: "USER" });
    const own = await seedRecipe(author.id, "propia-0a1b2c3d");
    const token = bearerFor({ id: author.id, role: "USER" });
    await db.prisma.user.update({ where: { id: author.id }, data: { isActive: false } });
    const auth = (req: request.Test) => req.set("Authorization", token);

    // Act
    const responses = await Promise.all([
      auth(request(app).get("/api/v1/recipes/mine")),
      auth(request(app).post("/api/v1/recipes")).send(VALID_RECIPE),
      auth(request(app).put(`/api/v1/recipes/${own.id}`)).send({ prepTimeMinutes: 20 }),
      auth(request(app).delete(`/api/v1/recipes/${own.id}`)),
    ]);

    // Assert — mismo mensaje genérico que un token inválido; nada se escribió
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ success: false, message: "Token inválido o expirado" });
    }
    expect(await db.prisma.recipe.count()).toBe(1);
    expect((await db.prisma.recipe.findUniqueOrThrow({ where: { id: own.id } })).prepTimeMinutes).toBe(10);
  });

  it("un CHEF degradado a USER deja de aprobar de inmediato aunque su JWT diga CHEF (riesgo de #53 cerrado)", async () => {
    // Arrange
    const owner = await createUserWithRole(db, { email: "duena@recetaria.com", role: "USER" });
    const chef = await createUserWithRole(db, { email: "chef@recetaria.com", role: "CHEF" });
    const recipe = await seedRecipe(owner.id, "a-aprobar-0a1b2c3d");
    const token = bearerFor({ id: chef.id, role: "CHEF" });
    await db.prisma.user.update({ where: { id: chef.id }, data: { role: "USER" } });

    // Act
    const res = await request(app)
      .put(`/api/v1/recipes/${recipe.id}/approve`)
      .set("Authorization", token)
      .set("If-Match", '"1"');

    // Assert
    expect(res.status).toBe(403);
    expect((await db.prisma.recipe.findUniqueOrThrow({ where: { id: recipe.id } })).status).toBe("DRAFT");
    expect(await db.prisma.auditLog.count()).toBe(0);
  });

  it("un ADMIN degradado deja de borrar recetas ajenas de inmediato", async () => {
    // Arrange
    const owner = await createUserWithRole(db, { email: "duena@recetaria.com", role: "USER" });
    const admin = await createUserWithRole(db, { email: "admin@recetaria.com", role: "ADMIN" });
    const recipe = await seedRecipe(owner.id, "ajena-0a1b2c3d");
    const token = bearerFor({ id: admin.id, role: "ADMIN" });
    await db.prisma.user.update({ where: { id: admin.id }, data: { role: "USER" } });

    // Act
    const res = await request(app).delete(`/api/v1/recipes/${recipe.id}`).set("Authorization", token);

    // Assert
    expect(res.status).toBe(403);
    expect(await db.prisma.recipe.count({ where: { id: recipe.id } })).toBe(1);
  });

  it("un JWT con role ADMIN de un USER real se trata como USER (la base manda sobre el claim)", async () => {
    // Arrange — token firmado con el secreto pero con un claim de rol que no coincide con la base
    const user = await createUserWithRole(db, { email: "usuario@recetaria.com", role: "USER" });
    const victim = await createUserWithRole(db, { email: "otro@recetaria.com", role: "USER" });
    const forgedRoleToken = bearerFor({ id: user.id, role: "ADMIN" });

    // Act
    const res = await request(app)
      .patch(`/api/v1/users/${victim.id}/role`)
      .set("Authorization", forgedRoleToken)
      .send({ role: "ADMIN" });

    // Assert
    expect(res.status).toBe(403);
    expect((await db.prisma.user.findUniqueOrThrow({ where: { id: victim.id } })).role).toBe("USER");
  });

  it("un JWT de un id inexistente recibe 401 genérico", async () => {
    const res = await request(app)
      .get("/api/v1/recipes/mine")
      .set("Authorization", bearerFor({ id: randomUUID(), role: "ADMIN" }));
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ message: "Token inválido o expirado" });
  });

  it("si la base falla al resolver al actor, responde 5xx redactado y nunca 401", async () => {
    // Arrange
    const user = await createUserWithRole(db, { email: "usuario@recetaria.com", role: "USER" });
    vi.spyOn(db.prisma.user, "findUnique").mockRejectedValueOnce(new Error("conexión perdida con PostgreSQL"));

    // Act
    const res = await request(app).get("/api/v1/recipes/mine").set("Authorization", bearerFor({ id: user.id, role: "USER" }));

    // Assert
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.status).toBeLessThan(600);
    expect(res.body).toMatchObject({ success: false });
    expect(JSON.stringify(res.body)).not.toContain("PostgreSQL");
  });

  it("las rutas públicas ignoran el token: un usuario desactivado sigue leyendo el catálogo y sin lectura de users", async () => {
    // Arrange
    const user = await createUserWithRole(db, { email: "inactivo@recetaria.com", role: "USER", isActive: false });
    const spy = vi.spyOn(db.prisma.user, "findUnique");

    // Act
    const res = await request(app).get("/api/v1/recipes").set("Authorization", bearerFor({ id: user.id, role: "USER" }));

    // Assert
    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });

  it("defensa en profundidad: si el resolvedor dejara pasar a un actor borrado, el repositorio responde 401 (P2003)", async () => {
    // Arrange — app con un resolvedor permisivo (como el modo stateless anterior) para alcanzar las
    // ramas P2003 → 401 de recipes, que el resolvedor real hace inalcanzables en la práctica.
    const owner = await createUserWithRole(db, { email: "duena@recetaria.com", role: "USER" });
    const recipe = await seedRecipe(owner.id, "defensa-0a1b2c3d");
    const ghostId = randomUUID();
    const permissiveApp = (role: UserRole) => {
      const authGuard = createAuthMiddleware({
        secret: TEST_JWT_CONFIG.secret,
        resolveActor: (id) => Promise.resolve({ id, role }),
      });
      const service = new RecipeService(new RecipeRepository(db.prisma));
      return buildApp({
        prisma: db.prisma,
        jwt: TEST_JWT_CONFIG,
        apiRouters: [{ path: "/recipes", router: createRecipeRouter(new RecipeController(service), authGuard) }],
        onLog: () => undefined,
        onError: () => undefined,
      });
    };

    // Act
    const created = await request(permissiveApp("USER"))
      .post("/api/v1/recipes")
      .set("Authorization", bearerFor({ id: ghostId, role: "USER" }))
      .send(VALID_RECIPE);
    const approved = await request(permissiveApp("CHEF"))
      .put(`/api/v1/recipes/${recipe.id}/approve`)
      .set("Authorization", bearerFor({ id: ghostId, role: "CHEF" }))
      .set("If-Match", '"1"');
    const deleted = await request(permissiveApp("ADMIN"))
      .delete(`/api/v1/recipes/${recipe.id}`)
      .set("Authorization", bearerFor({ id: ghostId, role: "ADMIN" }));

    // Assert — 401 con el mensaje del repositorio y sin escrituras parciales
    for (const res of [created, approved, deleted]) {
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ message: INVALID_AUTHOR_MESSAGE });
    }
    expect(await db.prisma.recipe.count()).toBe(1);
    expect((await db.prisma.recipe.findUniqueOrThrow({ where: { id: recipe.id } })).status).toBe("DRAFT");
    expect(await db.prisma.auditLog.count()).toBe(0);
  });

  describe("ventana entre authMiddleware y la transacción cerrada (FOR SHARE del actor, ADR-0009)", () => {
    it("un CHEF degradado mientras su aprobación ya pasó el middleware recibe 403 y no aprueba", async () => {
      // Arrange — la degradación está en curso (fila del CHEF bloqueada) cuando llega la aprobación
      const owner = await createUserWithRole(db, { email: "duena@recetaria.com", role: "USER" });
      const chef = await createUserWithRole(db, { email: "chef@recetaria.com", role: "CHEF" });
      const recipe = await seedRecipe(owner.id, "carrera-aprobar-0a1b2c3d");
      const degradation = holdLock(
        db,
        (tx) => tx.$queryRaw`SELECT id FROM "users" WHERE id = ${chef.id}::uuid FOR UPDATE`,
        (tx) => tx.user.update({ where: { id: chef.id }, data: { role: "USER" } }),
      );
      await degradation.locked;

      // Act — authMiddleware lee el rol confirmado (CHEF, sin bloquearse); la transacción espera
      const pending = request(app)
        .put(`/api/v1/recipes/${recipe.id}/approve`)
        .set("Authorization", bearerFor({ id: chef.id, role: "CHEF" }))
        .set("If-Match", '"1"')
        .then((res) => res);
      try {
        await waitForLockWaiters(db, '%"users"%FOR SHARE%');
      } finally {
        degradation.release();
        await degradation.done;
      }
      const res = await pending;

      // Assert
      expect(res.status).toBe(403);
      expect((await db.prisma.recipe.findUniqueOrThrow({ where: { id: recipe.id } })).status).toBe("DRAFT");
      expect(await db.prisma.auditLog.count()).toBe(0);
    });

    it("un ADMIN desactivado mientras su borrado ya pasó el middleware recibe 401 y no borra", async () => {
      // Arrange
      const owner = await createUserWithRole(db, { email: "duena@recetaria.com", role: "USER" });
      const admin = await createUserWithRole(db, { email: "admin@recetaria.com", role: "ADMIN" });
      const recipe = await seedRecipe(owner.id, "carrera-borrar-0a1b2c3d");
      const deactivation = holdLock(
        db,
        (tx) => tx.$queryRaw`SELECT id FROM "users" WHERE id = ${admin.id}::uuid FOR UPDATE`,
        (tx) => tx.user.update({ where: { id: admin.id }, data: { isActive: false } }),
      );
      await deactivation.locked;

      // Act
      const pending = request(app)
        .delete(`/api/v1/recipes/${recipe.id}`)
        .set("Authorization", bearerFor({ id: admin.id, role: "ADMIN" }))
        .then((res) => res);
      try {
        await waitForLockWaiters(db, '%"users"%FOR SHARE%');
      } finally {
        deactivation.release();
        await deactivation.done;
      }
      const res = await pending;

      // Assert
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ message: INVALID_AUTHOR_MESSAGE });
      expect(await db.prisma.recipe.count({ where: { id: recipe.id } })).toBe(1);
      expect(await db.prisma.auditLog.count()).toBe(0);
    });

    it("orden inverso sin interbloqueo: si la aprobación ya tomó el lock, la degradación espera y ambas terminan", async () => {
      // Arrange — la receta bloqueada retiene la aprobación después de que bloqueó al CHEF
      const owner = await createUserWithRole(db, { email: "duena@recetaria.com", role: "USER" });
      const chef = await createUserWithRole(db, { email: "chef@recetaria.com", role: "CHEF" });
      const admin = await createUserWithRole(db, { email: "admin@recetaria.com", role: "ADMIN" });
      const recipe = await seedRecipe(owner.id, "orden-inverso-0a1b2c3d");
      const recipeHolder = holdLock(db, (tx) => tx.$queryRaw`SELECT id FROM "recipes" WHERE id = ${recipe.id}::uuid FOR UPDATE`);
      await recipeHolder.locked;

      // Act
      const approval = request(app)
        .put(`/api/v1/recipes/${recipe.id}/approve`)
        .set("Authorization", bearerFor({ id: chef.id, role: "CHEF" }))
        .set("If-Match", '"1"')
        .then((res) => res);
      let degradation: Promise<request.Response> | undefined;
      try {
        await waitForLockWaiters(db, '%"recipes"%FOR UPDATE%');
        degradation = request(app)
          .patch(`/api/v1/users/${chef.id}/role`)
          .set("Authorization", bearerFor({ id: admin.id, role: "ADMIN" }))
          .send({ role: "USER" })
          .then((res) => res);
        await waitForLockWaiters(db, '%"users"%FOR NO KEY UPDATE%');
      } finally {
        recipeHolder.release();
        await recipeHolder.done;
      }
      const [approved, degraded] = await Promise.all([approval, degradation]);

      // Assert — la aprobación era legítima al empezar; la degradación se aplica después
      expect(approved.status).toBe(200);
      expect(degraded?.status).toBe(200);
      expect((await db.prisma.recipe.findUniqueOrThrow({ where: { id: recipe.id } })).status).toBe("APPROVED");
      expect((await db.prisma.user.findUniqueOrThrow({ where: { id: chef.id } })).role).toBe("USER");
      const actions = (await db.prisma.auditLog.findMany({ orderBy: { createdAt: "asc" } })).map((log) => log.action);
      expect(actions).toEqual(["APPROVE", "ROLE_CHANGED"]);
    });
  });
});
