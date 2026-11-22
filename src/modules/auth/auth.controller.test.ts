import express, { type Request } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { BadRequestError, ConflictError } from "../../shared/errors/app-error.js";
import { AuthController } from "./auth.controller.js";
import type { RegisterDTO } from "./auth.schema.js";
import type { IAuthService } from "./auth.service.js";

function createControllerTestHarness(options: {
  readonly authService: IAuthService;
  readonly valid?: Request["valid"] | undefined;
}): {
  readonly app: express.Express;
  readonly nextErrors: unknown[];
} {
  const nextErrors: unknown[] = [];
  const controller = new AuthController(options.authService);
  const app = express();

  app.use(express.json());

  app.use((req, _res, next) => {
    if (options.valid !== undefined) {
      req.valid = options.valid;
    }
    next();
  });

  app.post("/register", controller.register);

  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      nextErrors.push(err);
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

  return { app, nextErrors };
}

describe("AuthController.register", () => {
  it("lee exclusivamente req.valid.body (ignorando req.body crudo), delega en AuthService y responde 201 JSend", async () => {
    // Arrange
    const validBody: RegisterDTO = {
      email: "chef@recetaria.com",
      password: "password123",
      firstName: "Clara",
      lastName: "Chef",
      role: "CHEF",
    };
    const registerMock = vi.fn<IAuthService["register"]>().mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      email: "chef@recetaria.com",
      role: "CHEF",
    });
    const { app, nextErrors } = createControllerTestHarness({
      authService: { register: registerMock },
      valid: { body: validBody },
    });

    // Act
    const res = await request(app).post("/register").send({
      email: "atacante@evil.com",
      role: "ADMIN",
      isActive: false,
    });

    // Assert
    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(registerMock).toHaveBeenCalledWith(validBody);
    expect(nextErrors).toHaveLength(0);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      success: true,
      statusCode: 201,
      message: "Usuario registrado exitosamente",
      data: {
        id: "11111111-1111-4111-8111-111111111111",
        email: "chef@recetaria.com",
        role: "CHEF",
      },
    });
  });

  it.each([
    { label: "req.valid ausente", valid: undefined },
    { label: "req.valid sin propiedad body", valid: {} },
  ])(
    "falla cerrado con BadRequestError 400 cuando $label sin invocar AuthService",
    async ({ valid }) => {
      // Arrange
      const registerMock = vi.fn<IAuthService["register"]>();
      const { app, nextErrors } = createControllerTestHarness({
        authService: { register: registerMock },
        valid,
      });

      // Act
      const res = await request(app).post("/register").send({});

      // Assert
      expect(res.status).toBe(400);
      expect(registerMock).not.toHaveBeenCalled();
      expect(nextErrors).toHaveLength(1);
      expect(nextErrors[0]).toBeInstanceOf(BadRequestError);
      if (nextErrors[0] instanceof BadRequestError) {
        expect(nextErrors[0].statusCode).toBe(400);
        expect(nextErrors[0].message).toBe("Error de validación");
      }
    },
  );

  it("delega errores esperados (ConflictError) e inesperados de AuthService directamente a next(err)", async () => {
    // Arrange
    const validBody: RegisterDTO = {
      email: "dup@recetaria.com",
      password: "password123",
      firstName: "Duplicado",
      lastName: "Test",
      role: "USER",
    };
    const conflictError = new ConflictError("El correo electrónico ya está registrado");
    const unexpectedError = new Error("Unexpected failure");

    const conflictHarness = createControllerTestHarness({
      authService: { register: vi.fn<IAuthService["register"]>().mockRejectedValue(conflictError) },
      valid: { body: validBody },
    });
    const unexpectedHarness = createControllerTestHarness({
      authService: {
        register: vi.fn<IAuthService["register"]>().mockRejectedValue(unexpectedError),
      },
      valid: { body: validBody },
    });

    // Act
    const conflictRes = await request(conflictHarness.app).post("/register").send({});
    const unexpectedRes = await request(unexpectedHarness.app).post("/register").send({});

    // Assert
    expect(conflictRes.status).toBe(409);
    expect(conflictHarness.nextErrors).toHaveLength(1);
    expect(conflictHarness.nextErrors[0]).toBe(conflictError);

    expect(unexpectedRes.status).toBe(500);
    expect(unexpectedHarness.nextErrors).toHaveLength(1);
    expect(unexpectedHarness.nextErrors[0]).toBe(unexpectedError);
  });
});
