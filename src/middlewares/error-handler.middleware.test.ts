import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
} from "../shared/errors/app-error.js";
import {
  createErrorHandlerMiddleware,
  errorHandlerMiddleware,
} from "./error-handler.middleware.js";

function createMockRequest(): Request {
  return {} as unknown as Request;
}

function createMockResponse(headersSent = false): {
  readonly res: Response;
  readonly statusMock: ReturnType<typeof vi.fn>;
  readonly jsonMock: ReturnType<typeof vi.fn>;
} {
  const statusMock = vi.fn();
  const jsonMock = vi.fn();
  const res = {
    headersSent,
    status: statusMock,
    json: jsonMock,
  } as unknown as Response;

  statusMock.mockReturnValue(res);
  jsonMock.mockReturnValue(res);

  return { res, statusMock, jsonMock };
}

describe("errorHandlerMiddleware", () => {
  it("mantiene aridad estricta de 4 parámetros requerida por Express 5", () => {
    // Arrange & Act
    const defaultLength = errorHandlerMiddleware.length;
    const factoryLength = createErrorHandlerMiddleware().length;

    // Assert
    expect(defaultLength).toBe(4);
    expect(factoryLength).toBe(4);
  });

  it("delega al handler interno de Express cuando res.headersSent es true", () => {
    // Arrange
    const logError = vi.fn();
    const handler = createErrorHandlerMiddleware(logError);
    const err = new Error("fallo tardío");
    const { res, statusMock, jsonMock } = createMockResponse(true);
    const next = vi.fn();

    // Act
    handler(err, createMockRequest(), res, next as unknown as NextFunction);

    // Assert
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(err);
    expect(statusMock).not.toHaveBeenCalled();
    expect(jsonMock).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it("mapea entity.parse.failed y request.aborted a 400 JSend", () => {
    // Arrange
    const handler = createErrorHandlerMiddleware(vi.fn());
    const parseRes = createMockResponse();
    const abortedRes = createMockResponse();

    // Act
    handler(
      { type: "entity.parse.failed" },
      createMockRequest(),
      parseRes.res,
      vi.fn() as unknown as NextFunction,
    );
    handler(
      { type: "request.aborted" },
      createMockRequest(),
      abortedRes.res,
      vi.fn() as unknown as NextFunction,
    );

    // Assert
    expect(parseRes.statusMock).toHaveBeenCalledWith(400);
    expect(parseRes.jsonMock).toHaveBeenCalledWith({
      success: false,
      statusCode: 400,
      message: "JSON inválido en el cuerpo de la solicitud",
      errors: [],
    });
    expect(abortedRes.statusMock).toHaveBeenCalledWith(400);
    expect(abortedRes.jsonMock).toHaveBeenCalledWith({
      success: false,
      statusCode: 400,
      message: "Solicitud interrumpida antes de completarse",
      errors: [],
    });
  });

  it("mapea entity.too.large y parameters.too.many a 413 JSend", () => {
    // Arrange
    const handler = createErrorHandlerMiddleware(vi.fn());
    const largeRes = createMockResponse();
    const paramsRes = createMockResponse();

    // Act
    handler(
      { type: "entity.too.large" },
      createMockRequest(),
      largeRes.res,
      vi.fn() as unknown as NextFunction,
    );
    handler(
      { type: "parameters.too.many" },
      createMockRequest(),
      paramsRes.res,
      vi.fn() as unknown as NextFunction,
    );

    // Assert
    expect(largeRes.statusMock).toHaveBeenCalledWith(413);
    expect(largeRes.jsonMock).toHaveBeenCalledWith({
      success: false,
      statusCode: 413,
      message: "El cuerpo de la solicitud excede el tamaño máximo permitido",
      errors: [],
    });
    expect(paramsRes.statusMock).toHaveBeenCalledWith(413);
    expect(paramsRes.jsonMock).toHaveBeenCalledWith({
      success: false,
      statusCode: 413,
      message: "El cuerpo de la solicitud excede el tamaño máximo permitido",
      errors: [],
    });
  });

  it("mapea ZodError directo (incluyendo BOPLA strictObject y path vacío → request) a 400 JSend", () => {
    // Arrange
    const handler = createErrorHandlerMiddleware(vi.fn());
    const strictRes = createMockResponse();
    const rootRes = createMockResponse();
    const strictSchema = z.strictObject({ title: z.string("Título requerido") });
    const strictParsed = strictSchema.safeParse({ title: 123, extra: "no" });
    const rootSchema = z.string().refine(() => false, { message: "Valor de raíz inválido" });
    const rootParsed = rootSchema.safeParse("abc");
    if (strictParsed.success || rootParsed.success) {
      throw new Error("Se esperaba ZodError");
    }

    // Act
    handler(strictParsed.error, createMockRequest(), strictRes.res, vi.fn() as unknown as NextFunction);
    handler(rootParsed.error, createMockRequest(), rootRes.res, vi.fn() as unknown as NextFunction);

    // Assert
    expect(strictRes.statusMock).toHaveBeenCalledWith(400);
    expect(strictRes.jsonMock).toHaveBeenCalledWith({
      success: false,
      statusCode: 400,
      message: "Error de validación",
      errors: [
        { field: "title", message: "Título requerido" },
        { field: "extra", message: "Campo no permitido" },
      ],
    });
    expect(rootRes.statusMock).toHaveBeenCalledWith(400);
    expect(rootRes.jsonMock).toHaveBeenCalledWith({
      success: false,
      statusCode: 400,
      message: "Error de validación",
      errors: [{ field: "request", message: "Valor de raíz inválido" }],
    });
  });

  it.each([
    {
      label: "400 BadRequestError con errores",
      error: new BadRequestError("Datos inválidos", {
        errors: [{ field: "email", message: "Formato inválido" }],
      }),
      expectedStatus: 400,
      expectedMessage: "Datos inválidos",
      expectedErrors: [{ field: "email", message: "Formato inválido" }],
    },
    {
      label: "401 UnauthorizedError",
      error: new UnauthorizedError(),
      expectedStatus: 401,
      expectedMessage: "No autorizado",
      expectedErrors: [],
    },
    {
      label: "403 ForbiddenError",
      error: new ForbiddenError(),
      expectedStatus: 403,
      expectedMessage: "Permisos insuficientes",
      expectedErrors: [],
    },
    {
      label: "404 NotFoundError",
      error: new NotFoundError("Receta no encontrada"),
      expectedStatus: 404,
      expectedMessage: "Receta no encontrada",
      expectedErrors: [],
    },
    {
      label: "409 ConflictError",
      error: new ConflictError("La receta ya fue aprobada"),
      expectedStatus: 409,
      expectedMessage: "La receta ya fue aprobada",
      expectedErrors: [],
    },
    {
      label: "503 ServiceUnavailableError",
      error: new ServiceUnavailableError("Base de datos no disponible"),
      expectedStatus: 503,
      expectedMessage: "Base de datos no disponible",
      expectedErrors: [],
    },
  ])(
    "traduce $label operacional sin registrarlo como error no controlado",
    ({ error, expectedStatus, expectedMessage, expectedErrors }) => {
      // Arrange
      const logError = vi.fn();
      const handler = createErrorHandlerMiddleware(logError);
      const { res, statusMock, jsonMock } = createMockResponse();

      // Act
      handler(error, createMockRequest(), res, vi.fn() as unknown as NextFunction);

      // Assert
      expect(logError).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(expectedStatus);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        statusCode: expectedStatus,
        message: expectedMessage,
        errors: expectedErrors,
      });
    },
  );

  it.each([
    {
      label: "isOperational=false",
      error: new AppError(503, "INTERNAL_SQL_SECRET_DETAILS", { isOperational: false }),
    },
    {
      label: "statusCode === 500 incluso con isOperational=true",
      error: new AppError(500, "INTERNAL_DB_LEAK_500"),
    },
  ])("redacta AppError interno ($label) devolviendo 500 genérico", ({ error }) => {
    // Arrange
    const logError = vi.fn();
    const handler = createErrorHandlerMiddleware(logError);
    const { res, statusMock, jsonMock } = createMockResponse();

    // Act
    handler(error, createMockRequest(), res, vi.fn() as unknown as NextFunction);

    // Assert
    expect(logError).toHaveBeenCalledWith("[NON_OPERATIONAL_ERROR]", error);
    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith({
      success: false,
      statusCode: 500,
      message: "Error interno del servidor",
      errors: [],
    });
  });

  it("mapea códigos conocidos de Prisma (P2002 → 409, P2025 → 404) sin logError ni metadatos", () => {
    // Arrange
    const logError = vi.fn();
    const handler = createErrorHandlerMiddleware(logError);
    const conflictRes = createMockResponse();
    const notFoundRes = createMockResponse();

    // Act
    handler(
      { code: "P2002", meta: { target: ["users_email_key"] } },
      createMockRequest(),
      conflictRes.res,
      vi.fn() as unknown as NextFunction,
    );
    handler(
      { code: "P2025", meta: { cause: "Record not found" } },
      createMockRequest(),
      notFoundRes.res,
      vi.fn() as unknown as NextFunction,
    );

    // Assert
    expect(logError).not.toHaveBeenCalled();
    expect(conflictRes.statusMock).toHaveBeenCalledWith(409);
    expect(conflictRes.jsonMock).toHaveBeenCalledWith({
      success: false,
      statusCode: 409,
      message: "Conflicto: el recurso ya existe",
      errors: [],
    });
    expect(notFoundRes.statusMock).toHaveBeenCalledWith(404);
    expect(notFoundRes.jsonMock).toHaveBeenCalledWith({
      success: false,
      statusCode: 404,
      message: "Recurso no encontrado",
      errors: [],
    });
  });

  it.each([
    new Error("SELECT * FROM users WHERE password_hash = 'SECRET_STACK_INFO'"),
    "error crudo no-Error con datos internos",
  ])("responde 500 genérico redactado ante fallos inesperados (%s)", (unexpectedError) => {
    // Arrange
    const logError = vi.fn();
    const handler = createErrorHandlerMiddleware(logError);
    const { res, statusMock, jsonMock } = createMockResponse();

    // Act
    handler(unexpectedError, createMockRequest(), res, vi.fn() as unknown as NextFunction);

    // Assert
    expect(logError).toHaveBeenCalledWith("[UNHANDLED_ERROR]", unexpectedError);
    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith({
      success: false,
      statusCode: 500,
      message: "Error interno del servidor",
      errors: [],
    });
  });
});
