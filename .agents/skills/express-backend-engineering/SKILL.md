---
name: express-backend-engineering
description: >-
  Construye, revisa y opera el servidor Express 5 + TypeScript de Recetaria API —
  orden estricto de middlewares en buildApp (x-powered-by, trust proxy, query
  parser simple, requestId/logger, CORS, /health, body parsers con límite,
  routers /api/v1, notFound y errorHandler de 4 argumentos), particularidades de
  Express 5 (req.query getter → req.valid, req.body undefined, sintaxis de rutas,
  res.headersSent), mapeo de entity.parse.failed/entity.too.large a JSend,
  testing Express con Supertest y migración Express 4 → 5. Usar al configurar
  src/app.ts, middlewares de Express, validación de requests o handlers de error.
---

# Ingeniería Backend con Express 5 (TypeScript) — Recetaria API

**Baseline:** Express 5.3+ sobre Node.js LTS y TypeScript estricto, respetando la arquitectura en 4 capas de `AGENTS.md` (`*.router.ts` → `*.controller.ts` → `*.service.ts` → `*.repository.ts`) y el contrato **JSend extendido** (`docs/sad.md`, `ADR-0004`).

**Prioridades:** Seguridad → Correctitud → Disponibilidad → Observabilidad → Mantenibilidad → Rendimiento.

*(Delegaciones: capas y composition root → `layered-architecture-ts`; tipado estricto TS 7, `Result`/`AppError`, Big-O y complejidad → [typescript-engineering](../typescript-engineering/SKILL.md); estrategia QA basada en riesgo P0, sensibilidad y Vitest/Supertest → [critical-path-testing](../critical-path-testing/SKILL.md); semántica HTTP, BOPLA, cursor, ETag e Idempotency-Key → `api-engineering-ts`; JWT, Bcrypt, RBAC, ownership y CSRF → `identity-sessions-authorization`; runtime Node, event loop, async/await, Piscina y ALS → `node-backend-engineering`; `env.ts`, npm/pnpm y graceful shutdown → `js-project-configuration`; alta paso a paso de rutas → `nuevo-endpoint`.)*

## 1. Reglas duras de Express 5 en Recetaria (MUST)

- **Hardening base de Express:** declarar siempre `app.disable("x-powered-by")`, `app.set("query parser", "simple")` y `app.set("trust proxy", hops)` con el número exacto de proxies (nunca `true` a ciegas).
- **Orden estricto de middlewares en `buildApp()` (`src/app.ts`, sin `listen()`):**
  1. Correlación (`requestContextMiddleware`) y logging (`loggerMiddleware`, redactando `authorization`).
  2. Seguridad de cabeceras y `cors` (allowlist explícita en producción; `helmet` cuando se incorpore en evolución).
  3. Salud (`GET /health`) **antes** de parsers, autenticación y rate limit.
  4. Parsers con límite (`express.json({ limit: "100kb" })`, `express.urlencoded({ extended: false, limit: "100kb" })`).
  5. Routers de negocio (`/api/v1/auth`, `/api/v1/recipes`).
  6. `notFoundMiddleware` (`404` JSend) y un único `errorHandlerMiddleware` de **4 parámetros** `(err, req, res, next)` al final.
- **`req.query` inmutable y `req.body` opcional (Express 5):** nunca reasignar `req.query = ...` (es un getter y lanza `TypeError`) ni asumir `req.body` como `{}` (es `undefined` sin parser). Validar `req.body ?? {}`, `req.query` y `req.params` con Zod y guardar el resultado tipado en `req.valid`.
- **Controladores y errores:** cada método de `*.controller.ts` envuelve la llamada al servicio en `try/catch` (Requisito 9 del TP) y delega errores con `next(err)` al `errorHandlerMiddleware` único (chequeando `if (res.headersSent) return next(err);`).
- **Mapeo de errores de body-parser en JSend:** `entity.parse.failed` → `400 Bad Request`; `entity.too.large` → `413 Payload Too Large`; `ZodError` → `400 Bad Request` con `errors`; `500` sin *stack trace* en producción.

