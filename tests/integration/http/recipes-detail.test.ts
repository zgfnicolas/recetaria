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
import { RATE_LIMIT_EXCEEDED_MESSAGE } from "../../../src/middlewares/rate-limit.middleware.js";
import { DUMMY_BCRYPT_HASH, type JwtConfig } from "../../../src/modules/auth/index.js";
import { RECIPE_NOT_FOUND_MESSAGE } from "../../../src/modules/recipes/index.js";
import { truncateAll } from "../../support/database.js";

const TEST_JWT_CONFIG: JwtConfig = {
  secret: "test-jwt-secret-".repeat(3),
  expiresIn: "1h",
};

const AUTHOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REVIEWER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const APPROVED_ID = "22222222-2222-4222-8222-222222222222";
const MISSING_ID = "99999999-9999-4999-8999-999999999999";
const CREATED_AT = new Date("2026-11-20T10:00:00.000Z");
const PUBLISHED_AT = new Date("2026-11-21T10:00:00.000Z");

async function truncateTables(db: Database): Promise<void> {
  await truncateAll(db);
}

async function seed(db: Database): Promise<void> {
  await db.prisma.user.createMany({
    data: [
      { id: AUTHOR_ID, role: "USER" as const },
      { id: REVIEWER_ID, role: "CHEF" as const },
    ].map((user, index) => ({
      ...user,
      email: `detalle-${String(index)}@recetaria.com`,
      passwordHash: DUMMY_BCRYPT_HASH,
      firstName: "Usuario",
      lastName: String(index),
    })),
  });
  await db.prisma.recipe.create({
    data: {
      id: DRAFT_ID,
      title: "Ñoquis caseros",
      slug: "noquis-caseros-0a1b2c3d",
      description: "Ñoquis de papa tradicionales del 29.",
      difficulty: "MEDIUM",
      status: "DRAFT",
      prepTimeMinutes: 45,
      tags: ["casero", "pastas"],
      ingredients: [
        { name: "Papa", quantity: 1, unit: "kg" },
        { name: "Harina", quantity: 300, unit: "g" },
      ],
      nutritionalInfo: { calories: 350, proteinGrams: 9, servings: 4 },
      coverImageUrl: "https://cdn.recetaria.com/noquis.jpg",
      videoUrl: null,
      authorId: AUTHOR_ID,
      createdAt: CREATED_AT,
    },
  });
  await db.prisma.recipe.create({
    data: {
      id: APPROVED_ID,
      title: "Ensalada sin TACC",
      slug: "ensalada-sin-tacc-0a1b2c3d",
      description: "Ensalada apta para celíacos.",
      difficulty: "EASY",
      status: "APPROVED",
      prepTimeMinutes: 10,
      ingredients: [{ name: "Lechuga", quantity: 1, unit: "u" }],
      authorId: AUTHOR_ID,
      reviewedById: REVIEWER_ID,
      publishedAt: PUBLISHED_AT,
      createdAt: CREATED_AT,
    },
  });
}

type DetailBody = {
  success: boolean;
  statusCode: number;
  message: string;
  data: Record<string, unknown>;
};

type ErrorBody = {
  success: false;
  statusCode: number;
  message: string;
  errors?: { field: string; message: string }[];
};

