/**
 * Aislamiento de la base de datos de pruebas: las suites nunca usan la base de `DATABASE_URL`
 * (la de desarrollo), sino una base hermana con sufijo `_test`, creada y migrada por
 * `tests/setup/global-database.ts`. Cualquier nombre sin el sufijo aborta (*fail closed*).
 */

/** Nombre de base válido para pruebas: identificador seguro (minúsculas, dígitos, `_`) que termina en `_test`. */
const TEST_DATABASE_NAME = /^[a-z0-9_]+_test$/;

export const TEST_DATABASE_SUFFIX = "_test";

export type TestDatabase = Readonly<{ url: string; databaseName: string }>;

type DatabaseEnv = Readonly<Record<string, string | undefined>>;

/** Lanza si `name` no es un nombre de base de pruebas; también lo vuelve seguro para `CREATE DATABASE`. */
export function assertTestDatabaseName(name: string): void {
  if (!TEST_DATABASE_NAME.test(name)) {
    throw new Error(
      `Las pruebas solo se ejecutan contra una base cuyo nombre termine en "${TEST_DATABASE_SUFFIX}" ` +
        `(minúsculas, dígitos y "_"); se recibió "${name}". Ninguna prueba se ejecutó ni se borró ningún dato.`,
    );
  }
}

/** Nombre de la base de una URL de conexión (lanza si no tiene uno). */
export function databaseNameFromUrl(raw: string): string {
  return databaseNameOf(parseUrl(raw, "DATABASE_URL"));
}

function databaseNameOf(url: URL): string {
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (name === "" || name.includes("/")) {
    throw new Error("La URL de base de datos debe incluir un único nombre de base (…/recetaria)");
  }
  return name;
}

function parseUrl(raw: string, variable: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new Error(`${variable} no es una URL válida de PostgreSQL`);
  }
}

/**
 * Resuelve la base de pruebas:
 * - `TEST_DATABASE_URL`, si está definida, se usa tal cual (debe terminar en `_test`);
 * - si no, se deriva de `DATABASE_URL` cambiando solo el nombre de la base (`recetaria` →
 *   `recetaria_test`) y conservando host, credenciales y parámetros (`?schema=public`).
 */
export function resolveTestDatabaseUrl(env: DatabaseEnv): TestDatabase {
  const explicit = env["TEST_DATABASE_URL"]?.trim();
  if (explicit !== undefined && explicit !== "") {
    const url = parseUrl(explicit, "TEST_DATABASE_URL");
    const databaseName = databaseNameOf(url);
    assertTestDatabaseName(databaseName);
    return { url: url.toString(), databaseName };
  }

  const base = env["DATABASE_URL"]?.trim();
  if (base === undefined || base === "") {
    throw new Error("DATABASE_URL (o TEST_DATABASE_URL) es obligatoria para las pruebas de integración");
  }
  const url = parseUrl(base, "DATABASE_URL");
  const current = databaseNameOf(url);
  const databaseName = current.endsWith(TEST_DATABASE_SUFFIX) ? current : `${current}${TEST_DATABASE_SUFFIX}`;
  assertTestDatabaseName(databaseName);
  url.pathname = `/${databaseName}`;
  return { url: url.toString(), databaseName };
}

/**
 * URL de la base de mantenimiento `postgres` del mismo servidor (para `CREATE DATABASE`). Conserva
 * los parámetros de conexión (p. ej. `sslmode`) y quita solo `schema`, que es exclusivo de Prisma.
 */
export function maintenanceDatabaseUrl(testUrl: string): string {
  const url = new URL(testUrl);
  url.pathname = "/postgres";
  url.searchParams.delete("schema");
  return url.toString();
}

/** Oculta la contraseña de cualquier URL de conexión dentro de un texto (mensajes de error). */
export function redactCredentials(text: string): string {
  return text.replace(/(postgres(?:ql)?:\/\/[^:/@\s]+:)[^@\s]+@/gi, "$1***@");
}

/** URL para el driver `pg`: la misma conexión sin `schema` (parámetro exclusivo de Prisma). */
export function driverDatabaseUrl(testUrl: string): string {
  const url = new URL(testUrl);
  url.searchParams.delete("schema");
  return url.toString();
}
