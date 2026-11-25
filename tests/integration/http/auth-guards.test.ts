import { generateKeyPairSync } from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildApp } from "../../../src/app.js";
import { buildApiRouters } from "../../../src/bootstrap/container.js";
import {
  disconnect,
  getDatabase,
  type Database,
} from "../../../src/infrastructure/database/prisma.js";
import {
  createAuthMiddleware,
  type AuthenticatedRequest,
} from "../../../src/middlewares/auth.middleware.js";
import { rbacMiddleware } from "../../../src/middlewares/rbac.middleware.js";
import {
  validateMiddleware,
  type ValidatedRequest,
} from "../../../src/middlewares/validate.middleware.js";
import { INVALID_TOKEN_MESSAGE, type JwtConfig } from "../../../src/modules/auth/index.js";
import { sendSuccess } from "../../../src/shared/http/jsend.js";
import { createDbActorResolver, registerAndLogin } from "../../support/users.js";
import { truncateAll } from "../../support/database.js";

const EXPECTED_MVP_ROLES = ["USER", "CHEF", "NUTRITIONIST", "ADMIN"] as const;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const TEST_JWT_CONFIG: JwtConfig = {
  secret: "test-jwt-secret-".repeat(3),
  expiresIn: "1h",
};
const OTHER_JWT_SECRET = "other-jwt-secret-".repeat(3);

const approveBodySchema = z.strictObject({
  note: z.string({ error: "La nota es obligatoria" }).trim().min(3, "Nota mínima de 3 caracteres"),
});

type ApproveBodyDTO = z.infer<typeof approveBodySchema>;

function toBase64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

async function truncateTables(db: Database): Promise<void> {
  await truncateAll(db);
}

function createGuardsTestApp(options: {
  readonly db: Database;
  readonly authGuard: express.RequestHandler;
  readonly onLog?: (line: string) => void;
  readonly onError?: (message: string, err: unknown) => void;
}): express.Express {
  const protectedRouter = express.Router();

  protectedRouter.get("/me", options.authGuard, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    sendSuccess(res, {
      statusCode: 200,
      message: "Identidad verificada",
      data: { user: authReq.user },
    });
  });

  protectedRouter.post(
    "/approve",
    options.authGuard,
    rbacMiddleware(["CHEF", "NUTRITIONIST"]),
    validateMiddleware({ body: approveBodySchema }),
    (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const validReq = req as ValidatedRequest<ApproveBodyDTO>;
      sendSuccess(res, {
        statusCode: 200,
        message: "Acción autorizada",
        data: {
          actor: authReq.user,
          note: validReq.valid.body?.note,
        },
      });
    },
  );

  protectedRouter.delete(
    "/admin-only",
    options.authGuard,
    rbacMiddleware(["ADMIN"]),
    (req, res) => {
      const authReq = req as AuthenticatedRequest;
      sendSuccess(res, {
        statusCode: 200,
        message: "Acción de administración autorizada",
        data: { actor: authReq.user },
      });
    },
  );

  protectedRouter.get("/rbac-without-auth", rbacMiddleware(["ADMIN"]), (_req, res) => {
    sendSuccess(res, {
      statusCode: 200,
      message: "No debería alcanzarse",
      data: {},
    });
  });

  return buildApp({
    prisma: options.db.prisma,
    jwt: TEST_JWT_CONFIG,
    apiRouters: [
      ...buildApiRouters(options.db.prisma, { jwt: TEST_JWT_CONFIG }),
      { path: "/protected", router: protectedRouter },
    ],
    onLog: options.onLog,
    onError: options.onError,
  });
}

