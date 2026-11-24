# Plan: [Spec 03.5] Acotar JWT_EXPIRES_IN con un tope máximo en la validación de configuración (#52)

Fecha: 2026-11-24 · Rama: `feat/52-jwt-expires-in-cap` · Parent: `#3` · Estado: **Completado y archivado (2026-11-24); pendiente commit/PR**

## Objetivo
Rechazar al arrancar (*fail fast*) un `JWT_EXPIRES_IN` mayor que un máximo, para acotar la ventana de exposición de un JWT stateless (`RN-08`, sin revocación). Hoy el formato `^[1-9]\d{0,5}(s|m|h|d|w|y)$` admite hasta `999999y`. Con el tope quedan acotados:
- un token filtrado;
- un `CHEF`/`NUTRITIONIST`/`ADMIN` desactivado o degradado, que sigue operando hasta el vencimiento (`docs/sad.md` §7);
- los JWT privilegiados emitidos antes de #48.

## Contexto que el agente debe leer
- `AGENTS.md`, `docs/business_rules.md` (`RN-08`), `docs/sad.md` §7, `docs/adr/0004-autenticacion-jwt-stateless-y-contrato-jsend.md`, ADR-0007
- Código:
  - `src/config/env.ts`: `JWT_EXPIRES_IN_PATTERN`, `isJwtExpiresIn`, tipos `JwtDurationUnit`/`JwtExpiresIn`, default `1d`
  - `src/modules/auth/jwt.ts`: **patrón duplicado** y `assertValidJwtConfig` al firmar
  - `src/server.ts:234`
- Pruebas: `src/config/env.test.ts` (acepta hoy `7d`, `1w`, `1y`) y `src/modules/auth/jwt.test.ts` (ventanas `15m`/`1h`/`1d` → `exp - iat`)
- Plan de referencia con validación de configuración similar: `docs/plans/archivo/2026-11-23_issue-38-trust-proxy-config.md`

## Análisis del estado actual
- **Dos validaciones independientes del mismo valor:** `env.ts` lo valida al arrancar y `jwt.ts` lo revalida al firmar (*fail closed*, defensa en profundidad para un `buildApp({ jwt })` armado a mano, p. ej. en pruebas). Si el tope se pone solo en `env.ts`, una app construida programáticamente puede seguir emitiendo tokens eternos. **Las dos deben compartir una única regla.**
- **Semántica de unidades:** `jsonwebtoken` interpreta `expiresIn` con la librería `ms`, donde `1y = 365,25 d` y `1w = 7 d`. La conversión a segundos debe usar esos mismos factores, para que el tope coincida con el `exp - iat` real del token.
- **Impacto de compatibilidad:** `compose.yaml` usa `${JWT_EXPIRES_IN:-1d}`, el `README` documenta `1d` y las pruebas usan `30s`/`15m`/`1h`/`2h`/`1d`, todos dentro de un tope de `1d`. **Solo cambia** el caso de `env.test.ts` que hoy *acepta* `7d`/`1w`/`1y`: pasan a ser rechazados (cambio de contrato de configuración). Un despliegue con `JWT_EXPIRES_IN` mayor a `1d` **no arrancará**, con un mensaje claro.
- **Docker:** no hace falta tocar `compose.yaml` (`AGENTS.md` pide confirmación para la configuración de Docker), porque su default `1d` ya cumple. El máximo se documenta en `.env.example` y en el `README`.

## Decisiones propuestas
1. **Módulo puro compartido** `src/config/jwt-expires-in.ts`, sin `dotenv` ni efectos, que importan `env.ts` y `jwt.ts`:
   - `JWT_EXPIRES_IN_PATTERN` (el formato actual, sin cambios) y `JWT_DURATION_UNIT_SECONDS` (`s: 1, m: 60, h: 3600, d: 86 400, w: 604 800, y: 31 557 600`, la semántica de `ms`).
   - `MAX_JWT_EXPIRES_IN_SECONDS = 86_400` (`1d`) y `MAX_JWT_EXPIRES_IN_LABEL = "1d"`.
   - `jwtExpiresInToSeconds(value): number | null` (`null` si el formato es inválido) e `isAllowedJwtExpiresIn(value): value is JwtExpiresIn` (formato **y** tope).
   - Los tipos `JwtDurationUnit`/`JwtExpiresIn` se mueven a este módulo y `env.ts` los re-exporta, para no romper los imports existentes.
