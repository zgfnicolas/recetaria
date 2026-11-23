# Plan: Rate limit contra fuerza bruta en POST /api/v1/auth/login (#39)

Fecha: 2026-11-23 · Rama: `feat/39-auth-login-rate-limit` · Origen: análisis de #36 · Milestone: `v0.1.0 — MVP TP Integrador` · Dependencia: #38 (cerrado en #41) · Estado: **Completado y archivado (2026-11-23)**

## Objetivo
`POST /api/v1/auth/login` es público y no limita intentos: permite fuerza bruta contra una cuenta y *credential stuffing* (OWASP API2 / API4), y cada intento ejecuta un `bcrypt.compare` deliberadamente costoso (CPU). Reutilizar `createRateLimitMiddleware` de #36 —que ya identifica al cliente real detrás de un proxy gracias a `TRUST_PROXY` (#38)— para cortar intentos abusivos **antes** de validar y de comparar contraseñas, sin romper la anti-enumeración de `RN-08`.

## Contexto que el agente debe leer
- `AGENTS.md`, `docs/business_rules.md` (`RN-08`: mismo `401` genérico para email inexistente, clave errónea o cuenta inactiva; comparación timing-safe), `docs/compliance.md`
- `src/middlewares/rate-limit.middleware.ts` (+ tests), `src/modules/auth/auth.router.ts`, `src/modules/auth/auth.schema.ts` (`emailFieldSchema`: `trim` + `toLowerCase`), `src/bootstrap/container.ts`, `src/app.ts` (`publicRateLimit`)
- `tests/integration/http/auth-login.test.ts`, `auth-register.test.ts`, `auth-guards.test.ts`, `recipes-*.test.ts` (volumen de logins/registros por app)

## Hallazgos del análisis
- **Orden y costo:** `express.json` corre a nivel app; el limitador puede ir antes de `validateMiddleware` en el router de auth y leer `req.body` crudo. Bloquear ahí evita también el `bcrypt.compare`.
- **Contar solo fallos:** `express-rate-limit` soporta `skipSuccessfulRequests` (cuenta solo respuestas `>= 400`). Un usuario legítimo que inicia sesión bien no consume cuota; los `401` y `400` sí.
- **Límite por cuenta (email):** frena el ataque distribuido contra **una** cuenta desde muchas IPs, pero introduce el riesgo de **bloqueo dirigido**: un atacante puede agotar la cuota de la cuenta de la víctima y dejarla sin poder entrar durante la ventana. Se mitiga con umbral más alto que el de IP, ventana corta y contando solo fallos. Para no romper `RN-08`, el límite aplica a **cualquier** email (exista o no) y el `429` es idéntico en ambos casos.
- **Datos personales en memoria:** el store en memoria guardaría emails en claro como claves; conviene usar un hash (`sha256`) del email normalizado como clave (`docs/compliance.md`, Ley 25.326).
- **Registro:** `POST /api/v1/auth/register` también es público y crea cuentas masivamente (y ejecuta `bcrypt.hash`); el issue pide evaluarlo.
- **Tests existentes:** cada prueba de auth construye su propia app (store nuevo) y hace pocos intentos, por lo que límites razonables no deberían romperlas; igualmente se agrega una opción de `buildApp` para configurarlos o desactivarlos, como `publicRateLimit`.

## Decisiones aprobadas (2026-11-23)
- **Alcance:** límite de login **por IP + por cuenta** (email normalizado y hasheado), contando solo intentos fallidos.
- **Umbrales:** **10 fallidos por IP** y **20 fallidos por cuenta** cada **15 minutos**.
- **Registro:** incluido, **5 registros por hora por IP**.

## Detalle de las decisiones
1. **Alcance del límite de login:** por IP + por cuenta (aprobado).
2. **Umbrales por defecto** (contando solo intentos fallidos):
   - Por IP: **10 intentos fallidos / 15 min** (política `auth-login-ip`).
   - Por cuenta: **20 intentos fallidos / 15 min** por email normalizado y hasheado (política `auth-login-account`).
   - Registro por IP: **5 registros / hora** contando todas las solicitudes (política `auth-register-ip`).
3. **Extensión de `createRateLimitMiddleware`** (retrocompatible): opciones `countOnlyFailures` (`skipSuccessfulRequests`), `key` (función que devuelve la clave o `undefined` para no aplicar ese limitador, p. ej. body sin email válido) y `message` del `429`. El limitador por IP sigue usando la clave por defecto de la librería (IPv6 `/56`).
4. **Wiring:** `createAuthRouter(controller, { loginLimiters, registerLimiter })` con orden `rateLimit → validateMiddleware → controller`; `BuildAppOptions.authRateLimit?: { login?, loginAccount?, register? } | false` → `buildApiRouters`. Mensaje del `429`: "Demasiados intentos, intentá nuevamente más tarde" (no revela si la cuenta existe).
5. **Docs:** `RN-08` (`docs/business_rules.md`: se aplica también en el rate limit de `/auth`), `README.md` (`429` en `/auth/login` y `/auth/register`), `docs/sad.md`, `CHANGELOG.md`.
6. **Fuera de alcance:** store compartido (Redis) para varias réplicas, CAPTCHA, retardo progresivo y bloqueo persistente de cuentas.

