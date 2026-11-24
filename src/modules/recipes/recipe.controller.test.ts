import express, { type Request } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Actor } from "../auth/index.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
} from "../../shared/errors/app-error.js";
import { RecipeController } from "./recipe.controller.js";
import type { PaginatedRecipes, RecipeRecord } from "./recipe.repository.js";
import type {
  CreateRecipeDTO,
  ListMyRecipesQueryDTO,
  ListRecipesQueryDTO,
} from "./recipe.schema.js";
import type { IRecipeService } from "./recipe.service.js";

const ACTOR: Actor = Object.freeze({ id: "11111111-1111-4111-8111-111111111111", role: "USER" });

const VALID_BODY: CreateRecipeDTO = {
  title: "Ñoquis caseros",
  description: "Ñoquis de papa tradicionales del 29.",
  difficulty: "MEDIUM",
  prepTimeMinutes: 45,
  tags: [],
  ingredients: [{ name: "Papa", quantity: 1, unit: "kg" }],
};

const PERSISTED: RecipeRecord = {
  ...VALID_BODY,
  id: "22222222-2222-4222-8222-222222222222",
  slug: "noquis-caseros-0a1b2c3d",
  status: "DRAFT",
  nutritionalInfo: null,
  coverImageUrl: null,
  videoUrl: null,
  authorId: ACTOR.id,
  reviewedById: null,
  publishedAt: null,
  createdAt: new Date("2026-11-23T10:00:00.000Z"),
  updatedAt: new Date("2026-11-23T10:00:00.000Z"),
};

function createHarness(options: {
  readonly service: IRecipeService;
  readonly user?: Actor | undefined;
  readonly valid?: Request["valid"] | undefined;
}): { readonly app: express.Express; readonly nextErrors: unknown[] } {
  const nextErrors: unknown[] = [];
  const controller = new RecipeController(options.service);
  const app = express();

  app.use(express.json());
  app.use((req, _res, next) => {
    if (options.user !== undefined) {
      req.user = options.user;
    }
    if (options.valid !== undefined) {
      req.valid = options.valid;
    }
    next();
  });
  app.post("/recipes", controller.create);
  app.get("/recipes", controller.list);
  app.get("/recipes/mine", controller.listMine);
  app.get("/recipes/:id", controller.getById);
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      nextErrors.push(err);
      const statusCode =
        typeof err === "object" &&
        err !== null &&
        "statusCode" in err &&
        typeof err.statusCode === "number"
          ? err.statusCode
          : 500;
      res.status(statusCode).json({ delegated: true });
    },
  );

  return { app, nextErrors };
}

function createMockService(): {
  readonly service: IRecipeService;
  readonly create: ReturnType<typeof vi.fn<IRecipeService["create"]>>;
  readonly list: ReturnType<typeof vi.fn<IRecipeService["list"]>>;
  readonly getMine: ReturnType<typeof vi.fn<IRecipeService["getMine"]>>;
  readonly getById: ReturnType<typeof vi.fn<IRecipeService["getById"]>>;
} {
  const create = vi.fn<IRecipeService["create"]>().mockResolvedValue(PERSISTED);
  const list = vi.fn<IRecipeService["list"]>();
  const getMine = vi.fn<IRecipeService["getMine"]>();
  const getById = vi.fn<IRecipeService["getById"]>().mockResolvedValue(PERSISTED);
  return { service: { create, list, getMine, getById }, create, list, getMine, getById };
}

