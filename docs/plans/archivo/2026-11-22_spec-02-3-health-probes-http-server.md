# Plan: [Spec 02.3] Sondas de salud (GET /health y GET /health/ready) y servidor HTTP con apagado ordenado (#12)

Fecha: 2026-11-22 · Rama: `feat/12-health-probes-http-server` · Parent: `#2` · Estado: **Completado y archivado (2026-11-22)**

## Objetivo
Incorporar las sondas operativas separadas de liveness (`GET /health`) y readiness (`GET /health/ready`) y el punto de entrada ejecutable del servidor HTTP (`src/server.ts` → `dist/server.js`) alineados con `ADR-0006`, `Dockerfile` y `compose.yaml`:
1. **`GET /health` (liveness puro):** montada antes de parsers y autenticación sin consultar PostgreSQL; devuelve `200 OK` en sobre JSend extendido incluso si la base de datos falla, alimentando el `HEALTHCHECK` de Docker sin reinicios en cascada.
2. **`GET /health/ready` (readiness contra PostgreSQL):** montada antes de parsers y autenticación; ejecuta `SELECT 1` mediante el cliente Prisma inyectado con timeout acotado (`2000ms`), devolviendo `200 OK` JSend o `503 Service Unavailable` JSend redactado ante fallo o timeout.
3. **Servidor HTTP (`src/server.ts` → `dist/server.js`):** carga configuración validada (`loadEnv()`), enlaza el cliente Prisma singleton (`getDatabase(env.DATABASE_URL)`) con `buildApp`, arranca `http.Server` aplicando timeouts defensivos (`keepAliveTimeout: 65s`, `headersTimeout: 66s`, `requestTimeout: 30s`) y ejecuta apagado ordenado idempotente ante `SIGTERM`, `SIGINT`, `uncaughtException` y `unhandledRejection` dentro de `stop_grace_period: 30s`.

## Decisiones aprobadas
1. **Sondas de salud (`src/shared/http/health.router.ts`) montadas en `src/app.ts`:**
   - Contrato segregado (`ReadinessDatabaseClient` con `$queryRaw`), compatible directamente con `AppPrismaClient` (`createDatabase`/`getDatabase`) y stubs de prueba sin casts `any`.
   - Cabecera `Cache-Control: no-store` en ambas sondas; montadas en `buildApp` después de `cors` y antes de `express.json` / `express.urlencoded`.
   - `DEFAULT_READINESS_TIMEOUT_MS = 2_000` (menor a `--timeout=3s` de `Dockerfile`), sobreescribible vía `BuildAppOptions.readinessTimeoutMs`.
   - Coalescencia *single-flight* (`inFlightQuery`) sobre `SELECT 1` para evitar agotamiento de `pg.Pool` ante ráfagas concurrentes bajo degradación de PostgreSQL.
   - Carrera `Promise.race` con timer `.unref()`, `clearTimeout` en `finally` y limpieza en `.then(clearInFlight, clearInFlight)` sin `UnhandledPromiseRejection`.
   - Ante ausencia de `prisma`, error de PostgreSQL o expiración de timeout, lanza `ServiceUnavailableError("Base de datos no disponible")` (`503` JSend vía `errorHandlerMiddleware`, sin filtrar errores SQL).
2. **Retrocompatibilidad de `buildApp` y `getDatabase`:**
   - `BuildAppOptions` agrega `prisma?: ReadinessDatabaseClient | undefined` y `readinessTimeoutMs?: number | undefined` sin romper llamadas existentes a `buildApp()`.
   - `getDatabase(connectionString?: string)` en `src/infrastructure/database/prisma.ts` acepta opcionalmente la URL ya validada por `loadEnv()`, manteniendo intacto `getDatabase()` sin argumentos para scripts y pruebas.
