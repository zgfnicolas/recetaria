import { z } from "zod";
import { Prisma } from "../../generated/prisma/client.js";
import type { AppPrismaClient } from "../../infrastructure/database/prisma.js";
import { AppError, ConflictError, UnauthorizedError } from "../../shared/errors/app-error.js";
import {
  RECIPE_STATUSES,
  type IngredientDTO,
  type NutritionalInfoDTO,
  type RecipeDifficulty,
  type RecipeStatus,
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

/** Nombre canónico de la entidad en `audit_logs` (`RN-06`, `ADR-0006`). */
export const AUDIT_ENTITY_RECIPE = "Recipe";

/** Acciones auditadas sobre Recetas (`RN-06`); `RESET_TO_DRAFT` y `DELETE` llegan en #20/#21. */
export type RecipeAuditAction = "APPROVE" | "RESET_TO_DRAFT" | "DELETE";

/** Campos del ciclo de vida que cambia una Aprobación (snapshot de `oldValues`/`newValues`). */
export type RecipeApprovalSnapshot = Readonly<{
  status: RecipeStatus;
  reviewedById: string | null;
  publishedAt: Date | null;
}>;

/** Receta junto con su versión de contenido (`ETag`, #46); la versión nunca viaja en el JSON. */
export type VersionedRecipe = Readonly<{ recipe: RecipeRecord; version: number }>;

export type ApproveWithAuditInput = Readonly<{
  recipeId: string;
  reviewerId: string;
  /** Versiones aceptadas por el `If-Match` del revisor (bloqueo optimista, #46). */
  expectedVersions: readonly number[];
}>;

/**
 * Resultado de `approveWithAudit`, decidido sobre la fila bloqueada dentro de la transacción:
 * `not_found` (borrada entre la lectura del servicio y la transacción → `404`),
 * `precondition_failed` (la versión revisada ya no es la vigente → `412`) y
 * `already_approved` (guarda defensiva → `409`: casi inalcanzable, porque una aprobación previa
 * incrementa la versión y el perdedor de una carrera recibe `precondition_failed`).
 */
export type ApproveWithAuditResult =
  | Readonly<{ outcome: "approved"; recipe: RecipeRecord; version: number }>
  | Readonly<{ outcome: "not_found" }>
  | Readonly<{ outcome: "precondition_failed" }>
  | Readonly<{ outcome: "already_approved" }>;

/**
 * Cambios de una edición (`HU-05`): solo las claves presentes se actualizan.
 * `null` vacía los opcionales; `slug` llega regenerado si se editó `title`.
 */
export type UpdateRecipeChanges = Readonly<{
  title?: string;
  slug?: string;
  description?: string;
  difficulty?: RecipeDifficulty;
  prepTimeMinutes?: number;
  tags?: readonly string[];
  ingredients?: readonly IngredientDTO[];
  nutritionalInfo?: NutritionalInfoDTO | null;
  coverImageUrl?: string | null;
  videoUrl?: string | null;
}>;

export type UpdateWithOptionalResetInput = Readonly<{
  recipeId: string;
  actorId: string;
  changes: UpdateRecipeChanges;
}>;

/**
 * Resultado de `updateWithOptionalReset`, decidido sobre la fila bloqueada: `resetToDraft`
 * indica si estaba `APPROVED` y se reinició con `RESET_TO_DRAFT`; `not_found` → `404`.
 */
export type UpdateWithOptionalResetResult =
  | Readonly<{ outcome: "updated"; recipe: RecipeRecord; version: number; resetToDraft: boolean }>
  | Readonly<{ outcome: "not_found" }>;

export type DeleteWithAuditInput = Readonly<{
  recipeId: string;
  actorId: string;
}>;

/** Resultado de `deleteWithAudit`; `not_found` si otro borrado concurrente ganó la carrera (`404`). */
export type DeleteWithAuditResult = Readonly<{ outcome: "deleted" }> | Readonly<{ outcome: "not_found" }>;

/** Snapshot mínimo que `RN-03` conserva en `audit_logs.oldValues` tras el borrado físico. */
export type RecipeDeletionSnapshot = Readonly<{
  title: string;
  authorId: string;
  status: RecipeStatus;
}>;

export interface IRecipeRepository {
  create(data: CreateRecipeRecordInput): Promise<RecipeRecord>;
  findById(id: string): Promise<RecipeRecord | null>;
  /** Detalle con su versión de contenido para el `ETag` (#46). */
  findByIdWithVersion(id: string): Promise<VersionedRecipe | null>;
  findBySlug(slug: string): Promise<RecipeRecord | null>;
  findManyPaginated(params: FindManyPaginatedParams): Promise<PaginatedRecipes>;
  /**
   * Aprueba atómicamente (`RN-06`) una Receta **solo si sigue en `DRAFT`** e inserta `APPROVE`
   * en `audit_logs` con el snapshot real de la fila bloqueada como `oldValues`.
   */
  approveWithAudit(input: ApproveWithAuditInput): Promise<ApproveWithAuditResult>;
  /**
   * Actualiza los campos presentes y, **solo si la fila bloqueada estaba `APPROVED`**, la reinicia
   * a `DRAFT` (limpia `reviewedById`/`publishedAt`) e inserta `RESET_TO_DRAFT` (`RN-02`, `RN-06`).
   */
  updateWithOptionalReset(input: UpdateWithOptionalResetInput): Promise<UpdateWithOptionalResetResult>;
  /**
   * Inserta `DELETE` en `audit_logs` con el snapshot de la fila bloqueada y la elimina físicamente,
   * en la misma transacción (`RN-03`, `RN-06`).
   */
  deleteWithAudit(input: DeleteWithAuditInput): Promise<DeleteWithAuditResult>;
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

/** Proyección pública + `version` (uso interno para el `ETag`; no se serializa en el JSON). */
const RECIPE_VERSIONED_SELECT = {
  ...RECIPE_PUBLIC_SELECT,
  version: true,
} as const satisfies Prisma.RecipeSelect;

type VersionedRecipeRow = Prisma.RecipeGetPayload<{ select: typeof RECIPE_VERSIONED_SELECT }>;

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

/** Separa la versión antes de mapear: `version` no debe filtrarse al cuerpo JSON público. */
function toVersionedRecipe(row: VersionedRecipeRow): VersionedRecipe {
  const { version, ...publicRow } = row;
  return { recipe: toRecipeRecord(publicRow), version };
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

  async findByIdWithVersion(id: string): Promise<VersionedRecipe | null> {
    const row = await this.#prisma.recipe.findUnique({
      where: { id },
      select: RECIPE_VERSIONED_SELECT,
    });
    return row === null ? null : toVersionedRecipe(row);
  }

  async findById(id: string): Promise<RecipeRecord | null> {
    const row = await this.#prisma.recipe.findUnique({
      where: { id },
      select: RECIPE_PUBLIC_SELECT,
    });
    return row === null ? null : toRecipeRecord(row);
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

  /**
   * Transacción interactiva con aislamiento `READ COMMITTED` (por defecto):
   * 1. `SELECT … FOR UPDATE` bloquea la fila y toma el snapshot real para `oldValues` (una
   *    aprobación o edición concurrente espera el commit y relee el estado ya confirmado).
   * 2. `UPDATE` condicional `WHERE id = ? AND status = 'DRAFT'` como guarda adicional (`count`).
   * Sin `SERIALIZABLE` ni reintentos. Un único `publishedAt` alimenta la fila y `newValues`.
   */
  async approveWithAudit(input: ApproveWithAuditInput): Promise<ApproveWithAuditResult> {
    const publishedAt = new Date();
    try {
      return await this.#prisma.$transaction(async (tx): Promise<ApproveWithAuditResult> => {
        const previous = await lockRecipeLifecycle(tx, input.recipeId);
        if (previous === null) {
          return { outcome: "not_found" };
        }
        // Verificación autoritativa del `If-Match` sobre la fila bloqueada: una edición confirmada
        // mientras esta aprobación esperaba el lock ya incrementó la versión (`trg_recipes_version`).
        if (!input.expectedVersions.includes(previous.version)) {
          return { outcome: "precondition_failed" };
        }
        if (previous.status !== "DRAFT") {
          return { outcome: "already_approved" };
        }

        const { count } = await tx.recipe.updateMany({
          where: { id: input.recipeId, status: "DRAFT" },
          data: { status: "APPROVED", reviewedById: input.reviewerId, publishedAt },
        });
        if (count === 0) {
          return { outcome: "already_approved" };
        }

        await tx.auditLog.create({
          data: {
            entityName: AUDIT_ENTITY_RECIPE,
            entityId: input.recipeId,
            action: "APPROVE" satisfies RecipeAuditAction,
            userId: input.reviewerId,
            oldValues: toApprovalSnapshotJson(previous),
            newValues: toApprovalSnapshotJson({
              status: "APPROVED",
              reviewedById: input.reviewerId,
              publishedAt,
            }),
          },
        });

        const row = await tx.recipe.findUniqueOrThrow({
          where: { id: input.recipeId },
          select: RECIPE_VERSIONED_SELECT,
        });
        return { outcome: "approved", ...toVersionedRecipe(row) };
      });
    } catch (err: unknown) {
      // Revisor con JWT válido pero inexistente en `users` (FK de `reviewedById`/`userId`).
      if (hasPrismaErrorCode(err, "P2003")) {
        throw new UnauthorizedError(INVALID_AUTHOR_MESSAGE, { cause: err });
      }
      throw err;
    }
  }

  /**
   * Transacción interactiva `READ COMMITTED`: `SELECT … FOR UPDATE` bloquea la fila y la decisión
   * de reiniciar se toma sobre ese estado confirmado (nunca sobre una lectura previa del servicio),
   * así una aprobación concurrente no puede dejar `APPROVED` un contenido editado sin revisar.
   */
  async updateWithOptionalReset(
    input: UpdateWithOptionalResetInput,
  ): Promise<UpdateWithOptionalResetResult> {
    try {
      return await this.#prisma.$transaction(async (tx): Promise<UpdateWithOptionalResetResult> => {
        const previous = await lockRecipeLifecycle(tx, input.recipeId);
        if (previous === null) {
          return { outcome: "not_found" };
        }
        const resetToDraft = previous.status === "APPROVED";

        const row = await tx.recipe.update({
          where: { id: input.recipeId },
          data: resetToDraft
            ? { ...toRecipeUpdateData(input.changes), status: "DRAFT", reviewedById: null, publishedAt: null }
            : toRecipeUpdateData(input.changes),
          select: RECIPE_VERSIONED_SELECT,
        });

        if (resetToDraft) {
          await tx.auditLog.create({
            data: {
              entityName: AUDIT_ENTITY_RECIPE,
              entityId: input.recipeId,
              action: "RESET_TO_DRAFT" satisfies RecipeAuditAction,
              userId: input.actorId,
              oldValues: toApprovalSnapshotJson(previous),
              newValues: {
                ...toApprovalSnapshotJson({ status: "DRAFT", reviewedById: null, publishedAt: null }),
                changedFields: Object.keys(input.changes).sort(),
              },
            },
          });
        }

        return { outcome: "updated", ...toVersionedRecipe(row), resetToDraft };
      });
    } catch (err: unknown) {
      // Sin rama `P2003`: el actor es siempre el Autor y `fk_recipes_author` (`RESTRICT`) impide
      // borrar un usuario con recetas, así que `audit_logs.userId` no puede violar su FK.
      if (hasPrismaErrorCode(err, "P2002")) {
        throw new ConflictError(RECIPE_SLUG_CONFLICT_MESSAGE, { cause: err });
      }
      throw err;
    }
  }

  /**
   * Transacción interactiva `READ COMMITTED`: `SELECT … FOR UPDATE` bloquea la fila y toma el
   * snapshot `{ title, authorId, status }`; luego inserta `DELETE` (sin FK a `recipes`, sobrevive
   * al borrado) y elimina la fila. Un borrado concurrente espera el lock y obtiene `not_found`.
   */
  async deleteWithAudit(input: DeleteWithAuditInput): Promise<DeleteWithAuditResult> {
    try {
      return await this.#prisma.$transaction(async (tx): Promise<DeleteWithAuditResult> => {
        const snapshot = await lockRecipeForDelete(tx, input.recipeId);
        if (snapshot === null) {
          return { outcome: "not_found" };
        }

        await tx.auditLog.create({
          data: {
            entityName: AUDIT_ENTITY_RECIPE,
            entityId: input.recipeId,
            action: "DELETE" satisfies RecipeAuditAction,
            userId: input.actorId,
            oldValues: { title: snapshot.title, authorId: snapshot.authorId, status: snapshot.status },
            newValues: Prisma.DbNull,
          },
        });
        await tx.recipe.delete({ where: { id: input.recipeId } });

        return { outcome: "deleted" };
      });
    } catch (err: unknown) {
      // `ADMIN` con JWT válido pero ya inexistente en `users` (FK `fk_audit_logs_user`).
      if (hasPrismaErrorCode(err, "P2003")) {
        throw new UnauthorizedError(INVALID_AUTHOR_MESSAGE, { cause: err });
      }
      throw err;
    }
  }
}

