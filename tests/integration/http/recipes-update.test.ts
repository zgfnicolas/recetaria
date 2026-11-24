import type express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../../src/app.js";
import { buildApiRouters } from "../../../src/bootstrap/container.js";
import {
  disconnect,
  getDatabase,
  type Database,
} from "../../../src/infrastructure/database/prisma.js";
import { createAuthMiddleware } from "../../../src/middlewares/auth.middleware.js";
import { DUMMY_BCRYPT_HASH, type JwtConfig, type UserRole } from "../../../src/modules/auth/index.js";
import {
  BUSINESS_VALIDATION_MESSAGE,
  createRecipeRouter,
  RECIPE_EDIT_FORBIDDEN_MESSAGE,
  RECIPE_NOT_FOUND_MESSAGE,
  RecipeController,
  RecipeRepository,
  RecipeService,
  UPDATE_REQUIRES_FIELD_MESSAGE,
} from "../../../src/modules/recipes/index.js";

const TEST_JWT_CONFIG: JwtConfig = {
  secret: "test-jwt-secret-".repeat(3),
  expiresIn: "1h",
};

const USERS = {
  author: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "USER" },
  chef: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", role: "CHEF" },
  admin: { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", role: "ADMIN" },
  other: { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", role: "USER" },
} as const satisfies Record<string, Readonly<{ id: string; role: UserRole }>>;

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const APPROVED_ID = "22222222-2222-4222-8222-222222222222";
const MISSING_ID = "99999999-9999-4999-8999-999999999999";
const DRAFT_SLUG = "borrador-original-0a1b2c3d";
const APPROVED_SLUG = "aprobada-original-0a1b2c3d";
const PUBLISHED_AT = new Date("2026-11-20T10:00:00.000Z");
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}$/;
const ROLLBACK_TRIGGER = "trg_test_20_fail_reset_audit";
const ROLLBACK_FUNCTION = "test_20_fail_reset_audit";

function bearer(user: Readonly<{ id: string; role: UserRole }>): string {
  return `Bearer ${jwt.sign({ id: user.id, role: user.role }, TEST_JWT_CONFIG.secret, { algorithm: "HS256", expiresIn: "1h" })}`;
}

async function truncateTables(db: Database): Promise<void> {
  await db.prisma.$executeRaw`TRUNCATE TABLE "audit_logs", "recipes", "users" RESTART IDENTITY;`;
}

async function seed(db: Database): Promise<void> {
  await db.prisma.user.createMany({
    data: Object.values(USERS).map((user, index) => ({
      id: user.id,
      role: user.role,
      email: `edicion-${String(index)}@recetaria.com`,
      passwordHash: DUMMY_BCRYPT_HASH,
      firstName: "Usuario",
      lastName: String(index),
    })),
  });
  const base = {
    description: "Descripción original de la receta.",
    difficulty: "HARD" as const,
    prepTimeMinutes: 30,
    tags: ["sin-tacc", "casero"],
    ingredients: [{ name: "Arroz", quantity: 200, unit: "g" }],
    nutritionalInfo: { calories: 400, servings: 2 },
    coverImageUrl: "https://cdn.recetaria.com/original.jpg",
    authorId: USERS.author.id,
  };
  await db.prisma.recipe.create({
    data: { ...base, id: DRAFT_ID, title: "Borrador original", slug: DRAFT_SLUG },
  });
  await db.prisma.recipe.create({
    data: {
      ...base,
      id: APPROVED_ID,
      title: "Aprobada original",
      slug: APPROVED_SLUG,
      status: "APPROVED",
      reviewedById: USERS.chef.id,
      publishedAt: PUBLISHED_AT,
    },
  });
}

async function dropRollbackTrigger(db: Database): Promise<void> {
  await db.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${ROLLBACK_TRIGGER} ON "audit_logs";`);
  await db.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${ROLLBACK_FUNCTION}();`);
}

