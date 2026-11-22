import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { createLoggerMiddleware, sanitizeUrlForLog } from "./logger.middleware.js";

function createMockRequest(overrides?: {
  readonly method?: string;
  readonly originalUrl?: string;
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly body?: Record<string, unknown>;
}): Request {
  return {
    method: overrides?.method ?? "GET",
    originalUrl: overrides?.originalUrl ?? "/api/v1/recipes",
    url: overrides?.url ?? "/api/v1/recipes",
    headers: overrides?.headers ?? {},
    body: overrides?.body,
  } as unknown as Request;
}

function createEmitterResponse(statusCode = 200): {
  readonly emitter: EventEmitter;
  readonly res: Response;
} {
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, { statusCode }) as unknown as Response;
  return { emitter, res };
}

describe("sanitizeUrlForLog", () => {
  it("preserva rutas limpias, trailing '?' vacío y parámetros de consulta benignos", () => {
    // Arrange
    const cleanUrl = "/api/v1/recipes?status=APPROVED&difficulty=EASY&page=1";
    const trailingQuestionMark = "/api/v1/recipes?";

    // Act & Assert
    expect(sanitizeUrlForLog(cleanUrl)).toBe(cleanUrl);
    expect(sanitizeUrlForLog(trailingQuestionMark)).toBe(trailingQuestionMark);
  });

  it("elimina caracteres de control C0, C1, CRLF y separadores de línea Unicode", () => {
    // Arrange
    const rawUrl = "/api/v1/recipes\r\nFAKE_LOG_ENTRY\t\x00\x1f\u0085\u009b\u2028\u2029?page=1";

    // Act
    const sanitized = sanitizeUrlForLog(rawUrl);

    // Assert
    expect(sanitized).toBe("/api/v1/recipesFAKE_LOG_ENTRY?page=1");
  });

  it("redacta parámetros sensibles en query string sin alterar los demás", () => {
    // Arrange
    const rawUrl =
      "/api/v1/auth/verify?token=SECRET_1&Password=SECRET_2&api%5Fkey=SECRET_3&secret=SECRET_4&authorization=SECRET_5&status=DRAFT";

    // Act
    const sanitized = sanitizeUrlForLog(rawUrl);

    // Assert
    expect(sanitized).toBe(
      "/api/v1/auth/verify?token=[REDACTED]&Password=[REDACTED]&api%5Fkey=[REDACTED]&secret=[REDACTED]&authorization=[REDACTED]&status=DRAFT",
    );
  });

  it("tolera escapes percent-encoding malformados sin lanzar errores", () => {
    // Arrange
    const rawUrl = "/api/v1/recipes?token=abc&%ZZ=val";

    // Act
    const sanitized = sanitizeUrlForLog(rawUrl);

    // Assert
    expect(sanitized).toBe("/api/v1/recipes?token=[REDACTED]&%ZZ=val");
  });
});

describe("createLoggerMiddleware", () => {
  it("invoca next() de inmediato y registra el formato exacto solo al evento finish", () => {
    // Arrange
    const writeLine = vi.fn();
    const middleware = createLoggerMiddleware(writeLine);
    const req = createMockRequest({
      method: "POST",
      originalUrl: "/api/v1/recipes?status=DRAFT",
    });
    const { emitter, res } = createEmitterResponse(201);
    const next = vi.fn();

    // Act (llamada síncrona al middleware)
    middleware(req, res, next);

    // Assert (antes de finish no debe escribir log)
    expect(next).toHaveBeenCalledTimes(1);
    expect(writeLine).not.toHaveBeenCalled();

    // Act (emite finish)
    emitter.emit("finish");

    // Assert (formato exacto [ISO_DATE] METHOD /url STATUS DURATIONms)
    expect(writeLine).toHaveBeenCalledTimes(1);
    const line = writeLine.mock.calls[0]?.[0];
    expect(typeof line).toBe("string");
    expect(line).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] POST \/api\/v1\/recipes\?status=DRAFT 201 \d+\.\dms$/,
    );
  });

  it("usa req.url como fallback cuando req.originalUrl está vacío", () => {
    // Arrange
    const writeLine = vi.fn();
    const middleware = createLoggerMiddleware(writeLine);
    const req = createMockRequest({
      method: "GET",
      originalUrl: "",
      url: "/fallback-url?page=2",
    });
    const { emitter, res } = createEmitterResponse(200);

    // Act
    middleware(req, res, vi.fn());
    emitter.emit("finish");

    // Assert
    const line = String(writeLine.mock.calls[0]?.[0] ?? "");
    expect(line).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] GET \/fallback-url\?page=2 200 \d+\.\dms$/,
    );
  });

  it("nunca incluye Authorization, cookies, body con contraseñas ni tokens en query", () => {
    // Arrange
    const writeLine = vi.fn();
    const middleware = createLoggerMiddleware(writeLine);
    const req = createMockRequest({
      method: "POST",
      originalUrl: "/api/v1/auth/login?token=QUERY_SECRET_XYZ",
      headers: {
        authorization: "Bearer HEADER_JWT_SECRET",
        cookie: "session=COOKIE_SECRET_VALUE",
      },
      body: {
        email: "chef@recetaria.com",
        password: "BODY_PASSWORD_SECRET",
      },
    });
    const { emitter, res } = createEmitterResponse(401);
    const next = vi.fn();

    // Act
    middleware(req, res, next);
    emitter.emit("finish");

    // Assert
    const line = String(writeLine.mock.calls[0]?.[0] ?? "");
    expect(line).toContain("token=[REDACTED]");
    expect(line).not.toContain("QUERY_SECRET_XYZ");
    expect(line).not.toContain("HEADER_JWT_SECRET");
    expect(line).not.toContain("COOKIE_SECRET_VALUE");
    expect(line).not.toContain("BODY_PASSWORD_SECRET");
  });
});