## Fases

### Fase 1 — Rama y registro del plan · Estado: Hecha
- [x] Crear la rama `feat/39-auth-login-rate-limit` desde `main` (`0501b29`, con #38 mergeado)
- [x] Persistir este plan
Criterio: rama creada y plan registrado.

### Fase 2 — Implementación · Estado: Hecha
- [x] Extender `createRateLimitMiddleware` (`countOnlyFailures`, `key`, `message`) sin romper `GET /api/v1/recipes`
- [x] Clave por cuenta: email de `req.body` (`string`, `trim` + `toLowerCase`, ≤ 255) → `sha256`; sin email válido no aplica (el límite por IP sigue)
- [x] `createAuthRouter` + `container.ts` + `BuildAppOptions.authRateLimit`
- [x] `npm run typecheck && npm run typecheck:test && npm run build && npm test`
Criterio: compilación estricta y 745 pruebas existentes en verde.
Resultado:
- `src/middlewares/rate-limit.middleware.ts`: `RateLimitConfig` suma `countOnlyFailures` (`skipSuccessfulRequests`) y `message`; nuevo `RateLimitKeyResolver` / `RateLimitMiddlewareOptions.key` (con `skip` cuando la clave es `undefined`). Retrocompatible: el catálogo sigue igual.
- `src/modules/auth/auth.rate-limit.ts`: `DEFAULT_AUTH_LOGIN_IP_RATE_LIMIT` (10 fallidos / 15 min), `DEFAULT_AUTH_LOGIN_ACCOUNT_RATE_LIMIT` (20 fallidos / 15 min), `DEFAULT_AUTH_REGISTER_RATE_LIMIT` (5 / hora), mensaje genérico `AUTH_RATE_LIMIT_EXCEEDED_MESSAGE` y `loginAccountRateLimitKey` (`sha256` del email `trim` + `toLowerCase`, ≤ 255; `undefined` si no hay email utilizable).
- Wiring: `createAuthRouter(controller, { loginLimiters, registerLimiter })` con orden `rateLimit → validate → controller`; `AuthRateLimitOptions` en `container.ts` y `BuildAppOptions.authRateLimit` (`false` o `false` por entrada para desactivar).
- Ajuste de prueba existente: `recipes-rate-limit.test.ts` verificaba que `/auth/login` no tuviera headers `RateLimit`; ahora verifica que no use la política `recipes-public-read` (tiene las suyas).
- Prueba rápida contra la base de desarrollo: 10 logins fallidos → `401` y el 11.º → `429` con `Retry-After: 899` y el mensaje genérico; las dos políticas aparecen en `RateLimit-Policy` (`auth-login-ip` q=10 w=900, `auth-login-account` q=20 w=900); 6.º registro → `429`.
- typecheck, typecheck:test y build OK; 32 archivos · 745 pruebas en verde, sin advertencias `ERR_ERL_*`.


### Fase 3 — Pruebas · Estado: Hecha
- [x] Unitarias del middleware: `countOnlyFailures` (los `2xx` no consumen cuota, los `4xx` sí), `key` personalizada y `undefined` → no limita, `message` propio
- [x] Integración `tests/integration/http/auth-rate-limit.test.ts` (PostgreSQL):
  - N logins fallidos → `429` JSend con `Retry-After`; los exitosos no consumen cuota
  - bloqueado por IP: tampoco puede entrar con la clave correcta hasta que vence la ventana; otra IP (`TRUST_PROXY` de 1 salto) sí
  - por cuenta: fallos contra el mismo email desde IPs distintas → `429`; otro email no se ve afectado; mismo `429` para email existente e inexistente (`RN-08`); variantes de mayúsculas/espacios del email comparten cuota; la clave no expone el email
  - los `400` de validación consumen cuota; un `429` no ejecuta `bcrypt.compare` (espía sobre el repositorio/servicio)
  - registro: N registros → `429`; no afecta a login ni a `GET /api/v1/recipes`
- [x] Suite completa en verde (`sequence.shuffle: true`)
Criterio: suite completa en verde.
Resultado:
- Unitarias [+19]: `rate-limit.middleware.test.ts` [+5] (`countOnlyFailures` cuenta solo fallos y bloquea luego también los éxitos; sin la opción cuenta todo; `key` por clave e ignorando la IP; `key` → `undefined` no aplica; `message` propio) y `auth.rate-limit.test.ts` [14] (políticas por defecto congeladas, mensaje genérico, normalización de mayúsculas/espacios, claves distintas por email, sin email en claro, 8 cuerpos sin email utilizable → `undefined`, aplica a emails inexistentes).
- Integración `tests/integration/http/auth-rate-limit.test.ts` [11] sobre PostgreSQL con `trustProxy: 1`: políticas por defecto en los headers; éxitos que no consumen cuota y `429` JSend con `Retry-After`; IP bloqueada sin acceso con la clave correcta y otra IP con acceso; `400` que consumen cuota; `429` sin llegar al repositorio (sin `bcrypt.compare`); bloqueo por cuenta desde 3 IPs sin afectar otra cuenta; mismo `429` para email existente e inexistente (`RN-08`); variantes del email que comparten cuota; `pk` sin el email; registro bloqueado al 3.º sin afectar login ni catálogo; `authRateLimit: false`.
- Chequeo de mutación: contar éxitos (`countOnlyFailures: false`), no normalizar el email y poner el limitador después de `validateMiddleware` hacen fallar 1, 3 y 1 pruebas respectivamente (archivos restaurados y verificados con `cmp`).
- 34 archivos · 775 pruebas en verde (30 nuevas), sin advertencias `ERR_ERL_*`; typecheck, typecheck:test y build OK.


### Fase 4 — Documentación, auditorías y cierre · Estado: Hecha
- [x] `docs/business_rules.md` (`RN-08`), `README.md`, `docs/sad.md`, `CHANGELOG.md`
- [x] Auditorías como 3 subagentes en paralelo (`code-reviewer`, `security-auditor`, `qa-tester`; solo lectura, sin tocar la DB) y resolución de hallazgos
- [x] Archivar el plan en `docs/plans/archivo/`
Criterio: auditorías aprobadas y suite en verde, listo para commit/push/PR.

## Auditorías (3 subagentes de Claude Code en paralelo, definiciones de `.agents/agents/`, solo lectura)
- **code-reviewer:** aprobado (sin altos ni medios). `RN-08` intacta, normalización idéntica a `emailFieldSchema`, sin `ERR_ERL_*`, retrocompatibilidad y docs coherentes. Bajas: (1) los `429` del limitador por cuenta consumían la cuota por IP (un usuario que reintenta contra su cuenta bloqueada agota su IP y, en un NAT, la de otros) → **resuelto** con `ignoreRateLimitedResponses`; (2) el header `"auth-login-account"; r=N` revelaba a cualquiera los fallos de un email ajeno → **resuelto** con `exposeHeaders: false`. Nits: doble cálculo de la clave (inocuo, sin cambio) y título del test de bcrypt → **resuelto**.
- **security-auditor:** sin VETO. Verificado con script: la clave coincide con `emailFieldSchema` para toda entrada aceptada, sin carreras (el incremento es previo al handler; una conexión abortada cuenta como fallo), sin oráculo de existencia ni de tiempos, memoria acotada. Media (trade-off aceptado): el bloqueo dirigido cuesta solo 3 orígenes (IPv6 `/48` = 256 subredes `/56`) → **documentado** con cifras y mitigaciones futuras en `docs/sad.md`. Baja: fuga de metadatos por `r=` → **resuelto** (misma corrección que code-reviewer). Informativa: NAT en registro → **documentado**.
- **qa-tester:** cobertura buena. Media: `Promise.all` de éxitos con `limit: 2` podía ser intermitente → **resuelto** (secuencial). Media: sin prueba de ambos limitadores activos → **resuelto** (bloqueo por IP no suma a la cuenta; reintentos contra cuenta bloqueada no agotan la IP). Media: sin fallos en paralelo → **resuelto** (8 en paralelo → exactamente 3 × `401`, 5 × `429` y 3 consultas). Bajas → **resueltas**: cuenta inactiva cuenta como fallo, vencimiento de la ventana, `400`/`409` de registro consumen cuota, `429` por cuenta sin consultar la base, cuerpo sin email no se limita por cuenta, aserciones más estrictas y default de 20 por cuenta verificado con los valores reales.

## Resultado final
- Chequeo de mutación adicional: quitar `ignoreRateLimitedResponses` o `exposeHeaders: false` de los defaults hace fallar 1 y 2 pruebas (archivo restaurado y verificado con `cmp`).
- `npm run typecheck`, `npm run typecheck:test`, `npm run build` y `npm test` en verde: 34 archivos · 787 pruebas (42 nuevas: 8 del middleware, 14 de `auth.rate-limit.test.ts` y 20 de integración), sin advertencias `ERR_ERL_*`.

