# Plan: [Spec 01.2] Migración SQL inicial reproducible y verificación de integridad relacional (#8)

Fecha: 2026-11-21 · Rama: `feat/8-migracion-sql-inicial-integridad` · Parent: `#1` · Estado: **Completado y archivado (2026-11-21)**

## Objetivo
Entregar la migración SQL inicial versionada de Prisma 7 capaz de construir desde cero una base de datos PostgreSQL 15 fiel al diseño relacional aprobado (`pgcrypto`, restricciones `CHECK`, función y triggers automáticos de `updatedAt`, y `COMMENT ON COLUMN`), verificar cero drift contra `prisma/schema.prisma` y demostrar en pruebas reales contra PostgreSQL 15 el cumplimiento de restricciones, triggers y políticas referenciales (`RESTRICT`, `SET NULL`, `RN-06`).

## Decisiones aprobadas
1. **Entorno Docker limpio gestionado por Prisma:** retirar el montaje de `./database_schema_init.sql:/docker-entrypoint-initdb.d/01-init.sql:ro` en `compose.override.yaml` para que `npm run docker:db` levante PostgreSQL 15 vacío y `prisma migrate deploy` cree el esquema y `_prisma_migrations` sin conflicto (`P3005`). Conservar `database_schema_init.sql` como referencia histórica en el repositorio y actualizar `docs/data_model.md`.
2. **Constraints `CHECK` en `migration.sql` — Opción B (defensa en profundidad sin drift):**
   - `chk_prep_time_positive`: `CHECK ("prepTimeMinutes" > 0 AND "prepTimeMinutes" <= 1440)` (`RN-07`).
   - `chk_recipes_reviewer_not_author`: `CHECK ("reviewedById" IS NULL OR "reviewedById" <> "authorId")` (`RN-05`).
   - `chk_recipes_ingredients_array`: `CHECK (jsonb_typeof("ingredients") = 'array')`.
   - `chk_recipes_nutritional_info_object`: `CHECK ("nutritionalInfo" IS NULL OR jsonb_typeof("nutritionalInfo") = 'object')` *(nota de implementación en Prisma: usar `Prisma.DbNull` cuando se limpia la columna a SQL `NULL`; `Prisma.JsonNull` escribe JSON `'null'`, que el `CHECK` rechaza correctamente).*
   - **Excluidos a propósito:** índice funcional `LOWER(email)` (generaría drift en `prisma migrate diff`) y roles separados / `REVOKE` en `audit_logs` (diferidos a Fase Beta/Producción según `ADR-0006` y fuera de alcance de `#1`).
3. **Confirmación humana obligatoria:** por `.agents/rules/database-migrations.md` y `.agents/hooks.json`, ningún comando `prisma migrate` ni edición dentro de `prisma/migrations/` se ejecuta sin confirmación explícita del usuario.

## Fases

### Fase 1 — Rama, plan y Docker limpio · Estado: Hecha
- [x] Sincronizar `main` con `origin/main` y crear rama `feat/8-migracion-sql-inicial-integridad`.
- [x] Registrar este plan en `docs/plans/2026-11-21_spec-01-2-migracion-sql-inicial.md`.
- [x] Retirar montaje de `database_schema_init.sql` en `compose.override.yaml` (conservando volumen `postgres_data` de `compose.yaml`) y validar con `npm run docker:config`.

Criterio de salida: rama limpia desde `main`, plan registrado y `docker compose config` validado sin `01-init.sql`. **Detenerse para revisión humana.**

---

### Fase 2 — Generación y auditoría de la migración SQL inicial (`--create-only`) · Estado: Hecha
- [x] Confirmar esquema válido: `npm run db:validate`.
- [x] Con confirmación explícita del usuario, generar el borrador de migración sin aplicarlo:
  ```bash
  npx prisma migrate dev --create-only --name init
  ```
- [x] Completar `prisma/migrations/<timestamp>_init/migration.sql` con las garantías de PostgreSQL 15 no expresables en Prisma:
  1. Extensión al inicio:
     ```sql
     CREATE EXTENSION IF NOT EXISTS "pgcrypto";
     ```
  2. Constraints `CHECK` en `"recipes"` (Opción B):
     ```sql
     ALTER TABLE "recipes"
       ADD CONSTRAINT "chk_prep_time_positive"
       CHECK ("prepTimeMinutes" > 0 AND "prepTimeMinutes" <= 1440);

     ALTER TABLE "recipes"
       ADD CONSTRAINT "chk_recipes_reviewer_not_author"
       CHECK ("reviewedById" IS NULL OR "reviewedById" <> "authorId");

     ALTER TABLE "recipes"
       ADD CONSTRAINT "chk_recipes_ingredients_array"
       CHECK (jsonb_typeof("ingredients") = 'array');

     ALTER TABLE "recipes"
       ADD CONSTRAINT "chk_recipes_nutritional_info_object"
       CHECK ("nutritionalInfo" IS NULL OR jsonb_typeof("nutritionalInfo") = 'object');
     ```
  3. Función y triggers `BEFORE UPDATE` de `"updatedAt"` sobre `"users"` y `"recipes"`:
     ```sql
     CREATE OR REPLACE FUNCTION update_updated_at_column()
     RETURNS TRIGGER AS $$
     BEGIN
         NEW."updatedAt" = NOW();
         RETURN NEW;
     END;
     $$ LANGUAGE plpgsql;

     CREATE TRIGGER trg_users_updated_at
     BEFORE UPDATE ON "users"
     FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

     CREATE TRIGGER trg_recipes_updated_at
     BEFORE UPDATE ON "recipes"
     FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
     ```
  4. Documentación en catálogo PostgreSQL (`RN-06`):
     ```sql
     COMMENT ON COLUMN "audit_logs"."entityId" IS
       'ID de la entidad afectada; sin FK hacia recipes por diseño (RN-06) para conservar trazabilidad tras DELETE físico.';
     ```
