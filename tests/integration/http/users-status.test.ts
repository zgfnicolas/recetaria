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
import type { JwtConfig, UserRole } from "../../../src/modules/auth/index.js";
import {
  ACTOR_NOT_ACTIVE_ADMIN_MESSAGE,
  SELF_STATUS_CHANGE_FORBIDDEN_MESSAGE,
  USER_NOT_FOUND_MESSAGE,
} from "../../../src/modules/users/index.js";
import { createUserWithRole, loginAs } from "../../support/users.js";
import { truncateAll } from "../../support/database.js";

const TEST_JWT_CONFIG: JwtConfig = {
  secret: "test-jwt-secret-".repeat(3),
  expiresIn: "1h",
};
const AUDIT_TRIGGER = "trg_test_56_fail_status_audit";
const AUDIT_FUNCTION = "test_56_fail_status_audit";

type SeededUser = Readonly<{ id: string; email: string; password: string; role: UserRole }>;

function bearerFor(user: Readonly<{ id: string; role: UserRole }>): string {
  return `Bearer ${jwt.sign({ id: user.id, role: user.role }, TEST_JWT_CONFIG.secret, { algorithm: "HS256", expiresIn: "1h" })}`;
}

async function truncateTables(db: Database): Promise<void> {
  await truncateAll(db);
}

async function seedUser(db: Database, email: string, role: UserRole, isActive = true): Promise<SeededUser> {
  const created = await createUserWithRole(db, { email, role, isActive });
  return { ...created, role };
}

/** Espera hasta que `expected` sesiones estén bloqueadas en un `SELECT … FOR NO KEY UPDATE` de `users`. */
async function waitForLockWaiters(db: Database, expected: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await db.prisma.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query ILIKE '%"users"%FOR NO KEY UPDATE%'`;
    if ((row?.waiting ?? 0) >= expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No se alcanzaron ${String(expected)} sesiones esperando el lock a tiempo`);
}

