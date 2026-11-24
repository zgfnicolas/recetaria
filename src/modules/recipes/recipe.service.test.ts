import { describe, expect, it, vi } from "vitest";
import type { Actor } from "../auth/index.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../shared/errors/app-error.js";
import type {
  CreateRecipeRecordInput,
  IRecipeRepository,
  PaginatedRecipes,
  RecipeRecord,
} from "./recipe.repository.js";
import type { CreateRecipeDTO, ListMyRecipesQueryDTO } from "./recipe.schema.js";
import {
  BUSINESS_VALIDATION_MESSAGE,
  RECIPE_ALREADY_APPROVED_MESSAGE,
  RECIPE_APPROVAL_FORBIDDEN_MESSAGE,
  RECIPE_EDIT_FORBIDDEN_MESSAGE,
  RECIPE_NOT_FOUND_MESSAGE,
  RecipeService,
} from "./recipe.service.js";

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
  readonly findManyPaginated: ReturnType<typeof vi.fn<IRecipeRepository["findManyPaginated"]>>;
  readonly findById: ReturnType<typeof vi.fn<IRecipeRepository["findById"]>>;
  readonly approveWithAudit: ReturnType<typeof vi.fn<IRecipeRepository["approveWithAudit"]>>;
  readonly updateWithOptionalReset: ReturnType<
    typeof vi.fn<IRecipeRepository["updateWithOptionalReset"]>
  >;
} {
  const create = vi
    .fn<IRecipeRepository["create"]>()
    .mockImplementation((input) => Promise.resolve(toRecord(input)));
  const findBySlug = vi.fn<IRecipeRepository["findBySlug"]>().mockResolvedValue(null);
  const findManyPaginated = vi.fn<IRecipeRepository["findManyPaginated"]>();
  const findById = vi.fn<IRecipeRepository["findById"]>().mockResolvedValue(null);
  const approveWithAudit = vi.fn<IRecipeRepository["approveWithAudit"]>();
  const updateWithOptionalReset = vi.fn<IRecipeRepository["updateWithOptionalReset"]>();
  return {
    repository: {
      create,
      findById,
      findBySlug,
      findManyPaginated,
      approveWithAudit,
      updateWithOptionalReset,
    },
    create,
    findManyPaginated,
    findById,
    approveWithAudit,
    updateWithOptionalReset,
  };
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

describe("RecipeService.list — catálogo paginado (HU-04)", () => {
  it("delega en findManyPaginated los filtros, la página y el límite validados y devuelve su resultado", async () => {
    // Arrange
    const { repository, findManyPaginated } = createMockRepository();
    const page: PaginatedRecipes = {
      items: [toRecord({ ...buildRecordInput(), status: "APPROVED" })],
      meta: { page: 2, limit: 5, total: 6, totalPages: 2 },
    };
    findManyPaginated.mockResolvedValueOnce(page);
    const service = new RecipeService(repository);

    // Act
    const result = await service.list({
      status: "APPROVED",
      difficulty: "EASY",
      authorId: AUTHOR_ID,
      page: 2,
      limit: 5,
    });

    // Assert
    expect(findManyPaginated).toHaveBeenCalledWith({
      filters: { status: "APPROVED", difficulty: "EASY", authorId: AUTHOR_ID },
      page: 2,
      limit: 5,
    });
    expect(result).toBe(page);
  });

  it("no agrega filtros de visibilidad: sin filtros el catálogo incluye DRAFT y APPROVED", async () => {
    // Arrange
    const { repository, findManyPaginated } = createMockRepository();
    findManyPaginated.mockResolvedValueOnce({
      items: [],
      meta: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
    const service = new RecipeService(repository);

    // Act
    await service.list({ page: 1, limit: 20 });

    // Assert
    expect(findManyPaginated).toHaveBeenCalledWith({
      filters: { status: undefined, difficulty: undefined, authorId: undefined },
      page: 1,
      limit: 20,
    });
  });

  it("propaga errores del repositorio sin envolverlos", async () => {
    // Arrange
    const { repository, findManyPaginated } = createMockRepository();
    const failure = new Error("timeout");
    findManyPaginated.mockRejectedValueOnce(failure);
    const service = new RecipeService(repository);

    // Act
    const err = await captureError(service.list({ page: 1, limit: 20 }));

    // Assert
    expect(err).toBe(failure);
  });
});

const OTHER_AUTHOR_ID = "33333333-3333-4333-8333-333333333333";
const RECIPE_ID = "22222222-2222-4222-8222-222222222222";
const EMPTY_PAGE: PaginatedRecipes = {
  items: [],
  meta: { page: 1, limit: 20, total: 0, totalPages: 0 },
};

describe("RecipeService.getMine — recetas propias (HU-04)", () => {
  it("fuerza authorId al actor autenticado y delega filtros, página y límite", async () => {
    // Arrange
    const { repository, findManyPaginated } = createMockRepository();
    findManyPaginated.mockResolvedValueOnce(EMPTY_PAGE);
    const service = new RecipeService(repository);

    // Act
    const result = await service.getMine(AUTHOR_ID, {
      status: "APPROVED",
      difficulty: "HARD",
      page: 3,
      limit: 10,
    });

    // Assert
    expect(findManyPaginated).toHaveBeenCalledWith({
      filters: { status: "APPROVED", difficulty: "HARD", authorId: AUTHOR_ID },
      page: 3,
      limit: 10,
    });
    expect(result).toBe(EMPTY_PAGE);
  });

  it("ignora un authorId ajeno colado en la query: el alcance es siempre el del actor", async () => {
    // Arrange
    const { repository, findManyPaginated } = createMockRepository();
    findManyPaginated.mockResolvedValueOnce(EMPTY_PAGE);
    const service = new RecipeService(repository);
    // Intencional: TypeScript solo chequea propiedades de más en literales, no en una variable
    // intermedia. Así se simula, sin casts, un `authorId` colado que eludió el borde Zod.
    const smuggled = { page: 1, limit: 20, authorId: OTHER_AUTHOR_ID };
    const query: ListMyRecipesQueryDTO = smuggled;

    // Act
    await service.getMine(AUTHOR_ID, query);

    // Assert
    expect(findManyPaginated).toHaveBeenCalledTimes(1);
    expect(findManyPaginated.mock.calls[0]?.[0].filters.authorId).toBe(AUTHOR_ID);
    expect(findManyPaginated).toHaveBeenCalledWith({
      filters: { status: undefined, difficulty: undefined, authorId: AUTHOR_ID },
      page: 1,
      limit: 20,
    });
  });

  it("propaga errores del repositorio sin envolverlos", async () => {
    // Arrange
    const { repository, findManyPaginated } = createMockRepository();
    const failure = new Error("timeout");
    findManyPaginated.mockRejectedValueOnce(failure);
    const service = new RecipeService(repository);

    // Act
    const err = await captureError(service.getMine(AUTHOR_ID, { page: 1, limit: 20 }));

    // Assert
    expect(err).toBe(failure);
  });
});

describe("RecipeService.getById — detalle público (HU-04)", () => {
  it("devuelve la Receta encontrada por id", async () => {
    // Arrange
    const { repository, findById } = createMockRepository();
    const recipe = toRecord(buildRecordInput());
    findById.mockResolvedValueOnce(recipe);
    const service = new RecipeService(repository);

    // Act
    const result = await service.getById(RECIPE_ID);

    // Assert
    expect(findById).toHaveBeenCalledWith(RECIPE_ID);
    expect(result).toBe(recipe);
  });

  it("lanza NotFoundError 404 cuando el repositorio devuelve null", async () => {
    // Arrange
    const { repository, findById } = createMockRepository();
    findById.mockResolvedValueOnce(null);
    const service = new RecipeService(repository);

    // Act
    const err = await captureError(service.getById(RECIPE_ID));

    // Assert
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toMatchObject({ statusCode: 404, message: RECIPE_NOT_FOUND_MESSAGE });
  });

  it("propaga errores inesperados del repositorio sin envolverlos", async () => {
    // Arrange
    const { repository, findById } = createMockRepository();
    const failure = new Error("timeout");
    findById.mockRejectedValueOnce(failure);
    const service = new RecipeService(repository);

    // Act
    const err = await captureError(service.getById(RECIPE_ID));

    // Assert
    expect(err).toBe(failure);
  });
});

describe("RecipeService.approve — Aprobación profesional (HU-07, RN-04, RN-05)", () => {
  const CHEF: Actor = { id: "44444444-4444-4444-8444-444444444444", role: "CHEF" };
  const draft = (): RecipeRecord => toRecord(buildRecordInput());
  const approvedBy = (reviewerId: string): RecipeRecord => ({
    ...draft(),
    status: "APPROVED",
    reviewedById: reviewerId,
    publishedAt: new Date("2026-11-24T10:00:00.000Z"),
  });

  it("aprueba una receta DRAFT ajena delegando recipeId y reviewerId del actor", async () => {
    // Arrange
    const { repository, findById, approveWithAudit } = createMockRepository();
    findById.mockResolvedValueOnce(draft());
    const approved = approvedBy(CHEF.id);
    approveWithAudit.mockResolvedValueOnce({ outcome: "approved", recipe: approved });
    const service = new RecipeService(repository);

    // Act
    const result = await service.approve(CHEF, RECIPE_ID);

    // Assert
    expect(findById).toHaveBeenCalledWith(RECIPE_ID);
    expect(approveWithAudit).toHaveBeenCalledWith({ recipeId: RECIPE_ID, reviewerId: CHEF.id });
    expect(result).toBe(approved);
  });

  it("acepta también a un NUTRITIONIST y delega su id como revisor", async () => {
    // Arrange
    const nutritionist: Actor = { id: "66666666-6666-4666-8666-666666666666", role: "NUTRITIONIST" };
    const { repository, findById, approveWithAudit } = createMockRepository();
    findById.mockResolvedValueOnce(draft());
    const approved = approvedBy(nutritionist.id);
    approveWithAudit.mockResolvedValueOnce({ outcome: "approved", recipe: approved });
    const service = new RecipeService(repository);

    // Act
    const result = await service.approve(nutritionist, RECIPE_ID);

    // Assert
    expect(approveWithAudit).toHaveBeenCalledWith({ recipeId: RECIPE_ID, reviewerId: nutritionist.id });
    expect(result).toBe(approved);
  });

  it("lanza NotFoundError 404 si la receta no existe, sin escribir", async () => {
    // Arrange
    const { repository, approveWithAudit } = createMockRepository();
    const service = new RecipeService(repository);

    // Act
    const err = await captureError(service.approve(CHEF, RECIPE_ID));

    // Assert
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toMatchObject({ statusCode: 404, message: RECIPE_NOT_FOUND_MESSAGE });
    expect(approveWithAudit).not.toHaveBeenCalled();
  });

  it.each([
    ["auto-aprobación de un CHEF (RN-05)", { id: AUTHOR_ID, role: "CHEF" } satisfies Actor],
    ["auto-aprobación de un NUTRITIONIST (RN-05)", { id: AUTHOR_ID, role: "NUTRITIONIST" } satisfies Actor],
    ["USER sin rol profesional (RN-04, defensa en profundidad)", { id: CHEF.id, role: "USER" } satisfies Actor],
    ["ADMIN sin rol profesional (RN-04, defensa en profundidad)", { id: CHEF.id, role: "ADMIN" } satisfies Actor],
  ])("lanza ForbiddenError 403 por %s, sin escribir", async (_label, actor) => {
    // Arrange
    const { repository, findById, approveWithAudit } = createMockRepository();
    findById.mockResolvedValueOnce(draft());
    const service = new RecipeService(repository);

    // Act
    const err = await captureError(service.approve(actor, RECIPE_ID));

    // Assert
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err).toMatchObject({ statusCode: 403, message: RECIPE_APPROVAL_FORBIDDEN_MESSAGE });
    expect(approveWithAudit).not.toHaveBeenCalled();
  });

  it("prioriza 403 sobre 409: el Autor no puede aprobar su receta aunque ya esté APPROVED", async () => {
    // Arrange
    const { repository, findById } = createMockRepository();
    findById.mockResolvedValueOnce(approvedBy(CHEF.id));
    const service = new RecipeService(repository);

    // Act
    const err = await captureError(service.approve({ id: AUTHOR_ID, role: "CHEF" }, RECIPE_ID));

    // Assert
    expect(err).toBeInstanceOf(ForbiddenError);
  });

  it("lanza ConflictError 409 si la receta ya está APPROVED, sin escribir (RN-04)", async () => {
    // Arrange
    const { repository, findById, approveWithAudit } = createMockRepository();
    findById.mockResolvedValueOnce(approvedBy("55555555-5555-4555-8555-555555555555"));
    const service = new RecipeService(repository);

    // Act
    const err = await captureError(service.approve(CHEF, RECIPE_ID));

    // Assert
    expect(err).toBeInstanceOf(ConflictError);
    expect(err).toMatchObject({ statusCode: 409, message: RECIPE_ALREADY_APPROVED_MESSAGE });
    expect(approveWithAudit).not.toHaveBeenCalled();
  });

  it("lanza ConflictError 409 si la transacción encuentra la receta ya aprobada (aprobación concurrente)", async () => {
    // Arrange
    const { repository, findById, approveWithAudit } = createMockRepository();
    findById.mockResolvedValueOnce(draft());
    approveWithAudit.mockResolvedValueOnce({ outcome: "already_approved" });
    const service = new RecipeService(repository);

    // Act
    const err = await captureError(service.approve(CHEF, RECIPE_ID));

    // Assert
    expect(err).toBeInstanceOf(ConflictError);
    expect(err).toMatchObject({ statusCode: 409, message: RECIPE_ALREADY_APPROVED_MESSAGE });
  });

  it("lanza NotFoundError 404 si la transacción ya no encuentra la receta (borrado concurrente)", async () => {
    // Arrange
    const { repository, findById, approveWithAudit } = createMockRepository();
    findById.mockResolvedValueOnce(draft());
    approveWithAudit.mockResolvedValueOnce({ outcome: "not_found" });
    const service = new RecipeService(repository);

    // Act
    const err = await captureError(service.approve(CHEF, RECIPE_ID));

    // Assert
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toMatchObject({ statusCode: 404, message: RECIPE_NOT_FOUND_MESSAGE });
  });

  it("propaga errores del repositorio sin envolverlos", async () => {
    // Arrange
    const { repository, findById, approveWithAudit } = createMockRepository();
    findById.mockResolvedValueOnce(draft());
    const failure = new Error("timeout");
    approveWithAudit.mockRejectedValueOnce(failure);
    const service = new RecipeService(repository);

    // Act
    const err = await captureError(service.approve(CHEF, RECIPE_ID));

    // Assert
    expect(err).toBe(failure);
  });
});

describe("RecipeService.update — Edición por el Autor (HU-05, RN-02, RN-07)", () => {
  const AUTHOR: Actor = { id: AUTHOR_ID, role: "USER" };
  const existing = (): RecipeRecord => toRecord(buildRecordInput());
  const fixedSlug = () => "slug-regenerado-0a1b2c3d";

  function arrange(): ReturnType<typeof createMockRepository> & { readonly service: RecipeService } {
    const mocks = createMockRepository();
    mocks.findById.mockResolvedValue(existing());
    mocks.updateWithOptionalReset.mockImplementation(({ changes }) =>
      Promise.resolve({
        outcome: "updated",
        recipe: { ...existing(), ...changes },
        resetToDraft: false,
      }),
    );
    return { ...mocks, service: new RecipeService(mocks.repository, { generateSlug: fixedSlug }) };
  }

  it("delega solo los campos presentes, sin regenerar slug si no llega title", async () => {
    // Arrange
    const { service, updateWithOptionalReset } = arrange();

    // Act
    await service.update(AUTHOR, RECIPE_ID, { prepTimeMinutes: 25, coverImageUrl: null });

    // Assert
    expect(updateWithOptionalReset).toHaveBeenCalledWith({
      recipeId: RECIPE_ID,
      actorId: AUTHOR_ID,
      changes: { prepTimeMinutes: 25, coverImageUrl: null },
    });
  });

  it("regenera el slug solo cuando llega title", async () => {
    // Arrange
    const generateSlug = vi.fn(fixedSlug);
    const mocks = createMockRepository();
    mocks.findById.mockResolvedValue(existing());
    mocks.updateWithOptionalReset.mockResolvedValue({
      outcome: "updated",
      recipe: existing(),
      resetToDraft: false,
    });
    const service = new RecipeService(mocks.repository, { generateSlug });

    // Act
    await service.update(AUTHOR, RECIPE_ID, { title: "Nuevo título" });

    // Assert
    expect(generateSlug).toHaveBeenCalledWith("Nuevo título");
    expect(mocks.updateWithOptionalReset).toHaveBeenCalledWith(
      expect.objectContaining({ changes: { title: "Nuevo título", slug: "slug-regenerado-0a1b2c3d" } }),
    );
  });

  it("no decide el reinicio: delega igual aunque su lectura previa diga APPROVED y devuelve lo del repositorio", async () => {
    // Arrange — la decisión RESET_TO_DRAFT es del repositorio sobre la fila bloqueada
    const { service, findById, updateWithOptionalReset } = arrange();
    findById.mockResolvedValueOnce({ ...existing(), status: "APPROVED", reviewedById: "r", publishedAt: new Date() });
    const reset: RecipeRecord = { ...existing(), status: "DRAFT", reviewedById: null, publishedAt: null };
    updateWithOptionalReset.mockResolvedValueOnce({ outcome: "updated", recipe: reset, resetToDraft: true });

    // Act
    const result = await service.update(AUTHOR, RECIPE_ID, { description: "Descripción nueva y larga." });

    // Assert
    expect(updateWithOptionalReset).toHaveBeenCalledWith({
      recipeId: RECIPE_ID,
      actorId: AUTHOR_ID,
      changes: { description: "Descripción nueva y larga." },
    });
    expect(result).toBe(reset);
  });

  it("lanza NotFoundError 404 si la receta no existe, sin escribir", async () => {
    // Arrange
    const { service, findById, updateWithOptionalReset } = arrange();
    findById.mockResolvedValueOnce(null);

    // Act
    const err = await captureError(service.update(AUTHOR, RECIPE_ID, { title: "Nuevo título" }));

    // Assert
    expect(err).toBeInstanceOf(NotFoundError);
    expect(updateWithOptionalReset).not.toHaveBeenCalled();
  });

  it("lanza NotFoundError 404 si la transacción ya no encuentra la receta (borrado concurrente)", async () => {
    // Arrange
    const { service, updateWithOptionalReset } = arrange();
    updateWithOptionalReset.mockResolvedValueOnce({ outcome: "not_found" });

    // Act
    const err = await captureError(service.update(AUTHOR, RECIPE_ID, { title: "Nuevo título" }));

    // Assert
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toMatchObject({ message: RECIPE_NOT_FOUND_MESSAGE });
  });

  it.each([
    ["otro USER", { id: "77777777-7777-4777-8777-777777777777", role: "USER" } satisfies Actor],
    ["un ADMIN", { id: "77777777-7777-4777-8777-777777777777", role: "ADMIN" } satisfies Actor],
    ["un CHEF ajeno", { id: "77777777-7777-4777-8777-777777777777", role: "CHEF" } satisfies Actor],
  ])("lanza ForbiddenError 403 si edita %s (RN-02), sin escribir", async (_label, actor) => {
    // Arrange
    const { service, updateWithOptionalReset } = arrange();

    // Act
    const err = await captureError(service.update(actor, RECIPE_ID, { title: "Nuevo título" }));

    // Assert
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err).toMatchObject({ statusCode: 403, message: RECIPE_EDIT_FORBIDDEN_MESSAGE });
    expect(updateWithOptionalReset).not.toHaveBeenCalled();
  });

  it("acumula los incumplimientos RN-07 de los campos presentes en un único 400, sin escribir", async () => {
    // Arrange
    const { service, updateWithOptionalReset } = arrange();

    // Act
    const err = await captureError(
      service.update(AUTHOR, RECIPE_ID, {
        prepTimeMinutes: 1441,
        ingredients: [
          { name: "Sal", quantity: 0, unit: "g" },
          { name: "Agua", quantity: -1, unit: "ml" },
        ],
      }),
    );

    // Assert
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toMatchObject({
      statusCode: 400,
      message: BUSINESS_VALIDATION_MESSAGE,
      errors: [
        expect.objectContaining({ field: "prepTimeMinutes" }),
        expect.objectContaining({ field: "ingredients.0.quantity" }),
        expect.objectContaining({ field: "ingredients.1.quantity" }),
      ],
    });
    expect(updateWithOptionalReset).not.toHaveBeenCalled();
  });

  it.each([
    [{ prepTimeMinutes: 0 }, "prepTimeMinutes"],
    [{ ingredients: [] }, "ingredients"],
  ])("rechaza %j (RN-07)", async (dto, field) => {
    // Arrange
    const { service } = arrange();

    // Act
    const err = await captureError(service.update(AUTHOR, RECIPE_ID, dto));

    // Assert
    expect(err).toMatchObject({ statusCode: 400, errors: [expect.objectContaining({ field })] });
  });

  it("no valida RN-07 sobre campos ausentes (edición solo de título)", async () => {
    // Arrange
    const { service, updateWithOptionalReset } = arrange();

    // Act
    await service.update(AUTHOR, RECIPE_ID, { title: "Nuevo título" });

    // Assert — sin prepTimeMinutes ni ingredients en el payload, nada que validar ni enviar
    expect(updateWithOptionalReset).toHaveBeenCalledWith({
      recipeId: RECIPE_ID,
      actorId: AUTHOR_ID,
      changes: { title: "Nuevo título", slug: "slug-regenerado-0a1b2c3d" },
    });
  });

  it("propaga el ConflictError 409 por colisión de slug", async () => {
    // Arrange
    const { service, updateWithOptionalReset } = arrange();
    const conflict = new ConflictError("Ya existe una receta con ese slug");
    updateWithOptionalReset.mockRejectedValueOnce(conflict);

    // Act
    const err = await captureError(service.update(AUTHOR, RECIPE_ID, { title: "Nuevo título" }));

    // Assert
    expect(err).toBe(conflict);
  });
});

function buildRecordInput(): CreateRecipeRecordInput {
  return {
    title: "Ñoquis",
    slug: "noquis-0a1b2c3d",
    description: "Ñoquis de papa tradicionales.",
    difficulty: "EASY",
    status: "DRAFT",
    prepTimeMinutes: 30,
    tags: [],
    ingredients: [{ name: "Papa", quantity: 1, unit: "kg" }],
    nutritionalInfo: null,
    coverImageUrl: null,
    videoUrl: null,
    authorId: AUTHOR_ID,
  };
}
