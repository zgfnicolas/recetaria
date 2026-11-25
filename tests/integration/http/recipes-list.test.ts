import type express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../src/app.js";
import {
  disconnect,
  getDatabase,
  type Database,
} from "../../../src/infrastructure/database/prisma.js";
import { DUMMY_BCRYPT_HASH, type JwtConfig } from "../../../src/modules/auth/index.js";
import {
  calculateTotalPages,
  RECIPE_DIFFICULTIES,
  RecipeRepository,
  type RecipeDifficulty,
  type RecipeStatus,
} from "../../../src/modules/recipes/index.js";
import { truncateAll } from "../../support/database.js";

const TEST_JWT_CONFIG: JwtConfig = {
  secret: "test-jwt-secret-".repeat(3),
  expiresIn: "1h",
};

const AUTHOR_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AUTHOR_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UNKNOWN_AUTHOR = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BASE_TIME = Date.parse("2026-11-01T12:00:00.000Z");
const TOTAL_RECIPES = 25;

type SeededRecipe = Readonly<{
  id: string;
  authorId: string;
  status: RecipeStatus;
  difficulty: RecipeDifficulty;
  createdAt: Date;
}>;

/**
 * 25 recetas con `createdAt` repetido de a 3 (fuerza el desempate por `id DESC`),
 * estados, dificultades y autores alternados. El `id` se deriva de `(i * 7) % 25`
 * (permutación) para que **no** crezca junto con `createdAt`: así un orden solo por `id`,
 * o con las claves invertidas, no coincide con el esperado.
 */
function buildDataset(): SeededRecipe[] {
  return Array.from({ length: TOTAL_RECIPES }, (_, i) => ({
    id: `00000000-0000-4000-8000-${((i * 7) % TOTAL_RECIPES).toString(16).padStart(12, "0")}`,
    authorId: i % 2 === 0 ? AUTHOR_A : AUTHOR_B,
    status: i % 3 === 0 ? "APPROVED" : "DRAFT",
    difficulty: RECIPE_DIFFICULTIES[i % RECIPE_DIFFICULTIES.length] ?? "MEDIUM",
    createdAt: new Date(BASE_TIME + Math.floor(i / 3) * 60_000),
  }));
}

/** Orden esperado `("createdAt" DESC, id DESC)`; uuid en PostgreSQL ordena como su hex en minúsculas. */
function expectedOrder(recipes: readonly SeededRecipe[]): string[] {
  return [...recipes]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
    .map((recipe) => recipe.id);
}

async function truncateTables(db: Database): Promise<void> {
  await truncateAll(db);
}

async function seed(db: Database, recipes: readonly SeededRecipe[]): Promise<void> {
  await db.prisma.user.createMany({
    data: [AUTHOR_A, AUTHOR_B].map((id, index) => ({
      id,
      email: `autor-${String(index)}@recetaria.com`,
      passwordHash: DUMMY_BCRYPT_HASH,
      firstName: "Autor",
      lastName: String(index),
      role: index === 0 ? "USER" : "CHEF",
    })),
  });
  await db.prisma.recipe.createMany({
    data: recipes.map((recipe, i) => ({
      id: recipe.id,
      title: `Receta ${String(i)}`,
      slug: `receta-${String(i)}-0a1b2c3d`,
      description: "Descripción de prueba del catálogo.",
      difficulty: recipe.difficulty,
      status: recipe.status,
      prepTimeMinutes: 30,
      ingredients: [{ name: "Sal", quantity: 1, unit: "g" }],
      authorId: recipe.authorId,
      reviewedById:
        recipe.status === "APPROVED" ? (recipe.authorId === AUTHOR_A ? AUTHOR_B : AUTHOR_A) : null,
      publishedAt: recipe.status === "APPROVED" ? recipe.createdAt : null,
      createdAt: recipe.createdAt,
    })),
  });
}

type ListBody = {
  success: boolean;
  statusCode: number;
  message: string;
  data: {
    items: { id: string; status: string; difficulty: string; authorId: string }[];
    meta: { page: number; limit: number; total: number; totalPages: number };
  };
};

