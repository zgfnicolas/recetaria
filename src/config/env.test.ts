import express from "express";
import { describe, expect, it, vi } from "vitest";
import {
  describeTrustProxy,
  loadEnv,
  MAX_TRUST_PROXY_HOPS,
  parseEnv,
  type EnvSource,
  type NodeEnv,
} from "./env.js";

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
      TRUST_PROXY: 0,
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

  it.each(["30s", "15m", "2h", "3600s", "86400s", "1440m", "24h", "1d"] as const)(
    "acepta duración JWT explícita válida hasta el tope de 1d (%s)",
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
    expect(() => parseEnv(source)).not.toThrow(/no puede superar/);
    if (expiresIn.trim() !== "") {
      expect(() => parseEnv(source)).toThrow(/formato válido con unidad explícita/);
    }
  });

  it.each(["86401s", "1441m", "25h", "2d", "7d", "1w", "1y", "999999y"])(
    "rechaza fail-fast JWT_EXPIRES_IN = %s por superar el tope de 1d, con mensaje explícito (#52)",
    (expiresIn) => {
      // Arrange
      const source = createValidSource({ JWT_EXPIRES_IN: expiresIn });

      // Act
      let message = "";
      try {
        parseEnv(source);
      } catch (err: unknown) {
        message = err instanceof Error ? err.message : String(err);
      }

      // Assert — distingue "excede el tope" de "formato inválido" y no filtra otras variables
      expect(message).toContain("JWT_EXPIRES_IN no puede superar 1d (86400 s)");
      expect(message).not.toContain("formato válido");
      expect(message).not.toContain(VALID_JWT_SECRET);
      expect(message).not.toContain(VALID_POSTGRES_URL);
    },
  );

  it("aplica el mismo tope en todos los entornos (también en development y test)", () => {
    for (const nodeEnv of ["development", "test", "production"]) {
      expect(() => parseEnv(createValidSource({ NODE_ENV: nodeEnv, JWT_EXPIRES_IN: "2d" }))).toThrow(
        /no puede superar 1d/,
      );
    }
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

describe("parseEnv — TRUST_PROXY (#38)", () => {
  function captureEnvError(trustProxy: string): string {
    try {
      parseEnv(createValidSource({ TRUST_PROXY: trustProxy }));
    } catch (err: unknown) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error(`Se esperaba que TRUST_PROXY=${JSON.stringify(trustProxy)} fuera rechazado`);
  }

  it.each([undefined, "", "   ", "0"])(
    "interpreta %j como 0 (no confiar en X-Forwarded-For, comportamiento previo)",
    (value) => {
      // Act
      const env = parseEnv(createValidSource({ TRUST_PROXY: value }));

      // Assert
      expect(env.TRUST_PROXY).toBe(0);
    },
  );

  it.each([
    ["1", 1],
    [" 2 ", 2],
    [String(MAX_TRUST_PROXY_HOPS), MAX_TRUST_PROXY_HOPS],
  ])("acepta el número de saltos %j como %d", (value, expected) => {
    expect(parseEnv(createValidSource({ TRUST_PROXY: value })).TRUST_PROXY).toBe(expected);
  });

  const ACCEPTED_TRUST_PROXY_LISTS = [
    ["10.0.0.1", "10.0.0.1"],
    [" 10.0.0.0/8 , loopback ", "10.0.0.0/8,loopback"],
    ["172.16.0.0/12,192.168.0.0/16", "172.16.0.0/12,192.168.0.0/16"],
    ["::1,fd00::/16,2001:db8::/32", "::1,fd00::/16,2001:db8::/32"],
    ["loopback,linklocal,uniquelocal", "loopback,linklocal,uniquelocal"],
    ["10.0.0.0/32", "10.0.0.0/32"],
    ["10.0.0.0/08", "10.0.0.0/08"],
    ["fe80::1%eth0", "fe80::1%eth0"],
    ["::ffff:10.0.0.0/104", "::ffff:10.0.0.0/104"],
  ] as const;

  it.each(ACCEPTED_TRUST_PROXY_LISTS)(
    "acepta la lista de confianza %j normalizada como %j",
    (value, expected) => {
      expect(parseEnv(createValidSource({ TRUST_PROXY: value })).TRUST_PROXY).toBe(expected);
    },
  );

  it.each([
    ...ACCEPTED_TRUST_PROXY_LISTS.map(([value]) => value),
    "",
    "1",
    String(MAX_TRUST_PROXY_HOPS),
  ])("todo valor aceptado (%j) también lo acepta Express en trust proxy sin lanzar", (value) => {
    // Arrange
    const setting = parseEnv(createValidSource({ TRUST_PROXY: value })).TRUST_PROXY;
    const app = express();

    // Act / Assert
    expect(() => app.set("trust proxy", setting)).not.toThrow();
  });

  it.each(["true", "TRUE", " True ", "false", "FALSE"])(
    "rechaza %j explicando que true permite falsificar X-Forwarded-For",
    (value) => {
      // Act
      const message = captureEnvError(value);

      // Assert
      expect(message).toContain("TRUST_PROXY no admite true/false");
      expect(message).toContain("falsificar X-Forwarded-For");
    },
  );

  it.each([
    "0.0.0.0/0",
    "::/0",
    "10.0.0.1,0.0.0.0/00",
    "loopback, ::/0",
    "0.0.0.0/1",
    "0.0.0.0/1,128.0.0.0/1",
    "10.0.0.0/7",
    "::ffff:0:0/96",
    "::ffff:0.0.0.0/96",
    "0:0:0:0:0:ffff:0:0/96",
    "::ffff:10.0.0.0/103",
    "2000::/15",
    "fd00::/8",
  ])("rechaza el rango demasiado amplio %j (equivalente en la práctica a true)", (value) => {
    expect(captureEnvError(value)).toContain(
      "TRUST_PROXY no admite rangos más amplios que /8 en IPv4 ni /16 en IPv6",
    );
  });

  it.each(["11", "99"])("rechaza %j por superar el máximo de saltos", (value) => {
    expect(captureEnvError(value)).toContain(
      `TRUST_PROXY admite como máximo ${String(MAX_TRUST_PROXY_HOPS)} saltos de proxy`,
    );
  });

  it.each([
    "-1",
    "1.5",
    "1e1",
    "abc",
    "999.1.1.1",
    "10.0.0",
    "10.0.0.0/33",
    "10.0.0.0/-1",
    "10.0.0.0/",
    "10.0.0.0/8/1",
    "10.0.0.0/255.0.0.0",
    "::1/129",
    "gggg::1",
    "localhost",
    "loopback,,10.0.0.1",
    "10.0.0.1,",
    "Loopback",
  ])("rechaza el valor inválido %j con mensaje de formatos válidos", (value) => {
    // Act
    const message = captureEnvError(value);

    // Assert
    expect(message).toContain("TRUST_PROXY debe ser un número de saltos (0-10)");
    expect(message).toContain("loopback, linklocal, uniquelocal");
  });

  it("no expone secretos del entorno cuando TRUST_PROXY es inválido", () => {
    // Arrange
    const secretMarker = "JWT_SECRET_MARKER_".repeat(3);

    // Act
    let message = "";
    try {
      parseEnv({ DATABASE_URL: VALID_POSTGRES_URL, JWT_SECRET: secretMarker, TRUST_PROXY: "true" });
    } catch (err: unknown) {
      message = err instanceof Error ? err.message : String(err);
    }

    // Assert
    expect(message).toContain("TRUST_PROXY");
    expect(message).not.toContain(secretMarker);
    expect(message).not.toContain("devpass");
  });

  it.each([
    [0, "desactivado (se ignora X-Forwarded-For)"],
    [1, "1 salto de proxy"],
    [3, "3 saltos de proxy"],
    ["10.0.0.0/8,loopback", "direcciones de confianza 10.0.0.0/8,loopback"],
  ])("describeTrustProxy(%j) = %j para el log de arranque", (setting, expected) => {
    expect(describeTrustProxy(setting)).toBe(expected);
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
    vi.stubEnv("TRUST_PROXY", "");

    // Act
    const env = loadEnv({ loadDotenv: false });

    // Assert
    expect(env).toEqual({
      NODE_ENV: "test",
      PORT: 4100,
      DATABASE_URL: VALID_POSTGRES_URL,
      JWT_SECRET: VALID_JWT_SECRET,
      JWT_EXPIRES_IN: "2h",
      TRUST_PROXY: 0,
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
    vi.stubEnv("TRUST_PROXY", "");

    // Act
    const env = loadEnv();

    // Assert
    expect(env).toEqual({
      NODE_ENV: "test",
      PORT: 4200,
      DATABASE_URL: VALID_POSTGRES_URL,
      JWT_SECRET: VALID_JWT_SECRET,
      JWT_EXPIRES_IN: "1d",
      TRUST_PROXY: 0,
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
