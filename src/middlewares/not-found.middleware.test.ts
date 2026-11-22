import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { NotFoundError } from "../shared/errors/app-error.js";
import { notFoundMiddleware } from "./not-found.middleware.js";

describe("notFoundMiddleware", () => {
  it("delega NotFoundError 404 con método y path sin reflejar query strings ni tocar res", () => {
    // Arrange
    const req = {
      method: "POST",
      path: "/api/v1/recipes/123",
      originalUrl: "/api/v1/recipes/123?token=secreto_sensible",
    } as unknown as Request;
    const statusMock = vi.fn();
    const jsonMock = vi.fn();
    const res = {
      status: statusMock,
      json: jsonMock,
    } as unknown as Response;
    const next = vi.fn();

    // Act
    notFoundMiddleware(req, res, next as unknown as NextFunction);

    // Assert
    expect(statusMock).not.toHaveBeenCalled();
    expect(jsonMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);

    const passedError = next.mock.calls[0]?.[0];
    expect(passedError).toBeInstanceOf(NotFoundError);
    if (passedError instanceof NotFoundError) {
      expect(passedError.statusCode).toBe(404);
      expect(passedError.message).toBe("Ruta no encontrada: POST /api/v1/recipes/123");
      expect(passedError.message).not.toContain("token");
      expect(passedError.message).not.toContain("secreto_sensible");
    }
  });
});
