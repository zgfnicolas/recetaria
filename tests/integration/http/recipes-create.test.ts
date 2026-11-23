import { randomUUID } from "node:crypto";
import type express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../src/app.js";
import { buildApiRouters } from "../../../src/bootstrap/container.js";
import {
  disconnect,
  getDatabase,
  type Database,
} from "../../../src/infrastructure/database/prisma.js";
import { createAuthMiddleware } from "../../../src/middlewares/auth.middleware.js";
import type { JwtConfig, UserRole } from "../../../src/modules/auth/index.js";
import {
  createRecipeRouter,
  RecipeController,
  RecipeRepository,
  RecipeService,
} from "../../../src/modules/recipes/index.js";

const EXPECTED_MVP_ROLES = ["USER", "CHEF", "NUTRITIONIST", "ADMIN"] as const;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const TEST_JWT_CONFIG: JwtConfig = {
  secret: "test-jwt-secret-".repeat(3),
  expiresIn: "1h",
};

const VALID_RECIPE = {
  title: "Ñoquis de Papá",
  description: "Ñoquis de papa tradicionales para el 29 de cada mes.",
  prepTimeMinutes: 45,
  ingredients: [
    { name: "Papa", quantity: 1, unit: "kg" },
    { name: "Harina", quantity: 300, unit: "g" },
  ],
} as const;

async function truncateTables(db: Database): Promise<void> {
  await db.prisma.$executeRaw`TRUNCATE TABLE "audit_logs", "recipes", "users" RESTART IDENTITY;`;
}

function createApp(
  db: Database,
  options?: { readonly onError?: (message: string, err: unknown) => void },
): express.Express {
  return buildApp({
    prisma: db.prisma,
    jwt: TEST_JWT_CONFIG,
    onLog: () => undefined,
    onError: options?.onError ?? (() => undefined),
  });
}

async function registerAndLogin(
  app: express.Express,
  options: { readonly email: string; readonly role: UserRole },
): Promise<{ readonly token: string; readonly userId: string }> {
  const password = "test-password-example";
  const registerRes = await request(app).post("/api/v1/auth/register").send({
    email: options.email,
    password,
    firstName: "Autor",
    lastName: options.role,
    role: options.role,
  });
  expect(registerRes.status).toBe(201);

  const loginRes = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: options.email, password });
  expect(loginRes.status).toBe(200);

  return {
    token: String(loginRes.body.data.token),
    userId: String(loginRes.body.data.user.id),
  };
}

