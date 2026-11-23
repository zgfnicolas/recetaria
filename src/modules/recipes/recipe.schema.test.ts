import { describe, expect, it } from "vitest";
import {
  createRecipeSchema,
  DESCRIPTION_MAX_LENGTH,
  MAX_INGREDIENTS,
  MAX_NUMERIC_AMOUNT,
  MAX_TAGS,
} from "./recipe.schema.js";

const INGREDIENT = { name: "Papa", quantity: 1, unit: "kg" } as const;

function buildValidInput(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    title: "Ñoquis caseros",
    description: "Ñoquis de papa tradicionales del 29.",
    prepTimeMinutes: 45,
    ingredients: [{ name: "Papa", quantity: 1, unit: "kg" }],
    ...overrides,
  };
}

function issuePaths(input: unknown): string[] {
  const result = createRecipeSchema.safeParse(input);
  if (result.success) {
    return [];
  }
  return result.error.issues.map((issue) => issue.path.map(String).join("."));
}

describe("createRecipeSchema — entrada mínima y completa", () => {
  it("acepta la entrada mínima aplicando defaults (difficulty MEDIUM, tags []) y trim", () => {
    // Act
    const result = createRecipeSchema.parse(
      buildValidInput({ title: "  Ñoquis caseros  ", description: "  Ñoquis de papa del 29.  " }),
    );

    // Assert
    expect(result).toEqual({
      title: "Ñoquis caseros",
      description: "Ñoquis de papa del 29.",
      difficulty: "MEDIUM",
      prepTimeMinutes: 45,
      tags: [],
      ingredients: [{ name: "Papa", quantity: 1, unit: "kg" }],
    });
  });

  it("acepta la entrada completa con nutritionalInfo y URLs http/https", () => {
    // Arrange
    const input = buildValidInput({
      difficulty: "EXPERT",
      tags: [" vegano ", "sin-tacc"],
      nutritionalInfo: {
        calories: 350,
        proteinGrams: 12.5,
        carbsGrams: 40,
        fatGrams: 0,
        fiberGrams: 3,
        servings: 4,
      },
      coverImageUrl: "https://cdn.recetaria.com/noquis.jpg",
      videoUrl: "http://videos.recetaria.com/noquis.mp4",
    });

    // Act
    const result = createRecipeSchema.parse(input);

    // Assert
    expect(result.tags).toEqual(["vegano", "sin-tacc"]);
    expect(result.nutritionalInfo).toEqual({
      calories: 350,
      proteinGrams: 12.5,
      carbsGrams: 40,
      fatGrams: 0,
      fiberGrams: 3,
      servings: 4,
    });
    expect(result.coverImageUrl).toBe("https://cdn.recetaria.com/noquis.jpg");
  });
});

