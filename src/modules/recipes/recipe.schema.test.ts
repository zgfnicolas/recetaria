import { describe, expect, it } from "vitest";
import {
  createRecipeSchema,
  DEFAULT_LIMIT,
  DEFAULT_PAGE,
  DESCRIPTION_MAX_LENGTH,
  listMyRecipesQuerySchema,
  listRecipesQuerySchema,
  recipeIdParamsSchema,
  MAX_INGREDIENTS,
  MAX_LIMIT,
  MAX_NUMERIC_AMOUNT,
  MAX_PAGE,
  MAX_RESULT_WINDOW,
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

describe("listRecipesQuerySchema — paginación y filtros (HU-04)", () => {
  const AUTHOR_V4 = "6f1c2d3e-4b5a-4c6d-8e7f-0123456789ab";

  function queryIssuePaths(input: Record<string, unknown>): string[] {
    const result = listRecipesQuerySchema.safeParse(input);
    if (result.success) {
      return [];
    }
    return result.error.issues.map((issue) => issue.path.map(String).join(".") || issue.code);
  }

  it("aplica defaults page = 1 y limit = 20 sin filtros", () => {
    expect(listRecipesQuerySchema.parse({})).toEqual({ page: DEFAULT_PAGE, limit: DEFAULT_LIMIT });
  });

  it("acepta filtros combinados y convierte page/limit a número", () => {
    // Act
    const result = listRecipesQuerySchema.parse({
      status: "APPROVED",
      difficulty: "EASY",
      authorId: AUTHOR_V4,
      page: "3",
      limit: "50",
    });

    // Assert
    expect(result).toEqual({
      status: "APPROVED",
      difficulty: "EASY",
      authorId: AUTHOR_V4,
      page: 3,
      limit: 50,
    });
  });

  it.each([
    ["limit", "1", 1],
    ["limit", String(MAX_LIMIT), MAX_LIMIT],
    ["page", "1", 1],
  ])("acepta el borde %s = %s", (field, value, expected) => {
    expect(listRecipesQuerySchema.parse({ [field]: value })[field as "page" | "limit"]).toBe(expected);
  });

  it.each([
    [String(MAX_PAGE), "1"],
    ["100", "100"],
    ["500", undefined],
  ])("acepta page = %s con limit = %s dentro de la ventana de 10000 resultados", (page, limit) => {
    expect(
      listRecipesQuerySchema.safeParse(limit === undefined ? { page } : { page, limit }).success,
    ).toBe(true);
  });

  it.each([
    ["101", "100"],
    ["501", undefined],
    [String(MAX_PAGE), "2"],
  ])("rechaza page = %s con limit = %s por superar la ventana de 10000 resultados (OWASP API4)", (page, limit) => {
    // Act
    const result = listRecipesQuerySchema.safeParse(limit === undefined ? { page } : { page, limit });

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ["page"],
        message: `page × limit no puede superar ${String(MAX_RESULT_WINDOW)} resultados`,
      }),
    ]);
  });

  it.each([
    ["limit", "0"],
    ["limit", "101"],
    ["limit", "-1"],
    ["page", "0"],
    ["page", String(MAX_PAGE + 1)],
    ["page", "99999999999999999999"],
    ["page", "1e1"],
    ["page", " 2 "],
    ["page", "2.0"],
    ["page", "0x10"],
    ["page", "02"],
    ["page", ""],
    ["limit", ["10", "20"]],
  ])("rechaza %s = %j (OWASP API4)", (field, value) => {
    expect(queryIssuePaths({ [field]: value })).toContain(field);
  });

  it.each([
    ["status", "PUBLISHED"],
    ["status", "draft"],
    ["status", ""],
    ["status", ["DRAFT", "APPROVED"]],
    ["difficulty", "IMPOSSIBLE"],
    ["authorId", "no-es-uuid"],
    ["authorId", "6f1c2d3e-4b5a-1c6d-8e7f-0123456789ab"],
  ])("rechaza el filtro %s = %j", (field, value) => {
    expect(queryIssuePaths({ [field]: value })).toContain(field);
  });

  it("rechaza parámetros de consulta desconocidos (BOPLA)", () => {
    // Act
    const result = listRecipesQuerySchema.safeParse({ sort: "title", page: "1" });

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ code: "unrecognized_keys", keys: ["sort"] });
  });
});

describe("listMyRecipesQuerySchema — recetas propias (HU-04)", () => {
  it("aplica los defaults page = 1 y limit = 20 y acepta status y difficulty", () => {
    expect(listMyRecipesQuerySchema.parse({})).toEqual({ page: DEFAULT_PAGE, limit: DEFAULT_LIMIT });
    expect(
      listMyRecipesQuerySchema.parse({ status: "APPROVED", difficulty: "EXPERT", page: "2", limit: "100" }),
    ).toEqual({ status: "APPROVED", difficulty: "EXPERT", page: 2, limit: 100 });
  });

  it.each([
    ["authorId", "6f1c2d3e-4b5a-4c6d-8e7f-0123456789ab"],
    ["sort", "title"],
  ])("rechaza el parámetro %s (el alcance lo fija req.user.id, BOLA/BOPLA)", (field, value) => {
    // Act
    const result = listMyRecipesQuerySchema.safeParse({ [field]: value });

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ code: "unrecognized_keys", keys: [field] });
  });

  it.each([
    ["limit", "101"],
    ["page", "0"],
    ["page", "1e1"],
    ["status", "PUBLISHED"],
    ["difficulty", ""],
    ["status", ["DRAFT", "APPROVED"]],
  ])("rechaza %s = %j", (field, value) => {
    const result = listMyRecipesQuerySchema.safeParse({ [field]: value });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain(field);
  });

  it("aplica la ventana page × limit ≤ 10000 (OWASP API4)", () => {
    expect(listMyRecipesQuerySchema.safeParse({ page: "100", limit: "100" }).success).toBe(true);
    const result = listMyRecipesQuerySchema.safeParse({ page: "101", limit: "100" });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ["page"],
        message: `page × limit no puede superar ${String(MAX_RESULT_WINDOW)} resultados`,
      }),
    ]);
  });
});

describe("recipeIdParamsSchema — :id UUID v4 (HU-04)", () => {
  it.each([
    "6f1c2d3e-4b5a-4c6d-8e7f-0123456789ab",
    "6F1C2D3E-4B5A-4C6D-9E7F-0123456789AB",
  ])("acepta el UUID v4 %s", (id) => {
    expect(recipeIdParamsSchema.parse({ id })).toEqual({ id });
  });

  it.each([
    "mine",
    "abc",
    "",
    "6f1c2d3e-4b5a-1c6d-8e7f-0123456789ab",
    "0190f2a1-4b5a-7c6d-8e7f-0123456789ab",
    "6f1c2d3e-4b5a-4c6d-8e7f-0123456789ab0",
    "00000000-0000-0000-0000-000000000000",
  ])("rechaza id = %j con mensaje en el campo id", (id) => {
    // Act
    const result = recipeIdParamsSchema.safeParse({ id });

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ["id"],
      message: "id debe ser un UUID v4 válido",
    });
  });

  it("rechaza claves extra en params (z.strictObject)", () => {
    const result = recipeIdParamsSchema.safeParse({ id: "6f1c2d3e-4b5a-4c6d-8e7f-0123456789ab", x: "1" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ code: "unrecognized_keys", keys: ["x"] });
  });
});
