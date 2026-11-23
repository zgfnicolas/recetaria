import express, { type RequestHandler, type Router } from "express";
import { validateMiddleware } from "../../middlewares/validate.middleware.js";
import type { RecipeController } from "./recipe.controller.js";
import { createRecipeSchema, listRecipesQuerySchema } from "./recipe.schema.js";

export type RecipeRouterOptions = Readonly<{
  /** Rate limit por IP del catálogo público (#36); se aplica antes de validar la query. */
  publicReadLimiter?: RequestHandler | undefined;
}>;

/**
 * Construye el router de recetas bajo `/api/v1/recipes`.
 * Rutas públicas: `[rateLimit →] validateMiddleware → controller`; protegidas:
 * `authGuard → validateMiddleware → controller` (`ADR-0006`).
 * `GET /` se declara antes de las futuras rutas `/mine` y `/:id` (#18).
 */
export function createRecipeRouter(
  controller: RecipeController,
  authGuard: RequestHandler,
  options?: RecipeRouterOptions,
): Router {
  const router = express.Router();
  const publicReadGuards = options?.publicReadLimiter === undefined ? [] : [options.publicReadLimiter];

  router.get(
    "/",
    ...publicReadGuards,
    validateMiddleware({ query: listRecipesQuerySchema }),
    controller.list,
  );
  router.post("/", authGuard, validateMiddleware({ body: createRecipeSchema }), controller.create);

  return router;
}
