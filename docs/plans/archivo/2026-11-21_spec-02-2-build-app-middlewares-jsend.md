# Plan: [Spec 02.2] Fábrica buildApp (Express 5), loggerMiddleware, validateMiddleware (req.valid) y errorHandler JSend (#11)

Fecha: 2026-11-21 · Rama: `feat/11-build-app-middlewares-jsend` · Parent: `#2` · Estado: **Completado y archivado (2026-11-21)**

## Objetivo
Construir la fábrica de aplicación Express 5 (`buildApp`, sin `listen()`) y toda la cadena de middlewares transversales de Recetaria API alineados con `ADR-0004` y `ADR-0006`, estableciendo la costura principal de integración HTTP con Supertest (`buildApp`) que reutilizarán `Spec 02.3`, `Auth` y `Recipes`:
1. `loggerMiddleware` seguro en consola (`[ISO_DATE] METHOD /url STATUS DURATIONms`) sin fuga de cabeceras ni cuerpos sensibles.
2. `validateMiddleware` genérico con Zod 4 (`z.strictObject`, prevención BOPLA) compatible con Express 5 (`req.body ?? {}`, sin reasignar `req.query`) escribiendo en `req.valid`.
3. `notFoundMiddleware` (`404` JSend) y `errorHandlerMiddleware` de 4 argumentos traduciendo de forma centralizada `entity.parse.failed`, `entity.too.large`, `ZodError`, `AppError`, códigos Prisma (`P2002`, `P2025`) y errores inesperados (`500` redactado) al contrato **JSend extendido**.
4. `buildApp` con endurecimiento HTTP (`x-powered-by` deshabilitado, `query parser` `"simple"`, `trust proxy` explícito, CORS, parsers limitados a `100kb` y montaje inyectable bajo `/api/v1`).

*(Nota de alcance: las sondas de salud `GET /health` y `GET /health/ready` y el entrypoint `src/server.ts` pertenecen a `#12` `[Spec 02.3]`; `authMiddleware` y `rbacMiddleware` a `Spec 03`.)*

## Decisiones aprobadas
1. **`loggerMiddleware` (`src/middlewares/logger.middleware.ts`):**
   - Exponer `createLoggerMiddleware(writeLine?: (line: string) => void): RequestHandler` y el export `loggerMiddleware`.
   - Suscribir a `res.once("finish", ...)` midiendo latencia con `performance.now()` para emitir `[ISO_DATE] METHOD /url STATUS DURATIONms`.
   - Nunca imprimir headers (`Authorization`, `Cookie`) ni bodies; sanear caracteres de control C0/C1 y separadores Unicode (`\r`, `\n`, `\t`, `\u0085`, `\u2028`, `\u2029`) contra inyección de logs y redactar valores en query strings para parámetros sensibles (`token`, `access_token`, `refresh_token`, `password`, `passwd`, `secret`, `authorization`, `apikey`, `api_key`, `key`).
2. **`validateMiddleware` (`src/middlewares/validate.middleware.ts`):**
   - Aumentar `Express.Request` con `declare global { namespace Express { interface Request { valid?: ValidatedRequestData; } } }` (100 % borrable bajo `erasableSyntaxOnly: true`) y exportar `ValidatedRequest<TBody, TQuery, TParams>` para controladores posteriores.
   - Aceptar `{ body?, query?, params? }` como esquemas Zod 4 (`ValidationSchemas`), parsear `req.body ?? {}` (Express 5), nunca mutar ni reasignar el getter `req.query`, y actualizar `req.valid` preservando secciones previas sin asignar `undefined` explícito (`exactOptionalPropertyTypes: true`).
   - Exportar el helper reutilizable `formatZodIssues(issues, section?)`, expandiendo cada clave rechazada de `unrecognized_keys` (`z.strictObject` / BOPLA) como `{ field: "<ruta.clave>", message: "Campo no permitido" }`, delegando en `next(new BadRequestError("Error de validación", { errors }))`.
3. **`notFoundMiddleware` (`src/middlewares/not-found.middleware.ts`):**
   - Delegar `next(new NotFoundError(\`Ruta no encontrada: \${req.method} \${req.path}\`))` usando `req.path` (sin reflejar query strings en el cuerpo de error).
4. **`errorHandlerMiddleware` (`src/middlewares/error-handler.middleware.ts`):**
   - Exponer `createErrorHandlerMiddleware(logError?: (message: string, err: unknown) => void): ErrorRequestHandler` y `errorHandlerMiddleware` con firma estricta de **4 parámetros** `(err, _req, res, next)`.
   - Orden de precedencia: `res.headersSent` → `entity.parse.failed` / `request.aborted` (`400`) → `entity.too.large` / `parameters.too.many` (`413`) → `ZodError` (`400` con `formatZodIssues`) → `AppError` (`isOperational === true && statusCode !== 500` → `err.statusCode` + `err.errors`; resto → log + `500` redactado) → códigos conocidos Prisma (`P2002` → `409`, `P2025` → `404` sin exponer metadatos) → fallback `500` genérico redactado sin *stack traces*, consultas SQL ni `err.message`.
