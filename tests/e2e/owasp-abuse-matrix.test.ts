import { randomUUID } from "node:crypto";
import type express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { disconnect, getDatabase, type Database } from "../../src/infrastructure/database/prisma.js";
import type { UserRole } from "../../src/modules/auth/index.js";
import { truncateAll } from "../support/database.js";
import { E2E_JWT_CONFIG } from "../support/e2e.js";
import { createExposureRecorder } from "../support/exposure.js";
import { createUserWithRole, TEST_USER_PASSWORD } from "../support/users.js";

const TEST_JWT_CONFIG = E2E_JWT_CONFIG;

const VALID_RECIPE = {
  title: "Receta de la matriz",
  description: "Receta usada por la matriz de abuso OWASP.",
  prepTimeMinutes: 15,
  ingredients: [{ name: "Arroz", quantity: 100, unit: "g" }],
};

type Actor = Readonly<{ id: string; email: string; role: UserRole }>;
type Fixture = Readonly<{
  author: Actor;
  other: Actor;
  chef: Actor;
  nutri: Actor;
  admin: Actor;
  inactive: Actor;
  degradedAdmin: Actor;
  inactiveAdmin: Actor;
  authorRecipeId: string;
  chefRecipeId: string;
}>;

function sign(payload: object, options: jwt.SignOptions = { algorithm: "HS256", expiresIn: "1h" }): string {
  return jwt.sign(payload, TEST_JWT_CONFIG.secret, options);
}

function tokenFor(actor: Actor): string {
  return sign({ id: actor.id, role: actor.role });
}

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

type AbuseCase = Readonly<{
  owasp: string;
  rule: string;
  name: string;
  expected: number;
  /** BOPLA: campo que el esquema estricto debe señalar (evita que el 400 sea por otro motivo). */
  field?: string;
  send: (app: express.Express, f: Fixture) => request.Test;
}>;

const auth = (test: request.Test, token: string) => test.set("Authorization", `Bearer ${token}`);

/**
 * Matriz consolidada de abuso (#22) contra las rutas **reales**: cada fila es un vector OWASP API
 * Top 10 trazado a su regla de negocio. Cada caso verifica además que no hubo efecto en la base.
 */
