# Plan: [Spec 04.1] Alta de Receta en Borrador (POST /api/v1/recipes) con slug automático, Zod 4 y reglas RN-01/RN-07 (#16)

Fecha: 2026-11-23 · Rama: `feat/16-recipes-create-draft` · Parent: `#4` · Estado: **Completado y archivado (2026-11-23)**

## Objetivo
Inaugurar el módulo `Recipes` (`src/modules/recipes/`) en 4 capas estrictas (`ADR-0003`) y exponer `POST /api/v1/recipes` para cualquier usuario autenticado (`docs/roles.md`), con:
1. Orden de middlewares `authMiddleware → validateMiddleware` (`ADR-0006`; sin `rbacMiddleware` porque los 4 roles pueden crear).
2. Validación de borde Zod 4 `z.strictObject` (anti-BOPLA) y validaciones de dominio `RN-07` explícitas en `RecipeService`.
3. `RN-01`: `status = "DRAFT"`, `authorId = req.user.id` y `slug` `<titulo-ascii>-<8-hex>` (≤ 200 chars).

## Contexto que el agente debe leer
- `AGENTS.md`, `docs/business_rules.md` (`RN-01`, `RN-07`), `docs/roles.md`, `docs/data_model.md` (tabla `recipes` y `CHECK`)
- `docs/adr/0003-*.md`, `docs/adr/0006-*.md`, `.agents/rules/*.md`
- Patrón de referencia: `src/modules/auth/*`, `src/bootstrap/container.ts`

## Decisiones aprobadas
1. **`recipe.schema.ts`:** constantes (`RECIPE_DIFFICULTIES`, `RECIPE_STATUSES`, límites `RN-07`/`ADR-0006`) y esquemas estrictos:
   - `ingredientItemSchema`: `name` (trim 1..100), `quantity` (`z.number()` finito), `unit` (trim 1..30).
   - `nutritionalInfoSchema`: `calories`, `proteinGrams`, `carbsGrams`, `fatGrams`, `fiberGrams` (`>= 0`, opcionales) y `servings` (int `> 0`, opcional).
   - `createRecipeSchema`: `title` (trim 3..150), `description` (trim ≥ 10), `difficulty` (default `MEDIUM`), `prepTimeMinutes` (`z.number().int()`), `tags` (trim 1..50, máx. 20, default `[]`), `ingredients` (mín. 1), `nutritionalInfo` opcional, `coverImageUrl`/`videoUrl` opcionales (trim, ≤ 512, `z.url({ protocol: /^https?$/ })`).
   - DTOs con `z.infer` (`CreateRecipeDTO`, `IngredientDTO`, `NutritionalInfoDTO`).
2. **`recipe.slug.ts`:** función pura `generateRecipeSlug(title, generateHexSuffix?)` — NFD sin diacríticos, minúsculas ASCII, no `[a-z0-9]` → `-`, sin guiones extremos, fallback `"receta"`, base ≤ 191 chars + `-<8-hex>` (`crypto.randomBytes(4)`).
3. **`recipe.repository.ts`:** único acceso a Prisma (`IRecipeRepository`, `RecipeRepository`, `RecipeRecord`, `CreateRecipeRecordInput`); `create` y `findBySlug`; `Prisma.DbNull` para `nutritionalInfo` nulo; `P2002 → ConflictError` (409) y `P2003 → UnauthorizedError("Usuario autenticado no válido")` (401).
4. **`recipe.service.ts`:** `IRecipeService`/`RecipeService` sin Prisma ni Express; acumula fallos `RN-07` (`prepTimeMinutes` fuera de `[1, 1440]`, `ingredients.<i>.quantity <= 0`) en un único `BadRequestError("Error de validación de negocio", { errors })`; aplica `RN-01`.
5. **`recipe.controller.ts`:** `try/catch`, lee `req.user` (401 si falta) y `req.valid.body` (400 si falta), responde `201` JSend `"Receta creada exitosamente"`.
6. **`recipe.router.ts` + `index.ts`:** `POST /` con `authGuard → validateMiddleware({ body: createRecipeSchema }) → controller.create`.
7. **`src/bootstrap/container.ts`:** monta `/recipes` con `createAuthMiddleware({ secret: options?.jwt?.secret })`; retrocompatible con `buildApp({ prisma })` sin `jwt` (falla cerrado 500 redactado).

## Fases

### Fase 1 — Rama y registro del plan · Estado: Hecha
- [x] Crear la rama `feat/16-recipes-create-draft` desde `main` (`df79b26`)
- [x] Persistir este plan
Criterio: rama creada y plan registrado.

