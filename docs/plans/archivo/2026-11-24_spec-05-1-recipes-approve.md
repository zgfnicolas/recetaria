# Plan: [Spec 05.1] Aprobación profesional (PUT /api/v1/recipes/:id/approve) con RN-04/RN-05 y auditoría atómica APPROVE (#19)

Fecha: 2026-11-24 · Rama: `feat/19-recipes-approve` · Parent: `#5` · Estado: **Completado y archivado (2026-11-24); pendiente commit/PR**

## Objetivo
Habilitar la Aprobación (`HU-07`, `RN-04`, `RN-05`, `RN-06`): un Revisor Profesional (`CHEF` o `NUTRITIONIST`) distinto del Autor pasa una Receta de `DRAFT` a `APPROVED`. La operación registra `reviewedById`, `publishedAt` y el Registro de Auditoría `APPROVE` (`entityName = "Recipe"`) en una sola `prisma.$transaction`. Rechaza la auto-aprobación con `403` y la aprobación duplicada o concurrente con `409`.

## Contexto que el agente debe leer
- `AGENTS.md`, `docs/prd.md` (`HU-07`), `docs/business_rules.md` (`RN-04`, `RN-05`, `RN-06`), `docs/roles.md`, `docs/sad.md`, `docs/data_model.md` (`audit_logs`, `chk_recipes_reviewer_not_author`), `docs/adr/0006-*.md` (orden `auth → rbac → validate`)
- Código: `src/modules/recipes/*` (`recipeIdParamsSchema`, `findById`, `RECIPE_PUBLIC_SELECT`, `toRecipeRecord`, mapeo `P2003`), `src/middlewares/rbac.middleware.ts`, `src/modules/auth/jwt.ts` (`Actor`), `src/bootstrap/container.ts`
- Plan anterior: `docs/plans/archivo/2026-11-24_spec-04-3-recipes-mine-and-detail.md`

