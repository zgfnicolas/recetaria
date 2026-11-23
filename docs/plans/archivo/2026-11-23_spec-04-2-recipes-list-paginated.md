# Plan: [Spec 04.2] Listado público paginado y filtrado de Recetas (GET /api/v1/recipes) con orden determinístico (#17)

Fecha: 2026-11-23 · Rama: `feat/17-recipes-list-paginated` · Parent: `#4` · Estado: **Completado y archivado (2026-11-23)**

## Objetivo
Exponer `GET /api/v1/recipes` público (Visitante y Usuario, `HU-04`, `docs/roles.md`) sobre el módulo `Recipes` existente (#16), con:
1. Validación de `req.query` con Zod 4 `z.strictObject` (`status`, `difficulty`, `authorId`, `page`, `limit`) — `400` ante valores inválidos o claves desconocidas (OWASP API4 / BOPLA).
2. Filtros combinables aplicados en el `where` de Prisma (nunca en memoria), orden determinístico `("createdAt" DESC, id DESC)` y paginación acotada (`page=1`, `limit=20`, máx. `100`).
3. Respuesta `200` JSend `data: { items, meta: { page, limit, total, totalPages } }`, con `totalPages = total === 0 ? 0 : Math.ceil(total / limit)`.

## Contexto que el agente debe leer
- `AGENTS.md`, `docs/prd.md` (`HU-04`), `docs/roles.md` (reglas de visibilidad), `docs/adr/0006-*.md` (contrato de paginación)
- Módulo existente: `src/modules/recipes/*`, `src/middlewares/validate.middleware.ts` (`req.valid.query`, `query parser: "simple"` en `src/app.ts`)

## Decisiones propuestas
1. **`recipe.schema.ts` → `listRecipesQuerySchema` (`z.strictObject`):**
   - `status: z.enum(RECIPE_STATUSES).optional()`, `difficulty: z.enum(RECIPE_DIFFICULTIES).optional()`, `authorId: z.uuid({ version: "v4" }).optional()` (el criterio pide UUIDv4; `gen_random_uuid()` genera v4).
   - `page`/`limit` con **parseo estricto de dígitos** en lugar de `z.coerce.number()`: `z.string().regex(/^[1-9]\d*$/)` → `Number` → `z.int().min/max`. `z.coerce` aceptaría `" 2 "`, `"1e1"`, `"0x10"` o `"2.0"`.
   - **Tope de `page` en `10_000` (`MAX_PAGE`):** `skip = (page - 1) * limit` debe caber en el `Int` de 32 bits de Prisma; sin tope, `page=99999999&limit=100` provocaría un error de validación de Prisma → `500`. Además evita `OFFSET` gigantes (API4). *No lo pide el ticket → requiere aprobación.*
   - Parámetros repetidos (`?status=DRAFT&status=APPROVED` → arreglo) y vacíos (`?status=`) → `400` (no se interpretan como "sin filtro").
   - DTO: `ListRecipesQueryDTO = z.infer<...>`.
2. **`recipe.repository.ts` → `findManyPaginated({ filters, page, limit })`:**
   - `where` construido solo con filtros definidos (`exactOptionalPropertyTypes`), `orderBy: [{ createdAt: "desc" }, { id: "desc" }]`, `skip`/`take`, misma proyección `RECIPE_PUBLIC_SELECT` y lectura JSONB defensiva de #16.
   - `count` + `findMany` dentro de `prisma.$transaction([...])` para leerlos juntos.
   - Devuelve `PaginatedRecipes = { items, meta: { page, limit, total, totalPages } }` (cálculo de `totalPages` en el repositorio, como pide el criterio).
3. **`recipe.service.ts` → `list(query)`:** delega en el repositorio aplicando defaults ya resueltos por Zod; sin lógica de visibilidad extra (el catálogo incluye `DRAFT` y `APPROVED` por defecto, `docs/roles.md`).
4. **`recipe.controller.ts` → `list`:** `try/catch`, lee `req.valid.query` (400 *fail-closed* si falta) y responde `200` `"Recetas obtenidas exitosamente"`.
5. **`recipe.router.ts`:** `router.get("/", validateMiddleware({ query: listRecipesQuerySchema }), controller.list)` — público, sin `authGuard`. Se declara antes de las futuras rutas `/mine` y `/:id` (#18).
6. **Fuera de alcance (anotado):** índice compuesto `("createdAt" DESC, id DESC)` para el orden — requiere migración y aprobación explícita; se evaluará en #22 (E2E) o con datos reales.

## Fases

### Fase 1 — Rama y registro del plan · Estado: Hecha
- [x] Crear la rama `feat/17-recipes-list-paginated` desde `main` (`e1a6059`, con #16 mergeado)
- [x] Persistir este plan
Criterio: rama creada y plan registrado.

### Fase 2 — Implementación · Estado: Hecha
- [x] `listRecipesQuerySchema` + DTO en `recipe.schema.ts`
- [x] `findManyPaginated` en `IRecipeRepository`/`RecipeRepository`; `list` en `IRecipeService`/`RecipeService` y `RecipeController`
- [x] Ruta `GET /` en `recipe.router.ts` y re-exports en `index.ts`
- [x] `npm run typecheck && npm run typecheck:test && npm run build && npm test` (0 `any`, 0 `as unknown as`)
Criterio: compilación estricta y 545 pruebas existentes en verde (los mocks de `IRecipeRepository`/`IRecipeService` se actualizan con el nuevo método).
Resultado: typecheck, typecheck:test y build OK; 28 archivos · 545 pruebas en verde; 0 `any`/`as unknown as`. Smoke test del esquema con `node:querystring` real: defaults, `1e1`, `limit=101`, `page=10001`, parámetro repetido, vacío, clave desconocida y UUID no v4 se comportan según lo decidido.

### Fase 3 — Pruebas · Estado: Hecha
- [x] `recipe.schema.test.ts`: defaults `page=1`/`limit=20`; bordes `limit` 1/100 y `page` 1/10000; rechazo de `0`, `101`, `-1`, `"1e1"`, `" 2 "`, `"2.0"`, `""`, enums inválidos, UUID no v4, arreglos por parámetro repetido y claves desconocidas
- [x] `recipe.service.test.ts` (mock solo de `IRecipeRepository`): delegación de filtros, página y límite
- [x] `recipe.controller.test.ts`: `200` JSend con `req.valid.query`, `400` si falta y delegación a `next(err)`
- [x] `tests/integration/http/recipes-list.test.ts` (Supertest + PostgreSQL 15), con recetas sembradas por repositorio/Prisma con `createdAt` controlado:
  - listado por defecto con `DRAFT` y `APPROVED`, `page=1`, `limit=20` y sin token
  - recorrido de varias páginas sin duplicados ni saltos, incluido **desempate por `id DESC` con `createdAt` idénticos**
  - filtros `status`, `difficulty`, `authorId` individuales y combinados con `total`/`totalPages` exactos
  - resultado vacío (`total: 0, totalPages: 0`) y página más allá del final (`items: []` con `total` real)
  - `400` JSend por `limit`/`page` fuera de rango, enums, UUID inválido, parámetros desconocidos y repetidos
- [x] Suite completa en verde (`sequence.shuffle: true`)
Criterio: suite completa en verde.
Resultado: 63 pruebas nuevas (34 unitarias + 29 de integración en `tests/integration/http/recipes-list.test.ts` con 25 recetas sembradas y `createdAt` repetido de a 3); 29 archivos · 608 pruebas en verde bajo `sequence.shuffle: true`; typecheck, typecheck:test y build OK; `dist/` sin tests.

### Fase 4 — Documentación, auditorías y cierre · Estado: Hecha
- [x] `CHANGELOG.md` (`## [Sin publicar]`) y, si cambia el contrato, `docs/adr/0006` / `README.md` (tope de `page`)
- [x] Auditorías como 3 subagentes en paralelo (`code-reviewer`, `security-auditor`, `qa-tester`, definiciones de `.agents/agents/`, solo lectura, sin tocar la DB) y resolución de hallazgos
- [x] Archivar el plan en `docs/plans/archivo/` y verificar `git status --short`
Criterio: auditorías aprobadas y suite en verde, listo para commit/push/PR.

## Resultado final
- `npm run typecheck`, `npm run typecheck:test`, `npm run build` y `npm test` en verde: 29 archivos · 635 pruebas (90 nuevas: 39 unitarias y 51 de integración) bajo `sequence.shuffle: true`. `dist/` sin tests; 0 `any`/`as unknown as`.
- Chequeo de mutación: invertir las claves de `orderBy` hace fallar 9 pruebas (el dataset ya no es tautológico).

## Auditorías (3 subagentes de Claude Code en paralelo, definiciones de `.agents/agents/`, solo lectura)
- **code-reviewer:** aprobado sin hallazgos altos/medios. Baja: sin prueba directa de `calculateTotalPages` ni de la guarda `RangeError` → **resuelto** (pruebas en `recipes-list.test.ts`). Nit: índice de orden → issue #36.
- **security-auditor:** sin VETO. Media (API4): sin índice de orden ni rate limit, `OFFSET` hasta 999.900 filas + `count(*)` anónimos → **mitigado** con la ventana `page × limit ≤ 10000` (decisión humana) y **diferido** índice + rate limit a #36 (`needs-triage`). Baja: una fila con JSONB corrupto hace fallar la página con `500` (*fail-closed*, se mantiene). Informativa: `tags`/`nutritionalInfo` de `DRAFT` públicos según `docs/roles.md` y `docs/compliance.md` (sin cambio).
- **qa-tester:** cobertura suficiente. Media-alta: `id` y `createdAt` correlacionados en el dataset (un orden solo por `id` pasaba) → **resuelto** con `id = (i * 7) % 25` y aserción explícita. Media: "filtros en el `where`, nunca en memoria" no demostrado → **resuelto** con `vi.spyOn` sobre `prisma.recipe.count/findMany` verificando `where`, `orderBy`, `skip` y `take`. Bajas → **resueltas**: token válido, subconjunto filtrado paginado, `limit=abc`/`1.5`, `difficulty=easy`, `page` repetido y `status` faltante en un caso.

## Decisiones humanas
- Tope de `page` (aprobado en el plan) reforzado tras la auditoría con la ventana `page × limit ≤ 10000` (`MAX_RESULT_WINDOW`); `README.md`, `docs/sad.md`, `docs/roles.md` y `CHANGELOG.md` actualizados. ADR-0006 y `docs/prd.md` sin cambios (la restricción es aditiva).

