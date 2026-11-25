import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  INVALID_TOKEN_MESSAGE,
  MIN_JWT_SECRET_LENGTH,
  signAccessToken,
  type Actor,
  type UserRole,
} from "../modules/auth/index.js";
import { AppError, UnauthorizedError } from "../shared/errors/app-error.js";
import {
  createAuthMiddleware,
  type ActorResolver,
  extractBearerToken,
  type AuthenticatedRequest,
} from "./auth.middleware.js";

const EXPECTED_MVP_ROLES = ["USER", "CHEF", "NUTRITIONIST", "ADMIN"] as const;
const TEST_JWT_SECRET = "test-jwt-secret-".repeat(3);
const OTHER_JWT_SECRET = "other-jwt-secret-".repeat(3);
const VALID_UUID = "33333333-3333-4333-8333-333333333333";

/** Resolvedor que simula un usuario activo con `role` vigente en la base (#56, ADR-0009). */
function activeAs(role: UserRole): ActorResolver {
  return (id) => Promise.resolve({ id, role });
}

/** Resolvedor que nunca debería invocarse (token inválido, header ausente o sin secreto). */
function neverResolve(): ReturnType<typeof vi.fn<ActorResolver>> {
  return vi.fn<ActorResolver>().mockRejectedValue(new Error("resolveActor no debía llamarse"));
}

function toBase64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function createAuthTestHarness(options: {
  readonly middleware: express.RequestHandler;
  readonly preAssignedUser?: Actor | undefined;
}): {
  readonly app: express.Express;
  readonly nextErrors: unknown[];
  readonly getCapturedUserOnError: () => Actor | undefined;
} {
  const nextErrors: unknown[] = [];
  let capturedUserOnError: Actor | undefined;
  const app = express();

  app.use((req, _res, next) => {
    if (options.preAssignedUser !== undefined) {
      req.user = options.preAssignedUser;
    }
    next();
  });

  app.get("/protected", options.middleware, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    res.status(200).json({
      user: authReq.user,
      isFrozen: Object.isFrozen(authReq.user),
    });
  });

  app.use(
    (err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
      nextErrors.push(err);
      capturedUserOnError = req.user;
      const statusCode =
        typeof err === "object" &&
        err !== null &&
        "statusCode" in err &&
        typeof err.statusCode === "number"
          ? err.statusCode
          : 500;
      res.status(statusCode).json({ delegated: true });
    },
  );

  return {
    app,
    nextErrors,
    getCapturedUserOnError: () => capturedUserOnError,
  };
}

describe("extractBearerToken", () => {
  it("extrae el token exacto ante prefijo Bearer válido", () => {
    // Arrange
    const header = "Bearer header.payload.signature";

    // Act
    const extracted = extractBearerToken(header);

    // Assert
    expect(extracted).toBe("header.payload.signature");
  });

  it.each([
    { label: "header undefined", header: undefined },
    { label: "array de headers", header: ["Bearer a.b.c"] },
    { label: "cadena vacía", header: "" },
    { label: "esquema Basic", header: "Basic dXNlcjpwYXNz" },
    { label: "prefijo bearer en minúsculas", header: "bearer header.payload.signature" },
    { label: "prefijo BEARER en mayúsculas", header: "BEARER header.payload.signature" },
    { label: "prefijo Token", header: "Token header.payload.signature" },
    { label: "Bearer sin espacio ni token", header: "Bearer" },
    { label: "Bearer con token vacío", header: "Bearer " },
    { label: "Bearer solo espacios", header: "Bearer    " },
    { label: "doble espacio tras Bearer", header: "Bearer  header.payload.signature" },
    { label: "token con segmento adicional", header: "Bearer header.payload.signature extra" },
    { label: "espacio previo al prefijo", header: " Bearer header.payload.signature" },
    { label: "token con salto CRLF", header: "Bearer header.payload.signature\r\n" },
  ])("retorna null ante formato inválido ($label)", ({ header }) => {
    // Arrange
    const candidate = header;

    // Act
    const extracted = extractBearerToken(candidate);

    // Assert
    expect(extracted).toBeNull();
  });
});

