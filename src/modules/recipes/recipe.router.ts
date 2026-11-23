import express, { type RequestHandler, type Router } from "express";
import { validateMiddleware } from "../../middlewares/validate.middleware.js";
import type { RecipeController } from "./recipe.controller.js";
import { createRecipeSchema } from "./recipe.schema.js";

/**
 * Construye el router de recetas bajo `/api/v1/recipes`.
 * Rutas protegidas: `authGuard → validateMiddleware → controller` (`ADR-0006`).
 */
export function createRecipeRouter(controller: RecipeController, authGuard: RequestHandler): Router {
  const router = express.Router();

  router.post("/", authGuard, validateMiddleware({ body: createRecipeSchema }), controller.create);

  return router;
}
