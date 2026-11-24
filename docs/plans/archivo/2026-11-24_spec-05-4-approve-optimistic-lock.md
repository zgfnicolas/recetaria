# Plan: [Spec 05.4] Bloqueo optimista en la Aprobación (If-Match/ETag) para no aprobar contenido no revisado (#46)

Fecha: 2026-11-24 · Rama: `feat/46-approve-optimistic-lock` · Parent: `#5` · Estado: **Completado y archivado (2026-11-24); pendiente commit/PR**

## Objetivo
Impedir que `PUT /api/v1/recipes/:id/approve` apruebe un contenido distinto del que leyó el Revisor Profesional:
- `GET /api/v1/recipes/:id` expone un `ETag` fuerte con la versión de la Receta.
- La aprobación **exige** `If-Match` con esa versión: sin el header responde `428`; con una versión que no coincide, `412`.
- La versión se compara **sobre la fila bloqueada** (`FOR UPDATE`) dentro de `approveWithAudit`.

Es un cambio de contrato de #19 (RFC 9110 §8.8.3, §13.1.1; RFC 6585 §3).

## Contexto que el agente debe leer
- `AGENTS.md`, `docs/business_rules.md` (`RN-04`, `RN-06`), `docs/sad.md` §6 (contrato JSend, CORS) y §7 (riesgo "Aprobación sin versión del contenido revisado"), `docs/data_model.md`
- Código:
  - `src/modules/recipes/*`: `lockRecipeLifecycle`, `approveWithAudit`, `updateWithOptionalReset`, `findById`, `RECIPE_PUBLIC_SELECT`
  - `src/shared/errors/app-error.ts` (`HttpErrorStatusCode`)
  - `src/middlewares/error-handler.middleware.ts`
  - `src/app.ts` (CORS: `DEFAULT_CORS_ALLOWED_HEADERS`, `exposedHeaders`; Express `etag` por defecto)
  - `prisma/schema.prisma` y la migración `20261121201424_init` (trigger `update_updated_at_column`)
- Pruebas de referencia: `tests/integration/http/recipes-approve.test.ts` y `recipes-update.test.ts` (barreras `FOR UPDATE` + `pg_stat_activity`)

## Análisis del estado actual
- **`updatedAt` no sirve como versión confiable.** El trigger `update_updated_at_column` asigna `NOW()`, que en PostgreSQL es la hora de **inicio de la transacción**, no la del commit.
  - Ejemplo: una edición que empezó en `t1` y esperó el lock confirma *después* de una aprobación que empezó en `t2 > t1`. Su `updatedAt` queda en `t1`, así que la versión puede **retroceder**.
  - Dos `UPDATE` en la misma transacción comparten el valor.
  - Además, `timestamptz` tiene precisión de µs y JS/Prisma de ms: el ETag habría que derivarlo en SQL para evitar falsos `412`.
  - Funcionaría en la práctica (rara vez dos versiones coinciden), pero no es determinista.
- **Express ya genera ETags débiles** (`etag: "weak"` por defecto, `W/"…"` sobre el cuerpo JSON) y resuelve `If-None-Match` → `304` en los `GET`. Si la respuesta ya tiene un header `ETag`, Express no lo pisa. Fijar un ETag **fuerte** explícito en `GET /:id` es compatible y suma el `304` condicional de forma gratuita. Un `W/"…"` enviado en `If-Match` nunca coincide (comparación fuerte), y eso es correcto.
- **CORS:**
  - `allowedHeaders` solo contiene `Content-Type` y `Authorization`, así que un navegador no podría enviar `If-Match` → hay que agregarlo.
  - `exposedHeaders` solo contiene los de rate limit, así que `ETag` no sería legible desde JS → hay que agregarlo.
- **`HttpErrorStatusCode` no incluye `412` ni `428`.** Hay que extender el tipo, crear las subclases y agregarlos al contrato JSend.
- **Inconsistencia en el ticket:** el criterio 2 dice que `428` se devuelve "sin consultar ni escribir", pero el criterio 5 ubica el `428` después del `404` y del `403` de auto-aprobación, que necesitan leer la base. Hay que elegir uno (pregunta 2).
- **La versión no se debería exponer en el cuerpo:** `RECIPE_PUBLIC_SELECT` define el JSON de todos los endpoints y varias pruebas fijan el conjunto exacto de claves. El contrato de versión es el header `ETag`, no un campo `version` en el body.

