import { z } from "zod";

export const RECIPE_DIFFICULTIES = ["EASY", "MEDIUM", "HARD", "EXPERT"] as const;
export const RECIPE_STATUSES = ["DRAFT", "APPROVED"] as const;

export type RecipeDifficulty = (typeof RECIPE_DIFFICULTIES)[number];
export type RecipeStatus = (typeof RECIPE_STATUSES)[number];

/** Límites de dominio `RN-07` (también garantizados por `chk_prep_time_positive`). */
export const MIN_PREP_TIME_MINUTES = 1;
export const MAX_PREP_TIME_MINUTES = 1440;

/** Límites estructurales de borde (`ADR-0006`, `docs/data_model.md`). */
export const TITLE_MIN_LENGTH = 3;
export const TITLE_MAX_LENGTH = 150;
export const DESCRIPTION_MIN_LENGTH = 10;
export const DESCRIPTION_MAX_LENGTH = 5000;
export const MAX_INGREDIENTS = 100;
/** Cota superior estructural de cantidades y nutrientes (OWASP API4); `quantity > 0` es `RN-07`. */
export const MAX_NUMERIC_AMOUNT = 100_000;
export const TAG_MAX_LENGTH = 50;
export const MAX_TAGS = 20;
export const INGREDIENT_NAME_MAX_LENGTH = 100;
export const INGREDIENT_UNIT_MAX_LENGTH = 30;
export const MEDIA_URL_MAX_LENGTH = 512;

/**
 * URL opcional acotada a `http`/`https` (bloquea `javascript:`, `data:`, `file:`, etc.).
 */
function mediaUrlSchema(label: string) {
  return z
    .string({ error: `${label} debe ser un texto` })
    .trim()
    .max(MEDIA_URL_MAX_LENGTH, {
      error: `${label} no puede superar los ${String(MEDIA_URL_MAX_LENGTH)} caracteres`,
    })
    .pipe(z.url({ protocol: /^https?$/, error: `${label} debe ser una URL http(s) válida` }));
}

function nonNegativeNutrient(label: string) {
  return z
    .number({ error: `${label} debe ser un número` })
    .min(0, { error: `${label} no puede ser negativo` })
    .max(MAX_NUMERIC_AMOUNT, {
      error: `${label} no puede superar ${String(MAX_NUMERIC_AMOUNT)}`,
    });
}

/**
 * Ingrediente estructurado. `quantity` solo exige número finito acotado: la regla `quantity > 0`
 * es de dominio y la aplica `RecipeService` (`RN-07`).
 */
export const ingredientItemSchema = z.strictObject({
  name: z
    .string({ error: "El nombre del ingrediente es obligatorio" })
    .trim()
    .min(1, { error: "El nombre del ingrediente es obligatorio" })
    .max(INGREDIENT_NAME_MAX_LENGTH, {
      error: `El nombre del ingrediente no puede superar los ${String(INGREDIENT_NAME_MAX_LENGTH)} caracteres`,
    }),
  quantity: z
    .number({ error: "La cantidad del ingrediente debe ser un número" })
    .max(MAX_NUMERIC_AMOUNT, {
      error: `La cantidad del ingrediente no puede superar ${String(MAX_NUMERIC_AMOUNT)}`,
    }),
  unit: z
    .string({ error: "La unidad del ingrediente es obligatoria" })
    .trim()
    .min(1, { error: "La unidad del ingrediente es obligatoria" })
    .max(INGREDIENT_UNIT_MAX_LENGTH, {
      error: `La unidad del ingrediente no puede superar los ${String(INGREDIENT_UNIT_MAX_LENGTH)} caracteres`,
    }),
});

/** Información nutricional opcional tipada (`ADR-0006`). */
export const nutritionalInfoSchema = z.strictObject({
  calories: nonNegativeNutrient("Las calorías").optional(),
  proteinGrams: nonNegativeNutrient("Las proteínas").optional(),
  carbsGrams: nonNegativeNutrient("Los carbohidratos").optional(),
  fatGrams: nonNegativeNutrient("Las grasas").optional(),
  fiberGrams: nonNegativeNutrient("La fibra").optional(),
  servings: z
    .number({ error: "Las porciones deben ser un número" })
    .int({ error: "Las porciones deben ser un número entero" })
    .positive({ error: "Las porciones deben ser mayores a 0" })
    .optional(),
});

