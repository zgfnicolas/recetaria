# Plan: [Spec 04.3] Recetas propias autenticadas (GET /api/v1/recipes/mine) y detalle público por UUID (GET /api/v1/recipes/:id) (#18)

Fecha: 2026-11-24 · Rama: `feat/18-recipes-mine-and-detail` · Parent: `#4` · Estado: **Completado y archivado (2026-11-24); pendiente commit/PR**

## Objetivo
Completar las lecturas del módulo `Recipes` (`HU-04`, `ADR-0006`) sobre lo construido en #16 y #17:
1. `GET /api/v1/recipes/mine` (autenticado): el Autor lista **solo** sus Recetas con paginación y filtros `status`/`difficulty`; `authorId` en la query → `400` (nunca altera el alcance).
2. `GET /api/v1/recipes/:id` (público): detalle completo por UUIDv4; `400` si `:id` no es UUIDv4 válido, `404` si no existe.
3. `/mine` registrada **antes** de `/:id` para que el literal `"mine"` nunca se capture como `:id`.

## Contexto que el agente debe leer
- `AGENTS.md`, `docs/prd.md` (`HU-04`), `docs/roles.md` (matriz y visibilidad), `docs/sad.md` (orden de middlewares, catálogo de endpoints), `docs/adr/0006-*.md`, `docs/testing.md`
- Módulo existente: `src/modules/recipes/*` (`listRecipesQuerySchema`, `findManyPaginated`, `RECIPE_PUBLIC_SELECT`, `toRecipeRecord`), `src/middlewares/validate.middleware.ts` (`req.valid.params`), `src/bootstrap/container.ts` (`authGuard`, `publicReadLimiter`)
- Patrón de pruebas: `tests/integration/http/recipes-list.test.ts` (dataset, `truncateTables`, JWT de prueba)
- Plan anterior archivado: `docs/plans/archivo/2026-11-23_spec-04-2-recipes-list-paginated.md`

