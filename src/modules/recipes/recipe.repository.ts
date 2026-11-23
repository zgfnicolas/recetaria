import { z } from "zod";
import { Prisma } from "../../generated/prisma/client.js";
import type { AppPrismaClient } from "../../infrastructure/database/prisma.js";
import { AppError, ConflictError, UnauthorizedError } from "../../shared/errors/app-error.js";
import type {
  IngredientDTO,
  NutritionalInfoDTO,
  RecipeDifficulty,
  RecipeStatus,
} from "./recipe.schema.js";

/** Proyección pública de una Receta persistida. */
export type RecipeRecord = Readonly<{
  id: string;
  title: string;
  slug: string;
  description: string;
  difficulty: RecipeDifficulty;
  status: RecipeStatus;
  prepTimeMinutes: number;
  tags: readonly string[];
  ingredients: readonly IngredientDTO[];
  nutritionalInfo: NutritionalInfoDTO | null;
  coverImageUrl: string | null;
  videoUrl: string | null;
  authorId: string;
  reviewedById: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type CreateRecipeRecordInput = Readonly<{
  title: string;
  slug: string;
  description: string;
  difficulty: RecipeDifficulty;
  status: RecipeStatus;
  prepTimeMinutes: number;
  tags: readonly string[];
  ingredients: readonly IngredientDTO[];
  nutritionalInfo: NutritionalInfoDTO | null;
  coverImageUrl: string | null;
  videoUrl: string | null;
  authorId: string;
}>;

/** Filtros opcionales combinables del catálogo (`HU-04`). */
export type RecipeListFilters = Readonly<{
  status?: RecipeStatus | undefined;
  difficulty?: RecipeDifficulty | undefined;
  authorId?: string | undefined;
}>;

export type FindManyPaginatedParams = Readonly<{
  filters: RecipeListFilters;
  page: number;
  limit: number;
}>;

export type PaginationMeta = Readonly<{
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}>;

export type PaginatedRecipes = Readonly<{
  items: readonly RecipeRecord[];
  meta: PaginationMeta;
}>;

export interface IRecipeRepository {
  create(data: CreateRecipeRecordInput): Promise<RecipeRecord>;
  findBySlug(slug: string): Promise<RecipeRecord | null>;
  findManyPaginated(params: FindManyPaginatedParams): Promise<PaginatedRecipes>;
}

export const RECIPE_SLUG_CONFLICT_MESSAGE = "Ya existe una receta con ese slug";
export const INVALID_AUTHOR_MESSAGE = "Usuario autenticado no válido";

const RECIPE_PUBLIC_SELECT = {
  id: true,
  title: true,
  slug: true,
  description: true,
  difficulty: true,
  status: true,
  prepTimeMinutes: true,
  tags: true,
  ingredients: true,
  nutritionalInfo: true,
  coverImageUrl: true,
  videoUrl: true,
  authorId: true,
  reviewedById: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.RecipeSelect;

type RecipeRow = Prisma.RecipeGetPayload<{ select: typeof RECIPE_PUBLIC_SELECT }>;

/** Orden determinístico: `id` desempata recetas con el mismo `createdAt` (sin duplicados ni saltos). */
const RECIPE_LIST_ORDER_BY = [
  { createdAt: "desc" },
  { id: "desc" },
] as const satisfies Prisma.RecipeOrderByWithRelationInput[];

/** Construye el `where` de Prisma solo con los filtros definidos (nunca filtra en memoria). */
function buildRecipeListWhere(filters: RecipeListFilters): Prisma.RecipeWhereInput {
  const where: Prisma.RecipeWhereInput = {};
  if (filters.status !== undefined) {
    where.status = filters.status;
  }
  if (filters.difficulty !== undefined) {
    where.difficulty = filters.difficulty;
  }
  if (filters.authorId !== undefined) {
    where.authorId = filters.authorId;
  }
  return where;
}

export function calculateTotalPages(total: number, limit: number): number {
  return total === 0 ? 0 : Math.ceil(total / limit);
}

/** Lectura defensiva de columnas JSONB (tolerante a claves extra, estricta en tipos). */
const storedIngredientsSchema = z.array(
  z.object({ name: z.string(), quantity: z.number(), unit: z.string() }),
);
const storedNutritionalInfoSchema = z
  .object({
    calories: z.number().optional(),
    proteinGrams: z.number().optional(),
    carbsGrams: z.number().optional(),
    fatGrams: z.number().optional(),
    fiberGrams: z.number().optional(),
    servings: z.number().optional(),
  })
  .nullable();

/**
 * Datos persistidos inconsistentes son un fallo del servidor (500), nunca un `ZodError`
 * que el manejador global traduciría a `400` culpando al cliente.
 */
function parseStoredJson<T>(schema: z.ZodType<T>, value: unknown, column: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(500, `Columna JSONB "${column}" de receta con formato inválido`, {
      isOperational: false,
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function toRecipeRecord(row: RecipeRow): RecipeRecord {
  return {
    ...row,
    ingredients: parseStoredJson(storedIngredientsSchema, row.ingredients, "ingredients"),
    nutritionalInfo: parseStoredJson(
      storedNutritionalInfoSchema,
      row.nutritionalInfo,
      "nutritionalInfo",
    ),
  };
}

function hasPrismaErrorCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

/**
 * Repositorio Prisma exclusivo del módulo `Recipes` (único punto de acceso a PostgreSQL).
 * Mapea `P2002` (slug duplicado) a `409` y `P2003` (autor inexistente) a `401`.
 */
export class RecipeRepository implements IRecipeRepository {
  readonly #prisma: AppPrismaClient;

  constructor(prisma: AppPrismaClient) {
    this.#prisma = prisma;
  }

  async create(data: CreateRecipeRecordInput): Promise<RecipeRecord> {
    try {
      const row = await this.#prisma.recipe.create({
        data: {
          title: data.title,
          slug: data.slug,
          description: data.description,
          difficulty: data.difficulty,
          status: data.status,
          prepTimeMinutes: data.prepTimeMinutes,
          tags: [...data.tags],
          ingredients: data.ingredients.map((ingredient) => ({
            name: ingredient.name,
            quantity: ingredient.quantity,
            unit: ingredient.unit,
          })),
          // SQL NULL explícito: `Prisma.JsonNull` violaría `chk_recipes_nutritional_info_object`.
          nutritionalInfo:
            data.nutritionalInfo === null ? Prisma.DbNull : toNutritionalInfoJson(data.nutritionalInfo),
          coverImageUrl: data.coverImageUrl,
          videoUrl: data.videoUrl,
          authorId: data.authorId,
        },
        select: RECIPE_PUBLIC_SELECT,
      });
      return toRecipeRecord(row);
    } catch (err: unknown) {
      if (hasPrismaErrorCode(err, "P2002")) {
        throw new ConflictError(RECIPE_SLUG_CONFLICT_MESSAGE, { cause: err });
      }
      if (hasPrismaErrorCode(err, "P2003")) {
        throw new UnauthorizedError(INVALID_AUTHOR_MESSAGE, { cause: err });
      }
      throw err;
    }
  }

  async findBySlug(slug: string): Promise<RecipeRecord | null> {
    const row = await this.#prisma.recipe.findUnique({
      where: { slug },
      select: RECIPE_PUBLIC_SELECT,
    });
    return row === null ? null : toRecipeRecord(row);
  }

  async findManyPaginated(params: FindManyPaginatedParams): Promise<PaginatedRecipes> {
    const { page, limit } = params;
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1) {
      throw new RangeError("page y limit deben ser enteros >= 1");
    }

    const where = buildRecipeListWhere(params.filters);
    const [total, rows] = await this.#prisma.$transaction([
      this.#prisma.recipe.count({ where }),
      this.#prisma.recipe.findMany({
        where,
        orderBy: [...RECIPE_LIST_ORDER_BY],
        skip: (page - 1) * limit,
        take: limit,
        select: RECIPE_PUBLIC_SELECT,
      }),
    ]);

    return {
      items: rows.map(toRecipeRecord),
      meta: { page, limit, total, totalPages: calculateTotalPages(total, limit) },
    };
  }
}

/** Copia solo las claves definidas (sin `undefined`) hacia un objeto JSON de Prisma. */
function toNutritionalInfoJson(info: NutritionalInfoDTO): Prisma.InputJsonObject {
  const json: Record<string, number> = {};
  for (const [key, value] of Object.entries(info)) {
    if (typeof value === "number") {
      json[key] = value;
    }
  }
  return json;
}
