# Plan: Rendimiento y protección del catálogo público — índice de orden y rate limit en GET /api/v1/recipes (#36)

Fecha: 2026-11-23 · Rama: `perf/36-recipes-index-rate-limit` · Origen: hallazgo medio (OWASP API4) de `security-auditor` en #17 · Estado: **Completado y archivado (2026-11-23)**

## Objetivo
`GET /api/v1/recipes` es anónimo. Cada página ejecuta `ORDER BY "createdAt" DESC, id DESC OFFSET n LIMIT m` más un `count(*)` sin índice que cubra el orden y sin rate limit. #17 acotó la ventana `page × limit ≤ 10000`; este issue completa la mitigación:
1. **Medir** el costo real con `EXPLAIN (ANALYZE, BUFFERS)` sobre datos sintéticos antes de tocar el esquema.
2. **Índice** que permita resolver el orden sin *sort* de tabla completa.
3. **Rate limit por IP** en el catálogo público con respuesta `429` en JSend.

## Contexto que el agente debe leer
- `AGENTS.md` (límites: migraciones, `package.json`, `.env`, Docker), `.agents/rules/database-migrations.md`, `.agents/skills/db-migration/SKILL.md`, `.agents/skills/express-backend-engineering/SKILL.md` (store en memoria vs multi-réplica)
- `prisma/schema.prisma`, `prisma/migrations/20261121201424_init/migration.sql`, `docs/data_model.md`
- `src/app.ts` (orden de middlewares, `trustProxy`), `src/bootstrap/container.ts`, `src/modules/recipes/recipe.router.ts`, `src/middlewares/error-handler.middleware.ts` (`AppError` 429 ya tipado)

## Hallazgos del análisis
- **Índices actuales en `recipes`:** `idx_recipes_authorid (authorId)`, `idx_recipes_status_difficulty (status, difficulty)` y el único de `slug`. Ninguno sirve para `ORDER BY "createdAt" DESC, id DESC`: hoy cada página es *Seq Scan + Sort* (top-N heapsort con `LIMIT`, pero recorre toda la tabla).
- **#18 (`GET /recipes/mine`)** consultará `WHERE "authorId" = $1 ORDER BY "createdAt" DESC, id DESC`: un índice `("authorId", "createdAt" DESC, id DESC)` lo resuelve sin *sort* y, por ser prefijo izquierdo, reemplaza a `idx_recipes_authorid` (incluida la verificación de la FK `ON DELETE RESTRICT`).
- **`count(*)`** no se acelera con B-Tree de forma significativa (sigue siendo *Seq/Index Only Scan*); la ventana de #17 y el rate limit acotan su frecuencia. Paginación por cursor o conteo estimado quedan para v1.0.
- **Rate limit:** `express-rate-limit` (MIT, `peer express >= 4.11`, 2 dependencias) es el estándar; la última versión con ≥ 2 semanas es **`8.7.3`** (2026-11-02). Store en memoria: válido para el MVP de **una réplica**; con varias réplicas requiere store compartido (Redis), según `express-backend-engineering`.
- **IP del cliente:** `buildApp` ya acepta `trustProxy`, pero `server.ts` no lo configura (default `false`). `compose.yaml` de producción no publica el puerto de la API (se asume un proxy delante): detrás de un proxy sin `trust proxy`, **todos los clientes compartirían la IP del proxy** y un solo cliente bloquearía a todos. Configurarlo requiere una variable de entorno nueva (`.env.example`, límite de `AGENTS.md`).
- **Tests existentes:** `tests/integration/http/recipes-list.test.ts` construye una sola app y hace ~90 requests; con un límite por defecto cercano a 100/min empezaría a recibir `429`. El limitador debe ser configurable por `buildApp` (y desactivable en suites que no lo prueban).

## Decisiones aprobadas (2026-11-23)
- **Índices:** orden + autor (`idx_recipes_createdat_id`, `idx_recipes_authorid_createdat_id`) y retiro de `idx_recipes_authorid`. Confirmación explícita para `prisma migrate`, condicionada a que la medición de la Fase 2 lo justifique.
- **Rate limit:** `express-rate-limit@8.7.3` (versión exacta). Aprobación para modificar `package.json`.
- **Límite por defecto:** 120 solicitudes/minuto por IP en `GET /api/v1/recipes`.