describe("POST /api/v1/recipes — Alta de Receta en Borrador (Integración HTTP + PostgreSQL)", () => {
  let db: Database;

  beforeAll(() => {
    db = getDatabase();
  });

  beforeEach(async () => {
    await truncateTables(db);
  });

  afterEach(async () => {
    await truncateTables(db);
  });

  afterAll(async () => {
    await disconnect();
  });

  describe("201 Created (RN-01)", () => {
    it.each(EXPECTED_MVP_ROLES)(
      "permite crear a %s: persiste DRAFT, authorId del JWT, slug normalizado y JSONB sin auditar",
      async (role) => {
        // Arrange
        const app = createApp(db);
        const { token, userId } = await registerAndLogin(app, {
          email: `${role.toLowerCase()}-recipes@recetaria.com`,
          role,
        });

        // Act
        const res = await request(app)
          .post("/api/v1/recipes")
          .set("Authorization", `Bearer ${token}`)
          .send(VALID_RECIPE);

        // Assert
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
          success: true,
          statusCode: 201,
          message: "Receta creada exitosamente",
          data: {
            title: VALID_RECIPE.title,
            description: VALID_RECIPE.description,
            difficulty: "MEDIUM",
            status: "DRAFT",
            prepTimeMinutes: 45,
            tags: [],
            ingredients: VALID_RECIPE.ingredients,
            nutritionalInfo: null,
            coverImageUrl: null,
            videoUrl: null,
            authorId: userId,
            reviewedById: null,
            publishedAt: null,
          },
        });
        expect(res.body.data.id).toMatch(UUID_V4_PATTERN);
        expect(res.body.data.slug).toMatch(SLUG_PATTERN);
        expect(String(res.body.data.slug).startsWith("noquis-de-papa-")).toBe(true);

        const stored = await db.prisma.recipe.findUniqueOrThrow({ where: { id: res.body.data.id } });
        expect(stored).toMatchObject({
          status: "DRAFT",
          authorId: userId,
          slug: res.body.data.slug,
          ingredients: VALID_RECIPE.ingredients,
          reviewedById: null,
          publishedAt: null,
        });
        const [nullCheck] = await db.prisma.$queryRaw<{ isSqlNull: boolean }[]>`
          SELECT "nutritionalInfo" IS NULL AS "isSqlNull" FROM "recipes" WHERE "id" = ${stored.id}::uuid`;
        expect(nullCheck?.isSqlNull).toBe(true);
        expect(await db.prisma.auditLog.count()).toBe(0);
      },
    );

    it.each([1, 1440])(
      "acepta el borde prepTimeMinutes = %d (RN-07, chk_prep_time_positive)",
      async (prepTimeMinutes) => {
        // Arrange
        const app = createApp(db);
        const { token } = await registerAndLogin(app, { email: "edge@recetaria.com", role: "USER" });

        // Act
        const res = await request(app)
          .post("/api/v1/recipes")
          .set("Authorization", `Bearer ${token}`)
          .send({ ...VALID_RECIPE, prepTimeMinutes });

        // Assert
        expect(res.status).toBe(201);
        expect(res.body.data.prepTimeMinutes).toBe(prepTimeMinutes);
      },
    );

    it("persiste la entrada completa con nutritionalInfo como objeto JSONB, tags y URLs", async () => {
      // Arrange
      const app = createApp(db);
      const { token } = await registerAndLogin(app, { email: "full@recetaria.com", role: "USER" });
      const body = {
        ...VALID_RECIPE,
        difficulty: "HARD",
        tags: ["casero", "vegetariano"],
        nutritionalInfo: { calories: 420, proteinGrams: 11.5, servings: 4 },
        coverImageUrl: "https://cdn.recetaria.com/noquis.jpg",
        videoUrl: "https://cdn.recetaria.com/noquis.mp4",
      };

      // Act
      const res = await request(app)
        .post("/api/v1/recipes")
        .set("Authorization", `Bearer ${token}`)
        .send(body);

      // Assert
      expect(res.status).toBe(201);
      const [row] = await db.prisma.$queryRaw<{ kind: string }[]>`
        SELECT jsonb_typeof("nutritionalInfo") AS "kind" FROM "recipes" WHERE "id" = ${String(res.body.data.id)}::uuid`;
      expect(row?.kind).toBe("object");
      const stored = await db.prisma.recipe.findUniqueOrThrow({ where: { id: res.body.data.id } });
      expect(stored).toMatchObject({
        difficulty: "HARD",
        tags: ["casero", "vegetariano"],
        nutritionalInfo: { calories: 420, proteinGrams: 11.5, servings: 4 },
        coverImageUrl: body.coverImageUrl,
        videoUrl: body.videoUrl,
      });
    });
  });

  describe("401 Unauthorized (authMiddleware → validateMiddleware, ADR-0006)", () => {
    it.each([
      ["sin encabezado Authorization", undefined],
      ["con esquema distinto de Bearer", "Basic dXNlcjpwYXNz"],
      ["con JWT firmado con otro secreto", `Bearer ${jwt.sign({ id: randomUUID(), role: "USER" }, "otro-secreto-".repeat(4), { algorithm: "HS256" })}`],
      ["con token malformado", "Bearer no.es.jwt"],
      [
        "con JWT expirado",
        `Bearer ${jwt.sign({ id: randomUUID(), role: "USER", exp: Math.floor(Date.now() / 1000) - 60 }, TEST_JWT_CONFIG.secret, { algorithm: "HS256" })}`,
      ],
      [
        "con JWT firmado con algoritmo fuera de la lista blanca (HS512)",
        `Bearer ${jwt.sign({ id: randomUUID(), role: "USER" }, TEST_JWT_CONFIG.secret, { algorithm: "HS512" })}`,
      ],
      [
        "con JWT sin firma (alg: none)",
        `Bearer ${jwt.sign({ id: randomUUID(), role: "USER" }, "", { algorithm: "none" })}`,
      ],
    ])("rechaza %s antes de validar el cuerpo (incluso vacío o con BOPLA)", async (_label, header) => {
      // Arrange
      const app = createApp(db);

      for (const body of [{}, { status: "APPROVED", authorId: randomUUID() }]) {
        // Act
        const req = request(app).post("/api/v1/recipes");
        const res = await (header === undefined ? req : req.set("Authorization", header)).send(body);

        // Assert
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ success: false, statusCode: 401 });
      }
      expect(await db.prisma.recipe.count()).toBe(0);
    });

    it("fija el comportamiento actual: JSON malformado sin token responde 400 (parser global previo al router)", async () => {
      // Arrange
      const app = createApp(db);

      // Act
      const res = await request(app)
        .post("/api/v1/recipes")
        .set("Content-Type", "application/json")
        .send('{"title": ');

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("JSON inválido en el cuerpo de la solicitud");
      expect(await db.prisma.recipe.count()).toBe(0);
    });

    it("rechaza un JWT válido cuyo usuario no existe en la base (P2003) sin 500", async () => {
      // Arrange
      const onError = vi.fn();
      const app = createApp(db, { onError });
      const orphanToken = jwt.sign({ id: randomUUID(), role: "USER" }, TEST_JWT_CONFIG.secret, {
        algorithm: "HS256",
        expiresIn: "1h",
      });

      // Act
      const res = await request(app)
        .post("/api/v1/recipes")
        .set("Authorization", `Bearer ${orphanToken}`)
        .send(VALID_RECIPE);

      // Assert
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        success: false,
        statusCode: 401,
        message: "Usuario autenticado no válido",
        errors: [],
      });
      expect(onError).not.toHaveBeenCalled();
      expect(await db.prisma.recipe.count()).toBe(0);
    });
  });

  describe("400 Bad Request (Zod 4, BOPLA y RN-07)", () => {
    it.each(["status", "authorId", "reviewedById", "publishedAt", "slug"])(
      "rechaza el campo protegido %s (BOPLA) sin escribir filas",
      async (field) => {
        // Arrange
        const app = createApp(db);
        const { token } = await registerAndLogin(app, { email: "bopla@recetaria.com", role: "CHEF" });

        // Act
        const res = await request(app)
          .post("/api/v1/recipes")
          .set("Authorization", `Bearer ${token}`)
          .send({ ...VALID_RECIPE, [field]: field === "status" ? "APPROVED" : randomUUID() });

        // Assert
        expect(res.status).toBe(400);
        expect(res.body).toEqual({
          success: false,
          statusCode: 400,
          message: "Error de validación",
          errors: [{ field, message: "Campo no permitido" }],
        });
        expect(await db.prisma.recipe.count()).toBe(0);
      },
    );

    it("rechaza claves extra anidadas en ingredientes y nutritionalInfo", async () => {
      // Arrange
      const app = createApp(db);
      const { token } = await registerAndLogin(app, { email: "nested@recetaria.com", role: "USER" });

      // Act
      const res = await request(app)
        .post("/api/v1/recipes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          ...VALID_RECIPE,
          ingredients: [{ name: "Papa", quantity: 1, unit: "kg", price: 10 }],
          nutritionalInfo: { calories: 10, sodiumMg: 5 },
        });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.errors).toEqual(
        expect.arrayContaining([
          { field: "ingredients.0.price", message: "Campo no permitido" },
          { field: "nutritionalInfo.sodiumMg", message: "Campo no permitido" },
        ]),
      );
    });

    it("rechaza un cuerpo estructuralmente inválido detallando cada campo", async () => {
      // Arrange
      const app = createApp(db);
      const { token } = await registerAndLogin(app, { email: "zod@recetaria.com", role: "USER" });

      // Act
      const res = await request(app)
        .post("/api/v1/recipes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          title: "ab",
          description: "corta",
          prepTimeMinutes: 10.5,
          ingredients: [],
          coverImageUrl: "javascript:alert(1)",
        });

      // Assert
      expect(res.status).toBe(400);
      const fields = (res.body.errors as { field: string }[]).map((e) => e.field);
      expect(fields).toEqual(
        expect.arrayContaining(["title", "description", "prepTimeMinutes", "ingredients", "coverImageUrl"]),
      );
      expect(await db.prisma.recipe.count()).toBe(0);
    });

    it("rechaza payloads que exceden los topes de description, ingredients y quantity (OWASP API4)", async () => {
      // Arrange
      const app = createApp(db);
      const { token } = await registerAndLogin(app, { email: "caps@recetaria.com", role: "USER" });

      // Act
      const res = await request(app)
        .post("/api/v1/recipes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          ...VALID_RECIPE,
          description: "d".repeat(5001),
          ingredients: Array.from({ length: 101 }, () => ({ name: "Sal", quantity: 100001, unit: "g" })),
        });

      // Assert
      expect(res.status).toBe(400);
      const fields = (res.body.errors as { field: string }[]).map((e) => e.field);
      expect(fields).toEqual(expect.arrayContaining(["description", "ingredients"]));
      expect(await db.prisma.recipe.count()).toBe(0);
    });

    it("rechaza un cuerpo text/plain con 400 sin alcanzar el servicio", async () => {
      // Arrange
      const app = createApp(db);
      const { token } = await registerAndLogin(app, { email: "plain@recetaria.com", role: "USER" });

      // Act
      const res = await request(app)
        .post("/api/v1/recipes")
        .set("Authorization", `Bearer ${token}`)
        .set("Content-Type", "text/plain")
        .send(JSON.stringify(VALID_RECIPE));

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Error de validación");
      expect(await db.prisma.recipe.count()).toBe(0);
    });

    it("rechaza JSON malformado con 400", async () => {
      // Arrange
      const app = createApp(db);
      const { token } = await registerAndLogin(app, { email: "json@recetaria.com", role: "USER" });

      // Act
      const res = await request(app)
        .post("/api/v1/recipes")
        .set("Authorization", `Bearer ${token}`)
        .set("Content-Type", "application/json")
        .send('{"title": "Ñoquis",');

      // Assert
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, statusCode: 400 });
    });

    it.each([0, -5, 1441])(
      "rechaza prepTimeMinutes = %d en RecipeService (RN-07) sin escribir filas",
      async (prepTimeMinutes) => {
        // Arrange
        const app = createApp(db);
        const { token } = await registerAndLogin(app, { email: "rn07@recetaria.com", role: "USER" });

        // Act
        const res = await request(app)
          .post("/api/v1/recipes")
          .set("Authorization", `Bearer ${token}`)
          .send({ ...VALID_RECIPE, prepTimeMinutes });

        // Assert
        expect(res.status).toBe(400);
        expect(res.body).toEqual({
          success: false,
          statusCode: 400,
          message: "Error de validación de negocio",
          errors: [
            {
              field: "prepTimeMinutes",
              message: "El tiempo de preparación debe ser un entero entre 1 y 1440 minutos",
            },
          ],
        });
        expect(await db.prisma.recipe.count()).toBe(0);
      },
    );

    it("rechaza ingredientes con quantity <= 0 en RecipeService (RN-07) acumulando errores", async () => {
      // Arrange
      const app = createApp(db);
      const { token } = await registerAndLogin(app, { email: "qty@recetaria.com", role: "USER" });

      // Act
      const res = await request(app)
        .post("/api/v1/recipes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          ...VALID_RECIPE,
          ingredients: [
            { name: "Sal", quantity: 0, unit: "g" },
            { name: "Papa", quantity: 1, unit: "kg" },
            { name: "Agua", quantity: -1, unit: "ml" },
          ],
        });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Error de validación de negocio");
      expect(res.body.errors).toEqual([
        { field: "ingredients.0.quantity", message: "La cantidad del ingrediente debe ser mayor a 0" },
        { field: "ingredients.2.quantity", message: "La cantidad del ingrediente debe ser mayor a 0" },
      ]);
      expect(await db.prisma.recipe.count()).toBe(0);
    });
  });

  describe("RecipeRepository.findBySlug (PostgreSQL real)", () => {
    it("devuelve la receta tipada por slug o null si no existe", async () => {
      // Arrange
      const app = createApp(db);
      const { token } = await registerAndLogin(app, { email: "find@recetaria.com", role: "USER" });
      const created = await request(app)
        .post("/api/v1/recipes")
        .set("Authorization", `Bearer ${token}`)
        .send(VALID_RECIPE);
      const repository = new RecipeRepository(db.prisma);

      // Act
      const found = await repository.findBySlug(String(created.body.data.slug));
      const missing = await repository.findBySlug("no-existe-0a1b2c3d");

      // Assert
      expect(found).toMatchObject({
        id: created.body.data.id,
        status: "DRAFT",
        ingredients: VALID_RECIPE.ingredients,
        nutritionalInfo: null,
      });
      expect(missing).toBeNull();
    });

    it("trata un JSONB persistido con formato inválido como error 500 no operacional (no 400)", async () => {
      // Arrange
      const app = createApp(db);
      const { userId } = await registerAndLogin(app, { email: "corrupt@recetaria.com", role: "USER" });
      await db.prisma.$executeRaw`
        INSERT INTO "recipes" ("title", "slug", "description", "prepTimeMinutes", "ingredients", "authorId")
        VALUES ('Corrupta', 'corrupta-0a1b2c3d', 'Descripción corrupta', 10, '[{"name": 1}]'::jsonb, ${userId}::uuid)`;
      const repository = new RecipeRepository(db.prisma);

      // Act
      const result = repository.findBySlug("corrupta-0a1b2c3d");

      // Assert
      await expect(result).rejects.toMatchObject({ statusCode: 500, isOperational: false });
    });
  });

  describe("409 Conflict y 500 fail-closed", () => {
    it("devuelve 409 ante colisión real de slug (P2002) y conserva solo la primera fila", async () => {
      // Arrange: slug determinístico inyectado en el servicio para forzar la colisión
      const authGuard = createAuthMiddleware({ secret: TEST_JWT_CONFIG.secret });
      const service = new RecipeService(new RecipeRepository(db.prisma), {
        generateSlug: () => "slug-fijo-0a1b2c3d",
      });
      const [authRouter] = buildApiRouters(db.prisma, { jwt: TEST_JWT_CONFIG });
      if (authRouter === undefined) {
        throw new Error("Router de auth no disponible");
      }
      const app = buildApp({
        prisma: db.prisma,
        jwt: TEST_JWT_CONFIG,
        apiRouters: [
          authRouter,
          { path: "/recipes", router: createRecipeRouter(new RecipeController(service), authGuard) },
        ],
        onLog: () => undefined,
        onError: () => undefined,
      });
      const { token } = await registerAndLogin(app, { email: "slug@recetaria.com", role: "USER" });
      const send = () =>
        request(app).post("/api/v1/recipes").set("Authorization", `Bearer ${token}`).send(VALID_RECIPE);

      // Act
      const first = await send();
      const second = await send();

      // Assert
      expect(first.status).toBe(201);
      expect(second.status).toBe(409);
      expect(second.body).toEqual({
        success: false,
        statusCode: 409,
        message: "Ya existe una receta con ese slug",
        errors: [],
      });
      expect(await db.prisma.recipe.count()).toBe(1);
    });

    it("falla cerrado con 500 redactado si la app se construye sin configuración JWT", async () => {
      // Arrange
      const onError = vi.fn();
      const app = buildApp({ prisma: db.prisma, onLog: () => undefined, onError });

      // Act
      const res = await request(app)
        .post("/api/v1/recipes")
        .set("Authorization", "Bearer cualquier.token.valor")
        .send(VALID_RECIPE);

      // Assert
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        success: false,
        statusCode: 500,
        message: "Error interno del servidor",
        errors: [],
      });
      expect(JSON.stringify(res.body)).not.toContain("JWT");
      expect(onError).toHaveBeenCalled();
      expect(await db.prisma.recipe.count()).toBe(0);
    });
  });
});
