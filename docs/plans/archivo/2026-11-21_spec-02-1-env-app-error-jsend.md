# Plan: [Spec 02.1] Validación fail-fast de entorno (Zod 4), jerarquía AppError y contrato JSend (#10)

Fecha: 2026-11-21 · Rama: `feat/10-env-app-error-jsend` · Parent: `#2` · Estado: **Completado y archivado (2026-11-21)**

## Objetivo
Proveer los cimientos transversales de configuración y contrato de respuestas HTTP de Recetaria API alineados con `ADR-0004` y `ADR-0006`:
1. Validación estricta *fail fast* de variables de entorno con Zod 4 (`NODE_ENV`, `PORT`, `DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`) expuesta como objeto inmutable y estrictamente tipado (`src/config/env.ts`).
2. Jerarquía tipada de errores operacionales `AppError` compatible con `erasableSyntaxOnly` y `exactOptionalPropertyTypes` junto con subclases semánticas para `400`, `401`, `403`, `404`, `409` y `503` (`src/shared/errors/app-error.ts`).
3. Tipos y helpers puros para emitir sobres **JSend extendido** de éxito y error (`src/shared/http/jsend.ts`), respaldados por pruebas unitarias en Vitest junto al código fuente (`src/**/*.test.ts`).

*(Nota de alcance: la fábrica `buildApp`, `validateMiddleware`, `loggerMiddleware` y `errorHandlerMiddleware` pertenecen a `#11` `[Spec 02.2]`, y las sondas `/health`, `/health/ready` y `src/server.ts` a `#12` `[Spec 02.3]`. `src/infrastructure/database/prisma.ts` se mantiene independiente de `JWT_SECRET` en esta spec para no acoplar los scripts y tests aislados de persistencia.)*

## Decisiones aprobadas
1. **Validación fail-fast de entorno con Zod 4 (`src/config/env.ts`):**
   - Sin efectos laterales al importar el módulo: exportar `parseEnv(source: Readonly<Record<string, string | undefined>>): Env` (pura, retorna `Object.freeze(data)`) y `loadEnv(options?: Readonly<{ loadDotenv?: boolean }>): Env` (carga variables locales con `dotenv.config({ quiet: true })` cuando `loadDotenv !== false` y delega en `parseEnv(process.env)`).
   - **`NODE_ENV`:** `z.enum(["development", "test", "production"]).default("development")`, rechazando *fail fast* cualquier valor fuera del conjunto permitido (incluido `""`).
   - **`PORT`:** validación estricta de entero en rango `[1..65_535]` evitando falsos positivos de `z.coerce.number()` (`""` → `0`, `"0x10"`, `"1e3"`), aceptando cadenas decimales limpias (`^\d+$`) con default `3000` cuando se omite.
   - **`DATABASE_URL`:** `z.url({ protocol: /^postgres(ql)?$/ })` con validación adicional de `hostname` y nombre de base en `pathname` no vacíos.
   - **`JWT_SECRET`:** `z.string().min(32)` verificando también longitud sin espacios (`value.replace(/\s+/g, "").length >= 32` para HS256, sin mutar los bytes del secreto).
   - **`JWT_EXPIRES_IN`:** default `"1d"`, validado con unidad explícita en segundos o superior (`^[1-9]\d{0,5}(s|m|h|d|w|y)$`, máx. 100 chars respecto a `ms`) y estrechado con *type predicate* (cero `as`) al tipo `JwtExpiresIn` compatible con `@types/jsonwebtoken`.
   - Mensajes de error agregados que listan **únicamente nombres de variables y motivos**, sin exponer jamás valores de secretos ni credenciales.

2. **Jerarquía `AppError` (`src/shared/errors/app-error.ts`):**
   - 100 % compatible con `erasableSyntaxOnly: true` y `exactOptionalPropertyTypes: true` (sin *parameter properties*, sin `enum`, `this.name = new.target.name`, preservación de `cause`).
   - Campos: `readonly statusCode: HttpErrorStatusCode`, `readonly isOperational: boolean` (default `true`), `readonly errors?: readonly ErrorDetail[]` (omitida cuando no se provee y congelada con `Object.freeze` cuando existe).
   - Valida que `statusCode` pertenezca al rango `[400..599]`.
   - Subclases semánticas: `BadRequestError` (`400`), `UnauthorizedError` (`401`), `ForbiddenError` (`403`), `NotFoundError` (`404`), `ConflictError` (`409`) y `ServiceUnavailableError` (`503`).

3. **Contrato JSend extendido (`src/shared/http/jsend.ts`) — Opción recomendada (array `errors` siempre presente):**
   - Tipos discriminados estrictos:
     - `JSendSuccessResponse<TData>`: `{ readonly success: true; readonly statusCode: 200 | 201; readonly message: string; readonly data: TData }`.
     - `JSendErrorResponse`: `{ readonly success: false; readonly statusCode: HttpErrorStatusCode; readonly message: string; readonly errors: readonly ErrorDetail[] }`.
     - `JSendResponse<TData> = JSendSuccessResponse<TData> | JSendErrorResponse`.
   - En respuestas de error sin errores de campo (`401`, `404`, `500`, `503`), incluir siempre `errors: []` (congelado) para mantener un sobre uniforme de 4 claves conforme a `docs/sad.md` y al criterio de aceptación de `#10`.
   - Builders puros (`buildSuccessResponse`, `buildErrorResponse`) y emisores HTTP delgados tipados con `import type { Response } from "express"` (`sendSuccess`, `sendError`).

