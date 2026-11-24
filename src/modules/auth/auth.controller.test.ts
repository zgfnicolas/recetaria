import express, { type Request } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  BadRequestError,
  ConflictError,
  UnauthorizedError,
} from "../../shared/errors/app-error.js";
import { AuthController } from "./auth.controller.js";
import type { LoginDTO, RegisterDTO } from "./auth.schema.js";
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
  app.post("/login", controller.login);

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
      email: "clara@recetaria.com",
      password: "password123",
      firstName: "Clara",
      lastName: "Registro",
    };
    // El rol lo decide AuthService (USER, #48); el controlador solo lo transmite tal cual
    const registerMock = vi.fn<IAuthService["register"]>().mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      email: "clara@recetaria.com",
      role: "USER",
    });
    const loginMock = vi.fn<IAuthService["login"]>();
    const { app, nextErrors } = createControllerTestHarness({
      authService: { register: registerMock, login: loginMock },
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
        email: "clara@recetaria.com",
        role: "USER",
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
      const loginMock = vi.fn<IAuthService["login"]>();
      const { app, nextErrors } = createControllerTestHarness({
        authService: { register: registerMock, login: loginMock },
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
    };
    const conflictError = new ConflictError("El correo electrónico ya está registrado");
    const unexpectedError = new Error("Unexpected failure");

    const conflictHarness = createControllerTestHarness({
      authService: {
        register: vi.fn<IAuthService["register"]>().mockRejectedValue(conflictError),
        login: vi.fn<IAuthService["login"]>(),
      },
      valid: { body: validBody },
    });
    const unexpectedHarness = createControllerTestHarness({
      authService: {
        register: vi.fn<IAuthService["register"]>().mockRejectedValue(unexpectedError),
        login: vi.fn<IAuthService["login"]>(),
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

describe("AuthController.login", () => {
  it("lee exclusivamente req.valid.body (ignorando req.body crudo), aplica Cache-Control no-store y responde 200 JSend", async () => {
    // Arrange
    const validBody: LoginDTO = {
      email: "chef@recetaria.com",
      password: "password123",
    };
    const session = {
      token: "header.payload.signature",
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        email: "chef@recetaria.com",
        role: "CHEF" as const,
      },
    };
    const loginMock = vi.fn<IAuthService["login"]>().mockResolvedValue(session);
    const { app, nextErrors } = createControllerTestHarness({
      authService: { register: vi.fn<IAuthService["register"]>(), login: loginMock },
      valid: { body: validBody },
    });

    // Act
    const res = await request(app).post("/login").send({
      email: "atacante@evil.com",
      role: "ADMIN",
      isActive: false,
    });

    // Assert
    expect(loginMock).toHaveBeenCalledTimes(1);
    expect(loginMock).toHaveBeenCalledWith(validBody);
    expect(nextErrors).toHaveLength(0);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({
      success: true,
      statusCode: 200,
      message: "Inicio de sesión exitoso",
      data: session,
    });
  });

  it.each([
    { label: "req.valid ausente", valid: undefined },
    { label: "req.valid sin propiedad body", valid: {} },
  ])(
    "falla cerrado con BadRequestError 400 cuando $label sin invocar AuthService.login",
    async ({ valid }) => {
      // Arrange
      const loginMock = vi.fn<IAuthService["login"]>();
      const { app, nextErrors } = createControllerTestHarness({
        authService: { register: vi.fn<IAuthService["register"]>(), login: loginMock },
        valid,
      });

      // Act
      const res = await request(app).post("/login").send({});

      // Assert
      expect(res.status).toBe(400);
      expect(loginMock).not.toHaveBeenCalled();
      expect(nextErrors).toHaveLength(1);
      expect(nextErrors[0]).toBeInstanceOf(BadRequestError);
      if (nextErrors[0] instanceof BadRequestError) {
        expect(nextErrors[0].statusCode).toBe(400);
        expect(nextErrors[0].message).toBe("Error de validación");
      }
    },
  );

  it("delega UnauthorizedError y errores inesperados de AuthService.login a next(err)", async () => {
    // Arrange
    const validBody: LoginDTO = {
      email: "user@recetaria.com",
      password: "wrong-password-test",
    };
    const unauthorizedError = new UnauthorizedError("Credenciales inválidas");
    const unexpectedError = new Error("Unexpected failure");

    const unauthorizedHarness = createControllerTestHarness({
      authService: {
        register: vi.fn<IAuthService["register"]>(),
        login: vi.fn<IAuthService["login"]>().mockRejectedValue(unauthorizedError),
      },
      valid: { body: validBody },
    });
    const unexpectedHarness = createControllerTestHarness({
      authService: {
        register: vi.fn<IAuthService["register"]>(),
        login: vi.fn<IAuthService["login"]>().mockRejectedValue(unexpectedError),
      },
      valid: { body: validBody },
    });

    // Act
    const unauthorizedRes = await request(unauthorizedHarness.app).post("/login").send({});
    const unexpectedRes = await request(unexpectedHarness.app).post("/login").send({});

    // Assert
    expect(unauthorizedRes.status).toBe(401);
    expect(unauthorizedHarness.nextErrors).toHaveLength(1);
    expect(unauthorizedHarness.nextErrors[0]).toBe(unauthorizedError);

    expect(unexpectedRes.status).toBe(500);
    expect(unexpectedHarness.nextErrors).toHaveLength(1);
    expect(unexpectedHarness.nextErrors[0]).toBe(unexpectedError);
  });
});
