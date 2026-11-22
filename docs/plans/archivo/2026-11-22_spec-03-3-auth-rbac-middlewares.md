# Plan: [Spec 03.3] Guardas transversales authMiddleware (JWT HS256 fail-closed) y rbacMiddleware (401/403) (#15)

Fecha: 2026-11-22 · Rama: `feat/15-auth-rbac-middlewares` · Parent: `#3` · Estado: **Completado y archivado (2026-11-22)**

## Objetivo
Construir las guardas transversales `authMiddleware` y `rbacMiddleware` listas para proteger cualquier ruta de negocio bajo el orden estricto `authMiddleware -> rbacMiddleware -> validateMiddleware` (`ADR-0006`, `ADR-0004`, `ADR-0005`, `RN-04`, `RN-08`):
1. Verificación stateless endurecida de JWT en `src/modules/auth/jwt.ts` (`algorithms: ["HS256"]`, validación Zod 4 de `{ id: UUID, role: Role }`, *fail closed* con `401 Unauthorized` y objeto `Actor` congelado).
2. `src/middlewares/auth.middleware.ts` con extracción estricta `Authorization: Bearer <token>`, aumentación tipada de `Express.Request.user` sin `any` (`AuthenticatedRequest`), fábrica DI `createAuthMiddleware({ secret })` y exportación `authMiddleware` (*fail closed* `500` no operacional si falta configuración JWT).
3. `src/middlewares/rbac.middleware.ts` exigiendo `req.user` (`401` si faltara) y validando pertenencia de `req.user.role` a un `ReadonlySet<UserRole>` inmutable (`403 Forbidden` en caso contrario, prevención BFLA).

## Decisiones aprobadas
1. **Verificación JWT (`src/modules/auth/jwt.ts`, re-exportada en `src/modules/auth/index.ts`):**
   - Extraer `assertValidJwtSecret(secret: string)` (`>= 32` caracteres no blancos, `RangeError`) y reutilizarlo en `assertValidJwtConfig(config)`.
   - Definir `accessTokenPayloadSchema = z.object({ id: z.uuid(), role: z.enum(USER_ROLES) })` y `INVALID_TOKEN_MESSAGE = "Token inválido o expirado"`.
   - `verifyAccessToken(token, secret)` valida primero `assertValidJwtSecret(secret)` fuera del `try/catch` (errores de configuración del servidor fallan como `RangeError`), verifica con `jwt.verify(token, secret, { algorithms: [JWT_ALGORITHM] })`, valida con `accessTokenPayloadSchema.safeParse(decoded)`, devuelve `Object.freeze({ id, role })` y traduce cualquier fallo de token a `new UnauthorizedError(INVALID_TOKEN_MESSAGE)`.
2. **`src/middlewares/auth.middleware.ts`:**
   - Aumenta `Express.Request` con `user?: Actor` y exporta `AuthenticatedRequest = Request & { readonly user: Actor }`.
   - `extractBearerToken(header)` exige string con prefijo exacto `"Bearer "` (sensible a mayúsculas), token no vacío y sin espacios/caracteres de control (`/\s/`).
   - Limpia defensivamente `delete req.user` ante cualquier rechazo antes de invocar `next(err)`.
   - `createAuthMiddleware(options?: { secret?: string | undefined })`: valida `secret` en construcción con `assertValidJwtSecret` si se provee; si se omite, falla cerrado en cada request con `AppError(500, "Configuración JWT no inicializada", { isOperational: false })`.
   - `authMiddleware`: lee `process.env["JWT_SECRET"]`, valida con `assertValidJwtSecret` y falla cerrado (`500` no operacional) si falta o es inválido; en caso válido verifica el Bearer token 100 % stateless sin consultar la base de datos.
3. **`src/middlewares/rbac.middleware.ts`:**
   - `rbacMiddleware(allowedRoles: readonly UserRole[])`: valida *fail fast* en construcción (`RangeError` si `allowedRoles.length === 0` o contiene rol fuera de `USER_ROLES`) y guarda copia inmutable `ReadonlySet<UserRole>`.
   - En ejecución: si `req.user === undefined` → `next(new UnauthorizedError("Autenticación requerida"))` (`401`); si `!allowedRoleSet.has(req.user.role)` → `next(new ForbiddenError("No tienes permisos para realizar esta acción"))` (`403`); si cumple → `next()`.