3. **Servidor HTTP y apagado ordenado (`src/server.ts` → `dist/server.js`):**
   - Contrato segregado `ServerDatabase` (`prisma: ReadinessDatabaseClient` + `disconnect()`) en `StartServerOptions.database`.
   - `applyServerTimeouts(server)`: `keepAliveTimeout = 65_000`, `headersTimeout = 66_000` (`> keepAliveTimeout`) y `requestTimeout = 30_000`.
   - `SHUTDOWN_TIMEOUT_MS = 10_000` (< `stop_grace_period: 30s` en `compose.yaml`) con timer `.unref()`, `clearTimeout` en `finally` y `closeAllConnections()` en corte forzado.
   - `createDrainingHttpServer` + `createGracefulShutdown`: guarda idempotente (`shutdownPromise`), propagación de `hasFatalError` aunque ocurra durante un drenaje ya iniciado (`exit(1)`), drenaje de peticiones HTTP/1.1 `keep-alive` en curso (`Connection: close` cuando `!res.headersSent` + `closeIdleConnections()` al finalizar respuestas activas), limpieza de singleton vía `disconnect()` cuando usa `getDatabase()`, y salida `0`/`1`.
   - Registra `SIGTERM`, `SIGINT`, `uncaughtException` y `unhandledRejection`, más manejo de error de arranque (`server.on("error")`), ejecutando `startServer()` únicamente bajo guarda `isMainModule()` (sin efectos laterales al importarse en tests).

## Fases

### Fase 1 — Rama y registro del plan · Estado: Hecha
- [x] Crear la rama `feat/12-health-probes-http-server` desde `main` actualizado (`dc835ec`).
- [x] Registrar este plan en `docs/plans/2026-11-22_spec-02-3-health-probes-http-server.md`.

Criterio de salida: rama creada y plan persistido. **Detenerse para revisión humana.**

---

### Fase 2 — Implementación de sondas de salud, wiring en `buildApp` y `src/server.ts` · Estado: Hecha
- [x] Actualizar `getDatabase(connectionString?: string)` en `src/infrastructure/database/prisma.ts`.
- [x] Crear `src/shared/http/health.router.ts` (`GET /health` y `GET /health/ready`).
- [x] Montar `createHealthRouter` en `src/app.ts` antes de parsers y autenticación (`BuildAppOptions.prisma` y `readinessTimeoutMs`).
- [x] Crear `src/server.ts` (`applyServerTimeouts`, `createGracefulShutdown`, `startServer` e `isMainModule()`).
- [x] Verificar compilación estricta, build ESM emitiendo `dist/server.js` y `0 any`:
  ```bash
  npm run typecheck && npm run typecheck:test && npm run build
  ```

Criterio de salida: 0 errores de tipos/build y `dist/server.js` emitido limpiamente sin `.test.*`. **Detenerse para revisión humana.**

---

### Fase 3 — Pruebas unitarias y de integración HTTP contra PostgreSQL 15 · Estado: Hecha
- [x] Crear `src/shared/http/health.router.test.ts` (liveness sin DB, readiness sin `prisma` `503`, timeout acotado sin `UnhandledPromiseRejection`, redacción de fallos, `Cache-Control: no-store` y ejecución previa a body parsers).
- [x] Crear `src/server.test.ts` (`applyServerTimeouts`, `createGracefulShutdown` idempotente, código `1` ante error/timeout y drenaje HTTP real en curso sobre puerto efímero).
- [x] Crear `tests/integration/http/health.test.ts` (Supertest + PostgreSQL 15 en Docker vía `getDatabase()` + `disconnect()`): `GET /health` `200` con DB fallando, `GET /health/ready` `200` con PostgreSQL activo y `503` cuando falla o expira timeout.
- [x] Verificar con `npm run typecheck && npm run typecheck:test && npm run build && npm test` y chequeos estáticos (`CLEAN_DIST`, `0 any`, `0 .only`/`.skip`).

Criterio de salida: suite completa en verde (unitarias + integración HTTP + integración DB) bajo `sequence.shuffle: true`. **Detenerse para revisión humana.**

---

### Fase 4 — Documentación, auditorías obligatorias y cierre · Estado: Hecha
- [x] Actualizar `CHANGELOG.md` (`## [Sin publicar]`) y archivar este plan en `docs/plans/archivo/2026-11-22_spec-02-3-health-probes-http-server.md`.
- [x] Ejecutar en paralelo las revisiones obligatorias de `GEMINI.md`: `@code-reviewer`, `@security-auditor` y `@qa-tester`, resolver los hallazgos dentro del alcance (coalescencia *single-flight*, propagación de error fatal en drenaje, `disconnect()` de singleton y ampliación de cobertura a 36 pruebas) y obtener `APROBADO` en las re-auditorías.
- [x] Ejecutar verificación final (`npm run typecheck && npm run typecheck:test && npm run build && npm test` — 14 archivos / 226 pruebas — y `git status --short`).

Criterio de salida: auditorías aprobadas y suite completa en verde, listo para `commit` y PR cuando el usuario lo indique.

---

## Regla de parada
Ejecutar **una fase por vez** y detenerse al finalizar cada fase para revisión humana antes de continuar con la siguiente.
