# Plan: [Spec 05.2] Edición por el Autor (PUT /api/v1/recipes/:id), regeneración de slug y Reinicio a Borrador atómico (RESET_TO_DRAFT) (#20)

Fecha: 2026-11-24 · Rama: `feat/20-recipes-update-reset` · Parent: `#5` · Estado: **Completado y archivado (2026-11-24); pendiente commit/PR**

## Objetivo
Habilitar la edición parcial o completa de una Receta por su Autor (`HU-05`, `RN-02`, `RN-06`, `RN-07`):
- Solo el Autor puede editar; cualquier otro usuario recibe `403`, incluido `ADMIN`.
- Una Receta en `DRAFT` se actualiza sin auditar.
- Una Receta en `APPROVED` vuelve a `DRAFT`: se limpian `reviewedById` y `publishedAt` y se registra `RESET_TO_DRAFT` en `audit_logs` dentro de la misma `prisma.$transaction`.
- El `slug` se regenera solo si se envía `title`. Una colisión de `slug` responde `409`.

## Contexto que el agente debe leer
- `AGENTS.md`, `docs/prd.md` (`HU-05`), `docs/business_rules.md` (`RN-02`, `RN-06`, `RN-07`), `docs/roles.md` (ni siquiera `ADMIN` edita recetas ajenas), `docs/data_model.md` (`Prisma.DbNull`, `CHECK`s)
- Código: `src/modules/recipes/*` (`createRecipeSchema`, `collectRecipeDomainErrors`, `generateRecipeSlug`, `approveWithAudit` y su patrón `FOR UPDATE`, `recipe.policy.ts`, mapeo `P2002 → 409`)
- Pruebas de referencia: `tests/integration/http/recipes-approve.test.ts` (barreras de lock, trigger de *rollback*) y `recipes-create.test.ts` (`409` por `slug` con `generateSlug` inyectado)
- Plan anterior: `docs/plans/archivo/2026-11-24_spec-05-1-recipes-approve.md`

## Análisis del estado actual
- **Ya existe y se reutiliza:**
  - `recipeIdParamsSchema` (UUID v4)
  - `collectRecipeDomainErrors` (`RN-07`)
  - `generateRecipeSlug` con `SlugGenerator` inyectable
  - el mapeo `P2002 → 409` y `P2003 → 401` de `create`
  - `AUDIT_ENTITY_RECIPE`, `RecipeAuditAction` (ya incluye `RESET_TO_DRAFT`), `toApprovalSnapshotJson` y el patrón de transacción con `SELECT … FOR UPDATE` de #19
- **Hallazgo crítico verificado en Zod 4.6:** `createRecipeSchema.partial()` **conserva los `.default()`**.
  - `{ title: "X" }` se parsea como `{ title: "X", difficulty: "MEDIUM", tags: [] }`, así que una edición parcial **pisaría la dificultad y las etiquetas existentes**.
  - `{}` se parsea como `{ difficulty: "MEDIUM", tags: [] }`, así que un `refine` de "al menos 1 campo" sobre la salida **dejaría pasar el `{}`**.
  - Derivar literalmente con `.partial()`, como dice el ticket, introduce ese bug. Lo correcto es derivar la edición de una forma base sin defaults (decisión 1).
- **Carrera de integridad clínica:** si el servicio decidiera el reinicio con su propia lectura previa, podría pasar lo siguiente: el Autor edita una receta en `DRAFT`, un `CHEF` la aprueba entre esa lectura y el `UPDATE`, y la edición se aplica sobre una receta `APPROVED` **sin reiniciarla**. Quedaría aprobado un contenido que nadie revisó. Por eso la decisión de reiniciar se toma sobre la fila bloqueada (decisión 4).

## Decisiones propuestas
1. **`recipe.schema.ts`:**
   - Extraer `recipeFieldsShape`, con los mismos validadores de hoy pero **sin `.default()`**.
     - `createRecipeSchema = z.strictObject({ ...recipeFieldsShape, difficulty: …default("MEDIUM"), tags: …default([]) })`, sin cambio de contrato: las pruebas de #16 deben pasar sin tocarse.
     - `updateRecipeSchema = z.strictObject(recipeFieldsShape).partial().refine(hayAlMenosUnaClave)`. El refinamiento se evalúa sobre la salida, que ahora ya no recibe claves inyectadas por defaults.
     - `UpdateRecipeDTO = z.infer<…>`.
   - Campos protegidos (`status`, `authorId`, `slug`, `reviewedById`, `publishedAt`, `id`…) → `400` "Campo no permitido" (BOPLA).
   - **Limpiar opcionales con `null`** *(requiere aprobación, pregunta 1)*: `nutritionalInfo`, `coverImageUrl` y `videoUrl` aceptan `null` para vaciarse. Sin esto, una portada o un video cargados no se podrían quitar nunca. `nutritionalInfo: null` se persiste como `Prisma.DbNull`, porque `JsonNull` violaría `chk_recipes_nutritional_info_object`. Los campos obligatorios no aceptan `null`.
