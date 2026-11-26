import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SEED_USERS, seedUsers } from "../../prisma/seed.js";
import { buildApp } from "../../src/app.js";
import { disconnect, getDatabase, type Database } from "../../src/infrastructure/database/prisma.js";
import type { UserRole } from "../../src/modules/auth/index.js";
import { truncateAll } from "../support/database.js";
import { E2E_JWT_CONFIG } from "../support/e2e.js";
import { createUserWithRole } from "../support/users.js";

/**
 * Scripts del runbook post-#48 (#51) ejecutados con `psql` REAL contra la base aislada de pruebas
 * (`<base>_test`, #59). Credenciales por variables PG* (nunca en la línea de comandos).
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const AUDIT_SQL = path.join(ROOT, "scripts/ops/audit-privileged-users.sql");
const DEMOTE_SQL = path.join(ROOT, "scripts/ops/demote-privileged-users.sql");

const psqlAvailable = spawnSync("psql", ["--version"], { encoding: "utf8" }).status === 0;

type PsqlResult = Readonly<{ code: number; out: string }>;

function psql(script: string, vars: Readonly<Record<string, string>> = {}): PsqlResult {
  const url = new URL(process.env["DATABASE_URL"] ?? "");
  expect(url.pathname, "los scripts solo se prueban contra la base _test").toMatch(/_test$/);
  const res = spawnSync(
    "psql",
    ["-X", "-q", "-A", "-F", "|", ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`])],
    {
      input: script,
      encoding: "utf8",
      env: {
        PATH: process.env["PATH"] ?? "",
        PGHOST: url.hostname,
        PGPORT: url.port || "5432",
        PGUSER: decodeURIComponent(url.username),
        PGPASSWORD: decodeURIComponent(url.password),
        PGDATABASE: url.pathname.slice(1),
        PGCONNECT_TIMEOUT: "5",
        // Mensajes del servidor en inglés: las aserciones no dependen del idioma de la instancia
        PGOPTIONS: "-c lc_messages=C",
      },
      timeout: 30_000,
    },
  );
  return { code: res.status ?? 1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

const auditScript = () => readFileSync(AUDIT_SQL, "utf8");
const demoteScript = () => readFileSync(DEMOTE_SQL, "utf8");

describe.skipIf(!psqlAvailable)("Scripts del runbook post-#48 (#51) — psql real contra la base de pruebas", () => {
  let db: Database;
  let intruder: { id: string; email: string };
  let intruderChef: { id: string; email: string };
  let operator: { id: string; email: string };

  beforeEach(async () => {
    db = getDatabase();
    await truncateAll(db);
    await seedUsers(db.prisma);
    operator = await db.prisma.user.findUniqueOrThrow({
      where: { email: "admin@recetaria.com" },
      select: { id: true, email: true },
    });
    // Cuentas privilegiadas "auto-registradas" antes de #48: sin seed ni ROLE_CHANGED
    intruder = await createUserWithRole(db, { email: "intruso-admin@recetaria.com", role: "ADMIN" });
    intruderChef = await createUserWithRole(db, { email: "intruso-chef@recetaria.com", role: "CHEF" });
  });

  afterAll(async () => {
    await truncateAll(db);
    await disconnect();
  });

  async function snapshot() {
    const [users, audits] = await Promise.all([
      db.prisma.user.findMany({ select: { email: true, role: true, isActive: true }, orderBy: { email: "asc" } }),
      db.prisma.auditLog.count(),
    ]);
    return { users, audits };
  }

  async function roleOf(email: string): Promise<{ role: UserRole; isActive: boolean }> {
    return db.prisma.user.findUniqueOrThrow({ where: { email }, select: { role: true, isActive: true } });
  }

  describe("audit-privileged-users.sql (solo lectura)", () => {
    it("los emails y roles del seed coinciden con SEED_USERS (prisma/seed.ts)", () => {
      const values = [...auditScript().matchAll(/\('([^']+@recetaria\.com)', '([A-Z]+)'\)/g)].map((m) => `${m[1]}:${m[2]}`);
      // La lista aparece en cada consulta del script: todas las copias deben coincidir con el seed
      expect([...new Set(values)].sort()).toEqual(SEED_USERS.map((u) => `${u.email}:${u.role}`).sort());
      expect(values.length % SEED_USERS.length).toBe(0);
    });

    it("clasifica: seed, otorgado por ADMIN y SIN RASTRO (las candidatas a remediar)", async () => {
      // Arrange — un rol otorgado legítimamente por la API deja ROLE_CHANGED
      const granted = await createUserWithRole(db, { email: "otorgada@recetaria.com", role: "NUTRITIONIST" });
      await db.prisma.auditLog.create({
        data: {
          entityName: "User",
          entityId: granted.id,
          action: "ROLE_CHANGED",
          userId: operator.id,
          oldValues: { role: "USER" },
          newValues: { role: "NUTRITIONIST" },
        },
      });
      const before = await snapshot();

      // Act
      const res = psql(auditScript());

      // Assert
      expect(res.code, res.out).toBe(0);
      const rows = res.out.split("\n");
      // Columnas: id|email|role|activo|creado|otorgado_por|origen (se compara la columna email exacta)
      const originOf = (email: string) => rows.map((line) => line.split("|")).find((cols) => cols[1] === email)?.at(-1);
      expect(originOf("intruso-admin@recetaria.com")).toBe("SIN RASTRO");
      expect(originOf("intruso-chef@recetaria.com")).toBe("SIN RASTRO");
      expect(originOf("otorgada@recetaria.com")).toBe("otorgado por ADMIN");
      expect(originOf("admin@recetaria.com")).toBe("seed");
      expect(originOf("chef@recetaria.com")).toBe("seed");
      expect(rows.some((line) => line.split("|")[1] === "user@recetaria.com"), "los USER no se listan").toBe(false);
      expect(res.out).toContain("SIN RASTRO|2|2");
      expect(await snapshot()).toEqual(before);
    });

    it("un rol otorgado por una cuenta SIN RASTRO (un intruso que usó /role) no pasa por legítimo", async () => {
      // Arrange — el intruso ADMIN promovió a un cómplice antes de ser remediado
      const accomplice = await createUserWithRole(db, { email: "complice@recetaria.com", role: "CHEF" });
      await db.prisma.auditLog.create({
        data: {
          entityName: "User",
          entityId: accomplice.id,
          action: "ROLE_CHANGED",
          userId: intruder.id,
          oldValues: { role: "USER" },
          newValues: { role: "CHEF" },
        },
      });

      // Act
      const res = psql(auditScript());

      // Assert — muestra quién lo otorgó y lo marca para revisar
      expect(res.code, res.out).toBe(0);
      const row = res.out.split("\n").map((line) => line.split("|")).find((cols) => cols[1] === "complice@recetaria.com");
      expect(row?.at(-2)).toBe("intruso-admin@recetaria.com");
      expect(row?.at(-1)).toBe("otorgado por cuenta SIN RASTRO");
    });

    it("un seed con un rol distinto al del seed y sin auditoría aparece SIN RASTRO", async () => {
      await db.prisma.user.update({ where: { email: "chef@recetaria.com" }, data: { role: "ADMIN" } });
      const res = psql(auditScript());
      expect(res.code, res.out).toBe(0);
      expect(res.out.split("\n").map((l) => l.split("|")).find((cols) => cols[1] === "chef@recetaria.com")?.at(-1)).toBe("SIN RASTRO");
    });

    it("es de solo lectura incluso si se le agrega una escritura (la transacción READ ONLY la rechaza)", async () => {
      const before = await snapshot();
      const tampered = auditScript().replace(
        "ROLLBACK;",
        "UPDATE users SET role = 'USER' WHERE email = 'intruso-admin@recetaria.com';\nROLLBACK;",
      );
      const res = psql(tampered);
      expect(res.code).not.toBe(0);
      expect(res.out).toMatch(/cannot execute UPDATE in a read-only transaction/);
      expect(await snapshot()).toEqual(before);
    });
  });

  describe("demote-privileged-users.sql — guardas (fail closed, sin cambios)", () => {
    const valid = () => ({ emails: intruder.email, mode: "demote", operator_email: operator.email, apply: "1" });

    it.each([
      ["sin emails", { mode: "demote", operator_email: "admin@recetaria.com", apply: "1" }, /falta -v emails/],
      ["sin mode", { emails: "intruso-admin@recetaria.com", operator_email: "admin@recetaria.com", apply: "1" }, /falta -v mode/],
      ["sin operator_email", { emails: "intruso-admin@recetaria.com", mode: "demote", apply: "1" }, /falta -v operator_email/],
      ["lista vacía", { emails: " , ", mode: "demote", operator_email: "admin@recetaria.com", apply: "1" }, /lista de emails está vacía/],
      ["mode inválido", { emails: "intruso-admin@recetaria.com", mode: "borrar", operator_email: "admin@recetaria.com", apply: "1" }, /mode inválido/],
      ["email inexistente", { emails: "nadie@recetaria.com", mode: "demote", operator_email: "admin@recetaria.com", apply: "1" }, /emails inexistentes: nadie@recetaria\.com/],
      ["operador que no es ADMIN", { emails: "intruso-admin@recetaria.com", mode: "demote", operator_email: "chef@recetaria.com", apply: "1" }, /no es un ADMIN activo/],
      ["operador dentro de la lista", { emails: "admin@recetaria.com", mode: "demote", operator_email: "admin@recetaria.com", apply: "1" }, /no puede remediarse a sí mismo/],
      ["cuenta que ya es USER", { emails: "user@recetaria.com", mode: "demote", operator_email: "admin@recetaria.com", apply: "1" }, /ya son USER/],
      ["lista mixta (un email válido y uno inexistente): aborta todo", { emails: "intruso-admin@recetaria.com,nadie@recetaria.com", mode: "demote", operator_email: "admin@recetaria.com", apply: "1" }, /emails inexistentes: nadie@recetaria\.com/],
    ])("aborta con código ≠ 0: %s", async (_label, vars, message) => {
      const before = await snapshot();
      const res = psql(demoteScript(), vars);
      expect(res.code).not.toBe(0);
      expect(res.out).toMatch(message);
      expect(await snapshot()).toEqual(before);
    });

    it("aborta si el operador es ADMIN pero está desactivado", async () => {
      // Arrange
      await db.prisma.user.update({ where: { email: operator.email }, data: { isActive: false } });
      const before = await snapshot();

      // Act
      const res = psql(demoteScript(), valid());

      // Assert
      expect(res.code).not.toBe(0);
      expect(res.out).toMatch(/no es un ADMIN activo/);
      expect(await snapshot()).toEqual(before);
    });
  });

  describe("demote-privileged-users.sql — simulación y aplicación", () => {
    it("sin -v apply=1 es una simulación: muestra la vista previa y no cambia nada", async () => {
      const before = await snapshot();
      for (const apply of [undefined, "0", "yes"]) {
        const res = psql(demoteScript(), {
          emails: `${intruder.email},${intruderChef.email}`,
          mode: "both",
          operator_email: operator.email,
          ...(apply === undefined ? {} : { apply }),
        });
        expect(res.code, res.out).toBe(0);
        expect(res.out).toContain(`${intruder.email}|ROLE_CHANGED|{"role": "ADMIN"}|{"role": "USER"}`);
        expect(res.out).toContain(`${intruderChef.email}|ACCOUNT_DEACTIVATED|{"isActive": true}|{"isActive": false}`);
        expect(res.out).toContain("SIMULACIÓN");
        expect(await snapshot()).toEqual(before);
      }
    });

    it("con -v apply=1 degrada SOLO las cuentas listadas, con un ROLE_CHANGED canónico por cuenta a nombre del operador", async () => {
      // Act
      const res = psql(demoteScript(), { emails: ` ${intruder.email.toUpperCase()} `, mode: "demote", operator_email: operator.email, apply: "1" });

      // Assert
      expect(res.code, res.out).toBe(0);
      expect(res.out).toContain("APLICADO");
      expect(await roleOf(intruder.email)).toEqual({ role: "USER", isActive: true });
      expect(await roleOf(intruderChef.email)).toEqual({ role: "CHEF", isActive: true });
      expect(await roleOf("admin@recetaria.com")).toEqual({ role: "ADMIN", isActive: true });
      const logs = await db.prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        entityName: "User",
        entityId: intruder.id,
        action: "ROLE_CHANGED",
        userId: operator.id,
        oldValues: { role: "ADMIN" },
        newValues: { role: "USER" },
      });
    });

    it("mode=both degrada y desactiva; no audita lo que ya estaba (cuenta ya inactiva)", async () => {
      // Arrange
      await db.prisma.user.update({ where: { id: intruderChef.id }, data: { isActive: false } });

      // Act
      const res = psql(demoteScript(), {
        emails: `${intruder.email},${intruderChef.email}`,
        mode: "both",
        operator_email: operator.email,
        apply: "1",
      });

      // Assert
      expect(res.code, res.out).toBe(0);
      expect(await roleOf(intruder.email)).toEqual({ role: "USER", isActive: false });
      expect(await roleOf(intruderChef.email)).toEqual({ role: "USER", isActive: false });
      const actions = (await db.prisma.auditLog.findMany({ orderBy: [{ entityId: "asc" }, { action: "asc" }] })).map(
        (log) => `${log.entityId === intruder.id ? "admin" : "chef"}:${log.action}`,
      );
      expect(actions.sort()).toEqual(["admin:ACCOUNT_DEACTIVATED", "admin:ROLE_CHANGED", "chef:ROLE_CHANGED"]);
    });

    it("mode=deactivate solo desactiva (conserva el rol) y registra ACCOUNT_DEACTIVATED", async () => {
      const res = psql(demoteScript(), { emails: intruder.email, mode: "deactivate", operator_email: operator.email, apply: "1" });
      expect(res.code, res.out).toBe(0);
      expect(await roleOf(intruder.email)).toEqual({ role: "ADMIN", isActive: false });
      const logs = await db.prisma.auditLog.findMany();
      expect(logs.map((log) => [log.action, log.oldValues, log.newValues])).toEqual([
        ["ACCOUNT_DEACTIVATED", { isActive: true }, { isActive: false }],
      ]);
    });

    it("mode=deactivate sobre una cuenta ya inactiva termina en 0, sin cambios ni auditoría", async () => {
      await db.prisma.user.update({ where: { id: intruder.id }, data: { isActive: false } });
      const before = await snapshot();
      const res = psql(demoteScript(), { emails: intruder.email, mode: "deactivate", operator_email: operator.email, apply: "1" });
      expect(res.code, res.out).toBe(0);
      expect(await snapshot()).toEqual(before);
    });

    it("los emails duplicados en la lista se procesan una sola vez", async () => {
      const res = psql(demoteScript(), {
        emails: `${intruder.email}, ${intruder.email},${intruder.email.toUpperCase()}`,
        mode: "demote",
        operator_email: operator.email,
        apply: "1",
      });
      expect(res.code, res.out).toBe(0);
      expect(await db.prisma.auditLog.count()).toBe(1);
    });

    it("después de remediar, la auditoría ya no lista cuentas SIN RASTRO activas", async () => {
      psql(demoteScript(), { emails: `${intruder.email},${intruderChef.email}`, mode: "demote", operator_email: operator.email, apply: "1" });
      const res = psql(auditScript());
      expect(res.code, res.out).toBe(0);
      // Ninguna fila de detalle ni del resumen con origen SIN RASTRO (el encabezado no cuenta)
      expect(res.out.split("\n").filter((line) => /\|SIN RASTRO(\||$)/.test(line))).toEqual([]);
    });
  });
});

describe("Paso 4 del runbook: efecto en la API (ADR-0009) y rotación de JWT_SECRET", () => {
  let db: Database;
  const OLD = { ...E2E_JWT_CONFIG, secret: "secreto-anterior-".repeat(3) };
  const NEW = { ...E2E_JWT_CONFIG, secret: "secreto-rotado-nuevo-".repeat(3) };
  const appWith = (jwtConfig: typeof OLD): express.Express =>
    buildApp({ prisma: db.prisma, jwt: jwtConfig, publicRateLimit: false, authRateLimit: false, onLog: () => undefined, onError: () => undefined });

  beforeEach(async () => {
    db = getDatabase();
    await truncateAll(db);
    await seedUsers(db.prisma);
  });

  afterAll(async () => {
    await truncateAll(db);
    await disconnect();
  });

  it("degradar a un ADMIN corta su acceso privilegiado de inmediato, aunque su JWT siga vigente", async () => {
    // Arrange — token del intruso emitido antes de la remediación
    const intruder = await createUserWithRole(db, { email: "intruso-admin@recetaria.com", role: "ADMIN" });
    const token = jwt.sign({ id: intruder.id, role: "ADMIN" }, OLD.secret, { algorithm: "HS256", expiresIn: "1h" });
    await db.prisma.user.update({ where: { id: intruder.id }, data: { role: "USER" } });
    const victim = await db.prisma.user.findUniqueOrThrow({ where: { email: "user@recetaria.com" } });

    // Act
    const res = await request(appWith(OLD))
      .patch(`/api/v1/users/${victim.id}/role`)
      .set("Authorization", `Bearer ${token}`)
      .send({ role: "ADMIN" });

    // Assert
    expect(res.status).toBe(403);
  });

  it("tras rotar JWT_SECRET, un token emitido antes recibe 401 y un login nuevo funciona", async () => {
    // Arrange — sesión con el secreto anterior
    const credentials = { email: "admin@recetaria.com", password: "password123" };
    const before = await request(appWith(OLD)).post("/api/v1/auth/login").send(credentials);
    const oldToken = String(before.body.data.token);

    // Act — la API reinicia con el secreto rotado
    const rotated = appWith(NEW);
    const withOldToken = await request(rotated).get("/api/v1/recipes/mine").set("Authorization", `Bearer ${oldToken}`);
    const relogin = await request(rotated).post("/api/v1/auth/login").send(credentials);
    const withNewToken = await request(rotated)
      .get("/api/v1/recipes/mine")
      .set("Authorization", `Bearer ${String(relogin.body.data.token)}`);

    // Assert
    expect(withOldToken.status).toBe(401);
    expect(withOldToken.body).toMatchObject({ success: false, message: "Token inválido o expirado" });
    expect(relogin.status).toBe(200);
    expect(withNewToken.status).toBe(200);
  });
});