## Detalle de las decisiones
1. **Índices (migración Prisma, `migrate dev --create-only` + revisión del SQL + `migrate deploy` local):**
   - Nuevo `idx_recipes_createdat_id ("createdAt" DESC, id DESC)` → `@@index([createdAt(sort: Desc), id(sort: Desc)])`.
   - Nuevo `idx_recipes_authorid_createdat_id ("authorId", "createdAt" DESC, id DESC)` y **eliminar** `idx_recipes_authorid` (redundante).
   - Se mantiene `idx_recipes_status_difficulty` (filtros de baja cardinalidad; el planner decidirá entre él y el índice de orden según `EXPLAIN`).
   - `CREATE INDEX` simple (tabla chica en el MVP); `CONCURRENTLY` documentado para producción con datos.
2. **Rate limit:** dependencia `express-rate-limit@8.7.3` (versión exacta) con:
   - `createRateLimitMiddleware(options)` en `src/middlewares/rate-limit.middleware.ts`: `windowMs` y `limit` inyectables, `standardHeaders: "draft-8"` (`RateLimit`, `RateLimit-Policy`) y `Retry-After`, `legacyHeaders: false`, `handler` que delega `next(new AppError(429, "Demasiadas solicitudes, intentá nuevamente más tarde"))` → JSend por el error handler global.
   - Valor por defecto: **120 solicitudes por minuto por IP** en `GET /api/v1/recipes` (lectura pública); se aplica **antes** de `validateMiddleware` para cortar temprano (las respuestas `400` también consumen cuota).
   - Wiring: `BuildAppOptions.publicRateLimit?: { windowMs, limit } | false` → `buildApiRouters` → `createRecipeRouter(controller, authGuard, { publicReadLimiter })`. `false` solo en suites que no prueban el limitador.
   - `cors`: `exposedHeaders` con `RateLimit`, `RateLimit-Policy` y `Retry-After` para clientes de navegador.
   - **Sin** variable de entorno nueva ni `TRUST_PROXY` en este issue (MVP con la API expuesta directamente); se documenta la limitación y se propone issue aparte.
3. **Fuera de alcance:** rate limit de `POST /api/v1/auth/login` (fuerza bruta; recomendado como issue propio), store Redis, paginación por cursor y conteo estimado (v1.0).

## Fases

