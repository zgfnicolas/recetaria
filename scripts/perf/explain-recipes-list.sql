-- Medición de costo de GET /api/v1/recipes (#36). SOLO PARA DESARROLLO.
--
-- Uso (PostgreSQL de desarrollo en Docker; `-v confirm_dev=1` es obligatorio):
--   docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v confirm_dev=1' \
--     < scripts/perf/explain-recipes-list.sql
--
-- Los datos no persisten: todo corre dentro de BEGIN … ROLLBACK (inserta 100 autores y 100.000
-- recetas sintéticas, mide sin los índices propuestos, los crea dentro de la misma transacción y
-- vuelve a medir). Las consultas replican las de `RecipeRepository.findManyPaginated`.
-- Efectos fuera de la transacción que el ROLLBACK no deshace:
--   - `ANALYZE` actualiza `pg_class.reltuples/relpages` en el lugar: por eso se repite un
--     `ANALYZE "recipes"` tras el ROLLBACK para restaurar las estadísticas reales.
--   - `CREATE/DROP INDEX` toman locks sobre "recipes" mientras dura la transacción (segundos):
--     nunca correr contra una base con tráfico. Guardas: `confirm_dev` y tabla casi vacía.

\set ON_ERROR_STOP 1
\set QUIET on
\pset pager off

\if :{?confirm_dev}
\else
  \echo 'ABORTADO: falta -v confirm_dev=1 (script solo para la base de desarrollo).'
  \quit
\endif

SELECT count(*) > 1000 AS tabla_con_datos FROM "recipes" \gset
\if :tabla_con_datos
  \echo 'ABORTADO: "recipes" tiene más de 1000 filas; este script es solo para una base de desarrollo vacía.'
  \quit
\endif

BEGIN;

SET LOCAL synchronous_commit = off;

-- Línea base independiente del estado de migraciones: reconstruye los índices previos a #36
-- (si la migración 20261123145000 ya está aplicada) dentro de la transacción.
DROP INDEX IF EXISTS "idx_recipes_createdat_id";
DROP INDEX IF EXISTS "idx_recipes_authorid_createdat_id";
CREATE INDEX IF NOT EXISTS "idx_recipes_authorid" ON "recipes" ("authorId");

INSERT INTO "users" ("id", "email", "passwordHash", "firstName", "lastName")
SELECT gen_random_uuid(), 'perf-' || g || '@recetaria.test', 'x', 'Perf', 'Autor ' || g
FROM generate_series(1, 100) AS g;

CREATE TEMP TABLE perf_authors ON COMMIT DROP AS
SELECT "id", row_number() OVER (ORDER BY "id") AS n FROM "users" WHERE "email" LIKE 'perf-%';

-- Distribución sesgada: el autor 1 concentra ~10 % de las recetas (caso /mine con muchas filas).
INSERT INTO "recipes" ("title", "slug", "description", "difficulty", "status", "prepTimeMinutes",
                       "ingredients", "authorId", "createdAt")
SELECT 'Receta ' || g,
       'perf-receta-' || g,
       'Descripción sintética para medición de rendimiento.',
       (ARRAY['EASY','MEDIUM','HARD','EXPERT']::"Difficulty"[])[1 + (g % 4)],
       CASE WHEN g % 10 < 3 THEN 'APPROVED'::"RecipeStatus" ELSE 'DRAFT'::"RecipeStatus" END,
       30,
       '[{"name":"Sal","quantity":1,"unit":"g"}]'::jsonb,
       (SELECT "id" FROM perf_authors WHERE n = CASE WHEN g % 10 = 0 THEN 1 ELSE 2 + (g % 99) END),
       timestamptz '2026-01-01 00:00:00+00' + (g * interval '5 minutes')
FROM generate_series(1, 100000) AS g;

ANALYZE "recipes";

SELECT count(*) AS recetas_sinteticas FROM "recipes";
SELECT "id" AS autor_mayoritario FROM perf_authors WHERE n = 1 \gset
SELECT "id" AS autor_minoritario FROM perf_authors WHERE n = 50 \gset
SELECT gen_random_uuid() AS autor_sin_recetas \gset

\echo
\echo '================ ANTES: índices previos a #36 ================'
\echo '--- Q1 listado por defecto (page=1, limit=20)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT "id", "title", "createdAt" FROM "recipes"
ORDER BY "createdAt" DESC, "id" DESC LIMIT 20 OFFSET 0;

\echo '--- Q2 página profunda (page=100, limit=100 → OFFSET 9900, tope de la ventana)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT "id", "title", "createdAt" FROM "recipes"
ORDER BY "createdAt" DESC, "id" DESC LIMIT 100 OFFSET 9900;

\echo '--- Q3 filtro status=APPROVED (page=1, limit=20)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT "id", "title", "createdAt" FROM "recipes" WHERE "status" = 'APPROVED'
ORDER BY "createdAt" DESC, "id" DESC LIMIT 20 OFFSET 0;

\echo '--- Q4 filtro authorId (autor con ~10 % de las filas; caso /mine #18)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT "id", "title", "createdAt" FROM "recipes" WHERE "authorId" = :'autor_mayoritario'
ORDER BY "createdAt" DESC, "id" DESC LIMIT 20 OFFSET 0;

\echo '--- Q4b filtro authorId (autor con ~0,9 % de las filas)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT "id", "title", "createdAt" FROM "recipes" WHERE "authorId" = :'autor_minoritario'
ORDER BY "createdAt" DESC, "id" DESC LIMIT 20 OFFSET 0;

\echo '--- Q4c filtro authorId de un autor sin recetas (página vacía)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT "id", "title", "createdAt" FROM "recipes" WHERE "authorId" = :'autor_sin_recetas'
ORDER BY "createdAt" DESC, "id" DESC LIMIT 20 OFFSET 0;

\echo '--- FK ON DELETE RESTRICT: chequeo al borrar un usuario sin recetas (forma del trigger RI)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT 1 FROM ONLY "recipes" x WHERE "authorId" = :'autor_sin_recetas' FOR KEY SHARE OF x;

\echo '--- Q5 count(*) sin filtros'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT count(*) FROM "recipes";

\echo '--- Q6 count(*) por authorId'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT count(*) FROM "recipes" WHERE "authorId" = :'autor_mayoritario';

-- Índices propuestos (decisión aprobada en el plan de #36), solo dentro de esta transacción.
CREATE INDEX "idx_recipes_createdat_id" ON "recipes" ("createdAt" DESC, "id" DESC);
CREATE INDEX "idx_recipes_authorid_createdat_id" ON "recipes" ("authorId", "createdAt" DESC, "id" DESC);
DROP INDEX "idx_recipes_authorid";
ANALYZE "recipes";

\echo
\echo '================ DESPUÉS: índices de #36 ================'
\echo '--- Q1 listado por defecto (page=1, limit=20)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT "id", "title", "createdAt" FROM "recipes"
ORDER BY "createdAt" DESC, "id" DESC LIMIT 20 OFFSET 0;

\echo '--- Q2 página profunda (page=100, limit=100 → OFFSET 9900, tope de la ventana)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT "id", "title", "createdAt" FROM "recipes"
ORDER BY "createdAt" DESC, "id" DESC LIMIT 100 OFFSET 9900;

\echo '--- Q3 filtro status=APPROVED (page=1, limit=20)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT "id", "title", "createdAt" FROM "recipes" WHERE "status" = 'APPROVED'
ORDER BY "createdAt" DESC, "id" DESC LIMIT 20 OFFSET 0;

\echo '--- Q4 filtro authorId (autor con ~10 % de las filas; caso /mine #18)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT "id", "title", "createdAt" FROM "recipes" WHERE "authorId" = :'autor_mayoritario'
ORDER BY "createdAt" DESC, "id" DESC LIMIT 20 OFFSET 0;

\echo '--- Q4b filtro authorId (autor con ~0,9 % de las filas)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT "id", "title", "createdAt" FROM "recipes" WHERE "authorId" = :'autor_minoritario'
ORDER BY "createdAt" DESC, "id" DESC LIMIT 20 OFFSET 0;

\echo '--- Q4c filtro authorId de un autor sin recetas (página vacía)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT "id", "title", "createdAt" FROM "recipes" WHERE "authorId" = :'autor_sin_recetas'
ORDER BY "createdAt" DESC, "id" DESC LIMIT 20 OFFSET 0;

\echo '--- FK ON DELETE RESTRICT: chequeo al borrar un usuario sin recetas (forma del trigger RI)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT 1 FROM ONLY "recipes" x WHERE "authorId" = :'autor_sin_recetas' FOR KEY SHARE OF x;

\echo '--- Q5 count(*) sin filtros'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT count(*) FROM "recipes";

\echo '--- Q6 count(*) por authorId'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT count(*) FROM "recipes" WHERE "authorId" = :'autor_mayoritario';

ROLLBACK;

-- Restaura las estadísticas del planner (ANALYZE no es transaccional respecto de pg_class).
ANALYZE "recipes";
