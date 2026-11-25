import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Fronteras de la arquitectura en 4 capas (ADR-0003, #22) verificadas sobre el código fuente: un
 * import que cruce una capa hace fallar la suite. Los `import type` entre capas se aceptan (se
 * borran al compilar; p. ej. `RecipeRecord` en la política), pero **nunca** hacia Prisma, que
 * acopla el dominio a la persistencia. Analiza especificadores **directos**; los
 * `index.ts` de cada módulo (barrels) quedan fuera porque los servicios importan legítimamente
 * tipos de repositorio a través de ellos.
 */

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

type Layer = "router" | "controller" | "service" | "repository" | "policy" | "schema" | "middleware";

/** Especificadores que dan acceso a Prisma / PostgreSQL. */
const PRISMA_SPECIFIER = /(?:^@prisma\/|(?:^|\/)generated\/prisma(?:\/|$)|(?:^|\/)infrastructure\/database(?:\/|$))/;

/** Únicos archivos que pueden importar Prisma: repositorios, infraestructura y la raíz de composición. */
const PRISMA_ALLOWLIST: readonly RegExp[] = [
  /^modules\/[^/]+\/[^/]+\.repository\.ts$/,
  /^infrastructure\/database\//,
  /^bootstrap\//,
  /^app\.ts$/,
  /^server\.ts$/,
];

/** Capas que cada capa NO puede importar (además de Prisma, salvo los repositorios). */
const FORBIDDEN_LAYER_IMPORTS: Readonly<Record<Layer, readonly Layer[]>> = {
  router: ["service", "repository"],
  controller: ["repository", "router"],
  service: ["controller", "router"],
  repository: ["service", "controller", "router"],
  policy: ["service", "repository", "controller", "router"],
  schema: ["service", "repository", "controller", "router"],
  middleware: ["service", "repository", "controller", "router"],
};

/** `names`: identificadores importados como **valor** (excluye `type X` y los `import type`). */
export type ImportRef = Readonly<{ specifier: string; typeOnly: boolean; names?: readonly string[] }>;

/** Marcador de un `import()` cuyo argumento no es un literal: no puede analizarse estáticamente. */
export const UNANALYZABLE_DYNAMIC_IMPORT = "<import() no literal>";

/**
 * Quita comentarios respetando strings y template literals (un `"src/**\/*.ts"` o una URL con `//`
 * dentro de un string no se confunden con comentarios). Los strings se conservan tal cual.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const char = source[i] ?? "";
    const next = source[i + 1] ?? "";
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (char === '"' || char === "'" || char === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== char) j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else {
      out += char;
      i += 1;
    }
  }
  return out;
}

const NAMED_CLAUSE = /\{([^}]*)\}/;

/** Identificadores de valor de una cláusula `default, { a, type B, c as d }` (los alias cuentan por el original). */
function valueNames(clause: string): string[] {
  const names: string[] = [];
  const named = NAMED_CLAUSE.exec(clause);
  for (const part of (named?.[1] ?? "").split(",")) {
    const trimmed = part.trim();
    if (trimmed !== "" && !trimmed.startsWith("type ")) {
      names.push(trimmed.split(/\s+as\s+/)[0] ?? trimmed);
    }
  }
  const defaultName = /^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause.replace(NAMED_CLAUSE, ""));
  if (defaultName?.[1] !== undefined) {
    names.push(defaultName[1]);
  }
  return names;
}

/** Extrae los especificadores de `import`/`export … from`, `import "x"` e `import("x")`. */
export function extractImports(source: string): ImportRef[] {
  const code = stripComments(source);
  const refs: ImportRef[] = [];
  const staticPattern = /\b(import|export)\s+(type\s+)?(?:([\w*{}\s,$]+?)\s+from\s+)?["']([^"']+)["']/g;
  for (const match of code.matchAll(staticPattern)) {
    const [, , typeKeyword, clause, specifier] = match;
    if (specifier !== undefined) {
      const typeOnly = typeKeyword !== undefined;
      refs.push({ specifier, typeOnly, names: typeOnly || clause === undefined ? [] : valueNames(clause) });
    }
  }
  for (const match of code.matchAll(/\bimport\(\s*([^)]*?)\s*\)/g)) {
    const argument = match[1] ?? "";
    const literal = /^["']([^"']+)["']$/.exec(argument);
    refs.push({ specifier: literal?.[1] ?? UNANALYZABLE_DYNAMIC_IMPORT, typeOnly: false });
  }
  return refs;
}

