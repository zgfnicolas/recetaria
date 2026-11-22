import express, { type Router } from "express";
import { validateMiddleware } from "../../middlewares/validate.middleware.js";
import type { AuthController } from "./auth.controller.js";
import { registerSchema } from "./auth.schema.js";

/**
 * Construye el router público de autenticación bajo `/api/v1/auth`.
 */
export function createAuthRouter(controller: AuthController): Router {
  const router = express.Router();

  router.post("/register", validateMiddleware({ body: registerSchema }), controller.register);

  return router;
}