### Fase 2 — Módulo Recipes (4 capas) y wiring · Estado: Hecha
- [x] Crear `src/modules/recipes/` (`recipe.schema.ts`, `recipe.slug.ts`, `recipe.repository.ts`, `recipe.service.ts`, `recipe.controller.ts`, `recipe.router.ts`, `index.ts`)
- [x] Montar `/recipes` en `src/bootstrap/container.ts`
- [x] `npm run typecheck && npm run typecheck:test && npm run build && npm test` (0 `any`, 0 `as unknown as`)
Criterio: compilación estricta y 428 pruebas existentes en verde.

### Fase 3 — Pruebas unitarias e integración HTTP · Estado: Hecha
- [x] `recipe.slug.test.ts`, `recipe.schema.test.ts`, `recipe.service.test.ts` (mock solo de `IRecipeRepository`), `recipe.controller.test.ts`
- [x] `tests/integration/http/recipes-create.test.ts`: `201` (4 roles, persistencia real), `401` (sin token / JWT inválido / `authorId` inexistente `P2003`), `400` (Zod, BOPLA, JSON malformado, `RN-07` sin escribir filas), `409` (`P2002`) y `500` sin `jwt`
- [x] Suite completa en verde (`sequence.shuffle: true`)
Criterio: suite completa en verde.

### Fase 4 — Documentación, auditorías y cierre · Estado: Hecha
- [x] Actualizar `CHANGELOG.md` (`## [Sin publicar]`)
- [x] Auditorías según `.agents/agents/` (`code-reviewer`, `security-auditor`, `qa-tester`) y resolución de hallazgos
- [x] Archivar el plan en `docs/plans/archivo/` y verificar `git status --short`
Criterio: auditorías aprobadas y suite en verde, listo para commit/push/PR.

## Resultado de verificación
- `npm run typecheck`, `npm run typecheck:test`, `npm run build` y `npm test` en verde: 28 archivos · 545 pruebas (117 nuevas) bajo `sequence.shuffle: true`.
- `CLEAN_DIST`: `dist/` sin archivos `*.test.*`. `CLEAN_STATIC`: 0 `any`, 0 `as unknown as`, 0 `@ts-ignore`/`@ts-expect-error`, 0 `console.log` en el módulo.

## Auditorías
Se ejecutaron como 3 subagentes de Claude Code en paralelo (solo lectura, sin tocar la DB), cada uno con el prompt y las reglas de su definición en `.agents/agents/` (adaptación de los `@agentes` de Antigravity de `GEMINI.md`). Antes hubo una autorrevisión que detectó y corrigió que un JSONB corrupto se habría traducido a `400` (`parseStoredJson` → `AppError(500, { isOperational: false })`, con prueba de integración).

- **code-reviewer:** Aprobado, sin hallazgos altos/medios. Bajos/nits: redacción de `RN-07` en `docs/business_rules.md` ("al menos un ingrediente") difiere del ticket y el código ("cada ingrediente"); JSON malformado sin token → `400` (parser global); `findBySlug` aún sin uso en el servicio (previsto para #17); sin tope de `description`/`quantity`/nutrientes.
- **security-auditor:** Sin VETO. Baja (API4): sin `.max()` en `ingredients` y `description` (acotados solo por `BODY_LIMIT = 100kb`). Informativas: sin cota superior en `quantity`/nutrientes; `mediaUrlSchema` acepta hosts internos (SSRF latente, no explotable porque el servidor no descarga URLs).
- **qa-tester:** Cobertura suficiente. Brechas medias/bajas resueltas con pruebas de integración nuevas: JWT expirado, `HS512` y `alg: none` → `401`; bordes `prepTimeMinutes` 1/1440 → `201`; `text/plain` → `400`; JSON malformado sin token → `400` (comportamiento fijado).

## Decisiones humanas tras las auditorías
- **Topes Zod (aprobado):** `description` ≤ 5000 caracteres, `ingredients` ≤ 100 ítems, `quantity` y nutrientes ≤ 100000 (OWASP API4), con pruebas unitarias e integración y nota en `docs/data_model.md`.
- **`RN-07` (aprobado):** la regla correcta es que **cada** ingrediente tenga `quantity > 0`; se corrigió la redacción en `docs/business_rules.md` y `AGENTS.md` (el código ya lo aplicaba).
- **Sin cambio:** SSRF latente en `coverImageUrl`/`videoUrl` (informativo; revisar si el backend llega a descargar URLs) y `findBySlug` sin uso en el servicio (previsto para #17).
