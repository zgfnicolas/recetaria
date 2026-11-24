import type express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../../src/app.js";
import {
  disconnect,
  getDatabase,
  type Database,
} from "../../../src/infrastructure/database/prisma.js";
import { DUMMY_BCRYPT_HASH, type JwtConfig } from "../../../src/modules/auth/index.js";
import {
  RECIPE_DIFFICULTIES,
  type RecipeDifficulty,
  type RecipeStatus,
} from "../../../src/modules/recipes/index.js";

const TEST_JWT_CONFIG: JwtConfig = {
  secret: "test-jwt-secret-".repeat(3),
  expiresIn: "1h",
};

const AUTHOR_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AUTHOR_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** Autor sin recetas (existe en `users`). */
const AUTHOR_EMPTY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BASE_TIME = Date.parse("2026-11-01T12:00:00.000Z");
const TOTAL_RECIPES = 15;

type SeededRecipe = Readonly<{
  id: string;
  authorId: string;
  status: RecipeStatus;
  difficulty: RecipeDifficulty;
  createdAt: Date;
}>;

/**
 * 15 recetas: A (9) y B (6) con patrón `i % 5 < 3` (no correlacionado con la dificultad
 * `i % 4`: ambos Autores tienen las 4 dificultades y combinaciones `DRAFT` + `HARD`).
 * `createdAt` se repite de a 3, con empates **dentro del mismo Autor** (fuerza el desempate
 * por `id DESC` en `/mine`), e `id` permutado (`(i * 4) % 15`) respecto de `createdAt`.
 */
function buildDataset(): SeededRecipe[] {
  return Array.from({ length: TOTAL_RECIPES }, (_, i) => ({
    id: `00000000-0000-4000-8000-${((i * 4) % TOTAL_RECIPES).toString(16).padStart(12, "0")}`,
    authorId: i % 5 < 3 ? AUTHOR_A : AUTHOR_B,
    status: i % 3 === 0 ? "APPROVED" : "DRAFT",
    difficulty: RECIPE_DIFFICULTIES[i % RECIPE_DIFFICULTIES.length] ?? "MEDIUM",
    createdAt: new Date(BASE_TIME + Math.floor(i / 3) * 60_000),
  }));
}

function expectedOrder(recipes: readonly SeededRecipe[]): string[] {
  return [...recipes]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
    .map((recipe) => recipe.id);
}

function bearer(id: string, role = "USER"): string {
  return `Bearer ${jwt.sign({ id, role }, TEST_JWT_CONFIG.secret, { algorithm: "HS256", expiresIn: "1h" })}`;
}

async function truncateTables(db: Database): Promise<void> {
  await db.prisma.$executeRaw`TRUNCATE TABLE "audit_logs", "recipes", "users" RESTART IDENTITY;`;
}

