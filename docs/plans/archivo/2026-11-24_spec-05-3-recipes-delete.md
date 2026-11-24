# Plan: [Spec 05.3] Eliminación física autorizada (DELETE /api/v1/recipes/:id) con snapshot atómico DELETE en audit_logs (#21)

Fecha: 2026-11-24 · Rama: `feat/21-recipes-delete` · Parent: `#5` · Estado: **Completado y archivado (2026-11-24); pendiente commit/PR**

## Objetivo
Habilitar la eliminación física de una Receta (`HU-06`, `RN-03`, `RN-06`):
- Solo pueden eliminarla su Autor o un `ADMIN`. Cualquier otro usuario recibe `403`, incluidos `CHEF`/`NUTRITIONIST` que no sean el Autor.
- La misma `prisma.$transaction` inserta en `audit_logs` el evento `DELETE` con `oldValues = { title, authorId, status }` y borra la fila de `recipes`.
- El Registro de Auditoría sobrevive al borrado, porque `audit_logs.entityId` no tiene FK hacia `recipes`.

## Contexto que el agente debe leer
- `AGENTS.md`, `docs/prd.md` (`HU-06`), `docs/business_rules.md` (`RN-03`, `RN-06`), `docs/roles.md` (borrado propio por cualquier rol y ajeno solo por `ADMIN`), `docs/data_model.md` (políticas referenciales: `audit_logs.entityId` sin FK; `fk_audit_logs_user` con `SET NULL`)
- Código: `src/modules/recipes/*` (`recipe.policy.ts`, `lockRecipeLifecycle`, `approveWithAudit`/`updateWithOptionalReset` y sus resultados discriminados, `recipeIdParamsSchema`, mapeo `P2003 → 401`)
- Pruebas de referencia: `tests/integration/http/recipes-approve.test.ts` y `recipes-update.test.ts` (barreras `FOR UPDATE`, trigger temporal de *rollback*)
- Plan anterior: `docs/plans/archivo/2026-11-24_spec-05-2-recipes-update-reset.md`

## Análisis del estado actual
- **Ya existe y se reutiliza:** `recipeIdParamsSchema`, `findById`, el patrón `SELECT … FOR UPDATE` con resultado discriminado (`not_found`), `AUDIT_ENTITY_RECIPE`, `RecipeAuditAction` (ya incluye `DELETE`), `RECIPE_NOT_FOUND_MESSAGE` y las barreras de prueba de #19/#20.
- **El esquema ya lo soporta:**
  - `audit_logs.entityId` no tiene FK, así que el registro sobrevive al `DELETE` físico.
  - No hay tablas que referencien a `recipes`, por lo que el `DELETE` no puede fallar por FK.
  - No hacen falta migraciones.
- **`lockRecipeLifecycle` no alcanza:** devuelve `status`, `reviewedById` y `publishedAt`, pero el snapshot de `RN-03` necesita `title` y `authorId`. Hay que tomar el snapshot de la fila bloqueada, no de la lectura previa del servicio: una edición del `title` confirmada entre esa lectura y el borrado dejaría en la auditoría un título que ya no era el real.
- **`P2003` sí es alcanzable aquí, a diferencia de #20:** un `ADMIN` sin recetas puede borrarse de `users` mientras su JWT sigue vigente. En ese caso la inserción en `audit_logs` violaría `fk_audit_logs_user`, y corresponde responder `401` (mismo criterio que `create`/`approve`).

## Decisiones propuestas
1. **`recipe.policy.ts` → `canDelete(actor, recipe): boolean`** = `recipe.authorId === actor.id || actor.role === "ADMIN"`. Es pura y se prueba con la tabla de 4 roles × (autor / no autor).
2. **`RecipeService.delete(actor, recipeId)`:**
   1. `findById`: `404` si no existe.
   2. `canDelete`: `403` (`"Solo el autor o un administrador pueden eliminar la receta"`).
   3. Delegar en `deleteWithAudit({ recipeId, actorId })`: `deleted` → `{ id }`; `not_found` → `404` (otro borrado concurrente ganó la carrera).
   - El orden `404` → `403` es el mismo de #19/#20. Que la respuesta revele si el id existe no es un riesgo, porque las recetas son públicas.
