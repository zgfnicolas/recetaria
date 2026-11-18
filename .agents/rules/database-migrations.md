---
trigger: model_decision
description: "Aplicar al crear o revisar esquemas de Prisma, migraciones SQL o cambios en el modelo de datos."
---

# Reglas de Base de Datos y Migraciones

- Nunca ejecutar `npx prisma migrate` ni `npx prisma db push` sin confirmación explícita del usuario.
- Nunca usar `ON DELETE CASCADE` en entidades de negocio (`recipes`, `audit_logs`): usar `RESTRICT` o `SET NULL` según `docs/data_model.md`. `CASCADE` solo se admite en `sessions`.
- Toda columna nueva en una tabla con registros debe definir un valor por defecto o ser nullable.
- Las transiciones de estado con auditoría (`approve`) deben ejecutarse dentro de `prisma.$transaction`.
- Al modificar tablas, índices o relaciones, actualizar en paralelo `docs/data_model.md` y los esquemas Zod afectados.