2. **`env.ts`:** `JWT_EXPIRES_IN` pasa a usar `superRefine`, con **dos mensajes distintos**:
   - formato inválido → el mensaje actual;
   - fuera del tope → `"JWT_EXPIRES_IN no puede superar 1d (86400 s): limita la vigencia de tokens stateless sin revocación (RN-08)"`.

   El default `1d` no cambia y el mensaje no incluye otras variables ni secretos.
3. **`jwt.ts`:** `assertValidJwtConfig` usa `isAllowedJwtExpiresIn` (lanza `RangeError` también si se supera el tope) y se elimina el patrón duplicado.
4. **Triage** *(preguntas 1–3)*: tope de **`1d`**, el **mismo en todos los entornos**, y se **mantienen** las unidades `w`/`y` en el formato (se rechazan por el tope cuando lo exceden).
5. **Fuera de alcance:** refresh tokens, revocación (`tokenVersion`, `sessions`), rotación de `JWT_SECRET` (#51) y cambios en `compose.yaml`.

## Fases

### Fase 1 — Triage, rama y registro del plan · Estado: Hecha
- [x] Resolver las preguntas abiertas y pasar #52 de `needs-triage` a `ready-for-agent`, con un comentario de las decisiones
- [x] Crear la rama `feat/52-jwt-expires-in-cap` desde `main` (`a2b5e6d`, con #48 mergeado)
- [x] Mover #52 a `In Progress` (y el #48, ya cerrado, a `Done`)
Criterio: decisiones aprobadas y rama creada.

### Fase 2 — Implementación · Estado: Hecha
- [x] `src/config/jwt-expires-in.ts` (constantes, conversión y validación pura); re-export de los tipos desde `env.ts`
- [x] `envSchema.JWT_EXPIRES_IN` con `superRefine` y los dos mensajes
- [x] `assertValidJwtConfig` con la regla compartida, sin el patrón duplicado
- [x] `npm run typecheck && npm run typecheck:test && npm run build`
Criterio: compilación estricta; la única prueba existente que cambia de expectativa es la de `7d`/`1w`/`1y`.

### Fase 3 — Pruebas · Estado: Hecha
- [x] `src/config/jwt-expires-in.test.ts`:
  - conversión por unidad con la semántica de `ms` (`1y = 31 557 600`)
  - bordes del tope: `86400s`, `1440m`, `24h` y `1d` aceptados; `86401s`, `1441m`, `25h`, `2d`, `1w`, `1y` y `999999y` rechazados
  - formatos inválidos → `null`
- [x] `src/config/env.test.ts`:
  - mover `7d`/`1w`/`1y` a los rechazados, con el **mensaje de tope**, distinguiéndolo del de formato
  - mantener aceptados `30s`/`15m`/`2h`/`3600s`/`1d`, el default `1d` y el valor con espacios
  - verificar que el mensaje de error no filtra `JWT_SECRET` ni `DATABASE_URL`
- [x] `src/modules/auth/jwt.test.ts`:
  - `assertValidJwtConfig` y `signAccessToken` lanzan `RangeError` por encima del tope
  - **propiedad:** para cada duración aceptada en el borde (`86400s`, `1440m`, `24h`, `1d`), `exp - iat` del token firmado es igual al valor esperado y nunca supera `MAX_JWT_EXPIRES_IN_SECONDS`
- [x] Suite completa en verde, ejecutada **en forma secuencial**, y chequeos de mutación: subir el tope en el módulo compartido debe hacer fallar las pruebas de borde, y quitar el chequeo de `jwt.ts` debe hacer fallar su prueba de defensa en profundidad
Criterio: todos los criterios de aceptación del issue cubiertos.
Resultado: 45 archivos · 1198 pruebas en verde (secuencial).
- **Verificación de unidades:** se usa el `exp - iat` real de `jsonwebtoken`, que es dependencia directa, y no la librería `ms`, que es solo transitiva y no está en `package.json`.
- **`env.ts`:** dos `refine` (el de formato con `abort`), así el segundo narrowea a `JwtExpiresIn` sin `transform`.
- **Mutaciones detectadas:**
  - (a) tope subido a `2d` → fallan 17 pruebas;
  - (b) `jwt.ts` validando solo el formato → fallan 6.

### Fase 4 — Documentación, auditorías y cierre · Estado: Hecha
- [x] `.env.example` (comentario: máximo `1d`, ejemplos válidos) y `README.md` (variables de entorno: máximo y error de arranque)
- [x] `docs/sad.md` §7: el riesgo "Revisor o `ADMIN` desactivado o degradado con JWT vigente" pasa a tener una ventana máxima acotada de `1d`; se actualiza la sugerencia del despliegue de #48
- [x] `docs/business_rules.md` (`RN-08`: vigencia máxima del token) y `CHANGELOG.md` (`Cambiado`: valores mayores a `1d` rechazados al arrancar)
- [x] Auditorías con 3 subagentes en paralelo (solo lectura, **sin** tocar la base) y resolución de hallazgos
- [x] Archivar el plan; commit sugerido `feat(config): acotar JWT_EXPIRES_IN a 1d para limitar la vigencia de tokens stateless` — *commit/push/PR solo con confirmación*
Criterio: auditorías aprobadas, suite en verde y listo para el PR.

## Resultado final
- `npm run typecheck`, `npm run typecheck:test`, `npm run build` y `npm test` en verde: 45 archivos · 1204 pruebas (secuencial); `dist/` sin tests.
- **Mutaciones detectadas:**
  - tope subido a `2d` → fallan 17 pruebas;
  - `jwt.ts` validando solo el formato → fallan 6;
  - sin el chequeo `exp`/`iat` en `verifyAccessToken` → fallan 2.

## Auditorías (3 subagentes en paralelo, solo lectura y sin tocar la base)
- **security-auditor:** sin VETO. El único `jwt.sign` de `src/` está protegido por la regla compartida; no hay ReDoS y los mensajes no filtran secretos.
  - Baja/Informativa: `verifyAccessToken` aceptaba un token sin `exp` o con `exp` lejano firmado con el secreto → **resuelto** como defensa en profundidad: exige `iat` y `exp`, aplica `maxAge = 1d` y rechaza `exp - iat > 1d` (con su prueba de mutación).
  - Informativas: los tokens ya emitidos con valores mayores siguen válidos hasta su `exp` (rotar `JWT_SECRET`, runbook #51) y la ventana de `1d` sigue existiendo sin revocación → riesgos asumidos.
- **code-reviewer:** aprobado.
  - Baja: `assertValidJwtConfig` usaba un único mensaje → **resuelto** con los mismos dos mensajes del arranque.
  - Nit: `JWT_EXPIRES_IN_PATTERN` exportado sin uso → **resuelto** (es interno).
  - Nit: total de pruebas del `CHANGELOG` → **actualizado** con el resultado real de `npm test`.
- **qa-tester:** aprobado.
  - Media: la aserción `exp - iat ≤ tope` era tautológica → **resuelto**: se eliminó y el criterio se prueba del lado de la verificación (tokens sin `exp`/`iat`, con `exp` lejano o con `iat` vencido).
  - Bajas → **resueltas**: `1441m` en los excedentes de `jwt.test.ts`, el mensaje de `RangeError` sin el secreto y el texto positivo del mensaje de formato en `env.test.ts`.

## Preguntas abiertas (resueltas: opciones recomendadas; triage cerrado en #52)
1. **Valor del tope.** Recomendado: **`1d` (86 400 s)**, el default actual de `compose.yaml` y del `README`, compatible con todas las pruebas y sin obligar a refresh tokens. Alternativas: `12h` (más estricto; obliga a cambiar el default) o `7d` (más cómodo; mayor ventana de exposición).
2. **¿Tope distinto por entorno?** Recomendado: **el mismo en todos**, sin caminos que una mala configuración habilite (mismo criterio que ADR-0007). La alternativa es permitir más en `development`.
3. **Unidades `w`/`y`.** Recomendado: **mantenerlas en el formato** y rechazarlas por el tope, con un mensaje explícito de "no puede superar 1d" en lugar de "formato inválido". La alternativa es eliminarlas del patrón.

## Riesgos
- **Cambio de contrato de configuración:** un entorno con `JWT_EXPIRES_IN` mayor a `1d` deja de arrancar. Es intencional y queda documentado en el `CHANGELOG`; el mensaje indica el máximo.
- **Sesiones más cortas** para quien hoy use valores mayores: los usuarios tendrán que volver a iniciar sesión cada día como máximo. Es aceptable para el MVP sin refresh tokens.
