import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BadRequestError } from "../shared/errors/app-error.js";
import { formatZodIssues, validateMiddleware } from "./validate.middleware.js";

function createMockReq(overrides?: {
  readonly params?: Record<string, string>;
  readonly query?: Record<string, unknown>;
  readonly body?: unknown;
  readonly valid?: Request["valid"];
}): Request {
  const req = {
    params: overrides?.params ?? {},
    query: overrides?.query ?? {},
    body: overrides?.body,
    valid: overrides?.valid,
  } as unknown as Request;
  return req;
}

function createNoopRes(): Response {
  return {} as unknown as Response;
}

describe("formatZodIssues", () => {
  it("formatea rutas simples y anidadas manteniendo el camino separado por puntos", () => {
    // Arrange
    const schema = z.strictObject({
      title: z.string().min(3, "Mínimo 3 caracteres"),
      nutritionalInfo: z.strictObject({
        calories: z.number().int("Calorías enteras"),
      }),
    });

    const parsed = schema.safeParse({
      title: "ab",
      nutritionalInfo: { calories: 1.5 },
    });

    // Act
    const details = parsed.success ? [] : formatZodIssues(parsed.error.issues, "body");

    // Assert
    expect(details).toEqual([
      { field: "title", message: "Mínimo 3 caracteres" },
      { field: "nutritionalInfo.calories", message: "Calorías enteras" },
    ]);
  });

  it("usa fallbackField cuando el path de un issue de nivel raíz está vacío", () => {
    // Arrange
    const schema = z
      .strictObject({
        title: z.string().min(3),
      })
      .refine(() => false, { message: "Debe cumplir la regla global" });

    const parsed = schema.safeParse({ title: "Pollo" });

    // Act
    const details = parsed.success ? [] : formatZodIssues(parsed.error.issues, "body");

    // Assert
    expect(details).toEqual([{ field: "body", message: "Debe cumplir la regla global" }]);
  });

  it("expande cada clave de unrecognized_keys (z.strictObject / BOPLA) como Campo no permitido", () => {
    // Arrange
    const schema = z.strictObject({
      email: z.email(),
      nested: z
        .strictObject({
          name: z.string(),
        })
        .optional(),
    });

    const parsed = schema.safeParse({
      email: "user@recetaria.com",
      roleOverride: "ADMIN",
      isActive: false,
      nested: { name: "ok", secretFlag: true },
    });

    // Act
    const details = parsed.success ? [] : formatZodIssues(parsed.error.issues, "body");

    // Assert
    expect(details).toEqual([
      { field: "nested.secretFlag", message: "Campo no permitido" },
      { field: "roleOverride", message: "Campo no permitido" },
      { field: "isActive", message: "Campo no permitido" },
    ]);
  });
});

