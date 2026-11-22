import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Actor, UserRole } from "../modules/auth/index.js";
import { ForbiddenError, UnauthorizedError } from "../shared/errors/app-error.js";
import { rbacMiddleware } from "./rbac.middleware.js";

const VALID_UUID = "44444444-4444-4444-8444-444444444444";

function createRbacTestHarness(options: {
  readonly guard: express.RequestHandler;
  readonly actor?: Actor | undefined;
}): {
  readonly app: express.Express;
  readonly routeReached: ReturnType<typeof vi.fn>;
  readonly nextErrors: unknown[];
} {
  const nextErrors: unknown[] = [];
  const routeReached = vi.fn();
  const app = express();

  app.use((req, _res, next) => {
    if (options.actor !== undefined) {
      req.user = options.actor;
    }
    next();
  });

  app.post("/resource", options.guard, (req, res) => {
    routeReached(req.user);
    res.status(200).json({ allowed: true });
  });

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

  return { app, routeReached, nextErrors };
}

describe("rbacMiddleware", () => {
  it("falla fast-fail en construcción con RangeError si allowedRoles está vacío", () => {
    // Arrange
    const emptyRoles: readonly UserRole[] = [];

    // Act & Assert
    expect(() => rbacMiddleware(emptyRoles)).toThrow(RangeError);
  });

  it("falla fast-fail en construcción con RangeError si recibe un rol fuera de USER_ROLES", () => {
    // Arrange
    const invalidRuntimeArgs: readonly unknown[] = [["SUPERADMIN"]];

    // Act & Assert
    expect(() => Reflect.apply(rbacMiddleware, undefined, invalidRuntimeArgs)).toThrow(RangeError);
  });

  it("congela una copia defensiva de allowedRoles inmune a mutaciones posteriores del array", async () => {
    // Arrange
    const mutableRoles: UserRole[] = ["ADMIN"];
    const guard = rbacMiddleware(mutableRoles);
    mutableRoles.push("USER");
    const harness = createRbacTestHarness({
      guard,
      actor: { id: VALID_UUID, role: "USER" },
    });

    // Act
    const res = await request(harness.app).post("/resource");

    // Assert
    expect(res.status).toBe(403);
    expect(harness.routeReached).not.toHaveBeenCalled();
    expect(harness.nextErrors).toHaveLength(1);
    expect(harness.nextErrors[0]).toBeInstanceOf(ForbiddenError);
  });

  it("delega UnauthorizedError 401 sin alcanzar la ruta cuando req.user no está presente", async () => {
    // Arrange
    const guard = rbacMiddleware(["USER", "CHEF", "NUTRITIONIST", "ADMIN"]);
    const harness = createRbacTestHarness({ guard, actor: undefined });

    // Act
    const res = await request(harness.app).post("/resource");

    // Assert
    expect(res.status).toBe(401);
    expect(harness.routeReached).not.toHaveBeenCalled();
    expect(harness.nextErrors).toHaveLength(1);
    const passedError = harness.nextErrors[0];
    expect(passedError).toBeInstanceOf(UnauthorizedError);
    if (passedError instanceof UnauthorizedError) {
      expect(passedError.statusCode).toBe(401);
      expect(passedError.message).toBe("Autenticación requerida");
      expect(passedError.errors).toBeUndefined();
    }
  });

  describe("matriz de aprobación RN-04 (['CHEF', 'NUTRITIONIST'])", () => {
    const approveGuard = rbacMiddleware(["CHEF", "NUTRITIONIST"]);

    it.each(["CHEF", "NUTRITIONIST"] as const)(
      "permite el paso (200) para rol autorizado %s",
      async (role) => {
        // Arrange
        const harness = createRbacTestHarness({
          guard: approveGuard,
          actor: { id: VALID_UUID, role },
        });

        // Act
        const res = await request(harness.app).post("/resource");

        // Assert
        expect(res.status).toBe(200);
        expect(harness.nextErrors).toHaveLength(0);
        expect(harness.routeReached).toHaveBeenCalledWith({ id: VALID_UUID, role });
      },
    );

    it.each(["USER", "ADMIN"] as const)(
      "rechaza con ForbiddenError 403 sin filtrar roles permitidos ante rol %s (BFLA)",
      async (role) => {
        // Arrange
        const harness = createRbacTestHarness({
          guard: approveGuard,
          actor: { id: VALID_UUID, role },
        });

        // Act
        const res = await request(harness.app).post("/resource");

        // Assert
        expect(res.status).toBe(403);
        expect(harness.routeReached).not.toHaveBeenCalled();
        expect(harness.nextErrors).toHaveLength(1);
        const passedError = harness.nextErrors[0];
        expect(passedError).toBeInstanceOf(ForbiddenError);
        if (passedError instanceof ForbiddenError) {
          expect(passedError.statusCode).toBe(403);
          expect(passedError.message).toBe("No tienes permisos para realizar esta acción");
          expect(passedError.message).not.toContain("CHEF");
          expect(passedError.message).not.toContain("NUTRITIONIST");
          expect(passedError.errors).toBeUndefined();
        }
      },
    );
  });

  describe("ruta exclusiva de administración (['ADMIN'])", () => {
    const adminGuard = rbacMiddleware(["ADMIN"]);

    it("permite acceso a ADMIN (200)", async () => {
      // Arrange
      const harness = createRbacTestHarness({
        guard: adminGuard,
        actor: { id: VALID_UUID, role: "ADMIN" },
      });

      // Act
      const res = await request(harness.app).post("/resource");

      // Assert
      expect(res.status).toBe(200);
      expect(harness.nextErrors).toHaveLength(0);
      expect(harness.routeReached).toHaveBeenCalledTimes(1);
    });

    it.each(["USER", "CHEF", "NUTRITIONIST"] as const)(
      "rechaza con ForbiddenError 403 ante rol %s",
      async (role) => {
        // Arrange
        const harness = createRbacTestHarness({
          guard: adminGuard,
          actor: { id: VALID_UUID, role },
        });

        // Act
        const res = await request(harness.app).post("/resource");

        // Assert
        expect(res.status).toBe(403);
        expect(harness.routeReached).not.toHaveBeenCalled();
        expect(harness.nextErrors).toHaveLength(1);
        const passedError = harness.nextErrors[0];
        expect(passedError).toBeInstanceOf(ForbiddenError);
        if (passedError instanceof ForbiddenError) {
          expect(passedError.statusCode).toBe(403);
          expect(passedError.errors).toBeUndefined();
        }
      },
    );
  });
});