5. **`buildApp` (`src/app.ts`):**
   - Firma `buildApp(options?: BuildAppOptions): Express` sin `listen()`, aceptando `apiRouters?: readonly MountedRouter[]` (`{ path: string; router: Router }`, exigiendo prefijo `"/"`), `cors?: CorsOptions`, `trustProxy` (default `false`), `onLog` y `onError`.
   - CORS por defecto (con arreglos frescos por instancia): `{ origin: "*", methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"], credentials: false }`.
   - Orden estricto en Express 5: `app.disable("x-powered-by")`, `query parser: "simple"`, `trust proxy`, `loggerMiddleware`, `cors`, *(espacio reservado antes de parsers para `/health` y `/health/ready` en `#12`)*, `express.json({ limit: "100kb" })`, `express.urlencoded({ extended: false, limit: "100kb" })`, montaje de `apiRouters` bajo `/api/v1`, `notFoundMiddleware` y `errorHandlerMiddleware`.

## Fases

### Fase 1 — Rama y registro del plan · Estado: Hecha
- [x] Crear la rama `feat/11-build-app-middlewares-jsend` desde `main` actualizado (`e925370`).
- [x] Registrar este plan en `docs/plans/2026-11-21_spec-02-2-build-app-middlewares-jsend.md`.

Criterio de salida: rama creada y plan persistido. **Detenerse para revisión humana.**

---

### Fase 2 — Implementación de middlewares y fábrica `buildApp` · Estado: Hecha
- [x] Crear `src/middlewares/logger.middleware.ts`.
- [x] Crear `src/middlewares/validate.middleware.ts` (`req.valid` y `formatZodIssues`).
- [x] Crear `src/middlewares/not-found.middleware.ts`.
- [x] Crear `src/middlewares/error-handler.middleware.ts`.
- [x] Crear `src/app.ts` (`buildApp`).
- [x] Verificar compilación estricta, build ESM limpio en `dist/` y ausencia de `any`:
  ```bash
  npm run typecheck && npm run typecheck:test && npm run build
  ```

Criterio de salida: 0 errores de tipos/build en ESM estricto y `dist/` limpio. **Detenerse para revisión humana.**

---

### Fase 3 — Pruebas unitarias de middlewares e integración HTTP con Supertest · Estado: Hecha
- [x] Crear `src/middlewares/logger.middleware.test.ts` (formato exacto, control chars C0/C1/Unicode, fallback `req.url`, redacción de query keys sensibles y ausencia de headers/bodies: 7 pruebas).
- [x] Crear `src/middlewares/validate.middleware.test.ts` (`formatZodIssues`, BOPLA `unrecognized_keys`, `req.valid`, preservación de getter `req.query`, `req.body ?? {}` y omisión de `undefined` explícito: 9 pruebas).
- [x] Crear `src/middlewares/not-found.middleware.test.ts` (delegación `NotFoundError` 404 sin reflejar query strings: 1 prueba).
- [x] Crear `src/middlewares/error-handler.middleware.test.ts` (`length === 4`, `res.headersSent`, `AppError` operacional vs `isOperational=false`/`500`, `request.aborted`, `parameters.too.many`, `ZodError`, `P2002`, `P2025` y fallback `500` redactado: 16 pruebas).
- [x] Crear `tests/integration/http/app.test.ts` con Supertest sobre `buildApp` cubriendo `200`, `201`, `400` (JSON malformado, params/query/body Zod y BOPLA), `401`/`403`/`404`/`409`/`503` (síncrono y `async`), `404` en ruta inexistente sin `X-Powered-By`, `409` (`P2002`), `404` (`P2025`), `413` (`json` y `urlencoded` `> 100kb`), `500` redactado sin fuga de *stack trace*, `buildApp()` sin argumentos y CORS/logging en errores (17 pruebas).
- [x] Verificar con `npm run typecheck && npm run typecheck:test && npm run build && npm test` y chequeo estático (`CLEAN_DIST`, `0 any`, `0 .only`/`.skip`: 11 archivos, 190/190 tests en verde).

Criterio de salida: suite completa en verde (unitarias + integración HTTP + integración DB) bajo `sequence.shuffle: true`. **Detenerse para revisión humana.**

---

### Fase 4 — Documentación, auditorías obligatorias y cierre · Estado: Hecha
- [x] Actualizar `CHANGELOG.md` (`## [Sin publicar]`) y archivar este plan en `docs/plans/archivo/2026-11-21_spec-02-2-build-app-middlewares-jsend.md`.
- [x] Ejecutar en paralelo las revisiones obligatorias de `GEMINI.md`: `@code-reviewer`, `@security-auditor` y `@qa-tester`.
- [x] Resolver eventuales hallazgos y ejecutar verificación final (`npm run typecheck && npm run typecheck:test && npm run build && npm test` y `git status --short`).

Criterio de salida: auditorías aprobadas y suite completa en verde, listo para `commit` y PR cuando el usuario lo indique.

---

## Regla de parada
Ejecutar **una fase por vez** y detenerse al finalizar cada fase para revisión humana antes de continuar con la siguiente.