describe("PATCH /api/v1/users/:id/status — Activación y desactivación auditada (#56, Integración HTTP + PostgreSQL)", () => {
  let db: Database;
  let app: express.Express;
  let admin: SeededUser;
  let otherAdmin: SeededUser;
  let user: SeededUser;

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
    admin = await seedUser(db, "admin@recetaria.com", "ADMIN");
    otherAdmin = await seedUser(db, "admin2@recetaria.com", "ADMIN");
    user = await seedUser(db, "usuario@recetaria.com", "USER");
  });

  afterEach(async () => {
    await truncateTables(db);
  });

  afterAll(async () => {
    await db.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${AUDIT_TRIGGER} ON "audit_logs";`);
    await db.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${AUDIT_FUNCTION}();`);
    await disconnect();
  });

  // `.then()` dispara el envío de inmediato (Supertest es perezoso hasta que se consume).
  const patchStatus = (targetId: string, body: unknown, actor: Readonly<{ id: string; role: UserRole }> = admin) =>
    request(app)
      .patch(`/api/v1/users/${targetId}/status`)
      .set("Authorization", bearerFor(actor))
      .send(body as object)
      .then((res) => res);

  async function isActiveOf(id: string): Promise<boolean> {
    return (await db.prisma.user.findUniqueOrThrow({ where: { id } })).isActive;
  }

  describe("200 OK — con registro ACCOUNT_* atómico (RN-10)", () => {
    it("desactiva una cuenta y registra ACCOUNT_DEACTIVATED, sin datos sensibles", async () => {
      // Act
      const res = await patchStatus(user.id, { isActive: false });

      // Assert
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        statusCode: 200,
        message: "Cuenta desactivada exitosamente",
        data: { id: user.id, email: user.email, role: "USER", isActive: false },
      });
      expect(JSON.stringify(res.body)).not.toContain("$2b$");
      expect(await isActiveOf(user.id)).toBe(false);
      const logs = await db.prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        entityName: "User",
        entityId: user.id,
        action: "ACCOUNT_DEACTIVATED",
        userId: admin.id,
        oldValues: { isActive: true },
        newValues: { isActive: false },
      });
    });

    it("reactiva una cuenta y registra ACCOUNT_ACTIVATED", async () => {
      // Arrange
      await db.prisma.user.update({ where: { id: user.id }, data: { isActive: false } });

      // Act
      const res = await patchStatus(user.id, { isActive: true });

      // Assert
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ message: "Cuenta activada exitosamente", data: { isActive: true } });
      expect(await db.prisma.auditLog.findFirst()).toMatchObject({
        action: "ACCOUNT_ACTIVATED",
        oldValues: { isActive: false },
        newValues: { isActive: true },
      });
    });

    it("es idempotente también al desactivar una cuenta ya inactiva (200 sin auditar)", async () => {
      // Arrange
      const inactive = await seedUser(db, "ya-inactivo@recetaria.com", "USER", false);

      // Act
      const res = await patchStatus(inactive.id, { isActive: false });

      // Assert
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ isActive: false });
      expect(await db.prisma.auditLog.count()).toBe(0);
    });

    it("reactiva a un ADMIN inactivo (no aplica la regla del último ADMIN)", async () => {
      // Arrange
      const inactiveAdmin = await seedUser(db, "admin-inactivo@recetaria.com", "ADMIN", false);

      // Act
      const res = await patchStatus(inactiveAdmin.id, { isActive: true });

      // Assert
      expect(res.status).toBe(200);
      expect(await db.prisma.user.count({ where: { role: "ADMIN", isActive: true } })).toBe(3);
    });

    it("es idempotente: pedir el estado actual responde 200 sin registrar auditoría", async () => {
      const res = await patchStatus(user.id, { isActive: true });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id: user.id, email: user.email, role: "USER", isActive: true });
      expect(await db.prisma.auditLog.count()).toBe(0);
    });

    it("desactivar rige de inmediato: el JWT vigente y el login dan 401; reactivar devuelve el acceso", async () => {
      // Arrange — sesión previa del usuario
      const session = await loginAs(app, { email: user.email, password: user.password });
      const mine = (token: string) => request(app).get("/api/v1/recipes/mine").set("Authorization", `Bearer ${token}`);
      expect((await mine(session.token)).status).toBe(200);

      // Act — desactivar
      await patchStatus(user.id, { isActive: false });
      const afterDeactivation = await mine(session.token);
      const loginWhileInactive = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: user.email, password: user.password });

      // Act — reactivar
      await patchStatus(user.id, { isActive: true });
      const afterReactivation = await mine(session.token);

      // Assert
      expect(afterDeactivation.status).toBe(401);
      expect(afterDeactivation.body).toMatchObject({ message: "Token inválido o expirado" });
      expect(loginWhileInactive.status).toBe(401);
      expect(afterReactivation.status).toBe(200);
    });

    it("desactivar a otro ADMIN deja de permitirle administrar al instante", async () => {
      // Act
      await patchStatus(otherAdmin.id, { isActive: false });
      const res = await patchStatus(user.id, { isActive: false }, otherAdmin);

      // Assert
      expect(res.status).toBe(401);
      expect(await isActiveOf(user.id)).toBe(true);
    });
  });

  describe("400 Bad Request", () => {
    it.each([
      ["isActive como texto", { isActive: "false" }, "isActive"],
      ["isActive numérico", { isActive: 0 }, "isActive"],
      ["body vacío", {}, "isActive"],
      ["un campo extra (BOPLA)", { isActive: false, role: "ADMIN" }, "role"],
    ])("rechaza %s sin cambiar el estado", async (_label, body, field) => {
      // Act
      const res = await patchStatus(user.id, body);

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.errors.map((e: { field: string }) => e.field)).toContain(field);
      expect(await isActiveOf(user.id)).toBe(true);
      expect(await db.prisma.auditLog.count()).toBe(0);
    });

    it("rechaza un :id que no es UUID v4", async () => {
      const res = await patchStatus("abc", { isActive: false });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ errors: [{ field: "id" }] });
    });
  });

  describe("401 / 403 / 404", () => {
    it("responde 401 sin token y con un JWT de un usuario inexistente", async () => {
      const anonymous = await request(app).patch(`/api/v1/users/${user.id}/status`).send({ isActive: false });
      const ghost = await patchStatus(user.id, { isActive: false }, { id: randomUUID(), role: "ADMIN" });
      expect(anonymous.status).toBe(401);
      expect(ghost.status).toBe(401);
      expect(await isActiveOf(user.id)).toBe(true);
    });

    it.each(["USER", "CHEF", "NUTRITIONIST"] as const)("rechaza en RBAC a un %s", async (role) => {
      // Arrange
      const actor = await seedUser(db, `${role.toLowerCase()}-actor@recetaria.com`, role);

      // Act
      const res = await patchStatus(user.id, { isActive: false }, actor);

      // Assert
      expect(res.status).toBe(403);
      expect(await isActiveOf(user.id)).toBe(true);
    });

    it.each([false, true])("prohíbe que un ADMIN cambie el estado de su propia cuenta (isActive = %s)", async (isActive) => {
      // Act
      const res = await patchStatus(admin.id, { isActive });

      // Assert
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ message: SELF_STATUS_CHANGE_FORBIDDEN_MESSAGE });
      expect(await isActiveOf(admin.id)).toBe(true);
      expect(await db.prisma.auditLog.count()).toBe(0);
    });

    it("un ADMIN degradado recibe 403 también contra un id inexistente (no distingue si existe)", async () => {
      // Arrange
      await db.prisma.user.update({ where: { id: otherAdmin.id }, data: { role: "USER" } });

      // Act
      const res = await patchStatus("99999999-9999-4999-8999-999999999999", { isActive: false }, otherAdmin);

      // Assert
      expect(res.status).toBe(403);
    });

    it("responde 404 si el usuario destino no existe, sin auditoría", async () => {
      const res = await patchStatus("99999999-9999-4999-8999-999999999999", { isActive: false });
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ statusCode: 404, message: USER_NOT_FOUND_MESSAGE });
      expect(await db.prisma.auditLog.count()).toBe(0);
    });
  });

  describe("Último ADMIN y concurrencia", () => {
    it("dos ADMIN que se desactivan mutuamente a la vez: uno gana, el otro recibe 403 y queda un ADMIN activo", async () => {
      // Arrange — barrera: una transacción externa bloquea las filas ADMIN; ambas solicitudes ya
      // pasaron authMiddleware (estaban activas) y esperan el lock de los ADMIN activos.
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let markLocked: () => void = () => undefined;
      const locked = new Promise<void>((resolve) => {
        markLocked = resolve;
      });
      const holder = db.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "users" WHERE role = 'ADMIN' FOR UPDATE`;
          markLocked();
          await released;
        },
        { timeout: 15_000 },
      );
      await locked;

      // Act
      const pending = Promise.all([
        patchStatus(otherAdmin.id, { isActive: false }, admin),
        patchStatus(admin.id, { isActive: false }, otherAdmin),
      ]);
      try {
        await waitForLockWaiters(db, 2);
      } finally {
        release();
        await holder;
      }
      const responses = await pending;

      // Assert
      expect(responses.map((res) => res.status).sort()).toEqual([200, 403]);
      // El perdedor ya pasó authMiddleware: lo frena la revalidación con lock dentro de la transacción
      expect(responses.find((res) => res.status === 403)?.body).toMatchObject({
        message: ACTOR_NOT_ACTIVE_ADMIN_MESSAGE,
      });
      expect(await db.prisma.user.count({ where: { role: "ADMIN", isActive: true } })).toBe(1);
      expect(await db.prisma.auditLog.count({ where: { action: "ACCOUNT_DEACTIVATED" } })).toBe(1);
    });
  });

  describe("Atomicidad (RN-06/RN-10)", () => {
    it("revierte la desactivación si falla la inserción de ACCOUNT_DEACTIVATED (500 redactado)", async () => {
      // `$executeRawUnsafe` solo porque el DDL no admite parámetros: interpola únicamente
      // constantes y un UUID generado en esta prueba. No replicar este patrón en `src/`.
      try {
        await db.prisma.$executeRawUnsafe(`
          CREATE OR REPLACE FUNCTION ${AUDIT_FUNCTION}() RETURNS trigger AS $$
          BEGIN
            IF NEW."entityId" = '${user.id}'::uuid THEN
              RAISE EXCEPTION 'fallo forzado (prueba #56)';
            END IF;
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql;
        `);
        await db.prisma.$executeRawUnsafe(
          `CREATE TRIGGER ${AUDIT_TRIGGER} BEFORE INSERT ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION ${AUDIT_FUNCTION}();`,
        );

        // Act
        const res = await patchStatus(user.id, { isActive: false });

        // Assert
        expect(res.status).toBe(500);
        expect(res.body).toMatchObject({ success: false, statusCode: 500 });
        expect(JSON.stringify(res.body)).not.toContain("fallo forzado");
        expect(await isActiveOf(user.id)).toBe(true);
        expect(await db.prisma.auditLog.count()).toBe(0);
      } finally {
        await db.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${AUDIT_TRIGGER} ON "audit_logs";`);
        await db.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${AUDIT_FUNCTION}();`);
      }
    });
  });
});
