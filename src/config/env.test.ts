import { describe, expect, it, vi } from "vitest";
import { loadEnv, parseEnv, type EnvSource, type NodeEnv } from "./env.js";

const VALID_POSTGRES_URL = "postgresql://recetaria:devpass@localhost:5433/recetaria";
const VALID_JWT_SECRET = "s".repeat(32);

function createValidSource(overrides?: Partial<Record<string, string | undefined>>): EnvSource {
  return {
    DATABASE_URL: VALID_POSTGRES_URL,
    JWT_SECRET: VALID_JWT_SECRET,
    ...overrides,
  };
}

describe("parseEnv (validación fail-fast con Zod 4)", () => {
  it("aplica defaults para NODE_ENV, PORT y JWT_EXPIRES_IN y retorna un objeto congelado", () => {
    // Arrange
    const source = createValidSource();

    // Act
    const env = parseEnv(source);

    // Assert
    expect(env).toEqual({
      NODE_ENV: "development",
      PORT: 3000,
      DATABASE_URL: VALID_POSTGRES_URL,
      JWT_SECRET: VALID_JWT_SECRET,
      JWT_EXPIRES_IN: "1d",
    });
    expect(Object.isFrozen(env)).toBe(true);
    expect(Reflect.set(env, "PORT", 4000)).toBe(false);
    expect(() => {
      Object.assign(env, { PORT: 4000 });
    }).toThrow(TypeError);
    expect(env.PORT).toBe(3000);
  });

  it.each<{
    readonly label: string;
    readonly nodeEnv: NodeEnv;
    readonly port: string;
    readonly expectedPort: number;
    readonly databaseUrl: string;
    readonly expiresIn: string;
    readonly expectedExpiresIn: string;
  }>([
    {
      label: "test con postgres:// y puerto límite inferior 1",
      nodeEnv: "test",
      port: "1",
      expectedPort: 1,
      databaseUrl: "postgres://user:pass@127.0.0.1:5432/recetaria_test",
      expiresIn: "30s",
      expectedExpiresIn: "30s",
    },
    {
      label: "production con postgresql:// y puerto límite superior 65535",
      nodeEnv: "production",
      port: "65535",
      expectedPort: 65_535,
      databaseUrl: "postgresql://app:pass@db.internal:5432/recetaria?schema=public",
      expiresIn: "15m",
      expectedExpiresIn: "15m",
    },
    {
      label: "development con espacios alrededor en PORT y JWT_EXPIRES_IN",
      nodeEnv: "development",
      port: " 8080 ",
      expectedPort: 8080,
      databaseUrl: VALID_POSTGRES_URL,
      expiresIn: " 3600s ",
      expectedExpiresIn: "3600s",
    },
  ])(
    "acepta valores explícitos válidos ($label)",
    ({ nodeEnv, port, expectedPort, databaseUrl, expiresIn, expectedExpiresIn }) => {
      // Arrange
      const source = createValidSource({
        NODE_ENV: nodeEnv,
        PORT: port,
        DATABASE_URL: databaseUrl,
        JWT_EXPIRES_IN: expiresIn,
      });

      // Act
      const env = parseEnv(source);

      // Assert
      expect(env.NODE_ENV).toBe(nodeEnv);
      expect(env.PORT).toBe(expectedPort);
      expect(env.DATABASE_URL).toBe(databaseUrl);
      expect(env.JWT_EXPIRES_IN).toBe(expectedExpiresIn);
    },
  );

  it.each(["30s", "15m", "2h", "7d", "1w", "1y", "3600s"] as const)(
    "acepta duración JWT explícita válida (%s)",
    (duration) => {
      // Arrange
      const source = createValidSource({ JWT_EXPIRES_IN: duration });

      // Act
      const env = parseEnv(source);

      // Assert
      expect(env.JWT_EXPIRES_IN).toBe(duration);
    },
  );

  it.each([
    ["faltante", undefined],
    ["cadena vacía", ""],
    ["no es URL", "not-a-url"],
    ["protocolo mysql", "mysql://user:pass@localhost:3306/recetaria"],
    ["protocolo http", "http://localhost:5432/recetaria"],
    ["sin host", "postgresql:///recetaria"],
    ["sin nombre de base", "postgresql://localhost:5432"],
    ["barra final sin nombre de base", "postgresql://localhost:5432/"],
  ])("rechaza fail-fast DATABASE_URL inválida (%s)", (_label, databaseUrl) => {
    // Arrange
    const source = createValidSource({ DATABASE_URL: databaseUrl });

    // Act & Assert
    expect(() => parseEnv(source)).toThrow(/DATABASE_URL/);
  });

  it.each([
    ["faltante", undefined],
    ["cadena vacía", ""],
    ["longitud exacta 31", "a".repeat(31)],
    ["32 espacios en blanco", " ".repeat(32)],
    ["32 caracteres con solo 31 no vacíos", ` ${"a".repeat(31)}`],
    ["espacios internos dejando solo 2 caracteres", `a${" ".repeat(30)}b`],
  ])("rechaza fail-fast JWT_SECRET inválido (%s)", (_label, jwtSecret) => {
    // Arrange
    const source = createValidSource({ JWT_SECRET: jwtSecret });

    // Act & Assert
    expect(() => parseEnv(source)).toThrow(/JWT_SECRET/);
  });

  it.each(["staging", "", "PRODUCTION", "dev"])(
    "rechaza fail-fast NODE_ENV fuera de la lista permitida (%j)",
    (nodeEnv) => {
      // Arrange
      const source = createValidSource({ NODE_ENV: nodeEnv });

      // Act & Assert
      expect(() => parseEnv(source)).toThrow(/NODE_ENV/);
    },
  );

  it.each(["", "   ", "0", "65536", "-1", "3000.5", "abc", "0x10", "1e3"])(
    "rechaza fail-fast PORT inválido o no decimal entero (%j)",
    (port) => {
      // Arrange
      const source = createValidSource({ PORT: port });

      // Act & Assert
      expect(() => parseEnv(source)).toThrow(/PORT/);
    },
  );

  it.each([
    "",
    "0d",
    "-5m",
    "15min",
    "abc",
    "1.5h",
    "3600",
    "500ms",
    "1000000s",
    `${"1".repeat(101)}s`,
  ])("rechaza fail-fast JWT_EXPIRES_IN inválido o sin unidad (%j)", (expiresIn) => {
    // Arrange
    const source = createValidSource({ JWT_EXPIRES_IN: expiresIn });

    // Act & Assert
    expect(() => parseEnv(source)).toThrow(/JWT_EXPIRES_IN/);
  });

  it("nunca expone secretos ni credenciales al fallar protocolo de DATABASE_URL o longitud de JWT_SECRET", () => {
    // Arrange
    const secretMarker = "SHORT_JWT_MARKER_123";
    const dbSecretMarker = "DB_SECRET_MARKER_999";
    const source: EnvSource = {
      DATABASE_URL: `mysql://admin:${dbSecretMarker}@db.local:3306/app`,
      JWT_SECRET: secretMarker,
    };

    // Act
    let thrownMessage = "";
    try {
      parseEnv(source);
    } catch (err: unknown) {
      thrownMessage = err instanceof Error ? err.message : String(err);
    }

    // Assert
    expect(thrownMessage).toContain("DATABASE_URL");
    expect(thrownMessage).toContain("JWT_SECRET");
    expect(thrownMessage).not.toContain(secretMarker);
    expect(thrownMessage).not.toContain(dbSecretMarker);
  });

  it("nunca expone credenciales de DATABASE_URL cuando falla la validación de host o nombre de base", () => {
    // Arrange
    const dbSecretMarker = "DB_SECRET_MARKER_999";
    const source = createValidSource({
      DATABASE_URL: `postgresql://admin:${dbSecretMarker}@db.local:5432/`,
    });

    // Act
    let thrownMessage = "";
    try {
      parseEnv(source);
    } catch (err: unknown) {
      thrownMessage = err instanceof Error ? err.message : String(err);
    }

    // Assert
    expect(thrownMessage).toContain("DATABASE_URL");
    expect(thrownMessage).not.toContain(dbSecretMarker);
  });
});

