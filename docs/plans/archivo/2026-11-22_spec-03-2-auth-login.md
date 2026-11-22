# Plan: [Spec 03.2] Inicio de sesión stateless (POST /api/v1/auth/login), defensa anti-enumeración y emisión JWT HS256 (#14)

Fecha: 2026-11-22 · Rama: `feat/14-auth-login-jwt-hs256` · Parent: `#3` · Estado: **Completado y archivado (2026-11-22)**

## Objetivo
Habilitar el inicio de sesión stateless mediante `POST /api/v1/auth/login` completando el flujo de autenticación del módulo `Auth` en 4 capas (`Router -> Controller -> Service -> UserRepository`) conforme a `HU-02`, `RN-08`, `ADR-0004` y `ADR-0005`:
1. Validación estricta de entrada con Zod 4 (`z.strictObject`, prevención BOPLA), normalización de `email` y exigencia de contraseña no vacía sin recorte de espacios.
2. Verificación de credenciales con defensa anti-enumeración (`bcrypt.compare` contra un hash Bcrypt ficticio precomputado cuando no existe el email, rechazo uniforme `401 Unauthorized` para email inexistente, contraseña incorrecta o `isActive === false`, y defensa ante truncado de 72 bytes en Bcrypt).
3. Emisión JWT 100 % stateless (`algorithm: "HS256"`, payload mínimo `{ id, role }`, expiración acotada `JWT_EXPIRES_IN`, secreto validado `JWT_SECRET` inyectado fail-closed desde `loadEnv()`), con respuesta `200 OK` en sobre JSend extendido `{ token, user: { id, email, role } }` y `Cache-Control: no-store`.

## Decisiones aprobadas
1. **Esquema `loginSchema` (`src/modules/auth/auth.schema.ts`):**
   - `z.strictObject` rechaza propiedades extra (BOPLA).
   - `email`: `.trim().toLowerCase().max(255)` antes de `.pipe(z.email(...))` (consistente con `registerSchema`).
   - `password`: `z.string({ error: "La contraseña es obligatoria" }).min(1, { error: "La contraseña es obligatoria" })` sin `.trim()`.
2. **Defensa anti-enumeración y anti-truncado Bcrypt (`RN-08` en `src/modules/auth/auth.service.ts`):**
   - Hash ficticio precomputado válido de 60 caracteres (`DUMMY_BCRYPT_HASH`, costo 10; si se configura `saltRounds > 10` en el constructor se computa un hash ficticio del mismo costo para homogeneizar latencias).
   - Siempre se ejecuta `bcrypt.compare(...)` tanto si el email no existe (`user === null` → contra `DUMMY_BCRYPT_HASH`) como si `user.isActive === false` antes de fallar.
   - Si `Buffer.byteLength(dto.password, "utf8") > 72`, se compara una cadena acotada ficticia y se rechaza con el mismo `401` (previene el bypass por truncado silencioso de Bcrypt cuando una clave de 72 bytes recibe octetos extra y acota el trabajo de CPU).
   - Los tres casos negativos (email inexistente, contraseña incorrecta, `isActive === false`) emiten exactamente el mismo `new UnauthorizedError("Credenciales inválidas")` (`401` JSend con `errors: []`).
3. **Separación de consultas en `src/modules/auth/user.repository.ts`:**
   - Se mantiene `USER_PUBLIC_SELECT` (sin `passwordHash`) para `findByEmail`, `findById` y `create`.
   - Se agrega `findAuthByEmail(email): Promise<UserAuthRecord | null>` con `USER_AUTH_SELECT` (`id`, `email`, `role`, `isActive`, `passwordHash`) usado exclusivamente por `AuthService.login()`.
