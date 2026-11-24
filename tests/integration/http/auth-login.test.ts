import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../src/app.js";
import {
  disconnect,
  getDatabase,
  type Database,
} from "../../../src/infrastructure/database/prisma.js";
import { UserRepository, type JwtConfig } from "../../../src/modules/auth/index.js";
import { createUserWithRole } from "../../support/users.js";

const EXPECTED_MVP_ROLES = ["USER", "CHEF", "NUTRITIONIST", "ADMIN"] as const;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const JWT_COMPACT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const TEST_JWT_CONFIG: JwtConfig = {
  secret: "test-jwt-secret-".repeat(3),
  expiresIn: "1h",
};

async function truncateTables(db: Database): Promise<void> {
  await db.prisma.$executeRaw`TRUNCATE TABLE "audit_logs", "recipes", "users" RESTART IDENTITY;`;
}

describe("POST /api/v1/auth/login — Integración HTTP (Supertest + PostgreSQL 15)", () => {
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

  it.each(EXPECTED_MVP_ROLES)(
    "autentica usuario activo con rol %s, emite JWT HS256 stateless y Cache-Control no-store sin exponer secretos (RN-08)",
    async (role) => {
      // Arrange
      const logs: string[] = [];
      const onError = vi.fn();
      const app = buildApp({
        prisma: db.prisma,
        jwt: TEST_JWT_CONFIG,
        onLog: (line) => logs.push(line),
        onError,
      });
      const email = `${role.toLowerCase()}@recetaria.com`;
      const password = "test-password-example";

      // Roles privilegiados: solo por seed (#48, ADR-0007); `USER` por el registro público real
      const registered =
        role === "USER"
          ? await request(app)
              .post("/api/v1/auth/register")
              .send({ email, password, firstName: "Usuario", lastName: "Activo" })
              .then((res) => {
                expect(res.status).toBe(201);
                return { id: String(res.body.data.id) };
              })
          : await createUserWithRole(db, { email, role, password, lastName: "Activo" });

      // Act
      const loginRes = await request(app).post("/api/v1/auth/login").send({
        email: `  ${email.toUpperCase()}  `,
        password,
      });

      // Assert HTTP, headers y JSend
      expect(onError).not.toHaveBeenCalled();
      expect(loginRes.status).toBe(200);
      expect(loginRes.headers["x-powered-by"]).toBeUndefined();
      expect(loginRes.headers["cache-control"]).toBe("no-store");
      expect(loginRes.body).toEqual({
        success: true,
        statusCode: 200,
        message: "Inicio de sesión exitoso",
        data: {
          token: expect.stringMatching(JWT_COMPACT_PATTERN),
          user: {
            id: expect.stringMatching(UUID_V4_PATTERN),
            email,
            role,
          },
        },
      });
      expect(Object.keys(loginRes.body.data).sort()).toEqual(["token", "user"]);
      expect(Object.keys(loginRes.body.data.user).sort()).toEqual(["email", "id", "role"]);
      expect("passwordHash" in loginRes.body.data.user).toBe(false);

      // Assert no-fuga en respuesta y logs
      const issuedToken: string = loginRes.body.data.token;
      // USER: register + login; roles sembrados: solo login
      expect(logs).toHaveLength(role === "USER" ? 2 : 1);
      expect(logs.join("\n")).not.toContain(password);
      expect(logs.join("\n")).not.toContain(issuedToken);
      expect(logs.join("\n")).not.toContain("$2b$");
      expect(loginRes.text).not.toContain(password);
      expect(loginRes.text).not.toContain("passwordHash");
      expect(loginRes.text).not.toContain("$2b$");

      // Assert verificación criptográfica real del JWT emitido
      const decodedComplete = jwt.decode(issuedToken, { complete: true });
      const verified = jwt.verify(issuedToken, TEST_JWT_CONFIG.secret, {
        algorithms: ["HS256"],
      });

      expect(decodedComplete?.header.alg).toBe("HS256");
      expect(typeof verified).toBe("object");
      expect(verified).not.toBeNull();
      if (typeof verified === "object" && verified !== null) {
        expect(Object.keys(verified).sort()).toEqual(["exp", "iat", "id", "role"]);
        expect(verified["id"]).toBe(registered.id);
        expect(verified["role"]).toBe(role);
        expect(typeof verified.iat).toBe("number");
        expect(typeof verified.exp).toBe("number");
        if (typeof verified.iat === "number" && typeof verified.exp === "number") {
          expect(verified.exp - verified.iat).toBe(3600);
        }
      }
      expect(() =>
        jwt.verify(issuedToken, "wrong-jwt-secret-".repeat(3), { algorithms: ["HS256"] }),
      ).toThrow();
    },
  );

  it("devuelve exactamente el mismo 401 Unauthorized genérico ante email inexistente, contraseña incorrecta o cuenta inactiva (RN-08)", async () => {
    // Arrange
    const logs: string[] = [];
    const onError = vi.fn();
    const app = buildApp({
      prisma: db.prisma,
      jwt: TEST_JWT_CONFIG,
      onLog: (line) => logs.push(line),
      onError,
    });
    const activePassword = "active-password-test";
    const inactivePassword = "inactive-password-test";
    const wrongPassword = "wrong-password-test";

    const activeRes = await request(app).post("/api/v1/auth/register").send({
      email: "activo@recetaria.com",
      password: activePassword,
      firstName: "Usuario",
      lastName: "Activo",
    });
    const inactiveRes = await request(app).post("/api/v1/auth/register").send({
      email: "inactivo@recetaria.com",
      password: inactivePassword,
      firstName: "Usuario",
      lastName: "Inactivo",
    });
    expect(activeRes.status).toBe(201);
    expect(inactiveRes.status).toBe(201);

    await db.prisma.user.update({
      where: { id: inactiveRes.body.data.id },
      data: { isActive: false },
    });

    // Act
    const missingUserRes = await request(app).post("/api/v1/auth/login").send({
      email: "no-existe@recetaria.com",
      password: wrongPassword,
    });
    const wrongPasswordRes = await request(app).post("/api/v1/auth/login").send({
      email: "activo@recetaria.com",
      password: wrongPassword,
    });
    const inactiveUserRes = await request(app).post("/api/v1/auth/login").send({
      email: "inactivo@recetaria.com",
      password: inactivePassword,
    });

    // Assert: los 3 casos producen exactamente la misma respuesta 401 JSend
    expect(onError).not.toHaveBeenCalled();
    expect(logs).toHaveLength(5);
    expect(logs.join("\n")).not.toContain(activePassword);
    expect(logs.join("\n")).not.toContain(inactivePassword);
    expect(logs.join("\n")).not.toContain(wrongPassword);
    expect(logs.join("\n")).not.toContain("$2b$");

    for (const res of [missingUserRes, wrongPasswordRes, inactiveUserRes]) {
      expect(res.status).toBe(401);
      expect(res.headers["x-powered-by"]).toBeUndefined();
      expect(res.body).toEqual({
        success: false,
        statusCode: 401,
        message: "Credenciales inválidas",
        errors: [],
      });
    }
    expect(wrongPasswordRes.body).toEqual(missingUserRes.body);
    expect(inactiveUserRes.body).toEqual(missingUserRes.body);
  });

  it.each([
    {
      label: "ASCII 72 bytes vs 73 bytes",
      email: "limite72-ascii@recetaria.com",
      exact72: "a".repeat(72),
      overlong: `${"a".repeat(72)}X`,
    },
    {
      label: "UTF-8 multi-byte 36 chars (72 bytes) vs 37 chars (74 bytes)",
      email: "limite72-utf8@recetaria.com",
      exact72: "á".repeat(36),
      overlong: "á".repeat(37),
    },
  ])(
    "evita bypass por truncado de Bcrypt ($label): acepta 72 bytes con 200 y rechaza > 72 bytes con 401 (RN-08)",
    async ({ email, exact72, overlong }) => {
      // Arrange
      expect(Buffer.byteLength(exact72, "utf8")).toBe(72);
      expect(Buffer.byteLength(overlong, "utf8")).toBeGreaterThan(72);
      const app = buildApp({
        prisma: db.prisma,
        jwt: TEST_JWT_CONFIG,
        onLog: vi.fn(),
        onError: vi.fn(),
      });

      const registerRes = await request(app).post("/api/v1/auth/register").send({
        email,
        password: exact72,
        firstName: "Limite",
        lastName: "Bcrypt",
      });
      expect(registerRes.status).toBe(201);

      // Act
      const exactOkRes = await request(app).post("/api/v1/auth/login").send({
        email,
        password: exact72,
      });
      const truncatedAttemptRes = await request(app).post("/api/v1/auth/login").send({
        email,
        password: overlong,
      });

      // Assert
      expect(exactOkRes.status).toBe(200);
      expect(truncatedAttemptRes.status).toBe(401);
      expect(truncatedAttemptRes.body).toEqual({
        success: false,
        statusCode: 401,
        message: "Credenciales inválidas",
        errors: [],
      });
    },
  );

  it("preserva espacios laterales en password: retorna 200 con espacios exactos y 401 si se omiten", async () => {
    // Arrange
    const app = buildApp({
      prisma: db.prisma,
      jwt: TEST_JWT_CONFIG,
      onLog: vi.fn(),
      onError: vi.fn(),
    });
    const spacedPassword = "  test password spaces  ";

    const registerRes = await request(app).post("/api/v1/auth/register").send({
      email: "espacios@recetaria.com",
      password: spacedPassword,
      firstName: "Espacios",
      lastName: "Prueba",
    });
    expect(registerRes.status).toBe(201);

    // Act
    const exactRes = await request(app).post("/api/v1/auth/login").send({
      email: "espacios@recetaria.com",
      password: spacedPassword,
    });
    const trimmedRes = await request(app).post("/api/v1/auth/login").send({
      email: "espacios@recetaria.com",
      password: spacedPassword.trim(),
    });

    // Assert
    expect(exactRes.status).toBe(200);
    expect(exactRes.body.data.token).toMatch(JWT_COMPACT_PATTERN);
    expect(exactRes.body.data.user.email).toBe("espacios@recetaria.com");
    expect(trimmedRes.status).toBe(401);
    expect(trimmedRes.body).toEqual({
      success: false,
      statusCode: 401,
      message: "Credenciales inválidas",
      errors: [],
    });
  });

  it("rechaza con 400 Bad Request body vacío {} o petición sin cuerpo", async () => {
    // Arrange
    const logs: string[] = [];
    const onError = vi.fn();
    const app = buildApp({
      prisma: db.prisma,
      jwt: TEST_JWT_CONFIG,
      onLog: (line) => logs.push(line),
      onError,
    });

    // Act
    const emptyObjectRes = await request(app).post("/api/v1/auth/login").send({});
    const noBodyRes = await request(app).post("/api/v1/auth/login");

    // Assert
    expect(onError).not.toHaveBeenCalled();
    expect(logs).toHaveLength(2);
    for (const res of [emptyObjectRes, noBodyRes]) {
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.statusCode).toBe(400);
      expect(res.body.message).toBe("Error de validación");
      expect(res.body.errors.map((e: { field: string }) => e.field)).toEqual(
        expect.arrayContaining(["email", "password"]),
      );
    }
  });

  it("rechaza con 400 Bad Request email inválido y contraseña vacía", async () => {
    // Arrange
    const logs: string[] = [];
    const onError = vi.fn();
    const app = buildApp({
      prisma: db.prisma,
      jwt: TEST_JWT_CONFIG,
      onLog: (line) => logs.push(line),
      onError,
    });

    // Act
    const invalidRes = await request(app).post("/api/v1/auth/login").send({
      email: "correo-invalido",
      password: "",
    });

    // Assert
    expect(onError).not.toHaveBeenCalled();
    expect(logs).toHaveLength(1);
    expect(invalidRes.status).toBe(400);
    expect(invalidRes.body).toEqual({
      success: false,
      statusCode: 400,
      message: "Error de validación",
      errors: [
        { field: "email", message: "Formato de email inválido" },
        { field: "password", message: "La contraseña es obligatoria" },
      ],
    });
  });

  it("rechaza con 400 Bad Request propiedades extra (BOPLA) sin filtrar contraseña en logs", async () => {
    // Arrange
    const logs: string[] = [];
    const onError = vi.fn();
    const app = buildApp({
      prisma: db.prisma,
      jwt: TEST_JWT_CONFIG,
      onLog: (line) => logs.push(line),
      onError,
    });
    const sentinelPassword = "test-bopla-password";

    // Act
    const boplaRes = await request(app).post("/api/v1/auth/login").send({
      email: "bopla@recetaria.com",
      password: sentinelPassword,
      role: "ADMIN",
      isActive: true,
      rememberMe: true,
    });

    // Assert
    expect(onError).not.toHaveBeenCalled();
    expect(logs).toHaveLength(1);
    expect(logs.join("\n")).not.toContain(sentinelPassword);
    expect(boplaRes.status).toBe(400);
    expect(boplaRes.text).not.toContain(sentinelPassword);
    expect(boplaRes.body.errors).toEqual(
      expect.arrayContaining([
        { field: "role", message: "Campo no permitido" },
        { field: "isActive", message: "Campo no permitido" },
        { field: "rememberMe", message: "Campo no permitido" },
      ]),
    );
  });

  it("rechaza con 400 Bad Request JSON malformado", async () => {
    // Arrange
    const logs: string[] = [];
    const onError = vi.fn();
    const app = buildApp({
      prisma: db.prisma,
      jwt: TEST_JWT_CONFIG,
      onLog: (line) => logs.push(line),
      onError,
    });

    // Act
    const malformedJsonRes = await request(app)
      .post("/api/v1/auth/login")
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
  });

  it("falla cerrado con 500 JSend redactado si POST /api/v1/auth/login se monta sin configuración JWT", async () => {
    // Arrange
    const onError = vi.fn();
    const appWithoutJwt = buildApp({
      prisma: db.prisma,
      onLog: vi.fn(),
      onError,
    });

    // Act
    const res = await request(appWithoutJwt).post("/api/v1/auth/login").send({
      email: "usuario@recetaria.com",
      password: "password123",
    });

    // Assert
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      success: false,
      statusCode: 500,
      message: "Error interno del servidor",
      errors: [],
    });
    expect(res.text).not.toContain("Configuración JWT");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe("[NON_OPERATIONAL_ERROR]");
  });

  it("UserRepository.findAuthByEmail expone hash para autenticación mientras findByEmail continúa omitiendo passwordHash", async () => {
    // Arrange
    const repository = new UserRepository(db.prisma);
    const created = await repository.create({
      email: "authrepo@recetaria.com",
      passwordHash: "$2b$10$EpRnTzVlqHNP0.fUbXUwSOyuiXe/QLSUG6xNekdHgTGmrpHEfIoxm",
      firstName: "Auth",
      lastName: "Repo",
      role: "CHEF",
    });

    // Act
    const authRecord = await repository.findAuthByEmail("authrepo@recetaria.com");
    const publicRecord = await repository.findByEmail("authrepo@recetaria.com");
    const publicById = await repository.findById(created.id);
    const missingAuth = await repository.findAuthByEmail("ausente@recetaria.com");

    // Assert
    expect("passwordHash" in created).toBe(false);
    expect(authRecord).toEqual({
      id: created.id,
      email: "authrepo@recetaria.com",
      role: "CHEF",
      isActive: true,
      passwordHash: "$2b$10$EpRnTzVlqHNP0.fUbXUwSOyuiXe/QLSUG6xNekdHgTGmrpHEfIoxm",
    });
    expect(publicRecord).toEqual(created);
    expect(publicRecord !== null && "passwordHash" in publicRecord).toBe(false);
    expect(publicById).toEqual(created);
    expect(publicById !== null && "passwordHash" in publicById).toBe(false);
    expect(missingAuth).toBeNull();
  });
});
