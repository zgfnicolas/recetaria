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

/**
 * Esquema estricto de entrada para `POST /api/v1/recipes`.
 * Rechaza campos protegidos o desconocidos (`status`, `authorId`, `slug`, `reviewedById`,
 * `publishedAt`...) para prevenir BOPLA. `prepTimeMinutes` solo exige entero: el rango
 * `[1, 1440]` es regla de dominio (`RN-07`) y lo valida `RecipeService`.
 */
export const createRecipeSchema = z.strictObject({
  title: z
    .string({ error: "El título es obligatorio" })
    .trim()
    .min(TITLE_MIN_LENGTH, {
      error: `El título debe tener al menos ${String(TITLE_MIN_LENGTH)} caracteres`,
    })
    .max(TITLE_MAX_LENGTH, {
      error: `El título no puede superar los ${String(TITLE_MAX_LENGTH)} caracteres`,
    }),
  description: z
    .string({ error: "La descripción es obligatoria" })
    .trim()
    .min(DESCRIPTION_MIN_LENGTH, {
      error: `La descripción debe tener al menos ${String(DESCRIPTION_MIN_LENGTH)} caracteres`,
    })
    .max(DESCRIPTION_MAX_LENGTH, {
      error: `La descripción no puede superar los ${String(DESCRIPTION_MAX_LENGTH)} caracteres`,
    }),
  difficulty: z.enum(RECIPE_DIFFICULTIES, { error: "Dificultad inválida" }).default("MEDIUM"),
  prepTimeMinutes: z
    .number({ error: "El tiempo de preparación es obligatorio y debe ser un número" })
    .int({ error: "El tiempo de preparación debe ser un número entero de minutos" }),
  tags: z
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
    .max(MAX_TAGS, { error: `No se permiten más de ${String(MAX_TAGS)} etiquetas` })
    .default([]),
  ingredients: z
    .array(ingredientItemSchema, { error: "Los ingredientes deben ser una lista" })
    .min(1, { error: "La receta debe incluir al menos un ingrediente" })
    .max(MAX_INGREDIENTS, {
      error: `La receta no puede incluir más de ${String(MAX_INGREDIENTS)} ingredientes`,
    }),
  nutritionalInfo: nutritionalInfoSchema.optional(),
  coverImageUrl: mediaUrlSchema("La URL de portada").optional(),
  videoUrl: mediaUrlSchema("La URL de video").optional(),
});

export type IngredientDTO = z.infer<typeof ingredientItemSchema>;
export type NutritionalInfoDTO = z.infer<typeof nutritionalInfoSchema>;
export type CreateRecipeDTO = z.infer<typeof createRecipeSchema>;