async function seed(db: Database, recipes: readonly SeededRecipe[]): Promise<void> {
  await db.prisma.user.createMany({
    data: [AUTHOR_A, AUTHOR_B, AUTHOR_EMPTY].map((id, index) => ({
      id,
      email: `autor-${String(index)}@recetaria.com`,
      passwordHash: DUMMY_BCRYPT_HASH,
      firstName: "Autor",
      lastName: String(index),
      role: index === 1 ? "CHEF" : "USER",
    })),
  });
  await db.prisma.recipe.createMany({
    data: recipes.map((recipe, i) => ({
      id: recipe.id,
      title: `Receta ${String(i)}`,
      slug: `receta-${String(i)}-0a1b2c3d`,
      description: "Descripción de prueba de recetas propias.",
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

type ErrorBody = {
  success: false;
  statusCode: number;
  message: string;
  errors?: { field: string; message: string }[];
};

describe("GET /api/v1/recipes/mine — Recetas propias autenticadas (Integración HTTP + PostgreSQL)", () => {
  let db: Database;
  let app: express.Express;
  const dataset = buildDataset();
  const ofA = dataset.filter((recipe) => recipe.authorId === AUTHOR_A);
  const ofB = dataset.filter((recipe) => recipe.authorId === AUTHOR_B);

  beforeAll(() => {
    db = getDatabase();
    app = buildApp({
      prisma: db.prisma,
      jwt: TEST_JWT_CONFIG,
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

  describe("200 OK — aislamiento entre Autores", () => {
    it.each([
      ["A", AUTHOR_A, ofA],
      ["B", AUTHOR_B, ofB],
    ])("el Autor %s ve solo sus recetas, en orden createdAt DESC, id DESC", async (_label, authorId, own) => {
      // Act
      const res = await request(app).get("/api/v1/recipes/mine").set("Authorization", bearer(authorId));

      // Assert
      const body = res.body as ListBody;
      expect(res.status).toBe(200);
      expect(body).toMatchObject({
        success: true,
        statusCode: 200,
        message: "Recetas propias obtenidas exitosamente",
        data: { meta: { page: 1, limit: 20, total: own.length, totalPages: 1 } },
      });
      expect(body.data.items.map((item) => item.id)).toEqual(expectedOrder(own));
      expect(body.data.items.every((item) => item.authorId === authorId)).toBe(true);
    });

    it("el rol no amplía el alcance: un CHEF también ve solo las suyas", async () => {
      // Act
      const res = await request(app)
        .get("/api/v1/recipes/mine")
        .set("Authorization", bearer(AUTHOR_B, "CHEF"));

      // Assert
      const body = res.body as ListBody;
      expect(res.status).toBe(200);
      expect(body.data.meta.total).toBe(ofB.length);
    });

    it("desempata por id DESC las recetas propias con el mismo createdAt", async () => {
      // Arrange: grupos de recetas de A que comparten createdAt
      const byCreatedAt = new Map<number, SeededRecipe[]>();
      for (const recipe of ofA) {
        const group = byCreatedAt.get(recipe.createdAt.getTime()) ?? [];
        group.push(recipe);
        byCreatedAt.set(recipe.createdAt.getTime(), group);
      }
      const ties = [...byCreatedAt.values()].filter((group) => group.length > 1);

      // Act
      const res = await request(app).get("/api/v1/recipes/mine").set("Authorization", bearer(AUTHOR_A));

      // Assert
      const ids = (res.body as ListBody).data.items.map((item) => item.id);
      expect(ties.length).toBeGreaterThan(0);
      for (const group of ties) {
        const expectedTie = group.map((recipe) => recipe.id).sort().reverse();
        expect(ids.filter((id) => expectedTie.includes(id))).toEqual(expectedTie);
      }
    });

    it("pagina sin duplicados ni saltos", async () => {
      // Act
      const pages = await Promise.all(
        [1, 2, 3].map((page) =>
          request(app)
            .get(`/api/v1/recipes/mine?page=${String(page)}&limit=3`)
            .set("Authorization", bearer(AUTHOR_A)),
        ),
      );

      // Assert
      const bodies = pages.map((res) => res.body as ListBody);
      expect(bodies.map((body) => body.data.meta)).toEqual([
        { page: 1, limit: 3, total: ofA.length, totalPages: 3 },
        { page: 2, limit: 3, total: ofA.length, totalPages: 3 },
        { page: 3, limit: 3, total: ofA.length, totalPages: 3 },
      ]);
      expect(bodies.flatMap((body) => body.data.items.map((item) => item.id))).toEqual(
        expectedOrder(ofA),
      );
    });

    it("combina filtros status y difficulty dentro del alcance del Autor", async () => {
      // Arrange: B también tiene recetas DRAFT + HARD, que no deben filtrarse hacia A
      const expected = ofA.filter((recipe) => recipe.status === "DRAFT" && recipe.difficulty === "HARD");
      expect(ofB.some((recipe) => recipe.status === "DRAFT" && recipe.difficulty === "HARD")).toBe(true);

      // Act
      const res = await request(app)
        .get("/api/v1/recipes/mine?status=DRAFT&difficulty=HARD")
        .set("Authorization", bearer(AUTHOR_A));

      // Assert
      const body = res.body as ListBody;
      expect(res.status).toBe(200);
      expect(expected.length).toBeGreaterThan(0);
      expect(body.data.items.map((item) => item.id)).toEqual(expectedOrder(expected));
      expect(body.data.meta.total).toBe(expected.length);
    });

    it("un Autor sin recetas recibe items vacíos con total 0 y totalPages 0", async () => {
      // Act
      const res = await request(app).get("/api/v1/recipes/mine").set("Authorization", bearer(AUTHOR_EMPTY));

      // Assert
      const body = res.body as ListBody;
      expect(res.status).toBe(200);
      expect(body.data).toEqual({ items: [], meta: { page: 1, limit: 20, total: 0, totalPages: 0 } });
    });
  });

  describe("400 Bad Request", () => {
    it("rechaza ?authorId= de otro Autor sin ampliar el alcance (BOLA/BOPLA)", async () => {
      // Act
      const res = await request(app)
        .get(`/api/v1/recipes/mine?authorId=${AUTHOR_B}`)
        .set("Authorization", bearer(AUTHOR_A));

      // Assert
      const body = res.body as ErrorBody;
      expect(res.status).toBe(400);
      expect(body).toMatchObject({ success: false, statusCode: 400, message: "Error de validación" });
      expect(body.errors).toEqual([{ field: "authorId", message: "Campo no permitido" }]);
    });

    it.each([
      ["clave desconocida", "sort=title", "sort"],
      ["limit fuera de rango", "limit=101", "limit"],
      ["status inválido", "status=PUBLISHED", "status"],
      ["parámetro repetido", "status=DRAFT&status=APPROVED", "status"],
      ["ventana page × limit", "page=101&limit=100", "page"],
    ])("rechaza %s", async (_label, qs, field) => {
      // Act
      const res = await request(app).get(`/api/v1/recipes/mine?${qs}`).set("Authorization", bearer(AUTHOR_A));

      // Assert
      const body = res.body as ErrorBody;
      expect(res.status).toBe(400);
      expect(body.errors?.map((error) => error.field)).toContain(field);
    });
  });

  describe("401 Unauthorized", () => {
    it.each([
      ["sin header Authorization", undefined],
      ["con token malformado", "Bearer no.es.jwt"],
      [
        "con JWT firmado con otro secreto",
        `Bearer ${jwt.sign({ id: AUTHOR_A, role: "USER" }, "otro-secreto-".repeat(4), { algorithm: "HS256" })}`,
      ],
      [
        "con JWT expirado",
        `Bearer ${jwt.sign({ id: AUTHOR_A, role: "USER", exp: Math.floor(Date.now() / 1000) - 60 }, TEST_JWT_CONFIG.secret, { algorithm: "HS256" })}`,
      ],
    ])("responde 401 JSend %s", async (_label, authorization) => {
      // Act
      const req = request(app).get("/api/v1/recipes/mine");
      const res = await (authorization === undefined ? req : req.set("Authorization", authorization));

      // Assert
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ success: false, statusCode: 401 });
    });

    it("autentica antes de validar: query inválida sin token responde 401, no 400", async () => {
      // Act
      const res = await request(app).get(`/api/v1/recipes/mine?authorId=${AUTHOR_B}&limit=999`);

      // Assert
      expect(res.status).toBe(401);
    });
  });

  describe("Precedencia de /mine sobre /:id", () => {
    it("sin token responde 401 de autenticación (no 400 por UUID inválido de /:id)", async () => {
      // Act
      const res = await request(app).get("/api/v1/recipes/mine");

      // Assert
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ success: false, statusCode: 401 });
    });

    it("con token responde 200 paginado (no 404 ni 400 del detalle)", async () => {
      // Act
      const res = await request(app).get("/api/v1/recipes/mine").set("Authorization", bearer(AUTHOR_A));

      // Assert
      const body = res.body as ListBody;
      expect(res.status).toBe(200);
      expect(body.data).toHaveProperty("items");
      expect(body.data).toHaveProperty("meta");
    });

    it("el enrutamiento de Express no distingue mayúsculas: /MINE también resuelve a /mine (no a /:id)", async () => {
      // Act
      const unauthenticated = await request(app).get("/api/v1/recipes/MINE");
      const authenticated = await request(app)
        .get("/api/v1/recipes/MINE")
        .set("Authorization", bearer(AUTHOR_A));

      // Assert
      expect(unauthenticated.status).toBe(401);
      expect(authenticated.status).toBe(200);
      expect((authenticated.body as ListBody).data.meta.total).toBe(ofA.length);
    });
  });
});