describe("RecipeController.create", () => {
  it("usa req.user.id y req.valid.body (ignorando req.body crudo) y responde 201 JSend", async () => {
    // Arrange
    const { service, create } = createMockService();
    const { app, nextErrors } = createHarness({ service, user: ACTOR, valid: { body: VALID_BODY } });

    // Act
    const res = await request(app)
      .post("/recipes")
      .send({ ...VALID_BODY, status: "APPROVED", authorId: "33333333-3333-4333-8333-333333333333" });

    // Assert
    expect(nextErrors).toEqual([]);
    expect(create).toHaveBeenCalledWith(ACTOR.id, VALID_BODY);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      success: true,
      statusCode: 201,
      message: "Receta creada exitosamente",
      data: JSON.parse(JSON.stringify(PERSISTED)),
    });
  });

  it("falla cerrado con 401 si falta req.user sin invocar al servicio", async () => {
    // Arrange
    const { service, create } = createMockService();
    const { app, nextErrors } = createHarness({ service, valid: { body: VALID_BODY } });

    // Act
    const res = await request(app).post("/recipes").send(VALID_BODY);

    // Assert
    expect(res.status).toBe(401);
    expect(nextErrors[0]).toBeInstanceOf(UnauthorizedError);
    expect(create).not.toHaveBeenCalled();
  });

  it("falla cerrado con 400 si falta req.valid.body sin invocar al servicio", async () => {
    // Arrange
    const { service, create } = createMockService();
    const { app, nextErrors } = createHarness({ service, user: ACTOR });

    // Act
    const res = await request(app).post("/recipes").send(VALID_BODY);

    // Assert
    expect(res.status).toBe(400);
    expect(nextErrors[0]).toBeInstanceOf(BadRequestError);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    new ConflictError("Ya existe una receta con ese slug"),
    new BadRequestError("Error de validación de negocio"),
    new Error("inesperado"),
  ])("delega en next(err) los errores del servicio: %s", async (failure) => {
    // Arrange
    const { service, create } = createMockService();
    create.mockRejectedValueOnce(failure);
    const { app, nextErrors } = createHarness({ service, user: ACTOR, valid: { body: VALID_BODY } });

    // Act
    await request(app).post("/recipes").send(VALID_BODY);

    // Assert
    expect(nextErrors).toEqual([failure]);
  });
});

describe("RecipeController.list", () => {
  const VALID_QUERY: ListRecipesQueryDTO = { status: "DRAFT", page: 1, limit: 20 };
  const PAGE: PaginatedRecipes = {
    items: [PERSISTED],
    meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
  };

  it("usa req.valid.query (ignorando req.query crudo) y responde 200 JSend con items y meta", async () => {
    // Arrange
    const { service, list } = createMockService();
    list.mockResolvedValueOnce(PAGE);
    const { app, nextErrors } = createHarness({ service, valid: { query: VALID_QUERY } });

    // Act
    const res = await request(app).get("/recipes?status=APPROVED&limit=999");

    // Assert
    expect(nextErrors).toEqual([]);
    expect(list).toHaveBeenCalledWith(VALID_QUERY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      statusCode: 200,
      message: "Recetas obtenidas exitosamente",
      data: JSON.parse(JSON.stringify(PAGE)),
    });
  });

  it("no exige req.user (endpoint público)", async () => {
    // Arrange
    const { service, list } = createMockService();
    list.mockResolvedValueOnce(PAGE);
    const { app } = createHarness({ service, valid: { query: VALID_QUERY } });

    // Act
    const res = await request(app).get("/recipes");

    // Assert
    expect(res.status).toBe(200);
  });

  it("falla cerrado con 400 si falta req.valid.query sin invocar al servicio", async () => {
    // Arrange
    const { service, list } = createMockService();
    const { app, nextErrors } = createHarness({ service });

    // Act
    const res = await request(app).get("/recipes");

    // Assert
    expect(res.status).toBe(400);
    expect(nextErrors[0]).toBeInstanceOf(BadRequestError);
    expect(list).not.toHaveBeenCalled();
  });

  it("delega en next(err) los errores del servicio", async () => {
    // Arrange
    const { service, list } = createMockService();
    const failure = new Error("inesperado");
    list.mockRejectedValueOnce(failure);
    const { app, nextErrors } = createHarness({ service, valid: { query: VALID_QUERY } });

    // Act
    await request(app).get("/recipes");

    // Assert
    expect(nextErrors).toEqual([failure]);
  });
});

