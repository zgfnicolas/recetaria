import { BadRequestError, NotFoundError, type ErrorDetail } from "../../shared/errors/app-error.js";
import {
  MAX_PREP_TIME_MINUTES,
  MIN_PREP_TIME_MINUTES,
  type CreateRecipeDTO,
  type ListMyRecipesQueryDTO,
  type ListRecipesQueryDTO,
} from "./recipe.schema.js";
import { generateRecipeSlug } from "./recipe.slug.js";
import type { IRecipeRepository, PaginatedRecipes, RecipeRecord } from "./recipe.repository.js";

export const BUSINESS_VALIDATION_MESSAGE = "Error de validación de negocio";
export const RECIPE_NOT_FOUND_MESSAGE = "Receta no encontrada";

export type SlugGenerator = (title: string) => string;

export type RecipeServiceOptions = Readonly<{
  generateSlug?: SlugGenerator | undefined;
}>;

export interface IRecipeService {
  create(authorId: string, dto: CreateRecipeDTO): Promise<RecipeRecord>;
  list(query: ListRecipesQueryDTO): Promise<PaginatedRecipes>;
  getMine(authorId: string, query: ListMyRecipesQueryDTO): Promise<PaginatedRecipes>;
  getById(id: string): Promise<RecipeRecord>;
}

/**
 * Validaciones de dominio `RN-07`: `prepTimeMinutes` entero en `[1, 1440]`
 * y cada ingrediente con `quantity > 0`. Acumula todos los incumplimientos.
 */
function collectRecipeDomainErrors(
  dto: Pick<CreateRecipeDTO, "prepTimeMinutes" | "ingredients">,
): ErrorDetail[] {
  const errors: ErrorDetail[] = [];

  if (
    !Number.isInteger(dto.prepTimeMinutes) ||
    dto.prepTimeMinutes < MIN_PREP_TIME_MINUTES ||
    dto.prepTimeMinutes > MAX_PREP_TIME_MINUTES
  ) {
    errors.push({
      field: "prepTimeMinutes",
      message: `El tiempo de preparación debe ser un entero entre ${String(MIN_PREP_TIME_MINUTES)} y ${String(MAX_PREP_TIME_MINUTES)} minutos`,
    });
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
}
