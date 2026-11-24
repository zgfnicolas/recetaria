import type { NextFunction, Request, Response } from "express";
import type { ValidatedRequest } from "../../middlewares/validate.middleware.js";
import type { Actor } from "../auth/index.js";
import { BadRequestError, UnauthorizedError } from "../../shared/errors/app-error.js";
import { sendSuccess } from "../../shared/http/jsend.js";
import type {
  CreateRecipeDTO,
  ListMyRecipesQueryDTO,
  ListRecipesQueryDTO,
  RecipeIdParamsDTO,
  UpdateRecipeDTO,
} from "./recipe.schema.js";
import type { IRecipeService } from "./recipe.service.js";

function readValidatedParams<TParams>(req: Request): TParams {
  const validatedReq = req as Partial<ValidatedRequest<unknown, unknown, TParams>>;
  const params = validatedReq.valid?.params;
  if (params === undefined) {
    throw new BadRequestError("Error de validación");
  }
  return params;
}

function readValidatedQuery<TQuery>(req: Request): TQuery {
  const validatedReq = req as Partial<ValidatedRequest<unknown, TQuery>>;
  const query = validatedReq.valid?.query;
  if (query === undefined) {
    throw new BadRequestError("Error de validación");
  }
  return query;
}

function readValidatedBody<TBody>(req: Request): TBody {
  const validatedReq = req as Partial<ValidatedRequest<TBody>>;
  const body = validatedReq.valid?.body;
  if (body === undefined) {
    throw new BadRequestError("Error de validación");
  }
  return body;
}

function readActor(req: Request): Actor {
  const actor = req.user;
  if (actor === undefined) {
    throw new UnauthorizedError("Autenticación requerida");
  }
  return actor;
}

function readActorId(req: Request): string {
  return readActor(req).id;
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

  readonly list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = readValidatedQuery<ListRecipesQueryDTO>(req);
      const page = await this.#recipeService.list(query);
      sendSuccess(res, {
        statusCode: 200,
        message: "Recetas obtenidas exitosamente",
        data: page,
      });
    } catch (err: unknown) {
      next(err);
    }
  };

  readonly listMine = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authorId = readActorId(req);
      const query = readValidatedQuery<ListMyRecipesQueryDTO>(req);
      const page = await this.#recipeService.getMine(authorId, query);
      sendSuccess(res, {
        statusCode: 200,
        message: "Recetas propias obtenidas exitosamente",
        data: page,
      });
    } catch (err: unknown) {
      next(err);
    }
  };

  readonly getById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = readValidatedParams<RecipeIdParamsDTO>(req);
      const recipe = await this.#recipeService.getById(id);
      sendSuccess(res, {
        statusCode: 200,
        message: "Receta obtenida exitosamente",
        data: recipe,
      });
    } catch (err: unknown) {
      next(err);
    }
  };

  readonly update = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const actor = readActor(req);
      const { id } = readValidatedParams<RecipeIdParamsDTO>(req);
      const body = readValidatedBody<UpdateRecipeDTO>(req);
      const recipe = await this.#recipeService.update(actor, id, body);
      sendSuccess(res, {
        statusCode: 200,
        message: "Receta actualizada exitosamente",
        data: recipe,
      });
    } catch (err: unknown) {
      next(err);
    }
  };

  readonly delete = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const actor = readActor(req);
      const { id } = readValidatedParams<RecipeIdParamsDTO>(req);
      const deleted = await this.#recipeService.delete(actor, id);
      sendSuccess(res, {
        statusCode: 200,
        message: "Receta eliminada exitosamente",
        data: deleted,
      });
    } catch (err: unknown) {
      next(err);
    }
  };

  readonly approve = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const actor = readActor(req);
      const { id } = readValidatedParams<RecipeIdParamsDTO>(req);
      const recipe = await this.#recipeService.approve(actor, id);
      sendSuccess(res, {
        statusCode: 200,
        message: "Receta aprobada exitosamente",
        data: recipe,
      });
    } catch (err: unknown) {
      next(err);
    }
  };
}