## Análisis del estado actual
- **Ya existe y se reutiliza:** `findManyPaginated` con filtro opcional `authorId` en el `where` de Prisma, orden `("createdAt" DESC, id DESC)` y meta `{ page, limit, total, totalPages }`; índice `idx_recipes_authorid_createdat_id` (#36) que ya cubre el orden de `/mine`; `NotFoundError` (`404`) en `app-error.ts`; `validateMiddleware` ya soporta `params`.
- **Falta:** esquemas de query de `/mine` y de params de `/:id`, `findById` en el repositorio, `getMine`/`getById` en el servicio, `listMine`/`getById` en el controlador y las dos rutas.
- **Restricción técnica detectada:** con Zod 4.6, `.omit()` sobre un `z.strictObject(...).refine(...)` lanza error (no se puede omitir en objetos con refinamientos). Hay que extraer la forma común en lugar de derivar `/mine` de `listRecipesQuerySchema` con `.omit({ authorId: true })`.

## Decisiones propuestas
1. **`recipe.schema.ts`:**
   - Extraer la forma común de paginación/filtros (`status`, `difficulty`, `page`, `limit`) y la regla de ventana `page × limit ≤ MAX_RESULT_WINDOW` en un helper interno, y construir con él:
     - `listRecipesQuerySchema` = forma común + `authorId` (comportamiento actual **sin cambios**; sus pruebas deben seguir en verde).
     - `listMyRecipesQuerySchema` = `z.strictObject` con la forma común **sin** `authorId` → `?authorId=` responde `400` "Campo no permitido".
   - `recipeIdParamsSchema = z.strictObject({ id: z.uuidv4({ error: "id debe ser un UUID v4 válido" }) })`.
   - DTOs: `ListMyRecipesQueryDTO`, `RecipeIdParamsDTO` vía `z.infer`.
2. **`recipe.repository.ts`:** `findById(id): Promise<RecipeRecord | null>` con `findUnique({ where: { id }, select: RECIPE_PUBLIC_SELECT })` y `toRecipeRecord` (misma proyección pública y lectura JSONB defensiva). No se agregan métodos de listado: `/mine` reutiliza `findManyPaginated`.
3. **`recipe.service.ts`:**
   - `getMine(authorId, query)`: delega en `findManyPaginated` con `filters: { status, difficulty, authorId }`, donde `authorId` es **siempre** el del actor (se construye el objeto de filtros explícitamente, nunca con *spread* de la query, así un `authorId` colado no puede pisarlo).
   - `getById(id)`: `findById`; si devuelve `null` → `throw new NotFoundError("Receta no encontrada")`.
   - Sin reglas de visibilidad extra: el detalle público incluye `DRAFT` y `APPROVED` (`docs/roles.md`).
4. **`recipe.controller.ts`:** `listMine` (lee `req.user` → `401` *fail-closed* y `req.valid.query`) y `getById` (lee `req.valid.params`, nuevo helper `readValidatedParams`), ambos con `try/catch` y `sendSuccess` `200` (`"Recetas propias obtenidas exitosamente"` / `"Receta obtenida exitosamente"`).
5. **`recipe.router.ts`** (orden de declaración):
   1. `GET /` — sin cambios.
   2. `GET /mine` — `authGuard → validateMiddleware({ query: listMyRecipesQuerySchema }) → controller.listMine` (orden exigido por el ticket; sin token → `401` antes de validar).
   3. `GET /:id` — `[publicReadLimiter →] validateMiddleware({ params: recipeIdParamsSchema }) → controller.getById`.
   4. `POST /` — sin cambios.
   - Se actualiza el JSDoc del router (hoy menciona "futuras rutas `/mine` y `/:id`").
6. **Rate limit en `GET /:id`** *(no lo pide el ticket → requiere aprobación)*: aplicar el mismo `publicReadLimiter` del catálogo (cuota compartida de 120 req/min por IP) porque es una lectura anónima y permite enumeración de IDs (OWASP API4, coherente con #36). `/mine` queda **sin** limitador: está detrás de JWT y el ticket fija `authMiddleware → validateMiddleware`.
7. **`z.uuidv4()` en lugar de `z.uuid()`** *(desvío menor del texto del ticket → requiere aprobación)*: el criterio dice "UUIDv4" y `docs/prd.md` también; en Zod 4 `z.uuid()` acepta cualquier versión RFC 9562. Se alinea con `authorId` de #17 y con `gen_random_uuid()` (v4). Consecuencia: un UUID válido no-v4 responde `400`, no `404`.
8. **Re-exports en `index.ts`** de los nuevos esquemas/DTOs.
9. **Fuera de alcance:** colección Thunder Client (`docs/thunder-client-collection.json`, ticket posterior), `PUT`/`DELETE`/`approve` (#19+), cambios de esquema o migraciones (el índice necesario ya existe).

## Fases

### Fase 1 — Rama y registro del plan · Estado: Hecha
- [x] Crear la rama `feat/18-recipes-mine-and-detail` desde `main` (`220aa7d`)
- [x] Persistir este plan (hecho en borrador) y mover el issue a `In Progress` en el Project
Criterio: rama creada y plan aprobado.

### Fase 2 — Implementación · Estado: Hecha
- [x] Refactor de la forma común + `listMyRecipesQuerySchema` y `recipeIdParamsSchema` en `recipe.schema.ts`
- [x] `findById` en `IRecipeRepository`/`RecipeRepository`
- [x] `getMine`/`getById` en `IRecipeService`/`RecipeService`; `listMine`/`getById` en `RecipeController`
- [x] Rutas en `recipe.router.ts` (orden `/` → `/mine` → `/:id` → `POST /`) y re-exports en `index.ts`
- [x] Actualizar mocks existentes de `IRecipeRepository`/`IRecipeService` con los métodos nuevos
- [x] `npm run typecheck && npm run typecheck:test && npm run build && npm test` (0 `any`, 0 `as unknown as`)
Criterio: compilación estricta y suite existente (635 pruebas) en verde, incluidas las de `listRecipesQuerySchema` tras el refactor.
Resultado: typecheck, typecheck:test y build OK; pruebas de #17 sin modificar en verde.

### Fase 3 — Pruebas · Estado: Hecha
- [x] `recipe.schema.test.ts`: `listMyRecipesQuerySchema` (defaults, bordes, ventana, rechazo de `authorId` y claves desconocidas); `recipeIdParamsSchema` (UUIDv4 válido, `"mine"`, `"abc"`, UUID v1/v7, mayúsculas, clave extra)
- [x] `recipe.service.test.ts` (mock solo de `IRecipeRepository`):
  - `getMine`: `authorId` forzado al actor aunque el objeto de query traiga otro `authorId` (vía variable intermedia, sin casts), delegación de `status`/`difficulty`/`page`/`limit`
  - `getById`: devuelve la Receta; `NotFoundError` `404` si el repositorio devuelve `null`; propaga errores inesperados
- [x] `recipe.controller.test.ts`: `listMine` (`200`, `401` sin `req.user`, `400` sin `req.valid.query`, `next(err)`) y `getById` (`200`, `400` sin `req.valid.params`, `next(err)`)
- [x] `tests/integration/http/recipes-mine.test.ts` (Supertest + PostgreSQL 15): dos Autores con recetas intercaladas →
  - `200` cada Autor ve solo las suyas (`total` exacto, orden `createdAt DESC, id DESC`, paginación, filtros `status`/`difficulty`)
  - `200` Autor sin recetas → `items: []`, `total: 0`, `totalPages: 0`
  - `400` con `?authorId=<otro autor>`, clave desconocida, `limit` fuera de rango
  - `401` sin header, token inválido y token expirado (y `401` aunque la query sea inválida: auth precede a validación)
  - Precedencia: `GET /mine` sin token → `401` (no `400` de UUID) y con token → `200` paginado (no `404`)
- [x] `tests/integration/http/recipes-detail.test.ts`: `200` detalle completo sin token (campos de `RECIPE_PUBLIC_SELECT`, `DRAFT` y `APPROVED`), `200` con token, `400` (`"abc"`, UUID no v4), `404` UUIDv4 inexistente, y que `GET /:id` consume la cuota del limitador público si se aprueba la decisión 6
- [x] Suite completa en verde (`sequence.shuffle: true`)
Criterio: todos los criterios de aceptación del issue cubiertos por al menos una prueba.
Resultado: 36 archivos · 854 pruebas (856 tras auditorías) en verde bajo `sequence.shuffle: true` (unitarias de esquema/servicio/controlador + 33 de integración en `recipes-mine.test.ts` y `recipes-detail.test.ts`).

### Fase 4 — Documentación, auditorías y cierre · Estado: Hecha
- [x] `CHANGELOG.md` (`## [Sin publicar]`); `docs/sad.md`/`README.md` solo si cambia el contrato (rate limit en `/:id`)
- [x] Auditorías como 3 subagentes en paralelo (`code-reviewer`, `security-auditor`, `qa-tester`, definiciones de `.agents/agents/`, solo lectura) y resolución de hallazgos
- [x] Archivar el plan en `docs/plans/archivo/` y verificar `git status --short`
- [ ] Commit sugerido: `feat(recipes): agregar GET /recipes/mine autenticado y detalle público GET /recipes/:id` — *commit/push/PR solo con confirmación*
Criterio: auditorías aprobadas, suite en verde, listo para PR.

## Resultado final
- `npm run typecheck`, `npm run typecheck:test`, `npm run build` y `npm test` en verde: 36 archivos · 856 pruebas bajo `sequence.shuffle: true`; `dist/` sin tests; 0 `any`/`as unknown as`.
- Chequeo de mutación: cambiar el desempate a `id ASC` hace fallar 4 pruebas de `recipes-mine.test.ts`.

## Auditorías (3 subagentes en paralelo, definiciones de `.agents/agents/`, solo lectura)
- **code-reviewer:** aprobado sin hallazgos altos/medios. Baja: `/mine` sin rate limit → **documentado** como riesgo asumido en `docs/sad.md` §7. Baja: el caso `/MINE` prometido en el plan faltaba → **resuelto** (prueba de precedencia). Nit: comentario sobre el `authorId` colado vía variable intermedia → **resuelto**. Nit: colección Thunder Client → fuera de alcance.
- **security-auditor:** sin VETO. Baja (API4): `/mine` sin rate limit → **documentado** (mitigación prevista: limitador por `req.user.id` tras `authGuard`). Informativas: distinción `400`/`404` (despreciable con UUIDv4 aleatorio + rate limit) y detalle público de `DRAFT` con `tags`/`nutritionalInfo` (Ley 25.326) → **documentado** en `docs/sad.md` §7 como decisión de producto vigente.
- **qa-tester:** cobertura suficiente. Media: el desempate `id DESC` de `/mine` no se probaba (los empates eran entre autores) → **resuelto** con dataset `i % 5 < 3` y prueba explícita. Media: dificultad correlacionada con autor → **resuelto** (ambos Autores con las 4 dificultades y `DRAFT` + `HARD`). Bajas: espías dependientes de `findUnique` → **resuelto** (también `findFirst`/`findMany`); aserción redundante → **resuelto**.

## Riesgos
- **Refactor de `listRecipesQuerySchema`:** cambiar su construcción puede alterar mensajes o el `path` del error de ventana; mitigación: las pruebas de #17 deben pasar sin modificarse.
- **Enrutamiento case-insensitive de Express:** `/MINE` también coincide con `/mine` (comportamiento por defecto, aceptable); se documenta en la prueba de precedencia.
- **Detalle público de `DRAFT`:** expone recetas no aprobadas a Visitantes, conforme a `docs/roles.md`; no se cambia en este ticket.
