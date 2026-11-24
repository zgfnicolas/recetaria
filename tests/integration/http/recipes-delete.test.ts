import { randomUUID } from "node:crypto";
import type express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../../src/app.js";
import {
  disconnect,
  getDatabase,
  type Database,
} from "../../../src/infrastructure/database/prisma.js";
import { DUMMY_BCRYPT_HASH, type JwtConfig, type UserRole } from "../../../src/modules/auth/index.js";
import {
  INVALID_AUTHOR_MESSAGE,
  RECIPE_DELETE_FORBIDDEN_MESSAGE,
  RECIPE_NOT_FOUND_MESSAGE,
} from "../../../src/modules/recipes/index.js";

const TEST_JWT_CONFIG: JwtConfig = {
  secret: "test-jwt-secret-".repeat(3),
  expiresIn: "1h",
};

const USERS = {
  author: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "USER" },
  chef: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", role: "CHEF" },
  nutritionist: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", role: "NUTRITIONIST" },
  admin: { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", role: "ADMIN" },
  other: { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", role: "USER" },
} as const satisfies Record<string, Readonly<{ id: string; role: UserRole }>>;

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const APPROVED_ID = "22222222-2222-4222-8222-222222222222";
const MISSING_ID = "99999999-9999-4999-8999-999999999999";
const AUDIT_TRIGGER = "trg_test_21_fail_delete_audit";
const AUDIT_FUNCTION = "test_21_fail_delete_audit";
const DELETE_TRIGGER = "trg_test_21_fail_recipe_delete";
const DELETE_FUNCTION = "test_21_fail_recipe_delete";

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
      email: `borrado-${String(index)}@recetaria.com`,
      passwordHash: DUMMY_BCRYPT_HASH,
      firstName: "Usuario",
      lastName: String(index),
    })),
  });
  const base = {
    description: "Descripción de la receta a eliminar.",
    prepTimeMinutes: 30,
    ingredients: [{ name: "Sal", quantity: 1, unit: "g" }],
    authorId: USERS.author.id,
  };
  await db.prisma.recipe.create({
    data: { ...base, id: DRAFT_ID, title: "Borrador a eliminar", slug: "borrador-0a1b2c3d" },
  });
  await db.prisma.recipe.create({
    data: {
      ...base,
      id: APPROVED_ID,
      title: "Aprobada a eliminar",
      slug: "aprobada-0a1b2c3d",
      status: "APPROVED",
      reviewedById: USERS.chef.id,
      publishedAt: new Date("2026-11-20T10:00:00.000Z"),
    },
  });
}

/**
 * Crea un trigger temporal que falla para una Receta concreta. `$executeRawUnsafe` solo porque
 * el DDL no admite parámetros: interpola únicamente constantes de este archivo. No replicar en `src/`.
 */
