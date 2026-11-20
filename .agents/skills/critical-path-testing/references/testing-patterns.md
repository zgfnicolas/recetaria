# Patrones de Testing Crítico para Recetaria API

Referencia ejecutable de [critical-path-testing](../SKILL.md) adaptada al backend REST **Node.js + TypeScript + Express 5 + Prisma + PostgreSQL 15 + Zod 4 + JSend** de Recetaria API ([docs/testing.md](../../../../docs/testing.md), [docs/business_rules.md](../../../../docs/business_rules.md), [docs/roles.md](../../../../docs/roles.md)).

---

## 1. Inventario crítico P0 inicial de Recetaria API

| ID | Comportamiento crítico | Riesgo (I×P) | Prioridad | Oráculo | Capas | Control negativo (sensibilidad) |
|---|---|:-:|:-:|---|---|---|
| `AUTH-01` | Hash Bcrypt `>= 10`, login sin enumeración (`401` uniforme), JWT `HS256` validado y `passwordHash` jamás expuesto | 5×3 (override seg.) | **P0** | `RN-08`, `docs/roles.md` | Unit + Integración | Devolver `passwordHash` o aceptar `alg: none` → debe fallar |
| `REC-01` | Toda receta nueva nace `DRAFT` con `authorId` del JWT; rechaza campos extra (BOPLA) | 5×3 | **P0** | `RN-01`, `docs/prd.md` | Integración API | Enviar `status: "APPROVED"` en `POST` y permitirlo → debe fallar |
| `REC-02` | Solo el autor edita (`RN-02`); editar `APPROVED` reinicia a `DRAFT` + registra `RESET_TO_DRAFT` en `audit_logs` dentro de `$transaction` | 5×3 | **P0** | `RN-02`, `RN-06` | Unit (`policy`) + Integración DB | Quitar check `authorId === actor.id` o romper `audit_logs` → debe fallar y hacer rollback |
| `REC-03` | Solo autor o `ADMIN` elimina (`RN-03`); `DELETE` + `audit_logs` atómicos y el log sobrevive al borrado físico | 5×2 | **P0** | `RN-03`, `RN-06` | Unit + Integración DB | Permitir borrado por `CHEF` no autor o borrar en cascada el log → debe fallar |
| `REC-04` | Solo `CHEF`/`NUTRITIONIST` aprueban (`RN-04`), nunca su propia receta (`RN-05`), `409` si ya es `APPROVED`, atómico con `audit_logs` y seguro en carrera concurrente | 5×3 | **P0** | `RN-04`, `RN-05`, `RN-06` | Unit + Integración concurrente | Permitir auto-aprobación o quitar condición `status = 'DRAFT'` → debe fallar |
| `REC-05` | `prepTimeMinutes` ∈ `[1, 1440]`, ≥ 1 ingrediente con `quantity > 0` (`RN-07`) y `slug` único (`P2002` → `409`) | 4×3 | **P0** | `RN-07`, `database_schema_init.sql` | Unit (límites + `fast-check`) + Integración DB | Cambiar `<= 1440` por `< 1440` o aceptar `quantity: 0` → debe fallar |
| `SYS-01` | Todas las respuestas de error cumplen JSend sin stack trace/SQL en producción; rutas privadas por defecto (`401`) | 5×2 (override seg.) | **P0** | `docs/sad.md`, `ADR-0004` | Integración HTTP | Quitar `authMiddleware` de una mutación o filtrar `err.stack` → debe fallar |

### Checklist P0 (aplicar solo los que correspondan al caso)
Camino exitoso · entrada inválida (`400`) · valores límite (`0`, `1`, `1440`, `1441`) · sin autenticar (`401`) · sin permisos horizontales/verticales (`403`) · recurso inexistente (`404`) · conflicto de estado/unicidad (`409`) · reintento/duplicado · fallo de dependencia · concurrencia real · efecto persistido y rollback comprobado.

---