2. **`recipe.policy.ts` → `canEdit(actor, recipe): boolean`** = `recipe.authorId === actor.id`. Es pura y no exime a ningún rol, ni siquiera a `ADMIN` (`docs/roles.md`).
3. **`RecipeService.update(actor, recipeId, dto)`:**
   1. `findById`: `404` si no existe.
   2. `canEdit`: `403` (`"Solo el autor puede editar la receta"`) si no es el Autor.
   3. `RN-07` sobre los campos presentes: generalizar `collectRecipeDomainErrors` a `Partial<…>`, para validar `prepTimeMinutes` solo si viene e `ingredients` (no vacío y `quantity > 0`) solo si viene. Acumula los errores en un único `400`.
   4. `slug = this.#generateSlug(dto.title)` solo si `dto.title !== undefined`. Si se envía el mismo título, igual se regenera, que es lo que pide el ticket.
   5. Delegar en `updateWithOptionalReset({ recipeId, actorId, changes })` y traducir el resultado: `updated` → Receta, `not_found` → `404`.
4. **`RecipeRepository.updateWithOptionalReset`**, en una transacción interactiva `READ COMMITTED`:
   1. Bloquear la fila con `SELECT status, "reviewedById", "publishedAt" … FOR UPDATE`. Extraigo de `approveWithAudit` un helper `lockRecipeLifecycle(tx, id)` que comparten ambos métodos. Si no hay fila → `not_found`.
   2. `wasApproved = locked.status === "APPROVED"`, decidido sobre la fila bloqueada. Con eso, una aprobación concurrente espera el commit de la edición o la edición espera a la aprobación, y en los dos casos el resultado es coherente.
   3. `tx.recipe.update({ where: { id }, data: { ...changes, ...(wasApproved ? { status: "DRAFT", reviewedById: null, publishedAt: null } : {}) } })`. Solo copia los campos presentes, compatible con `exactOptionalPropertyTypes`; `nutritionalInfo: null` va como `Prisma.DbNull`.
   4. Si `wasApproved`, insertar en `audit_logs`: `entityName: "Recipe"`, `action: "RESET_TO_DRAFT"`, `userId: actorId`, `oldValues` y `newValues` (contenido en la pregunta 2).
   5. Devolver `{ outcome: "updated", recipe, resetToDraft: wasApproved }`.
   - **Errores:** `P2002` (colisión de `slug`) → `409` (`RECIPE_SLUG_CONFLICT_MESSAGE`); `P2003` → `401`; cualquier otro error provoca el *rollback*.
