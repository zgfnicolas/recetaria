---
name: db-migration
description: >-
  Valida y sincroniza cambios del esquema de Prisma con PostgreSQL. Usar solo cuando
  el usuario pida explícitamente validar, generar o migrar el esquema de base de datos.
---

# Gestión y Migración de Base de Datos

> [!CAUTION]
> No ejecutes `npx prisma migrate` ni `npx prisma db push` por iniciativa propia.
> Pedí confirmación explícita del usuario antes de aplicar cualquier cambio de esquema.

## Pasos seguros (solo lectura / validación)
1. Revisá que ninguna tabla de negocio use `ON DELETE CASCADE` (ver `docs/data_model.md`).
2. Validá la sintaxis del esquema: `npx prisma validate`.
3. Mostrá al usuario el plan de migración y esperá su confirmación.

## Pasos tras confirmación explícita
1. Generá el cliente tipado: `npx prisma generate`.
2. Creá y aplicá la migración con nombre descriptivo: `npx prisma migrate dev --name <descripcion_corta>`.
3. Actualizá `docs/data_model.md` y los esquemas Zod afectados en `src/modules/`.
4. Corré `npm run build` para confirmar que no haya errores de tipos.

## Skills relacionadas
- Modelado ER, normalización 3NF, constraints y reglas de SQL relacional: [sql-relational-design](../sql-relational-design/SKILL.md).
- Análisis de locks DDL, `lock_timeout`, `NOT VALID`, `CONCURRENTLY` y migraciones zero-downtime en PostgreSQL: [postgresql-engineering](../postgresql-engineering/SKILL.md).
- Configuración de Prisma 7 (`prisma.config.ts`), `migrate dev --create-only`, `migrate deploy` en job y drift check en CI: [orm-persistence-js-ts](../orm-persistence-js-ts/SKILL.md).
