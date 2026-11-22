# Plan: [Spec 03.1] Registro de Usuarios (POST /api/v1/auth/register) en 4 capas con Bcrypt y prevención BOPLA (#13)

Fecha: 2026-11-22 · Rama: `feat/13-auth-register-4-layers` · Parent: `#3` · Estado: **Completado y archivado (2026-11-22)**

## Objetivo
Habilitar el registro público de `Usuarios` mediante `POST /api/v1/auth/register` implementando la base del módulo `Auth` en 4 capas estrictas (`Router -> Controller -> Service -> UserRepository`) montada en `/api/v1/auth`:
1. Validación estricta de borde con Zod 4 (`z.strictObject`, prevención BOPLA), normalización de `email`, validación de longitud/bytes de contraseña para Bcrypt y soporte opcional de `role` (`"USER"` por defecto en el MVP según `docs/roles.md`).
2. Persistencia segura en PostgreSQL (`RN-08`) con Bcrypt (`>= 10` rounds), proyección explícita sin `passwordHash` y manejo de colisión de unicidad (`409 Conflict`) ante registros duplicados o concurrentes (`P2002`).
3. Composition root explícito (`src/bootstrap/container.ts`) integrado retrocompatiblemente con `buildApp({ prisma })` en `src/app.ts`.

## Decisiones aprobadas
1. **Esquema Zod 4 estricto (`src/modules/auth/auth.schema.ts`):**
   - `z.strictObject` rechaza propiedades extra o protegidas (`isActive`, `id`, `passwordHash`, etc.) devolviendo `400 Bad Request` con detalle por campo vía `validateMiddleware`.
   - `email`: cadena normalizada con `.trim().toLowerCase().max(255)` antes de `.pipe(z.email(...))` para aceptar espacios laterales y respetar `@db.VarChar(255)`.
   - `password`: mínimo `8` caracteres y máximo `72` bytes UTF-8 (`Buffer.byteLength <= 72`) sin `.trim()` ni reglas arbitrarias de composición.
   - `firstName` / `lastName`: `.trim().min(2).max(100)`.
   - `role`: enum `["USER", "CHEF", "NUTRITIONIST", "ADMIN"]` opcional con default `"USER"`.
2. **Arquitectura en 4 capas (`ADR-0003`) y seguridad (`RN-08`):**
   - **`user.repository.ts`:** único archivo del módulo que importa `AppPrismaClient`; expone `UserRecord`, `CreateUserInput` e `IUserRepository`, usa `select` explícito sin `passwordHash`, construye `data` por *allowlist* y traduce Prisma `P2002` a `ConflictError`.
   - **`auth.service.ts`:** depende solo de `IUserRepository` (sin imports de Prisma ni Express), valida existencia previa (`ConflictError` `409`), cifra la contraseña con `bcrypt.hash(password, 10)` (`BCRYPT_SALT_ROUNDS = 10`, mínimo `>= 10`) y devuelve `{ id, email, role }`.
   - **`auth.controller.ts`:** lee `req.valid.body`, envuelve en `try/catch` delegando errores a `next(err)` y responde `201 Created` vía `sendSuccess`.
   - **`auth.router.ts` + `index.ts`:** ruta pública `POST /register` con `validateMiddleware({ body: registerSchema })` y exportación exclusiva de la API pública en `src/modules/auth/index.ts`.
3. **Composition root (`src/bootstrap/container.ts`) y `src/app.ts`:**
   - `buildApiRouters(prisma)` e `isAppPrismaClient(prisma)` en `src/bootstrap/container.ts`.
   - En `src/app.ts`, `BuildAppOptions.prisma` acepta `AppPrismaClient | ReadinessDatabaseClient | undefined`: cuando recibe un `AppPrismaClient` real y no se sobreescribe `apiRouters`, monta `/api/v1/auth` automáticamente conservando compatibilidad con `buildApp()` y con los stubs de salud/servidor.

## Fases

### Fase 1 — Rama y registro del plan · Estado: Hecha
- [x] Crear la rama `feat/13-auth-register-4-layers` desde `main` actualizado (`da62a78`).
- [x] Registrar este plan en `docs/plans/2026-11-22_spec-03-1-auth-register.md`.

Criterio de salida: rama creada y plan persistido. **Detenerse para revisión humana.**

---

### Fase 2 — Implementación del módulo `Auth` en 4 capas y wiring en `buildApp` · Estado: Hecha
- [x] Crear `src/modules/auth/auth.schema.ts`, `src/modules/auth/user.repository.ts`, `src/modules/auth/auth.service.ts`, `src/modules/auth/auth.controller.ts`, `src/modules/auth/auth.router.ts` y `src/modules/auth/index.ts`.
- [x] Crear `src/bootstrap/container.ts` y actualizar `src/app.ts` de forma retrocompatible.
- [x] Verificar `npm run typecheck && npm run typecheck:test && npm run build`, `CLEAN_DIST` y `0 any`.

Criterio de salida: 0 errores de tipos/build y artefactos limpios sin `.test.*`. **Detenerse para revisión humana.**

---

### Fase 3 — Pruebas unitarias y de integración HTTP contra PostgreSQL 15 · Estado: Hecha
- [x] Crear `src/modules/auth/auth.schema.test.ts` (normalización de `email`, longitudes, límite `72` bytes UTF-8, roles y rechazo BOPLA).
- [x] Crear `src/modules/auth/auth.service.test.ts` (mockeando solo `IUserRepository`: Bcrypt `>= 10` rounds, `RN-08`, `409` por duplicado previo o carrera concurrente, proyección sin `passwordHash`).
- [x] Crear `src/modules/auth/auth.controller.test.ts` (`req.valid.body`, respuesta `201` JSend, fallo cerrado ante ausencia de `req.valid` y delegación a `next`).
- [x] Crear `tests/integration/http/auth-register.test.ts` (Supertest sobre `buildApp({ prisma })` + PostgreSQL 15 en Docker con limpieza entre tests): `201`, `400` (Zod + BOPLA) y `409` (duplicado, mayúsculas/espacios y carrera concurrente `P2002`), sin fuga de contraseñas.
- [x] Verificar con `npm run typecheck && npm run typecheck:test && npm run build && npm test` bajo `sequence.shuffle: true` y chequeos estáticos (`0 any`, `0 .only`/`.skip`).

Criterio de salida: suite completa en verde. **Detenerse para revisión humana.**

---

### Fase 4 — Documentación, auditorías obligatorias y cierre · Estado: Hecha
- [x] Actualizar `CHANGELOG.md` (`## [Sin publicar]`) y archivar este plan en `docs/plans/archivo/2026-11-22_spec-03-1-auth-register.md`.
- [x] Ejecutar en paralelo las revisiones obligatorias de `GEMINI.md`: `@code-reviewer`, `@security-auditor` y `@qa-tester`, resolver los hallazgos de QA en los 4 archivos de pruebas (ampliando a 52 pruebas nuevas) y obtener `APROBADO` en todas las auditorías.
- [x] Ejecutar verificación final (`npm run typecheck && npm run typecheck:test && npm run build && npm test` — 18 archivos / 278 pruebas — y `git status --short`).

Criterio de salida: auditorías aprobadas y suite completa en verde, listo para `commit` y PR cuando el usuario lo indique.

---

## Regla de parada
Ejecutar **una fase por vez** y detenerse al finalizar cada fase para revisión humana antes de continuar con la siguiente.
