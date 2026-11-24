import { randomUUID } from "node:crypto";
import type express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { buildApp } from "../../../src/app.js";
import {
  disconnect,
  getDatabase,
  type Database,
} from "../../../src/infrastructure/database/prisma.js";
import {
  DUMMY_BCRYPT_HASH,
  type JwtConfig,
  type UserRole,
} from "../../../src/modules/auth/index.js";
import {
  INVALID_AUTHOR_MESSAGE,
  RECIPE_ALREADY_APPROVED_MESSAGE,
  RECIPE_APPROVAL_FORBIDDEN_MESSAGE,
  RECIPE_NOT_FOUND_MESSAGE,
  RECIPE_VERSION_MISMATCH_MESSAGE,
} from "../../../src/modules/recipes/index.js";

const TEST_JWT_CONFIG: JwtConfig = {
  secret: "test-jwt-secret-".repeat(3),
  expiresIn: "1h",
};

const USERS = {
  author: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "USER" },
  chef: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", role: "CHEF" },
  nutritionist: {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    role: "NUTRITIONIST",
  },
  admin: { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", role: "ADMIN" },
  user: { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", role: "USER" },
} as const satisfies Record<string, Readonly<{ id: string; role: UserRole }>>;

/** Receta `DRAFT` del Autor `USER`. */
const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
/** Receta `DRAFT` cuyo Autor es el `CHEF` (auto-aprobación). */
const CHEF_OWN_ID = "22222222-2222-4222-8222-222222222222";
/** Receta `DRAFT` cuyo Autor es el `NUTRITIONIST` (auto-aprobación). */
const NUTRI_OWN_ID = "33333333-3333-4333-8333-333333333333";
const MISSING_ID = "99999999-9999-4999-8999-999999999999";
/** ETag vigente de las recetas sembradas (`version = 1`, #46); el contrato exige `If-Match`. */
const CURRENT_ETAG = '"1"';
const ROLLBACK_TRIGGER = "trg_test_19_fail_audit_insert";
const ROLLBACK_FUNCTION = "test_19_fail_audit_insert";

function bearer(user: Readonly<{ id: string; role: UserRole }>): string {
  return `Bearer ${jwt.sign({ id: user.id, role: user.role }, TEST_JWT_CONFIG.secret, { algorithm: "HS256", expiresIn: "1h" })}`;
}

async function truncateTables(db: Database): Promise<void> {
  await db.prisma
    .$executeRaw`TRUNCATE TABLE "audit_logs", "recipes", "users" RESTART IDENTITY;`;
}

async function seed(db: Database): Promise<void> {
  await db.prisma.user.createMany({
    data: Object.values(USERS).map((user, index) => ({
      id: user.id,
      role: user.role,
      email: `aprobacion-${String(index)}@recetaria.com`,
      passwordHash: DUMMY_BCRYPT_HASH,
      firstName: "Usuario",
      lastName: String(index),
    })),
  });
  await db.prisma.recipe.createMany({
    data: [
      { id: DRAFT_ID, authorId: USERS.author.id, slug: "draft-0a1b2c3d" },
      { id: CHEF_OWN_ID, authorId: USERS.chef.id, slug: "chef-own-0a1b2c3d" },
      {
        id: NUTRI_OWN_ID,
        authorId: USERS.nutritionist.id,
        slug: "nutri-own-0a1b2c3d",
      },
    ].map((recipe) => ({
      ...recipe,
      title: "Receta a aprobar",
      description: "Descripción de prueba de aprobación.",
      prepTimeMinutes: 30,
      ingredients: [{ name: "Sal", quantity: 1, unit: "g" }],
    })),
  });
}

async function dropRollbackTrigger(db: Database): Promise<void> {
  await db.prisma.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS ${ROLLBACK_TRIGGER} ON "audit_logs";`,
  );
  await db.prisma.$executeRawUnsafe(
    `DROP FUNCTION IF EXISTS ${ROLLBACK_FUNCTION}();`,
  );
}

/** Espera hasta que `expected` sesiones de esta base estén bloqueadas esperando un lock. */
async function waitForLockWaiters(
  db: Database,
  expected: number,
  timeoutMs = 10_000,
): Promise<void> {
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
  throw new Error(
    `No se alcanzaron ${String(expected)} sesiones esperando el lock a tiempo`,
  );
}

type RecipeBody = {
  success: boolean;
  statusCode: number;
  message: string;
  data: {
    id: string;
    status: string;
    reviewedById: string | null;
    publishedAt: string | null;
  };
};

describe("PUT /api/v1/recipes/:id/approve — Aprobación profesional (Integración HTTP + PostgreSQL)", () => {
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

  async function expectUnchangedDraft(id: string): Promise<void> {
    const recipe = await db.prisma.recipe.findUniqueOrThrow({ where: { id } });
    expect(recipe).toMatchObject({
      status: "DRAFT",
      reviewedById: null,
      publishedAt: null,
    });
    expect(await db.prisma.auditLog.count()).toBe(0);
  }

  describe("200 OK — DRAFT → APPROVED con Registro de Auditoría atómico (RN-06)", () => {
    it.each([
      ["CHEF", USERS.chef],
      ["NUTRITIONIST", USERS.nutritionist],
    ])(
      "un %s distinto del Autor aprueba la receta",
      async (_label, reviewer) => {
        // Arrange
        const before = Date.now();

        // Act
        const res = await request(app)
          .put(`/api/v1/recipes/${DRAFT_ID}/approve`)
          .set("If-Match", CURRENT_ETAG)
          .set("Authorization", bearer(reviewer));

        // Assert — respuesta JSend
        const body = res.body as RecipeBody;
        expect(res.status).toBe(200);
        expect(body).toMatchObject({
          success: true,
          statusCode: 200,
          message: "Receta aprobada exitosamente",
          data: { id: DRAFT_ID, status: "APPROVED", reviewedById: reviewer.id },
        });

        // Assert — fila persistida
        const persisted = await db.prisma.recipe.findUniqueOrThrow({
          where: { id: DRAFT_ID },
        });
        expect(persisted.status).toBe("APPROVED");
        expect(persisted.reviewedById).toBe(reviewer.id);
        expect(persisted.publishedAt).not.toBeNull();
        const publishedAt = persisted.publishedAt?.getTime() ?? 0;
        expect(publishedAt).toBeGreaterThanOrEqual(before - 1000);
        expect(publishedAt).toBeLessThanOrEqual(Date.now() + 1000);
        expect(body.data.publishedAt).toBe(
          persisted.publishedAt?.toISOString(),
        );

        // Assert — exactamente 1 Registro de Auditoría APPROVE coherente con la fila
        const logs = await db.prisma.auditLog.findMany();
        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatchObject({
          entityName: "Recipe",
          entityId: DRAFT_ID,
          action: "APPROVE",
          userId: reviewer.id,
          oldValues: { status: "DRAFT", reviewedById: null, publishedAt: null },
          newValues: {
            status: "APPROVED",
            reviewedById: reviewer.id,
            publishedAt: persisted.publishedAt?.toISOString(),
          },
        });
      },
    );
  });

  describe("400 Bad Request", () => {
    it.each(["abc", "6f1c2d3e-4b5a-1c6d-8e7f-0123456789ab"])(
      "rechaza :id = %s con token y rol válidos",
      async (id) => {
        // Act
        const res = await request(app)
          .put(`/api/v1/recipes/${id}/approve`)
          .set("If-Match", CURRENT_ETAG)
          .set("Authorization", bearer(USERS.chef));

        // Assert
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({
          success: false,
          statusCode: 400,
          errors: [{ field: "id", message: "id debe ser un UUID v4 válido" }],
        });
      },
    );
  });

  describe("401 Unauthorized", () => {
    it.each([
      ["sin header Authorization", undefined],
      ["con token malformado", "Bearer no.es.jwt"],
      [
        "con JWT expirado",
        `Bearer ${jwt.sign({ id: USERS.chef.id, role: "CHEF", exp: Math.floor(Date.now() / 1000) - 60 }, TEST_JWT_CONFIG.secret, { algorithm: "HS256" })}`,
      ],
    ])(
      "responde 401 %s, sin modificar la receta",
      async (_label, authorization) => {
        // Act
        const req = request(app).put(`/api/v1/recipes/${DRAFT_ID}/approve`).set("If-Match", CURRENT_ETAG);
        const res = await (authorization === undefined
          ? req
          : req.set("Authorization", authorization));

        // Assert
        expect(res.status).toBe(401);
        await expectUnchangedDraft(DRAFT_ID);
      },
    );

    it("autentica antes de validar: :id inválido sin token responde 401, no 400", async () => {
      // Act
      const res = await request(app).put("/api/v1/recipes/abc/approve").set("If-Match", CURRENT_ETAG);

      // Assert
      expect(res.status).toBe(401);
    });

    it("responde 401 si el revisor del JWT ya no existe en users (P2003), sin escritura parcial", async () => {
      // Arrange
      const ghost = { id: randomUUID(), role: "CHEF" } as const;

      // Act
      const res = await request(app)
        .put(`/api/v1/recipes/${DRAFT_ID}/approve`)
        .set("If-Match", CURRENT_ETAG)
        .set("Authorization", bearer(ghost));

      // Assert
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        success: false,
        message: INVALID_AUTHOR_MESSAGE,
      });
      await expectUnchangedDraft(DRAFT_ID);
    });
  });

  describe("403 Forbidden", () => {
    it.each([
      ["USER", USERS.user],
      ["ADMIN", USERS.admin],
    ])("rechaza el rol %s en rbacMiddleware (RN-04)", async (_label, actor) => {
      // Act
      const res = await request(app)
        .put(`/api/v1/recipes/${DRAFT_ID}/approve`)
        .set("If-Match", CURRENT_ETAG)
        .set("Authorization", bearer(actor));

      // Assert
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        success: false,
        statusCode: 403,
        message: "No tienes permisos para realizar esta acción",
      });
      await expectUnchangedDraft(DRAFT_ID);
    });

    it("RBAC va antes de validar: un USER con :id inválido recibe 403, no 400", async () => {
      // Act
      const res = await request(app)
        .put("/api/v1/recipes/abc/approve")
        .set("If-Match", CURRENT_ETAG)
        .set("Authorization", bearer(USERS.user));

      // Assert
      expect(res.status).toBe(403);
    });

    it.each([
      ["CHEF", USERS.chef, CHEF_OWN_ID],
      ["NUTRITIONIST", USERS.nutritionist, NUTRI_OWN_ID],
    ])(
      "bloquea la auto-aprobación de un %s (RN-05)",
      async (_label, reviewer, recipeId) => {
        // Act
        const res = await request(app)
          .put(`/api/v1/recipes/${recipeId}/approve`)
          .set("If-Match", CURRENT_ETAG)
          .set("Authorization", bearer(reviewer));

        // Assert
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({
          success: false,
          statusCode: 403,
          message: RECIPE_APPROVAL_FORBIDDEN_MESSAGE,
        });
        await expectUnchangedDraft(recipeId);
      },
    );
  });

  describe("404 Not Found", () => {
    it("responde 404 si el UUID v4 no existe", async () => {
      // Act
      const res = await request(app)
        .put(`/api/v1/recipes/${MISSING_ID}/approve`)
        .set("If-Match", CURRENT_ETAG)
        .set("Authorization", bearer(USERS.chef));

      // Assert
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        success: false,
        statusCode: 404,
        message: RECIPE_NOT_FOUND_MESSAGE,
      });
      expect(await db.prisma.auditLog.count()).toBe(0);
    });
  });

  it("responde 404 si la receta se borra mientras la aprobación espera el lock de fila", async () => {
    // Arrange — una transacción externa bloquea la fila, espera a que la aprobación quede
    // bloqueada en su `SELECT … FOR UPDATE` (ya superó el chequeo del servicio) y la borra.
    let releaseLock: () => void = () => undefined;
    const lockReleased = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let markLocked: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const holder = db.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "recipes" WHERE id = ${DRAFT_ID}::uuid FOR UPDATE`;
        markLocked();
        await lockReleased;
        await tx.recipe.delete({ where: { id: DRAFT_ID } });
      },
      { timeout: 15_000 },
    );
    await locked;

    // Act
    // `.then()` dispara el envío ya: Supertest no ejecuta el request hasta que se lo consume.
    const pending = request(app)
      .put(`/api/v1/recipes/${DRAFT_ID}/approve`)
      .set("If-Match", CURRENT_ETAG)
      .set("Authorization", bearer(USERS.chef))
      .then((response) => response);
    try {
      await waitForLockWaiters(db, 1);
    } finally {
      releaseLock();
      await holder;
    }
    const res = await pending;

    // Assert
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      success: false,
      statusCode: 404,
      message: RECIPE_NOT_FOUND_MESSAGE,
    });
    expect(await db.prisma.auditLog.count()).toBe(0);
  });

  describe("409 Conflict", () => {
    it("rechaza la doble aprobación secuencial conservando al primer revisor y un único registro", async () => {
      // Arrange
      const first = await request(app)
        .put(`/api/v1/recipes/${DRAFT_ID}/approve`)
        .set("If-Match", CURRENT_ETAG)
        .set("Authorization", bearer(USERS.chef));
      expect(first.status).toBe(200);

      // Act — con el ETag vigente tras la primera aprobación (versión 2): ya no hay nada que aprobar
      const second = await request(app)
        .put(`/api/v1/recipes/${DRAFT_ID}/approve`)
        .set("If-Match", String(first.headers["etag"]))
        .set("Authorization", bearer(USERS.nutritionist));
      // Con el ETag viejo (versión 1), la versión revisada ya no es la vigente: 412 antes que 409 (#46)
      const stale = await request(app)
        .put(`/api/v1/recipes/${DRAFT_ID}/approve`)
        .set("If-Match", CURRENT_ETAG)
        .set("Authorization", bearer(USERS.nutritionist));

      // Assert
      expect(first.headers["etag"]).toBe('"2"');
      expect(stale.status).toBe(412);
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({
        success: false,
        statusCode: 409,
        message: RECIPE_ALREADY_APPROVED_MESSAGE,
      });
      const persisted = await db.prisma.recipe.findUniqueOrThrow({
        where: { id: DRAFT_ID },
      });
      expect(persisted.reviewedById).toBe(USERS.chef.id);
      expect(
        await db.prisma.auditLog.count({ where: { action: "APPROVE" } }),
      ).toBe(1);
    });

    it("ante dos aprobaciones concurrentes, una gana (200), la otra recibe 412 y queda 1 único registro", async () => {
      // Arrange — barrera determinista: una transacción externa toma el lock de la fila, así
      // ambas solicitudes superan el chequeo del servicio (leen DRAFT, MVCC no bloquea lecturas)
      // y sus UPDATE quedan esperando el lock. Se libera recién con los 2 UPDATE en espera.
      let releaseLock: () => void = () => undefined;
      const lockReleased = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      let markLocked: () => void = () => undefined;
      const locked = new Promise<void>((resolve) => {
        markLocked = resolve;
      });
      const holder = db.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "recipes" WHERE id = ${DRAFT_ID}::uuid FOR UPDATE`;
          markLocked();
          await lockReleased;
        },
        { timeout: 15_000 },
      );
      await locked;

      // Act
      const pending = Promise.all(
        [USERS.chef, USERS.nutritionist].map((reviewer) =>
          request(app)
            .put(`/api/v1/recipes/${DRAFT_ID}/approve`)
            .set("If-Match", CURRENT_ETAG)
            .set("Authorization", bearer(reviewer)),
        ),
      );
      try {
        await waitForLockWaiters(db, 2);
      } finally {
        releaseLock();
        await holder;
      }
      const responses = await pending;

      // Assert
      // El perdedor revisó la versión 1, que la aprobación ganadora ya incrementó: 412 (#46)
      expect(responses.map((res) => res.status).sort()).toEqual([200, 412]);
      const loser = responses.find((res) => res.status === 412);
      expect(loser?.body).toMatchObject({
        success: false,
        message: RECIPE_VERSION_MISMATCH_MESSAGE,
      });
      const winner = responses.find((res) => res.status === 200);
      const winnerId = (winner?.body as RecipeBody | undefined)?.data
        .reviewedById;
      const logs = await db.prisma.auditLog.findMany({
        where: { entityId: DRAFT_ID },
      });
      expect(logs).toHaveLength(1);
      expect(logs[0]?.userId).toBe(winnerId);
      const persisted = await db.prisma.recipe.findUniqueOrThrow({
        where: { id: DRAFT_ID },
      });
      expect(persisted.reviewedById).toBe(winnerId);
    });
  });

  describe("Atomicidad (RN-06)", () => {
    it("revierte el UPDATE de recipes si falla la inserción en audit_logs (500 redactado)", async () => {
      // Arrange — trigger temporal que falla solo para esta Receta; se elimina siempre.
      // `$executeRawUnsafe` solo porque el DDL no admite parámetros: interpola únicamente
      // constantes de este archivo (nunca entrada externa). No replicar este patrón en `src/`.
      try {
        await db.prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION ${ROLLBACK_FUNCTION}() RETURNS trigger AS $$
        BEGIN
          IF NEW."entityId" = '${DRAFT_ID}'::uuid THEN
            RAISE EXCEPTION 'fallo forzado de auditoría (prueba #19)';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);
        await db.prisma.$executeRawUnsafe(
          `CREATE TRIGGER ${ROLLBACK_TRIGGER} BEFORE INSERT ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION ${ROLLBACK_FUNCTION}();`,
        );

        // Act
        const res = await request(app)
          .put(`/api/v1/recipes/${DRAFT_ID}/approve`)
          .set("If-Match", CURRENT_ETAG)
          .set("Authorization", bearer(USERS.chef));

        // Assert
        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toContain("fallo forzado");
        await expectUnchangedDraft(DRAFT_ID);
      } finally {
        await dropRollbackTrigger(db);
      }

      // Tras quitar el trigger, la misma aprobación funciona (no quedó estado inconsistente)
      const retry = await request(app)
        .put(`/api/v1/recipes/${DRAFT_ID}/approve`)
        .set("If-Match", CURRENT_ETAG)
        .set("Authorization", bearer(USERS.chef));
      expect(retry.status).toBe(200);
      expect(await db.prisma.auditLog.count()).toBe(1);
    });
  });
});
