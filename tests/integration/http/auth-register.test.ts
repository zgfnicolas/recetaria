import * as bcrypt from "bcrypt";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../src/app.js";
import {
  disconnect,
  getDatabase,
  type Database,
} from "../../../src/infrastructure/database/prisma.js";
import { DEFAULT_SEED_PASSWORD, SEED_USERS, seedUsers } from "../../../prisma/seed.js";
import { UserRepository } from "../../../src/modules/auth/index.js";
import { ConflictError } from "../../../src/shared/errors/app-error.js";
import { truncateAll } from "../../support/database.js";

const EXPECTED_MVP_ROLES = ["USER", "CHEF", "NUTRITIONIST", "ADMIN"] as const;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function truncateTables(db: Database): Promise<void> {
  await truncateAll(db);
}

describe("POST /api/v1/auth/register — Integración HTTP (Supertest + PostgreSQL 15)", () => {
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

  it("registra un usuario válido con rol 'USER' por defecto, Bcrypt >= 10 en PostgreSQL y sin exponer secretos ni hashes (RN-08)", async () => {
    // Arrange
    const logs: string[] = [];
    const onError = vi.fn();
    const app = buildApp({
      prisma: db.prisma,
      onLog: (line) => logs.push(line),
      onError,
    });
    const plainPassword = "MiClaveSecreta!2026";

    // Act
    const res = await request(app).post("/api/v1/auth/register").send({
      email: "  Nuevo.Usuario@Recetaria.COM  ",
      password: plainPassword,
      firstName: "  Lucía  ",
      lastName: "  Fernández  ",
    });

    // Assert HTTP, JSend y no-fuga en logs
    expect(onError).not.toHaveBeenCalled();
    expect(res.status).toBe(201);
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.body).toEqual({
      success: true,
      statusCode: 201,
      message: "Usuario registrado exitosamente",
      data: {
        id: expect.stringMatching(UUID_V4_PATTERN),
        email: "nuevo.usuario@recetaria.com",
        role: "USER",
      },
    });
    expect(Object.keys(res.body.data).sort()).toEqual(["email", "id", "role"]);
    expect(logs).toHaveLength(1);
    expect(logs.join("\n")).not.toContain(plainPassword);
    expect(logs.join("\n")).not.toContain("$2b$");
    expect(res.text).not.toContain(plainPassword);
    expect(res.text).not.toContain("passwordHash");
    expect(res.text).not.toContain("$2b$");

    // Assert consulta por defecto (omit) y verificación real con hash en PostgreSQL 15
    const defaultUser = await db.prisma.user.findUnique({ where: { id: res.body.data.id } });
    expect(defaultUser).not.toBeNull();
    if (defaultUser !== null) {
      expect("passwordHash" in defaultUser).toBe(false);
    }

    const persisted = await db.prisma.user.findUnique({
      where: { id: res.body.data.id },
      omit: { passwordHash: false },
    });
    expect(persisted).not.toBeNull();
    if (persisted !== null) {
      expect(res.text).not.toContain(persisted.passwordHash);
      expect(persisted.email).toBe("nuevo.usuario@recetaria.com");
      expect(persisted.firstName).toBe("Lucía");
      expect(persisted.lastName).toBe("Fernández");
      expect(persisted.role).toBe("USER");
      expect(persisted.isActive).toBe(true);
      expect(persisted.passwordHash).not.toBe(plainPassword);
      expect(bcrypt.getRounds(persisted.passwordHash)).toBeGreaterThanOrEqual(10);
      expect(await bcrypt.compare(plainPassword, persisted.passwordHash)).toBe(true);
    }
  });

  it.each([...EXPECTED_MVP_ROLES, "ROOT", null, ["ADMIN"]])(
    "rechaza role = %j con 400 \"Campo no permitido\" sin crear el usuario, incluido USER (BFLA, #48)",
    async (role) => {
      // Arrange
      const app = buildApp({ prisma: db.prisma, onLog: vi.fn(), onError: vi.fn() });

      // Act
      const res = await request(app).post("/api/v1/auth/register").send({
        email: "escalada@recetaria.com",
        password: "CentinelaRole!2026",
        firstName: "Perfil",
        lastName: "RoleTest",
        role,
      });

      // Assert — mismo sobre BOPLA que cualquier clave extra; no enumera los roles existentes
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        success: false,
        statusCode: 400,
        message: "Error de validación",
        errors: [{ field: "role", message: "Campo no permitido" }],
      });
      expect(JSON.stringify(res.body)).not.toMatch(/CHEF|NUTRITIONIST|ADMIN/);
      expect(await db.prisma.user.count()).toBe(0);
    },
  );

  it.each(["Role", "ROLE", "isActive", "passwordHash", "id"])(
    "rechaza la clave protegida %s en el registro (mass assignment) sin crear el usuario",
    async (key) => {
      // Arrange
      const app = buildApp({ prisma: db.prisma, onLog: vi.fn(), onError: vi.fn() });

      // Act
      const res = await request(app).post("/api/v1/auth/register").send({
        email: "masiva@recetaria.com",
        password: "CentinelaRole!2026",
        firstName: "Perfil",
        lastName: "Masivo",
        [key]: key === "isActive" ? false : "ADMIN",
      });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.errors).toEqual([{ field: key, message: "Campo no permitido" }]);
      expect(await db.prisma.user.count()).toBe(0);
    },
  );

  it.each([
    ["__proto__ con role", '{"email":"proto@recetaria.com","password":"CentinelaRole!2026","firstName":"Pro","lastName":"To","__proto__":{"role":"ADMIN"}}', "__proto__"],
    ["constructor con role", '{"email":"proto@recetaria.com","password":"CentinelaRole!2026","firstName":"Pro","lastName":"To","constructor":{"prototype":{"role":"ADMIN"}}}', "constructor"],
  ])("rechaza %s en el body sin contaminar prototipos ni crear el usuario", async (_label, rawBody, key) => {
    // Arrange
    const app = buildApp({ prisma: db.prisma, onLog: vi.fn(), onError: vi.fn() });

    // Act
    const res = await request(app)
      .post("/api/v1/auth/register")
      .set("Content-Type", "application/json")
      .send(rawBody);

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual([{ field: key, message: "Campo no permitido" }]);
    expect(({} as Record<string, unknown>)["role"]).toBeUndefined();
    expect(await db.prisma.user.count()).toBe(0);
  });

  it("ignora ?role=ADMIN en la query: el registro crea igual un USER", async () => {
    // Arrange
    const app = buildApp({ prisma: db.prisma, onLog: vi.fn(), onError: vi.fn() });

    // Act
    const res = await request(app)
      .post("/api/v1/auth/register?role=ADMIN")
      .send({ email: "query@recetaria.com", password: "CentinelaRole!2026", firstName: "Que", lastName: "Ry" });

    // Assert
    expect(res.status).toBe(201);
    expect(res.body.data.role).toBe("USER");
    const persisted = await db.prisma.user.findUniqueOrThrow({ where: { email: "query@recetaria.com" } });
    expect(persisted.role).toBe("USER");
  });

  it("los 4 usuarios del seed siguen pudiendo iniciar sesión con su rol (único camino a roles privilegiados)", async () => {
    // Arrange
    const app = buildApp({
      prisma: db.prisma,
      jwt: { secret: "test-jwt-secret-".repeat(3), expiresIn: "1h" },
      authRateLimit: false,
      onLog: vi.fn(),
      onError: vi.fn(),
    });
    await seedUsers(db.prisma);

    // Act
    const sessions = await Promise.all(
      SEED_USERS.map(async (user) => ({
        expected: user.role,
        res: await request(app)
          .post("/api/v1/auth/login")
          .send({ email: user.email, password: DEFAULT_SEED_PASSWORD }),
      })),
    );

    // Assert
    expect(sessions).toHaveLength(4);
    for (const { expected, res } of sessions) {
      expect(res.status).toBe(200);
      expect(res.body.data.user.role).toBe(expected);
    }
    expect(new Set(sessions.map((session) => session.expected))).toEqual(
      new Set(["USER", "CHEF", "NUTRITIONIST", "ADMIN"]),
    );
  });

  it("de punta a punta: un intento de auto-asignarse ADMIN nunca obtiene privilegios (BFLA, #48)", async () => {
    // Arrange — receta ajena en DRAFT para intentar operaciones privilegiadas
    const app = buildApp({
      prisma: db.prisma,
      jwt: { secret: "test-jwt-secret-".repeat(3), expiresIn: "1h" },
      publicRateLimit: false,
      authRateLimit: false,
      onLog: vi.fn(),
      onError: vi.fn(),
    });
    const owner = await db.prisma.user.create({
      data: {
        email: "duena@recetaria.com",
        passwordHash: await bcrypt.hash("password-duena", 10),
        firstName: "Dueña",
        lastName: "Receta",
      },
    });
    const recipe = await db.prisma.recipe.create({
      data: {
        title: "Receta ajena",
        slug: "receta-ajena-0a1b2c3d",
        description: "Receta de otra persona para el intento de escalada.",
        prepTimeMinutes: 10,
        ingredients: [{ name: "Sal", quantity: 1, unit: "g" }],
        authorId: owner.id,
      },
    });
    const credentials = { email: "atacante@recetaria.com", password: "CentinelaRole!2026" };

    // Act
    const escalation = await request(app)
      .post("/api/v1/auth/register")
      .send({ ...credentials, firstName: "Ata", lastName: "Cante", role: "ADMIN" });
    const plainRegister = await request(app)
      .post("/api/v1/auth/register")
      .send({ ...credentials, firstName: "Ata", lastName: "Cante" });
    const login = await request(app).post("/api/v1/auth/login").send(credentials);
    const token = String(login.body.data.token);
    const deleteRes = await request(app)
      .delete(`/api/v1/recipes/${recipe.id}`)
      .set("Authorization", `Bearer ${token}`);
    const approveRes = await request(app)
      .put(`/api/v1/recipes/${recipe.id}/approve`)
      .set("Authorization", `Bearer ${token}`)
      // Sin efecto en el resultado: rbacMiddleware rechaza al USER antes de evaluar If-Match (#46)
      .set("If-Match", '"1"');

    // Assert
    expect(escalation.status).toBe(400);
    expect(plainRegister.status).toBe(201);
    expect(plainRegister.body.data.role).toBe("USER");
    expect(login.status).toBe(200);
    expect(login.body.data.user.role).toBe("USER");
    const [, payloadSegment] = token.split(".");
    expect(JSON.parse(Buffer.from(payloadSegment ?? "", "base64url").toString("utf8"))).toMatchObject({
      role: "USER",
    });
    expect(deleteRes.status).toBe(403);
    expect(approveRes.status).toBe(403);
    expect(await db.prisma.recipe.count({ where: { id: recipe.id } })).toBe(1);
    const persisted = await db.prisma.user.findUniqueOrThrow({ where: { email: credentials.email } });
    expect(persisted.role).toBe("USER");
  });

  it("rechaza con 409 Conflict el registro de un email ya existente sin exponer contraseñas en respuesta ni logs (RN-08)", async () => {
    // Arrange
    const logs: string[] = [];
    const onError = vi.fn();
    const app = buildApp({ prisma: db.prisma, onLog: (line) => logs.push(line), onError });
    const firstPassword = "PrimeraCentinela!2026";
    const secondPassword = "SegundaCentinela!2026";

    const first = await request(app).post("/api/v1/auth/register").send({
      email: "existente@recetaria.com",
      password: firstPassword,
      firstName: "Primero",
      lastName: "Registro",
    });
    expect(first.status).toBe(201);

    // Act
    const duplicate = await request(app).post("/api/v1/auth/register").send({
      email: "  EXISTENTE@Recetaria.COM ",
      password: secondPassword,
      firstName: "Segundo",
      lastName: "Intento",
    });

    // Assert
    expect(onError).not.toHaveBeenCalled();
    expect(duplicate.status).toBe(409);
    expect(duplicate.headers["x-powered-by"]).toBeUndefined();
    expect(duplicate.body).toEqual({
      success: false,
      statusCode: 409,
      message: "El correo electrónico ya está registrado",
      errors: [],
    });
    expect(logs).toHaveLength(2);
    expect(logs.join("\n")).not.toContain(firstPassword);
    expect(logs.join("\n")).not.toContain(secondPassword);
    expect(logs.join("\n")).not.toContain("$2b$");
    expect(duplicate.text).not.toContain(secondPassword);
    expect(await db.prisma.user.count()).toBe(1);
  });

  it("resuelve registros concurrentes con el mismo email garantizando JSend 201 ganador, 409 (P2002) y única fila coincidente en PostgreSQL (RN-08)", async () => {
    // Arrange
    const onError = vi.fn();
    const app = buildApp({ prisma: db.prisma, onLog: vi.fn(), onError });
    const payload = {
      email: "concurrente@recetaria.com",
      password: "password123",
      firstName: "Carrera",
      lastName: "Registro",
    };

    // Act
    const [resA, resB] = await Promise.all([
      request(app).post("/api/v1/auth/register").send(payload),
      request(app).post("/api/v1/auth/register").send(payload),
    ]);

    // Assert
    expect(onError).not.toHaveBeenCalled();
    const responses = [resA, resB].sort((left, right) => left.status - right.status);
    expect(responses.map((item) => item.status)).toEqual([201, 409]);

    const winnerResponse = responses[0];
    const conflictResponse = responses[1];
    expect(winnerResponse).toBeDefined();
    expect(conflictResponse).toBeDefined();

    if (winnerResponse !== undefined && conflictResponse !== undefined) {
      expect(winnerResponse.body).toEqual({
        success: true,
        statusCode: 201,
        message: "Usuario registrado exitosamente",
        data: {
          id: expect.stringMatching(UUID_V4_PATTERN),
          email: "concurrente@recetaria.com",
          role: "USER",
        },
      });
      expect("passwordHash" in winnerResponse.body.data).toBe(false);
      expect(conflictResponse.body).toEqual({
        success: false,
        statusCode: 409,
        message: "El correo electrónico ya está registrado",
        errors: [],
      });

      const persistedWinner = await db.prisma.user.findUnique({
        where: { id: winnerResponse.body.data.id },
      });
      expect(persistedWinner).not.toBeNull();
    }
    expect(await db.prisma.user.count()).toBe(1);
  });

  it("rechaza con 400 Bad Request body vacío {} o petición sin cuerpo sin persistir usuarios", async () => {
    // Arrange
    const logs: string[] = [];
    const onError = vi.fn();
    const app = buildApp({ prisma: db.prisma, onLog: (line) => logs.push(line), onError });

    // Act
    const emptyObjectRes = await request(app).post("/api/v1/auth/register").send({});
    const noBodyRes = await request(app).post("/api/v1/auth/register");

    // Assert
    expect(onError).not.toHaveBeenCalled();
    expect(logs).toHaveLength(2);
    for (const res of [emptyObjectRes, noBodyRes]) {
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.statusCode).toBe(400);
      expect(res.body.message).toBe("Error de validación");
      expect(res.body.errors.map((e: { field: string }) => e.field)).toEqual(
        expect.arrayContaining(["email", "password", "firstName", "lastName"]),
      );
    }
    expect(await db.prisma.user.count()).toBe(0);
  });

  it("rechaza con 400 Bad Request campos inválidos (Zod) y contraseñas > 72 bytes UTF-8 sin filtrar contraseña en logs", async () => {
    // Arrange
    const logs: string[] = [];
    const onError = vi.fn();
    const app = buildApp({ prisma: db.prisma, onLog: (line) => logs.push(line), onError });
    const sentinelShortPassword = "C3n";

    // Act
    const invalidFieldsRes = await request(app).post("/api/v1/auth/register").send({
      email: "invalido",
      password: sentinelShortPassword,
      firstName: "A",
      lastName: " ",
      role: "ROOT",
    });

    const overlongBytesPasswordRes = await request(app)
      .post("/api/v1/auth/register")
      .send({
        email: "utf8@recetaria.com",
        password: "á".repeat(37),
        firstName: "Usuario",
        lastName: "Utf8",
      });

    // Assert
    expect(onError).not.toHaveBeenCalled();
    expect(logs).toHaveLength(2);
    expect(logs.join("\n")).not.toContain(sentinelShortPassword);
    expect(logs.join("\n")).not.toContain("á".repeat(10));

    expect(invalidFieldsRes.status).toBe(400);
    expect(invalidFieldsRes.body.success).toBe(false);
    expect(invalidFieldsRes.body.statusCode).toBe(400);
    expect(invalidFieldsRes.body.message).toBe("Error de validación");
    expect(invalidFieldsRes.body.errors.map((e: { field: string }) => e.field)).toEqual(
      expect.arrayContaining(["email", "password", "firstName", "lastName", "role"]),
    );

    expect(overlongBytesPasswordRes.status).toBe(400);
    expect(overlongBytesPasswordRes.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "password",
          message: "La contraseña no puede superar los 72 bytes UTF-8",
        }),
      ]),
    );
    expect(await db.prisma.user.count()).toBe(0);
  });

  it("rechaza con 400 Bad Request campos protegidos (prevención BOPLA) sin filtrar contraseña en logs ni respuesta", async () => {
    // Arrange
    const logs: string[] = [];
    const onError = vi.fn();
    const app = buildApp({ prisma: db.prisma, onLog: (line) => logs.push(line), onError });
    const sentinelPassword = "CentinelaSecreta!2026";

    // Act
    const boplaRes = await request(app).post("/api/v1/auth/register").send({
      email: "bopla@recetaria.com",
      password: sentinelPassword,
      firstName: "Eva",
      lastName: "Atacante",
      isActive: false,
      id: "550e8400-e29b-41d4-a716-446655440000",
      passwordHash: "$2b$10$fakesalt",
    });

    // Assert
    expect(onError).not.toHaveBeenCalled();
    expect(logs).toHaveLength(1);
    expect(logs.join("\n")).not.toContain(sentinelPassword);
    expect(boplaRes.status).toBe(400);
    expect(boplaRes.text).not.toContain(sentinelPassword);
    expect(boplaRes.body.errors).toEqual(
      expect.arrayContaining([
        { field: "isActive", message: "Campo no permitido" },
        { field: "id", message: "Campo no permitido" },
        { field: "passwordHash", message: "Campo no permitido" },
      ]),
    );
    expect(await db.prisma.user.count()).toBe(0);
  });

  it("rechaza con 400 Bad Request JSON malformado antes de invocar lógica de negocio", async () => {
    // Arrange
    const logs: string[] = [];
    const onError = vi.fn();
    const app = buildApp({ prisma: db.prisma, onLog: (line) => logs.push(line), onError });

    // Act
    const malformedJsonRes = await request(app)
      .post("/api/v1/auth/register")
      .set("Content-Type", "application/json")
      .send('{"email": roto');

    // Assert
    expect(onError).not.toHaveBeenCalled();
    expect(logs).toHaveLength(1);
    expect(malformedJsonRes.status).toBe(400);
    expect(malformedJsonRes.body).toEqual({
      success: false,
      statusCode: 400,
      message: "JSON inválido en el cuerpo de la solicitud",
      errors: [],
    });
    expect(await db.prisma.user.count()).toBe(0);
  });

  it("UserRepository proyecta sin passwordHash, retorna null cuando no existe, mapea P2002 con cause y propaga errores distintos", async () => {
    // Arrange
    const repository = new UserRepository(db.prisma);
    const created = await repository.create({
      email: "repo@recetaria.com",
      passwordHash: "$2b$10$EpRnTzVlqHNP0.fUbXUwSOyuiXe/QLSUG6xNekdHgTGmrpHEfIoxm",
      firstName: "Repo",
      lastName: "Prueba",
      role: "USER",
    });

    // Act
    const byEmail = await repository.findByEmail("repo@recetaria.com");
    const missingByEmail = await repository.findByEmail("ausente@recetaria.com");
    const byId = await repository.findById(created.id);
    const missingById = await repository.findById("00000000-0000-4000-8000-000000000000");

    let duplicateErr: unknown;
    try {
      await repository.create({
        email: "repo@recetaria.com",
        passwordHash: "$2b$10$EpRnTzVlqHNP0.fUbXUwSOyuiXe/QLSUG6xNekdHgTGmrpHEfIoxm",
        firstName: "Repo",
        lastName: "Duplicado",
        role: "USER",
      });
    } catch (err: unknown) {
      duplicateErr = err;
    }

    let nonUniqueErr: unknown;
    try {
      await repository.create({
        email: "largo@recetaria.com",
        passwordHash: "$2b$10$EpRnTzVlqHNP0.fUbXUwSOyuiXe/QLSUG6xNekdHgTGmrpHEfIoxm",
        firstName: "x".repeat(150),
        lastName: "Valido",
        role: "USER",
      });
    } catch (err: unknown) {
      nonUniqueErr = err;
    }

    // Assert
    expect("passwordHash" in created).toBe(false);
    expect(byEmail).toEqual(created);
    expect(byId).toEqual(created);
    expect(byEmail !== null && "passwordHash" in byEmail).toBe(false);
    expect(missingByEmail).toBeNull();
    expect(missingById).toBeNull();

    expect(duplicateErr).toBeInstanceOf(ConflictError);
    if (duplicateErr instanceof ConflictError) {
      expect(duplicateErr.statusCode).toBe(409);
      expect(duplicateErr.cause).toBeDefined();
    }

    expect(nonUniqueErr).toBeDefined();
    expect(nonUniqueErr).not.toBeInstanceOf(ConflictError);
  });
});