describe("loadEnv", () => {
  it("lee y valida process.env con loadDotenv=false devolviendo un objeto congelado", () => {
    // Arrange
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("PORT", "4100");
    vi.stubEnv("DATABASE_URL", VALID_POSTGRES_URL);
    vi.stubEnv("JWT_SECRET", VALID_JWT_SECRET);
    vi.stubEnv("JWT_EXPIRES_IN", "2h");

    // Act
    const env = loadEnv({ loadDotenv: false });

    // Assert
    expect(env).toEqual({
      NODE_ENV: "test",
      PORT: 4100,
      DATABASE_URL: VALID_POSTGRES_URL,
      JWT_SECRET: VALID_JWT_SECRET,
      JWT_EXPIRES_IN: "2h",
    });
    expect(Object.isFrozen(env)).toBe(true);
  });

  it("ejecuta la carga por defecto (loadDotenv implícito) y retorna la configuración congelada", () => {
    // Arrange
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("PORT", "4200");
    vi.stubEnv("DATABASE_URL", VALID_POSTGRES_URL);
    vi.stubEnv("JWT_SECRET", VALID_JWT_SECRET);
    vi.stubEnv("JWT_EXPIRES_IN", "1d");

    // Act
    const env = loadEnv();

    // Assert
    expect(env).toEqual({
      NODE_ENV: "test",
      PORT: 4200,
      DATABASE_URL: VALID_POSTGRES_URL,
      JWT_SECRET: VALID_JWT_SECRET,
      JWT_EXPIRES_IN: "1d",
    });
    expect(Object.isFrozen(env)).toBe(true);
  });

  it("aborta fail-fast cuando process.env tiene un JWT_SECRET inválido", () => {
    // Arrange
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("PORT", "3000");
    vi.stubEnv("DATABASE_URL", VALID_POSTGRES_URL);
    vi.stubEnv("JWT_SECRET", "INVALID_STUB_SECRET");
    vi.stubEnv("JWT_EXPIRES_IN", "1d");

    // Act & Assert
    expect(() => loadEnv({ loadDotenv: false })).toThrow(/JWT_SECRET/);
  });

  it("aborta fail-fast cuando JWT_SECRET está ausente en process.env", () => {
    // Arrange
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("PORT", "3000");
    vi.stubEnv("DATABASE_URL", VALID_POSTGRES_URL);
    vi.stubEnv("JWT_SECRET", undefined);
    vi.stubEnv("JWT_EXPIRES_IN", "1d");

    // Act & Assert
    expect(() => loadEnv({ loadDotenv: false })).toThrow(/JWT_SECRET/);
  });
});