4. **Helper JWT endurecido (`src/modules/auth/jwt.ts`) y wiring fail-closed:**
   - `signAccessToken(actor, config)` firma exclusivamente con `algorithm: "HS256"`, payload mínimo explícito `{ id, role }`, `expiresIn: JwtExpiresIn` y validación del secreto (`>= 32` chars no blancos). `verifyAccessToken` se diferirá a Spec 03.3 (`#15`) junto a `authMiddleware` (YAGNI).
   - Inyección explícita `jwt?: JwtConfig` vía `src/server.ts` (`loadEnv()`) → `BuildAppOptions.jwt` (`src/app.ts`) → `buildApiRouters(prisma, { jwt })` (`src/bootstrap/container.ts`) → `AuthService(repo, { jwt })`. Si se invoca `login()` sin `jwt` configurado, `AuthService` falla cerrado (`500` no operacional) sin secretos por defecto ni lecturas dispersas de `process.env`.
   - `AuthController.login` establece `Cache-Control: no-store` y emite `200 OK` JSend (`"Inicio de sesión exitoso"`, `{ token, user }`).
5. **Higiene en pruebas:** usar contraseñas sintéticas inocuas y secretos construidos dinámicamente para evitar falsos positivos en escáneres automáticos.

## Fases

### Fase 1 — Rama y registro del plan · Estado: Hecha
- [x] Crear la rama `feat/14-auth-login-jwt-hs256` desde `main` actualizado (`2fc714c`).
- [x] Registrar este plan en `docs/plans/2026-11-22_spec-03-2-auth-login.md`.

Criterio de salida: rama creada y plan persistido. **Detenerse para revisión humana.**

---

### Fase 2 — Implementación de `login` en 4 capas, helper JWT HS256 y wiring · Estado: Hecha
- [x] Crear `src/modules/auth/jwt.ts` (`JWT_ALGORITHM`, `Actor`, `JwtConfig`, `signAccessToken`).
- [x] Extender `auth.schema.ts`, `user.repository.ts`, `auth.service.ts`, `auth.controller.ts`, `auth.router.ts` e `index.ts`.
- [x] Actualizar `src/bootstrap/container.ts`, `src/app.ts` y `src/server.ts` para propagar `jwt` desde `loadEnv()`.
- [x] Verificar `npm run typecheck && npm run typecheck:test && npm run build && npm test`, `CLEAN_DIST` y `0 any`.

Criterio de salida: compilación estricta y las 278 pruebas existentes en verde sin regresiones. **Detenerse para revisión humana.**

---

### Fase 3 — Pruebas unitarias y de integración HTTP contra PostgreSQL 15 · Estado: Hecha
- [x] Crear `src/modules/auth/jwt.test.ts` (algoritmo `HS256`, payload mínimo `{ id, role }`, expiración y fail-closed ante secreto o duración inválida).
- [x] Ampliar `auth.schema.test.ts`, `auth.service.test.ts` y `auth.controller.test.ts` cubriendo `login`.
- [x] Crear `tests/integration/http/auth-login.test.ts` (Supertest + PostgreSQL 15 en Docker): `200` (JWT válido para los 4 roles, `Cache-Control: no-store`, cero fugas en respuesta/logs), los 3 casos de `401` uniforme (`RN-08`), anti-truncado `> 72` bytes (`401`), `400` (Zod, BOPLA, JSON malformado), fail-closed `500` sin `jwt` y `UserRepository.findAuthByEmail`.
- [x] Verificar con `npm run typecheck && npm run typecheck:test && npm run build && npm test` bajo `sequence.shuffle: true` y chequeos estáticos (`0 any`, `0 .only`/`.skip`).

Criterio de salida: suite completa en verde. **Detenerse para revisión humana.**

---

### Fase 4 — Documentación, auditorías obligatorias y cierre · Estado: Hecha
- [x] Actualizar `CHANGELOG.md` (`## [Sin publicar]`) y archivar este plan en `docs/plans/archivo/2026-11-22_spec-03-2-auth-login.md`.
- [x] Ejecutar en paralelo las revisiones obligatorias de `GEMINI.md`: `@code-reviewer`, `@security-auditor` y `@qa-tester`.
- [x] Resolver eventuales hallazgos y ejecutar verificación final (`npm run typecheck && npm run typecheck:test && npm run build && npm test` y `git status --short`).

Criterio de salida: auditorías aprobadas y suite completa en verde, listo para `commit` y PR cuando el usuario lo indique.

---

## Regla de parada
Ejecutar **una fase por vez** y detenerse al finalizar cada fase para revisión humana antes de continuar con la siguiente.