## 2. Particularidades críticas de Express 5

| Cambio en Express 5 | Impacto en Recetaria |
|---|---|
| `req.query` es getter de solo lectura | Guardar query validada en `req.valid.query` |
| `req.body` es `undefined` si no corre parser | Pasar `req.body ?? {}` al schema Zod |
| `query parser` default `"simple"` | Sin objetos anidados en query params (`?status=APPROVED&difficulty=EASY`) |
| Promesas rechazadas llegan solas al error handler | No instalar `express-async-errors`; `try/catch` en controladores + `next(err)` mantiene compatibilidad total |
| Rutas con comodines/opcionales | Usar `/*splat` o `{/*splat}` y `{/:id}` (nunca `*`, `:id?` ni regex en strings de ruta) |
| `res.status(code)` estricto | Códigos inválidos lanzan error; usar solo códigos HTTP válidos |

## 3. Baseline MVP vs. Evolución en Express (Fase Alfa/Beta)

- **MVP actual (`package.json`):** `express`, `cors`, `zod`, `loggerMiddleware` propio, `GET /health`. No agregar librerías sin confirmación humana (`AGENTS.md`).
- **Evolución en producción:** incorporar `helmet` (headers de seguridad), `pino-http` (logs JSON), `express-rate-limit` + `rate-limit-redis` (nunca store en memoria con múltiples réplicas), `BullMQ` (colas y crons distribuidos en lugar de `setInterval`), `OpenTelemetry` cargado con `--import` antes de Express y separación `/health/live` + `/health/ready`.

## 4. Patrones Express 5 y Migración (Referencia bajo demanda)

Consultá [`references/express5-patterns.md`](./references/express5-patterns.md) cuando necesites:
- Implementación de `validateMiddleware` tipado con `req.valid` (*module augmentation* para Express 5).
- `buildApp()` con orden exacto de middlewares, `loggerMiddleware`, `notFoundMiddleware` y `errorHandlerMiddleware` JSend (`res.headersSent`, `entity.parse.failed`, `entity.too.large`).
- Tests de integración con Supertest contra `buildApp()` (`400` JSON mal formado, `404` ruta inexistente, `413`, `500` redactado).
- Tabla de migración Express 4 → 5 y notas de `helmet` / `rate-limit` / `BullMQ` / `OpenTelemetry`.

## 5. Antipatrones específicos de Express

- Reasignar `req.query` o asumir `req.body` siempre definido en Express 5.
- Definir `errorHandlerMiddleware` sin los 4 parámetros `(err, req, res, next)` o ubicarlo antes de los routers.
- Omitir `if (res.headersSent) return next(err)` o llamar a `app.listen()` dentro de `src/app.ts`.
- Usar `trust proxy: true` sin conocer la topología de red o `cors` con `*` y `credentials: true`.
- Usar `express-rate-limit` con store en memoria en despliegues multi-réplica o servir compresión/estáticos desde Node en producción (delegar al proxy/CDN).

## 6. Definition of Done

La capa Express 5 de Recetaria está lista solo cuando cumple todo:
- [ ] `src/app.ts` aplica el orden de middlewares de §1 sin `listen()`, con `x-powered-by` deshabilitado y límites de body.
- [ ] `validateMiddleware` valida `body ?? {}`, `query` y `params` guardando en `req.valid` sin mutar `req.query`.
- [ ] `notFoundMiddleware` y `errorHandlerMiddleware` (4 parámetros + `res.headersSent`) formatean el 100 % de los errores en JSend (incluidos `entity.parse.failed` y `entity.too.large`).
- [ ] Tests Supertest sobre `buildApp()` verifican rutas válidas, `400`, `401`, `403`, `404`, `409`, `413` y `500` sin fuga de *stack trace*.