3. **`RecipeRepository.deleteWithAudit({ recipeId, actorId })`**, en una transacción interactiva `READ COMMITTED`:
   1. `SELECT title, "authorId", status … FOR UPDATE`, con un helper hermano de `lockRecipeLifecycle` que valida la fila con Zod (*fail-closed* → `500`). Si no hay fila → `{ outcome: "not_found" }`.
   2. `tx.auditLog.create`: `entityName: "Recipe"`, `entityId`, `action: "DELETE"`, `userId: actorId`, `oldValues: { title, authorId, status }` (el snapshot bloqueado) y `newValues` en SQL `NULL`.
   3. `tx.recipe.delete({ where: { id } })`.
   4. Devolver `{ outcome: "deleted" }`.
   - **Errores:** `P2003` (actor inexistente con JWT válido) → `401` (`INVALID_AUTHOR_MESSAGE`). Cualquier otro error provoca el *rollback* de ambas operaciones.
   - **Concurrencia:**
     - Dos borrados simultáneos (Autor + `ADMIN`): el segundo espera el lock, ya no encuentra la fila y recibe `404`; queda un único `DELETE` auditado.
     - Una edición o aprobación en espera ya resuelve a `404` gracias a `not_found` (#19/#20).
4. **`RecipeController.delete`:** `try/catch`; lee `req.user` y `req.valid.params`; responde `200` JSend con `"Receta eliminada exitosamente"` y `data: { id }`. No usa `204`, porque el contrato JSend pide sobre con `200` y el ticket así lo especifica.
5. **`recipe.router.ts`:** `router.delete("/:id", authGuard, validateMiddleware({ params: recipeIdParamsSchema }), controller.delete)`. Sin RBAC, porque cualquier rol puede borrar lo propio y la excepción de `ADMIN` la resuelve la política.
6. **Re-exports** de `canDelete`, los tipos nuevos y los mensajes.
7. **Fuera de alcance:** borrado lógico, bloqueo optimista en `DELETE` (#46 lo excluye), rate limit por usuario, colección Thunder Client y migraciones.

## Fases

### Fase 1 — Rama y registro del plan · Estado: Hecha
- [x] Crear la rama `feat/21-recipes-delete` desde `main` (`6bebf71`, con #20 mergeado)
- [x] Mover el #21 a `In Progress` en el Project
Criterio: rama creada y plan aprobado.

### Fase 2 — Implementación · Estado: Hecha
- [x] `canDelete` en `recipe.policy.ts`
- [x] Helper `lockRecipeForDelete` (snapshot `{ title, authorId, status }` validado) y `deleteWithAudit` + tipos `DeleteWithAuditInput`/`DeleteWithAuditResult` en `IRecipeRepository`/`RecipeRepository`
- [x] `RecipeService.delete`, `RecipeController.delete`, la ruta y los re-exports
- [x] Actualizar los mocks de `IRecipeRepository`/`IRecipeService`
- [x] `npm run typecheck && npm run typecheck:test && npm run build && npm test` (0 `any`, 0 `as unknown as`)
Criterio: compilación estricta y las 992 pruebas existentes en verde.

### Fase 3 — Pruebas · Estado: Hecha
- [x] `recipe.policy.test.ts`: `canDelete` para 4 roles × (autor / no autor). Solo el Autor o un `ADMIN` devuelven `true`.
- [x] `recipe.service.test.ts` (mock solo de `IRecipeRepository`): `404` sin escribir; `403` para `USER`/`CHEF`/`NUTRITIONIST` ajenos sin escribir; borrado del Autor y del `ADMIN` con `actorId` correcto; `not_found` → `404`; propagación de errores.
- [x] `recipe.controller.test.ts`: `200` JSend `{ id }`; `401` sin `req.user`; `400` sin `req.valid.params`; `next(err)`.
- [x] `tests/integration/http/recipes-delete.test.ts` (Supertest + PostgreSQL 15):
  - `200` del Autor sobre una receta `DRAFT` y sobre una `APPROVED`. La fila desaparece de `recipes` y queda **exactamente 1** `DELETE` en `audit_logs`, con `entityName`, `entityId`, `userId` del actor, `oldValues = { title, authorId, status }` exacto y `newValues` SQL `NULL`. Un `GET /:id` posterior responde `404`.
  - `200` de un `ADMIN` sobre una receta ajena (`userId` = admin, `oldValues.authorId` = Autor).
  - El registro de auditoría **sobrevive**: sigue presente después del borrado y se consulta por `entityId`.
  - `400` con `:id` inválido, y `401` (sin token, token inválido o expirado; también antes de validar el `:id`).
  - `403` para otro `USER`, un `CHEF` ajeno y un `NUTRITIONIST` ajeno (incluido el `CHEF` que la aprobó), sin cambios en la base ni auditoría.
  - `404` con un UUID v4 inexistente, y `404` en un segundo borrado de la misma receta, sin agregar auditoría.
  - `401` para un `ADMIN` con JWT válido borrado de `users` (`P2003`): la receta sigue presente y no se escribe auditoría.
  - **Concurrencia determinista** (barrera `FOR UPDATE`): Autor y `ADMIN` borran a la vez → un `200` + un `404`, y 1 solo `DELETE` auditado. Además, una edición en espera del lock cuya receta se borra resuelve en `404`.
  - **Atomicidad:** con un trigger temporal que hace fallar la inserción de `DELETE` en `audit_logs`, la receta **no** se borra y la respuesta es un `500` JSend sin detalles. Un trigger `BEFORE DELETE` sobre `recipes`, también temporal y limitado a un id, revierte la inserción de auditoría.
- [x] Suite completa en verde y chequeos de mutación: sin `FOR UPDATE`, con el `DELETE` fuera de la transacción o con el snapshot tomado de la lectura del servicio, las pruebas deben fallar
Criterio: todos los criterios de aceptación del issue cubiertos.
Resultado: 268 unitarias de `src/modules/recipes` y 20 de integración en `recipes-delete.test.ts`, en verde.
- **Mutaciones detectadas:**
  - (a) sin `FOR UPDATE` en el snapshot → fallan la carrera de doble borrado y la del título confirmado;
  - (b) con la inserción de auditoría fuera de la transacción → falla el *rollback* por `BEFORE DELETE`.
- La mutación "snapshot tomado de la lectura del servicio" queda cubierta por la prueba del título confirmado sobre la fila bloqueada.

### Fase 4 — Documentación, auditorías y cierre · Estado: Hecha
- [x] `CHANGELOG.md`; `docs/business_rules.md` (`RN-03`: snapshot tomado de la fila bloqueada, `P2003` → `401`, `200` con `{ id }`); `README.md` solo si cambia el contrato
- [x] Auditorías con 3 subagentes en paralelo (`code-reviewer`, `security-auditor`, `qa-tester`) y resolución de hallazgos
- [x] Archivar el plan y verificar con `git status --short`
- [ ] Commit sugerido: `feat(recipes): agregar eliminación física DELETE /recipes/:id con auditoría atómica` — *commit/push/PR solo con confirmación*
Criterio: auditorías aprobadas, suite en verde y listo para el PR.

## Resultado final
- `npm run typecheck`, `npm run typecheck:test`, `npm run build` y `npm test` en verde: 40 archivos · 1037 pruebas (`sequence.shuffle: true`); `dist/` sin tests; 0 `any`/`as unknown as`.
- **Incidencia del proceso:** una corrida de pruebas en paralelo con otra corrida completa en segundo plano, sobre la misma base, dio falsos rojos por interferencia de `TRUNCATE`. Corridas secuenciales: todo en verde. Las corridas contra PostgreSQL no deben solaparse.

## Auditorías (3 subagentes en paralelo, definiciones de `.agents/agents/`, solo lectura)
- **security-auditor:** sin VETO.
  - Media: el auto-registro como `ADMIN` permite borrar todo el catálogo → **documentado** en `docs/sad.md` §7 como bloqueante para Beta (es un compromiso ya aceptado en PRD §9).
  - Baja: `ADMIN` desactivado con JWT vigente → **documentado**.
  - Baja: inmutabilidad de `audit_logs` solo a nivel aplicación (preexistente) → **documentado**, se resuelve con la separación de roles de PostgreSQL.
  - Informativas: `$executeRawUnsafe` en el test (solo constantes) y respuesta mínima `{ id }` → sin cambios.
- **code-reviewer:** aprobado.
  - Baja: `canDelete` se evalúa fuera de la transacción → **documentado** en el JSDoc (depende de que `authorId` sea inmutable).
  - Nit: `authorId` del snapshot ahora se valida con `z.uuid()` → **resuelto**.
  - Nit: el nombre `INVALID_AUTHOR_MESSAGE` → se mantiene (texto genérico).
  - Nit: colección Thunder Client → fuera de alcance.
- **qa-tester:** aprobado, sin pruebas tautológicas.
  - Bajas → **resueltas**:
    - el timeout de la barrera bajó a 5 s;
    - los casos `400`/`401` verifican el cuerpo JSend y que la base quedó intacta;
    - se agregó un `403` de un `CHEF` ajeno sobre una receta `DRAFT`;
    - se verifica que `findById` reciba el id;
    - se renombró la prueba de interacción con `PUT`.

## Preguntas abiertas (resueltas: se siguieron el ticket y la convención de #19/#20)
Ninguna bloqueante. Las tres decisiones siguientes siguen el ticket o la convención de #19/#20; avisame si preferís otra:
1. **Respuesta `200` con `data: { id }`**, en lugar de `data: null` o del snapshot borrado.
2. **`oldValues` limitado a `{ title, authorId, status }`**, como fija `RN-03`. No agrego `reviewedById`/`publishedAt` ni contenido, por minimización de datos de salud implícita.
3. **`newValues` como SQL `NULL`** (no hay estado posterior).

## Riesgos
- **Borrado irreversible:** no hay borrado lógico ni papelera (fuera de alcance del MVP). El único rastro es el snapshot mínimo de `audit_logs`.
- **`ADMIN` desactivado con JWT vigente:** puede borrar hasta que expire el token, por la autenticación stateless (`RN-08`); ya documentado para revisores en `docs/sad.md` §7. Lo extiendo a `ADMIN`.
- **#46 (bloqueo optimista)** ya no está bloqueado, porque #20 se cerró; no interfiere con este ticket.
