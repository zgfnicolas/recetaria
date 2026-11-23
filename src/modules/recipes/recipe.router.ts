import express, { type RequestHandler, type Router } from "express";
import { validateMiddleware } from "../../middlewares/validate.middleware.js";
import type { RecipeController } from "./recipe.controller.js";
import { createRecipeSchema, listRecipesQuerySchema } from "./recipe.schema.js";

/**
 * Construye el router de recetas bajo `/api/v1/recipes`.
 * Rutas públicas: `validateMiddleware → controller`; protegidas:
 * `authGuard → validateMiddleware → controller` (`ADR-0006`).
 * `GET /` se declara antes de las futuras rutas `/mine` y `/:id` (#18).
 */
export function createRecipeRouter(controller: RecipeController, authGuard: RequestHandler): Router {
  const router = express.Router();

  router.get("/", validateMiddleware({ query: listRecipesQuerySchema }), controller.list);
  router.post("/", authGuard, validateMiddleware({ body: createRecipeSchema }), controller.create);

  return router;
}
