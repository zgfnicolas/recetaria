import type { Actor } from "../auth/index.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type ErrorDetail,
} from "../../shared/errors/app-error.js";
import { canApprove, canEdit } from "./recipe.policy.js";
import {
  MAX_PREP_TIME_MINUTES,
  MIN_PREP_TIME_MINUTES,
  type CreateRecipeDTO,
  type IngredientDTO,
  type ListMyRecipesQueryDTO,
  type ListRecipesQueryDTO,
  type UpdateRecipeDTO,
} from "./recipe.schema.js";
import { generateRecipeSlug } from "./recipe.slug.js";
import type {
  IRecipeRepository,
  PaginatedRecipes,
  RecipeRecord,
  UpdateRecipeChanges,
} from "./recipe.repository.js";

export const BUSINESS_VALIDATION_MESSAGE = "Error de validación de negocio";
export const RECIPE_NOT_FOUND_MESSAGE = "Receta no encontrada";
export const RECIPE_APPROVAL_FORBIDDEN_MESSAGE =
  "Solo un revisor profesional distinto del autor puede aprobar la receta";
export const RECIPE_ALREADY_APPROVED_MESSAGE = "La receta ya está aprobada";
export const RECIPE_EDIT_FORBIDDEN_MESSAGE = "Solo el autor puede editar la receta";

export type SlugGenerator = (title: string) => string;

export type RecipeServiceOptions = Readonly<{
  generateSlug?: SlugGenerator | undefined;
}>;

export interface IRecipeService {
  create(authorId: string, dto: CreateRecipeDTO): Promise<RecipeRecord>;
  list(query: ListRecipesQueryDTO): Promise<PaginatedRecipes>;
  getMine(authorId: string, query: ListMyRecipesQueryDTO): Promise<PaginatedRecipes>;
  getById(id: string): Promise<RecipeRecord>;
  approve(actor: Actor, recipeId: string): Promise<RecipeRecord>;
  update(actor: Actor, recipeId: string, dto: UpdateRecipeDTO): Promise<RecipeRecord>;
}

/**
 * Validaciones de dominio `RN-07`: `prepTimeMinutes` entero en `[1, 1440]`
 * y cada ingrediente con `quantity > 0`. Acumula todos los incumplimientos. En una edición
 * parcial solo valida los campos presentes (`HU-05`).
 */
function collectRecipeDomainErrors(
  dto: Readonly<{
    prepTimeMinutes?: number | undefined;
    ingredients?: readonly IngredientDTO[] | undefined;
  }>,
): ErrorDetail[] {
  const errors: ErrorDetail[] = [];

  if (
    dto.prepTimeMinutes !== undefined &&
    (!Number.isInteger(dto.prepTimeMinutes) ||
      dto.prepTimeMinutes < MIN_PREP_TIME_MINUTES ||
      dto.prepTimeMinutes > MAX_PREP_TIME_MINUTES)
  ) {
    errors.push({
      field: "prepTimeMinutes",
      message: `El tiempo de preparación debe ser un entero entre ${String(MIN_PREP_TIME_MINUTES)} y ${String(MAX_PREP_TIME_MINUTES)} minutos`,
    });
  }

  if (dto.ingredients === undefined) {
    return errors;
  }

  if (dto.ingredients.length === 0) {
    errors.push({ field: "ingredients", message: "La receta debe incluir al menos un ingrediente" });
  }

  dto.ingredients.forEach((ingredient, index) => {
    if (!Number.isFinite(ingredient.quantity) || ingredient.quantity <= 0) {
      errors.push({
        field: `ingredients.${String(index)}.quantity`,
        message: "La cantidad del ingrediente debe ser mayor a 0",
      });
    }
  });

  return errors;
}

/**
 * Servicio de dominio del módulo `Recipes`, desacoplado de Express y Prisma.
 */
export class RecipeService implements IRecipeService {
  readonly #recipeRepository: IRecipeRepository;
  readonly #generateSlug: SlugGenerator;

  constructor(recipeRepository: IRecipeRepository, options?: RecipeServiceOptions) {
    this.#recipeRepository = recipeRepository;
    this.#generateSlug = options?.generateSlug ?? ((title) => generateRecipeSlug(title));
  }