describe("validateMiddleware", () => {
  it("valida params, query y body y guarda los valores saneados/transformados en req.valid", () => {
    // Arrange
    const middleware = validateMiddleware({
      params: z.strictObject({ id: z.uuid() }),
      query: z.strictObject({ page: z.coerce.number().int().min(1) }),
      body: z.strictObject({ title: z.string().trim().min(3) }),
    });
    const validUuid = "550e8400-e29b-41d4-a716-446655440000";
    const req = createMockReq({
      params: { id: validUuid },
      query: { page: "2" },
      body: { title: "  Sopa crema  " },
    });
    const next = vi.fn();

    // Act
    middleware(req, createNoopRes(), next as unknown as NextFunction);

    // Assert
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(req.valid).toEqual({
      params: { id: validUuid },
      query: { page: 2 },
      body: { title: "Sopa crema" },
    });
  });

  it("compatibiliza con getter de solo lectura req.query de Express 5 sin intentar reasignarlo", () => {
    // Arrange
    const middleware = validateMiddleware({
      query: z.strictObject({ limit: z.coerce.number().int().max(100) }),
    });
    const req = {
      params: {},
      body: undefined,
    } as unknown as Request;
    Object.defineProperty(req, "query", {
      get: () => ({ limit: "25" }),
      enumerable: true,
      configurable: true,
    });
    const next = vi.fn();

    // Act
    middleware(req, createNoopRes(), next as unknown as NextFunction);

    // Assert
    expect(next).toHaveBeenCalledWith();
    expect(req.valid?.query).toEqual({ limit: 25 });
    expect(req.query).toEqual({ limit: "25" });
  });

  it("trata req.body === undefined como {} (Express 5 sin cuerpo)", () => {
    // Arrange
    const middleware = validateMiddleware({
      body: z.strictObject({ title: z.string({ error: "Título obligatorio" }) }),
    });
    const req = createMockReq({ body: undefined });
    const next = vi.fn();

    // Act
    middleware(req, createNoopRes(), next as unknown as NextFunction);

    // Assert
    expect(next).toHaveBeenCalledTimes(1);
    const passedError = next.mock.calls[0]?.[0];
    expect(passedError).toBeInstanceOf(BadRequestError);
    if (passedError instanceof BadRequestError) {
      expect(passedError.statusCode).toBe(400);
      expect(passedError.errors).toEqual([{ field: "title", message: "Título obligatorio" }]);
    }
  });

  it("encadena múltiples validaciones preservando secciones previas sin agregar claves undefined", () => {
    // Arrange
    const validateParams = validateMiddleware({
      params: z.strictObject({ id: z.string().min(1) }),
    });
    const validateBody = validateMiddleware({
      body: z.strictObject({ approved: z.boolean() }),
    });
    const req = createMockReq({
      params: { id: "abc" },
      body: { approved: true },
    });
    const next = vi.fn();

    // Act
    validateParams(req, createNoopRes(), next as unknown as NextFunction);
    validateBody(req, createNoopRes(), next as unknown as NextFunction);

    // Assert
    expect(req.valid).toEqual({
      params: { id: "abc" },
      body: { approved: true },
    });
    expect("query" in (req.valid ?? {})).toBe(false);
  });

  it("no inserta claves con valor undefined explícito cuando un esquema opcional resuelve undefined", () => {
    // Arrange
    const optionalQueryMiddleware = validateMiddleware({
      params: z.strictObject({ id: z.string().min(1) }),
      query: z.strictObject({}).transform(() => undefined),
    });
    const cleanReq = createMockReq({
      params: { id: "receta-1" },
      query: {},
    });
    const next = vi.fn();

    // Act
    optionalQueryMiddleware(cleanReq, createNoopRes(), next as unknown as NextFunction);

    // Assert
    expect(next).toHaveBeenCalledWith();
    expect(cleanReq.valid).toEqual({ params: { id: "receta-1" } });
    expect("query" in (cleanReq.valid ?? {})).toBe(false);
  });

  it("agrega fallos de params, query y body en un único BadRequestError sin escribir req.valid", () => {
    // Arrange
    const middleware = validateMiddleware({
      params: z.strictObject({ id: z.uuid("UUID inválido") }),
      query: z.strictObject({ page: z.coerce.number().int().min(1) }),
      body: z.strictObject({ title: z.string().min(3) }),
    });
    const req = createMockReq({
      params: { id: "no-uuid" },
      query: { page: "0" },
      body: { extraField: 1 },
    });
    const next = vi.fn();

    // Act
    middleware(req, createNoopRes(), next as unknown as NextFunction);

    // Assert
    expect(req.valid).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    const passedError = next.mock.calls[0]?.[0];
    expect(passedError).toBeInstanceOf(BadRequestError);
    if (passedError instanceof BadRequestError) {
      expect(passedError.message).toBe("Error de validación");
      expect(passedError.errors?.map((e) => e.field)).toEqual(["id", "page", "title", "extraField"]);
    }
  });
});