const LAYERS: ReadonlySet<string> = new Set<Layer>(["router", "controller", "service", "repository", "policy", "schema"]);

function isLayer(value: string | undefined): value is Layer {
  return value !== undefined && LAYERS.has(value);
}

export function layerOf(relativePath: string): Layer | undefined {
  if (relativePath.startsWith("middlewares/")) {
    return "middleware";
  }
  const captured = /\.(router|controller|service|repository|policy|schema)\.ts$/.exec(relativePath)?.[1];
  return isLayer(captured) ? captured : undefined;
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "generated" ? [] : listSourceFiles(full);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

type SourceFile = Readonly<{ relative: string; layer: Layer | undefined; imports: readonly ImportRef[] }>;

function loadSources(): SourceFile[] {
  return listSourceFiles(SRC_DIR).map((file) => {
    const relative = path.relative(SRC_DIR, file).split(path.sep).join("/");
    return { relative, layer: layerOf(relative), imports: extractImports(readFileSync(file, "utf8")) };
  });
}

function prismaViolations(files: readonly SourceFile[]): string[] {
  return files.flatMap((file) =>
    PRISMA_ALLOWLIST.some((allowed) => allowed.test(file.relative))
      ? []
      : file.imports
          .filter((ref) => PRISMA_SPECIFIER.test(ref.specifier))
          .map((ref) => `${file.relative} → ${ref.specifier}`),
  );
}

function layerViolations(files: readonly SourceFile[]): string[] {
  return files.flatMap((file) => {
    if (file.layer === undefined) {
      return [];
    }
    const forbidden = FORBIDDEN_LAYER_IMPORTS[file.layer];
    return file.imports
      .filter((ref) => {
        if (ref.typeOnly) {
          return false;
        }
        const target = layerOf(ref.specifier.replace(/\.js$/, ".ts"));
        return target !== undefined && target !== "middleware" && forbidden.includes(target);
      })
      .map((ref) => `${file.relative} (${file.layer}) → ${ref.specifier}`);
  });
}

/**
 * Defensa contra el atajo por barrel (`../auth/index.js` re-exporta repositorios): fuera de los
 * repositorios, los servicios y la raíz de composición, nadie importa como valor una clase
 * `*Repository` ni el namespace `Prisma`, venga del archivo que venga.
 */
const REPOSITORY_VALUE_ALLOWED: readonly Layer[] = ["repository", "service"];
const PERSISTENCE_VALUE_NAME = /(?:Repository|^Prisma|PrismaClient)$/;

function barrelViolations(files: readonly SourceFile[]): string[] {
  return files.flatMap((file) =>
    file.layer === undefined || REPOSITORY_VALUE_ALLOWED.includes(file.layer)
      ? []
      : file.imports.flatMap((ref) =>
          (ref.names ?? [])
            .filter((name) => PERSISTENCE_VALUE_NAME.test(name))
            .map((name) => `${file.relative} (${file.layer}) → ${name} desde ${ref.specifier}`),
        ),
  );
}

function dynamicImportViolations(files: readonly SourceFile[]): string[] {
  return files.flatMap((file) =>
    file.imports
      .filter((ref) => ref.specifier === UNANALYZABLE_DYNAMIC_IMPORT)
      .map(() => `${file.relative}: import() con argumento no literal`),
  );
}

describe("Fronteras de capas (ADR-0003, #22)", () => {
  const files = loadSources();

  it("analiza el código fuente real de las 4 capas", () => {
    const layers = new Set(files.map((file) => file.layer));
    for (const layer of ["router", "controller", "service", "repository", "middleware"] as const) {
      expect(layers.has(layer), `no se encontró ningún archivo de la capa ${layer}`).toBe(true);
    }
  });

  it("solo los repositorios, la infraestructura y la raíz de composición importan Prisma", () => {
    expect(prismaViolations(files)).toEqual([]);
  });

  it("ningún router, controlador, servicio, política, esquema ni middleware importa Prisma directamente", () => {
    const guarded = files.filter((file) => file.layer !== undefined && file.layer !== "repository");
    expect(guarded.length).toBeGreaterThan(10);
    expect(prismaViolations(guarded)).toEqual([]);
  });

  it("cada capa importa solo de la siguiente (Router → Controller → Service → Repository)", () => {
    expect(layerViolations(files)).toEqual([]);
  });

  it("ninguna capa superior obtiene un repositorio o Prisma como valor a través de un barrel", () => {
    expect(barrelViolations(files)).toEqual([]);
  });

  it("no hay import() con argumento no literal (no se podría analizar)", () => {
    expect(dynamicImportViolations(files)).toEqual([]);
  });

  describe("autoverificación del analizador", () => {
    it("extrae imports estáticos, multilínea, type-only, re-exports, side-effect y dinámicos", () => {
      const source = `
        import { a } from "./a.js";
        import type { B } from "./b.js";
        import {
          c,
          type D,
        } from "../c.service.js";
        export { e } from "./e.repository.js";
        export * from "./f.js";
        export type { G } from "./g.js";
        import H, { I as J } from "./h.js";
        import "./side-effect.js";
        const glob = "src/**/*.ts";
        import { k } from "./k.js";
        const lazy = await import("../../generated/prisma/client.js");
        const sneaky = await import(\`../\${name}.repository.js\`);
        // import { comentado } from "@prisma/client";
        /* import { bloque } from "@prisma/client"; */
        const url = "https://example.com/x"; // comentario al final
      `;
      expect(extractImports(source)).toEqual([
        { specifier: "./a.js", typeOnly: false, names: ["a"] },
        { specifier: "./b.js", typeOnly: true, names: [] },
        { specifier: "../c.service.js", typeOnly: false, names: ["c"] },
        { specifier: "./e.repository.js", typeOnly: false, names: ["e"] },
        { specifier: "./f.js", typeOnly: false, names: [] },
        { specifier: "./g.js", typeOnly: true, names: [] },
        { specifier: "./h.js", typeOnly: false, names: ["I", "H"] },
        { specifier: "./side-effect.js", typeOnly: false, names: [] },
        { specifier: "./k.js", typeOnly: false, names: ["k"] },
        { specifier: "../../generated/prisma/client.js", typeOnly: false },
        { specifier: UNANALYZABLE_DYNAMIC_IMPORT, typeOnly: false },
      ]);
    });

    it("detecta un servicio que importa Prisma y un controlador que importa un repositorio", () => {
      const planted: SourceFile[] = [
        { relative: "modules/x/x.service.ts", layer: "service", imports: [{ specifier: "../../infrastructure/database/prisma.js", typeOnly: true }] },
        { relative: "modules/x/x.controller.ts", layer: "controller", imports: [{ specifier: "./x.repository.js", typeOnly: false }] },
        { relative: "middlewares/x.middleware.ts", layer: "middleware", imports: [{ specifier: "@prisma/client", typeOnly: false }] },
        { relative: "modules/x/x.policy.ts", layer: "policy", imports: [{ specifier: "./x.repository.js", typeOnly: true }] },
      ];
      expect(prismaViolations(planted)).toEqual([
        "modules/x/x.service.ts → ../../infrastructure/database/prisma.js",
        "middlewares/x.middleware.ts → @prisma/client",
      ]);
      expect(layerViolations(planted)).toEqual(["modules/x/x.controller.ts (controller) → ./x.repository.js"]);
    });

    it("detecta un repositorio obtenido por barrel y un import() no literal", () => {
      const planted: SourceFile[] = [
        { relative: "modules/x/x.controller.ts", layer: "controller", imports: [{ specifier: "../auth/index.js", typeOnly: false, names: ["UserRepository", "USER_ROLES"] }] },
        { relative: "modules/x/x.router.ts", layer: "router", imports: [{ specifier: "../auth/index.js", typeOnly: false, names: ["Prisma"] }] },
        { relative: "modules/x/x.service.ts", layer: "service", imports: [{ specifier: "../auth/index.js", typeOnly: false, names: ["UserRepository"] }] },
        { relative: "middlewares/y.middleware.ts", layer: "middleware", imports: [{ specifier: UNANALYZABLE_DYNAMIC_IMPORT, typeOnly: false }] },
      ];
      expect(barrelViolations(planted)).toEqual([
        "modules/x/x.controller.ts (controller) → UserRepository desde ../auth/index.js",
        "modules/x/x.router.ts (router) → Prisma desde ../auth/index.js",
      ]);
      expect(dynamicImportViolations(planted)).toEqual(["middlewares/y.middleware.ts: import() con argumento no literal"]);
    });
  });
});