const ABUSE_MATRIX: readonly AbuseCase[] = [
  // API3 — BOPLA / mass assignment (`z.strictObject`)
  { owasp: "API3 BOPLA", rule: "RN-08", name: "register con role", expected: 400, field: "role",
    send: (app) => request(app).post("/api/v1/auth/register").send({ email: "nuevo@recetaria.com", password: TEST_USER_PASSWORD, firstName: "Nueva", lastName: "Prueba", role: "ADMIN" }) },
  { owasp: "API3 BOPLA", rule: "RN-08", name: "register con isActive", expected: 400, field: "isActive",
    send: (app) => request(app).post("/api/v1/auth/register").send({ email: "nuevo@recetaria.com", password: TEST_USER_PASSWORD, firstName: "Nueva", lastName: "Prueba", isActive: true }) },
  { owasp: "API3 BOPLA", rule: "RN-01", name: "POST receta con status APPROVED", expected: 400, field: "status",
    send: (app, f) => auth(request(app).post("/api/v1/recipes"), tokenFor(f.author)).send({ ...VALID_RECIPE, status: "APPROVED" }) },
  { owasp: "API3 BOPLA", rule: "RN-01", name: "POST receta con authorId ajeno", expected: 400, field: "authorId",
    send: (app, f) => auth(request(app).post("/api/v1/recipes"), tokenFor(f.author)).send({ ...VALID_RECIPE, authorId: f.other.id }) },
  { owasp: "API3 BOPLA", rule: "RN-02", name: "PUT receta con reviewedById", expected: 400, field: "reviewedById",
    send: (app, f) => auth(request(app).put(`/api/v1/recipes/${f.authorRecipeId}`), tokenFor(f.author)).send({ reviewedById: f.chef.id }) },
  { owasp: "API3 BOPLA", rule: "RN-02", name: "PUT receta con slug", expected: 400, field: "slug",
    send: (app, f) => auth(request(app).put(`/api/v1/recipes/${f.authorRecipeId}`), tokenFor(f.author)).send({ slug: "otro-slug-0a1b2c3d" }) },
  { owasp: "API3 BOPLA", rule: "RN-02", name: "PUT receta con status APPROVED", expected: 400, field: "status",
    send: (app, f) => auth(request(app).put(`/api/v1/recipes/${f.authorRecipeId}`), tokenFor(f.author)).send({ status: "APPROVED" }) },
  { owasp: "API3 BOPLA", rule: "RN-02", name: "PUT receta con authorId ajeno", expected: 400, field: "authorId",
    send: (app, f) => auth(request(app).put(`/api/v1/recipes/${f.authorRecipeId}`), tokenFor(f.author)).send({ authorId: f.other.id }) },
  { owasp: "API3 BOPLA", rule: "RN-09", name: "PATCH /role con un campo extra", expected: 400, field: "isActive",
    send: (app, f) => auth(request(app).patch(`/api/v1/users/${f.other.id}/role`), tokenFor(f.admin)).send({ role: "CHEF", isActive: false }) },
  { owasp: "API3 BOPLA", rule: "RN-10", name: "PATCH /status con un campo extra", expected: 400, field: "role",
    send: (app, f) => auth(request(app).patch(`/api/v1/users/${f.other.id}/status`), tokenFor(f.admin)).send({ isActive: false, role: "ADMIN" }) },

  // API1 — BOLA (ownership)
  { owasp: "API1 BOLA", rule: "RN-02", name: "otro USER edita una receta ajena", expected: 403,
    send: (app, f) => auth(request(app).put(`/api/v1/recipes/${f.authorRecipeId}`), tokenFor(f.other)).send({ prepTimeMinutes: 99 }) },
  { owasp: "API1 BOLA", rule: "RN-02", name: "un CHEF edita una receta ajena", expected: 403,
    send: (app, f) => auth(request(app).put(`/api/v1/recipes/${f.authorRecipeId}`), tokenFor(f.chef)).send({ prepTimeMinutes: 99 }) },
  { owasp: "API1 BOLA", rule: "RN-02", name: "un ADMIN edita una receta ajena", expected: 403,
    send: (app, f) => auth(request(app).put(`/api/v1/recipes/${f.authorRecipeId}`), tokenFor(f.admin)).send({ prepTimeMinutes: 99 }) },
  { owasp: "API1 BOLA", rule: "RN-03", name: "otro USER borra una receta ajena", expected: 403,
    send: (app, f) => auth(request(app).delete(`/api/v1/recipes/${f.authorRecipeId}`), tokenFor(f.other)) },
  { owasp: "API1 BOLA", rule: "RN-03", name: "un NUTRITIONIST borra una receta ajena", expected: 403,
    send: (app, f) => auth(request(app).delete(`/api/v1/recipes/${f.authorRecipeId}`), tokenFor(f.nutri)) },

  { owasp: "API1 BOLA", rule: "RN-01", name: "GET /mine con ?authorId= ajeno (IDOR por query)", expected: 400, field: "authorId",
    send: (app, f) => auth(request(app).get(`/api/v1/recipes/mine?authorId=${f.author.id}`), tokenFor(f.other)) },

  // API5 — BFLA (funciones por rol)
  { owasp: "API5 BFLA", rule: "RN-04", name: "un USER aprueba", expected: 403,
    send: (app, f) => auth(request(app).put(`/api/v1/recipes/${f.authorRecipeId}/approve`), tokenFor(f.other)).set("If-Match", '"1"') },
  { owasp: "API5 BFLA", rule: "RN-04", name: "un ADMIN aprueba", expected: 403,
    send: (app, f) => auth(request(app).put(`/api/v1/recipes/${f.authorRecipeId}/approve`), tokenFor(f.admin)).set("If-Match", '"1"') },
  { owasp: "API5 BFLA", rule: "RN-09", name: "un USER se autopromueve a ADMIN", expected: 403,
    send: (app, f) => auth(request(app).patch(`/api/v1/users/${f.other.id}/role`), tokenFor(f.other)).send({ role: "ADMIN" }) },
  { owasp: "API5 BFLA", rule: "RN-09", name: "un CHEF cambia un rol", expected: 403,
    send: (app, f) => auth(request(app).patch(`/api/v1/users/${f.other.id}/role`), tokenFor(f.chef)).send({ role: "CHEF" }) },
  { owasp: "API5 BFLA", rule: "RN-10", name: "un NUTRITIONIST desactiva una cuenta", expected: 403,
    send: (app, f) => auth(request(app).patch(`/api/v1/users/${f.other.id}/status`), tokenFor(f.nutri)).send({ isActive: false }) },
  { owasp: "API5 BFLA", rule: "RN-10 (auto-modificación)", name: "un ADMIN se desactiva a sí mismo", expected: 403,
    send: (app, f) => auth(request(app).patch(`/api/v1/users/${f.admin.id}/status`), tokenFor(f.admin)).send({ isActive: false }) },

  { owasp: "API5 BFLA", rule: "RN-09/ADR-0009", name: "ADMIN degradado con JWT de ADMIN cambia un rol", expected: 403,
    send: (app, f) => auth(request(app).patch(`/api/v1/users/${f.other.id}/role`), sign({ id: f.degradedAdmin.id, role: "ADMIN" })).send({ role: "CHEF" }) },
  { owasp: "API2 Auth", rule: "RN-10/ADR-0009", name: "ADMIN desactivado con JWT vigente cambia un estado", expected: 401,
    send: (app, f) => auth(request(app).patch(`/api/v1/users/${f.other.id}/status`), sign({ id: f.inactiveAdmin.id, role: "ADMIN" })).send({ isActive: false }) },
  { owasp: "API5 BFLA", rule: "RN-04 (#46)", name: "un CHEF aprueba sin If-Match", expected: 428,
    send: (app, f) => auth(request(app).put(`/api/v1/recipes/${f.authorRecipeId}/approve`), tokenFor(f.chef)) },

  // Separación de funciones
  { owasp: "API5 BFLA", rule: "RN-05", name: "un CHEF aprueba su propia receta", expected: 403,
    send: (app, f) => auth(request(app).put(`/api/v1/recipes/${f.chefRecipeId}/approve`), tokenFor(f.chef)).set("If-Match", '"1"') },

  // API2 — autenticación rota / cuenta inactiva / manipulación de JWT
  { owasp: "API2 Auth", rule: "RN-08", name: "JWT vigente de una cuenta inactiva", expected: 401,
    send: (app, f) => auth(request(app).get("/api/v1/recipes/mine"), tokenFor(f.inactive)) },
  { owasp: "API2 JWT", rule: "RN-08", name: "alg: none", expected: 401,
    send: (app, f) => auth(request(app).post("/api/v1/recipes"), `${base64url({ alg: "none", typ: "JWT" })}.${base64url({ id: f.admin.id, role: "ADMIN", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })}.`).send(VALID_RECIPE) },
  { owasp: "API2 JWT", rule: "RN-08", name: "firma inválida", expected: 401,
    send: (app, f) => auth(request(app).delete(`/api/v1/recipes/${f.authorRecipeId}`), jwt.sign({ id: f.admin.id, role: "ADMIN" }, "secreto-ajeno-".repeat(4), { algorithm: "HS256", expiresIn: "1h" })) },
  { owasp: "API2 JWT", rule: "RN-08", name: "token expirado", expected: 401,
    send: (app, f) => auth(request(app).delete(`/api/v1/recipes/${f.authorRecipeId}`), sign({ id: f.admin.id, role: "ADMIN", iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 }, { algorithm: "HS256" })) },
  { owasp: "API2 JWT", rule: "RN-08", name: "algoritmo distinto de HS256 (HS512)", expected: 401,
    send: (app, f) => auth(request(app).delete(`/api/v1/recipes/${f.authorRecipeId}`), sign({ id: f.admin.id, role: "ADMIN" }, { algorithm: "HS512", expiresIn: "1h" })) },
  { owasp: "API2 JWT", rule: "RN-08 (#52)", name: "iat 10 años en el futuro con exp - iat ≤ 1d", expected: 401,
    send: (app, f) => {
      const iat = Math.floor(Date.now() / 1000) + 10 * 365 * 86_400;
      return auth(request(app).delete(`/api/v1/recipes/${f.authorRecipeId}`), sign({ id: f.admin.id, role: "ADMIN", iat, exp: iat + 3600 }, { algorithm: "HS256" }));
    } },
  { owasp: "API2 JWT", rule: "RN-08", name: "token sin exp", expected: 401,
    send: (app, f) => auth(request(app).delete(`/api/v1/recipes/${f.authorRecipeId}`), sign({ id: f.admin.id, role: "ADMIN" }, { algorithm: "HS256" })) },
  { owasp: "API2 JWT", rule: "RN-08", name: "esquema Basic en lugar de Bearer", expected: 401,
    send: (app, f) => request(app).delete(`/api/v1/recipes/${f.authorRecipeId}`).set("Authorization", `Basic ${Buffer.from("admin:password123").toString("base64")}`) },
  { owasp: "API2 JWT", rule: "RN-08", name: "claim id que no es UUID", expected: 401,
    send: (app) => auth(request(app).get("/api/v1/recipes/mine"), sign({ id: "1 OR 1=1", role: "ADMIN" })) },
  { owasp: "API2 JWT", rule: "RN-08", name: "token en la query string en vez del header", expected: 401,
    send: (app, f) => request(app).get(`/api/v1/recipes/mine?access_token=${tokenFor(f.author)}`) },
  { owasp: "API2 JWT", rule: "RN-08", name: "token en una cookie en vez del header", expected: 401,
    send: (app, f) => request(app).get("/api/v1/recipes/mine").set("Cookie", `token=${tokenFor(f.author)}`) },
  { owasp: "API2 JWT", rule: "ADR-0009", name: "claim role inflado (USER firmado como ADMIN) borra ajeno", expected: 403,
    send: (app, f) => auth(request(app).delete(`/api/v1/recipes/${f.authorRecipeId}`), sign({ id: f.other.id, role: "ADMIN" })) },
];