/** Espera hasta que `expected` sesiones estén bloqueadas en un `SELECT … FOR UPDATE` de `recipes`. */
async function waitForLockWaiters(db: Database, expected: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await db.prisma.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query ILIKE '%"recipes"%FOR UPDATE%'`;
    if ((row?.waiting ?? 0) >= expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No se alcanzaron ${String(expected)} sesiones esperando el lock a tiempo`);
}

/**
 * Transacción externa que bloquea la fila hasta `release()`; `onLocked` corre dentro de ella
 * con el lock tomado y antes de liberarlo (p. ej. para aprobar la receta en la misma transacción).
 */
function holdRowLock(
  db: Database,
  recipeId: string,
  beforeCommit?: (tx: Parameters<Parameters<Database["prisma"]["$transaction"]>[0]>[0]) => Promise<void>,
): Readonly<{ locked: Promise<void>; release: () => void; done: Promise<void> }> {
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
      await tx.$queryRaw`SELECT id FROM "recipes" WHERE id = ${recipeId}::uuid FOR UPDATE`;
      markLocked();
      await released;
      if (beforeCommit !== undefined) {
        await beforeCommit(tx);
      }
    },
    { timeout: 15_000 },
  );
  return { locked, release: () => release(), done };
}

type RecipeBody = {
  success: boolean;
  statusCode: number;
  message: string;
  data: Record<string, unknown> & { slug: string; status: string };
};

