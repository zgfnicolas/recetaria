import { describe, expect, it, vi } from "vitest";
import { BadRequestError, ConflictError } from "../../shared/errors/app-error.js";
import type {
  CreateRecipeRecordInput,
  IRecipeRepository,
  RecipeRecord,
} from "./recipe.repository.js";
import type { CreateRecipeDTO } from "./recipe.schema.js";
import { BUSINESS_VALIDATION_MESSAGE, RecipeService } from "./recipe.service.js";

const AUTHOR_ID = "11111111-1111-4111-8111-111111111111";
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}$/;

function buildDto(overrides?: Partial<CreateRecipeDTO>): CreateRecipeDTO {
  return {
    title: "Ñoquis de Papá",
    description: "Ñoquis de papa tradicionales del 29.",
    difficulty: "MEDIUM",
    prepTimeMinutes: 45,
    tags: ["casero"],
    ingredients: [{ name: "Papa", quantity: 1, unit: "kg" }],
    ...overrides,
  };
}

function toRecord(input: CreateRecipeRecordInput): RecipeRecord {
  return {
    ...input,
    id: "22222222-2222-4222-8222-222222222222",
    reviewedById: null,
    publishedAt: null,
    createdAt: new Date("2026-11-23T10:00:00.000Z"),
    updatedAt: new Date("2026-11-23T10:00:00.000Z"),
  };
}

function createMockRepository(): {
  readonly repository: IRecipeRepository;
  readonly create: ReturnType<typeof vi.fn<IRecipeRepository["create"]>>;
} {
  const create = vi
    .fn<IRecipeRepository["create"]>()
    .mockImplementation((input) => Promise.resolve(toRecord(input)));
  const findBySlug = vi.fn<IRecipeRepository["findBySlug"]>().mockResolvedValue(null);
  return { repository: { create, findBySlug }, create };
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err: unknown) {
    return err;
  }
  throw new Error("Se esperaba que la promesa fuera rechazada");
}

describe("RecipeService.create — RN-01 (DRAFT, autoría y slug)", () => {
  it("fija status DRAFT, authorId del actor autenticado y slug normalizado con sufijo hex", async () => {
    // Arrange
    const { repository, create } = createMockRepository();
    const service = new RecipeService(repository);

    // Act
    const recipe = await service.create(AUTHOR_ID, buildDto());

    // Assert
    expect(create).toHaveBeenCalledTimes(1);
    const input = create.mock.calls[0]?.[0];
    expect(input?.status).toBe("DRAFT");
    expect(input?.authorId).toBe(AUTHOR_ID);
    expect(input?.slug).toMatch(SLUG_PATTERN);
    expect(input?.slug.startsWith("noquis-de-papa-")).toBe(true);
    expect(recipe.status).toBe("DRAFT");
    expect(recipe.authorId).toBe(AUTHOR_ID);
  });

  it("normaliza a null los opcionales ausentes y propaga los presentes sin alterarlos", async () => {
    // Arrange
    const { repository, create } = createMockRepository();
    const service = new RecipeService(repository, { generateSlug: () => "slug-fijo-0a1b2c3d" });

    // Act
    await service.create(AUTHOR_ID, buildDto());
    await service.create(
      AUTHOR_ID,
      buildDto({
        nutritionalInfo: { calories: 300, servings: 2 },
        coverImageUrl: "https://cdn.recetaria.com/a.jpg",
        videoUrl: "https://cdn.recetaria.com/a.mp4",
      }),
    );

    // Assert
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      slug: "slug-fijo-0a1b2c3d",
      nutritionalInfo: null,
      coverImageUrl: null,
      videoUrl: null,
    });
    expect(create.mock.calls[1]?.[0]).toMatchObject({
      nutritionalInfo: { calories: 300, servings: 2 },
      coverImageUrl: "https://cdn.recetaria.com/a.jpg",
      videoUrl: "https://cdn.recetaria.com/a.mp4",
    });
  });

  it("genera slugs ≤ 200 caracteres para títulos largos y distintos en cada alta", async () => {
    // Arrange
    const { repository, create } = createMockRepository();
    const service = new RecipeService(repository);
    const dto = buildDto({ title: "Á".repeat(150) });

    // Act
    await service.create(AUTHOR_ID, dto);
    await service.create(AUTHOR_ID, dto);

    // Assert
    const [first, second] = create.mock.calls.map((call) => call[0].slug);
    expect(first?.length).toBeLessThanOrEqual(200);
    expect(first?.startsWith("a".repeat(150))).toBe(true);
    expect(first).not.toBe(second);
  });
});