  /**
   * Crea una receta en `DRAFT` con `authorId` del usuario autenticado y `slug` automático
   * (`RN-01`), tras validar las reglas de dominio `RN-07`.
   */
  async create(authorId: string, dto: CreateRecipeDTO): Promise<RecipeRecord> {
    const errors = collectRecipeDomainErrors(dto);
    if (errors.length > 0) {
      throw new BadRequestError(BUSINESS_VALIDATION_MESSAGE, { errors });
    }

    return this.#recipeRepository.create({
      title: dto.title,
      slug: this.#generateSlug(dto.title),
      description: dto.description,
      difficulty: dto.difficulty,
      status: "DRAFT",
      prepTimeMinutes: dto.prepTimeMinutes,
      tags: dto.tags,
      ingredients: dto.ingredients,
      nutritionalInfo: dto.nutritionalInfo ?? null,
      coverImageUrl: dto.coverImageUrl ?? null,
      videoUrl: dto.videoUrl ?? null,
      authorId,
    });
  }

  /**
   * Lista el catálogo público (`DRAFT` y `APPROVED` por defecto, `HU-04`) con filtros
   * combinables y paginación acotada ya validada en el borde.
   */
  async list(query: ListRecipesQueryDTO): Promise<PaginatedRecipes> {
    return this.#recipeRepository.findManyPaginated({
      filters: {
        status: query.status,
        difficulty: query.difficulty,
        authorId: query.authorId,
      },
      page: query.page,
      limit: query.limit,
    });
  }

  /**
   * Lista solo las Recetas del Autor autenticado (`HU-04`). Los filtros se construyen
   * campo a campo: `authorId` es siempre el del actor y ningún valor de la query puede pisarlo.
   */
  async getMine(authorId: string, query: ListMyRecipesQueryDTO): Promise<PaginatedRecipes> {
    return this.#recipeRepository.findManyPaginated({
      filters: {
        status: query.status,
        difficulty: query.difficulty,
        authorId,
      },
      page: query.page,
      limit: query.limit,
    });
  }

  /**
   * Detalle público de una Receta (`DRAFT` o `APPROVED`, `docs/roles.md`); `404` si no existe.
   */
  async getById(id: string): Promise<RecipeRecord> {
    const recipe = await this.#recipeRepository.findById(id);
    if (recipe === null) {
      throw new NotFoundError(RECIPE_NOT_FOUND_MESSAGE);
    }
    return recipe;
  }

  /**
   * Aprobación profesional `DRAFT → APPROVED` (`HU-07`): `404` si no existe, `403` si el actor
   * no es Revisor Profesional o es el Autor (`RN-04`, `RN-05`), `409` si ya está aprobada o si
   * una aprobación concurrente ganó la carrera (`RN-04`); `404` también si se borró entretanto. Persistencia atómica en `RN-06`.
   */
  async approve(actor: Actor, recipeId: string): Promise<RecipeRecord> {
    const recipe = await this.#recipeRepository.findById(recipeId);
    if (recipe === null) {
      throw new NotFoundError(RECIPE_NOT_FOUND_MESSAGE);
    }
    if (!canApprove(actor, recipe)) {
      throw new ForbiddenError(RECIPE_APPROVAL_FORBIDDEN_MESSAGE);
    }
    if (recipe.status === "APPROVED") {
      throw new ConflictError(RECIPE_ALREADY_APPROVED_MESSAGE);
    }

    // El repositorio vuelve a verificar el estado sobre la fila bloqueada (`FOR UPDATE`): cubre
    // la carrera entre esta lectura y la transacción (aprobación o borrado concurrentes).
    const result = await this.#recipeRepository.approveWithAudit({
      recipeId,
      reviewerId: actor.id,
    });
    switch (result.outcome) {
      case "approved":
        return result.recipe;
      case "not_found":
        throw new NotFoundError(RECIPE_NOT_FOUND_MESSAGE);
      case "already_approved":
        throw new ConflictError(RECIPE_ALREADY_APPROVED_MESSAGE);
    }
  }

  /**
   * Edición parcial o completa por el Autor (`HU-05`): `404` si no existe, `403` si el actor no es
   * el Autor (`RN-02`, incluido `ADMIN`), `400` por `RN-07` sobre los campos presentes y `slug`
   * regenerado solo si llega `title`. El reinicio a `DRAFT` + `RESET_TO_DRAFT` lo decide el
   * repositorio sobre la fila bloqueada (`RN-06`).
   */
  async update(actor: Actor, recipeId: string, dto: UpdateRecipeDTO): Promise<RecipeRecord> {
    const recipe = await this.#recipeRepository.findById(recipeId);
    if (recipe === null) {
      throw new NotFoundError(RECIPE_NOT_FOUND_MESSAGE);
    }
    if (!canEdit(actor, recipe)) {
      throw new ForbiddenError(RECIPE_EDIT_FORBIDDEN_MESSAGE);
    }

    const errors = collectRecipeDomainErrors(dto);
    if (errors.length > 0) {
      throw new BadRequestError(BUSINESS_VALIDATION_MESSAGE, { errors });
    }

    const result = await this.#recipeRepository.updateWithOptionalReset({
      recipeId,
      actorId: actor.id,
      changes: this.#buildChanges(dto),
    });
    if (result.outcome === "not_found") {
      throw new NotFoundError(RECIPE_NOT_FOUND_MESSAGE);
    }
    return result.recipe;
  }

  /** Copia solo los campos presentes (sin `undefined`) y agrega el `slug` si cambia `title`. */
  #buildChanges(dto: UpdateRecipeDTO): UpdateRecipeChanges {
    return {
      ...(dto.title === undefined ? {} : { title: dto.title, slug: this.#generateSlug(dto.title) }),
      ...(dto.description === undefined ? {} : { description: dto.description }),
      ...(dto.difficulty === undefined ? {} : { difficulty: dto.difficulty }),
      ...(dto.prepTimeMinutes === undefined ? {} : { prepTimeMinutes: dto.prepTimeMinutes }),
      ...(dto.tags === undefined ? {} : { tags: dto.tags }),
      ...(dto.ingredients === undefined ? {} : { ingredients: dto.ingredients }),
      ...(dto.nutritionalInfo === undefined ? {} : { nutritionalInfo: dto.nutritionalInfo }),
      ...(dto.coverImageUrl === undefined ? {} : { coverImageUrl: dto.coverImageUrl }),
      ...(dto.videoUrl === undefined ? {} : { videoUrl: dto.videoUrl }),
    };
  }
}