## Decisiones propuestas
1. **Versión = columna `version INTEGER NOT NULL DEFAULT 1`** en `recipes` *(requiere migración → confirmación humana, `AGENTS.md`)*:
   - Migración nueva `2026112416…_recipes_version`:
     - `ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1`
     - `CHECK ("version" >= 1)`
     - función `increment_recipe_version()` + trigger `trg_recipes_version` `BEFORE UPDATE` con `NEW."version" := OLD."version" + 1`
   - El trigger ignora cualquier valor que mande el cliente y garantiza el incremento en **toda** escritura (edición, aprobación y reinicio a borrador), incluso en las que se agreguen en el futuro. Las filas existentes quedan en `1`.
   - `prisma/schema.prisma`: `version Int @default(1)`. No se agrega al `RECIPE_PUBLIC_SELECT`; se lee con una selección interna.
2. **ETag fuerte** con el formato `"<version>"` (p. ej. `"3"`), en `recipe.etag.ts`:
   - `formatRecipeETag(version)`.
   - `matchesRecipeETag(ifMatch, version)`, que hace una comparación fuerte según RFC 9110: acepta una lista separada por comas e ignora los `W/"…"`. Es una función pura con pruebas unitarias.
3. **`If-Match` en el borde de transporte:** el middleware `requireIfMatchMiddleware` en `src/middlewares/if-match.middleware.ts` va después de `rbacMiddleware` y antes de `validateMiddleware`. Parsea el header y deja `req.preconditions.ifMatch: readonly string[]` (con *declaration merging*, igual que `req.valid`).
   - Header ausente o vacío → `428` (`"Se requiere If-Match con el ETag de la versión revisada"`).
   - `If-Match: *` → `428`: no identifica una versión, así que no prueba qué se revisó.
   - Header malformado → `400`.
4. **Orden de guardas** *(pregunta 2)*: `401` → `403` RBAC → `428` (borde, sin tocar la base) → `400` `:id` → `404` → `403` auto-aprobación (`RN-05`) → `412` → `409`.
5. **`RecipeService.approve(actor, recipeId, ifMatch)`:** mantiene `404` → `403`. Después hace un chequeo rápido de versión contra la lectura previa (`412`) y de estado (`409`). Delega en el repositorio, que tiene la **verificación autoritativa**.
6. **`RecipeRepository.approveWithAudit({ recipeId, reviewerId, ifMatch })`:**
   - `lockRecipeLifecycle` pasa a devolver también `version`.
   - Sobre la fila bloqueada: si la fila no existe → `not_found`; si `!matchesRecipeETag(ifMatch, version)` → `{ outcome: "precondition_failed" }`; si `status !== "DRAFT"` → `already_approved`; si no, sigue el flujo de #19.
   - Devuelve la receta junto con la versión nueva, para el `ETag` de la respuesta.
   - Si la versión no coincide, la transacción no escribe nada.
7. **`ETag` en las respuestas:**
   - `GET /:id` lo lee con `findByIdWithVersion`.
   - `PUT /:id/approve` (`200`) devuelve el ETag nuevo.
   - **`PUT /:id` (`200`) también lo devuelve**, así el Autor y el cliente conservan la versión vigente. No exige `If-Match` en la edición (pregunta 3).
