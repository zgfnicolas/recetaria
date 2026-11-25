import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Requisito 10 del TP (#24): `.env.example` contiene **exclusivamente nombres de variables**, sin
 * valores ni secretos. Los valores de ejemplo para desarrollo viven en el README.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENV_EXAMPLE = path.join(ROOT, ".env.example");

function assignments(source: string): { name: string; value: string }[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator === -1) {
        throw new Error(`Línea sin "=" en .env.example: "${line}"`);
      }
      return { name: line.slice(0, separator), value: line.slice(separator + 1) };
    });
}

describe(".env.example (Requisito 10 del TP)", () => {
  const vars = assignments(readFileSync(ENV_EXAMPLE, "utf8"));

  it("declara las variables que la API y Compose necesitan", () => {
    const names = vars.map((v) => v.name);
    for (const required of ["NODE_ENV", "PORT", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB", "DATABASE_URL", "JWT_SECRET", "JWT_EXPIRES_IN", "TRUST_PROXY"]) {
      expect(names).toContain(required);
    }
  });

  it("toda línea es una asignación NOMBRE= con un nombre válido", () => {
    for (const { name } of vars) {
      expect(name, name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it("ninguna variable trae valor (sin secretos ni valores de ejemplo)", () => {
    expect(vars.filter((v) => v.value !== "").map((v) => v.name)).toEqual([]);
  });

  it("declara toda variable que compose.yaml exige con ${VAR:?…}", () => {
    const compose = readFileSync(path.join(ROOT, "compose.yaml"), "utf8");
    const required = new Set([...compose.matchAll(/\$\{(\w+):\?/g)].map((m) => m[1] ?? ""));
    const names = new Set(vars.map((v) => v.name));
    expect(required.size).toBeGreaterThan(0);
    expect([...required].filter((name) => !names.has(name))).toEqual([]);
  });

  it("no hay nombres duplicados", () => {
    const names = vars.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