### Fase 1 — Rama y registro del plan · Estado: Hecha
- [x] Crear la rama `perf/36-recipes-index-rate-limit` desde `main` (`39268dc`, con #17 mergeado)
- [x] Persistir este plan
Criterio: rama creada y plan registrado.

### Fase 2 — Medición base (sin cambios de esquema) · Estado: Hecha
- [x] Script `scripts/perf/explain-recipes-list.sql`: dentro de `BEGIN … ROLLBACK` inserta ~100k recetas sintéticas (`generate_series`, 2 autores), ejecuta `ANALYZE` y `EXPLAIN (ANALYZE, BUFFERS)` para: listado por defecto, `page=100&limit=100`, filtro `status`, filtro `authorId` y el `count(*)`; luego crea los índices propuestos **dentro de la misma transacción** y repite. Nada persiste.
- [x] Ejecutar con `docker compose exec -T postgres psql …` y registrar tiempos y planes (antes/después) en este plan
Criterio: evidencia de que los índices eliminan el *Sort* y la mejora justifica la migración (si no, ajustar la decisión 1 y consultar).

**Resultado (2026-11-23, PostgreSQL 15 en Docker, 100.000 recetas / 100 autores, `BEGIN … ROLLBACK`; la base quedó intacta: 0 filas y los mismos 4 índices antes y después):**

| Consulta | Antes (plan) | Antes | Después (plan) | Después |
|---|---|---:|---|---:|
| Q1 listado `page=1, limit=20` | Parallel Seq Scan + top-N Sort | 83–103 ms | Index Scan `idx_recipes_createdat_id` | 0,08 ms |
| Q2 `page=100, limit=100` (OFFSET 9900) | Parallel Seq Scan + Sort (2,3 MB) | 122–174 ms | Index Scan `idx_recipes_createdat_id` | 4 ms |
| Q3 `status=APPROVED` | Bitmap `idx_recipes_status_difficulty` + Sort de 30.000 filas | 28–71 ms | Index Scan `idx_recipes_createdat_id` | 0,08 ms |
| Q4 `authorId` (~10 % de filas, caso `/mine`) | Bitmap `idx_recipes_authorid` + Sort | 10–15 ms | Index Scan `idx_recipes_authorid_createdat_id` | 0,15 ms |
| Q4b `authorId` (~0,9 %) | Bitmap `idx_recipes_authorid` + Sort | 1,8 ms | Index Scan `idx_recipes_authorid_createdat_id` | 0,14 ms |
| Q4c / FK `ON DELETE RESTRICT` (autor sin recetas) | Index Scan `idx_recipes_authorid` | 0,1 ms | Index Scan `idx_recipes_authorid_createdat_id` | 0,06–0,09 ms |
| Q5 `count(*)` sin filtros | Seq Scan | 20–61 ms | Seq Scan (sin cambio) | 18–19 ms |
| Q6 `count(*)` por `authorId` | Bitmap `idx_recipes_authorid` | 6–9 ms | Bitmap `idx_recipes_authorid_createdat_id` | 7 ms |

**Conclusiones:**
- Los índices eliminan el *Sort* de tabla completa en todas las páginas (mejora de 1–3 órdenes de magnitud) y el costo de la página más profunda permitida pasa de ~150 ms a ~4 ms.
- `idx_recipes_authorid_createdat_id` reemplaza sin regresión a `idx_recipes_authorid`, incluido el chequeo de la FK `RESTRICT` al borrar un usuario → se confirma su retiro.
- `count(*)` sin filtros no mejora con B-Tree (esperado): queda acotado por la ventana de #17 y el rate limit de la Fase 4.
- **Se confirma la Fase 3 tal como fue aprobada.** Script reproducible: `scripts/perf/explain-recipes-list.sql`.

### Fase 3 — Migración de índices · Estado: Hecha
- [x] `prisma/schema.prisma`: nuevos `@@index` y retiro de `idx_recipes_authorid`; `npm run db:validate`
- [x] `npx prisma migrate dev --create-only --name recipes_list_order_indexes`, revisar el SQL generado (solo `CREATE INDEX`/`DROP INDEX`, sin pérdida de datos) y aplicar con `npx prisma migrate deploy`
- [x] Prueba de integración en `tests/integration/database/relational-integrity.test.ts`: los índices existen en `pg_indexes` con las columnas y el orden esperados y `idx_recipes_authorid` ya no existe
- [x] `docs/data_model.md` (lista de índices)
Criterio: migración aplicada, suite en verde, `prisma migrate status` sin drift.
Resultado:
- Migración `20261123145000_recipes_list_order_indexes` generada con `--create-only` y **reordenada a mano** (crea los índices nuevos antes de `DROP INDEX "idx_recipes_authorid"` para que la FK nunca quede sin índice); aplicada con `prisma migrate deploy`. `prisma migrate status` al día y `migrate diff --from-config-datasource --to-schema` vacío (sin drift).
- `relational-integrity.test.ts`: lista de índices actualizada, `indexdef` exacto de ambos índices y prueba de plan (`EXPLAIN` con `enable_seqscan`/`enable_bitmapscan` desactivados) que exige *Index (Only) Scan* sin nodo *Sort* para el catálogo y `/mine`.
- `docs/data_model.md` y las referencias de skills (`orm-persistence-js-ts`, `postgresql-engineering`) actualizadas; `database_schema_init.sql` se conserva como referencia histórica.
- 29 archivos · 637 pruebas en verde; typecheck, typecheck:test y build OK.

### Fase 4 — Rate limit · Estado: Hecha
- [x] `npm install express-rate-limit@8.7.3` (exacto) y registrar en `docs/dependency-overrides.md` si aplicara
- [x] `src/middlewares/rate-limit.middleware.ts` + wiring en `app.ts` → `container.ts` → `recipe.router.ts`; `exposedHeaders` en CORS; `publicRateLimit: false` en `recipes-list.test.ts`
- [x] Pruebas: unitarias del middleware (`429` JSend vía `next`, headers `RateLimit`/`Retry-After`, ventana inyectable) e integración (`limit: 3` → 3 × `200` y 4.º `429` JSend; el contador es por IP; `POST /api/v1/recipes`, `/auth` y `/health` no se ven afectados; un `400` consume cuota)
- [x] `npm run typecheck && npm run typecheck:test && npm run build && npm test`
Criterio: suite completa en verde y comportamiento `429` verificado.
Resultado:
- `express-rate-limit@8.7.3` exacto (`--save-exact`): agrega solo `ip-address` (`debug` ya venía con Express); `npm audit` sin vulnerabilidades. No requirió entrada en `docs/dependency-overrides.md`.
- `src/middlewares/rate-limit.middleware.ts`: `createRateLimitMiddleware` (validación *fail fast* de `windowMs`/`limit`), `DEFAULT_PUBLIC_READ_RATE_LIMIT` congelado (120/min, política `recipes-public-read`), headers draft-8 + `Retry-After`, sin `X-RateLimit-*`, `429` vía `AppError` → JSend. El `pk` de `RateLimit-Policy` es un hash (no expone la IP).
- Wiring: `BuildAppOptions.publicRateLimit` → `BuildApiRoutersOptions` → `createRecipeRouter(..., { publicReadLimiter })`, solo en `GET /` y antes de `validateMiddleware`; CORS `exposedHeaders` (`RateLimit`, `RateLimit-Policy`, `Retry-After`). `server.ts` no cambia (usa el default).
- Pruebas: 10 unitarias (`rate-limit.middleware.test.ts`) y 8 de integración (`recipes-rate-limit.test.ts`): default 120/min, `429` JSend con `Retry-After`, los `400` consumen cuota, `POST /recipes`/`/auth`/`/health` no afectados, contadores por IP (con `trustProxy: 1`), agrupación IPv6 `/56`, CORS y desactivación explícita. `recipes-list.test.ts` usa `publicRateLimit: false`.
- Nota: la librería advierte (`ERR_ERL_PERMISSIVE_TRUST_PROXY`) si `trust proxy` es `true`; las pruebas usan `1` salto, que es la configuración correcta detrás de un único proxy.
- 31 archivos · 655 pruebas en verde (18 nuevas en esta fase), sin advertencias `ERR_ERL_*`; typecheck, typecheck:test y build OK.

### Fase 5 — Documentación, auditorías y cierre · Estado: Hecha
- [x] `CHANGELOG.md`, `README.md` (código `429` en el catálogo), `docs/sad.md` (rate limit y su límite de una réplica), `docs/data_model.md`
- [x] Auditorías como 3 subagentes en paralelo (`code-reviewer`, `security-auditor`, `qa-tester`; solo lectura, sin tocar la DB) y resolución de hallazgos
- [x] Proponer issues aparte (`needs-triage`): rate limit de `/auth/login` y `TRUST_PROXY` para despliegues detrás de proxy
- [x] Archivar el plan en `docs/plans/archivo/`
Criterio: auditorías aprobadas y suite en verde, listo para commit/push/PR.

## Auditorías (3 subagentes de Claude Code en paralelo, definiciones de `.agents/agents/`, solo lectura)
- **code-reviewer:** aprobado (solo nits). RN-03 preservada (la FK sigue respaldada por índice), migración sin pérdida de datos, retrocompatibilidad de `buildApp`/`buildApiRouters`/`createRecipeRouter`, dependencia exacta con `integrity`. Baja: test de ventana con 200 ms/300 ms frágil → **resuelto** (1 s / 1,5 s y aserción previa a la espera). Nits: identificador por defecto sin aserción → **resuelto**; `CONCURRENTLY` en el checklist de producción → **resuelto** (`docs/sad.md` §7).
- **security-auditor:** sin VETO. Media: detrás de un proxy sin `trust proxy` todos los clientes comparten cuota (DoS a terceros) → fuera de alcance aprobado, **issue #38** (bloqueante para desplegar detrás de proxy) y documentado en `docs/sad.md`. Baja: el script de medición tenía efectos fuera de la transacción (`ANALYZE` en `pg_class`, locks) y sin guardas → **resuelto**: `\set ON_ERROR_STOP 1`, `-v confirm_dev=1` obligatorio, aborta si `recipes` tiene más de 1000 filas, `ANALYZE` tras el `ROLLBACK`; además se hizo **independiente del estado de migraciones** (falló al re-ejecutarlo con la migración aplicada: `idx_recipes_createdat_id already exists`, y dejó `reltuples = 100000`, que se restauró con `ANALYZE`). Verificado: sin evasión por `X-Forwarded-For`, `HEAD`, mayúsculas ni barra final; IPv4 mapeado normalizado; sin IP en headers; cadena de suministro limpia.
- **qa-tester:** cobertura suficiente; prueba de plan significativa (no tautológica). Media: falta probar que sin `trust proxy` se ignora `X-Forwarded-For` → **resuelto**. Media: flakiness del test de ventana → **resuelto**. Bajas → **resueltas**: `429` sin invocar handler / sin consultar la base (contador y `vi.spyOn(findMany)`), CORS en `429`, preflight `OPTIONS` sin consumir cuota, identificador por defecto, `NaN`/`Infinity` en la validación; agregado `HEAD`/mayúsculas/barra final.

## Resultado final
- `npm run typecheck`, `npm run typecheck:test`, `npm run build` y `npm test` en verde: 31 archivos · 663 pruebas (26 nuevas en #36: 14 unitarias del middleware, 12 de integración del rate limit, más 2 de índices/planes y la lista de índices actualizada), sin advertencias `ERR_ERL_*`; `dist/` sin tests.
- Issues de seguimiento creados (`needs-triage`, agregados al Project): **#38** `TRUST_PROXY` y **#39** rate limit de `POST /api/v1/auth/login` (depende de #38).

