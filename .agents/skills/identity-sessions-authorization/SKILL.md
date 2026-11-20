---
name: identity-sessions-authorization
description: >-
  Diseña, implementa y audita autenticación, autorización RBAC/ownership y seguridad
  de identidad en TypeScript/Express/Prisma para Recetaria API — Bcrypt (>= 10) con
  defensa anti-enumeración, Bearer JWT endurecido (allowlist HS256, claims mínimos,
  fail closed), políticas puras por objeto y rol (RN-02 a RN-05), rutas privadas por
  defecto, tests de abuso (BOLA, BFLA, JWT tampering, timing) y patrones de evolución
  post-MVP (sesiones opacas, CSRF Fetch Metadata, refresh token rotation, Argon2id).
  Usar al implementar o revisar auth, middlewares JWT/RBAC, permisos o tests de seguridad.
---

# Identidad, Sesiones y Autorización — Recetaria API (TypeScript)

**Referencias:** OWASP Top 10:2025 (A01 Broken Access Control, A07 Authentication Failures), ASVS 5.0, NIST SP 800-63B-4, RFC 9700.

**Prioridades:** Seguridad → Correctitud → Menor privilegio → Revocabilidad → Auditabilidad → UX → Rendimiento.

## 1. Reglas duras (MUST)

- **Server-side y *fail closed*:** autenticar y autorizar en el servidor en cada request. Si falla la verificación JWT, la base de datos o una política, denegar el acceso (`401`/`403`/`500`), nunca degradar a permitido.
- **Rutas privadas por defecto:** declarar explícitamente el conjunto de rutas públicas (`GET /health`, `GET /health/ready`, `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `GET /api/v1/recipes`, `GET /api/v1/recipes/:id`) y verificar mediante test automatizado que toda mutación y `GET /api/v1/recipes/mine` exigen `authMiddleware`.
- **JWT endurecido (MVP):** firmar y verificar con `jsonwebtoken` usando **lista blanca explícita de algoritmo (`algorithms: ["HS256"]`)**, expiración acotada (`JWT_EXPIRES_IN`), secreto en `process.env.JWT_SECRET` y payload mínimo validado con Zod (`{ id, role }`). Nunca aceptar `alg` desde el token ni incluir `passwordHash` o datos sensibles en el JWT.
- **Contraseñas y login sin enumeración (`RN-08`):** hashear con `bcrypt` (`saltRounds >= 10` en el MVP) sin reglas arbitrarias de composición; devolver siempre el mismo `401 Unauthorized` genérico en login comparando contra un hash Bcrypt ficticio cuando el email no existe para homogeneizar tiempos.
- **Autorización por rol y por objeto:** combinar `rbacMiddleware` (chequeo grueso de rol) con políticas puras en `Service` (`recipePolicy` para ownership `RN-02`/`RN-03`, anti auto-aprobación `RN-05` y estado `DRAFT` `RN-04`).
- **Listados filtrados en la query:** expresar filtros y alcances directamente en el `where` de Prisma (`findMany`), nunca trayendo todas las filas a memoria.
- **Cero fugas en respuestas y logs:** excluir `passwordHash` de toda respuesta JSON; nunca loguear contraseñas, tokens Bearer completos ni secretos.

## 2. Arquitectura de identidad: MVP vs. Evolución Post-MVP

| Escenario | Arquitectura recomendada | Notas para Recetaria |
|---|---|---|
| **MVP actual (API REST)** | Bearer JWT stateless (`HS256`, vida corta) + Bcrypt `>= 10` | Definido en `ADR-0004` y `ADR-0005`; sin tabla `sessions`. En `/register`, `role` opcional solo para pruebas de cátedra |
| **Fase Beta / Producción** | Restringir `/register` a `role = 'USER'` + flujo KYC por `ADMIN`; migrar a **Argon2id** con rehash en login + chequeo HIBP (`k-anonymity`) | Evita escalada de privilegios y contraseñas filtradas (NIST 800-63B-4) |
| **Cliente Web / SPA propia** | **BFF** o sesión opaca server-side (`__Host-session`, `HttpOnly`, `Secure`, `SameSite=Lax`, ID ≥ 128 bits hasheado con SHA-256 en store, idle + absolute timeout) + CSRF (`Sec-Fetch-Site` + `Origin`) | Nunca guardar tokens en `localStorage`/`sessionStorage`; regenerar sesión en login y cambios de privilegio |
| **Clientes móviles / revocación** | Access token corto + **refresh tokens rotados** con detección de reutilización (revocación de familia en `$transaction`) | Sin renovación infinita; revocar en logout o cambio de contraseña |
| **Cuentas `ADMIN` / alto riesgo** | **Passkeys (WebAuthn)** o TOTP sin replay + códigos de recuperación hasheados + **step-up** en operaciones críticas | Obligatorio al operar datos reales en producción |

## 3. Políticas de autorización en Recetaria (`docs/roles.md` y `docs/business_rules.md`)

Modelar reglas como funciones puras en `src/modules/recipes/recipe.policy.ts` (testeables sin HTTP ni DB):
- **`canEdit(actor, recipe)`:** `recipe.authorId === actor.id` (`RN-02` → `403` si falla; ni `ADMIN` edita recetas ajenas).
- **`canDelete(actor, recipe)`:** `recipe.authorId === actor.id || actor.role === "ADMIN"` (`RN-03` → `403` si falla).
- **`canApprove(actor, recipe)`:** `(actor.role === "CHEF" || actor.role === "NUTRITIONIST") && recipe.authorId !== actor.id` (`RN-04`/`RN-05` → `403` si falla; `409` si ya está `APPROVED`).

*(En futuros recursos privados multi-tenant, devolver `404 Not Found` para recursos ajenos a fin de no revelar existencia).*

## 4. Tests de abuso obligatorios (Supertest / Vitest)

| Ataque / Caso | Verificación exigida |
|---|---|
| **JWT ausente / manipulado / expirado / `alg: none`** | Todas las mutaciones devuelven `401 Unauthorized` en formato JSend |
| **BOLA / IDOR (`PUT` / `DELETE` ajeno)** | Usuario B sobre receta de Usuario A → `403 Forbidden` |
| **BFLA (`/approve` sin rol profesional)** | `USER` o `ADMIN` intentando aprobar → `403 Forbidden` |
| **Auto-aprobación (`RN-05`)** | `CHEF` o `NUTRITIONIST` intentando aprobar su propia receta → `403 Forbidden` |
| **Doble aprobación (`RN-04`)** | Aprobar una receta ya `APPROVED` → `409 Conflict` |
| **Enumeración y fuga de credenciales** | Login con email inexistente vs. clave errónea devuelve exactamente el mismo `401`; ninguna respuesta incluye `passwordHash` |
| **Rutas privadas por defecto** | Test recorriendo rutas registradas confirma que ninguna ruta fuera de `PUBLIC_ROUTES` responde `2xx` sin JWT |

## 5. Logging de eventos de identidad y patrones de referencia

Registrar de forma estructurada (con `userId`, método, ruta, resultado y motivo; sin secretos ni tokens): `auth.register.success`, `auth.login.success`, `auth.login.failure`, `authz.denied`, `recipe.approved`, `recipe.reset_to_draft`, `recipe.deleted`.

Consultá [`references/security-patterns.md`](./references/security-patterns.md) cuando necesites:
- Implementación TypeScript de `verifyAccessToken`, `comparePasswordTimingSafe`, `recipePolicy` y test automático de `PUBLIC_ROUTES`.
- Patrones TypeScript/Express/Prisma para evolución post-MVP: `isPwned` (HIBP k-anonymity), middleware CSRF con Fetch Metadata, rotación de refresh tokens en `$transaction` y sesiones opacas server-side.

## 6. Antipatrones a evitar

- Confiar en el algoritmo `alg` declarado en el header del JWT o no validar el payload decodificado.
- Autorizar solo en `rbacMiddleware` olvidando ownership (`authorId`) o estado del recurso en `Service`.
- Filtrar listados de recetas en memoria en lugar de en `prisma.recipe.findMany({ where })`.
- Devolver `passwordHash` o mensajes distintos ("usuario no existe" vs "clave inválida") en login.
- Guardar tokens en `localStorage`, usar cookies sin `HttpOnly`/`Secure`/`SameSite`, usar `MemoryStore` en producción o asumir que CORS protege contra CSRF.
- Usar reglas arbitrarias de composición o caducidad por calendario en contraseñas, o *fail open* ante fallos de verificación.

## 7. Definition of Done

Una implementación o auditoría de identidad/autorización está completa solo cuando cumple todo:
- [ ] `authMiddleware` verifica JWT con `algorithms: ["HS256"]`, valida claims `{ id, role }` con Zod y falla cerrado (`401`).
- [ ] `AuthService` usa Bcrypt (`>= 10`), comparación timing-safe con hash ficticio y respuestas `401` sin enumeración ni `passwordHash`.
- [ ] `recipePolicy` cubre `RN-02` a `RN-05` con tests unitarios puros y los listados filtran en la query de Prisma.
- [ ] Todos los tests de abuso de §4 (incluido el test de rutas privadas por defecto) pasan en verde (ver estrategia P0, prueba de sensibilidad y gates de CI en [critical-path-testing](../critical-path-testing/SKILL.md)).
- [ ] Ningún token, contraseña ni `JWT_SECRET` aparece en respuestas, código versionado o logs.
