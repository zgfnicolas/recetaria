# Plan: ajustes al esquema Prisma antes de la primera migración

Rama: `feat/7-esquema-prisma-adaptador-pg` · Estado: **Fase 1 verificada y archivada (2026-11-21)**

## Fase 1 — Cambios en `prisma/schema.prisma`
1. Nombrar las claves foráneas para que coincidan con `database_schema_init.sql`:
   - `Recipe.author` → `map: "fk_recipes_author"`
   - `Recipe.reviewedBy` → `map: "fk_recipes_reviewer"`
   - `AuditLog.user` → `map: "fk_audit_logs_user"`
2. Agregar `@@index([userId], map: "idx_audit_logs_userid")` en `AuditLog` (la FK con `SET NULL` evita escaneos al borrar usuarios o filtrar por actor).
3. Reemplazar comentarios que citan "el ticket" y "la Spec 01.2" por referencias permanentes (ADR-0002, ADR-0006, RN-06, `docs/data_model.md`).
4. Actualizar `docs/data_model.md` en paralelo (índice nuevo y nombres de FK), según `.agents/rules/database-migrations.md`.
5. Ajustar `prisma.config.ts` para resolver `MIGRATION_DATABASE_URL?.trim() || DATABASE_URL?.trim()` y omitir `datasource` cuando no hay URL definida (permite comandos offline sin variables de entorno y cumple `exactOptionalPropertyTypes`).

## Verificación
```bash
npm run db:format && npm run db:validate && npm run db:generate
```

## Fuera de alcance (Spec 01.2, migración SQL con `--create-only`)
- `CHECK` de `prepTimeMinutes`, `reviewedById <> authorId` (RN-05), `jsonb_typeof` de `ingredients` y `nutritionalInfo`.
- `audit_logs` solo inserción (`REVOKE UPDATE, DELETE` al rol de la app o trigger).
- Índice único sobre `LOWER(email)` y normalización en Zod.
- Triggers y `COMMENT`.

## Detenerse
Ejecutar solo la Fase 1 y detenerse para revisión humana. No correr `prisma migrate` sin confirmación explícita.
