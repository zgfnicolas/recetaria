import express, { type RequestHandler, type Router } from "express";
import { validateMiddleware } from "../../middlewares/validate.middleware.js";
import type { AuthController } from "./auth.controller.js";
import { loginSchema, registerSchema } from "./auth.schema.js";

export type AuthRouterOptions = Readonly<{
  /** Limitadores de `POST /login` (#39: por IP y por cuenta), aplicados en orden antes de validar. */
  loginLimiters?: readonly RequestHandler[] | undefined;
  /** Limitador de `POST /register` (#39: por IP), aplicado antes de validar. */
  registerLimiter?: RequestHandler | undefined;
}>;

/**
 * Construye el router público de autenticación bajo `/api/v1/auth`.
 * Orden: `[rateLimit →] validateMiddleware → controller` (el límite corta antes de Zod y de Bcrypt).
 */
export function createAuthRouter(controller: AuthController, options?: AuthRouterOptions): Router {
  const router = express.Router();
  const loginGuards = options?.loginLimiters ?? [];
  const registerGuards = options?.registerLimiter === undefined ? [] : [options.registerLimiter];

  router.post(
    "/register",
    ...registerGuards,
    validateMiddleware({ body: registerSchema }),
    controller.register,
  );
  router.post("/login", ...loginGuards, validateMiddleware({ body: loginSchema }), controller.login);

  return router;
}
