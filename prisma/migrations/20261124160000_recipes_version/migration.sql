-- #46: versión de contenido de la Receta para bloqueo optimista (ETag/If-Match) en la Aprobación.
-- Se descarta "updatedAt": su trigger asigna NOW() (inicio de la transacción, no el commit), por lo
-- que no es monotónico entre transacciones concurrentes y se repite dentro de una misma transacción.
-- ADD COLUMN con DEFAULT constante no reescribe la tabla en PostgreSQL 15 (filas existentes → 1).

-- AlterTable
ALTER TABLE "recipes" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "recipes"
    ADD CONSTRAINT "chk_recipes_version_positive" CHECK ("version" >= 1);

-- Incremento en TODA escritura (edición, aprobación, reinicio a borrador y futuras), ignorando
-- cualquier valor enviado por el cliente: cualquier cambio invalida una revisión previa.
CREATE OR REPLACE FUNCTION increment_recipe_version()
RETURNS TRIGGER AS $$
BEGIN
    NEW."version" = OLD."version" + 1;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_recipes_version
BEFORE UPDATE ON "recipes"
FOR EACH ROW EXECUTE FUNCTION increment_recipe_version();
