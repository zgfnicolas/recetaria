import { describe, expect, it } from "vitest";
import { loginSchema, MAX_BCRYPT_PASSWORD_BYTES, registerSchema } from "./auth.schema.js";

const EXPECTED_MVP_ROLES = ["USER", "CHEF", "NUTRITIONIST", "ADMIN"] as const;

describe("registerSchema (Zod 4 strictObject / BOPLA)", () => {
  it("acepta un payload válido, normaliza email/nombres, preserva password y aplica role 'USER' por defecto", () => {
    // Arrange
    const rawPayload = {
      email: "  Ana.Chef@Recetaria.COM  ",
      password: "  Cl4ve con espac1os  ",
      firstName: "  Ana María  ",
      lastName: "  Pérez  ",
    };

    // Act
    const parsed = registerSchema.safeParse(rawPayload);

    // Assert
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        email: "ana.chef@recetaria.com",
        password: "  Cl4ve con espac1os  ",
        firstName: "Ana María",
        lastName: "Pérez",
        role: "USER",
      });
    }
  });

  it.each(EXPECTED_MVP_ROLES)("acepta el rol explícito %s según docs/roles.md", (role) => {
    // Arrange
    const payload = {
      email: `${role.toLowerCase()}@recetaria.com`,
      password: "password123",
      firstName: "Usuario",
      lastName: "Valido",
      role,
    };

    // Act
    const parsed = registerSchema.safeParse(payload);

    // Assert
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.role).toBe(role);
    }
  });

  it("acepta fronteras válidas (email 255 chars, nombres 100 chars, password 8 chars y 72 bytes UTF-8)", () => {
    // Arrange
    const exact255Email = `${"a".repeat(60)}@${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(7)}.com`;
    const exact72Utf8Bytes = "á".repeat(36);
    const exact100Name = "n".repeat(100);

    // Act
    const boundaryResult = registerSchema.safeParse({
      email: exact255Email,
      password: exact72Utf8Bytes,
      firstName: exact100Name,
      lastName: "a".repeat(100),
    });
    const minPasswordResult = registerSchema.safeParse({
      email: "min@recetaria.com",
      password: "12345678",
      firstName: "Lu",
      lastName: "Sa",
    });

    // Assert
    expect(MAX_BCRYPT_PASSWORD_BYTES).toBe(72);
    expect(exact255Email).toHaveLength(255);
    expect(Buffer.byteLength(exact72Utf8Bytes, "utf8")).toBe(72);
    expect(boundaryResult.success).toBe(true);
    expect(minPasswordResult.success).toBe(true);
  });

  it("rechaza payload vacío reportando email, password, firstName y lastName", () => {
    // Arrange
    const emptyPayload = {};

    // Act
    const parsed = registerSchema.safeParse(emptyPayload);

    // Assert
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => String(issue.path[0]));
      expect(fields).toEqual(
        expect.arrayContaining(["email", "password", "firstName", "lastName"]),
      );
    }
  });

  it.each([
    {
      label: "email malformado",
      payload: {
        email: "no-es-email",
        password: "password123",
        firstName: "Ana",
        lastName: "López",
      },
      expectedField: "email",
      expectedMessage: "Formato de email inválido",
    },
    {
      label: "email de 256 caracteres",
      payload: {
        email: `${"a".repeat(60)}@${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(8)}.com`,
        password: "password123",
        firstName: "Ana",
        lastName: "López",
      },
      expectedField: "email",
      expectedMessage: "El correo electrónico no puede superar los 255 caracteres",
    },
    {
      label: "contraseña menor a 8 caracteres",
      payload: {
        email: "ana@recetaria.com",
        password: "1234567",
        firstName: "Ana",
        lastName: "López",
      },
      expectedField: "password",
      expectedMessage: "La contraseña debe tener al menos 8 caracteres",
    },
    {
      label: "contraseña ASCII de 73 bytes",
      payload: {
        email: "ana@recetaria.com",
        password: "a".repeat(73),
        firstName: "Ana",
        lastName: "López",
      },
      expectedField: "password",
      expectedMessage: "La contraseña no puede superar los 72 bytes UTF-8",
    },
    {
      label: "contraseña UTF-8 multi-byte de 74 bytes (37 caracteres)",
      payload: {
        email: "ana@recetaria.com",
        password: "á".repeat(37),
        firstName: "Ana",
        lastName: "López",
      },
      expectedField: "password",
      expectedMessage: "La contraseña no puede superar los 72 bytes UTF-8",
    },
    {
      label: "firstName menor a 2 caracteres tras trim",
      payload: {
        email: "ana@recetaria.com",
        password: "password123",
        firstName: "   A   ",
        lastName: "Pérez",
      },
      expectedField: "firstName",
      expectedMessage: "El nombre debe tener al menos 2 caracteres",
    },
    {
      label: "lastName solo espacios tras trim",
      payload: {
        email: "ana@recetaria.com",
        password: "password123",
        firstName: "Ana",
        lastName: "   ",
      },
      expectedField: "lastName",
      expectedMessage: "El apellido debe tener al menos 2 caracteres",
    },
    {
      label: "firstName > 100 caracteres",
      payload: {
        email: "ana@recetaria.com",
        password: "password123",
        firstName: "x".repeat(101),
        lastName: "Pérez",
      },
      expectedField: "firstName",
      expectedMessage: "El nombre no puede superar los 100 caracteres",
    },
    {
      label: "lastName > 100 caracteres",
      payload: {
        email: "ana@recetaria.com",
        password: "password123",
        firstName: "Ana",
        lastName: "y".repeat(101),
      },
      expectedField: "lastName",
      expectedMessage: "El apellido no puede superar los 100 caracteres",
    },
    {
      label: "rol fuera de catálogo (SUPERADMIN)",
      payload: {
        email: "ana@recetaria.com",
        password: "password123",
        firstName: "Ana",
        lastName: "Pérez",
        role: "SUPERADMIN",
      },
      expectedField: "role",
      expectedMessage: "Rol inválido",
    },
    {
      label: "rol en minúsculas fuera de enum (user)",
      payload: {
        email: "ana@recetaria.com",
        password: "password123",
        firstName: "Ana",
        lastName: "Pérez",
        role: "user",
      },
      expectedField: "role",
      expectedMessage: "Rol inválido",
    },
  ])(
    "rechaza $label reportando campo y mensaje exacto",
    ({ payload, expectedField, expectedMessage }) => {
      // Arrange
      const candidate = payload;

      // Act
      const parsed = registerSchema.safeParse(candidate);

      // Assert
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: [expectedField],
              message: expectedMessage,
            }),
          ]),
        );
      }
    },
  );

  it.each([
    { label: "email numérico", payload: { email: 123, password: "password123", firstName: "Ana", lastName: "Pérez" } },
    { label: "password null", payload: { email: "ana@recetaria.com", password: null, firstName: "Ana", lastName: "Pérez" } },
    { label: "role null", payload: { email: "ana@recetaria.com", password: "password123", firstName: "Ana", lastName: "Pérez", role: null } },
    { label: "raíz null", payload: null },
    { label: "raíz array", payload: [] },
    { label: "raíz string", payload: "texto" },
  ])("rechaza tipos inválidos y raíces no-objeto ($label)", ({ payload }) => {
    // Arrange
    const candidate = payload;

    // Act
    const parsed = registerSchema.safeParse(candidate);

    // Assert
    expect(parsed.success).toBe(false);
  });

  it("rechaza propiedades extra protegidas (prevención BOPLA con z.strictObject)", () => {
    // Arrange
    const boplaPayload = {
      email: "atacante@recetaria.com",
      password: "password123",
      firstName: "Eva",
      lastName: "Tester",
      isActive: false,
      id: "550e8400-e29b-41d4-a716-446655440000",
      passwordHash: "$2b$10$fakesalt",
      createdAt: "2026-11-22T00:00:00.000Z",
    };

    // Act
    const parsed = registerSchema.safeParse(boplaPayload);

    // Assert
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const unrecognizedIssue = parsed.error.issues.find(
        (issue) => issue.code === "unrecognized_keys",
      );
      expect(unrecognizedIssue).toBeDefined();
      if (unrecognizedIssue?.code === "unrecognized_keys") {
        expect(unrecognizedIssue.keys).toEqual(
          expect.arrayContaining(["isActive", "id", "passwordHash", "createdAt"]),
        );
      }
    }
  });
});