## 2. Configuración endurecida de Vitest (`vitest.config.ts`)

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    sequence: { shuffle: true },
    env: { TZ: "UTC" },
    coverage: {
      provider: "v8",
      include: ["src/**"],
      thresholds: {
        // Exigir umbrales altos en paths críticos, no perseguir 100 % global ciego
        "src/modules/auth/**": { lines: 95, branches: 90 },
        "src/modules/recipes/**": { lines: 95, branches: 90 },
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: ["tests/integration/global-setup.ts"],
          testTimeout: 30_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
```

- Activar `eslint-plugin-vitest` con `no-focused-tests` y `no-disabled-tests` en error para bloquear `.only` y `.skip`.
- Controlar tiempo y aleatoriedad con `vi.useFakeTimers()` / `vi.setSystemTime(...)`, `faker.seed(...)` y las semillas impresas por `fast-check`.

---

## 3. Unit test crítico (AAA + límites + propiedades)

```ts
// src/modules/recipes/recipe.schema.test.ts — REC-05 (P0) · Oráculo: RN-07
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createRecipeBodySchema } from "./recipe.schema";

const baseRecipe = {
  title: "Empanadas salteñas",
  description: "Masa casera con relleno cortado a cuchillo.",
  difficulty: "MEDIUM" as const,
  tags: ["tradicional"],
  ingredients: [{ name: "Harina", quantity: 500, unit: "g" }],
};

describe("createRecipeBodySchema [P0 REC-05 RN-07]", () => {
  it.each([1, 45, 1440])("acepta prepTimeMinutes límite válido %i", (prepTimeMinutes) => {
    const parsed = createRecipeBodySchema.safeParse({ ...baseRecipe, prepTimeMinutes });
    expect(parsed.success).toBe(true);
  });

  it.each([0, -1, 1441, 10.5])("rechaza prepTimeMinutes inválido %s", (prepTimeMinutes) => {
    const parsed = createRecipeBodySchema.safeParse({ ...baseRecipe, prepTimeMinutes });
    expect(parsed.success).toBe(false);
  });

  it("rechaza cualquier cantidad de ingrediente <= 0 (propiedad)", () => {
    fc.assert(
      fc.property(fc.double({ min: -10_000, max: 0, noNaN: true }), (quantity) => {
        const parsed = createRecipeBodySchema.safeParse({
          ...baseRecipe,
          prepTimeMinutes: 30,
          ingredients: [{ name: "Sal", quantity, unit: "g" }],
        });
        return !parsed.success;
      }),
    );
  });
});
```

---

## 4. Integration test crítico (Supertest + PostgreSQL 15 real)

```ts
// tests/integration/global-setup.ts — mismo major que compose.yaml (postgres:15-alpine)
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import type { TestProject } from "vitest/node";

let pg: StartedPostgreSqlContainer;

export default async function setup(project: TestProject) {
  pg = await new PostgreSqlContainer("postgres:15-alpine").start();
  const dbUrl = pg.getConnectionUri();
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: dbUrl, MIGRATION_DATABASE_URL: dbUrl },
  });
  project.provide("dbUrl", dbUrl);
  return async () => { await pg.stop(); };
}
```

```ts
// tests/integration/recipes.approve.test.ts — REC-04 (P0) · Oráculo: RN-04, RN-05, RN-06
import request from "supertest";
import { beforeEach, describe, it, expect } from "vitest";
import { app, prisma, truncateAll, createUserAndToken, createDraftRecipe } from "../helpers/setup";

beforeEach(() => truncateAll(prisma));

describe("POST /api/v1/recipes/:id/approve [P0 REC-04]", () => {
  it("bloquea auto-aprobación de un CHEF (403) y no altera estado ni audit_logs [RN-05]", async () => {
    const chef = await createUserAndToken("CHEF");
    const recipe = await createDraftRecipe(chef.user.id);

    const res = await request(app)
      .post(`/api/v1/recipes/${recipe.id}/approve`)
      .set("Authorization", `Bearer ${chef.token}`);

    expect(res.status).toBe(403);
    expect(res.body.status).toBe("fail");

    const persisted = await prisma.recipe.findUniqueOrThrow({ where: { id: recipe.id } });
    const logs = await prisma.auditLog.count({ where: { entityId: recipe.id } });
    expect(persisted.status).toBe("DRAFT");
    expect(logs).toBe(0);
  });

  it("aprueba en carrera concurrente solo una vez (1x 200 y resto 409) con 1 único audit_log [RN-06]", async () => {
    const author = await createUserAndToken("USER");
    const chefA = await createUserAndToken("CHEF");
    const chefB = await createUserAndToken("NUTRITIONIST");
    const recipe = await createDraftRecipe(author.user.id);

    const [resA, resB] = await Promise.all([
      request(app).post(`/api/v1/recipes/${recipe.id}/approve`).set("Authorization", `Bearer ${chefA.token}`),
      request(app).post(`/api/v1/recipes/${recipe.id}/approve`).set("Authorization", `Bearer ${chefB.token}`),
    ]);

    expect([resA.status, resB.status].sort()).toEqual([200, 409]);
    expect(await prisma.auditLog.count({ where: { entityId: recipe.id, action: "APPROVE" } })).toBe(1);
  });
});
```

- Si en el futuro Recetaria llama APIs HTTP externas, levantar `setupServer()` de `msw/node` con `server.listen({ onUnhandledRequest: "error" })` para que ninguna llamada real sin simular pase desapercibida.

---

## 5. Mutation testing (`Stryker`), rendimiento (`k6`), seguridad y resiliencia

### 5.1 `stryker.config.json` (acotado a módulos críticos)
```json
{
  "testRunner": "vitest",
  "mutate": [
    "src/modules/auth/**/*.ts",
    "src/modules/recipes/**/*.ts",
    "!src/**/*.test.ts"
  ],
  "incremental": true,
  "thresholds": { "high": 85, "low": 70, "break": 60 }
}
```
- Correr en nocturno o en PRs que modifican `auth`/`recipes`. Analizar mutantes sobrevivientes en P0 uno por uno.

### 5.2 Carga en endpoints críticos (`tests/performance/recipes-list.js` con `k6`)
```js
import http from "k6/http";
import { check } from "k6";

