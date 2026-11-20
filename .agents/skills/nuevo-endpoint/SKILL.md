---
name: nuevo-endpoint
description: >-
  Pasos para crear o extender un endpoint REST en Recetaria API respetando la
  arquitectura en 4 capas, Zod, RBAC y JSend. Usar cuando haya que agregar una ruta
  o módulo nuevo en src/modules/.
---

# Crear un endpoint en Recetaria API

1. Definí el esquema Zod 4 estricto (`z.strictObject`) y su DTO inferido (`z.infer<typeof schema>`) en `src/modules/<recurso>/<recurso>.schema.ts`.
2. Implementá la consulta tipada en `src/modules/<recurso>/<recurso>.repository.ts` (único lugar que llama a Prisma Client).
3. Implementá las reglas de negocio (`docs/business_rules.md`) en `src/modules/<recurso>/<recurso>.service.ts`, usando `prisma.$transaction` cuando afecte varias tablas (ej. `audit_logs` con `entityName = "Recipe"`).
4. Exponé el método HTTP en `src/modules/<recurso>/<recurso>.controller.ts` envuelto en `try/catch` devolviendo el sobre JSend extendido.
5. Registrá la ruta en `src/modules/<recurso>/<recurso>.router.ts` aplicando el orden **`authMiddleware` → `rbacMiddleware` → `validateMiddleware`** en rutas protegidas (y solo `validateMiddleware` en rutas públicas) según `docs/roles.md`.
6. Agregá tests unitarios del servicio (mockeando solo el repositorio) y test de integración Supertest cubriendo `200/201`, `400`, `401`, `403` y `404`.
7. Verificá los contratos base de Auth y Recipes en [contratos-modulos.md](./references/contratos-modulos.md) antes de editar.
8. Corré `npm run build` y `npm test` para validar tipos y pruebas.
