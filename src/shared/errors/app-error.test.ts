import { describe, expect, it } from "vitest";
import {
  AppError,
  BadRequestError,
  ConflictError,
  PreconditionFailedError,
  PreconditionRequiredError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
  freezeErrorDetails,
  type ErrorDetail,
} from "./app-error.js";

describe("freezeErrorDetails", () => {
  it("congela un arreglo vacío de detalles de error", () => {
    // Arrange
    const empty: ErrorDetail[] = [];

    // Act
    const frozen = freezeErrorDetails(empty);

    // Assert
    expect(frozen).toEqual([]);
    expect(Object.isFrozen(frozen)).toBe(true);
  });

  it("clona y congela profundamente múltiples detalles sin reflejar mutaciones posteriores", () => {
    // Arrange
    const mutable: ErrorDetail[] = [
      { field: "title", message: "El título es obligatorio" },
      { field: "prepTimeMinutes", message: "Debe ser mayor a 0" },
    ];

    // Act
    const frozen = freezeErrorDetails(mutable);
    mutable.push({ field: "extra", message: "no debe aparecer" });

    // Assert
    expect(frozen).toEqual([
      { field: "title", message: "El título es obligatorio" },
      { field: "prepTimeMinutes", message: "Debe ser mayor a 0" },
    ]);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen[0])).toBe(true);
    expect(Object.isFrozen(frozen[1])).toBe(true);
  });
});

describe("AppError (jerarquía tipada de errores operacionales)", () => {
  it("inicializa statusCode, message, name, isOperational=true y omite errors y cause por defecto", () => {
    // Arrange & Act
    const error = new AppError(400, "Parámetro inválido");

    // Assert
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppError);
    expect(error.name).toBe("AppError");
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe("Parámetro inválido");
    expect(error.isOperational).toBe(true);
    expect("errors" in error).toBe(false);
    expect("cause" in error).toBe(false);
    expect(error.errors).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });

  it("conserva arreglo errors vacío congelado cuando se pasa explícitamente", () => {
    // Arrange & Act
    const error = new AppError(400, "Parámetro inválido", { errors: [] });

    // Assert
    expect("errors" in error).toBe(true);
    expect(error.errors).toEqual([]);
    expect(Object.isFrozen(error.errors)).toBe(true);
  });

  it("preserva cause, respeta isOperational=false y clona/congela defensivamente errors", () => {
    // Arrange
    const rootCause = new Error("connection timeout");
    const mutableDetails: ErrorDetail[] = [{ field: "email", message: "Formato inválido" }];

    // Act
    const error = new AppError(503, "Base de datos sin respuesta", {
      errors: mutableDetails,
      isOperational: false,
      cause: rootCause,
    });
    mutableDetails.push({ field: "extra", message: "mutado" });

    // Assert
    expect(error.isOperational).toBe(false);
    expect(error.cause).toBe(rootCause);
    expect(error.errors).toEqual([{ field: "email", message: "Formato inválido" }]);
    expect(Object.isFrozen(error.errors)).toBe(true);

    const firstDetail = error.errors?.[0];
    expect(firstDetail).toBeDefined();
    expect(Object.isFrozen(firstDetail)).toBe(true);
  });

  it("permite indicar isOperational=false y cause en una subclase semántica", () => {
    // Arrange
    const dbError = new Error("ECONNREFUSED");

    // Act
    const error = new ServiceUnavailableError("PostgreSQL inaccesible", {
      isOperational: false,
      cause: dbError,
    });

    // Assert
    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(error.statusCode).toBe(503);
    expect(error.isOperational).toBe(false);
    expect(error.cause).toBe(dbError);
  });

  it.each([200, 399, 600, 400.5])(
    "rechaza con RangeError códigos HTTP fuera de [400..599] (%s)",
    (invalidStatus) => {
      // Act & Assert
      expect(() => {
        Reflect.construct(AppError, [invalidStatus, "Estado inválido"]);
      }).toThrow(RangeError);
    },
  );

  it.each([
    {
      SubClass: BadRequestError,
      expectedName: "BadRequestError",
      expectedStatus: 400,
      expectedDefaultMessage: "Solicitud inválida",
    },
    {
      SubClass: UnauthorizedError,
      expectedName: "UnauthorizedError",
      expectedStatus: 401,
      expectedDefaultMessage: "No autorizado",
    },
    {
      SubClass: ForbiddenError,
      expectedName: "ForbiddenError",
      expectedStatus: 403,
      expectedDefaultMessage: "Permisos insuficientes",
    },
    {
      SubClass: NotFoundError,
      expectedName: "NotFoundError",
      expectedStatus: 404,
      expectedDefaultMessage: "Recurso no encontrado",
    },
    {
      SubClass: ConflictError,
      expectedName: "ConflictError",
      expectedStatus: 409,
      expectedDefaultMessage: "Conflicto con el estado actual del recurso",
    },
    {
      SubClass: PreconditionFailedError,
      expectedName: "PreconditionFailedError",
      expectedStatus: 412,
      expectedDefaultMessage: "La versión del recurso cambió",
    },
    {
      SubClass: PreconditionRequiredError,
      expectedName: "PreconditionRequiredError",
      expectedStatus: 428,
      expectedDefaultMessage: "Se requiere una solicitud condicional",
    },
    {
      SubClass: ServiceUnavailableError,
      expectedName: "ServiceUnavailableError",
      expectedStatus: 503,
      expectedDefaultMessage: "Servicio no disponible",
    },
  ] as const)(
    "configura herencia, estado HTTP y mensaje por defecto en $expectedName ($expectedStatus)",
    ({ SubClass, expectedName, expectedStatus, expectedDefaultMessage }) => {
      // Arrange & Act
      const defaultError = new SubClass();

      // Assert
      expect(defaultError).toBeInstanceOf(Error);
      expect(defaultError).toBeInstanceOf(AppError);
      expect(defaultError).toBeInstanceOf(SubClass);
      expect(defaultError.name).toBe(expectedName);
      expect(defaultError.statusCode).toBe(expectedStatus);
      expect(defaultError.message).toBe(expectedDefaultMessage);
      expect(defaultError.isOperational).toBe(true);
      expect("errors" in defaultError).toBe(false);
    },
  );

  it.each([
    { SubClass: BadRequestError, expectedName: "BadRequestError", expectedStatus: 400 },
    { SubClass: UnauthorizedError, expectedName: "UnauthorizedError", expectedStatus: 401 },
    { SubClass: ForbiddenError, expectedName: "ForbiddenError", expectedStatus: 403 },
    { SubClass: NotFoundError, expectedName: "NotFoundError", expectedStatus: 404 },
    { SubClass: ConflictError, expectedName: "ConflictError", expectedStatus: 409 },
    {
      SubClass: ServiceUnavailableError,
      expectedName: "ServiceUnavailableError",
      expectedStatus: 503,
    },
  ] as const)(
    "acepta mensaje personalizado, errores por campo y cause en $expectedName ($expectedStatus)",
    ({ SubClass, expectedName, expectedStatus }) => {
      // Arrange
      const cause = new Error("causa interna");

      // Act
      const customError = new SubClass("Mensaje específico", {
        errors: [{ field: "id", message: "inválido" }],
        cause,
      });

      // Assert
      expect(customError.name).toBe(expectedName);
      expect(customError.statusCode).toBe(expectedStatus);
      expect(customError.message).toBe("Mensaje específico");
      expect(customError.errors).toEqual([{ field: "id", message: "inválido" }]);
      expect(customError.cause).toBe(cause);
    },
  );
});
