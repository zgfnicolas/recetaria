import { describe, expect, it } from "vitest";
import {
  assertTestDatabaseName,
  databaseNameFromUrl,
  maintenanceDatabaseUrl,
  redactCredentials,
  resolveTestDatabaseUrl,
} from "./test-database.js";

describe("resolveTestDatabaseUrl — aislamiento de la base de pruebas", () => {
  it("deriva <base>_test de DATABASE_URL conservando host, credenciales y parámetros", () => {
    // Act
    const resolved = resolveTestDatabaseUrl({
      DATABASE_URL: "postgresql://postgres:secreto@localhost:5432/recetaria?schema=public",
    });

    // Assert
    expect(resolved).toEqual({
      url: "postgresql://postgres:secreto@localhost:5432/recetaria_test?schema=public",
      databaseName: "recetaria_test",
    });
  });

  it("conserva un nombre que ya termina en _test (no lo duplica)", () => {
    const resolved = resolveTestDatabaseUrl({ DATABASE_URL: "postgresql://u:p@db:5432/recetaria_test" });
    expect(resolved.databaseName).toBe("recetaria_test");
  });

  it("ignora una TEST_DATABASE_URL vacía o con espacios y vuelve a derivar", () => {
    const resolved = resolveTestDatabaseUrl({
      DATABASE_URL: "postgresql://u:p@localhost:5432/recetaria",
      TEST_DATABASE_URL: "   ",
    });
    expect(resolved.databaseName).toBe("recetaria_test");
  });

  it("prioriza TEST_DATABASE_URL cuando está definida", () => {
    const resolved = resolveTestDatabaseUrl({
      DATABASE_URL: "postgresql://u:p@localhost:5432/recetaria",
      TEST_DATABASE_URL: "postgresql://ci:ci@pg-ci:5432/ci_test",
    });
    expect(resolved).toEqual({ url: "postgresql://ci:ci@pg-ci:5432/ci_test", databaseName: "ci_test" });
  });

  it("rechaza una TEST_DATABASE_URL sin sufijo _test (fail closed: no se usa la base de desarrollo)", () => {
    expect(() =>
      resolveTestDatabaseUrl({ TEST_DATABASE_URL: "postgresql://u:p@localhost:5432/recetaria" }),
    ).toThrow(/termine en "_test"/);
  });

  it.each([
    ["sin DATABASE_URL", {}],
    ["DATABASE_URL vacía", { DATABASE_URL: "   " }],
    ["URL inválida", { DATABASE_URL: "no-es-una-url" }],
    ["URL sin nombre de base", { DATABASE_URL: "postgresql://u:p@localhost:5432/" }],
    ["nombre con mayúsculas", { DATABASE_URL: "postgresql://u:p@localhost:5432/Recetaria" }],
    ["nombre con guion (fail closed)", { DATABASE_URL: "postgresql://u:p@localhost:5432/recetaria-dev" }],
    ["nombre con inyección", { DATABASE_URL: "postgresql://u:p@localhost:5432/x%22%3B%20DROP%20DATABASE%20y" }],
  ])("aborta con %s", (_label, env) => {
    expect(() => resolveTestDatabaseUrl(env)).toThrow();
  });
});

describe("assertTestDatabaseName", () => {
  it.each(["recetaria_test", "ci_test", "app2_test"])("acepta %s", (name) => {
    expect(() => assertTestDatabaseName(name)).not.toThrow();
  });

  it.each(["recetaria", "recetaria_testing", "test", "_test_x", "", 'x"; DROP DATABASE y; --_test'])(
    "rechaza %j",
    (name) => {
      expect(() => assertTestDatabaseName(name)).toThrow();
    },
  );
});

describe("databaseNameFromUrl", () => {
  it("extrae el nombre de la base de la URL efectiva", () => {
    expect(databaseNameFromUrl("postgresql://u:p@localhost:5432/recetaria?schema=public")).toBe("recetaria");
  });

  it("lanza con una URL sin nombre de base", () => {
    expect(() => databaseNameFromUrl("postgresql://u:p@localhost:5432")).toThrow();
  });
});

describe("redactCredentials", () => {
  it("oculta la contraseña de las URLs de conexión en un mensaje", () => {
    expect(redactCredentials("Error en postgresql://app:Sup3r$ecreto@db:5432/x_test: timeout")).toBe(
      "Error en postgresql://app:***@db:5432/x_test: timeout",
    );
  });
});

describe("maintenanceDatabaseUrl", () => {
  it("apunta a la base postgres del mismo servidor sin el parámetro schema de Prisma", () => {
    expect(maintenanceDatabaseUrl("postgresql://u:p@localhost:5432/recetaria_test?schema=public")).toBe(
      "postgresql://u:p@localhost:5432/postgres",
    );
  });

  it("conserva parámetros de conexión como sslmode", () => {
    expect(maintenanceDatabaseUrl("postgresql://u:p@db:5432/app_test?schema=public&sslmode=require")).toBe(
      "postgresql://u:p@db:5432/postgres?sslmode=require",
    );
  });
});
