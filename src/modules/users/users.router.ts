import express, { type RequestHandler, type Router } from "express";
import { rbacMiddleware } from "../../middlewares/rbac.middleware.js";
import { validateMiddleware } from "../../middlewares/validate.middleware.js";
import type { UserAdminController } from "./users.controller.js";
import { changeRoleSchema, changeStatusSchema, userIdParamsSchema } from "./users.schema.js";

/**
 * Router de administración de Usuarios bajo `/api/v1/users` (#53):
 * `authGuard → rbacMiddleware(["ADMIN"]) → validateMiddleware → controller` (`ADR-0006`).
 */
export function createUserAdminRouter(controller: UserAdminController, authGuard: RequestHandler): Router {
  const router = express.Router();
  router.patch(
    "/:id/role",
    authGuard,
    rbacMiddleware(["ADMIN"]),
    validateMiddleware({ params: userIdParamsSchema, body: changeRoleSchema }),
    controller.changeRole,
  );
  router.patch(
    "/:id/status",
    authGuard,
    rbacMiddleware(["ADMIN"]),
    validateMiddleware({ params: userIdParamsSchema, body: changeStatusSchema }),
    controller.changeStatus,
  );
  return router;
}
