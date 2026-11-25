# Plan — #24 [Spec 06.3] Verificación de despliegue Docker Compose (dev y prod), HEALTHCHECK y cierre del TP

Fecha: 2026-11-25 · Rama propuesta: `fix/24-docker-deploy` (desde `main`, con #59 y #60 mergeados) · Parent: `#6` · Estado: **Completado y archivado (2026-11-25)**

## 1. Objetivo
Demostrar, con evidencia reproducible, que Recetaria API:
- compila en ESM estricto y pasa el 100 % de las pruebas;
- arranca en contenedores tanto en desarrollo (`docker:dev`) como con la imagen endurecida de producción (`docker:prod`: Node 24 Bookworm slim, usuario `node` y `read_only`) contra PostgreSQL 15;
- llega a `healthy` con un `HEALTHCHECK` sobre `/health`, sin consultar la base (ADR-0006);
- responde con JSend correcto a las pruebas de humo;
- cierra el TP con `.env.example` limpio, documentación fiel y las tres auditorías finales.

## 2. Estado actual (análisis con evidencia)
Verificado con builds reales (`docker build --target …`, solo imágenes locales `recetaria-verify:*`, sin tocar contenedores ni volúmenes) y con `docker compose config`:

| # | Hallazgo | Evidencia | Impacto |
|---|---|---|---|
| 1 | ✅ La imagen de **producción compila** | `prebuild` → `prisma generate` antes de `tsc`. `dist/generated/prisma` existe, usuario `node`, Node `v24.22.3` | — |
| 2 | ❌ La imagen de **desarrollo no tiene el cliente de Prisma** *(corregido en la implementación: con `docker:dev`, el montaje de solo lectura de `./src` usa el cliente del host, que el inicio rápido genera con `npm run db:generate`. Solo falla en un clon nuevo sin ese paso)* | `.dockerignore` excluye `src/generated`, y la etapa `development` hace `COPY . .` sin `prisma generate`. Dentro de la imagen, `ls src/generated` → *No such file* | **`docker:dev` no puede arrancar**: `tsx watch src/server.ts` falla al importar `src/generated/prisma/client.js` |
| 3 | ❌ **No hay forma de migrar en contenedores** | La imagen de producción no trae `prisma/` (ni el CLI de desarrollo), y ningún servicio ejecuta `prisma migrate deploy` | El stack arranca con una base **sin tablas**. `/health` y `/health/ready` dan 200, pero `login`, `recipes` y `/mine` dan 500. Fallan 3 de las 5 pruebas de humo del ticket |
| 4 | ❌ **`docker:prod` corre con `NODE_ENV=development`** | `compose.yaml` usa `NODE_ENV: ${NODE_ENV:-production}`, y Compose interpola desde `.env` (`NODE_ENV=development`). `docker compose -f compose.yaml config` → `NODE_ENV: development` | La imagen "de producción" arranca en modo desarrollo. Hoy cambia poco, pero rompe la garantía de entorno, y un `production` real bloquearía el seed como corresponde |
| 5 | ⚠️ **Dev y prod comparten el proyecto Compose `recetaria`** | El mismo nombre de proyecto, el volumen `postgres_data` y los mismos contenedores | Probar `docker:prod` reutiliza o recrea la base de **desarrollo** del usuario. Las pruebas de humo deben correr en un proyecto aislado y efímero |
| 6 | ⚠️ El `api` de producción **no publica puertos** | Solo redes internas, sin `ports:` en `compose.yaml` | Correcto para producción (detrás de un proxy), pero las pruebas de humo desde el host necesitan una vía: un override solo para el humo |
| 7 | ⚠️ `.env.example` **tiene un valor** | `PRISMA_HIDE_UPDATE_MESSAGE=1` | Incumple el criterio "exclusivamente nombres sin valores" (Requisito 10 del TP) |
| 8 | ✅ `npm run docker:config` sale con `0`; `typecheck`, `build` y `npm test` están en verde en `main` | — | — |

## 3. Diseño propuesto
### 3.1 `Dockerfile` (*requiere confirmación: configuración de Docker*)
- **Etapa `development`:** `RUN npx prisma generate` después del `COPY` y antes de `USER node`, para que `tsx` encuentre el cliente. Arregla el hallazgo 2.
- **Etapa nueva `migrator`** (`FROM dependencies`): copia `prisma/`, `prisma.config.ts`, `tsconfig.json` y `src/` (el seed importa el cliente generado), ejecuta `prisma generate`, corre como `USER node` y su `CMD` es `["./node_modules/.bin/prisma", "migrate", "deploy"]`. Usa el binario local y no `npx`, porque `npx` intenta escribir su caché en un sistema de archivos de solo lectura.
  - Tiene las dependencias de desarrollo (CLI de `prisma` y `tsx`) **sin contaminar** la imagen de producción, que sigue mínima.
  - Es el patrón estándar de un contenedor de migración *one-shot*, separado del runtime.

### 3.2 `compose.yaml` (*requiere confirmación*)
- **Servicio nuevo `migrate`:**
  - `target: migrator`, red `data` y `depends_on: postgres (service_healthy)`, con `restart: "no"`;
  - el mismo endurecimiento: `cap_drop`, `no-new-privileges`, `read_only` con `tmpfs` y límites;
  - `DATABASE_URL` y `MIGRATION_DATABASE_URL`, preparada para el rol DDL de Fase Beta.
- **`api`:** `depends_on: migrate (service_completed_successfully)`, porque nunca arranca contra un esquema viejo, y **`NODE_ENV: production` fijo**, sin interpolar desde `.env`. Arregla los hallazgos 3 y 4.
- **`compose.override.yaml` (dev):**
  - `migrate` hereda la configuración (incluido `read_only: true`, porque solo escribe en `/tmp`) y en dev además siembra;
  - el `api` de dev suma un `healthcheck` equivalente al de la imagen, para que `--wait` sirva también en dev.

### 3.3 Pruebas de humo reproducibles — `scripts/smoke/compose-smoke.mjs` y `compose.smoke.yaml`
Node puro, sin dependencias nuevas, **en un proyecto aislado** (`-p recetaria-smoke-prod` / `recetaria-smoke-dev`) con su propio volumen efímero: nunca toca el proyecto `recetaria` ni la base de desarrollo del usuario (hallazgo 5).

1. **Producción** (`compose.yaml` + `compose.smoke.yaml`):
   - el override solo publica `api` en `127.0.0.1:${SMOKE_PORT:-3100}`;
   - el `migrate` del humo, además de migrar, siembra con `NODE_ENV=test`. Se acepta porque es un stack de prueba efímero; la allowlist del seed lo permite y en producción real sigue bloqueado.
   - `up -d --build` y un sondeo propio del estado de salud, que no usa `--wait` y corta ante `exited`, `dead`, `restarting` o reinicios. Se verifica con `docker inspect`:
     - estado **`healthy`**;
     - `User=node`;
     - `ReadonlyRootfs=true`;
     - `migrate` terminó con `0`.
   - Pruebas HTTP con aserciones JSend:
     - `GET /health` 200;
     - `GET /health/ready` 200;
     - `POST /api/v1/auth/login` con `user@recetaria.com` 200, con token;
     - `GET /api/v1/recipes` 200, con `items` y `meta`;
     - `GET /api/v1/recipes/mine` con Bearer 200.
   - **Prueba de ADR-0006:** se detiene `postgres`; `/health` sigue en 200 y el contenedor sigue `healthy`, mientras `/health/ready` pasa a 503. Así se demuestra que el `HEALTHCHECK` no consulta la base.
2. **Desarrollo** (`compose.yaml` + `compose.override.yaml`, con `PORT=3101` y `POSTGRES_PORT=55432` para no chocar con el `npm run dev` ni con el PostgreSQL del usuario): `up -d --build`, con la migración y el seed hechos por el servicio `migrate` de dev, y las mismas 5 pruebas de humo.
3. **Limpieza siempre** (`finally`): `docker compose -p recetaria-smoke-* down -v`. Solo borra **los recursos que creó el propio humo**.
4. **Salida:** un resumen legible y código de salida distinto de 0 ante cualquier fallo. **No entra en `npm test`**: es lento y requiere Docker. Corre con `npm run docker:smoke` (pregunta 4).

### 3.4 Requisito 10 y documentación
- **`.env.example`:** `PRISMA_HIDE_UPDATE_MESSAGE=`, con la recomendación en un comentario. Una prueba nueva, `tests/docs/env-example.test.ts`, exige que **toda** variable de `.env.example` esté vacía, para que no vuelva a pasar.
- **`README.md`:** la sección Docker (dev, prod, `migrate`, seed solo en dev, `docker:smoke`, puertos y aislamiento).
- **`docs/sad.md`:** el contenedor `migrate` en la tabla C4 nivel 2, `NODE_ENV` fijo y los riesgos actualizados.
- **`docs/testing.md`:** el nivel "Humo de despliegue".
- **`CHANGELOG.md`.**

### 3.5 Cierre del TP
- Las tres auditorías **finales** sobre todo el repositorio (`code-reviewer`, `security-auditor`, `qa-tester`), sin hallazgos críticos abiertos.
- Al mergear se cierra #24. #6 **queda abierto** hasta que se resuelva #51 (`ready-for-human`).

## 4. Fases
### Fase 1 — Triage y rama · Estado: Hecha
- [x] Resolver §6 y crear `fix/24-docker-deploy` desde `main`.
- [x] Borrar las imágenes de verificación `recetaria-verify:{build,dev,prod}` que creó este análisis.

### Fase 2 — `Dockerfile` y Compose (§3.1, §3.2) · Estado: Hecha
- [x] Cambios y `npm run docker:config`, con `docker compose -f compose.yaml config` mostrando `NODE_ENV: production`.

### Fase 3 — Pruebas de humo (§3.3) · Estado: Hecha
- [x] Script y override. Se corre contra producción y contra desarrollo, con evidencia: estado de salud, usuario, sistema de archivos de solo lectura y las respuestas.

### Fase 4 — Requisito 10, documentación y verificación (§3.4) · Estado: Hecha
- [x] `npm run typecheck`, `npm run build`, `npm test`, `npm run docker:config` y `npm run docker:smoke`, todos con código de salida `0`.
- [x] Mutaciones:
  - sin el `prisma generate` en dev → el humo de dev falla;
  - sin el servicio `migrate` → falla el login del humo;
  - un `HEALTHCHECK` que consulta `/health/ready` → falla la prueba de ADR-0006;
  - un valor en `.env.example` → falla la prueba nueva.

### Fase 5 — Auditorías finales y cierre (§3.5) · Estado: Hecha
Resultado:
- `typecheck`, `typecheck:test`, `build` y `docker:config` OK; `npm test` da 61 archivos · 1485 pruebas.
- `npm run docker:smoke` da **26/26** en la verificación final, con prod (18, que suma Debian Bookworm, Node 24 y PostgreSQL 15) y dev (8). `npm test` da 61 archivos · 1486 pruebas. No quedan contenedores ni volúmenes `smoke`, y la base de desarrollo del usuario quedó intacta: 4 usuarios, verificado con una consulta de solo lectura.

**Decisiones durante la implementación:**
- **Dev:** se conserva el montaje de solo lectura de `./src`, que es una decisión de endurecimiento existente. La imagen genera el cliente para funcionar sin montajes, y con `docker:dev` el contenedor **falla con un mensaje claro** si el host no tiene el cliente.
  - Se descartó montar `src` con escritura.
  - Un volumen anónimo anidado sobre el montaje de solo lectura falla cuando el host no tiene `src/generated`: se verificó empíricamente.
- **`migrate` en dev** también siembra, porque es idempotente y solo corre en `development|test`. Así `docker:dev` queda listo para usar.
- **Las pruebas de humo usan su propio `--env-file`** con secretos aleatorios, y quitan del entorno heredado las variables que controlan: nunca leen el `.env` del usuario. También usan `IMAGE_TAG=smoke`, para no pisar `recetaria/api:1.0.0`.
- **Prueba de ADR-0006:** exige una sonda **exitosa** después del corte, porque Docker tolera `retries` fallos antes de marcar `unhealthy`.

**Mutaciones:**
- `migrate` sin migrar → fallan login, `/recipes` y `/mine` (13/16);
- un `HEALTHCHECK` sobre `/health/ready` → falla ADR-0006 (15/16);
- un valor en `.env.example` → falla `env-example.test.ts`.

**Incidente:** al limpiar una prueba descartable intenté un `docker volume prune -f`, que habría borrado **todos** los volúmenes sin uso del sistema. El clasificador de permisos lo bloqueó y no se ejecutó. Se reemplazó por `docker run --rm`, que elimina solo los volúmenes anónimos propios.

## 5. Riesgos
- **Tiempo:** cada corrida del humo construye dos imágenes, con caché de BuildKit; tarda unos minutos.
- **Puertos ocupados** en la máquina del evaluador: el script usa puertos configurables (`SMOKE_PORT`, …) y falla con un mensaje claro.
- **Un `.env` sin `POSTGRES_PASSWORD`/`JWT_SECRET`:** `compose.yaml` los exige (`:?`). El humo inyecta valores efímeros propios y no lee los secretos del usuario.
- **Docker Desktop vs Engine:** se usa `--wait`, que existe desde Compose v2.1. El equipo tiene v5.7.

## 6. Preguntas abiertas
1. **Cambios de Docker y Compose:** `AGENTS.md` exige confirmación. ¿Apruebo los cambios de §3.1 y §3.2?
   - `Dockerfile`: `prisma generate` en dev y la etapa `migrator`;
   - `compose.yaml`: el servicio `migrate` y `NODE_ENV` fijo;
   - `compose.override.yaml`: `healthcheck` en dev;
   - un archivo nuevo, `compose.smoke.yaml`.

   *Recomendado: sí. Sin ellos, `docker:dev` no arranca y `docker:prod` no tiene tablas, así que el ticket no se puede cumplir.*
2. **Migraciones en producción:**
   - (a) un servicio *one-shot* `migrate` antes de `api`;
   - (b) que `api` migre al arrancar;
   - (c) solo documentar un comando manual.

   *Recomendado: (a). Es el patrón estándar: el runtime no necesita privilegios DDL ni el CLI, no hay carreras entre réplicas y `api` nunca arranca contra un esquema viejo. (b) mezcla responsabilidades, y (c) deja el despliegue incompleto.*
3. **Seed para el humo de producción:**
   - (a) el `migrate` **del humo** siembra con `NODE_ENV=test` en un proyecto efímero;
   - (b) `login` y `/mine` solo se prueban en dev, y en prod solo `/health`, `/ready` y `/recipes`.

   *Recomendado: (a). Así las 5 pruebas de humo del ticket corren sobre la imagen endurecida real. En un despliegue productivo real el seed sigue bloqueado.*
4. **Comando del humo:** ¿agrego `"docker:smoke": "node scripts/smoke/compose-smoke.mjs"` a `package.json`? `AGENTS.md` exige confirmación para modificarlo. *Recomendado: sí, para que el evaluador lo encuentre junto a `docker:dev`/`docker:prod`. La alternativa es documentar `node scripts/smoke/compose-smoke.mjs`.*

## Auditorías finales del TP (3 subagentes en paralelo, solo lectura: sin Docker, sin base y sin tests)
- **security-auditor:** **sin VETO para la entrega**. No hay hallazgos críticos ni altos; la pasada OWASP API Top 10 sobre `src/` sale sin hallazgos nuevos.
  - Media, un `docker compose up` sin `-f` carga el override de dev → **resuelta**: advertencia en el `README`, junto a `docker:prod`.
  - Bajas → **resueltas**: el humo quita las variables `COMPOSE_*`, usa `DEV_IMAGE_TAG` para no pisar `recetaria/api:dev` y borra sus imágenes `:smoke`.
  - Bajas **asumidas y documentadas** en `docs/sad.md` §7:
    - el `migrate` con superusuario y la imagen `migrator` con devDependencies, a resolver con el rol DDL dedicado en Beta;
    - secretos como variables de entorno (`secrets:`/`*_FILE` en Beta).
- **qa-tester:** **apto para la entrega**, sin hallazgos altos ni medios.
  - Bajas → **resueltas**:
    - detección de `restarting`, `dead` y reinicios;
    - timeout por comando;
    - limpieza ante `SIGINT`/`SIGTERM`;
    - `down -v` previo;
    - verificación real de Debian Bookworm, Node 24 y PostgreSQL 15;
    - una prueba de `.env.example` más estricta, contrastada con los `${VAR:?}` de `compose.yaml`;
    - `docs/testing.md` incluye `Users` y `Health`.
  - Informativa: no hay CI; la salida del humo y de `npm test` queda en el PR.
- **code-reviewer:** **listo para entregar**. La pasada global sobre `src/` no tiene hallazgos.
  - Media, `compose.smoke.yaml` sin nombre propio → **resuelta** (`name: recetaria-smoke`).
  - Bajas y nits → **resueltos**:
    - el comentario en `.env.example`;
    - los riesgos de `migrate` en `docs/sad.md`;
    - los códigos `304`, `412`, `428` y `429` en el PRD;
    - el plan alineado con lo implementado.