describe("GET /api/v1/recipes/:id — Detalle público por UUID (Integración HTTP + PostgreSQL)", () => {
  let db: Database;
  let app: express.Express;

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
    await seed(db);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await truncateTables(db);
  });

  afterAll(async () => {
    await disconnect();
  });

  describe("200 OK", () => {
    it("devuelve sin token el detalle completo de una Receta DRAFT con la proyección pública", async () => {
      // Act
      const res = await request(app).get(`/api/v1/recipes/${DRAFT_ID}`);

      // Assert
      const body = res.body as DetailBody;
      expect(res.status).toBe(200);
      expect(body).toMatchObject({
        success: true,
        statusCode: 200,
        message: "Receta obtenida exitosamente",
      });
      expect(body.data).toMatchObject({
        id: DRAFT_ID,
        title: "Ñoquis caseros",
        slug: "noquis-caseros-0a1b2c3d",
        description: "Ñoquis de papa tradicionales del 29.",
        difficulty: "MEDIUM",
        status: "DRAFT",
        prepTimeMinutes: 45,
        tags: ["casero", "pastas"],
        ingredients: [
          { name: "Papa", quantity: 1, unit: "kg" },
          { name: "Harina", quantity: 300, unit: "g" },
        ],
        nutritionalInfo: { calories: 350, proteinGrams: 9, servings: 4 },
        coverImageUrl: "https://cdn.recetaria.com/noquis.jpg",
        videoUrl: null,
        authorId: AUTHOR_ID,
        reviewedById: null,
        publishedAt: null,
        createdAt: CREATED_AT.toISOString(),
      });
      expect(Object.keys(body.data).sort()).toEqual(
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

    it("devuelve una Receta APPROVED con revisor y fecha de publicación", async () => {
      // Act
      const res = await request(app).get(`/api/v1/recipes/${APPROVED_ID}`);

      // Assert
      const body = res.body as DetailBody;
      expect(res.status).toBe(200);
      expect(body.data).toMatchObject({
        id: APPROVED_ID,
        status: "APPROVED",
        reviewedById: REVIEWER_ID,
        publishedAt: PUBLISHED_AT.toISOString(),
        nutritionalInfo: null,
        tags: [],
      });
    });

    it("también responde 200 con un token válido de un usuario que no es el autor", async () => {
      // Arrange
      const token = jwt.sign({ id: REVIEWER_ID, role: "CHEF" }, TEST_JWT_CONFIG.secret, {
        algorithm: "HS256",
        expiresIn: "1h",
      });

      // Act
      const res = await request(app)
        .get(`/api/v1/recipes/${DRAFT_ID}`)
        .set("Authorization", `Bearer ${token}`);

      // Assert
      expect(res.status).toBe(200);
      expect((res.body as DetailBody).data).toMatchObject({ id: DRAFT_ID });
    });

    it("acepta el UUID en mayúsculas", async () => {
      // Act
      const res = await request(app).get(`/api/v1/recipes/${DRAFT_ID.toUpperCase()}`);

      // Assert
      expect(res.status).toBe(200);
      expect((res.body as DetailBody).data).toMatchObject({ id: DRAFT_ID });
    });
  });

  describe("400 Bad Request", () => {
    it.each([
      ["texto arbitrario", "abc"],
      ["UUID v1 (no v4)", "6f1c2d3e-4b5a-1c6d-8e7f-0123456789ab"],
      ["UUID v7 (no v4)", "0190f2a1-4b5a-7c6d-8e7f-0123456789ab"],
      ["UUID nil", "00000000-0000-0000-0000-000000000000"],
      ["UUID con un carácter extra", `${DRAFT_ID}0`],
      ["inyección SQL", "1%27%20OR%20%271%27%3D%271"],
    ])("rechaza :id = %s sin consultar la base", async (_label, id) => {
      // Arrange
      const readSpies = [
        vi.spyOn(db.prisma.recipe, "findUnique"),
        vi.spyOn(db.prisma.recipe, "findFirst"),
        vi.spyOn(db.prisma.recipe, "findMany"),
      ];

      // Act
      const res = await request(app).get(`/api/v1/recipes/${id}`);

      // Assert
      const body = res.body as ErrorBody;
      expect(res.status).toBe(400);
      expect(body).toMatchObject({ success: false, statusCode: 400, message: "Error de validación" });
      expect(body.errors).toEqual([{ field: "id", message: "id debe ser un UUID v4 válido" }]);
      for (const spy of readSpies) {
        expect(spy).not.toHaveBeenCalled();
      }
    });
  });

  describe("404 Not Found", () => {
    it("responde 404 JSend si el UUID v4 es válido pero no existe", async () => {
      // Act
      const res = await request(app).get(`/api/v1/recipes/${MISSING_ID}`);

      // Assert
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        success: false,
        statusCode: 404,
        message: RECIPE_NOT_FOUND_MESSAGE,
      });
    });
  });
});

describe("Rate limit de lecturas públicas en GET /api/v1/recipes/:id (#18, OWASP API4)", () => {
  let db: Database;

  function createApp(limit: number): express.Express {
    return buildApp({
      prisma: db.prisma,
      jwt: TEST_JWT_CONFIG,
      publicRateLimit: { windowMs: 60_000, limit, identifier: "recipes-public-read" },
      onLog: () => undefined,
      onError: () => undefined,
    });
  }

  beforeAll(() => {
    db = getDatabase();
  });

  beforeEach(async () => {
    await truncateTables(db);
    await seed(db);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await truncateTables(db);
  });

  afterAll(async () => {
    await disconnect();
  });

  it("comparte la cuota con GET /api/v1/recipes y responde 429 JSend sin consultar la base", async () => {
    // Arrange
    const app = createApp(2);
    expect((await request(app).get("/api/v1/recipes")).status).toBe(200);
    expect((await request(app).get(`/api/v1/recipes/${DRAFT_ID}`)).status).toBe(200);
    const readSpies = [
      vi.spyOn(db.prisma.recipe, "findUnique"),
      vi.spyOn(db.prisma.recipe, "findFirst"),
    ];

    // Act
    const res = await request(app).get(`/api/v1/recipes/${DRAFT_ID}`);

    // Assert
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toMatch(/^\d+$/);
    expect(res.body).toMatchObject({
      success: false,
      statusCode: 429,
      message: RATE_LIMIT_EXCEEDED_MESSAGE,
    });
    for (const spy of readSpies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("aplica el limitador antes de validar: un :id inválido también consume cuota", async () => {
    // Arrange
    const app = createApp(1);
    expect((await request(app).get("/api/v1/recipes/abc")).status).toBe(400);

    // Act
    const res = await request(app).get(`/api/v1/recipes/${DRAFT_ID}`);

    // Assert
    expect(res.status).toBe(429);
  });

  it("no limita GET /api/v1/recipes/mine (ruta autenticada, fuera de la cuota pública)", async () => {
    // Arrange
    const app = createApp(1);
    const token = jwt.sign({ id: AUTHOR_ID, role: "USER" }, TEST_JWT_CONFIG.secret, {
      algorithm: "HS256",
      expiresIn: "1h",
    });
    expect((await request(app).get(`/api/v1/recipes/${DRAFT_ID}`)).status).toBe(200);

    // Act
    const res = await request(app).get("/api/v1/recipes/mine").set("Authorization", `Bearer ${token}`);

    // Assert
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit"]).toBeUndefined();
  });
});
