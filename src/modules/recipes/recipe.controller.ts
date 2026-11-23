import type { NextFunction, Request, Response } from "express";
import type { ValidatedRequest } from "../../middlewares/validate.middleware.js";
import { BadRequestError, UnauthorizedError } from "../../shared/errors/app-error.js";
import { sendSuccess } from "../../shared/http/jsend.js";
import type { CreateRecipeDTO } from "./recipe.schema.js";
import type { IRecipeService } from "./recipe.service.js";

function readValidatedBody<TBody>(req: Request): TBody {
  const validatedReq = req as Partial<ValidatedRequest<TBody>>;
  const body = validatedReq.valid?.body;
  if (body === undefined) {
    throw new BadRequestError("Error de validación");
  }
  return body;
}

function readActorId(req: Request): string {
  const actor = req.user;
  if (actor === undefined) {
    throw new UnauthorizedError("Autenticación requerida");
  }
  return actor.id;
}

/**
 * Controlador HTTP del módulo `Recipes`.
 * Lee `req.user` y `req.valid.body`, delega en `IRecipeService` y emite respuestas JSend.
 */
export class RecipeController {
  readonly #recipeService: IRecipeService;

  constructor(recipeService: IRecipeService) {
    this.#recipeService = recipeService;
  }

  readonly create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authorId = readActorId(req);
      const body = readValidatedBody<CreateRecipeDTO>(req);
      const recipe = await this.#recipeService.create(authorId, body);
      sendSuccess(res, {
        statusCode: 201,
        message: "Receta creada exitosamente",
        data: recipe,
      });
    } catch (err: unknown) {
      next(err);
    }
  };
}
