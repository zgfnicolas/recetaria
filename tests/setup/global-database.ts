import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import pg from "pg";
import {
  driverDatabaseUrl,
  maintenanceDatabaseUrl,
  redactCredentials,
  resolveTestDatabaseUrl,
} from "../support/test-database.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PRISMA_BIN = path.join(ROOT, "node_modules", ".bin", "prisma");
const CONNECT_TIMEOUT_MS = 5_000;
/** SQLSTATE `invalid_catalog_name`: la base no existe. */
const DATABASE_DOES_NOT_EXIST = "3D000";

function hasSqlState(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && Reflect.get(err, "code") === code;
}

async function withClient(connectionString: string, run: (client: pg.Client) => Promise<void>): Promise<void> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  await client.connect();
  try {
    await run(client);
  } finally {
    await client.end();
  }
}

/**
 * Si la base de pruebas ya existe, basta con conectarse a ella (no hace falta acceso a `postgres`).
 * Solo si no existe (`3D000`) se usa la base de mantenimiento para crearla.
 */
async function ensureDatabaseExists(testUrl: string, databaseName: string): Promise<void> {
  try {
    await withClient(driverDatabaseUrl(testUrl), async (client) => {
      await client.query("SELECT 1");
    });
    return;
  } catch (err: unknown) {
    if (!hasSqlState(err, DATABASE_DOES_NOT_EXIST)) {
      throw err;
    }
  }
  await withClient(maintenanceDatabaseUrl(testUrl), async (client) => {
    // `databaseName` ya pasó `assertTestDatabaseName` (^[a-z0-9_]+_test$): identificador seguro.
    await client.query(`CREATE DATABASE "${databaseName}"`);
  });
}

/**
 * `globalSetup` de Vitest: corre una vez, antes de los workers. Crea (si falta) y migra la base de
 * pruebas `<base>_test`, para que `npm test` nunca toque la base de desarrollo de `DATABASE_URL`.
 * `MIGRATION_DATABASE_URL` también se fija a la base de pruebas: `prisma.config.ts` la prioriza.
 */
export default async function setup(): Promise<void> {
  config({ quiet: true });
  const { url, databaseName } = resolveTestDatabaseUrl(process.env);

  try {
    await ensureDatabaseExists(url, databaseName);
    execFileSync(PRISMA_BIN, ["migrate", "deploy"], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: url, MIGRATION_DATABASE_URL: url },
      stdio: "pipe",
    });
  } catch (err: unknown) {
    // Sin `cause`: arrastraría stdout/stderr crudos de Prisma. El detalle se redacta.
    const detail = redactCredentials(err instanceof Error ? err.message : String(err));
    throw new Error(
      `No se pudo preparar la base de pruebas "${databaseName}": ${detail}\n` +
        "Verificá que PostgreSQL esté corriendo (npm run docker:db) y que el usuario pueda crear bases; " +
        "si no, creá la base a mano o definí TEST_DATABASE_URL (debe terminar en _test).",
    );
  }
}
