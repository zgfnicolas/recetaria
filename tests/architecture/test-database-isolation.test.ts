import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Invariante del aislamiento de la base de pruebas: el único `TRUNCATE` de `tests/` es el de
 * `truncateAll` (`tests/support/database.ts`), que verifica que la base sea `_test` antes de borrar.
 */
const TESTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.resolve(TESTS_DIR, "../src");
const GUARDED_FILE = "support/database.ts";
/**
 * Borrados en bloque, sin distinguir mayúsculas: `TRUNCATE` (con o sin `TABLE`), `DELETE FROM`,
 * `DROP TABLE/SCHEMA/DATABASE` sobre un identificador entre comillas y `deleteMany()` de Prisma.
 * Los `DROP TRIGGER/FUNCTION` de los *rollback* temporales no borran datos y quedan permitidos.
 */
const DESTRUCTIVE_SQL =
  /\btruncate\s+(?:table\s+)?(?:only\s+)?"|\bdelete\s+from\s+"|\bdrop\s+(?:table|schema|database)\s+(?:if\s+exists\s+)?"|\.deleteMany\(/i;

function listTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listTs(full) : entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** URLs literales pasadas directamente a un constructor de conexión (esquivarían la guarda de `env.ts`). */
const LITERAL_CONNECTION =
  /(?:createDatabase|new\s+(?:pg\.)?(?:Client|Pool)|new\s+PrismaPg)\(\s*(?:\{\s*connectionString:\s*)?["'`](postgres(?:ql)?:\/\/[^"'`]+)["'`]/g;

function literalConnectionUrls(source: string): string[] {
  return [...source.matchAll(LITERAL_CONNECTION)].map((match) => match[1] ?? "");
}

/** Segura si apunta a una base `_test` o al puerto 1 (inaccesible a propósito, p. ej. pruebas de 503). */
function isSafeLiteralUrl(raw: string): boolean {
  const url = new URL(raw);
  return url.port === "1" || /_test$/.test(url.pathname.replace(/^\//, ""));
}

function suiteFiles(): { file: string; label: string }[] {
  return [
    ...listTs(TESTS_DIR).map((file) => ({ file, label: path.relative(TESTS_DIR, file).split(path.sep).join("/") })),
    ...listTs(SRC_DIR)
      .filter((file) => file.endsWith(".test.ts"))
      .map((file) => ({ file, label: `src/${path.relative(SRC_DIR, file).split(path.sep).join("/")}` })),
  ];
}

describe("Aislamiento de la base de pruebas", () => {
  it("ninguna suite borra datos con un TRUNCATE propio: todo pasa por truncateAll", () => {
    const self = path.relative(TESTS_DIR, fileURLToPath(import.meta.url)).split(path.sep).join("/");
    const offenders = suiteFiles()
      .filter(({ label }) => label !== GUARDED_FILE && label !== self)
      .filter(({ file }) => DESTRUCTIVE_SQL.test(readFileSync(file, "utf8")))
      .map(({ label }) => label);
    expect(offenders).toEqual([]);
  });

  it("ninguna suite abre una conexión con una URL literal que no sea de pruebas ni inaccesible", () => {
    const self = path.relative(TESTS_DIR, fileURLToPath(import.meta.url)).split(path.sep).join("/");
    const offenders = suiteFiles()
      .filter(({ label }) => label !== self)
      .flatMap(({ file, label }) => literalConnectionUrls(readFileSync(file, "utf8")).map((url) => `${label} → ${url}`))
      .filter((entry) => !isSafeLiteralUrl(entry.slice(entry.indexOf("→ ") + 2)));
    expect(offenders).toEqual([]);
  });

  it("autoverificación: detecta una conexión literal a la base de desarrollo y acepta las seguras", () => {
    const source = `
      createDatabase("postgresql://u:p@localhost:5432/recetaria");
      createDatabase(
        "postgresql://u:p@127.0.0.1:1/recetaria",
      );
      new pg.Client({ connectionString: "postgres://u:p@db:5432/app_test" });
    `;
    const urls = literalConnectionUrls(source);
    expect(urls).toHaveLength(3);
    expect(urls.filter((url) => !isSafeLiteralUrl(url))).toEqual(["postgresql://u:p@localhost:5432/recetaria"]);
  });

  it("vitest prepara la base de pruebas antes de los workers (globalSetup)", () => {
    const config = readFileSync(path.resolve(TESTS_DIR, "../vitest.config.ts"), "utf8");
    expect(config).toContain('globalSetup: ["./tests/setup/global-database.ts"]');
  });
});
