# 2. Usar PostgreSQL 15 y Prisma ORM para la persistencia

Fecha: 2026-11-06
Estado: Aceptada *(actualizada parcialmente por [ADR-0005](0005-alcance-mvp-ciclo-recetas-y-auditoria.md) —retiro de `sessions`— y [ADR-0006](0006-estandarizacion-esm-prisma7-y-contratos-api.md) —alineación a Prisma 7 GA + `@prisma/adapter-pg`)*

## Contexto
El dominio de Recetaria combina entidades fuertemente relacionadas (`users`, `recipes`, `sessions`, `audit_logs`) que requieren transacciones ACID al aprobar recetas (RN-06), junto con estructuras semiestructuradas para listas de ingredientes y valores nutricionales.

## Opciones consideradas
1. PostgreSQL 15 + Prisma ORM
2. MySQL 8 + Sequelize / TypeORM
3. MongoDB + Mongoose

## Decisión
Usamos PostgreSQL 15 como único motor de base de datos y Prisma ORM como capa de acceso tipado.

## Motivos
- PostgreSQL garantiza integridad referencial (`RESTRICT`, `SET NULL`), restricciones `CHECK`, triggers nativos (`updatedAt`) y transacciones ACID completas.
- El tipo nativo `JSONB` y los arreglos (`VARCHAR[]`) permiten almacenar ingredientes y macros nutricionales sin perder la solidez relacional.
- Prisma ORM genera tipos TypeScript directamente desde el esquema y simplifica transacciones compuestas con `$transaction`.

## Consecuencias
- (+) Un único motor para datos relacionales estrictos, auditoría y metadatos JSONB
- (+) Seguridad de tipos end-to-end entre base de datos y capa `Repository`
- (−) Requiere disciplina en migraciones (`prisma migrate`) y validación previa de políticas `ON DELETE`
