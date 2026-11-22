import express, { type Express, type Router } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildApp } from "../../../src/app.js";
import { validateMiddleware } from "../../../src/middlewares/validate.middleware.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
} from "../../../src/shared/errors/app-error.js";
import { sendSuccess } from "../../../src/shared/http/jsend.js";

function createTestRouter(): Router {
  const router = express.Router();

  router.get(
    "/items/:id",
    validateMiddleware({
      params: z.strictObject({ id: z.uuid("UUID inválido") }),
      query: z.strictObject({
        page: z.coerce.number().int().min(1, "La página debe ser >= 1").default(1),
        tag: z.string().trim().min(1).optional(),
      }),
    }),
    (req, res) => {
      sendSuccess(res, {
        message: "Ítem obtenido",
        data: {
          valid: req.valid,
          rawQuery: req.query,
        },
      });
    },
  );

  router.get("/query-simple", (req, res) => {
    sendSuccess(res, {
      message: "Query inspeccionada",
      data: {
        hasBracketKey: Object.hasOwn(req.query, "filter[status]"),
        value: req.query["filter[status]"],
      },
    });
  });

  router.get("/proxy-ip", (req, res) => {
    sendSuccess(res, {
      message: "IP resuelta",
      data: { ip: req.ip ?? null },
    });
  });

  router.post("/urlencoded", (req, res) => {
    sendSuccess(res, {
      message: "Formulario recibido",
      data: { body: req.body },
    });
  });

  router.post(
    "/strict-body",
    validateMiddleware({
      body: z.strictObject({
        title: z.string({ error: "Título obligatorio" }).trim().min(3),
        isOptional: z.boolean().optional(),
      }),
    }),
    (req, res) => {
      sendSuccess(res, {
        statusCode: 201,
        message: "Receta validada",
        data: req.valid?.body ?? {},
      });
    },
  );

  router.get("/zod-throw", () => {
    z.strictObject({ code: z.string("Código de texto requerido") }).parse({
      code: 42,
      extra: true,
    });
  });

  router.get("/auth-error", () => {
    throw new UnauthorizedError("Token faltante o inválido");
  });

  router.get("/forbidden-error", () => {
    throw new ForbiddenError("Solo CHEF o NUTRITIONIST pueden aprobar");
  });

  router.get("/async-not-found", async () => {
    await Promise.resolve();
    throw new NotFoundError("Receta no encontrada");
  });

  router.get("/conflict-error", () => {
    throw new ConflictError("La receta ya está aprobada");
  });

  router.get("/service-unavailable", async () => {
    await Promise.resolve();
    throw new ServiceUnavailableError("PostgreSQL no responde");
  });

  router.post("/prisma-p2002", async () => {
    await Promise.reject({
      code: "P2002",
      meta: { target: ["users_email_key"] },
    });
  });

  router.get("/prisma-p2025", async () => {
    await Promise.reject({
      code: "P2025",
      meta: { cause: "Record to delete does not exist" },
    });
  });

  router.get("/boom", async () => {
    await Promise.resolve();
    throw new Error("PG_PASSWORD=SECRET_BOOM; SELECT * FROM users");
  });

  return router;
}

function buildTestApp(overrides?: {
  readonly trustProxy?: boolean | number | string;
  readonly onLog?: (line: string) => void;
  readonly onError?: (message: string, err: unknown) => void;
}): Express {
  return buildApp({
    apiRouters: [{ path: "/test", router: createTestRouter() }],
    trustProxy: overrides?.trustProxy,
    onLog: overrides?.onLog ?? vi.fn(),
    onError: overrides?.onError ?? vi.fn(),
  });
}