4. **Pruebas unitarias junto al fuente (`src/**/*.test.ts`) y configuración `tsconfig`:**
   - Ubicar los tests unitarios junto a cada módulo fuente (`src/config/env.test.ts`, `src/shared/errors/app-error.test.ts`, `src/shared/http/jsend.test.ts`) según `docs/testing.md` y `vitest.config.ts`.
   - Excluir `"src/**/*.test.ts"` en `tsconfig.json` para que `npm run build` (`tsc`) no emita archivos de test dentro de `dist/`, y declarar explícitamente `"exclude": ["node_modules", "dist"]` en `tsconfig.test.json` para que `npm run typecheck:test` siga verificando todos los tests en modo estricto.

## Fases

### Fase 1 — Rama y registro del plan · Estado: Hecha
- [x] Crear la rama `feat/10-env-app-error-jsend` desde `main` actualizado (`4c1ff6a`).
- [x] Registrar este plan en `docs/plans/2026-11-21_spec-02-1-env-app-error-jsend.md`.

Criterio de salida: rama creada y plan persistido. **Detenerse para revisión humana.**

---

### Fase 2 — Implementación de `env.ts`, `app-error.ts`, `jsend.ts` y ajuste de `tsconfig` · Estado: Hecha
- [x] Actualizar `"exclude"` en `tsconfig.json` (`["node_modules", "dist", "src/**/*.test.ts"]`) y en `tsconfig.test.json` (`["node_modules", "dist"]`).
- [x] Crear `src/config/env.ts` (`parseEnv`, `loadEnv`, `Env`, `NodeEnv`, `JwtExpiresIn`).
- [x] Crear `src/shared/errors/app-error.ts` (`ErrorDetail`, `HttpErrorStatusCode`, `AppError` y las 6 subclases `400`, `401`, `403`, `404`, `409`, `503`).
- [x] Crear `src/shared/http/jsend.ts` (`HttpSuccessStatusCode`, `JSendSuccessResponse`, `JSendErrorResponse`, `JSendResponse`, `buildSuccessResponse`, `buildErrorResponse`, `sendSuccess`, `sendError`).
- [x] Verificar compilación estricta y artefactos limpios:
  ```bash
  npm run typecheck && npm run typecheck:test && npm run build
  ```

Criterio de salida: 0 errores de tipos/build en ESM estricto y `dist/` sin archivos `.test.*`. **Detenerse para revisión humana.**

---

### Fase 3 — Pruebas unitarias en Vitest · Estado: Hecha
- [x] Crear `src/config/env.test.ts` (patrón AAA, `0 any`): defaults `NODE_ENV="development"`, `PORT=3000`, `JWT_EXPIRES_IN="1d"`; inmutabilidad (`Object.isFrozen`); casos válidos (`postgres://`, `postgresql://`, puertos límite `1`/`65535`, duraciones `s`/`m`/`h`/`d`/`w`/`y`); rechazos *fail fast* (faltantes, vacíos, protocolos distintos, secret `< 32` o con espacios internos, `NODE_ENV` inválido, `PORT` fuera de rango/no entero/notación científica/hex, `JWT_EXPIRES_IN` inválido o sin unidad); control de seguridad verificando que el error nunca filtra secretos ni credenciales; pruebas de `loadEnv` (`loadDotenv: false` y rama por defecto).
- [x] Crear `src/shared/errors/app-error.test.ts`: prototipo e `instanceof`, `name`, `statusCode`, `message`, `isOperational` por defecto `true` y override `false`, preservación de `cause`, omisión vs presencia e inmutabilidad de `errors`, rechazo de `statusCode` fuera de `[400..599]`, y verificación de las 6 subclases (`400`, `401`, `403`, `404`, `409`, `503`).
- [x] Crear `src/shared/http/jsend.test.ts`: sobres exactos de éxito (`200` por defecto y `201`) y de error (`400`, `401`, `403`, `404`, `409`, `413`, `500`, `503`), `errors: []` por defecto e inmutabilidad al pasar lista `{ field, message }`, compatibilidad con `AppError.errors`, y verificación de `sendSuccess` / `sendError` sobre respuesta tipada.
- [x] Verificar con `npm run typecheck && npm run typecheck:test && npm run build && npm test` y chequeo estático (`0 any`, `0 .only`/`.skip`).

Criterio de salida: suite completa en verde (unitarias nuevas + suites de integración de Spec 01) bajo `sequence.shuffle: true`. **Detenerse para revisión humana.**

---

### Fase 4 — Documentación, auditorías obligatorias y cierre · Estado: Hecha
- [x] Actualizar `CHANGELOG.md` (`## [Sin publicar]`) y archivar este plan en `docs/plans/archivo/2026-11-21_spec-02-1-env-app-error-jsend.md`.
- [x] Ejecutar revisiones obligatorias de `GEMINI.md` en paralelo: `@code-reviewer`, `@security-auditor` y `@qa-tester`.
- [x] Resolver eventuales hallazgos y ejecutar verificación final (`npm run typecheck && npm run typecheck:test && npm run build && npm test` y `git status --short`).

Criterio de salida: auditorías aprobadas y suite completa en verde, listo para `commit` y PR cuando el usuario lo indique.

---

## Regla de parada
Ejecutar **una fase por vez** y detenerse al finalizar cada fase para revisión humana antes de continuar con la siguiente.