describe("loginSchema (Zod 4 strictObject / BOPLA)", () => {
  it("acepta payload válido, normaliza email, preserva espacios en password y acepta bordes válidos", () => {
    // Arrange
    const exact255Email = `${"a".repeat(60)}@${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(7)}.com`;

    // Act
    const validWithSpaces = loginSchema.safeParse({
      email: "  User.Test@Recetaria.COM  ",
      password: "  test password spaces  ",
    });
    const validMinBoundary = loginSchema.safeParse({
      email: exact255Email,
      password: "x",
    });

    // Assert
    expect(validWithSpaces.success).toBe(true);
    if (validWithSpaces.success) {
      expect(validWithSpaces.data).toEqual({
        email: "user.test@recetaria.com",
        password: "  test password spaces  ",
      });
    }
    expect(exact255Email).toHaveLength(255);
    expect(validMinBoundary.success).toBe(true);
  });

  it("rechaza payload vacío reportando email y password", () => {
    // Arrange
    const emptyPayload = {};

    // Act
    const parsed = loginSchema.safeParse(emptyPayload);

    // Assert
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => String(issue.path[0]));
      expect(fields).toEqual(expect.arrayContaining(["email", "password"]));
    }
  });

  it.each([
    {
      label: "email faltante",
      payload: { password: "password123" },
      expectedField: "email",
      expectedMessage: "El correo electrónico es obligatorio",
    },
    {
      label: "email malformado",
      payload: { email: "no-es-email", password: "password123" },
      expectedField: "email",
      expectedMessage: "Formato de email inválido",
    },
    {
      label: "email de solo espacios",
      payload: { email: "   ", password: "password123" },
      expectedField: "email",
      expectedMessage: "Formato de email inválido",
    },
    {
      label: "email de 256 caracteres",
      payload: {
        email: `${"a".repeat(60)}@${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(8)}.com`,
        password: "password123",
      },
      expectedField: "email",
      expectedMessage: "El correo electrónico no puede superar los 255 caracteres",
    },
    {
      label: "contraseña vacía",
      payload: { email: "user@recetaria.com", password: "" },
      expectedField: "password",
      expectedMessage: "La contraseña es obligatoria",
    },
  ])(
    "rechaza $label reportando campo y mensaje exacto",
    ({ payload, expectedField, expectedMessage }) => {
      // Arrange
      const candidate = payload;

      // Act
      const parsed = loginSchema.safeParse(candidate);

      // Assert
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: [expectedField],
              message: expectedMessage,
            }),
          ]),
        );
      }
    },
  );

  it.each([
    { label: "email numérico", payload: { email: 123, password: "password123" } },
    { label: "password null", payload: { email: "user@recetaria.com", password: null } },
    { label: "raíz null", payload: null },
    { label: "raíz array", payload: [] },
    { label: "raíz string", payload: "texto" },
  ])("rechaza tipos erróneos y raíces no-objeto ($label)", ({ payload }) => {
    // Arrange
    const candidate = payload;

    // Act
    const parsed = loginSchema.safeParse(candidate);

    // Assert
    expect(parsed.success).toBe(false);
  });

  it("rechaza propiedades extra no permitidas (prevención BOPLA con z.strictObject)", () => {
    // Arrange
    const boplaPayload = {
      email: "user@recetaria.com",
      password: "password123",
      role: "ADMIN",
      isActive: true,
      rememberMe: true,
      id: "550e8400-e29b-41d4-a716-446655440000",
    };

    // Act
    const parsed = loginSchema.safeParse(boplaPayload);

    // Assert
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const unrecognizedIssue = parsed.error.issues.find(
        (issue) => issue.code === "unrecognized_keys",
      );
      expect(unrecognizedIssue).toBeDefined();
      if (unrecognizedIssue?.code === "unrecognized_keys") {
        expect(unrecognizedIssue.keys).toEqual(
          expect.arrayContaining(["role", "isActive", "rememberMe", "id"]),
        );
      }
    }
  });
});