describe("PUT /api/v1/recipes/:id — Edición por el Autor (Integración HTTP + PostgreSQL)", () => {
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
    await truncateTables(db);
    await seed(db);
  });

  afterEach(async () => {
    await truncateTables(db);
  });

  afterAll(async () => {
    await dropRollbackTrigger(db);
    await disconnect();
  });

  const put = (id: string, body: unknown, user: Readonly<{ id: string; role: UserRole }> = USERS.author) =>
    request(app).put(`/api/v1/recipes/${id}`).set("Authorization", bearer(user)).send(body as object);

  async function expectUntouched(id: string, slug: string): Promise<void> {
    const recipe = await db.prisma.recipe.findUniqueOrThrow({ where: { id } });
    expect(recipe).toMatchObject({ slug, prepTimeMinutes: 30, difficulty: "HARD", tags: ["sin-tacc", "casero"] });
    expect(await db.prisma.auditLog.count()).toBe(0);
  }

  describe("200 OK — Receta en DRAFT (sin auditoría)", () => {
    it("actualiza solo los campos enviados: no pisa difficulty ni tags y conserva el slug", async () => {
      // Act
      const res = await put(DRAFT_ID, { prepTimeMinutes: 45 });

      // Assert
      const body = res.body as RecipeBody;
      expect(res.status).toBe(200);
      expect(body).toMatchObject({
        success: true,
        statusCode: 200,
        message: "Receta actualizada exitosamente",
        data: { id: DRAFT_ID, prepTimeMinutes: 45, status: "DRAFT", slug: DRAFT_SLUG },
      });
      const persisted = await db.prisma.recipe.findUniqueOrThrow({ where: { id: DRAFT_ID } });
      expect(persisted).toMatchObject({
        prepTimeMinutes: 45,
        difficulty: "HARD",
        tags: ["sin-tacc", "casero"],
        title: "Borrador original",
        slug: DRAFT_SLUG,
        nutritionalInfo: { calories: 400, servings: 2 },
      });
      expect(await db.prisma.auditLog.count()).toBe(0);
    });

    it("regenera el slug cuando llega title", async () => {
      // Act
      const res = await put(DRAFT_ID, { title: "Arroz con Ñandú" });

      // Assert
      const body = res.body as RecipeBody;
      expect(res.status).toBe(200);
      expect(body.data.slug).toMatch(SLUG_PATTERN);
      expect(body.data.slug.startsWith("arroz-con-nandu-")).toBe(true);
      expect(body.data.slug).not.toBe(DRAFT_SLUG);
      const persisted = await db.prisma.recipe.findUniqueOrThrow({ where: { id: DRAFT_ID } });
      expect(persisted).toMatchObject({ title: "Arroz con Ñandú", slug: body.data.slug });
    });

    it("acepta una edición completa", async () => {
      // Arrange
      const full = {
        title: "Guiso completo",
        description: "Descripción completamente nueva del guiso.",
        difficulty: "EASY",
        prepTimeMinutes: 90,
        tags: ["invierno"],
        ingredients: [
          { name: "Lentejas", quantity: 300, unit: "g" },
          { name: "Agua", quantity: 1, unit: "l" },
        ],
        nutritionalInfo: { calories: 550, proteinGrams: 30 },
        coverImageUrl: "https://cdn.recetaria.com/guiso.jpg",
        videoUrl: "https://cdn.recetaria.com/guiso.mp4",
      };

      // Act
      const res = await put(DRAFT_ID, full);

      // Assert
      const body = res.body as RecipeBody;
      expect(res.status).toBe(200);
      expect(body.data).toMatchObject({ ...full, status: "DRAFT" });
      expect(body.data.slug.startsWith("guiso-completo-")).toBe(true);
      const persisted = await db.prisma.recipe.findUniqueOrThrow({ where: { id: DRAFT_ID } });
      expect(persisted).toMatchObject({ ...full, slug: body.data.slug, status: "DRAFT" });
      expect(await db.prisma.auditLog.count()).toBe(0);
    });

    it("vacía los opcionales con null (nutritionalInfo como SQL NULL, no JSON null)", async () => {
      // Act
      const res = await put(DRAFT_ID, { nutritionalInfo: null, coverImageUrl: null, videoUrl: null });

      // Assert
      expect(res.status).toBe(200);
      expect((res.body as RecipeBody).data).toMatchObject({
        nutritionalInfo: null,
        coverImageUrl: null,
        videoUrl: null,
      });
      const [row] = await db.prisma.$queryRaw<{ isSqlNull: boolean }[]>`
        SELECT "nutritionalInfo" IS NULL AS "isSqlNull" FROM "recipes" WHERE id = ${DRAFT_ID}::uuid`;
      expect(row?.isSqlNull).toBe(true);
    });
  });

  describe("200 OK — Receta APPROVED (Reinicio a Borrador atómico, RN-02/RN-06)", () => {
    it("reinicia a DRAFT, limpia revisor y fecha, y registra un único RESET_TO_DRAFT", async () => {
      // Act
      const res = await put(APPROVED_ID, { tags: ["vegano"], description: "Descripción corregida." });

      // Assert — respuesta y fila
      expect(res.status).toBe(200);
      expect((res.body as RecipeBody).data).toMatchObject({
        status: "DRAFT",
        reviewedById: null,
        publishedAt: null,
        tags: ["vegano"],
        slug: APPROVED_SLUG,
      });
      const persisted = await db.prisma.recipe.findUniqueOrThrow({ where: { id: APPROVED_ID } });
      expect(persisted).toMatchObject({ status: "DRAFT", reviewedById: null, publishedAt: null });

      // Assert — auditoría
      const logs = await db.prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        entityName: "Recipe",
        entityId: APPROVED_ID,
        action: "RESET_TO_DRAFT",
        userId: USERS.author.id,
        oldValues: {
          status: "APPROVED",
          reviewedById: USERS.chef.id,
          publishedAt: PUBLISHED_AT.toISOString(),
        },
        newValues: {
          status: "DRAFT",
          reviewedById: null,
          publishedAt: null,
          changedFields: ["description", "tags"],
        },
      });
    });

    it("incluye title y slug en changedFields cuando se renombra, y una segunda edición ya en DRAFT no audita", async () => {
      // Act
      const first = await put(APPROVED_ID, { title: "Aprobada renombrada" });
      const second = await put(APPROVED_ID, { prepTimeMinutes: 15 });

      // Assert
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const logs = await db.prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0]?.newValues).toMatchObject({ changedFields: ["slug", "title"] });
    });
  });

  describe("400 Bad Request", () => {
    it("rechaza {} con 400 (al menos un campo)", async () => {
      // Act
      const res = await put(DRAFT_ID, {});

      // Assert
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        success: false,
        statusCode: 400,
        errors: [{ field: "body", message: UPDATE_REQUIRES_FIELD_MESSAGE }],
      });
      await expectUntouched(DRAFT_ID, DRAFT_SLUG);
    });

    it.each(["status", "authorId", "reviewedById", "publishedAt", "slug"])(
      "rechaza el campo protegido %s (BOPLA) sin modificar la receta aprobada",
      async (field) => {
        // Act
        const res = await put(APPROVED_ID, { title: "Título válido", [field]: "x" });

        // Assert
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ errors: [{ field, message: "Campo no permitido" }] });
        const persisted = await db.prisma.recipe.findUniqueOrThrow({ where: { id: APPROVED_ID } });
        expect(persisted).toMatchObject({ status: "APPROVED", title: "Aprobada original" });
      },
    );

    it.each([
      [{ prepTimeMinutes: 0 }, "prepTimeMinutes"],
      [{ prepTimeMinutes: 1441 }, "prepTimeMinutes"],
      [{ ingredients: [{ name: "Sal", quantity: 0, unit: "g" }] }, "ingredients.0.quantity"],
    ])("rechaza %j por RN-07 sin escribir", async (body, field) => {
      // Act
      const res = await put(APPROVED_ID, body);

      // Assert
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        message: BUSINESS_VALIDATION_MESSAGE,
        errors: [expect.objectContaining({ field })],
      });
      const persisted = await db.prisma.recipe.findUniqueOrThrow({ where: { id: APPROVED_ID } });
      expect(persisted.status).toBe("APPROVED");
      expect(await db.prisma.auditLog.count()).toBe(0);
    });

    it("rechaza ingredients vacío y null en campos obligatorios", async () => {
      // Act
      const empty = await put(DRAFT_ID, { ingredients: [] });
      const nullTitle = await put(DRAFT_ID, { title: null });

      // Assert
      expect(empty.status).toBe(400);
      expect(nullTitle.status).toBe(400);
      await expectUntouched(DRAFT_ID, DRAFT_SLUG);
    });

    it("rechaza un :id que no es UUID v4", async () => {
      // Act
      const res = await put("abc", { title: "Título válido" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ errors: [{ field: "id" }] });
    });
  });

  describe("401 Unauthorized", () => {
    it.each([
      ["sin header Authorization", undefined],
      ["con token malformado", "Bearer no.es.jwt"],
      [
        "con JWT expirado",
        `Bearer ${jwt.sign({ id: USERS.author.id, role: "USER", exp: Math.floor(Date.now() / 1000) - 60 }, TEST_JWT_CONFIG.secret, { algorithm: "HS256" })}`,
      ],
    ])("responde 401 %s, antes de validar el body", async (_label, authorization) => {
      // Act
      const req = request(app).put(`/api/v1/recipes/${DRAFT_ID}`).send({});
      const res = await (authorization === undefined ? req : req.set("Authorization", authorization));

      // Assert
      expect(res.status).toBe(401);
      await expectUntouched(DRAFT_ID, DRAFT_SLUG);
    });
  });

  describe("403 Forbidden (RN-02)", () => {
    it.each([
      ["otro USER", USERS.other],
      ["un ADMIN", USERS.admin],
      ["el CHEF que la aprobó", USERS.chef],
    ])("rechaza la edición de %s sin modificar la receta", async (_label, user) => {
      // Act
      const res = await put(APPROVED_ID, { title: "Intento ajeno" }, user);

      // Assert
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        success: false,
        statusCode: 403,
        message: RECIPE_EDIT_FORBIDDEN_MESSAGE,
      });
      const persisted = await db.prisma.recipe.findUniqueOrThrow({ where: { id: APPROVED_ID } });
      expect(persisted).toMatchObject({ status: "APPROVED", title: "Aprobada original" });
      expect(await db.prisma.auditLog.count()).toBe(0);
    });
  });

  describe("404 Not Found", () => {
    it("responde 404 si el UUID v4 no existe", async () => {
      // Act
      const res = await put(MISSING_ID, { title: "Título válido" });

      // Assert
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ statusCode: 404, message: RECIPE_NOT_FOUND_MESSAGE });
    });
  });

  describe("409 Conflict", () => {
    /** App con `generateSlug` determinístico inyectado para forzar una colisión real (`P2002`). */
    function buildAppWithFixedSlug(slug: string): express.Express {
      const authGuard = createAuthMiddleware({ secret: TEST_JWT_CONFIG.secret });
      const service = new RecipeService(new RecipeRepository(db.prisma), { generateSlug: () => slug });
      const [authRouter] = buildApiRouters(db.prisma, { jwt: TEST_JWT_CONFIG });
      if (authRouter === undefined) {
        throw new Error("Router de auth no disponible");
      }
      return buildApp({
        prisma: db.prisma,
        jwt: TEST_JWT_CONFIG,
        apiRouters: [
          authRouter,
          { path: "/recipes", router: createRecipeRouter(new RecipeController(service), authGuard) },
        ],
        onLog: () => undefined,
        onError: () => undefined,
      });
    }

    const CONFLICT_BODY = {
      success: false,
      statusCode: 409,
      message: "Ya existe una receta con ese slug",
      errors: [],
    };

    it("devuelve 409 ante colisión real de slug (P2002) sobre una receta DRAFT sin modificarla", async () => {
      // Act
      const res = await request(buildAppWithFixedSlug(APPROVED_SLUG))
        .put(`/api/v1/recipes/${DRAFT_ID}`)
        .set("Authorization", bearer(USERS.author))
        .send({ title: "Título que colisiona" });

      // Assert
      expect(res.status).toBe(409);
      expect(res.body).toEqual(CONFLICT_BODY);
      const persisted = await db.prisma.recipe.findUniqueOrThrow({ where: { id: DRAFT_ID } });
      expect(persisted).toMatchObject({ title: "Borrador original", slug: DRAFT_SLUG });
    });

    it("sobre una receta APPROVED revierte también el reinicio: sigue APPROVED y sin auditoría", async () => {
      // Act
      const res = await request(buildAppWithFixedSlug(DRAFT_SLUG))
        .put(`/api/v1/recipes/${APPROVED_ID}`)
        .set("Authorization", bearer(USERS.author))
        .send({ title: "Título que colisiona" });

      // Assert
      expect(res.status).toBe(409);
      expect(res.body).toEqual(CONFLICT_BODY);
      const persisted = await db.prisma.recipe.findUniqueOrThrow({ where: { id: APPROVED_ID } });
      expect(persisted).toMatchObject({
        title: "Aprobada original",
        slug: APPROVED_SLUG,
        status: "APPROVED",
        reviewedById: USERS.chef.id,
        publishedAt: PUBLISHED_AT,
      });
      expect(await db.prisma.auditLog.count()).toBe(0);
    });
  });

  describe("Concurrencia con la Aprobación (decisión sobre la fila bloqueada)", () => {
    it("si una aprobación se confirma mientras la edición espera el lock, la edición reinicia a DRAFT y audita", async () => {
      // Arrange — la transacción externa aprueba la receta DRAFT y confirma recién cuando la
      // edición ya superó el chequeo del servicio (leyó DRAFT) y espera el lock de la fila.
      const holder = holdRowLock(db, DRAFT_ID, async (tx) => {
        await tx.recipe.update({
          where: { id: DRAFT_ID },
          data: { status: "APPROVED", reviewedById: USERS.chef.id, publishedAt: PUBLISHED_AT },
        });
      });
      await holder.locked;

      // Act
      const pending = put(DRAFT_ID, { prepTimeMinutes: 50 }).then((response) => response);
      try {
        await waitForLockWaiters(db, 1);
      } finally {
        holder.release();
        await holder.done;
      }
      const res = await pending;

      // Assert — nunca queda APPROVED un contenido editado sin revisar
      expect(res.status).toBe(200);
      const persisted = await db.prisma.recipe.findUniqueOrThrow({ where: { id: DRAFT_ID } });
      expect(persisted).toMatchObject({
        prepTimeMinutes: 50,
        status: "DRAFT",
        reviewedById: null,
        publishedAt: null,
      });
      const logs = await db.prisma.auditLog.findMany({ where: { entityId: DRAFT_ID } });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ action: "RESET_TO_DRAFT", userId: USERS.author.id });
    });

    it("si la edición confirma antes, una aprobación posterior aprueba el contenido ya editado", async () => {
      // Arrange
      const holder = holdRowLock(db, DRAFT_ID);
      await holder.locked;

      // Act — la edición espera el lock; al liberarse, edita; luego el CHEF aprueba
      const pending = put(DRAFT_ID, { prepTimeMinutes: 55 }).then((response) => response);
      try {
        await waitForLockWaiters(db, 1);
      } finally {
        holder.release();
        await holder.done;
      }
      const edited = await pending;
      // El revisor aprueba con el ETag vigente tras la edición (#46)
      const approved = await request(app)
        .put(`/api/v1/recipes/${DRAFT_ID}/approve`)
        .set("If-Match", String(edited.headers["etag"]))
        .set("Authorization", bearer(USERS.chef));

      // Assert
      expect(edited.status).toBe(200);
      expect(approved.status).toBe(200);
      const persisted = await db.prisma.recipe.findUniqueOrThrow({ where: { id: DRAFT_ID } });
      expect(persisted).toMatchObject({ prepTimeMinutes: 55, status: "APPROVED" });
      const actions = (await db.prisma.auditLog.findMany()).map((log) => log.action);
      expect(actions).toEqual(["APPROVE"]);
    });
  });

  describe("Atomicidad (RN-06)", () => {
    it("revierte la edición y el reinicio si falla la inserción de RESET_TO_DRAFT (500 redactado)", async () => {
      // `$executeRawUnsafe` solo porque el DDL no admite parámetros: interpola únicamente
      // constantes de este archivo (nunca entrada externa). No replicar este patrón en `src/`.
      try {
        await db.prisma.$executeRawUnsafe(`
          CREATE OR REPLACE FUNCTION ${ROLLBACK_FUNCTION}() RETURNS trigger AS $$
          BEGIN
            IF NEW."entityId" = '${APPROVED_ID}'::uuid THEN
              RAISE EXCEPTION 'fallo forzado de auditoría (prueba #20)';
            END IF;
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql;
        `);
        await db.prisma.$executeRawUnsafe(
          `CREATE TRIGGER ${ROLLBACK_TRIGGER} BEFORE INSERT ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION ${ROLLBACK_FUNCTION}();`,
        );

        // Act
        const res = await put(APPROVED_ID, { title: "Edición que debe revertirse" });

        // Assert
        expect(res.status).toBe(500);
        expect(res.body).toMatchObject({ success: false, statusCode: 500 });
        expect(JSON.stringify(res.body)).not.toContain("fallo forzado");
        const persisted = await db.prisma.recipe.findUniqueOrThrow({ where: { id: APPROVED_ID } });
        expect(persisted).toMatchObject({
          title: "Aprobada original",
          slug: APPROVED_SLUG,
          status: "APPROVED",
          reviewedById: USERS.chef.id,
          publishedAt: PUBLISHED_AT,
        });
        expect(await db.prisma.auditLog.count()).toBe(0);
      } finally {
        await dropRollbackTrigger(db);
      }
    });
  });
});
