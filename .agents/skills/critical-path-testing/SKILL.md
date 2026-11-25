---
name: critical-path-testing
description: >-
  Diseña, implementa y audita la estrategia de testing basada en riesgo para Recetaria API
  (Testing Trophy backend en TypeScript: Vitest, Supertest, PostgreSQL 15 real / Testcontainers,
  fast-check, Stryker, MSW estricto, k6, OWASP y Thunder Client) — inventario crítico P0/P1
  mapeado a RN-01..RN-08, oráculos independientes, prueba de sensibilidad obligatoria en P0,
  determinismo, no funcionales de API, reglas de honestidad IA (AI-01..AI-11) y quality gates
  en CI. Usar al escribir o revisar tests, definir estrategia QA o auditar una suite.
---

# Testing de Funcionalidades Críticas (Recetaria API)

Enfoque tradicional dirigido por riesgo sobre el modelo **Testing Trophy** de [docs/testing.md](../../../docs/testing.md) y [testing.md](../../rules/testing.md): probar en profundidad solo lo que, si falla, causa daño real en **Recetaria API** (autenticación, RBAC/ownership, ciclo `DRAFT`/`APPROVED`, atomicidad `RN-06` e integridad PostgreSQL); lo trivial queda cubierto por tipado estricto TS 7, Zod 4 y linters.

**Regla de oro:** probar lo importante, en la capa correcta, con evidencia de que el test falla ante el defecto que debe detectar.

## 0. Modo de trabajo, informe A–F y reglas duras (MUST)

Antes de escribir tests: auditar arquitectura, runner y CI existentes (no migrar herramientas sin motivo), armar el inventario P0/P1 con su fuente de verdad (`RN-01`–`RN-10`, `docs/prd.md`, `docs/roles.md`), elegir la capa más barata que aporte evidencia real y documentar qué NO se testea.

**Informe de intervención:** **A.** Diagnóstico · **B.** Plan (inventario + exclusiones) · **C.** Implementación · **D.** Verificación (comandos y salida real + sensibilidad de cada P0) · **E.** Riesgos residuales · **F.** Recomendaciones.
**Estados honestos:** `diseñado → implementado → ejecutado → validado → auditado` (nunca reportar un estado no alcanzado).

**Reglas duras:**
1. **Oráculo independiente:** el resultado esperado sale de un requisito (`RN-01`–`RN-10`), contrato JSend o invariante, nunca de lo que devuelve hoy el código ni del mismo algoritmo duplicado en el test.
2. **Prueba de sensibilidad obligatoria en P0:** todo test P0 tiene control negativo comprobado (introducir el defecto, verlo fallar con mensaje claro, revertir) o mutante muerto en `Stryker`.
3. **Regresión real:** todo bug en un área crítica recibe un test que falla antes del fix y pasa después.
4. **Integración real:** PostgreSQL **15** real (Docker Compose o `@testcontainers/postgresql`) con migraciones reales; cualquier HTTP saliente simulado con `MSW` estricto (`onUnhandledRequest: "error"`).
5. **Determinismo:** `TZ=UTC`, orden aleatorio (`sequence.shuffle: true`), reloj y semillas controlados, datos aislados entre tests (`TRUNCATE` o transacción).
6. **Prohibido debilitar tests:** nunca bajar assertions ni agregar `.skip`/`.only`/retries para lograr verde; ningún P0 entra en cuarentena ni se omite en ejecución selectiva por impacto.
7. **Honestidad de IA (`AI-01`–`AI-11`):** no inventar APIs ni reglas, no afirmar ejecución no observada, no generar tests en masa fuera del inventario crítico y mostrar original/cambio/causa ante cualquier reparación.

## 1. Priorización de riesgo, capas y exclusiones

`Riesgo = Impacto (1–5) × Probabilidad (1–5)`; obligaciones legales o de seguridad son **P0 directo**.
- **P0 (obligatorio en cada PR + sensibilidad):** Auth/JWT/Bcrypt (`RN-08`), autorización horizontal/vertical (`RN-02`–`RN-05`), atomicidad `recipes` + `audit_logs` (`RN-06`), integridad DB (`UNIQUE`, `CHECK`, concurrencia), cero fugas (`passwordHash`, stack traces).
- **P1:** reglas centrales y validaciones límite (`RN-07`), filtros/paginación y contratos HTTP JSend (`200`/`201`/`400`/`401`/`403`/`404`/`409`).
- **P2/P3 (no priorizar):** getters, mapeos 1:1, constantes, internals de Express/Prisma/Zod (cubiertos por TS 7 strict, Zod 4 y ESLint).