8. **Errores:** agregar `412` y `428` a `HttpErrorStatusCode`; crear `PreconditionFailedError` y `PreconditionRequiredError`; documentar ambos en el contrato JSend de `docs/sad.md` §6.
9. **CORS:** sumar `If-Match` a `DEFAULT_CORS_ALLOWED_HEADERS` y `ETag` a `exposedHeaders`.
10. **Fuera de alcance:** `If-Match` en `DELETE`, rate limit por usuario y la colección Thunder Client (#6, que deberá leer el detalle antes de aprobar).

## Fases

### Fase 1 — Rama, triage y registro del plan · Estado: Hecha
- [x] Resolver las preguntas abiertas y pasar #46 de `needs-triage` a `ready-for-agent`
- [x] Crear la rama `feat/46-approve-optimistic-lock` desde `main` (`cb938d6`)
- [x] Mover #46 a `In Progress`
Criterio: decisiones aprobadas y rama creada.

### Fase 2 — Migración y persistencia · Estado: Hecha
- [x] Columna `version` + trigger en `prisma/schema.prisma` y migración SQL (autorizada; aplicada con `prisma migrate deploy`; `migrate diff` vacío)
- [x] Aplicar la migración en la base local/de pruebas y regenerar el cliente
- [x] Prueba en `relational-integrity.test.ts`: el trigger incrementa en cada `UPDATE`, ignora un `version` enviado por el cliente, rechaza `version < 1` por `CHECK` y deja las filas existentes en `1`
Criterio: migración aplicada y las 1037 pruebas existentes en verde (la versión no aparece en ningún cuerpo JSON).

### Fase 3 — Implementación · Estado: Hecha
- [x] `recipe.etag.ts` (format/match), `if-match.middleware.ts`, `PreconditionFailedError`/`PreconditionRequiredError` y CORS
- [x] `lockRecipeLifecycle` con `version`, `approveWithAudit` con `precondition_failed`, `findByIdWithVersion` y la versión en el resultado de `updateWithOptionalReset`
- [x] `RecipeService.approve`/`getById`/`update`, los controladores (header `ETag`), la ruta `PUT /:id/approve` con el middleware y los re-exports
- [x] `npm run typecheck && npm run typecheck:test && npm run build && npm test`
Criterio: compilación estricta y suite en verde. Las pruebas de aprobación de #19 se actualizan para enviar `If-Match`: es el único cambio de contrato.

### Fase 4 — Pruebas · Estado: Hecha
- [x] Unitarias:
  - `recipe.etag.test.ts` (formato; listas; `W/`; espacios; comillas faltantes)
  - `if-match.middleware.test.ts` (ausente/vacío/`*` → `428`; malformado → `400`; válido → `req.preconditions`)
  - servicio (`412` antes que `409`; delegación de `ifMatch`; mapeo de `precondition_failed`)
  - controlador (headers `ETag`)
- [x] `tests/integration/http/recipes-approve-etag.test.ts` (+ ajuste de `recipes-approve.test.ts`):
  - `GET /:id` devuelve un `ETag` fuerte `"1"`, y el `ETag` cambia tras una edición, una aprobación y un reinicio
  - `If-None-Match` con el `ETag` vigente → `304`
  - `200` con el `If-Match` vigente; la respuesta trae el `ETag` nuevo
  - `428` sin header y con `*`, sin consultar la base (espía); `400` con un header malformado
  - `412` con un ETag arbitrario, con un `W/"1"` y con un ETag de otra versión: la receta queda `DRAFT` y no hay auditoría
  - Orden de guardas: `401`, `403` RBAC, `428`, `400`, `404`, `403` auto-aprobación, `412` y `409`, cada uno con la entrada mínima que lo dispara
  - **Carrera determinista** (el riesgo de origen): el revisor obtiene el `ETag`; el Autor edita y confirma mientras la aprobación espera el lock (barrera `FOR UPDATE`); la aprobación con el `ETag` viejo recibe `412` y no escribe. Variante: con el `ETag` vigente después de la edición → `200`.
  - CORS: preflight `OPTIONS` con `Access-Control-Request-Headers: if-match` permitido, y `ETag` en `Access-Control-Expose-Headers`
- [x] Chequeos de mutación: si el repositorio ignora `If-Match` (solo queda el chequeo del servicio), la carrera falla; sin el trigger de `version`, falla el cambio de `ETag` tras una edición
Criterio: todos los criterios de aceptación de #46 cubiertos.
Resultado: 44 archivos · 1111 pruebas en verde; `recipes-approve-etag.test.ts` (22).
- **Mutaciones detectadas:**
  - (a) si el repositorio ignora `If-Match` → falla la carrera determinista;
  - (b) sin el trigger `trg_recipes_version` (eliminado temporalmente en la base local y recreado con el SQL de la migración) → fallan 5 pruebas.
- **Ajustes de contrato en las suites de #19/#20:**
  - todas las aprobaciones envían `If-Match`;
  - en la doble aprobación concurrente el perdedor recibe ahora `412`, porque su versión quedó vieja;
  - la aprobación secuencial con el `ETag` vigente sigue respondiendo `409`.

### Fase 5 — Documentación, auditorías y cierre · Estado: Hecha
- [x] `docs/business_rules.md` (`RN-04`: `If-Match` obligatorio), `docs/sad.md` §6 (JSend `412`/`428`, CORS) y §7 (riesgo cerrado), `docs/data_model.md` (`version`, trigger), `README.md` (contrato de approve) y `CHANGELOG.md` (`Changed`: cambio de contrato de #19)
- [x] Auditorías con 3 subagentes en paralelo y resolución de hallazgos
- [x] Archivar el plan; commit sugerido `feat(recipes): exigir If-Match/ETag en la aprobación para no aprobar contenido no revisado` — *commit/push/PR solo con confirmación*
Criterio: auditorías aprobadas, suite en verde y listo para el PR.

## Resultado final
- `npm run typecheck`, `npm run typecheck:test`, `npm run build` y `npm test` en verde: 44 archivos · 1119 pruebas; `dist/` sin tests; migración aplicada y `prisma migrate diff` vacío.
- **Mutaciones detectadas:**
  - el repositorio ignora `If-Match` → falla la carrera;
  - sin el trigger de `version` → fallan 5 pruebas;
  - el servicio usa una versión fija `1` → falla la unitaria de versión real.

## Auditorías (3 subagentes en paralelo, solo lectura y sin tocar la base)
- **security-auditor:** sin VETO.
  - Baja: con versiones correlativas, una lista `If-Match: "1","2",…` equivalía a un `*` → **resuelto**: `requireIfMatchMiddleware({ singleTag: true })` exige un único ETag y una lista → `400`.
  - Baja: `428` antes del `400` del `:id` → **se mantiene** (decisión 2 del triage).
  - Informativas: el ETag revela la cantidad de ediciones (el recurso es público), el desborde de `INTEGER` no es realista y `PUT /:id` sin `If-Match` → sin cambios.
- **code-reviewer:** aprobado.
  - Bajas → **resueltas**: comentarios desactualizados de `already_approved`/`approve()` (el perdedor de una carrera recibe `412`) y `412`/`428` en "Manejo de errores" de `docs/sad.md`.
  - Nits → **resueltos**: la coma en `RN-04` y la limitación de `split(",")` documentada en `parseIfMatch`.
- **qa-tester:** aprobado.
  - Media: el adaptador `findByIdWithVersion` fijaba `version = 1` → **resuelto** con unitarias que mockean directamente la versión 3/7, verifican `findByIdWithVersion`, el orden `404`/`403` antes que `412`, y con el chequeo de mutación de la versión fija.
  - Bajas → **resueltas**: control positivo del espía del `428` y `428` antes del `403` de RN-05 para el Autor.
  - Baja: la rama `already_approved` en el repositorio es prácticamente inalcanzable → **documentada** como guarda defensiva.

## Preguntas abiertas (resueltas: opciones recomendadas; triage cerrado en #46)
1. **Fuente de la versión.** Recomendado: **columna `version` con trigger** (requiere migración; ¿la autorizás?). La alternativa sin migración es `updatedAt` en µs derivado en SQL, con los problemas descritos (`NOW()` toma el inicio de la transacción, no es monotónico y comparte valor dentro de una transacción).
2. **¿Dónde va el `428`?** Recomendado: **en el borde, antes de consultar la base** (orden de la decisión 4). Cumple "sin consultar ni escribir" y es más barato. La alternativa es respetar literalmente el criterio 5 (`428` después del `404` y del `403` de auto-aprobación), que obliga a leer la base antes de rechazar un request mal formado.
3. **`If-Match` en `PUT /:id` (edición).** Recomendado: **no exigirlo en este ticket**, solo devolver el `ETag` en la respuesta, y abrir un ticket opcional para evitar *lost updates* entre ediciones. La alternativa es exigirlo ya, lo que también rompe el contrato de #20.
4. **`If-Match: *`.** Recomendado: **`428`**, porque no identifica la versión revisada. La alternativa es la semántica RFC de "cualquier versión existente", que anularía la protección.

## Riesgos
- **Cambio de contrato:** todo cliente de `approve` debe leer el detalle antes de aprobar. La colección Thunder Client (#6) debe encadenar el `ETag`.
- **Migración sobre una tabla con datos:** `ADD COLUMN … DEFAULT 1` en PostgreSQL 15 no reescribe la tabla (default constante), así que el impacto es bajo; el `CREATE TRIGGER` toma un lock breve.
- **El trigger incrementa en *cualquier* `UPDATE`**, incluidos los administrativos directos sobre la tabla. Eso es lo deseado: cualquier cambio invalida la revisión.