describe("createAuthMiddleware", () => {
  it.each([
    { label: "secreto vacío", secret: "" },
    { label: "secreto menor a 32 chars", secret: "a".repeat(MIN_JWT_SECRET_LENGTH - 1) },
    { label: "secreto solo espacios", secret: " ".repeat(40) },
  ])("falla fast-fail en construcción con RangeError si $label", ({ secret }) => {
    // Arrange
    const invalidSecret = secret;

    // Act & Assert
    expect(() => createAuthMiddleware({ secret: invalidSecret, resolveActor: neverResolve() })).toThrow(
      RangeError,
    );
  });

  it.each([
    { label: "con header Bearer válido", includeBearerHeader: true },
    { label: "sin header Authorization", includeBearerHeader: false },
  ])(
    "falla cerrado con AppError 500 no operacional cuando no recibe secret ($label) y limpia req.user previo",
    async ({ includeBearerHeader }) => {
      // Arrange
      const validToken = signAccessToken(
        { id: VALID_UUID, role: "USER" },
        { secret: TEST_JWT_SECRET, expiresIn: "1h" },
      );
      const harness = createAuthTestHarness({
        middleware: createAuthMiddleware({ resolveActor: neverResolve() }),
        preAssignedUser: { id: VALID_UUID, role: "ADMIN" },
      });

      // Act
      const req = request(harness.app).get("/protected");
      const res = includeBearerHeader
        ? await req.set("Authorization", `Bearer ${validToken}`)
        : await req;

      // Assert
      expect(res.status).toBe(500);
      expect(harness.getCapturedUserOnError()).toBeUndefined();
      expect(harness.nextErrors).toHaveLength(1);
      const passedError = harness.nextErrors[0];
      expect(passedError).toBeInstanceOf(AppError);
      if (passedError instanceof AppError) {
        expect(passedError.statusCode).toBe(500);
        expect(passedError.isOperational).toBe(false);
        expect(passedError.message).toBe("Configuración JWT no inicializada");
      }
    },
  );

  it.each(EXPECTED_MVP_ROLES)(
    "verifica Bearer JWT HS256 para rol %s y adjunta req.user congelado { id, role }",
    async (role) => {
      // Arrange
      const token = signAccessToken(
        { id: VALID_UUID, role },
        { secret: TEST_JWT_SECRET, expiresIn: "1h" },
      );
      const harness = createAuthTestHarness({
        middleware: createAuthMiddleware({ secret: TEST_JWT_SECRET, resolveActor: activeAs(role) }),
      });

      // Act
      const res = await request(harness.app)
        .get("/protected")
        .set("Authorization", `Bearer ${token}`);

      // Assert
      expect(res.status).toBe(200);
      expect(harness.nextErrors).toHaveLength(0);
      expect(res.body).toEqual({
        user: { id: VALID_UUID, role },
        isFrozen: true,
      });
    },
  );

  it.each([
    { label: "header ausente", header: undefined },
    { label: "esquema Basic", header: "Basic dXNlcjpwYXNz" },
    { label: "prefijo bearer en minúsculas", header: "bearer a.b.c" },
    { label: "Bearer vacío", header: "Bearer " },
    { label: "Bearer con texto extra", header: "Bearer a.b.c extra" },
  ])(
    "rechaza con UnauthorizedError 401 y limpia req.user previo ante $label",
    async ({ header }) => {
      // Arrange
      const resolveActor = neverResolve();
      const harness = createAuthTestHarness({
        middleware: createAuthMiddleware({ secret: TEST_JWT_SECRET, resolveActor }),
        preAssignedUser: { id: VALID_UUID, role: "ADMIN" },
      });

      // Act
      const req = request(harness.app).get("/protected");
      const res = header !== undefined ? await req.set("Authorization", header) : await req;

      // Assert
      expect(res.status).toBe(401);
      expect(harness.getCapturedUserOnError()).toBeUndefined();
      expect(harness.nextErrors).toHaveLength(1);
      const passedError = harness.nextErrors[0];
      expect(passedError).toBeInstanceOf(UnauthorizedError);
      if (passedError instanceof UnauthorizedError) {
        expect(passedError.statusCode).toBe(401);
        expect(passedError.message).toBe("Token de autenticación requerido");
        expect(passedError.errors).toBeUndefined();
      }
      expect(resolveActor).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      label: "firma con otro secreto",
      buildToken: () =>
        signAccessToken(
          { id: VALID_UUID, role: "ADMIN" },
          { secret: OTHER_JWT_SECRET, expiresIn: "1h" },
        ),
    },
    {
      label: "token manipulado",
      buildToken: () => {
        const base = signAccessToken(
          { id: VALID_UUID, role: "USER" },
          { secret: TEST_JWT_SECRET, expiresIn: "1h" },
        );
        const [headerSeg, , signatureSeg] = base.split(".");
        return `${headerSeg ?? ""}.${toBase64Url({ id: VALID_UUID, role: "ADMIN" })}.${signatureSeg ?? ""}`;
      },
    },
    {
      label: "token expirado",
      buildToken: () => {
        const now = Math.floor(Date.now() / 1000);
        return jwt.sign(
          { id: VALID_UUID, role: "USER", iat: now - 120, exp: now - 10 },
          TEST_JWT_SECRET,
          { algorithm: "HS256" },
        );
      },
    },
    {
      label: "algoritmo none",
      buildToken: () =>
        `${toBase64Url({ alg: "none", typ: "JWT" })}.${toBase64Url({ id: VALID_UUID, role: "ADMIN" })}.`,
    },
    {
      label: "algoritmo HS512",
      buildToken: () =>
        jwt.sign({ id: VALID_UUID, role: "ADMIN" }, TEST_JWT_SECRET, {
          algorithm: "HS512",
          expiresIn: "1h",
        }),
    },
    {
      label: "payload sin role",
      buildToken: () => jwt.sign({ id: VALID_UUID }, TEST_JWT_SECRET, { algorithm: "HS256" }),
    },
  ])(
    "rechaza con UnauthorizedError 401 y limpia req.user previo ante $label",
    async ({ buildToken }) => {
      // Arrange
      const badToken = buildToken();
      const resolveActor = neverResolve();
      const harness = createAuthTestHarness({
        middleware: createAuthMiddleware({ secret: TEST_JWT_SECRET, resolveActor }),
        preAssignedUser: { id: VALID_UUID, role: "ADMIN" },
      });

      // Act
      const res = await request(harness.app)
        .get("/protected")
        .set("Authorization", `Bearer ${badToken}`);

      // Assert
      expect(res.status).toBe(401);
      expect(harness.getCapturedUserOnError()).toBeUndefined();
      expect(harness.nextErrors).toHaveLength(1);
      const passedError = harness.nextErrors[0];
      expect(passedError).toBeInstanceOf(UnauthorizedError);
      if (passedError instanceof UnauthorizedError) {
        expect(passedError.statusCode).toBe(401);
        expect(passedError.message).toBe(INVALID_TOKEN_MESSAGE);
        expect(passedError.errors).toBeUndefined();
      }
      expect(resolveActor).not.toHaveBeenCalled();
    },
  );
});