| Capa en Recetaria | Herramienta | Qué verifica | Mocking permitido |
|---|---|---|---|
| **Unit (`src/**/*.test.ts`)** | Vitest + `fast-check` | Reglas puras (`recipe.policy.ts`, `*.service.ts`, límites Zod `RN-07`) | Solo el `Repository` (nunca lógica interna) |
| **Integration (`tests/integration/`)** | Vitest + Supertest + PG 15 real | `Router → Zod → JWT/RBAC → Controller → Service → Repository → PostgreSQL`, `$transaction` (`RN-06`), `P2002`/`P2025`, concurrencia | Ninguno dentro del límite; solo HTTP externo vía `MSW` estricto |
| **Aceptación / Contrato / No funcionales** | Thunder Client, `schemathesis` (post-MVP), `k6`, `Stryker`, OWASP | Recorridos HTTP de punta a punta, seguridad, carga p95/p99 y calidad de assertions | Sin mocks sobre la API bajo prueba |

## 2. Quality Gates en CI y clasificación de fallos

- **Ante un test fallido, clasificar antes de editar:** defecto real · expectativa errónea (revisar oráculo) · test mal escrito · datos contaminados · entorno/concurrencia · cambio de requisito. Nunca cambiar producción para satisfacer un test malo ni ajustar un test para ocultar un bug.
- **Bloquean merge en PR:** fallo u omisión de cualquier P0, `.only`/`.skip` en código, caída de cobertura en `src/modules/auth/**` o `src/modules/recipes/**` bajo umbral, `Stryker` bajo `break`, vulnerabilidad crítica sin excepción con vencimiento o migración sin validar.

## 3. Colaboración y delegación

| Necesidad | Skill |
|---|---|
| Comandos diarios de ejecución (`npm test`, `npm run docker:db`) y tabla rápida Prisma | [run-tests](../run-tests/SKILL.md) |
| Desarrollo *test-first* (*red-green-refactor*) cuando el usuario pide TDD | [tdd](../tdd/SKILL.md) |
| `buildApp()` sin `listen()` y tests Supertest sobre middlewares Express 5 / JSend | [express-backend-engineering](../express-backend-engineering/SKILL.md) |
| Integración Prisma 7 + Testcontainers PG 15, rollback `RN-06` y retry `P2034` | [orm-persistence-js-ts](../orm-persistence-js-ts/SKILL.md) |
| Tests de abuso de identidad/RBAC (BOLA, BFLA, JWT tampering, `PUBLIC_ROUTES`) | [identity-sessions-authorization](../identity-sessions-authorization/SKILL.md) |
| `EXPLAIN (ANALYZE, BUFFERS)` y tests de concurrencia/locks en PostgreSQL | [postgresql-engineering](../postgresql-engineering/SKILL.md) |
| Primera línea estática (TS 7 strict, `erasableSyntaxOnly`, ESLint/SonarJS) | [typescript-engineering](../typescript-engineering/SKILL.md) |
| Frontera de testing por capa (`L0`/`L1`/`L2`) | [layered-architecture-ts](../layered-architecture-ts/SKILL.md) |
| Triage de edge cases, evitar sobreingeniería y tripwires con vencimiento | [pragmatic-engineering-complexity-control](../pragmatic-engineering-complexity-control/SKILL.md) |
| Rulesets de `main`, required status checks y política de PR (`pr-policy.yml`) | [github-repository-governance](../github-repository-governance/SKILL.md) · [git-workflow-engineering](../git-workflow-engineering/SKILL.md) |

Para inventario P0 completo de Recetaria, `vitest.config.ts` endurecido, tests Unit/Integración/Concurrencia, `stryker.config.json`, `k6`, OWASP, reglas `AI-01`–`AI-11`, KPIs y **Definition of Done**, consultá [references/testing-patterns.md](./references/testing-patterns.md).