describe("GET /api/v1/recipes — Catálogo público paginado (Integración HTTP + PostgreSQL)", () => {
  let db: Database;
  let app: express.Express;
  const dataset = buildDataset();

  beforeAll(() => {
    db = getDatabase();
    app = buildApp({
      prisma: db.prisma,
      jwt: TEST_JWT_CONFIG,
      // Una sola app para toda la suite: el rate limit (#36) se prueba en recipes-rate-limit.test.ts
      publicRateLimit: false,
      onLog: () => undefined,
      onError: () => undefined,
    });
  });

  beforeEach(async () => {
    await truncateTables(db);
    await seed(db, dataset);
  });

  afterEach(async () => {
    await truncateTables(db);
  });

  afterAll(async () => {
    await disconnect();
  });

  describe("200 OK", () => {
    it("lista sin token con defaults page=1/limit=20, DRAFT y APPROVED y orden determinístico", async () => {
      // Act
      const res = await request(app).get("/api/v1/recipes");

      // Assert
      const body = res.body as ListBody;
      expect(res.status).toBe(200);
      expect(body).toMatchObject({
        success: true,
        statusCode: 200,
        message: "Recetas obtenidas exitosamente",
        data: { meta: { page: 1, limit: 20, total: TOTAL_RECIPES, totalPages: 2 } },
      });
      expect(body.data.items.map((item) => item.id)).toEqual(expectedOrder(dataset).slice(0, 20));
      expect(new Set(body.data.items.map((item) => item.status))).toEqual(
        new Set(["DRAFT", "APPROVED"]),
      );
      expect(Object.keys(body.data.items[0] ?? {}).sort()).toEqual(
        [
          "authorId",
          "coverImageUrl",
          "createdAt",
          "description",
          "difficulty",
          "id",
          "ingredients",
          "nutritionalInfo",
          "prepTimeMinutes",
          "publishedAt",
          "reviewedById",
          "slug",
          "status",
          "tags",
          "title",
          "updatedAt",
          "videoUrl",
        ].sort(),
      );
    });

    it("el orden esperado no equivale a ordenar solo por id ni con las claves invertidas (dataset no tautológico)", async () => {
      // Arrange
      const idOnlyDesc = [...dataset].map((r) => r.id).sort().reverse();

      // Act
      const res = await request(app).get(`/api/v1/recipes?limit=${String(TOTAL_RECIPES)}`);

      // Assert
      const ids = (res.body as ListBody).data.items.map((item) => item.id);
      expect(ids).toEqual(expectedOrder(dataset));
      expect(ids).not.toEqual(idOnlyDesc);
    });

    it("aplica los filtros en el where de Prisma (count y findMany) con orden, skip y take, sin filtrar en memoria", async () => {
      // Arrange
      const countSpy = vi.spyOn(db.prisma.recipe, "count");
      const findManySpy = vi.spyOn(db.prisma.recipe, "findMany");

      // Act
      const res = await request(app).get(
        `/api/v1/recipes?status=DRAFT&authorId=${AUTHOR_B}&page=2&limit=3`,
      );

      // Assert
      expect(res.status).toBe(200);
      const expectedWhere = { status: "DRAFT", authorId: AUTHOR_B };
      expect(countSpy).toHaveBeenCalledWith({ where: expectedWhere });
      expect(findManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expectedWhere,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: 3,
          take: 3,
        }),
      );
      const findManyArgs = findManySpy.mock.calls[0]?.[0];
      expect(findManyArgs?.where).not.toHaveProperty("difficulty");
    });

    it("acepta un token válido igual que sin token (sin o con token, HU-04)", async () => {
      // Arrange
      const token = jwt.sign({ id: AUTHOR_A, role: "USER" }, TEST_JWT_CONFIG.secret, {
        algorithm: "HS256",
        expiresIn: "1h",
      });

      // Act
      const withToken = await request(app).get("/api/v1/recipes").set("Authorization", `Bearer ${token}`);
      const withoutToken = await request(app).get("/api/v1/recipes");

      // Assert
      expect(withToken.status).toBe(200);
      expect(withToken.body).toEqual(withoutToken.body);
    });

    it("pagina un subconjunto filtrado (segunda página parcial)", async () => {
      // Arrange
      const predicate = (r: SeededRecipe) => r.status === "DRAFT" && r.authorId === AUTHOR_B;
      const expected = expectedOrder(dataset.filter(predicate));
      const limit = 3;
      const lastPage = Math.ceil(expected.length / limit);

      // Act
      const res = await request(app).get(
        `/api/v1/recipes?status=DRAFT&authorId=${AUTHOR_B}&page=${String(lastPage)}&limit=${String(limit)}`,
      );

      // Assert
      const body = res.body as ListBody;
      expect(res.status).toBe(200);
      expect(body.data.meta).toEqual({ page: lastPage, limit, total: expected.length, totalPages: lastPage });
      expect(body.data.items.map((item) => item.id)).toEqual(expected.slice((lastPage - 1) * limit));
    });

    it("ignora el encabezado Authorization (endpoint público): un token inválido no provoca 401", async () => {
      // Act
      const res = await request(app).get("/api/v1/recipes").set("Authorization", "Bearer basura");

      // Assert
      expect(res.status).toBe(200);
    });

    it("recorre todas las páginas sin duplicados ni saltos, desempatando por id DESC", async () => {
      // Arrange
      const limit = 7;
      const collected: string[] = [];

      // Act
      for (let page = 1; page <= 4; page += 1) {
        const res = await request(app).get(`/api/v1/recipes?page=${String(page)}&limit=${String(limit)}`);
        const body = res.body as ListBody;
        expect(res.status).toBe(200);
        expect(body.data.meta).toEqual({ page, limit, total: TOTAL_RECIPES, totalPages: 4 });
        expect(body.data.items).toHaveLength(page < 4 ? limit : TOTAL_RECIPES - 3 * limit);
        collected.push(...body.data.items.map((item) => item.id));
      }

      // Assert
      expect(collected).toEqual(expectedOrder(dataset));
      expect(new Set(collected).size).toBe(TOTAL_RECIPES);
      // Cada grupo de 3 recetas con el mismo `createdAt` aparece contiguo y en orden de id descendente
      for (let group = 0; group < Math.ceil(TOTAL_RECIPES / 3); group += 1) {
        const tiedIds = dataset
          .filter((r) => r.createdAt.getTime() === BASE_TIME + group * 60_000)
          .map((r) => r.id)
          .sort()
          .reverse();
        const positions = tiedIds.map((id) => collected.indexOf(id));
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
        expect((positions.at(-1) ?? 0) - (positions[0] ?? 0)).toBe(tiedIds.length - 1);
      }
    });

    it.each([
      ["status=APPROVED", (r: SeededRecipe) => r.status === "APPROVED"],
      ["status=DRAFT", (r: SeededRecipe) => r.status === "DRAFT"],
      ["difficulty=HARD", (r: SeededRecipe) => r.difficulty === "HARD"],
      [`authorId=${AUTHOR_B}`, (r: SeededRecipe) => r.authorId === AUTHOR_B],
      [
        `status=APPROVED&difficulty=EASY`,
        (r: SeededRecipe) => r.status === "APPROVED" && r.difficulty === "EASY",
      ],
      [
        `status=DRAFT&difficulty=MEDIUM&authorId=${AUTHOR_B}`,
        (r: SeededRecipe) => r.status === "DRAFT" && r.difficulty === "MEDIUM" && r.authorId === AUTHOR_B,
      ],
    ])("filtra por %s con total y totalPages exactos del subconjunto", async (qs, predicate) => {
      // Arrange
      const expected = dataset.filter(predicate);
      const limit = 3;

      // Act
      const res = await request(app).get(`/api/v1/recipes?${qs}&limit=${String(limit)}`);

      // Assert
      const body = res.body as ListBody;
      expect(res.status).toBe(200);
      expect(expected.length).toBeGreaterThan(0);
      expect(body.data.meta).toEqual({
        page: 1,
        limit,
        total: expected.length,
        totalPages: Math.ceil(expected.length / limit),
      });
      expect(body.data.items.map((item) => item.id)).toEqual(expectedOrder(expected).slice(0, limit));
    });

    it("devuelve resultado vacío con total 0 y totalPages 0 cuando ningún registro coincide", async () => {
      // Act
      const res = await request(app).get(`/api/v1/recipes?authorId=${UNKNOWN_AUTHOR}`);

      // Assert
      expect(res.status).toBe(200);
      expect((res.body as ListBody).data).toEqual({
        items: [],
        meta: { page: 1, limit: 20, total: 0, totalPages: 0 },
      });
    });

    it("devuelve total 0 y totalPages 0 con el catálogo vacío", async () => {
      // Arrange
      await truncateTables(db);

      // Act
      const res = await request(app).get("/api/v1/recipes");

      // Assert
      expect(res.status).toBe(200);
      expect((res.body as ListBody).data).toEqual({
        items: [],
        meta: { page: 1, limit: 20, total: 0, totalPages: 0 },
      });
    });

    it("devuelve items vacíos con el total real al pedir una página posterior a la última", async () => {
      // Act
      const res = await request(app).get("/api/v1/recipes?page=10&limit=20");

      // Assert
      expect(res.status).toBe(200);
      expect((res.body as ListBody).data).toEqual({
        items: [],
        meta: { page: 10, limit: 20, total: TOTAL_RECIPES, totalPages: 2 },
      });
    });

    it.each(["page=100&limit=100", "page=10000&limit=1", "page=500"])(
      "acepta ?%s en el borde de la ventana de 10000 resultados",
      async (qs) => {
        // Act
        const res = await request(app).get(`/api/v1/recipes?${qs}`);

        // Assert
        expect(res.status).toBe(200);
        expect((res.body as ListBody).data.items).toEqual([]);
      },
    );
  });

  describe("RecipeRepository.findManyPaginated — guardas y cálculo de páginas", () => {
    it.each([
      [0, 20],
      [1, 0],
      [1.5, 20],
      [1, 2.5],
    ])("rechaza page = %d / limit = %d con RangeError antes de consultar la base", async (page, limit) => {
      // Arrange
      const repository = new RecipeRepository(db.prisma);
      const countSpy = vi.spyOn(db.prisma.recipe, "count");

      // Act
      const result = repository.findManyPaginated({ filters: {}, page, limit });

      // Assert
      await expect(result).rejects.toBeInstanceOf(RangeError);
      expect(countSpy).not.toHaveBeenCalled();
    });

    it.each([
      [0, 20, 0],
      [1, 20, 1],
      [20, 20, 1],
      [21, 20, 2],
      [25, 7, 4],
    ])("calculateTotalPages(%d, %d) = %d", (total, limit, expected) => {
      expect(calculateTotalPages(total, limit)).toBe(expected);
    });
  });

  describe("400 Bad Request (OWASP API4 / BOPLA)", () => {
    it.each([
      ["limit=101", "limit"],
      ["limit=0", "limit"],
      ["page=0", "page"],
      ["page=-1", "page"],
      ["page=10001", "page"],
      ["page=101&limit=100", "page"],
      ["page=501", "page"],
      ["page=10000&limit=100", "page"],
      ["page=1e1", "page"],
      ["page=2.5", "page"],
      ["page=abc", "page"],
      ["page=1&page=2", "page"],
      ["limit=abc", "limit"],
      ["limit=1.5", "limit"],
      ["difficulty=easy", "difficulty"],
      ["status=PUBLISHED", "status"],
      ["status=", "status"],
      ["status=DRAFT&status=APPROVED", "status"],
      ["difficulty=IMPOSSIBLE", "difficulty"],
      ["authorId=no-es-uuid", "authorId"],
      ["authorId=6f1c2d3e-4b5a-1c6d-8e7f-0123456789ab", "authorId"],
      ["sort=title", "sort"],
      ["authorId[$ne]=x", "authorId[$ne]"],
    ])("rechaza ?%s con 400 JSend señalando %s", async (qs, field) => {
      // Act
      const res = await request(app).get(`/api/v1/recipes?${qs}`);

      // Assert
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, statusCode: 400, message: "Error de validación" });
      expect((res.body.errors as { field: string }[]).map((e) => e.field)).toContain(field);
    });
  });
});
