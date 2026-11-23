-- #36: índices para el orden determinístico del catálogo ("createdAt" DESC, id DESC).
-- Medición previa (100k filas): elimina el Sort de tabla completa en GET /api/v1/recipes
-- (≈100 ms → ≈0,1 ms; página más profunda ≈150 ms → ≈4 ms). Ver scripts/perf/explain-recipes-list.sql.
-- Se crean los índices nuevos ANTES de retirar idx_recipes_authorid para que la FK
-- fk_recipes_author (ON DELETE RESTRICT) nunca quede sin índice de respaldo.
-- Producción con datos: preferir CREATE INDEX CONCURRENTLY en una migración sin transacción.

-- CreateIndex
CREATE INDEX "idx_recipes_createdat_id" ON "recipes"("createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "idx_recipes_authorid_createdat_id" ON "recipes"("authorId", "createdAt" DESC, "id" DESC);

-- DropIndex (redundante: idx_recipes_authorid_createdat_id lo cubre como prefijo izquierdo)
DROP INDEX "idx_recipes_authorid";
