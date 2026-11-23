# Plan: Configurar TRUST_PROXY para que el rate limit identifique al cliente real detrás de un proxy (#38)

Fecha: 2026-11-23 · Rama: `feat/38-trust-proxy-config` · Origen: hallazgo medio de `security-auditor` en #36 · Milestone: `v0.1.0 — MVP TP Integrador` · Bloquea: #39 · Estado: **Completado y archivado (2026-11-23)**

## Objetivo
`GET /api/v1/recipes` limita 120 req/min **por IP** (#36), pero `src/server.ts` no configura `trust proxy` y `buildApp` usa `false`. Detrás de un proxy inverso (el `compose.yaml` de producción no publica el puerto de la API), todas las solicitudes llegan con la IP del proxy: un solo cliente agota la cuota y bloquea el catálogo para todos (DoS a terceros). Hay que permitir declarar, de forma validada y segura, en qué proxies confiar, sin abrir la puerta a falsificar `X-Forwarded-For`.

## Contexto que el agente debe leer
- `AGENTS.md` (límites: `.env`, configuración de Docker), `src/config/env.ts` y `env.test.ts`, `src/server.ts` y `server.test.ts`, `src/app.ts` (`trustProxy` ya soportado en `BuildAppOptions`)
- `src/middlewares/rate-limit.middleware.ts`, `tests/integration/http/recipes-rate-limit.test.ts` (ya prueba 1 salto y que sin `trust proxy` se ignora el header)
- `compose.yaml`, `compose.override.yaml`, `.env.example`, `README.md` (variables locales), `docs/sad.md` §7

## Hallazgos del análisis
- **Express ya soporta todo lo necesario** (`app.set("trust proxy", …)`): número de saltos, lista de IP/CIDR o presets (`loopback`, `linklocal`, `uniquelocal`). Express lanza `TypeError` en el arranque ante IP/rango inválido (`999.1.1.1`, `10.0.0.0/33`), pero con un mensaje poco claro: conviene validarlo antes en `env.ts` con el mismo estilo *fail fast* que el resto.
- **`true` es peligroso:** confía en cualquier `X-Forwarded-For` (el cliente elige su IP y evade el límite); `express-rate-limit` lo marca con `ERR_ERL_PERMISSIVE_TRUST_PROXY`. Debe rechazarse explícitamente.
- **Retrocompatibilidad:** sin la variable, el comportamiento debe seguir siendo `false` (no confiar). `.env.example` deja los valores vacíos, así que `TRUST_PROXY=` (vacío) debe interpretarse como "no configurado" y no como error.
- **Cómo probarlo:** `startServer` en `server.test.ts` usa una base *stub* (solo sondas de salud), por lo que el catálogo no se monta y no sirve para verificar el efecto. La verificación de extremo a extremo requiere `startServer` con la base real.
- **Docker de desarrollo:** `compose.override.yaml` publica `127.0.0.1:3000`; ahí no hay proxy y el valor correcto es `0`. Producción: depende del proxy que se ponga delante (normalmente `1`).

## Decisiones aprobadas (2026-11-23)
- **Formatos:** número de saltos `0`–`10` **y** lista de IPs/CIDR/presets.
- **Configuración:** aprobada la modificación de `.env.example` (`TRUST_PROXY=` vacío) y de `compose.yaml` (servicio `api`: `TRUST_PROXY: ${TRUST_PROXY:-0}`).

## Detalle de las decisiones
1. **`TRUST_PROXY` en `src/config/env.ts` (Zod 4), opcional, default `0`:**
   - Número entero de saltos `0`–`10` (`"1"` → `1`): confía en los *n* proxies más cercanos.
   - Lista separada por comas de IPs, rangos CIDR y/o presets `loopback`, `linklocal`, `uniquelocal` (p. ej. `"10.0.0.0/8, loopback"` → `"10.0.0.0/8,loopback"`), validada con `node:net` (`isIP` y longitud de prefijo válida para IPv4/IPv6). Es la opción más estricta: solo confía en las direcciones del proxy real.
   - Vacío o ausente → `0`. Rechaza `true`/`false`, negativos, decimales, `> 10`, IPs/rangos inválidos y presets desconocidos, con mensaje claro y sin exponer otros valores del entorno.
   - Tipo de salida `number | string` compatible con `BuildAppOptions.trustProxy`.
2. **`src/server.ts`:** pasa `trustProxy: env.TRUST_PROXY` a `buildApp` y registra en el log de arranque la política efectiva (p. ej. `trust proxy: 1 salto` / `trust proxy: desactivado`), sin datos sensibles.
3. **Configuración (límites de `AGENTS.md`, requiere aprobación):**
   - `.env.example`: agregar `TRUST_PROXY=` (vacío, con comentario de formatos válidos).
   - `compose.yaml` (servicio `api` de producción): `TRUST_PROXY: ${TRUST_PROXY:-0}`.
   - `README.md`: documentar la variable (`TRUST_PROXY=0` en desarrollo) y cuándo usar `1` o una lista de CIDR.
4. **Fuera de alcance:** store compartido (Redis) para varias réplicas; rate limit de login (#39, se desbloquea al cerrar este issue).

## Fases

### Fase 1 — Rama y registro del plan · Estado: Hecha
- [x] Crear la rama `feat/38-trust-proxy-config` desde `main` (`a726f9e`, con #36 mergeado)
- [x] Persistir este plan
Criterio: rama creada y plan registrado.

### Fase 2 — Validación de entorno y wiring · Estado: Hecha
- [x] `TRUST_PROXY` en `envSchema` (`src/config/env.ts`) con los formatos aprobados y default `0`
- [x] `src/server.ts`: `trustProxy: env.TRUST_PROXY` y log de la política efectiva
- [x] `npm run typecheck && npm run typecheck:test && npm run build && npm test`
Criterio: compilación estricta y suite existente en verde (se ajusta el test de defaults de `env.test.ts`).
Resultado:
- `src/config/env.ts`: `trustProxySchema` (`MAX_TRUST_PROXY_HOPS = 10`, `TRUST_PROXY_PRESETS`, validación de IP/CIDR con `node:net.isIP` y prefijo ≤ 32/128), tipo `TrustProxySetting = number | string` y `describeTrustProxy()` para el log. Vacío/ausente → `0`; `true`/`false` (sin distinguir mayúsculas) rechazados con mensaje explícito; lista normalizada sin espacios.
- `src/server.ts`: `trustProxy: env.TRUST_PROXY` en `buildApp` y log `[SERVER] trust proxy: …` tras el de escucha.
- Ajustes de pruebas existentes: `TRUST_PROXY: 0` en el `Env` de `server.test.ts` y en las 3 aserciones de igualdad exacta de `env.test.ts`; `vi.stubEnv("TRUST_PROXY", "")` en los 2 tests de `loadEnv` para no depender del `.env` local.
- Prueba rápida con `parseEnv` + `app.set("trust proxy", …)` real: los valores válidos (`""`, `"1"`, `"10"`, listas IPv4/IPv6/CIDR/presets) son aceptados por Express; `true`, `FALSE`, `11`, `-1`, `1.5`, `abc`, `999.1.1.1`, `10.0.0.0/33`, `::1/129`, `10.0.0.1/8/1`, `10.0.0.0/` y entradas vacías fallan en `parseEnv` con mensaje claro.
- typecheck, typecheck:test y build OK; 31 archivos · 663 pruebas en verde.


### Fase 3 — Pruebas · Estado: Hecha
- [x] `env.test.ts`: default y vacío → `0`; `"0"`/`"1"`/`"10"`; listas con IPv4, IPv6, CIDR y presets (normalizadas); rechazo de `true`, `false`, `-1`, `11`, `1.5`, `abc`, `999.1.1.1`, `10.0.0.0/33`, `::1/129`, preset desconocido y entradas vacías en la lista; el mensaje de error no filtra secretos
- [x] `tests/integration/http/server-trust-proxy.test.ts` (`startServer` real con PostgreSQL, puerto `0`, sin señales): con `TRUST_PROXY=1`, dos `X-Forwarded-For` distintos producen claves de partición distintas en `RateLimit-Policy` (contadores separados); sin configurar, el header se ignora (misma clave); el log de arranque informa la política
- [x] Suite completa en verde (`sequence.shuffle: true`)
Criterio: suite completa en verde.
Resultado:
- **Hallazgo propio durante las pruebas:** `0.0.0.0/0` y `::/0` pasaban la validación y equivalen a `trust proxy: true` (confían en cualquier cliente). Se agregó `isMatchAllRange` y se rechaza cualquier prefijo `/0` (incluido `/00`) con mensaje explícito.
- `env.test.ts` [+46]: vacío/espacios/ausente/`"0"` → `0`; saltos `1`, `" 2 "`, `10`; listas IPv4, IPv6, CIDR y presets normalizadas; rechazo de `true`/`false` en cualquier capitalización, rangos `/0`, `> 10` saltos y 17 formatos inválidos (`1e1`, `10.0.0`, `10.0.0.0/255.0.0.0`, `gggg::1`, `localhost`, `Loopback`, coma final, etc.); sin filtrar secretos; `describeTrustProxy`.
- `tests/integration/http/server-trust-proxy.test.ts` [5]: `startServer` real con PostgreSQL. Con `TRUST_PROXY=1` y con la lista `127.0.0.1`, IPs distintas de `X-Forwarded-For` tienen claves de partición (`pk`) y cuotas separadas; sin configurar o con una lista que no incluye al par TCP (`10.0.0.0/8`), falsificar el header no da cuota nueva; el log de arranque informa la política; `true` aborta el arranque.
- 32 archivos · 714 pruebas en verde (51 nuevas), sin advertencias `ERR_ERL_*`; typecheck, typecheck:test y build OK.


### Fase 4 — Configuración, documentación, auditorías y cierre · Estado: Hecha
- [x] `.env.example`, `compose.yaml`, `README.md`; `npm run docker:config` sin errores
- [x] `docs/sad.md` §7 (riesgo resuelto: cómo configurar `TRUST_PROXY` y por qué nunca `true`) y `CHANGELOG.md`
- [x] Auditorías como 3 subagentes en paralelo (`code-reviewer`, `security-auditor`, `qa-tester`; solo lectura, sin tocar la DB) y resolución de hallazgos
- [x] Archivar el plan en `docs/plans/archivo/`
Criterio: auditorías aprobadas y suite en verde, listo para commit/push/PR (al mergear se desbloquea #39).

## Auditorías (3 subagentes de Claude Code en paralelo, definiciones de `.agents/agents/`, solo lectura)
- **code-reviewer:** Media: `::ffff:0:0/96` y `::ffff:0.0.0.0/96` pasaban la validación y `proxy-addr` los convierte a `0.0.0.0/0` (confía en todo IPv4) → **resuelto**. Nit: `0.0.0.0/1,128.0.0.0/1` cubre todo IPv4 → **resuelto** con el prefijo mínimo. Verificado: ningún valor aceptado hace lanzar a Express (zona `%eth0`, `/032`, IPv4 mapeado), estilo Zod 4 coherente, config y docs alineadas.
- **security-auditor:** sin VETO. Media: listas equivalentes a `true` para todo IPv4 (`0.0.0.0/1,128.0.0.0/1`, `::ffff:0:0/96`, `0.0.0.0/1`), reproducido con `parseEnv` + `proxy-addr` → **resuelto**. Baja: falta advertir que más saltos que proxies reales (o `1` sin proxy) permite falsificar la IP → **resuelto** en `README.md`, `.env.example` y `docs/sad.md`. Informativa: presets amplios (`uniquelocal`) o la red Docker completa dejan falsificar la IP a otros hosts de esa red → **documentado** (preferir la IP exacta del proxy).
- **qa-tester:** Alta: sin cadenas `X-Forwarded-For` de varios saltos → **resuelto** (anteponer IPs falsas no da cuota nueva con 1 salto; 1 vs 2 saltos cambian la IP elegida). Media: el test de "aborta el arranque" solo llamaba a `parseEnv` → **resuelto** (`startServer` sin `env` con `vi.stubEnv` aborta antes de escuchar/abrir el pool). Media: nada verificaba que todo valor aceptado lo acepte Express → **resuelto** (`app.set("trust proxy", …)` por cada valor aceptado). Media: aserciones de `pk` pasaban si faltaba el header y sin `status` → **resuelto** (`probe` exige `200`, `pk` y `r`). Bajas → **resueltas**: IPv6 en `X-Forwarded-For` (`/56`), `remaining` en la lista `127.0.0.1`, preset `loopback` y lista de varias entradas de extremo a extremo.

## Decisión de endurecimiento tras las auditorías
- Además de `/0`, se exige un **prefijo mínimo `/8` en IPv4 y `/16` en IPv6** (`MIN_TRUST_PROXY_IPV4_PREFIX`, `MIN_TRUST_PROXY_IPV6_PREFIX`). Los IPv4 mapeados en IPv6 (`::ffff:x/p`, en cualquier notación, normalizados con `URL`) se evalúan por su prefijo IPv4 efectivo `p - 96`, igual que `proxy-addr`. Con `/8` como mínimo, cubrir todo IPv4 requeriría listar 256 rangos. Consecuencia: `fd00::/8` ya no se acepta (usar `fd00::/16` o el preset `uniquelocal`).

## Resultado final
- `npm run typecheck`, `npm run typecheck:test`, `npm run build`, `npm run docker:config` y `npm test` en verde: 32 archivos · 745 pruebas (82 nuevas: 70 en `env.test.ts` y 12 en `server-trust-proxy.test.ts`), sin advertencias `ERR_ERL_*`.
- Al mergear se desbloquea #39 (rate limit de `POST /api/v1/auth/login`).