describe("Integración HTTP sobre buildApp (Express 5 + Middlewares + JSend)", () => {
  it("200 OK valida params/query en req.valid, emite sobre JSend, incluye CORS y omite X-Powered-By", async () => {
    // Arrange
    const app = buildTestApp();
    const validId = "550e8400-e29b-41d4-a716-446655440000";

    // Act
    const res = await request(app).get(`/api/v1/test/items/${validId}?page=3&tag=vegan`);

    // Assert
    expect(res.status).toBe(200);
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.body).toEqual({
      success: true,
      statusCode: 200,
      message: "Ítem obtenido",
      data: {
        valid: {
          params: { id: validId },
          query: { page: 3, tag: "vegan" },
        },
        rawQuery: { page: "3", tag: "vegan" },
      },
    });
  });

  it("201 Created valida req.valid.body con z.strictObject y recorta cadenas", async () => {
    // Arrange
    const app = buildTestApp();

    // Act
    const res = await request(app)
      .post("/api/v1/test/strict-body")
      .send({ title: "  Sopa de calabaza  " });

    // Assert
    expect(res.status).toBe(201);
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.body).toEqual({
      success: true,
      statusCode: 201,
      message: "Receta validada",
      data: { title: "Sopa de calabaza" },
    });
  });

  it("responde preflight CORS, usa query parser simple y parsea urlencoded (extended=false)", async () => {
    // Arrange
    const app = buildTestApp();

    // Act
    const preflightRes = await request(app)
      .options("/api/v1/test/items/123")
      .set("Origin", "https://cliente.recetaria.local")
      .set("Access-Control-Request-Method", "POST");
    const simpleQueryRes = await request(app).get("/api/v1/test/query-simple?filter[status]=DRAFT");
    const formRes = await request(app)
      .post("/api/v1/test/urlencoded")
      .set("Content-Type", "application/x-www-form-urlencoded")
      .send("email=chef%40recetaria.com&filter%5Bstatus%5D=DRAFT");

    // Assert
    expect(preflightRes.status).toBe(204);
    expect(preflightRes.headers["access-control-allow-origin"]).toBe("*");
    expect(preflightRes.headers["access-control-allow-methods"]).toContain("POST");

    expect(simpleQueryRes.status).toBe(200);
    expect(simpleQueryRes.body).toEqual({
      success: true,
      statusCode: 200,
      message: "Query inspeccionada",
      data: { hasBracketKey: true, value: "DRAFT" },
    });

    expect(formRes.status).toBe(200);
    expect(formRes.body).toEqual({
      success: true,
      statusCode: 200,
      message: "Formulario recibido",
      data: {
        body: {
          email: "chef@recetaria.com",
          "filter[status]": "DRAFT",
        },
      },
    });
  });

  it("funciona buildApp() sin argumentos, soporta múltiples routers bajo /api/v1 y CORS personalizado", async () => {
    // Arrange
    const bareApp = buildApp({ onLog: vi.fn(), onError: vi.fn() });
    const defaultBareApp = buildApp();
    const authRouter = express.Router();
    authRouter.get("/ping", (_req, res) => sendSuccess(res, { message: "pong-auth", data: null }));
    const recipesRouter = express.Router();
    recipesRouter.get("/ping", (_req, res) =>
      sendSuccess(res, { message: "pong-recipes", data: null }),
    );
    const customApp = buildApp({
      apiRouters: [
        { path: "/auth", router: authRouter },
        { path: "/recipes", router: recipesRouter },
      ],
      cors: { origin: "https://app.recetaria.test" },
      onLog: vi.fn(),
      onError: vi.fn(),
    });

    // Act
    const bareRootRes = await request(bareApp).get("/");
    const bareApiRes = await request(defaultBareApp).get("/api/v1/cualquiera");
    const authRes = await request(customApp).get("/api/v1/auth/ping");
    const recipesRes = await request(customApp).get("/api/v1/recipes/ping");
    const unprefixedRes = await request(customApp).get("/recipes/ping");

    // Assert
    expect(bareRootRes.status).toBe(404);
    expect(bareApiRes.status).toBe(404);
    expect(authRes.status).toBe(200);
    expect(authRes.headers["access-control-allow-origin"]).toBe("https://app.recetaria.test");
    expect(recipesRes.status).toBe(200);
    expect(unprefixedRes.status).toBe(404);
    expect(() =>
      buildApp({ apiRouters: [{ path: "sin-barra", router: express.Router() }] }),
    ).toThrow(RangeError);
  });

  it("mantiene trust proxy deshabilitado por defecto y respeta trustProxy=1 cuando se configura", async () => {
    // Arrange
    const defaultApp = buildTestApp();
    const proxiedApp = buildTestApp({ trustProxy: 1 });

    // Act
    const defaultRes = await request(defaultApp)
      .get("/api/v1/test/proxy-ip")
      .set("X-Forwarded-For", "203.0.113.9");
    const proxiedRes = await request(proxiedApp)
      .get("/api/v1/test/proxy-ip")
      .set("X-Forwarded-For", "203.0.113.9");

    // Assert
    expect(defaultRes.status).toBe(200);
    expect(defaultRes.body.data.ip).not.toBe("203.0.113.9");
    expect(proxiedRes.status).toBe(200);
    expect(proxiedRes.body.data.ip).toBe("203.0.113.9");
  });

  it("400 Bad Request ante JSON malformado (entity.parse.failed) preservando CORS y logging", async () => {
    // Arrange
    const logs: string[] = [];
    const app = buildTestApp({ onLog: (line) => logs.push(line) });

    // Act
    const res = await request(app)
      .post("/api/v1/test/strict-body")
      .set("Content-Type", "application/json")
      .send('{"title": "sin cerrar"');

    // Assert
    expect(res.status).toBe(400);
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.body).toEqual({
      success: false,
      statusCode: 400,
      message: "JSON inválido en el cuerpo de la solicitud",
      errors: [],
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(" 400 ");
  });

  it("400 Bad Request ante campos extra BOPLA, cuerpo ausente, params/query inválidos y ZodError", async () => {
    // Arrange
    const app = buildTestApp();

    // Act
    const boplaRes = await request(app).post("/api/v1/test/strict-body").send({
      title: "Tarta de manzana",
      isActive: true,
      authorId: "usuario-atacante",
    });
    const emptyBodyRes = await request(app).post("/api/v1/test/strict-body");
    const paramsQueryRes = await request(app).get(
      "/api/v1/test/items/no-es-uuid?page=0&extra=hack",
    );
    const zodThrowRes = await request(app).get("/api/v1/test/zod-throw");

    // Assert
    expect(boplaRes.status).toBe(400);
    expect(boplaRes.body).toEqual({
      success: false,
      statusCode: 400,
      message: "Error de validación",
      errors: [
        { field: "isActive", message: "Campo no permitido" },
        { field: "authorId", message: "Campo no permitido" },
      ],
    });

    expect(emptyBodyRes.status).toBe(400);
    expect(emptyBodyRes.body).toEqual({
      success: false,
      statusCode: 400,
      message: "Error de validación",
      errors: [{ field: "title", message: "Título obligatorio" }],
    });

    expect(paramsQueryRes.status).toBe(400);
    expect(paramsQueryRes.body).toEqual({
      success: false,
      statusCode: 400,
      message: "Error de validación",
      errors: [
        { field: "id", message: "UUID inválido" },
        { field: "page", message: "La página debe ser >= 1" },
        { field: "extra", message: "Campo no permitido" },
      ],
    });

    expect(zodThrowRes.status).toBe(400);
    expect(zodThrowRes.body).toEqual({
      success: false,
      statusCode: 400,
      message: "Error de validación",
      errors: [
        { field: "code", message: "Código de texto requerido" },
        { field: "extra", message: "Campo no permitido" },
      ],
    });
  });

  it.each([
    { path: "/api/v1/test/auth-error", expectedStatus: 401, expectedMessage: "Token faltante o inválido" },
    {
      path: "/api/v1/test/forbidden-error",
      expectedStatus: 403,
      expectedMessage: "Solo CHEF o NUTRITIONIST pueden aprobar",
    },
    { path: "/api/v1/test/async-not-found", expectedStatus: 404, expectedMessage: "Receta no encontrada" },
    { path: "/api/v1/test/conflict-error", expectedStatus: 409, expectedMessage: "La receta ya está aprobada" },
    {
      path: "/api/v1/test/service-unavailable",
      expectedStatus: 503,
      expectedMessage: "PostgreSQL no responde",
    },
  ])(
    "mapea instancias síncronas y async de AppError a JSend ($expectedStatus $path)",
    async ({ path, expectedStatus, expectedMessage }) => {
      // Arrange
      const onError = vi.fn();
      const app = buildTestApp({ onError });

      // Act
      const res = await request(app).get(path);

      // Assert
      expect(onError).not.toHaveBeenCalled();
      expect(res.status).toBe(expectedStatus);
      expect(res.body).toEqual({
        success: false,
        statusCode: expectedStatus,
        message: expectedMessage,
        errors: [],
      });
    },
  );

  it("404 Not Found ante ruta inexistente con CORS, logging y sin X-Powered-By ni query strings", async () => {
    // Arrange
    const logs: string[] = [];
    const app = buildTestApp({ onLog: (line) => logs.push(line) });

    // Act
    const res = await request(app).get("/api/v1/no-existe?secret=LEAK_ME_NOT");

    // Assert
    expect(res.status).toBe(404);
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.body).toEqual({
      success: false,
      statusCode: 404,
      message: "Ruta no encontrada: GET /api/v1/no-existe",
      errors: [],
    });
    expect(res.text).not.toContain("LEAK_ME_NOT");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("secret=[REDACTED]");
  });

  it("409 Conflict (Prisma P2002) y 404 Not Found (Prisma P2025) sin exponer metadatos internos", async () => {
    // Arrange
    const app = buildTestApp();

    // Act
    const conflictRes = await request(app).post("/api/v1/test/prisma-p2002").send({});
    const notFoundRes = await request(app).get("/api/v1/test/prisma-p2025");

    // Assert
    expect(conflictRes.status).toBe(409);
    expect(conflictRes.body).toEqual({
      success: false,
      statusCode: 409,
      message: "Conflicto: el recurso ya existe",
      errors: [],
    });
    expect(conflictRes.text).not.toContain("users_email_key");

    expect(notFoundRes.status).toBe(404);
    expect(notFoundRes.body).toEqual({
      success: false,
      statusCode: 404,
      message: "Recurso no encontrado",
      errors: [],
    });
    expect(notFoundRes.text).not.toContain("Record to delete");
  });

  it("413 Payload Too Large cuando el cuerpo JSON o urlencoded supera el límite de 100kb", async () => {
    // Arrange
    const logs: string[] = [];
    const app = buildTestApp({ onLog: (line) => logs.push(line) });
    const oversizedJson = { title: "x".repeat(110 * 1024) };
    const oversizedForm = `data=${"a".repeat(110 * 1024)}`;

    // Act
    const jsonRes = await request(app).post("/api/v1/test/strict-body").send(oversizedJson);
    const formRes = await request(app)
      .post("/api/v1/test/urlencoded")
      .set("Content-Type", "application/x-www-form-urlencoded")
      .send(oversizedForm);

    // Assert
    for (const res of [jsonRes, formRes]) {
      expect(res.status).toBe(413);
      expect(res.headers["x-powered-by"]).toBeUndefined();
      expect(res.headers["access-control-allow-origin"]).toBe("*");
      expect(res.body).toEqual({
        success: false,
        statusCode: 413,
        message: "El cuerpo de la solicitud excede el tamaño máximo permitido",
        errors: [],
      });
    }
    expect(logs).toHaveLength(2);
    expect(logs.every((line) => line.includes(" 413 "))).toBe(true);
  });

  it("500 Internal Server Error redactado ante error inesperado sin fuga de stack trace ni SQL", async () => {
    // Arrange
    const onError = vi.fn();
    const logs: string[] = [];
    const app = buildTestApp({ onError, onLog: (line) => logs.push(line) });

    // Act
    const res = await request(app).get("/api/v1/test/boom");

    // Assert
    expect(res.status).toBe(500);
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.body).toEqual({
      success: false,
      statusCode: 500,
      message: "Error interno del servidor",
      errors: [],
    });
    expect(res.text).not.toContain("SECRET_BOOM");
    expect(res.text).not.toContain("SELECT *");
    expect(res.text).not.toContain("app.test.ts");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe("[UNHANDLED_ERROR]");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(" 500 ");
  });

  it("loggerMiddleware integrado registra petición sin filtrar headers sensibles ni contraseñas", async () => {
    // Arrange
    const logs: string[] = [];
    const app = buildTestApp({
      onLog: (line) => logs.push(line),
    });

    // Act
    const res = await request(app)
      .post("/api/v1/test/strict-body?token=SECRET_Q_TOKEN&page=1")
      .set("Authorization", "Bearer SECRET_BEARER_TOKEN")
      .set("Cookie", "sid=SECRET_COOKIE")
      .send({ title: "Tarta", password: "SECRET_BODY_PW" });

    // Assert
    expect(res.status).toBe(400);
    expect(logs).toHaveLength(1);
    const logged = logs[0] ?? "";
    expect(logged).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] POST \/api\/v1\/test\/strict-body\?token=\[REDACTED\]&page=1 400 \d+\.\dms$/,
    );
    expect(logged).not.toContain("SECRET_Q_TOKEN");
    expect(logged).not.toContain("SECRET_BEARER_TOKEN");
    expect(logged).not.toContain("SECRET_COOKIE");
    expect(logged).not.toContain("SECRET_BODY_PW");
  });
});
