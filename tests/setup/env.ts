import { config } from "dotenv";
import { assertTestDatabaseName, databaseNameFromUrl, resolveTestDatabaseUrl } from "../support/test-database.js";

config({ quiet: true });

// Aislamiento (ver `tests/setup/global-database.ts`): cada worker apunta a la base `<base>_test`,
// nunca a la de desarrollo. `getDatabase()` y las suites que leen `DATABASE_URL` la heredan.
const testDatabase = resolveTestDatabaseUrl(process.env);
process.env["DATABASE_URL"] = testDatabase.url;
process.env["MIGRATION_DATABASE_URL"] = testDatabase.url;

// Guarda sobre la URL **efectiva** del worker: si la redirección faltara, aborta antes de que
// cualquier prueba se conecte (ni lecturas, ni escrituras, ni borrados en la base de desarrollo).
assertTestDatabaseName(databaseNameFromUrl(process.env["DATABASE_URL"] ?? ""));
assertTestDatabaseName(databaseNameFromUrl(process.env["MIGRATION_DATABASE_URL"] ?? ""));