describe("RecipeService.create — RN-07 (validaciones de dominio)", () => {
  it.each([1, 1440])("acepta el borde prepTimeMinutes = %d", async (prepTimeMinutes) => {
    // Arrange
    const { repository, create } = createMockRepository();
    const service = new RecipeService(repository);

    // Act
    await service.create(AUTHOR_ID, buildDto({ prepTimeMinutes }));

    // Assert
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each([0, -5, 1441, 12.5])(
    "rechaza prepTimeMinutes = %d con 400 sin tocar el repositorio (RN-07)",
    async (prepTimeMinutes) => {
      // Arrange
      const { repository, create } = createMockRepository();
      const service = new RecipeService(repository);

      // Act
      const err = await captureError(service.create(AUTHOR_ID, buildDto({ prepTimeMinutes })));

      // Assert
      expect(err).toBeInstanceOf(BadRequestError);
      expect(err).toMatchObject({
        statusCode: 400,
        message: BUSINESS_VALIDATION_MESSAGE,
        errors: [{ field: "prepTimeMinutes" }],
      });
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("acumula todos los incumplimientos de prepTimeMinutes e ingredients[].quantity en un único 400 (RN-07)", async () => {
    // Arrange
    const { repository, create } = createMockRepository();
    const service = new RecipeService(repository);
    const dto = buildDto({
      prepTimeMinutes: 0,
      ingredients: [
        { name: "Papa", quantity: 1, unit: "kg" },
        { name: "Sal", quantity: 0, unit: "g" },
        { name: "Harina", quantity: -3, unit: "g" },
      ],
    });

    // Act
    const err = await captureError(service.create(AUTHOR_ID, dto));

    // Assert
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toMatchObject({
      errors: [
        { field: "prepTimeMinutes" },
        { field: "ingredients.1.quantity", message: "La cantidad del ingrediente debe ser mayor a 0" },
        { field: "ingredients.2.quantity", message: "La cantidad del ingrediente debe ser mayor a 0" },
      ],
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("rechaza una lista de ingredientes vacía aunque haya eludido el borde (RN-07)", async () => {
    // Arrange
    const { repository, create } = createMockRepository();
    const service = new RecipeService(repository);

    // Act
    const err = await captureError(service.create(AUTHOR_ID, buildDto({ ingredients: [] })));

    // Assert
    expect(err).toMatchObject({ statusCode: 400, errors: [{ field: "ingredients" }] });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("RecipeService.create — propagación de errores del repositorio", () => {
  it("propaga ConflictError 409 ante colisión de slug", async () => {
    // Arrange
    const { repository, create } = createMockRepository();
    const conflict = new ConflictError("Ya existe una receta con ese slug");
    create.mockRejectedValueOnce(conflict);
    const service = new RecipeService(repository);

    // Act
    const err = await captureError(service.create(AUTHOR_ID, buildDto()));

    // Assert
    expect(err).toBe(conflict);
  });

  it("propaga errores inesperados sin envolverlos", async () => {
    // Arrange
    const { repository, create } = createMockRepository();
    const failure = new Error("conexión perdida");
    create.mockRejectedValueOnce(failure);
    const service = new RecipeService(repository);

    // Act
    const err = await captureError(service.create(AUTHOR_ID, buildDto()));

    // Assert
    expect(err).toBe(failure);
  });
});