async function createFailingTrigger(
  db: Database,
  options: Readonly<{ fn: string; trigger: string; table: string; timing: string; column: string }>,
): Promise<void> {
  await db.prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ${options.fn}() RETURNS trigger AS $$
    BEGIN
      IF ${options.column} = '${APPROVED_ID}'::uuid THEN
        RAISE EXCEPTION 'fallo forzado (prueba #21)';
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $$ LANGUAGE plpgsql;
  `);
  await db.prisma.$executeRawUnsafe(
    `CREATE TRIGGER ${options.trigger} ${options.timing} ON "${options.table}" FOR EACH ROW EXECUTE FUNCTION ${options.fn}();`,
  );
}

async function dropTestTriggers(db: Database): Promise<void> {
  await db.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${AUDIT_TRIGGER} ON "audit_logs";`);
  await db.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${AUDIT_FUNCTION}();`);
  await db.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${DELETE_TRIGGER} ON "recipes";`);
  await db.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${DELETE_FUNCTION}();`);
}

/** Espera hasta que `expected` sesiones estén bloqueadas en un `SELECT … FOR UPDATE` de `recipes`. */
async function waitForLockWaiters(db: Database, expected: number, timeoutMs = 5_000): Promise<void> {
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

type TransactionClient = Parameters<Parameters<Database["prisma"]["$transaction"]>[0]>[0];

/** Transacción externa que bloquea la fila hasta `release()` y ejecuta `beforeCommit` con el lock. */
function holdRowLock(
  db: Database,
  recipeId: string,
  beforeCommit?: (tx: TransactionClient) => Promise<void>,
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

describe("DELETE /api/v1/recipes/:id — Eliminación física autorizada (Integración HTTP + PostgreSQL)", () => {
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
    await dropTestTriggers(db);
    await disconnect();
  });

  // `.then()` dispara el envío de inmediato (Supertest es perezoso hasta que se consume).
  const del = (id: string, user: Readonly<{ id: string; role: UserRole }> = USERS.author) =>
    request(app).delete(`/api/v1/recipes/${id}`).set("Authorization", bearer(user)).then((res) => res);

  async function expectIntact(id: string): Promise<void> {
    expect(await db.prisma.recipe.count({ where: { id } })).toBe(1);
    expect(await db.prisma.auditLog.count()).toBe(0);
  }

  describe("200 OK — borrado físico con Registro de Auditoría DELETE (RN-03, RN-06)", () => {
    it.each([
      ["DRAFT", DRAFT_ID, "Borrador a eliminar", "DRAFT"],
      ["APPROVED", APPROVED_ID, "Aprobada a eliminar", "APPROVED"],
    ])("el Autor elimina su receta %s: la fila desaparece y el DELETE persiste", async (_label, id, title, status) => {
      // Act
      const res = await del(id);

      // Assert — respuesta JSend
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        statusCode: 200,
        message: "Receta eliminada exitosamente",
        data: { id },
      });

      // Assert — la fila ya no existe y el detalle público responde 404
      expect(await db.prisma.recipe.count({ where: { id } })).toBe(0);
      expect((await request(app).get(`/api/v1/recipes/${id}`)).status).toBe(404);

      // Assert — el Registro de Auditoría sobrevive con el snapshot exacto
      const logs = await db.prisma.auditLog.findMany({ where: { entityName: "Recipe", entityId: id } });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        action: "DELETE",
        userId: USERS.author.id,
        oldValues: { title, authorId: USERS.author.id, status },
        newValues: null,
      });
      const [raw] = await db.prisma.$queryRaw<{ isSqlNull: boolean }[]>`
        SELECT "newValues" IS NULL AS "isSqlNull" FROM "audit_logs" WHERE "entityId" = ${id}::uuid`;
      expect(raw?.isSqlNull).toBe(true);
    });

    it("un ADMIN elimina una receta ajena registrándose como responsable", async () => {
      // Act
      const res = await del(APPROVED_ID, USERS.admin);

      // Assert
      expect(res.status).toBe(200);
      expect(await db.prisma.recipe.count({ where: { id: APPROVED_ID } })).toBe(0);
      const logs = await db.prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        entityId: APPROVED_ID,
        action: "DELETE",
        userId: USERS.admin.id,
        oldValues: { title: "Aprobada a eliminar", authorId: USERS.author.id, status: "APPROVED" },
      });
    });

    it("solo elimina la receta indicada", async () => {
      // Act
      await del(DRAFT_ID);

      // Assert
      expect(await db.prisma.recipe.count({ where: { id: APPROVED_ID } })).toBe(1);
    });
  });

  describe("400 / 401", () => {
    it("rechaza un :id que no es UUID v4 con 400", async () => {
      // Act
      const res = await del("abc");

      // Assert
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        success: false,
        statusCode: 400,
        errors: [{ field: "id", message: "id debe ser un UUID v4 válido" }],
      });
      expect(await db.prisma.recipe.count()).toBe(2);
      expect(await db.prisma.auditLog.count()).toBe(0);
    });

    it.each([
      ["sin header Authorization", undefined],
      ["con token malformado", "Bearer no.es.jwt"],
      [
        "con JWT expirado",
        `Bearer ${jwt.sign({ id: USERS.author.id, role: "USER", exp: Math.floor(Date.now() / 1000) - 60 }, TEST_JWT_CONFIG.secret, { algorithm: "HS256" })}`,
      ],
    ])("responde 401 %s sin borrar", async (_label, authorization) => {
      // Act
      const req = request(app).delete(`/api/v1/recipes/${DRAFT_ID}`);
      const res = await (authorization === undefined ? req : req.set("Authorization", authorization));

      // Assert
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ success: false, statusCode: 401 });
      await expectIntact(DRAFT_ID);
    });

    it("autentica antes de validar: :id inválido sin token responde 401, no 400", async () => {
      // Act
      const res = await request(app).delete("/api/v1/recipes/abc");

      // Assert
      expect(res.status).toBe(401);
    });

    it("responde 401 si un ADMIN con JWT válido ya no existe en users (P2003), sin borrar", async () => {
      // Act
      const res = await del(APPROVED_ID, { id: randomUUID(), role: "ADMIN" });

      // Assert
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ success: false, message: INVALID_AUTHOR_MESSAGE });
      await expectIntact(APPROVED_ID);
    });
  });

  describe("403 Forbidden (RN-03)", () => {
    it.each([
      ["otro USER", USERS.other],
      ["el CHEF que la aprobó", USERS.chef],
      ["un NUTRITIONIST ajeno", USERS.nutritionist],
    ])("rechaza el borrado de %s sin alterar la receta", async (_label, user) => {
      // Act
      const res = await del(APPROVED_ID, user);

      // Assert
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        success: false,
        statusCode: 403,
        message: RECIPE_DELETE_FORBIDDEN_MESSAGE,
      });
      await expectIntact(APPROVED_ID);
    });
  });

  it("rechaza también el borrado de un CHEF ajeno sobre una receta DRAFT", async () => {
    // Act
    const res = await del(DRAFT_ID, USERS.chef);

    // Assert
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ message: RECIPE_DELETE_FORBIDDEN_MESSAGE });
    await expectIntact(DRAFT_ID);
  });

  describe("404 Not Found", () => {
    it("responde 404 si el UUID v4 no existe", async () => {
      // Act
      const res = await del(MISSING_ID);

      // Assert
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ statusCode: 404, message: RECIPE_NOT_FOUND_MESSAGE });
      expect(await db.prisma.auditLog.count()).toBe(0);
    });

    it("un segundo borrado de la misma receta responde 404 sin agregar auditoría", async () => {
      // Act
      const first = await del(DRAFT_ID);
      const second = await del(DRAFT_ID, USERS.admin);

      // Assert
      expect(first.status).toBe(200);
      expect(second.status).toBe(404);
      expect(await db.prisma.auditLog.count()).toBe(1);
    });
  });

  describe("Concurrencia (fila bloqueada)", () => {
    it("Autor y ADMIN borran a la vez: un 200, un 404 y un único DELETE auditado", async () => {
      // Arrange — ambos superan el chequeo del servicio y esperan el lock de la fila
      const holder = holdRowLock(db, DRAFT_ID);
      await holder.locked;

      // Act
      const pending = Promise.all([del(DRAFT_ID, USERS.author), del(DRAFT_ID, USERS.admin)]);
      try {
        await waitForLockWaiters(db, 2);
      } finally {
        holder.release();
        await holder.done;
      }
      const responses = await pending;

      // Assert
      expect(responses.map((res) => res.status).sort()).toEqual([200, 404]);
      const logs = await db.prisma.auditLog.findMany({ where: { entityId: DRAFT_ID } });
      expect(logs).toHaveLength(1);
      const winner = responses[0]?.status === 200 ? USERS.author : USERS.admin;
      expect(logs[0]?.userId).toBe(winner.id);
    });

    it("audita el título confirmado sobre la fila bloqueada, no el leído antes por el servicio", async () => {
      // Arrange — la transacción externa renombra la receta antes de liberar el lock
      const holder = holdRowLock(db, DRAFT_ID, async (tx) => {
        await tx.recipe.update({ where: { id: DRAFT_ID }, data: { title: "Título confirmado" } });
      });
      await holder.locked;

      // Act
      const pending = del(DRAFT_ID);
      try {
        await waitForLockWaiters(db, 1);
      } finally {
        holder.release();
        await holder.done;
      }
      const res = await pending;

      // Assert
      expect(res.status).toBe(200);
      const logs = await db.prisma.auditLog.findMany({ where: { entityId: DRAFT_ID } });
      expect(logs[0]?.oldValues).toMatchObject({ title: "Título confirmado" });
    });

    it("interacción con PUT /:id: una edición que espera el lock mientras la receta se borra responde 404", async () => {
      // Arrange — la transacción externa borra la receta antes de liberar el lock
      const holder = holdRowLock(db, DRAFT_ID, async (tx) => {
        await tx.recipe.delete({ where: { id: DRAFT_ID } });
      });
      await holder.locked;

      // Act
      const pending = request(app)
        .put(`/api/v1/recipes/${DRAFT_ID}`)
        .set("Authorization", bearer(USERS.author))
        .send({ prepTimeMinutes: 10 })
        .then((res) => res);
      try {
        await waitForLockWaiters(db, 1);
      } finally {
        holder.release();
        await holder.done;
      }
      const res = await pending;

      // Assert
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ message: RECIPE_NOT_FOUND_MESSAGE });
    });
  });

  describe("Atomicidad (RN-06)", () => {
    it("si falla la inserción del DELETE en audit_logs, la receta no se borra (500 redactado)", async () => {
      try {
        // Arrange
        await createFailingTrigger(db, {
          fn: AUDIT_FUNCTION,
          trigger: AUDIT_TRIGGER,
          table: "audit_logs",
          timing: "BEFORE INSERT",
          column: 'NEW."entityId"',
        });

        // Act
        const res = await del(APPROVED_ID);

        // Assert
        expect(res.status).toBe(500);
        expect(res.body).toMatchObject({ success: false, statusCode: 500 });
        expect(JSON.stringify(res.body)).not.toContain("fallo forzado");
        await expectIntact(APPROVED_ID);
      } finally {
        await dropTestTriggers(db);
      }
    });

    it("si falla el DELETE de recipes, se revierte el registro de auditoría ya insertado", async () => {
      try {
        // Arrange
        await createFailingTrigger(db, {
          fn: DELETE_FUNCTION,
          trigger: DELETE_TRIGGER,
          table: "recipes",
          timing: "BEFORE DELETE",
          column: "OLD.id",
        });

        // Act
        const res = await del(APPROVED_ID);

        // Assert
        expect(res.status).toBe(500);
        await expectIntact(APPROVED_ID);
      } finally {
        await dropTestTriggers(db);
      }

      // Sin el trigger, el mismo borrado funciona (no quedó estado inconsistente)
      expect((await del(APPROVED_ID)).status).toBe(200);
      expect(await db.prisma.auditLog.count()).toBe(1);
    });
  });
});