describe("Guardas transversales authMiddleware y rbacMiddleware — Integración HTTP y abuso", () => {
  let db: Database;

  beforeAll(() => {
    db = getDatabase();
  });

  beforeEach(async () => {
    await truncateTables(db);
  });

  afterEach(async () => {
    await truncateTables(db);
  });

  afterAll(async () => {
    await disconnect();
  });

  it.each(EXPECTED_MVP_ROLES)(
    "acepta Bearer JWT real tras login para rol %s devolviendo { id, role } sin fugas en logs",
    async (role) => {
      // Arrange
      const logs: string[] = [];
      const onError = vi.fn();
      const app = createGuardsTestApp({
        db,
        authGuard: createAuthMiddleware({ secret: TEST_JWT_CONFIG.secret, resolveActor: createDbActorResolver(db) }),
        onLog: (line) => logs.push(line),
        onError,
      });
      const { token, userId } = await registerAndLogin(app, db, {
        email: `${role.toLowerCase()}-guards@recetaria.com`,
        role,
      });

      // Act
      const res = await request(app)
        .get("/api/v1/protected/me")
        .set("Authorization", `Bearer ${token}`);

      // Assert
      expect(onError).not.toHaveBeenCalled();
      // USER: register + login + /me; roles privilegiados se siembran (#48): login + /me
      expect(logs).toHaveLength(role === "USER" ? 3 : 2);
      expect(logs.at(-1)).toContain("/api/v1/protected/me");
      expect(logs.join("\n")).not.toContain(token);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        statusCode: 200,
        message: "Identidad verificada",
        data: {
          user: {
            id: userId,
            role,
          },
        },
      });
      expect(res.body.data.user.id).toMatch(UUID_V4_PATTERN);
      expect(Object.keys(res.body.data.user).sort()).toEqual(["id", "role"]);
    },
  );

  it("aplica matriz RBAC RN-04 en ruta restringida a CHEF y NUTRITIONIST (200 vs 403)", async () => {
    // Arrange
    const onError = vi.fn();
    const app = createGuardsTestApp({
      db,
      authGuard: createAuthMiddleware({ secret: TEST_JWT_CONFIG.secret, resolveActor: createDbActorResolver(db) }),
      onLog: vi.fn(),
      onError,
    });
    const userSession = await registerAndLogin(app, db, { email: "user@recetaria.com", role: "USER" });
    const adminSession = await registerAndLogin(app, db, {
      email: "admin@recetaria.com",
      role: "ADMIN",
    });
    const chefSession = await registerAndLogin(app, db, { email: "chef@recetaria.com", role: "CHEF" });
    const nutriSession = await registerAndLogin(app, db, {
      email: "nutri@recetaria.com",
      role: "NUTRITIONIST",
    });

    // Act
    const userRes = await request(app)
      .post("/api/v1/protected/approve")
      .set("Authorization", `Bearer ${userSession.token}`)
      .send({ note: "Aprobación válida" });
    const adminRes = await request(app)
      .post("/api/v1/protected/approve")
      .set("Authorization", `Bearer ${adminSession.token}`)
      .send({ note: "Aprobación válida" });
    const chefRes = await request(app)
      .post("/api/v1/protected/approve")
      .set("Authorization", `Bearer ${chefSession.token}`)
      .send({ note: "  Aprobación gastronómica  " });
    const nutriRes = await request(app)
      .post("/api/v1/protected/approve")
      .set("Authorization", `Bearer ${nutriSession.token}`)
      .send({ note: "Aprobación nutricional" });

    // Assert
    expect(onError).not.toHaveBeenCalled();
    expect(userRes.status).toBe(403);
    expect(adminRes.status).toBe(403);
    for (const forbiddenRes of [userRes, adminRes]) {
      expect(forbiddenRes.body).toEqual({
        success: false,
        statusCode: 403,
        message: "No tienes permisos para realizar esta acción",
        errors: [],
      });
    }

    expect(chefRes.status).toBe(200);
    expect(chefRes.body.data).toEqual({
      actor: { id: chefSession.userId, role: "CHEF" },
      note: "Aprobación gastronómica",
    });
    expect(nutriRes.status).toBe(200);
    expect(nutriRes.body.data.actor).toEqual({
      id: nutriSession.userId,
      role: "NUTRITIONIST",
    });
  });

  it("impone precedencia authMiddleware -> rbacMiddleware -> validateMiddleware antes de parsear body inválido/BOPLA (ADR-0006)", async () => {
    // Arrange
    const onError = vi.fn();
    const app = createGuardsTestApp({
      db,
      authGuard: createAuthMiddleware({ secret: TEST_JWT_CONFIG.secret, resolveActor: createDbActorResolver(db) }),
      onLog: vi.fn(),
      onError,
    });
    const userSession = await registerAndLogin(app, db, { email: "user@recetaria.com", role: "USER" });
    const adminSession = await registerAndLogin(app, db, {
      email: "admin@recetaria.com",
      role: "ADMIN",
    });
    const chefSession = await registerAndLogin(app, db, { email: "chef@recetaria.com", role: "CHEF" });
    const invalidBoplaPayload = { note: "no", injected: true };

    // Act
    const unauthenticatedRes = await request(app)
      .post("/api/v1/protected/approve")
      .send(invalidBoplaPayload);
    const forbiddenUserRes = await request(app)
      .post("/api/v1/protected/approve")
      .set("Authorization", `Bearer ${userSession.token}`)
      .send({});
    const forbiddenAdminRes = await request(app)
      .post("/api/v1/protected/approve")
      .set("Authorization", `Bearer ${adminSession.token}`)
      .send(invalidBoplaPayload);
    const validationChefRes = await request(app)
      .post("/api/v1/protected/approve")
      .set("Authorization", `Bearer ${chefSession.token}`)
      .send(invalidBoplaPayload);

    // Assert
    expect(onError).not.toHaveBeenCalled();
    expect(unauthenticatedRes.status).toBe(401);
    expect(unauthenticatedRes.body).toEqual({
      success: false,
      statusCode: 401,
      message: "Token de autenticación requerido",
      errors: [],
    });

    expect(forbiddenUserRes.status).toBe(403);
    expect(forbiddenAdminRes.status).toBe(403);

    expect(validationChefRes.status).toBe(400);
    expect(validationChefRes.body).toEqual({
      success: false,
      statusCode: 400,
      message: "Error de validación",
      errors: [
        { field: "note", message: "Nota mínima de 3 caracteres" },
        { field: "injected", message: "Campo no permitido" },
      ],
    });
  });

  it("aplica matriz RBAC exclusiva de ADMIN en DELETE /api/v1/protected/admin-only (401, 403 y 200)", async () => {
    // Arrange
    const onError = vi.fn();
    const app = createGuardsTestApp({
      db,
      authGuard: createAuthMiddleware({ secret: TEST_JWT_CONFIG.secret, resolveActor: createDbActorResolver(db) }),
      onLog: vi.fn(),
      onError,
    });
    const userSession = await registerAndLogin(app, db, { email: "user-del@recetaria.com", role: "USER" });
    const chefSession = await registerAndLogin(app, db, { email: "chef-del@recetaria.com", role: "CHEF" });
    const nutriSession = await registerAndLogin(app, db, {
      email: "nutri-del@recetaria.com",
      role: "NUTRITIONIST",
    });
    const adminSession = await registerAndLogin(app, db, {
      email: "admin-del@recetaria.com",
      role: "ADMIN",
    });

    // Act
    const unauthenticatedRes = await request(app).delete("/api/v1/protected/admin-only");
    const userRes = await request(app)
      .delete("/api/v1/protected/admin-only")
      .set("Authorization", `Bearer ${userSession.token}`);
    const chefRes = await request(app)
      .delete("/api/v1/protected/admin-only")
      .set("Authorization", `Bearer ${chefSession.token}`);
    const nutriRes = await request(app)
      .delete("/api/v1/protected/admin-only")
      .set("Authorization", `Bearer ${nutriSession.token}`);
    const adminRes = await request(app)
      .delete("/api/v1/protected/admin-only")
      .set("Authorization", `Bearer ${adminSession.token}`);

    // Assert
    expect(onError).not.toHaveBeenCalled();
    expect(unauthenticatedRes.status).toBe(401);
    expect(unauthenticatedRes.body).toEqual({
      success: false,
      statusCode: 401,
      message: "Token de autenticación requerido",
      errors: [],
    });

    for (const forbiddenRes of [userRes, chefRes, nutriRes]) {
      expect(forbiddenRes.status).toBe(403);
      expect(forbiddenRes.body).toEqual({
        success: false,
        statusCode: 403,
        message: "No tienes permisos para realizar esta acción",
        errors: [],
      });
      expect(forbiddenRes.text).not.toContain("ADMIN");
    }

    expect(adminRes.status).toBe(200);
    expect(adminRes.body).toEqual({
      success: true,
      statusCode: 200,
      message: "Acción de administración autorizada",
      data: {
        actor: {
          id: adminSession.userId,
          role: "ADMIN",
        },
      },
    });
  });

  it("rechaza toda la batería de abuso JWT con 401 JSend exacto sin registrar tokens en logs", async () => {
    // Arrange
    const logs: string[] = [];
    const onError = vi.fn();
    const app = createGuardsTestApp({
      db,
      authGuard: createAuthMiddleware({ secret: TEST_JWT_CONFIG.secret, resolveActor: createDbActorResolver(db) }),
      onLog: (line) => logs.push(line),
      onError,
    });
    const realSession = await registerAndLogin(app, db, { email: "abuse@recetaria.com", role: "USER" });
    const [realHeader, , realSignature] = realSession.token.split(".");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const nowSeconds = Math.floor(Date.now() / 1000);

    const tamperedToken = `${realHeader ?? ""}.${toBase64Url({ id: realSession.userId, role: "ADMIN" })}.${realSignature ?? ""}`;
    const wrongSecretToken = jwt.sign(
      { id: realSession.userId, role: "ADMIN" },
      OTHER_JWT_SECRET,
      { algorithm: "HS256", expiresIn: "1h" },
    );
    const expiredToken = jwt.sign(
      { id: realSession.userId, role: "USER", iat: nowSeconds - 120, exp: nowSeconds - 10 },
      TEST_JWT_CONFIG.secret,
      { algorithm: "HS256" },
    );
    const algNoneToken = `${toBase64Url({ alg: "none", typ: "JWT" })}.${toBase64Url({ id: realSession.userId, role: "ADMIN" })}.`;
    const hs512Token = jwt.sign({ id: realSession.userId, role: "ADMIN" }, TEST_JWT_CONFIG.secret, {
      algorithm: "HS512",
      expiresIn: "1h",
    });
    const rs256Token = jwt.sign({ id: realSession.userId, role: "ADMIN" }, privateKey, {
      algorithm: "RS256",
      expiresIn: "1h",
    });
    const missingRoleToken = jwt.sign({ id: realSession.userId }, TEST_JWT_CONFIG.secret, {
      algorithm: "HS256",
      expiresIn: "1h",
    });
    const badUuidToken = jwt.sign({ id: "not-a-uuid", role: "USER" }, TEST_JWT_CONFIG.secret, {
      algorithm: "HS256",
      expiresIn: "1h",
    });
    const unknownRoleToken = jwt.sign(
      { id: realSession.userId, role: "SUPERADMIN" },
      TEST_JWT_CONFIG.secret,
      { algorithm: "HS256", expiresIn: "1h" },
    );

    const abuseCases: ReadonlyArray<{
      readonly label: string;
      readonly expectedMessage: string;
      readonly header?: string | undefined;
      readonly forgedToken?: string | undefined;
    }> = [
      { label: "sin header Authorization", expectedMessage: "Token de autenticación requerido" },
      {
        label: "esquema Basic",
        expectedMessage: "Token de autenticación requerido",
        header: "Basic dXNlcjpwYXNz",
      },
      {
        label: "prefijo bearer en minúsculas",
        expectedMessage: "Token de autenticación requerido",
        header: `bearer ${realSession.token}`,
      },
      {
        label: "Bearer vacío",
        expectedMessage: "Token de autenticación requerido",
        header: "Bearer ",
      },
      {
        label: "Bearer con segmento extra",
        expectedMessage: "Token de autenticación requerido",
        header: `Bearer ${realSession.token} extra`,
      },
      {
        label: "token malformado",
        expectedMessage: INVALID_TOKEN_MESSAGE,
        header: "Bearer not-a-jwt",
        forgedToken: "not-a-jwt",
      },
      {
        label: "payload manipulado USER -> ADMIN",
        expectedMessage: INVALID_TOKEN_MESSAGE,
        header: `Bearer ${tamperedToken}`,
        forgedToken: tamperedToken,
      },
      {
        label: "firma con secreto diferente",
        expectedMessage: INVALID_TOKEN_MESSAGE,
        header: `Bearer ${wrongSecretToken}`,
        forgedToken: wrongSecretToken,
      },
      {
        label: "token expirado",
        expectedMessage: INVALID_TOKEN_MESSAGE,
        header: `Bearer ${expiredToken}`,
        forgedToken: expiredToken,
      },
      {
        label: "algoritmo none",
        expectedMessage: INVALID_TOKEN_MESSAGE,
        header: `Bearer ${algNoneToken}`,
        forgedToken: algNoneToken,
      },
      {
        label: "algoritmo HS512 con mismo secreto",
        expectedMessage: INVALID_TOKEN_MESSAGE,
        header: `Bearer ${hs512Token}`,
        forgedToken: hs512Token,
      },
      {
        label: "algoritmo RS256",
        expectedMessage: INVALID_TOKEN_MESSAGE,
        header: `Bearer ${rs256Token}`,
        forgedToken: rs256Token,
      },
      {
        label: "payload sin role",
        expectedMessage: INVALID_TOKEN_MESSAGE,
        header: `Bearer ${missingRoleToken}`,
        forgedToken: missingRoleToken,
      },
      {
        label: "payload con id no UUID",
        expectedMessage: INVALID_TOKEN_MESSAGE,
        header: `Bearer ${badUuidToken}`,
        forgedToken: badUuidToken,
      },
      {
        label: "payload con rol desconocido",
        expectedMessage: INVALID_TOKEN_MESSAGE,
        header: `Bearer ${unknownRoleToken}`,
        forgedToken: unknownRoleToken,
      },
    ];

    // Act
    const responses = [];
    for (const testCase of abuseCases) {
      const req = request(app).get("/api/v1/protected/me");
      const res =
        testCase.header !== undefined ? await req.set("Authorization", testCase.header) : await req;
      responses.push({
        label: testCase.label,
        expectedMessage: testCase.expectedMessage,
        res,
      });
    }

    // Assert
    expect(onError).not.toHaveBeenCalled();
    expect(logs).toHaveLength(2 + abuseCases.length);
    const allLogs = logs.join("\n");
    expect(allLogs).not.toContain("Bearer ");
    expect(allLogs).not.toContain(realSession.token);
    for (const testCase of abuseCases) {
      if (testCase.forgedToken !== undefined) {
        expect(allLogs, testCase.label).not.toContain(testCase.forgedToken);
      }
    }
    for (const { label, expectedMessage, res } of responses) {
      expect(res.status, label).toBe(401);
      expect(res.body, label).toEqual({
        success: false,
        statusCode: 401,
        message: expectedMessage,
        errors: [],
      });
    }
  });

  it("aplica el estado vigente: un usuario desactivado tras el login pierde el acceso de inmediato (ADR-0009, #56)", async () => {
    // Arrange
    const app = createGuardsTestApp({
      db,
      authGuard: createAuthMiddleware({ secret: TEST_JWT_CONFIG.secret, resolveActor: createDbActorResolver(db) }),
      onLog: vi.fn(),
      onError: vi.fn(),
    });
    const { token, userId } = await registerAndLogin(app, db, {
      email: "stateless@recetaria.com",
      role: "CHEF",
    });

    await db.prisma.user.update({
      where: { id: userId },
      data: { isActive: false },
    });

    // Act
    const protectedRes = await request(app)
      .get("/api/v1/protected/me")
      .set("Authorization", `Bearer ${token}`);
    const reLoginRes = await request(app).post("/api/v1/auth/login").send({
      email: "stateless@recetaria.com",
      password: "test-password-example",
    });

    // Assert — el JWT sigue firmado y vigente, pero la base ya no autoriza (antes: 200 stateless)
    expect(protectedRes.status).toBe(401);
    expect(protectedRes.body).toMatchObject({ success: false, message: INVALID_TOKEN_MESSAGE });
    expect(reLoginRes.status).toBe(401);
    expect(reLoginRes.body.message).toBe("Credenciales inválidas");
  });

  it("aplica defensa en profundidad en rbacMiddleware sin authMiddleware (401) y fail-closed 500 redactado sin secret JWT", async () => {
    // Arrange
    const onError = vi.fn();
    const failClosedApp = createGuardsTestApp({
      db,
      authGuard: createAuthMiddleware({ resolveActor: createDbActorResolver(db) }),
      onLog: vi.fn(),
      onError,
    });

    // Act
    const rbacOnlyRes = await request(failClosedApp).get("/api/v1/protected/rbac-without-auth");
    const missingSecretRes = await request(failClosedApp)
      .get("/api/v1/protected/me")
      .set("Authorization", "Bearer header.payload.signature");

    // Assert
    expect(rbacOnlyRes.status).toBe(401);
    expect(rbacOnlyRes.body).toEqual({
      success: false,
      statusCode: 401,
      message: "Autenticación requerida",
      errors: [],
    });

    expect(missingSecretRes.status).toBe(500);
    expect(missingSecretRes.body).toEqual({
      success: false,
      statusCode: 500,
      message: "Error interno del servidor",
      errors: [],
    });
    expect(missingSecretRes.text).not.toContain("Configuración JWT");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe("[NON_OPERATIONAL_ERROR]");
  });
});