describe("createRecipeSchema — bordes estructurales", () => {
  it.each([
    ["title", "ab"],
    ["title", "   ab   "],
    ["title", "x".repeat(151)],
    ["description", "corta"],
    ["difficulty", "IMPOSSIBLE"],
    ["prepTimeMinutes", 12.5],
    ["prepTimeMinutes", "45"],
    ["ingredients", []],
    ["tags", Array.from({ length: MAX_TAGS + 1 }, (_, i) => `tag-${String(i)}`)],
    ["description", "d".repeat(DESCRIPTION_MAX_LENGTH + 1)],
    ["ingredients", Array.from({ length: MAX_INGREDIENTS + 1 }, () => INGREDIENT)],
  ])("rechaza %s = %j", (field, value) => {
    expect(issuePaths(buildValidInput({ [field]: value }))).toContain(field);
  });

  it("acepta los bordes title 3/150 y 20 tags de 50 caracteres", () => {
    expect(createRecipeSchema.safeParse(buildValidInput({ title: "abc" })).success).toBe(true);
    expect(createRecipeSchema.safeParse(buildValidInput({ title: "x".repeat(150) })).success).toBe(
      true,
    );
    expect(
      createRecipeSchema.safeParse(
        buildValidInput({ tags: Array.from({ length: MAX_TAGS }, () => "t".repeat(50)) }),
      ).success,
    ).toBe(true);
  });

  it("acepta los topes description 5000, 100 ingredientes y cantidades/nutrientes de 100000 (OWASP API4)", () => {
    // Act
    const result = createRecipeSchema.safeParse(
      buildValidInput({
        description: "d".repeat(DESCRIPTION_MAX_LENGTH),
        ingredients: Array.from({ length: MAX_INGREDIENTS }, () => ({
          ...INGREDIENT,
          quantity: MAX_NUMERIC_AMOUNT,
        })),
        nutritionalInfo: { calories: MAX_NUMERIC_AMOUNT, fatGrams: MAX_NUMERIC_AMOUNT },
      }),
    );

    // Assert
    expect(result.success).toBe(true);
  });

  it("rechaza cantidades y nutrientes por encima de 100000 (OWASP API4)", () => {
    // Act
    const paths = issuePaths(
      buildValidInput({
        ingredients: [{ ...INGREDIENT, quantity: MAX_NUMERIC_AMOUNT + 1 }],
        nutritionalInfo: { calories: MAX_NUMERIC_AMOUNT + 1, proteinGrams: MAX_NUMERIC_AMOUNT + 0.5 },
      }),
    );

    // Assert
    expect(paths).toEqual(
      expect.arrayContaining([
        "ingredients.0.quantity",
        "nutritionalInfo.calories",
        "nutritionalInfo.proteinGrams",
      ]),
    );
  });

  it.each([[""], ["   "], ["t".repeat(51)]])("rechaza etiquetas inválidas %j", (tag) => {
    expect(issuePaths(buildValidInput({ tags: [tag] }))).toContain("tags.0");
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "file:///etc/passwd",
    "ftp://recetaria.com/x.jpg",
    "no-es-una-url",
    `https://recetaria.com/${"a".repeat(512)}`,
  ])("rechaza coverImageUrl/videoUrl peligrosas o inválidas: %s", (url) => {
    const paths = issuePaths(buildValidInput({ coverImageUrl: url, videoUrl: url }));
    expect(paths).toContain("coverImageUrl");
    expect(paths).toContain("videoUrl");
  });

  it.each([
    ["calories", -1],
    ["fiberGrams", -0.5],
    ["servings", 0],
    ["servings", 1.5],
  ])("rechaza nutritionalInfo.%s = %j", (field, value) => {
    expect(issuePaths(buildValidInput({ nutritionalInfo: { [field]: value } }))).toContain(
      `nutritionalInfo.${field}`,
    );
  });

  it.each([
    [{ name: "", quantity: 1, unit: "kg" }, "ingredients.0.name"],
    [{ name: "Papa", quantity: 1, unit: "  " }, "ingredients.0.unit"],
    [{ name: "Papa", quantity: "1", unit: "kg" }, "ingredients.0.quantity"],
    [{ name: "Papa", quantity: Number.POSITIVE_INFINITY, unit: "kg" }, "ingredients.0.quantity"],
  ])("rechaza ingredientes estructuralmente inválidos %j", (ingredient, path) => {
    expect(issuePaths(buildValidInput({ ingredients: [ingredient] }))).toContain(path);
  });
});

describe("createRecipeSchema — reglas de dominio delegadas al servicio (RN-07)", () => {
  it.each([0, -5, 1441])(
    "deja pasar prepTimeMinutes = %d para que RecipeService aplique RN-07",
    (prepTimeMinutes) => {
      expect(createRecipeSchema.safeParse(buildValidInput({ prepTimeMinutes })).success).toBe(true);
    },
  );

  it.each([0, -2])("deja pasar quantity = %d para que RecipeService aplique RN-07", (quantity) => {
    expect(
      createRecipeSchema.safeParse(
        buildValidInput({ ingredients: [{ name: "Sal", quantity, unit: "g" }] }),
      ).success,
    ).toBe(true);
  });
});

describe("createRecipeSchema — prevención BOPLA (z.strictObject)", () => {
  it.each(["status", "authorId", "reviewedById", "publishedAt", "slug", "id", "createdAt"])(
    "rechaza el campo protegido %s en la raíz",
    (field) => {
      const result = createRecipeSchema.safeParse(buildValidInput({ [field]: "APPROVED" }));
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.code).toBe("unrecognized_keys");
    },
  );

  it("rechaza claves extra en ingredientes y nutritionalInfo", () => {
    // Act
    const result = createRecipeSchema.safeParse(
      buildValidInput({
        ingredients: [{ name: "Papa", quantity: 1, unit: "kg", isAdmin: true }],
        nutritionalInfo: { calories: 1, sodiumMg: 10 },
      }),
    );

    // Assert
    expect(result.success).toBe(false);
    const unrecognized = result.error?.issues.filter((issue) => issue.code === "unrecognized_keys");
    expect(unrecognized?.map((issue) => issue.path.map(String).join("."))).toEqual(
      expect.arrayContaining(["ingredients.0", "nutritionalInfo"]),
    );
  });
});