describe("createAuthMiddleware — estado vigente del actor en la base (#56, ADR-0009)", () => {
  function tokenFor(role: UserRole): string {
    return signAccessToken({ id: VALID_UUID, role }, { secret: TEST_JWT_SECRET, expiresIn: "1h" });
  }

  it("impone el rol de la base aunque el token declare otro (un degradado opera con su rol nuevo)", async () => {
    // Arrange — el token dice ADMIN; la base dice USER
    const resolveActor = vi.fn<ActorResolver>(activeAs("USER"));
    const harness = createAuthTestHarness({
      middleware: createAuthMiddleware({ secret: TEST_JWT_SECRET, resolveActor }),
    });

    // Act
    const res = await request(harness.app).get("/protected").set("Authorization", `Bearer ${tokenFor("ADMIN")}`);

    // Assert
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: { id: VALID_UUID, role: "USER" }, isFrozen: true });
    expect(resolveActor).toHaveBeenCalledWith(VALID_UUID);
  });

  it("responde 401 con el mensaje genérico de token inválido si el actor no existe o está inactivo", async () => {
    // Arrange
    const harness = createAuthTestHarness({
      middleware: createAuthMiddleware({ secret: TEST_JWT_SECRET, resolveActor: () => Promise.resolve(null) }),
      preAssignedUser: { id: VALID_UUID, role: "ADMIN" },
    });

    // Act
    const res = await request(harness.app).get("/protected").set("Authorization", `Bearer ${tokenFor("CHEF")}`);

    // Assert — no revela si la cuenta existe o está suspendida
    expect(res.status).toBe(401);
    expect(harness.getCapturedUserOnError()).toBeUndefined();
    expect(harness.nextErrors[0]).toBeInstanceOf(UnauthorizedError);
    expect(harness.nextErrors[0]).toMatchObject({ message: INVALID_TOKEN_MESSAGE });
  });

  it("responde 401 si el resolvedor devuelve un actor con otro id (fail closed)", async () => {
    // Arrange
    const harness = createAuthTestHarness({
      middleware: createAuthMiddleware({
        secret: TEST_JWT_SECRET,
        resolveActor: () => Promise.resolve({ id: "44444444-4444-4444-8444-444444444444", role: "ADMIN" }),
      }),
    });

    // Act
    const res = await request(harness.app).get("/protected").set("Authorization", `Bearer ${tokenFor("USER")}`);

    // Assert
    expect(res.status).toBe(401);
  });

  it("propaga un fallo de la base a next(err) sin convertirlo en 401", async () => {
    // Arrange
    const failure = new Error("PostgreSQL no disponible");
    const harness = createAuthTestHarness({
      middleware: createAuthMiddleware({ secret: TEST_JWT_SECRET, resolveActor: () => Promise.reject(failure) }),
    });

    // Act
    const res = await request(harness.app).get("/protected").set("Authorization", `Bearer ${tokenFor("USER")}`);

    // Assert
    expect(res.status).toBe(500);
    expect(harness.nextErrors).toEqual([failure]);
    expect(harness.getCapturedUserOnError()).toBeUndefined();
  });
});