describe("E2E — matriz de abuso OWASP API Top 10 (#22)", () => {
  let db: Database;
  let app: express.Express;
  let fixture: Fixture;
  const exposure = createExposureRecorder([TEST_JWT_CONFIG.secret, TEST_USER_PASSWORD]);

  beforeAll(() => {
    db = getDatabase();
    app = buildApp({
      prisma: db.prisma,
      jwt: TEST_JWT_CONFIG,
      publicRateLimit: false,
      authRateLimit: false,
      onLog: () => undefined,
      onError: () => undefined,
    });
  });

  const truncate = () => truncateAll(db);

  beforeEach(async () => {
    await truncate();
    const seed = async (email: string, role: UserRole, isActive = true): Promise<Actor> => {
      const user = await createUserWithRole(db, { email, role, isActive });
      return { id: user.id, email: user.email, role };
    };
    const [author, other, chef, nutri, admin, inactive, degradedAdmin, inactiveAdmin] = await Promise.all([
      seed("autora@recetaria.com", "USER"),
      seed("otro@recetaria.com", "USER"),
      seed("chef@recetaria.com", "CHEF"),
      seed("nutri@recetaria.com", "NUTRITIONIST"),
      seed("admin@recetaria.com", "ADMIN"),
      seed("inactiva@recetaria.com", "USER", false),
      seed("ex-admin@recetaria.com", "USER"), // degradado: su JWT todavía dice ADMIN
      seed("admin-inactivo@recetaria.com", "ADMIN", false),
    ]);
    const recipe = (authorId: string, slug: string) =>
      db.prisma.recipe.create({ data: { ...VALID_RECIPE, slug, authorId }, select: { id: true } });
    const [authorRecipe, chefRecipe] = await Promise.all([
      recipe(author.id, "de-la-autora-0a1b2c3d"),
      recipe(chef.id, "del-chef-0a1b2c3d"),
    ]);
    fixture = { author, other, chef, nutri, admin, inactive, degradedAdmin, inactiveAdmin, authorRecipeId: authorRecipe.id, chefRecipeId: chefRecipe.id };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await truncate();
  });

  afterAll(async () => {
    try {
      exposure.assertNoSensitiveExposure();
    } finally {
      await disconnect();
    }
  });

  /** Estado observable completo: cualquier efecto de un intento de abuso lo cambia. */
  async function snapshot() {
    const [users, recipes, audits] = await Promise.all([
      db.prisma.user.findMany({ select: { id: true, role: true, isActive: true }, orderBy: { id: "asc" } }),
      db.prisma.recipe.findMany({
        select: { id: true, status: true, prepTimeMinutes: true, slug: true, authorId: true, reviewedById: true, version: true },
        orderBy: { id: "asc" },
      }),
      db.prisma.auditLog.count(),
    ]);
    return { users, recipes, audits };
  }

  it.each(ABUSE_MATRIX)("[$owasp · $rule] $name → $expected sin efecto en la base", async ({ expected, field, send }) => {
    // Arrange
    const before = await snapshot();

    // Act
    const res = await exposure.track(send(app, fixture));

    // Assert — status y sobre JSend de error exactos, y ningún cambio persistido
    expect(res.status).toBe(expected);
    expect(res.body).toMatchObject({ success: false, statusCode: expected });
    expect(typeof res.body.message).toBe("string");
    if (field !== undefined) {
      expect(res.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ field })]));
    }
    expect(await snapshot()).toEqual(before);
  });

  it("[API2 · RN-08] login: cuenta inactiva, contraseña errónea y email inexistente dan el mismo 401", async () => {
    // Act
    const attempt = (email: string, password: string) =>
      exposure.track(request(app).post("/api/v1/auth/login").send({ email, password }));
    const inactive = await attempt(fixture.inactive.email, TEST_USER_PASSWORD);
    const wrongPassword = await attempt(fixture.author.email, "contraseña-incorrecta");
    const unknown = await attempt("nadie@recetaria.com", TEST_USER_PASSWORD);

    // Assert — respuesta indistinguible (no enumera cuentas ni revela la suspensión)
    for (const res of [inactive, wrongPassword, unknown]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual(inactive.body);
    }
    expect(inactive.body.data).toBeUndefined();
  });

  it("[API8] un 500 real sale redactado: sin stack, sin mensaje interno", async () => {
    // Arrange
    // Se fuerza en el borde de Prisma (el único punto que la API no puede controlar); si el
    // repositorio dejara de usar `findMany`, la prueba fallaría con 200 y no en silencio.
    vi.spyOn(db.prisma.recipe, "findMany").mockRejectedValueOnce(new Error("detalle interno: relation recipes"));

    // Act
    const res = await exposure.track(request(app).get("/api/v1/recipes"));

    // Assert
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, statusCode: 500 });
    expect(res.text).not.toContain("detalle interno");
  });

  it("[API3/API8] ninguna respuesta exitosa con usuarios expone passwordHash", async () => {
    // Act — las respuestas que devuelven usuarios
    const register = await exposure.track(
      request(app).post("/api/v1/auth/register").send({ email: "nueva@recetaria.com", password: TEST_USER_PASSWORD, firstName: "Nueva", lastName: "Prueba" }),
    );
    const login = await exposure.track(
      request(app).post("/api/v1/auth/login").send({ email: fixture.author.email, password: TEST_USER_PASSWORD }),
    );
    const role = await exposure.track(
      auth(request(app).patch(`/api/v1/users/${fixture.other.id}/role`), tokenFor(fixture.admin)).send({ role: "CHEF" }),
    );
    const status = await exposure.track(
      auth(request(app).patch(`/api/v1/users/${randomUUID()}/status`), tokenFor(fixture.admin)).send({ isActive: false }),
    );

    // Assert — el recorder valida todas al cierre; aquí se fijan los status del camino feliz
    expect([register.status, login.status, role.status, status.status]).toEqual([201, 200, 200, 404]);
    exposure.assertNoSensitiveExposure();
  });
});
