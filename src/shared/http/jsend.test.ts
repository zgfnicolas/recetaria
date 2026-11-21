import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { BadRequestError, NotFoundError, type ErrorDetail } from "../errors/app-error.js";
import {
  buildErrorResponse,
  buildSuccessResponse,
  sendError,
  sendSuccess,
  type JSendResponse,
} from "./jsend.js";

type MockResponseHandles = Readonly<{
  res: Response;
  statusMock: ReturnType<typeof vi.fn>;
  jsonMock: ReturnType<typeof vi.fn>;
}>;

function createMockResponse(): MockResponseHandles {
  const jsonMock = vi.fn();
  const statusMock = vi.fn();
  const res = {
    status: statusMock,
    json: jsonMock,
  } as unknown as Response;

  statusMock.mockReturnValue(res);
  jsonMock.mockReturnValue(res);

  return { res, statusMock, jsonMock };
}

describe("Contrato JSend extendido (jsend.ts)", () => {
  it("construye sobre de éxito con statusCode 200 por defecto y estructura exacta congelada", () => {
    // Arrange
    const payload = { id: "receta-1", status: "DRAFT" };

    // Act
    const envelope = buildSuccessResponse({
      message: "Receta obtenida",
      data: payload,
    });

    // Assert
    expect(envelope).toEqual({
      success: true,
      statusCode: 200,
      message: "Receta obtenida",
      data: { id: "receta-1", status: "DRAFT" },
    });
    expect(Object.keys(envelope)).toEqual(["success", "statusCode", "message", "data"]);
    expect(Object.isFrozen(envelope)).toBe(true);
  });

  it("construye sobre de éxito con statusCode 201 y admite arreglos o null en data", () => {
    // Arrange & Act
    const created = buildSuccessResponse({
      statusCode: 201,
      message: "Receta creada",
      data: [{ id: "1" }],
    });
    const empty = buildSuccessResponse({
      message: "Receta eliminada",
      data: null,
    });

    // Assert
    expect(created).toEqual({
      success: true,
      statusCode: 201,
      message: "Receta creada",
      data: [{ id: "1" }],
    });
    expect(empty).toEqual({
      success: true,
      statusCode: 200,
      message: "Receta eliminada",
      data: null,
    });
  });

  it.each([400, 401, 403, 404, 409, 413, 500, 503] as const)(
    "construye sobre de error JSend uniforme con errors=[] por defecto (%i)",
    (statusCode) => {
      // Act
      const envelope = buildErrorResponse({
        statusCode,
        message: "Error controlado",
      });

      // Assert
      expect(envelope).toEqual({
        success: false,
        statusCode,
        message: "Error controlado",
        errors: [],
      });
      expect(Object.keys(envelope)).toEqual(["success", "statusCode", "message", "errors"]);
      expect("data" in envelope).toBe(false);
      expect(Object.isFrozen(envelope)).toBe(true);
      expect(Object.isFrozen(envelope.errors)).toBe(true);
    },
  );

  it("retorna sobre de error uniforme y congelado cuando se pasa errors=[] explícitamente", () => {
    // Arrange
    const explicitEmpty: ErrorDetail[] = [];

    // Act
    const envelope = buildErrorResponse({
      statusCode: 400,
      message: "Error",
      errors: explicitEmpty,
    });

    // Assert
    expect(envelope).toEqual({
      success: false,
      statusCode: 400,
      message: "Error",
      errors: [],
    });
    expect("data" in envelope).toBe(false);
    expect(Object.isFrozen(envelope.errors)).toBe(true);
  });

  it("clona y congela defensivamente la lista de errores por campo e interopera con AppError", () => {
    // Arrange
    const mutableErrors: ErrorDetail[] = [{ field: "email", message: "Email inválido" }];
    const badRequest = new BadRequestError("Error de validación", {
      errors: [{ field: "title", message: "El título es obligatorio" }],
    });
    const notFound = new NotFoundError("Receta no encontrada");

    // Act
    const clonedEnvelope = buildErrorResponse({
      statusCode: 400,
      message: "Error de validación",
      errors: mutableErrors,
    });
    mutableErrors.push({ field: "extra", message: "no debe aparecer" });

    const fromBadRequest = buildErrorResponse({
      statusCode: badRequest.statusCode,
      message: badRequest.message,
      errors: badRequest.errors,
    });
    const fromNotFound = buildErrorResponse({
      statusCode: notFound.statusCode,
      message: notFound.message,
      errors: notFound.errors,
    });

    // Assert
    expect(clonedEnvelope.errors).toEqual([{ field: "email", message: "Email inválido" }]);
    expect(Object.isFrozen(clonedEnvelope.errors)).toBe(true);
    const firstError = clonedEnvelope.errors[0];
    expect(firstError).toBeDefined();
    expect(Object.isFrozen(firstError)).toBe(true);

    expect(fromBadRequest).toEqual({
      success: false,
      statusCode: 400,
      message: "Error de validación",
      errors: [{ field: "title", message: "El título es obligatorio" }],
    });
    expect(fromNotFound).toEqual({
      success: false,
      statusCode: 404,
      message: "Receta no encontrada",
      errors: [],
    });
  });

  it("permite discriminar éxito y error mediante la unión JSendResponse", () => {
    // Arrange
    const responses: ReadonlyArray<JSendResponse<{ readonly count: number }>> = [
      buildSuccessResponse({ message: "OK", data: { count: 4 } }),
      buildErrorResponse({ statusCode: 409, message: "Conflicto" }),
    ];

    // Act
    const summary = responses.map((item) =>
      item.success ? `ok:${item.data.count}` : `err:${item.statusCode}:${item.errors.length}`,
    );

    // Assert
    expect(summary).toEqual(["ok:4", "err:409:0"]);
  });

  it("sendSuccess emite status 200 por defecto con el sobre exacto y retorna res", () => {
    // Arrange
    const { res, statusMock, jsonMock } = createMockResponse();

    // Act
    const returned = sendSuccess(res, {
      message: "OK",
      data: { ok: true },
    });

    // Assert
    expect(returned).toBe(res);
    expect(statusMock).toHaveBeenCalledTimes(1);
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledTimes(1);
    expect(jsonMock).toHaveBeenCalledWith({
      success: true,
      statusCode: 200,
      message: "OK",
      data: { ok: true },
    });
  });

  it("sendSuccess emite status 201 explícito con el sobre exacto y retorna res", () => {
    // Arrange
    const { res, statusMock, jsonMock } = createMockResponse();

    // Act
    const returned = sendSuccess(res, {
      statusCode: 201,
      message: "Usuario registrado",
      data: { id: "user-1" },
    });

    // Assert
    expect(returned).toBe(res);
    expect(statusMock).toHaveBeenCalledTimes(1);
    expect(statusMock).toHaveBeenCalledWith(201);
    expect(jsonMock).toHaveBeenCalledTimes(1);
    expect(jsonMock).toHaveBeenCalledWith({
      success: true,
      statusCode: 201,
      message: "Usuario registrado",
      data: { id: "user-1" },
    });
  });

  it("sendError emite sobre uniforme con errors=[] cuando no hay detalles por campo", () => {
    // Arrange
    const { res, statusMock, jsonMock } = createMockResponse();

    // Act
    const returned = sendError(res, {
      statusCode: 401,
      message: "Token inválido",
    });

    // Assert
    expect(returned).toBe(res);
    expect(statusMock).toHaveBeenCalledTimes(1);
    expect(statusMock).toHaveBeenCalledWith(401);
    expect(jsonMock).toHaveBeenCalledTimes(1);
    expect(jsonMock).toHaveBeenCalledWith({
      success: false,
      statusCode: 401,
      message: "Token inválido",
      errors: [],
    });
  });

  it("sendError emite la lista de errores por campo e impide mutaciones sobre ella", () => {
    // Arrange
    const { res, statusMock, jsonMock } = createMockResponse();
    const fieldErrors: ErrorDetail[] = [
      { field: "title", message: "Obligatorio" },
      { field: "prepTimeMinutes", message: "Debe ser >= 1" },
    ];

    // Act
    const returned = sendError(res, {
      statusCode: 400,
      message: "Error de validación",
      errors: fieldErrors,
    });

    // Assert
    expect(returned).toBe(res);
    expect(statusMock).toHaveBeenCalledTimes(1);
    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledTimes(1);
    expect(jsonMock).toHaveBeenCalledWith({
      success: false,
      statusCode: 400,
      message: "Error de validación",
      errors: [
        { field: "title", message: "Obligatorio" },
        { field: "prepTimeMinutes", message: "Debe ser >= 1" },
      ],
    });
    const emittedBody = jsonMock.mock.calls[0]?.[0];
    expect(Object.isFrozen(emittedBody)).toBe(true);
  });
});