4. **Fronteras limpias e higiene en pruebas:**
   - Sin ciclos de dependencias: `auth.middleware.ts` y `rbac.middleware.ts` importan únicamente desde `../modules/auth/index.js` y `../shared/errors/app-error.js`. No se modifican `src/app.ts`, `src/bootstrap/container.ts` ni `src/server.ts`.
   - En pruebas: secretos sintéticos dinámicos (`"test-jwt-secret-".repeat(3)`), contraseñas inocuas y par de claves RSA generado en memoria con `node:crypto` (`generateKeyPairSync`) para el caso `RS256`.

## Fases

### Fase 1 — Rama y registro del plan · Estado: Hecha
- [x] Crear la rama `feat/15-auth-rbac-middlewares` desde `main` (`4dd86b1`).
- [x] Registrar este plan en `docs/plans/2026-11-22_spec-03-3-auth-rbac-middlewares.md`.

Criterio de salida: rama creada y plan persistido. **Detenerse para revisión humana.**

---

### Fase 2 — Implementación de `verifyAccessToken`, `authMiddleware` y `rbacMiddleware` · Estado: Hecha
- [x] Extender `src/modules/auth/jwt.ts` y `src/modules/auth/index.ts` (`assertValidJwtSecret`, `accessTokenPayloadSchema`, `INVALID_TOKEN_MESSAGE`, `verifyAccessToken`).
- [x] Crear `src/middlewares/auth.middleware.ts` (`extractBearerToken`, `createAuthMiddleware`, `authMiddleware`, `AuthenticatedRequest` y aumentación `Express.Request.user`).
- [x] Crear `src/middlewares/rbac.middleware.ts` (`rbacMiddleware`).
- [x] Verificar `npm run typecheck && npm run typecheck:test && npm run build && npm test`, `CLEAN_DIST` y `0 any`.

Criterio de salida: compilación estricta y las 335 pruebas existentes en verde sin regresiones. **Detenerse para revisión humana.**

---

### Fase 3 — Pruebas unitarias, de integración HTTP y de abuso (Supertest + PostgreSQL 15) · Estado: Hecha
- [x] Ampliar `src/modules/auth/jwt.test.ts` (4 roles, congelamiento/stripping, `401` ante firma inválida, payload manipulado, expirado, `nbf` futuro, `alg: "none"`, `HS384`/`HS512`, `RS256` con RSA efímera, payloads inválidos y `RangeError` ante secreto inválido).
- [x] Crear `src/middlewares/auth.middleware.test.ts` (`createAuthMiddleware`, `authMiddleware`, prefijo estricto `Bearer `, limpieza defensiva de `req.user`, `500` fail-closed sin secreto).
- [x] Crear `src/middlewares/rbac.middleware.test.ts` (`RangeError` en `[]`/rol inválido, copia inmutable, `401` sin `req.user`, `403` por rol no autorizado incluyendo matriz `RN-04`, `next()` autorizado).
- [x] Crear `tests/integration/http/auth-guards.test.ts` (Supertest + `buildApp` + PostgreSQL 15): login real + rutas protegidas (`200` en 4 roles sin fuga en logs), precedencia `auth -> rbac -> validate` (`401`/`403` sobre body inválido, `400` solo tras superar auth+rbac), batería de abuso JWT (`401`), comportamiento 100 % stateless (`isActive = false` tras login), defensa en profundidad (`rbac` sin `auth` → `401`) y fail-closed `500` sin `secret`.
- [x] Verificar `npm run typecheck && npm run typecheck:test && npm run build && npm test` bajo `sequence.shuffle: true` y `CLEAN_STATIC`.

Criterio de salida: suite completa en verde. **Detenerse para revisión humana.**

---

### Fase 4 — Documentación, auditorías obligatorias y cierre · Estado: Hecha
- [x] Actualizar `CHANGELOG.md` (`## [Sin publicar]`) y archivar este plan en `docs/plans/archivo/2026-11-22_spec-03-3-auth-rbac-middlewares.md`.
- [x] Ejecutar en paralelo las revisiones obligatorias de `GEMINI.md`: `@code-reviewer`, `@security-auditor` y `@qa-tester`.
- [x] Resolver eventuales hallazgos y ejecutar verificación final (`npm run typecheck && npm run typecheck:test && npm run build && npm test` y `git status --short`).

Criterio de salida: auditorías aprobadas y suite completa en verde, listo para `commit` y PR cuando el usuario lo indique.

---

## Regla de parada
Ejecutar **una fase por vez** y detenerse al finalizar cada fase para revisión humana antes de continuar con la siguiente.