5. **`RecipeController.update`:** `try/catch`, lee `req.user`, `req.valid.params` y `req.valid.body`, y responde `200` JSend `"Receta actualizada exitosamente"`. El sobre no expone el resultado del reinicio, porque la receta devuelta ya muestra `status: "DRAFT"`.
6. **`recipe.router.ts`:** `router.put("/:id", authGuard, validateMiddleware({ params: recipeIdParamsSchema, body: updateRecipeSchema }), controller.update)`. Sin RBAC, porque cualquier rol puede editar lo propio. No choca con `PUT /:id/approve`.
7. **Fuera de alcance:** `DELETE` (#21), la colección Thunder Client y migraciones (el esquema ya alcanza).

## Fases

### Fase 1 — Rama y registro del plan · Estado: Hecha
- [x] Crear la rama `feat/20-recipes-update-reset` desde `main` (`3488049`, con #19 mergeado)
- [x] Mover el #20 a `In Progress` en el Project
Criterio: rama creada y plan aprobado.

### Fase 2 — Implementación · Estado: Hecha
- [x] `recipeFieldsShape`, `createRecipeSchema` (sin cambio de contrato) y `updateRecipeSchema` + `UpdateRecipeDTO`
- [x] `canEdit` en `recipe.policy.ts`
- [x] Helper `lockRecipeLifecycle` (refactor de `approveWithAudit` sin cambio de comportamiento) y `updateWithOptionalReset`
- [x] `RecipeService.update` (con `RN-07` parcial), `RecipeController.update`, la ruta y los re-exports
- [x] Actualizar los mocks de `IRecipeRepository`/`IRecipeService`
- [x] `npm run typecheck && npm run typecheck:test && npm run build && npm test` (0 `any`, 0 `as unknown as`)
Criterio: compilación estricta y las 903 pruebas existentes en verde, incluidas las de `createRecipeSchema` y la aprobación sin modificarse.
Resultado: typecheck, typecheck:test y build OK; las 98 pruebas de `recipe.schema.test.ts` y las de aprobación pasan sin cambios.

### Fase 3 — Pruebas · Estado: Hecha
- [x] `recipe.schema.test.ts`:
  - `updateRecipeSchema` **no inyecta** `difficulty`/`tags` (es la regresión del hallazgo crítico)
  - `{}` → `400`
  - campos protegidos → `400`
  - validadores heredados (título corto, URL `javascript:`, `tags` > 20, ingrediente estricto)
  - `null` en opcionales y en obligatorios, según la pregunta 1
- [x] `recipe.policy.test.ts`: `canEdit` para los 4 roles × (autor / no autor)
- [x] `recipe.service.test.ts` (mock solo de `IRecipeRepository`):
  - `404`, `403` (otro usuario y `ADMIN`) y `400` de `RN-07` (cada regla y acumuladas), todos sin escribir
  - campos ausentes no se validan ni se envían
  - `slug` regenerado solo con `title`
  - mapeo de los resultados del repositorio y propagación de `409`
- [x] `recipe.controller.test.ts`: `200` JSend; `401` sin `req.user`; `400` sin `req.valid.params`/`body`; `next(err)`
- [x] `tests/integration/http/recipes-update.test.ts` (Supertest + PostgreSQL 15):
  - `200` en `DRAFT`: actualiza solo los campos enviados (`difficulty`/`tags` intactos), `slug` sin cambios y 0 filas en `audit_logs`
  - `200` en `APPROVED`: `status = DRAFT`, `reviewedById`/`publishedAt` en `null` y exactamente 1 fila `RESET_TO_DRAFT` con `userId` del Autor, `oldValues` y `newValues`; una segunda edición, ya en `DRAFT`, no agrega filas
  - `title` regenera el `slug` (`<titulo-normalizado>-<8-hex>`, distinto del anterior); sin `title`, el `slug` no cambia
  - edición completa (todos los campos); `nutritionalInfo: null` deja SQL `NULL`, según la pregunta 1
  - `400`: `{}`, BOPLA (`status`, `authorId`, `reviewedById`, `publishedAt`, `slug`), `RN-07` (`prepTimeMinutes: 0`/`1441`, `ingredients: []`, `quantity: 0`) y `:id` inválido
  - `401`: sin token, con token inválido o expirado, y antes de validar el body
  - `403`: otro `USER` y `ADMIN`, sin cambios en la base
  - `404` con UUID v4 inexistente
  - `409` por colisión real de `slug`, con `generateSlug` inyectado como en #16; la fila queda intacta
  - **Carrera determinista** (barrera `FOR UPDATE` como en #19): con una aprobación en vuelo, la edición se aplica después del commit, ve `APPROVED` y reinicia + audita. Con una edición en vuelo sobre `DRAFT`, la aprobación que llega después aprueba el contenido ya editado.
  - **Atomicidad:** con un trigger temporal que hace fallar la inserción de `RESET_TO_DRAFT`, el `UPDATE` se revierte (campos y estado intactos) y la respuesta es `500` sin detalles
- [x] Suite completa en verde y chequeos de mutación: decidir el reinicio con la lectura del servicio, sacar la inserción de auditoría de la transacción y volver a `.partial()` sobre el esquema de alta deben hacer fallar las pruebas
Criterio: todos los criterios de aceptación del issue cubiertos.
Resultado: 39 archivos · 991 pruebas en verde; `recipes-update.test.ts` (28) estable en 4 corridas seguidas.
- **Mutaciones detectadas:**
  - (a) sin `FOR UPDATE` → fallan 2 pruebas de concurrencia;
  - (c) `createRecipeSchema.partial()` → fallan 7 unitarias y la integración de edición parcial;
  - (d) decidir el reinicio con una lectura no bloqueada → fallan 2 pruebas de concurrencia.

### Fase 4 — Documentación, auditorías y cierre · Estado: Hecha
- [x] `CHANGELOG.md`; `docs/business_rules.md` (`RN-02`: lectura bloqueada y semántica de `null`); `README.md` y `docs/sad.md` solo si cambia el contrato
- [x] Auditorías con 3 subagentes en paralelo (`code-reviewer`, `security-auditor`, `qa-tester`) y resolución de hallazgos
- [x] Archivar el plan y verificar con `git status --short`
- [ ] Commit sugerido: `feat(recipes): agregar edición por el autor PUT /recipes/:id con reinicio a borrador atómico` — *commit/push/PR solo con confirmación*
Criterio: auditorías aprobadas, suite en verde y listo para el PR.

## Resultado final
- `npm run typecheck`, `npm run typecheck:test`, `npm run build` y `npm test` en verde: 39 archivos · 992 pruebas (`sequence.shuffle: true`); `dist/` sin tests; 0 `any`/`as unknown as`.

## Auditorías (3 subagentes en paralelo, definiciones de `.agents/agents/`, solo lectura)
- **security-auditor:** sin VETO.
  - Baja: si la edición confirma justo antes de una aprobación concurrente, se aprueba contenido que el revisor no leyó → **documentado** en `docs/sad.md` §7. La mitigación (`If-Match`/`updatedAt` en `approve`) cambia el contrato de #19 y queda para un ticket aparte.
  - Baja: la auditoría no guarda el contenido anterior → **se mantiene** por la decisión humana de la pregunta 2.
  - Baja: `PUT` sin rate limit → **documentado** (mitigación prevista: limitador por usuario).
  - Informativas: `canEdit` fuera de la transacción (`authorId` es inmutable) y `404` antes que `403` (las recetas son públicas) → sin cambios.
- **code-reviewer:** aprobado.
  - Baja: la rama `P2003 → 401` de `updateWithOptionalReset` es inalcanzable (el actor es el Autor y `fk_recipes_author` es `RESTRICT`) → **eliminada**, con un comentario.
  - Nits → **documentados** en `RN-02`: `changedFields` incluye `slug` al cambiar `title`, y una edición sin cambios reales también reinicia. El desvío respecto de `.partial()` se explica en el PR y en el issue.
- **qa-tester:** apto.
  - Media: faltaba el `409` sobre una receta `APPROVED` → **resuelto** (verifica que el reinicio se revierte y que no queda auditoría).
  - Bajas → **resueltas**: la edición completa verifica lo persistido y el `slug` nuevo; el `500` verifica la forma JSend; se reforzaron 2 unitarias del servicio.
  - Baja: la segunda prueba de concurrencia es secuencial → **se mantiene** como prueba del orden "edición → aprobación".

## Preguntas abiertas (resueltas: opciones recomendadas)
1. **¿Permitir `null` para vaciar `nutritionalInfo`, `coverImageUrl` y `videoUrl`?** Recomendado: sí. Hoy una receta con portada nunca podría quitarla. Los campos obligatorios seguirían rechazando `null` con `400`.
2. **¿Qué se guarda en `oldValues`/`newValues` del `RESET_TO_DRAFT`?** Recomendado: el snapshot de ciclo de vida (`status`, `reviewedById`, `publishedAt`), como en `APPROVE`, más `changedFields` (la lista ordenada de los campos editados) en `newValues`. Así queda trazable qué se tocó y quién había firmado, sin duplicar JSONB pesados (`ingredients`). La alternativa es guardar además los valores anteriores y nuevos de cada campo editado: trazabilidad completa, pero con más volumen y con contenido de salud implícita (`nutritionalInfo`, `tags`, Ley 25.326) duplicado en la auditoría.

## Riesgos
- **Refactor de `createRecipeSchema`:** separar la forma base de los defaults no debe cambiar mensajes ni orden de los issues; las pruebas de #16 son la red de seguridad.
- **Desvío del texto del ticket:** `updateRecipeSchema` no se deriva literalmente de `createRecipeSchema.partial()` por el bug de defaults verificado; queda documentado en el plan, el PR y el issue.
- **Regenerar el `slug` en cada edición con `title`** cambia la URL legible aunque el título no cambie. Es lo que pide el ticket. Evitarlo comparando con el título actual queda como mejora posible.