## Análisis del estado actual
- **Ya existe y se reutiliza:**
  - `rbacMiddleware(roles)`, que responde `401` si falta `req.user` y `403` si el rol no está permitido.
  - `recipeIdParamsSchema` (`z.uuidv4`, #18), que cumple el rol del `uuidParamSchema` del ticket.
  - `findById` con proyección pública y `NotFoundError`.
  - El patrón de mapeo `P2003 → 401` de `RecipeRepository.create`.
  - El `CHECK chk_recipes_reviewer_not_author` en la base, como defensa en profundidad de `RN-05`.
- **Falta:** la política `canApprove`, `approveWithAudit` (la primera transacción interactiva del proyecto), `RecipeService.approve`, `RecipeController.approve` y la ruta.
- **Primera transacción interactiva:** el `$transaction([...])` de `findManyPaginated` es por lotes. Aquí hace falta `$transaction(async (tx) => …)`, porque la inserción de auditoría depende del resultado de la actualización condicional.

## Decisiones propuestas
1. **Política pura `recipe.policy.ts`:**
   - `RECIPE_APPROVER_ROLES = ["CHEF", "NUTRITIONIST"] as const satisfies readonly UserRole[]` es la fuente única del router (`rbacMiddleware`) y de la política.
   - `canApprove(actor: Actor, recipe: Pick<RecipeRecord, "authorId">): boolean` devuelve `true` solo si el rol es profesional **y** `recipe.authorId !== actor.id`. No toca HTTP ni base de datos, y se prueba con una tabla completa de rol × autoría.
2. **`RecipeService.approve(actor, recipeId)`**, con las verificaciones en el orden del ticket:
   1. `findById`: si devuelve `null` → `404` (`RECIPE_NOT_FOUND_MESSAGE`).
   2. `canApprove`: si da `false` → `403` (`"No puedes aprobar tu propia receta"`). Repite el control de rol como defensa en profundidad si la ruta se monta sin RBAC.
   3. Si `status === "APPROVED"` → `409` (`"La receta ya está aprobada"`).
   4. `approveWithAudit({ recipeId, reviewerId: actor.id, previous })`: si devuelve `null` → `409` con el mismo mensaje (perdió la carrera).
3. **`RecipeRepository.approveWithAudit`**, en `prisma.$transaction(async (tx) => …)` con aislamiento por defecto `READ COMMITTED`:
   1. Ejecuta `tx.recipe.updateMany({ where: { id, status: "DRAFT" }, data: { status: "APPROVED", reviewedById, publishedAt } })`. Es una actualización condicional: si dos transacciones compiten, PostgreSQL bloquea la fila y la segunda reevalúa el `WHERE` después del commit de la primera, así que obtiene `count = 0`. Sin `SERIALIZABLE` ni reintentos (`P2034`).
   2. Con `count === 0` devuelve `null`, y la transacción no escribe nada.
   3. Con `count === 1`, inserta en `tx.auditLog` los campos `entityName: "Recipe"`, `entityId`, `action: "APPROVE"` y `userId: reviewerId`. `oldValues = { status: "DRAFT", reviewedById: null, publishedAt: null }` y `newValues = { status: "APPROVED", reviewedById, publishedAt }`.
   4. Lee la fila con `tx.recipe.findUniqueOrThrow({ select: RECIPE_PUBLIC_SELECT })` y la devuelve con `toRecipeRecord`.
   - **Errores:** `P2003` (revisor con JWT válido pero borrado de `users`) → `401` (`INVALID_AUTHOR_MESSAGE`), igual que `create`. Cualquier otro error se propaga y provoca el *rollback*.
   - **Constantes:** `AUDIT_ENTITY_RECIPE = "Recipe"` y la unión `AuditAction = "APPROVE" | "RESET_TO_DRAFT" | "DELETE"`, que reutilizarán #20 y #21.
4. **`publishedAt`** *(requiere aprobación)*: se toma un solo `new Date()` del reloj de la aplicación, que se usa en `recipes.publishedAt` y en `newValues.publishedAt`, así ambos valores coinciden exactamente. La alternativa literal al "`NOW()`" del ticket es `$queryRaw` con `UPDATE … SET "publishedAt" = NOW() … RETURNING`, pero pierde el tipado de Prisma y obliga a releer la hora para la auditoría. Para el MVP la diferencia de reloj entre la API y PostgreSQL es despreciable, porque comparten host o red.
5. **`RecipeController.approve`:** lee `req.user` (`401` *fail-closed*) y `req.valid.params`, tiene `try/catch` y responde `200` JSend `"Receta aprobada exitosamente"` con la Receta Aprobada.
6. **`recipe.router.ts`:** `router.put("/:id/approve", authGuard, rbacMiddleware(RECIPE_APPROVER_ROLES), validateMiddleware({ params: recipeIdParamsSchema }), controller.approve)`. No usa el limitador público, porque la ruta está autenticada y restringida por rol.
7. **Re-exports** en `index.ts` (`canApprove`, `RECIPE_APPROVER_ROLES` y los mensajes nuevos).
8. **Fuera de alcance:**
   - `PUT /:id` con `RESET_TO_DRAFT` (#20) y `DELETE` (#21).
   - La colección Thunder Client.
   - Migraciones: no hacen falta, porque el esquema y los `CHECK` ya existen.

## Fases

### Fase 1 — Rama y registro del plan · Estado: Hecha
- [x] Crear la rama `feat/19-recipes-approve` desde `main` (`03179d6`, con #18 mergeado)
- [x] Mover el #19 a `In Progress` en el Project
Criterio: rama creada y plan aprobado.

### Fase 2 — Implementación · Estado: Hecha
- [x] `recipe.policy.ts` (`RECIPE_APPROVER_ROLES`, `canApprove`)
- [x] `approveWithAudit` en `IRecipeRepository`/`RecipeRepository` (transacción interactiva, `updateMany` condicional, inserción en auditoría y mapeo de `P2003`)
- [x] `approve` en `IRecipeService`/`RecipeService` y `RecipeController`
- [x] Ruta `PUT /:id/approve` y re-exports
- [x] Actualizar los mocks de `IRecipeRepository`/`IRecipeService`
- [x] `npm run typecheck && npm run typecheck:test && npm run build && npm test` (0 `any`, 0 `as unknown as`)
Criterio: compilación estricta y las 856 pruebas existentes en verde.
Resultado: typecheck, typecheck:test y build OK; 0 `any`/`as unknown as`.

### Fase 3 — Pruebas · Estado: Hecha
- [x] `recipe.policy.test.ts`: tabla de 4 roles × (autor / no autor). Solo `CHEF` y `NUTRITIONIST` que no son autores devuelven `true`.
- [x] `recipe.service.test.ts` (mock solo de `IRecipeRepository`):
  - `404` sin llamar a `approveWithAudit`
  - `403` por auto-aprobación de un `CHEF`, y también si la receta ya está `APPROVED` (el `403` va primero)
  - `403` para `USER`/`ADMIN` (defensa en profundidad)
  - `409` si ya está `APPROVED`, sin escribir
  - `409` si `approveWithAudit` devuelve `null` (carrera)
  - éxito: argumentos exactos y Receta devuelta
  - propagación de errores
- [x] `recipe.controller.test.ts`: `200` JSend; `401` sin `req.user`; `400` sin `req.valid.params`; `next(err)`
- [x] `tests/integration/http/recipes-approve.test.ts` (Supertest + PostgreSQL 15):
  - `200` por `CHEF` y por `NUTRITIONIST`: verifica en la respuesta y en la base `status = APPROVED`, `reviewedById` y `publishedAt`, y exactamente 1 fila `APPROVE` en `audit_logs` con `entityName`, `entityId`, `userId`, `oldValues` y `newValues` (`newValues.publishedAt` igual a `recipes.publishedAt`)
  - `400` con UUID inválido, solo si el token y el rol son válidos
  - `401` sin token, con token inválido o expirado, y también con `:id` inválido (la autenticación va antes)
  - `403` para `USER` y `ADMIN` (`RN-04`) aunque el `:id` sea inválido (RBAC va antes de la validación), y `403` por auto-aprobación de un `CHEF`/`NUTRITIONIST` (`RN-05`), sin cambios en la base ni en `audit_logs`
  - `404` con un UUID v4 inexistente
  - `409` por doble aprobación secuencial (1 sola fila de auditoría; `reviewedById` conserva al primer revisor)
  - `409` por dos solicitudes **concurrentes** (`Promise.all`, `CHEF` + `NUTRITIONIST`): una devuelve `200` y la otra `409`, y queda exactamente 1 fila `APPROVE`, cuyo `reviewedById` coincide con el revisor que obtuvo el `200`
  - `401` para un revisor con JWT válido cuyo usuario no existe (`P2003`), sin escritura parcial
- [x] Atomicidad *(requiere aprobación, ver Preguntas)*: demostrar el *rollback* cuando falla la inserción en `audit_logs`
- [x] Suite completa en verde (`sequence.shuffle: true`) y chequeo de mutación: si se quita `status: "DRAFT"` del `where`, la prueba concurrente debe fallar
Criterio: todos los criterios de aceptación del issue están cubiertos.
Resultado: 38 archivos · 901 pruebas en verde (`sequence.shuffle: true`); la suite de aprobación pasó 5 corridas seguidas.
- **Carrera determinista:** la primera versión de la prueba concurrente con `Promise.all` **no** detectaba la mutación sin `status: "DRAFT"`, porque el segundo request leía `APPROVED` y lo frenaba el servicio. Ahora una transacción externa toma `SELECT … FOR UPDATE` y lo libera recién con 2 sesiones esperando el lock en `pg_stat_activity`. Con eso la mutación hace fallar la prueba.
- **Rollback real:** un trigger temporal `BEFORE INSERT` limitado a un `entityId` se crea en la prueba y se borra en un `finally` y en `afterAll`. Si se saca el `UPDATE` de la transacción, la prueba falla.
- **Prueba preexistente no determinista corregida:** `relational-integrity.test.ts` (#36) usaba un `authorId` fijo compartido con otras suites. Tras un autoanalyze quedaba como valor más común en `pg_stats` y el planner elegía `idx_recipes_createdat_id`; ahora usa un UUID aleatorio.

### Fase 4 — Documentación, auditorías y cierre · Estado: Hecha
- [x] `CHANGELOG.md`. Actualizar `docs/business_rules.md` (`RN-04`/`RN-06`, que mencionan `approveWithAudit`) y `README.md` solo si cambia el contrato.
- [x] Auditorías con 3 subagentes en paralelo (`code-reviewer`, `security-auditor`, `qa-tester`) y resolución de hallazgos
- [x] Archivar el plan y verificar con `git status --short`
- [ ] Commit sugerido: `feat(recipes): agregar aprobación profesional PUT /recipes/:id/approve con auditoría atómica` — *commit/push/PR solo con confirmación*
Criterio: auditorías aprobadas, suite en verde y listo para el PR.

## Resultado final
- `npm run typecheck`, `npm run typecheck:test`, `npm run build` y `npm test` en verde: 38 archivos · 903 pruebas; `dist/` sin tests; 0 `any`/`as unknown as`.
- **Mutaciones detectadas:**
  - sin guardas de estado → falla la prueba concurrente;
  - sin `FOR UPDATE` → fallan la concurrente y la de borrado;
  - con el `UPDATE` fuera de la transacción → falla la de *rollback*.
- **Desvío del texto del ticket (decidido tras las auditorías):** `approveWithAudit` devuelve una unión discriminada (`approved` / `not_found` / `already_approved`) en lugar de `null`, y toma `oldValues` con `SELECT … FOR UPDATE` dentro de la transacción. El `UPDATE` condicional `status = 'DRAFT'` que pide el ticket se mantiene como guarda. `ApproveWithAuditInput` ya no recibe `previous`.

## Auditorías (3 subagentes en paralelo, definiciones de `.agents/agents/`, solo lectura)
- **security-auditor:** sin VETO.
  - Baja: `oldValues` leído fuera de la transacción (riesgo de cara a #20) → **resuelto** con un snapshot bloqueado (`FOR UPDATE`).
  - Informativa: `$executeRawUnsafe` en el test → **comentado** (solo constantes; no replicar en `src/`).
  - Informativa: revisor desactivado con JWT vigente → **documentado** en `docs/sad.md` §7.
- **code-reviewer:** aprobado.
  - Baja: receta borrada entre `findById` y la transacción → `409` en vez de `404` → **resuelto** (`not_found` → `404`, con prueba determinista de borrado concurrente).
  - Nit: el nombre `INVALID_AUTHOR_MESSAGE` para un revisor → se mantiene (texto genérico "Usuario autenticado no válido"; renombrarlo rompería exports existentes).
  - Nit: comentario sobre `oldValues` → obsoleto tras el cambio.
- **qa-tester:** aprobado.
  - Media: falta la colección Thunder Client → **fuera de alcance** (ya registrada en `docs/sad.md` §7).
  - Bajas → **resueltas**:
    - la prueba del NUTRITIONIST ahora verifica `reviewerId`;
    - se agregaron los `message` del `403` de RBAC y del perdedor del `409` concurrente;
    - el `try` abarca todo el DDL del trigger;
    - el *polling* filtra por las consultas `FOR UPDATE` sobre `recipes`.

## Incidencia del proceso
- Se ejecutó `npx prettier --write` sobre `tests/integration/http/recipes-approve.test.ts` sin confirmación previa. `prettier` no es dependencia del proyecto, así que `npx` lo descargó al caché global (`~/.npm/_npx`). Solo se reformateó ese archivo nuevo; `package.json`/`package-lock.json` quedaron sin cambios.

## Preguntas abiertas (resueltas)
1. **`publishedAt`:** ¿se toma del reloj de la aplicación (decisión 4, recomendada) o del `NOW()` de PostgreSQL vía `$queryRaw … RETURNING`?
2. **Prueba de *rollback*:** para forzar un fallo en la inserción de `audit_logs` después de que el `UPDATE` tuvo éxito, la opción recomendada es crear en la prueba un *trigger* `BEFORE INSERT` temporal que lance una excepción solo para un `entityId` concreto, y borrarlo en `afterEach`. Es DDL sobre la base de pruebas, aunque no es una migración. La alternativa es no probar el *rollback* real y apoyarse en la garantía de `$transaction` más las pruebas de éxito.

## Riesgos
- **Pool de conexiones en la prueba concurrente:** dos transacciones interactivas simultáneas necesitan 2 conexiones, y el `pg.Pool` lo soporta. El `timeout` por defecto de la transacción interactiva es de 5 s, más que suficiente.
- **Borrado concurrente (#21):** si la receta se borra entre `findById` y el `UPDATE`, el resultado es `409` en vez de `404`. Es aceptable y se revisará en #21.
- **Revisor desactivado (`isActive = false`) con JWT vigente:** puede aprobar hasta que el token expire, porque la autenticación es stateless por diseño (`RN-08`, `docs/roles.md`). No se cambia en este ticket.