const titleField = z
  .string({ error: "El título es obligatorio" })
  .trim()
  .min(TITLE_MIN_LENGTH, {
    error: `El título debe tener al menos ${String(TITLE_MIN_LENGTH)} caracteres`,
  })
  .max(TITLE_MAX_LENGTH, {
    error: `El título no puede superar los ${String(TITLE_MAX_LENGTH)} caracteres`,
  });

const descriptionField = z
  .string({ error: "La descripción es obligatoria" })
  .trim()
  .min(DESCRIPTION_MIN_LENGTH, {
    error: `La descripción debe tener al menos ${String(DESCRIPTION_MIN_LENGTH)} caracteres`,
  })
  .max(DESCRIPTION_MAX_LENGTH, {
    error: `La descripción no puede superar los ${String(DESCRIPTION_MAX_LENGTH)} caracteres`,
  });

const difficultyField = z.enum(RECIPE_DIFFICULTIES, { error: "Dificultad inválida" });

const prepTimeMinutesField = z
  .number({ error: "El tiempo de preparación es obligatorio y debe ser un número" })
  .int({ error: "El tiempo de preparación debe ser un número entero de minutos" });

const tagsField = z
  .array(
    z
      .string({ error: "Cada etiqueta debe ser un texto" })
      .trim()
      .min(1, { error: "Las etiquetas no pueden estar vacías" })
      .max(TAG_MAX_LENGTH, {
        error: `Cada etiqueta no puede superar los ${String(TAG_MAX_LENGTH)} caracteres`,
      }),
    { error: "Las etiquetas deben ser una lista de textos" },
  )
  .max(MAX_TAGS, { error: `No se permiten más de ${String(MAX_TAGS)} etiquetas` });

const ingredientsField = z
  .array(ingredientItemSchema, { error: "Los ingredientes deben ser una lista" })
  .min(1, { error: "La receta debe incluir al menos un ingrediente" })
  .max(MAX_INGREDIENTS, {
    error: `La receta no puede incluir más de ${String(MAX_INGREDIENTS)} ingredientes`,
  });

const coverImageUrlField = mediaUrlSchema("La URL de portada");
const videoUrlField = mediaUrlSchema("La URL de video");

/**
 * Esquema estricto de entrada para `POST /api/v1/recipes`.
 * Rechaza campos protegidos o desconocidos (`status`, `authorId`, `slug`, `reviewedById`,
 * `publishedAt`...) para prevenir BOPLA. `prepTimeMinutes` solo exige entero: el rango
 * `[1, 1440]` es regla de dominio (`RN-07`) y lo valida `RecipeService`.
 */
export const createRecipeSchema = z.strictObject({
  title: titleField,
  description: descriptionField,
  difficulty: difficultyField.default("MEDIUM"),
  prepTimeMinutes: prepTimeMinutesField,
  tags: tagsField.default([]),
  ingredients: ingredientsField,
  nutritionalInfo: nutritionalInfoSchema.optional(),
  coverImageUrl: coverImageUrlField.optional(),
  videoUrl: videoUrlField.optional(),
});

export const UPDATE_REQUIRES_FIELD_MESSAGE = "Debe enviar al menos un campo para actualizar";

/**
 * Esquema estricto de `PUT /api/v1/recipes/:id` (`HU-05`): mismos validadores que el alta pero
 * **sin `.default()`**. `createRecipeSchema.partial()` conservaría los defaults de Zod 4 e
 * inyectaría `difficulty`/`tags` pisando datos guardados (y haría pasar un `{}`).
 * Exige al menos un campo; `null` vacía solo los opcionales (`nutritionalInfo`, `coverImageUrl`,
 * `videoUrl`). Campos protegidos o desconocidos → `400` (BOPLA). `RN-07` lo revalida el servicio.
 */
export const updateRecipeSchema = z
  .strictObject({
    title: titleField.optional(),
    description: descriptionField.optional(),
    difficulty: difficultyField.optional(),
    prepTimeMinutes: prepTimeMinutesField.optional(),
    tags: tagsField.optional(),
    ingredients: ingredientsField.optional(),
    nutritionalInfo: nutritionalInfoSchema.nullable().optional(),
    coverImageUrl: coverImageUrlField.nullable().optional(),
    videoUrl: videoUrlField.nullable().optional(),
  })
  .refine((dto) => Object.keys(dto).length > 0, { error: UPDATE_REQUIRES_FIELD_MESSAGE });