describe("RecipeController.listMine", () => {
  const VALID_QUERY: ListMyRecipesQueryDTO = { difficulty: "EASY", page: 2, limit: 5 };
  const PAGE: PaginatedRecipes = {
    items: [PERSISTED],
    meta: { page: 2, limit: 5, total: 6, totalPages: 2 },
  };

  it("usa req.user.id y req.valid.query (ignorando req.query crudo) y responde 200 JSend", async () => {
    // Arrange
    const { service, getMine } = createMockService();
    getMine.mockResolvedValueOnce(PAGE);
    const { app, nextErrors } = createHarness({ service, user: ACTOR, valid: { query: VALID_QUERY } });

    // Act
    const res = await request(app).get(
      "/recipes/mine?authorId=33333333-3333-4333-8333-333333333333",
    );

    // Assert
    expect(nextErrors).toEqual([]);
    expect(getMine).toHaveBeenCalledWith(ACTOR.id, VALID_QUERY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      statusCode: 200,
      message: "Recetas propias obtenidas exitosamente",
      data: JSON.parse(JSON.stringify(PAGE)),
    });
  });

  it("falla cerrado con 401 si falta req.user sin invocar al servicio", async () => {
    // Arrange
    const { service, getMine } = createMockService();
    const { app, nextErrors } = createHarness({ service, valid: { query: VALID_QUERY } });

    // Act
    const res = await request(app).get("/recipes/mine");

    // Assert
    expect(res.status).toBe(401);
    expect(nextErrors[0]).toBeInstanceOf(UnauthorizedError);
    expect(getMine).not.toHaveBeenCalled();
  });

  it("falla cerrado con 400 si falta req.valid.query sin invocar al servicio", async () => {
    // Arrange
    const { service, getMine } = createMockService();
    const { app, nextErrors } = createHarness({ service, user: ACTOR });

    // Act
    const res = await request(app).get("/recipes/mine");

    // Assert
    expect(res.status).toBe(400);
    expect(nextErrors[0]).toBeInstanceOf(BadRequestError);
    expect(getMine).not.toHaveBeenCalled();
  });

  it("delega en next(err) los errores del servicio", async () => {
    // Arrange
    const { service, getMine } = createMockService();
    const failure = new Error("inesperado");
    getMine.mockRejectedValueOnce(failure);
    const { app, nextErrors } = createHarness({ service, user: ACTOR, valid: { query: VALID_QUERY } });

    // Act
    await request(app).get("/recipes/mine");

    // Assert
    expect(nextErrors).toEqual([failure]);
  });
});

describe("RecipeController.getById", () => {
  it("usa req.valid.params.id (ignorando req.params crudo) y responde 200 JSend sin exigir req.user", async () => {
    // Arrange
    const { service, getById } = createMockService();
    const { app, nextErrors } = createHarness({ service, valid: { params: { id: PERSISTED.id } } });

    // Act
    const res = await request(app).get("/recipes/no-es-el-id-validado");

    // Assert
    expect(nextErrors).toEqual([]);
    expect(getById).toHaveBeenCalledWith(PERSISTED.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      statusCode: 200,
      message: "Receta obtenida exitosamente",
      data: JSON.parse(JSON.stringify(PERSISTED)),
    });
  });

  it("falla cerrado con 400 si falta req.valid.params sin invocar al servicio", async () => {
    // Arrange
    const { service, getById } = createMockService();
    const { app, nextErrors } = createHarness({ service });

    // Act
    const res = await request(app).get(`/recipes/${PERSISTED.id}`);

    // Assert
    expect(res.status).toBe(400);
    expect(nextErrors[0]).toBeInstanceOf(BadRequestError);
    expect(getById).not.toHaveBeenCalled();
  });

  it.each([new NotFoundError("Receta no encontrada"), new Error("inesperado")])(
    "delega en next(err) los errores del servicio: %s",
    async (failure) => {
      // Arrange
      const { service, getById } = createMockService();
      getById.mockRejectedValueOnce(failure);
      const { app, nextErrors } = createHarness({ service, valid: { params: { id: PERSISTED.id } } });

      // Act
      await request(app).get(`/recipes/${PERSISTED.id}`);

      // Assert
      expect(nextErrors).toEqual([failure]);
    },
  );
});
