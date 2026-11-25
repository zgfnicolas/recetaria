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
  SELF_ROLE_CHANGE_FORBIDDEN_MESSAGE,
  USER_NOT_FOUND_MESSAGE,
} from "../../../src/modules/users/index.js";
import { createUserWithRole, loginAs } from "../../support/users.js";

const TEST_JWT_CONFIG: JwtConfig = {
  secret: "test-jwt-secret-".repeat(3),
  expiresIn: "1h",
};
const AUDIT_TRIGGER = "trg_test_53_fail_role_audit";
const AUDIT_FUNCTION = "test_53_fail_role_audit";

type SeededUser = Readonly<{ id: string; email: string; password: string; role: UserRole }>;

function bearerFor(user: Readonly<{ id: string; role: UserRole }>): string {
  return `Bearer ${jwt.sign({ id: user.id, role: user.role }, TEST_JWT_CONFIG.secret, { algorithm: "HS256", expiresIn: "1h" })}`;
}

async function truncateTables(db: Database): Promise<void> {
  await db.prisma.$executeRaw`TRUNCATE TABLE "audit_logs", "recipes", "users" RESTART IDENTITY;`;
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

describe("PATCH /api/v1/users/:id/role — Administración de roles auditada (#53, Integración HTTP + PostgreSQL)", () => {
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
  const patchRole = (targetId: string, body: unknown, actor: Readonly<{ id: string; role: UserRole }> = admin) =>
    request(app)
      .patch(`/api/v1/users/${targetId}/role`)
      .set("Authorization", bearerFor(actor))
      .send(body as object)
      .then((res) => res);

  async function roleOf(id: string): Promise<UserRole> {
    return (await db.prisma.user.findUniqueOrThrow({ where: { id } })).role;
  }

  describe("200 OK — cambio de rol con ROLE_CHANGED atómico (RN-09)", () => {
    it.each(["CHEF", "NUTRITIONIST", "ADMIN"] as const)("un ADMIN asigna %s a un USER", async (role) => {
      // Act
      const res = await patchRole(user.id, { role });

      // Assert — respuesta JSend sin datos sensibles
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        statusCode: 200,
        message: "Rol actualizado exitosamente",
        data: { id: user.id, email: user.email, role },
      });
      expect(JSON.stringify(res.body)).not.toContain("passwordHash");
      expect(JSON.stringify(res.body)).not.toContain("$2b$");

      // Assert — fila y registro de auditoría exactos
      expect(await roleOf(user.id)).toBe(role);
      const logs = await db.prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        entityName: "User",
        entityId: user.id,
        action: "ROLE_CHANGED",
        userId: admin.id,
        oldValues: { role: "USER" },
        newValues: { role },
      });
    });

    it("degrada a USER a otro ADMIN (quedan administradores activos)", async () => {
      // Act
      const res = await patchRole(otherAdmin.id, { role: "USER" });

      // Assert
      expect(res.status).toBe(200);
      expect(await roleOf(otherAdmin.id)).toBe("USER");
      expect(await db.prisma.auditLog.findFirst()).toMatchObject({
        oldValues: { role: "ADMIN" },
        newValues: { role: "USER" },
      });
    });

    it("degrada a un ADMIN inactivo sin afectar la regla del último ADMIN activo", async () => {
      // Arrange
      const inactiveAdmin = await seedUser(db, "admin-inactivo@recetaria.com", "ADMIN", false);

      // Act
      const res = await patchRole(inactiveAdmin.id, { role: "USER" });

      // Assert
      expect(res.status).toBe(200);
      expect(await roleOf(inactiveAdmin.id)).toBe("USER");
      expect(await db.prisma.user.count({ where: { role: "ADMIN", isActive: true } })).toBe(2);
    });

    it("riesgo asumido (RN-08): un CHEF degradado a USER sigue aprobando con su JWT anterior hasta que vence", async () => {
      // Arrange — el CHEF inicia sesión antes de ser degradado
      const chef = await seedUser(db, "chef-degradado@recetaria.com", "CHEF");
      const chefSession = await loginAs(app, { email: chef.email, password: chef.password });
      const recipe = await db.prisma.recipe.create({
        data: {
          title: "Receta del usuario",
          slug: "receta-del-usuario-0a1b2c3d",
          description: "Receta ajena para probar el token vigente de un degradado.",
          prepTimeMinutes: 10,
          ingredients: [{ name: "Sal", quantity: 1, unit: "g" }],
          authorId: user.id,
        },
      });

      // Act
      const demote = await patchRole(chef.id, { role: "USER" });
      const approveWithOldToken = await request(app)
        .put(`/api/v1/recipes/${recipe.id}/approve`)
        .set("Authorization", `Bearer ${chefSession.token}`)
        .set("If-Match", '"1"');
      const relogin = await loginAs(app, { email: chef.email, password: chef.password });

      // Assert — el endpoint degradó en la base, pero el token stateless conserva CHEF (≤ 1d, #52)
      expect(demote.status).toBe(200);
      expect(approveWithOldToken.status).toBe(200);
      expect((jwt.decode(relogin.token) as { role?: unknown } | null)?.role).toBe("USER");
    });

    it("es idempotente: asignar el rol actual responde 200 sin registrar auditoría", async () => {
      // Act
      const res = await patchRole(user.id, { role: "USER" });

      // Assert
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id: user.id, email: user.email, role: "USER" });
      expect(await db.prisma.auditLog.count()).toBe(0);
    });

    it("el rol nuevo rige desde el próximo login; el token anterior conserva el rol hasta vencer", async () => {
      // Arrange — sesión previa del usuario como USER
      const before = await loginAs(app, { email: user.email, password: user.password });

      // Act
      await patchRole(user.id, { role: "CHEF" });
      const after = await loginAs(app, { email: user.email, password: user.password });

      // Assert — JWT nuevo con CHEF; el anterior sigue diciendo USER (stateless, RN-08)
      const roleIn = (token: string): unknown => (jwt.decode(token) as { role?: unknown } | null)?.role;
      expect(roleIn(before.token)).toBe("USER");
      expect(roleIn(after.token)).toBe("CHEF");

      // Assert — el CHEF promovido puede aprobar una receta ajena; con el token viejo, no
      const recipe = await db.prisma.recipe.create({
        data: {
          title: "Receta a aprobar",
          slug: "receta-a-aprobar-0a1b2c3d",
          description: "Receta de otro autor para probar el rol promovido.",
          prepTimeMinutes: 10,
          ingredients: [{ name: "Sal", quantity: 1, unit: "g" }],
          authorId: admin.id,
        },
      });
      const approveWith = (token: string) =>
        request(app)
          .put(`/api/v1/recipes/${recipe.id}/approve`)
          .set("Authorization", `Bearer ${token}`)
          .set("If-Match", '"1"');
      expect((await approveWith(before.token)).status).toBe(403);
      expect((await approveWith(after.token)).status).toBe(200);
    });
  });

  describe("400 Bad Request", () => {
    it.each([
      ["un rol inválido", { role: "SUPERADMIN" }, "role"],
      ["un body vacío", {}, "role"],
      ["un campo extra (BOPLA)", { role: "CHEF", isActive: false }, "isActive"],
    ])("rechaza %s sin cambiar el rol", async (_label, body, field) => {
      // Act
      const res = await patchRole(user.id, body);

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.errors.map((e: { field: string }) => e.field)).toContain(field);
      expect(await roleOf(user.id)).toBe("USER");
      expect(await db.prisma.auditLog.count()).toBe(0);
    });

    it("rechaza un :id que no es UUID v4", async () => {
      const res = await patchRole("abc", { role: "CHEF" });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ errors: [{ field: "id" }] });
      expect(await db.prisma.auditLog.count()).toBe(0);
    });
  });

  describe("401 Unauthorized", () => {
    it.each([
      ["sin header Authorization", undefined],
      ["con token malformado", "Bearer no.es.jwt"],
      [
        "con JWT expirado",
        `Bearer ${jwt.sign({ id: randomUUID(), role: "ADMIN", exp: Math.floor(Date.now() / 1000) - 60 }, TEST_JWT_CONFIG.secret, { algorithm: "HS256" })}`,
      ],
    ])("responde 401 %s, antes de validar el body", async (_label, authorization) => {
      // Act
      const req = request(app).patch(`/api/v1/users/${user.id}/role`).send({});
      const res = await (authorization === undefined ? req : req.set("Authorization", authorization));

      // Assert
      expect(res.status).toBe(401);
      expect(await roleOf(user.id)).toBe("USER");
    });
  });

  describe("403 Forbidden", () => {
    it.each(["USER", "CHEF", "NUTRITIONIST"] as const)(
      "rechaza en rbacMiddleware a un %s, aunque el body sea inválido",
      async (role) => {
        // Arrange
        const actor = await seedUser(db, `${role.toLowerCase()}-actor@recetaria.com`, role);

        // Act
        const res = await patchRole(user.id, { role: "ADMIN", extra: true }, actor);

        // Assert
        expect(res.status).toBe(403);
        expect(await roleOf(user.id)).toBe("USER");
        expect(await db.prisma.auditLog.count()).toBe(0);
      },
    );

    it("prohíbe que un ADMIN cambie su propio rol", async () => {
      // Act
      const res = await patchRole(admin.id, { role: "USER" });

      // Assert
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ statusCode: 403, message: SELF_ROLE_CHANGE_FORBIDDEN_MESSAGE });
      expect(await roleOf(admin.id)).toBe("ADMIN");
    });

    it.each([
      ["degradado a USER en la base", { role: "USER" as const }],
      ["desactivado (isActive = false)", { isActive: false }],
    ])("revalida al actor en la base: un ADMIN %s con JWT vigente recibe 403", async (_label, data) => {
      // Arrange — su JWT todavía dice ADMIN (stateless), pero la base ya no
      await db.prisma.user.update({ where: { id: otherAdmin.id }, data });

      // Act
      const res = await patchRole(user.id, { role: "ADMIN" }, otherAdmin);

      // Assert
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ message: ACTOR_NOT_ACTIVE_ADMIN_MESSAGE });
      expect(await roleOf(user.id)).toBe("USER");
      expect(await db.prisma.auditLog.count()).toBe(0);
    });

    it("un JWT ADMIN válido de un usuario que ya no existe recibe 403 sin escritura parcial", async () => {
      // Act
      const res = await patchRole(user.id, { role: "ADMIN" }, { id: randomUUID(), role: "ADMIN" });

      // Assert
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ message: ACTOR_NOT_ACTIVE_ADMIN_MESSAGE });
      expect(await roleOf(user.id)).toBe("USER");
      expect(await db.prisma.auditLog.count()).toBe(0);
    });

    it("un ADMIN degradado no puede distinguir si un usuario existe: recibe 403 también para un id inexistente", async () => {
      // Arrange
      await db.prisma.user.update({ where: { id: otherAdmin.id }, data: { role: "USER" } });

      // Act
      const res = await patchRole("99999999-9999-4999-8999-999999999999", { role: "CHEF" }, otherAdmin);

      // Assert
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ message: ACTOR_NOT_ACTIVE_ADMIN_MESSAGE });
    });
  });

  describe("404 Not Found", () => {
    it("responde 404 si el usuario destino no existe", async () => {
      const res = await patchRole("99999999-9999-4999-8999-999999999999", { role: "CHEF" });
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ statusCode: 404, message: USER_NOT_FOUND_MESSAGE });
      expect(await db.prisma.auditLog.count()).toBe(0);
    });
  });

  describe("Último ADMIN y concurrencia", () => {
    it("dos ADMIN que se degradan mutuamente a la vez: uno gana, el otro recibe 403 y queda un ADMIN activo", async () => {
      // Arrange — barrera: una transacción externa bloquea las filas ADMIN; ambas solicitudes
      // superan el chequeo del servicio y quedan esperando el lock de los ADMIN activos.
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
        patchRole(otherAdmin.id, { role: "USER" }, admin),
        patchRole(admin.id, { role: "USER" }, otherAdmin),
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
      expect(await db.prisma.user.count({ where: { role: "ADMIN", isActive: true } })).toBe(1);
      expect(await db.prisma.auditLog.count({ where: { action: "ROLE_CHANGED" } })).toBe(1);
    });
  });

  describe("Atomicidad (RN-06/RN-09)", () => {
    it("revierte el cambio de rol si falla la inserción de ROLE_CHANGED (500 redactado)", async () => {
      // `$executeRawUnsafe` solo porque el DDL no admite parámetros: interpola únicamente
      // constantes y un UUID generado en esta prueba. No replicar este patrón en `src/`.
      try {
        await db.prisma.$executeRawUnsafe(`
          CREATE OR REPLACE FUNCTION ${AUDIT_FUNCTION}() RETURNS trigger AS $$
          BEGIN
            IF NEW."entityId" = '${user.id}'::uuid THEN
              RAISE EXCEPTION 'fallo forzado (prueba #53)';
            END IF;
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql;
        `);
        await db.prisma.$executeRawUnsafe(
          `CREATE TRIGGER ${AUDIT_TRIGGER} BEFORE INSERT ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION ${AUDIT_FUNCTION}();`,
        );

        // Act
        const res = await patchRole(user.id, { role: "ADMIN" });

        // Assert
        expect(res.status).toBe(500);
        expect(res.body).toMatchObject({ success: false, statusCode: 500 });
        expect(JSON.stringify(res.body)).not.toContain("fallo forzado");
        expect(await roleOf(user.id)).toBe("USER");
        expect(await db.prisma.auditLog.count()).toBe(0);
      } finally {
        await db.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${AUDIT_TRIGGER} ON "audit_logs";`);
        await db.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${AUDIT_FUNCTION}();`);
      }
    });
  });

  describe("CORS", () => {
    it("el preflight permite PATCH desde navegadores", async () => {
      const res = await request(app)
        .options(`/api/v1/users/${user.id}/role`)
        .set("Origin", "https://app.recetaria.com")
        .set("Access-Control-Request-Method", "PATCH")
        .set("Access-Control-Request-Headers", "authorization,content-type");
      expect(res.status).toBe(204);
      expect(String(res.headers["access-control-allow-methods"]).split(",")).toContain("PATCH");
    });
  });
});