type TransactionClient = Parameters<Parameters<AppPrismaClient["$transaction"]>[0]>[0];

/** Lectura defensiva de la fila bloqueada para el borrado: inconsistencia → `500`. */
const lockedDeletionRowSchema = z.object({
  title: z.string(),
  authorId: z.uuid(),
  status: z.enum(RECIPE_STATUSES),
});

/**
 * Bloquea la fila (`SELECT … FOR UPDATE`) y devuelve el snapshot de `RN-03` confirmado, o `null`
 * si no existe. Se toma aquí (no de la lectura del servicio) para auditar el título real.
 */
async function lockRecipeForDelete(
  tx: TransactionClient,
  recipeId: string,
): Promise<RecipeDeletionSnapshot | null> {
  const lockedRows = await tx.$queryRaw<unknown[]>`
    SELECT title, "authorId", status FROM "recipes"
    WHERE id = ${recipeId}::uuid FOR UPDATE`;
  if (lockedRows.length === 0) {
    return null;
  }
  const parsed = lockedDeletionRowSchema.safeParse(lockedRows[0]);
  if (!parsed.success) {
    throw new AppError(500, "Fila de receta bloqueada con formato inválido", {
      isOperational: false,
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * Bloquea la fila (`SELECT … FOR UPDATE`) y devuelve su estado de ciclo de vida confirmado,
 * o `null` si no existe. Compartido por `approveWithAudit` y `updateWithOptionalReset`.
 */
async function lockRecipeLifecycle(
  tx: TransactionClient,
  recipeId: string,
): Promise<LockedRecipeLifecycle | null> {
  const lockedRows = await tx.$queryRaw<unknown[]>`
    SELECT status, "reviewedById", "publishedAt", "version" FROM "recipes"
    WHERE id = ${recipeId}::uuid FOR UPDATE`;
  return lockedRows.length === 0 ? null : parseLockedApprovalSnapshot(lockedRows[0]);
}

/** Traduce los cambios presentes a Prisma; `nutritionalInfo: null` → SQL `NULL` (`DbNull`). */
function toRecipeUpdateData(changes: UpdateRecipeChanges): Prisma.RecipeUncheckedUpdateInput {
  const data: Prisma.RecipeUncheckedUpdateInput = {};
  if (changes.title !== undefined) data.title = changes.title;
  if (changes.slug !== undefined) data.slug = changes.slug;
  if (changes.description !== undefined) data.description = changes.description;
  if (changes.difficulty !== undefined) data.difficulty = changes.difficulty;
  if (changes.prepTimeMinutes !== undefined) data.prepTimeMinutes = changes.prepTimeMinutes;
  if (changes.tags !== undefined) data.tags = [...changes.tags];
  if (changes.ingredients !== undefined) {
    data.ingredients = changes.ingredients.map((ingredient) => ({
      name: ingredient.name,
      quantity: ingredient.quantity,
      unit: ingredient.unit,
    }));
  }
  if (changes.nutritionalInfo !== undefined) {
    // SQL NULL explícito: `Prisma.JsonNull` violaría `chk_recipes_nutritional_info_object`.
    data.nutritionalInfo =
      changes.nutritionalInfo === null ? Prisma.DbNull : toNutritionalInfoJson(changes.nutritionalInfo);
  }
  if (changes.coverImageUrl !== undefined) data.coverImageUrl = changes.coverImageUrl;
  if (changes.videoUrl !== undefined) data.videoUrl = changes.videoUrl;
  return data;
}

/** Lectura defensiva de la fila bloqueada (`$queryRaw` no tipa en runtime): inconsistencia → `500`. */
const lockedApprovalRowSchema = z.object({
  status: z.enum(RECIPE_STATUSES),
  reviewedById: z.string().nullable(),
  publishedAt: z.date().nullable(),
  version: z.int().min(1),
});

/** Estado de ciclo de vida bloqueado más su versión de contenido (#46). */
type LockedRecipeLifecycle = RecipeApprovalSnapshot & Readonly<{ version: number }>;

function parseLockedApprovalSnapshot(value: unknown): LockedRecipeLifecycle {
  const parsed = lockedApprovalRowSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(500, "Fila de receta bloqueada con formato inválido", {
      isOperational: false,
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/** Snapshot JSON de auditoría (fechas en ISO 8601) para `oldValues`/`newValues`. */
function toApprovalSnapshotJson(snapshot: RecipeApprovalSnapshot): Prisma.InputJsonObject {
  return {
    status: snapshot.status,
    reviewedById: snapshot.reviewedById,
    publishedAt: snapshot.publishedAt === null ? null : snapshot.publishedAt.toISOString(),
  };
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
