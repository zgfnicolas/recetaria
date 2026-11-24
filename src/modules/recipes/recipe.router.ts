import express, { type RequestHandler, type Router } from "express";
import { rbacMiddleware } from "../../middlewares/rbac.middleware.js";
import { validateMiddleware } from "../../middlewares/validate.middleware.js";
import type { RecipeController } from "./recipe.controller.js";
import { RECIPE_APPROVER_ROLES } from "./recipe.policy.js";
import {
  createRecipeSchema,
  listMyRecipesQuerySchema,
  listRecipesQuerySchema,
  recipeIdParamsSchema,
} from "./recipe.schema.js";

export type RecipeRouterOptions = Readonly<{
  /**
   * Rate limit por IP de las lecturas públicas (`GET /` y `GET /:id`, #36 y #18; cuota
   * compartida); se aplica antes de validar.
   */
  publicReadLimiter?: RequestHandler | undefined;
}>;

/**
 * Construye el router de recetas bajo `/api/v1/recipes`.
 * Rutas públicas: `[rateLimit →] validateMiddleware → controller`; protegidas:
 * `authGuard → [rbacMiddleware →] validateMiddleware → controller` (`ADR-0006`).
 * `GET /mine` se declara **antes** de `GET /:id` para que el literal `"mine"` nunca se
 * capture como `:id` (#18).
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
  router.get(
    "/mine",
    authGuard,
    validateMiddleware({ query: listMyRecipesQuerySchema }),
    controller.listMine,
  );
  router.get(
    "/:id",
    ...publicReadGuards,
    validateMiddleware({ params: recipeIdParamsSchema }),
    controller.getById,
  );
  router.post("/", authGuard, validateMiddleware({ body: createRecipeSchema }), controller.create);
  router.put(
    "/:id/approve",
    authGuard,
    rbacMiddleware(RECIPE_APPROVER_ROLES),
    validateMiddleware({ params: recipeIdParamsSchema }),
    controller.approve,
  );

  return router;
}