- [x] Auditar `migration.sql` y `migration_lock.toml`:
  - Cero apariciones de `ON DELETE CASCADE` ni `ON UPDATE CASCADE`.
  - FKs explícitas: `fk_recipes_author` (`ON DELETE RESTRICT`), `fk_recipes_reviewer` (`ON DELETE SET NULL`), `fk_audit_logs_user` (`ON DELETE SET NULL`), todas con `ON UPDATE NO ACTION`.
  - Cero índices duplicados sobre `users.email` ni `recipes.slug` (solo restricción `UNIQUE`), más los índices B-Tree declarados en `prisma/schema.prisma`.

Criterio de salida: `migration.sql` y `migration_lock.toml` auditados y aprobados. **Detenerse para revisión humana.**

---

### Fase 3 — Despliegue limpio sobre PostgreSQL 15 y verificación de cero drift · Estado: Hecha
- [x] Con confirmación explícita del usuario, recrear el volumen vacío y aplicar la migración:
  ```bash
  docker compose down -v
  npm run docker:db
  npx prisma migrate deploy
  npx prisma migrate status
  ```
- [x] Verificar cero drift entre la base migrada y `prisma/schema.prisma` (confirmando flag exacto en Prisma 7.10.1 con `npx prisma migrate diff --help`):
  ```bash
  npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
  ```

Criterio de salida: `migrate deploy` sin errores sobre DB vacía, `migrate status` al día y `migrate diff --exit-code` retornando `0`. **Detenerse para revisión humana.**

---

### Fase 4 — Suite de integración relacional en Vitest contra PostgreSQL 15 · Estado: Hecha
- [x] Agregar `fileParallelism: false` en `vitest.config.ts` para aislar el `TRUNCATE` entre suites sobre PostgreSQL compartido.
- [x] Crear `tests/integration/database/relational-integrity.test.ts` (patrón AAA, `beforeEach`/`afterEach` con `TRUNCATE TABLE audit_logs, recipes, users RESTART IDENTITY;` sin `CASCADE`, `afterAll` con `disconnect()`):
  1. **Catálogo de motor:** verificar extensión `pgcrypto` en `pg_extension` y `COMMENT ON COLUMN audit_logs."entityId"` vía `col_description(...)` mencionando `RN-06`.
  2. **Unicidad (`P2002`):** email duplicado en `users` y slug duplicado en `recipes` devuelven `Prisma.PrismaClientKnownRequestError` con `code === "P2002"`.
  3. **Restricciones `CHECK` (SQLSTATE `23514`):**
     - `prepTimeMinutes` inválido (`0`, `-5`, `1441`) falla con `23514` y `chk_prep_time_positive` sin insertar fila; límites válidos `1` y `1440` insertan correctamente.
     - `reviewedById === authorId` (`RN-05`) falla con `23514` y `chk_recipes_reviewer_not_author`.
     - `ingredients` no-array (p. ej. `{}`) y `nutritionalInfo` no-object (p. ej. `[]` o `Prisma.JsonNull`) fallan con `23514`; omitir o pasar `Prisma.DbNull` funciona correctamente.
  4. **Triggers automáticos `updatedAt` (control real del motor, sin `@updatedAt` ni `sleep()`):** insertar `User` y `Recipe` con `"updatedAt"` inicial en `2020-01-01T00:00:00.000Z`; ejecutar `UPDATE` vía `$executeRaw` sobre `firstName` / `title` sin mencionar `"updatedAt"` y comprobar que se actualiza por encima de `2020-01-01`.
  5. **Políticas referenciales y auditoría (`ADR-0002`, `RN-03`, `RN-06`):**
     - `ON DELETE RESTRICT` (`fk_recipes_author`): impide borrar `User` autor con `Recipe` asociada; ambos permanecen.
     - `ON DELETE SET NULL` (`fk_recipes_reviewer`): borrar revisor conserva `Recipe` con `reviewedById === null`.
     - `ON DELETE SET NULL` (`fk_audit_logs_user`): borrar actor conserva `AuditLog` con `userId === null`.
     - Supervivencia tras borrado físico (`RN-06`): eliminar `Recipe` conserva su `AuditLog` (`entityName = "Recipe"`, `entityId = recipe.id`, snapshots `oldValues`/`newValues`).
- [x] Verificar con `npm run typecheck`, `npm run typecheck:test`, `npm run build` y `npm test`.

Criterio de salida: 0 errores de tipos/build y todas las suites verdes (con `sequence.shuffle: true`). **Detenerse para revisión humana.**

---

### Fase 5 — Documentación, revisiones y cierre · Estado: Hecha
- [x] Actualizar `docs/data_model.md` (Prisma + migraciones como fuente DDL operativa, `database_schema_init.sql` como referencia inicial, quitar nota obsoleta "Fase 2" y documentar los 4 `CHECK`), `prisma/schema.prisma` (comentario final) y `CHANGELOG.md` (`Sin publicar`).
- [x] Archivar este plan en `docs/plans/archivo/` al completar las fases.
- [x] Ejecutar revisiones obligatorias de `GEMINI.md`: `@code-reviewer`, `@security-auditor` y `@qa-tester`.
- [x] Verificación final (`git status --short`, `npm run typecheck`, `npm run typecheck:test`, `npm run build`, `npm test`, `npm run docker:config`).

---

## Regla de parada
Ejecutar **una fase por vez** y detenerse al finalizar cada fase para revisión humana antes de continuar con la siguiente.