export type IngredientDTO = z.infer<typeof ingredientItemSchema>;
export type NutritionalInfoDTO = z.infer<typeof nutritionalInfoSchema>;
export type CreateRecipeDTO = z.infer<typeof createRecipeSchema>;
export type UpdateRecipeDTO = z.infer<typeof updateRecipeSchema>;

/** Paginación acotada del catálogo (`ADR-0006`, OWASP API4). */
export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
/**
 * Tope de página: mantiene `skip = (page - 1) * limit` dentro del `Int` de 32 bits de Prisma
 * (evita un `500`) y descarta `OFFSET` gigantes.
 */
export const MAX_PAGE = 10_000;
/**
 * Ventana máxima de resultados alcanzables (`page × limit`): acota el `OFFSET` y el costo
 * del ordenamiento en un endpoint público sin rate limit (OWASP API4).
 */
export const MAX_RESULT_WINDOW = 10_000;

const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

/**
 * Entero positivo desde query string con parseo estricto de dígitos
 * (rechaza `" 2 "`, `"1e1"`, `"0x10"`, `"2.0"`, `""` y arreglos por parámetro repetido).
 */
function positiveIntQueryParam(label: string, max: number, defaultValue: number) {
  const rangeMessage = `${label} debe ser un entero entre 1 y ${String(max)}`;
  return z
    .string({ error: rangeMessage })
    .regex(POSITIVE_INTEGER_PATTERN, { error: rangeMessage })
    .transform(Number)
    .pipe(z.int({ error: rangeMessage }).min(1, { error: rangeMessage }).max(max, { error: rangeMessage }))
    .default(defaultValue);
}

/**
 * Forma común de filtros escalares y paginación de los listados (`/` y `/mine`).
 * Se comparte como *shape* porque Zod 4 no permite `.omit()` sobre objetos con `.refine()`.
 */
const recipeListBaseShape = {
  status: z.enum(RECIPE_STATUSES, { error: "Estado inválido" }).optional(),
  difficulty: z.enum(RECIPE_DIFFICULTIES, { error: "Dificultad inválida" }).optional(),
  page: positiveIntQueryParam("page", MAX_PAGE, DEFAULT_PAGE),
  limit: positiveIntQueryParam("limit", MAX_LIMIT, DEFAULT_LIMIT),
};

/** Ventana máxima `page × limit ≤ MAX_RESULT_WINDOW` (OWASP API4). */
function isWithinResultWindow(query: Readonly<{ page: number; limit: number }>): boolean {
  return query.page * query.limit <= MAX_RESULT_WINDOW;
}

const RESULT_WINDOW_REFINEMENT = {
  path: ["page"],
  error: `page × limit no puede superar ${String(MAX_RESULT_WINDOW)} resultados`,
};

/**
 * Esquema estricto de `req.query` para `GET /api/v1/recipes` (`HU-04`).
 * Rechaza claves desconocidas, valores vacíos y parámetros repetidos con `400`.
 */
export const listRecipesQuerySchema = z
  .strictObject({
    ...recipeListBaseShape,
    authorId: z.uuidv4({ error: "authorId debe ser un UUID v4 válido" }).optional(),
  })
  .refine(isWithinResultWindow, RESULT_WINDOW_REFINEMENT);

export type ListRecipesQueryDTO = z.infer<typeof listRecipesQuerySchema>;

/**
 * Esquema estricto de `req.query` para `GET /api/v1/recipes/mine` (`HU-04`).
 * No admite `authorId`: el alcance lo fija siempre `req.user.id` (prevención BOLA/BOPLA).
 */
export const listMyRecipesQuerySchema = z
  .strictObject(recipeListBaseShape)
  .refine(isWithinResultWindow, RESULT_WINDOW_REFINEMENT);

export type ListMyRecipesQueryDTO = z.infer<typeof listMyRecipesQuerySchema>;

/** Parámetro de ruta `:id` de una Receta: UUID v4 (`gen_random_uuid()`, `HU-04`). */
export const recipeIdParamsSchema = z.strictObject({
  id: z.uuidv4({ error: "id debe ser un UUID v4 válido" }),
});

export type RecipeIdParamsDTO = z.infer<typeof recipeIdParamsSchema>;
