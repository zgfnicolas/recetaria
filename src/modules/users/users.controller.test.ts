import express, { type Request } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Actor } from "../auth/index.js";
import { BadRequestError, ForbiddenError, UnauthorizedError } from "../../shared/errors/app-error.js";
import { UserAdminController } from "./users.controller.js";
import type { IUserAdminService } from "./users.service.js";

const ADMIN: Actor = Object.freeze({ id: "11111111-1111-4111-8111-111111111111", role: "ADMIN" });
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const VALID = { params: { id: TARGET_ID }, body: { role: "CHEF" } };

function createHarness(options: {
  readonly service: IUserAdminService;
  readonly user?: Actor | undefined;
  readonly valid?: Request["valid"] | undefined;
}): { readonly app: express.Express; readonly nextErrors: unknown[] } {
  const nextErrors: unknown[] = [];
  const controller = new UserAdminController(options.service);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (options.user !== undefined) req.user = options.user;
    if (options.valid !== undefined) req.valid = options.valid;
    next();
  });
  app.patch("/users/:id/role", controller.changeRole);
  app.patch("/users/:id/status", controller.changeStatus);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    nextErrors.push(err);
    const statusCode =
      typeof err === "object" && err !== null && "statusCode" in err && typeof err.statusCode === "number"
        ? err.statusCode
        : 500;
    res.status(statusCode).json({ delegated: true });
  });
  return { app, nextErrors };
}

function createMockService(): {
  readonly service: IUserAdminService;
  readonly changeRole: ReturnType<typeof vi.fn<IUserAdminService["changeRole"]>>;
  readonly changeStatus: ReturnType<typeof vi.fn<IUserAdminService["changeStatus"]>>;
} {
  const changeRole = vi
    .fn<IUserAdminService["changeRole"]>()
    .mockResolvedValue({ id: TARGET_ID, email: "destino@recetaria.com", role: "CHEF", isActive: true });
  const changeStatus = vi
    .fn<IUserAdminService["changeStatus"]>()
    .mockResolvedValue({ id: TARGET_ID, email: "destino@recetaria.com", role: "USER", isActive: false });
  return { service: { changeRole, changeStatus }, changeRole, changeStatus };
}

describe("UserAdminController.changeRole", () => {
  it("usa req.user y req.valid (ignorando el body crudo) y responde 200 JSend sin passwordHash", async () => {
    // Arrange
    const { service, changeRole } = createMockService();
    const { app, nextErrors } = createHarness({ service, user: ADMIN, valid: VALID });

    // Act
    const res = await request(app).patch("/users/no-es-el-id/role").send({ role: "ADMIN", isActive: false });

    // Assert
    expect(nextErrors).toEqual([]);
    expect(changeRole).toHaveBeenCalledWith(ADMIN, TARGET_ID, "CHEF");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      statusCode: 200,
      message: "Rol actualizado exitosamente",
      data: { id: TARGET_ID, email: "destino@recetaria.com", role: "CHEF", isActive: true },
    });
  });

  it("falla cerrado con 401 si falta req.user", async () => {
    // Arrange
    const { service, changeRole } = createMockService();
    const { app, nextErrors } = createHarness({ service, valid: VALID });

    // Act
    const res = await request(app).patch(`/users/${TARGET_ID}/role`);

    // Assert
    expect(res.status).toBe(401);
    expect(nextErrors[0]).toBeInstanceOf(UnauthorizedError);
    expect(changeRole).not.toHaveBeenCalled();
  });

  it.each([
    ["req.valid", undefined],
    ["req.valid.body", { params: { id: TARGET_ID } }],
    ["req.valid.params", { body: { role: "CHEF" } }],
  ])("falla cerrado con 400 si falta %s", async (_label, valid) => {
    // Arrange
    const { service, changeRole } = createMockService();
    const { app, nextErrors } = createHarness({ service, user: ADMIN, valid });

    // Act
    const res = await request(app).patch(`/users/${TARGET_ID}/role`);

    // Assert
    expect(res.status).toBe(400);
    expect(nextErrors[0]).toBeInstanceOf(BadRequestError);
    expect(changeRole).not.toHaveBeenCalled();
  });

  it.each([new ForbiddenError("prohibido"), new Error("inesperado")])(
    "delega en next(err) los errores del servicio: %s",
    async (failure) => {
      // Arrange
      const { service, changeRole } = createMockService();
      changeRole.mockRejectedValueOnce(failure);
      const { app, nextErrors } = createHarness({ service, user: ADMIN, valid: VALID });

      // Act
      await request(app).patch(`/users/${TARGET_ID}/role`);

      // Assert
      expect(nextErrors).toEqual([failure]);
    },
  );
});

describe("UserAdminController.changeStatus", () => {
  it.each([
    [false, "Cuenta desactivada exitosamente"],
    [true, "Cuenta activada exitosamente"],
  ])("con isActive = %s usa req.valid y responde 200 JSend con %s", async (isActive, message) => {
    // Arrange
    const { service, changeStatus } = createMockService();
    changeStatus.mockResolvedValueOnce({ id: TARGET_ID, email: "destino@recetaria.com", role: "USER", isActive });
    const { app, nextErrors } = createHarness({
      service,
      user: ADMIN,
      valid: { params: { id: TARGET_ID }, body: { isActive } },
    });

    // Act
    const res = await request(app).patch("/users/no-es-el-id/status").send({ isActive: !isActive, role: "ADMIN" });

    // Assert
    expect(nextErrors).toEqual([]);
    expect(changeStatus).toHaveBeenCalledWith(ADMIN, TARGET_ID, isActive);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      statusCode: 200,
      message,
      data: { id: TARGET_ID, email: "destino@recetaria.com", role: "USER", isActive },
    });
  });

  it("falla cerrado con 401 sin req.user y con 400 sin req.valid", async () => {
    // Arrange
    const { service, changeStatus } = createMockService();
    const noUser = createHarness({ service, valid: { params: { id: TARGET_ID }, body: { isActive: false } } });
    const noValid = createHarness({ service, user: ADMIN });

    // Act
    const unauthorized = await request(noUser.app).patch(`/users/${TARGET_ID}/status`);
    const invalid = await request(noValid.app).patch(`/users/${TARGET_ID}/status`);

    // Assert
    expect(unauthorized.status).toBe(401);
    expect(invalid.status).toBe(400);
    expect(changeStatus).not.toHaveBeenCalled();
  });
});