export const options = {
  scenarios: {
    list_recipes: { executor: "constant-arrival-rate", rate: 30, timeUnit: "1s", duration: "3m", preAllocatedVUs: 30 },
  },
  thresholds: {
    "http_req_duration{endpoint:recipes_list}": ["p(95)<250", "p(99)<600"],
    http_req_failed: ["rate<0.01"],
  },
};

export default function () {
  const res = http.get(`${__ENV.BASE_URL}/api/v1/recipes?status=APPROVED`, {
    tags: { endpoint: "recipes_list" },
  });
  check(res, { "status 200": (r) => r.status === 200 });
}
```

### 5.3 Seguridad y resiliencia
- **PR:** SAST (`Semgrep`/`CodeQL`) + SCA (`npm audit`/`Trivy`) + secretos (`gitleaks`) + controles funcionales de seguridad (ver [identity-sessions-authorization](../../identity-sessions-authorization/SKILL.md)).
- **Staging:** `docker run --rm -t ghcr.io/zaproxy/zaproxy:stable zap-baseline.py -t https://staging.recetaria.example -r zap-report.html` (solo en entornos autorizados).
- **Resiliencia:** reiniciar el contenedor Postgres en test dedicado (verificar reconexión del pool) y probar rollback de `RN-06` inyectando fallo en `audit_logs`.

---

## 6. Reglas de IA en testing (`AI-01`–`AI-11`), CI escalonado y DoD

- **Reglas de IA:** `AI-01` No inventar APIs ni fixtures · `AI-02` No inventar reglas de negocio (preguntar) · `AI-03` Implementación ≠ especificación · `AI-04` No afirmar resultados no observados · `AI-05` No debilitar tests (`skip`/`only`/retries) · `AI-06` Reportar tests omitidos · `AI-07` Toda reparación muestra original, cambio y causa · `AI-08` Simulado ≠ sistema real · `AI-09` Sanitizar secretos/datos · `AI-10` Cambios mínimos en alcance · `AI-11` Nunca generar tests en masa fuera del inventario crítico.
- **Ejecución escalonada en CI:**
  - *Local:* `npm run build` + `vitest related`
  - *PR:* lint + typecheck + SAST/SCA/secretos + unit + integración crítica (PG 15 real) + cobertura en `auth/**` y `recipes/**`
  - *Staging:* `zap-baseline.py` + smoke HTTP + `k6` en endpoints críticos
  - *Post-deploy:* `/health` + smoke no destructivo de lectura + monitoreo SLO
  - *Programado:* `Stryker` incremental + `schemathesis` (cuando haya OpenAPI) + `Trivy` continuo
- **Antipatrones:** cobertura global como fin en sí mismo · copiar el esperado de la salida actual · P0 nunca visto fallar · mockear PostgreSQL en tests de integración · `sleep` fijo en tests · orden dependiente entre tests · assertions débiles (`toBeDefined()` o solo `status === 200` sin verificar efecto persistido) · P0 en cuarentena · reportar verde sin haber corrido el comando.
- **KPIs:** 100 % P0 validados y auditados · 0 P0 sin prueba de sensibilidad · 0 P0 flaky/cuarentena · 0 vulnerabilidades críticas sin tratamiento · `Stryker` sobre `break` en `auth`/`recipes`.
- **Definition of Done:** inventario P0 con oráculo y exclusiones documentadas · prueba de sensibilidad comprobada en cada P0 · Unit (límites + `fast-check`) e Integración (Supertest + PostgreSQL 15 real con migraciones y limpieza) en verde · matriz HTTP `200`/`201`/`400`/`401`/`403`/`404`/`409` completa · determinismo (`TZ=UTC`, orden aleatorio, `restoreMocks`) · gates de CI activos · informe A–F con salida real y estado honesto de cada test.
