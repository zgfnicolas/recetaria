# Patrones de Express 5 + TypeScript — Recetaria API

Snippets listos para usar en `src/middlewares/` y `src/app.ts`, más guía de migración Express 4 → 5 y extensiones post-MVP.

---

## 1. `validateMiddleware` compatible con Express 5 (`src/middlewares/validate.middleware.ts`)

En Express 5 `req.query` es un *getter* (no reasignable) y `req.body` puede ser `undefined`. Guardar los datos validados en `req.valid`:

```typescript
import type { RequestHandler } from "express";
import type { z } from "zod";

declare global {
  namespace Express {
    interface Request {
      valid?: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };
    }
  }
}

type ValidationSchemas<
  B extends z.ZodType | undefined = undefined,
  Q extends z.ZodType | undefined = undefined,
  P extends z.ZodType | undefined = undefined,
> = Readonly<{
  body?: B;
  query?: Q;
  params?: P;
}>;

export function validateMiddleware<
  B extends z.ZodType | undefined = undefined,
  Q extends z.ZodType | undefined = undefined,
  P extends z.ZodType | undefined = undefined,
>(schemas: ValidationSchemas<B, Q, P>): RequestHandler {
  return (req, _res, next) => {
    try {
      req.valid = {
        body: schemas.body ? schemas.body.parse(req.body ?? {}) : req.valid?.body,
        query: schemas.query ? schemas.query.parse(req.query) : req.valid?.query,
        params: schemas.params ? schemas.params.parse(req.params) : req.valid?.params,
      };
      next();
    } catch (err: unknown) {
      next(err); // ZodError llega al errorHandlerMiddleware → 400 JSend
    }
  };
}
```

---

## 2. `loggerMiddleware`, `notFoundMiddleware` y `errorHandlerMiddleware` (JSend)

### `src/middlewares/logger.middleware.ts` (Extra +2,5 pts del TP)
Registra método, URL, status y duración en consola sin imprimir headers `Authorization` ni bodies con contraseñas:

```typescript
import type { RequestHandler } from "express";

export const loggerMiddleware: RequestHandler = (req, res, next) => {
  const start = performance.now();
  res.once("finish", () => {
    const durationMs = (performance.now() - start).toFixed(1);
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${durationMs}ms)`);
  });
  next();
};
```

### `src/middlewares/not-found.middleware.ts` y `error-handler.middleware.ts`
```typescript
import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { AppError } from "../shared/errors/app-error";

export const notFoundMiddleware: RequestHandler = (req, _res, next) => {
  next(new AppError(404, `Ruta no encontrada: ${req.method} ${req.path}`));
};

function hasErrorType(err: unknown): err is { type: string } {
  return typeof err === "object" && err !== null && "type" in err && typeof err.type === "string";
}

function hasPrismaCode(err: unknown): err is { code: string } {
  return typeof err === "object" && err !== null && "code" in err && typeof err.code === "string";
}

export const errorHandlerMiddleware: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err); // delega al handler interno de Express si la respuesta ya empezó
    return;
  }

  if (err instanceof ZodError) {
    const errors = err.issues.map((i) => ({ field: i.path.join("."), message: i.message }));
    res.status(400).json({ success: false, statusCode: 400, message: "Error de validación", errors });
    return;
  }

  if (hasErrorType(err) && err.type === "entity.parse.failed") {
    res.status(400).json({ success: false, statusCode: 400, message: "JSON inválido en el cuerpo de la solicitud" });
    return;
  }

  if (hasErrorType(err) && err.type === "entity.too.large") {
    res.status(413).json({ success: false, statusCode: 413, message: "El cuerpo excede el tamaño máximo permitido" });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      statusCode: err.statusCode,
      message: err.message,
      ...(err.errors ? { errors: err.errors } : {}),
    });
    return;
  }

  if (hasPrismaCode(err) && err.code === "P2002") {
    res.status(409).json({ success: false, statusCode: 409, message: "Conflicto: el recurso ya existe" });
    return;
  }

  if (hasPrismaCode(err) && err.code === "P2025") {
    res.status(404).json({ success: false, statusCode: 404, message: "Recurso no encontrado" });
    return;
  }

  console.error("[UNHANDLED_ERROR]", err);
  res.status(500).json({ success: false, statusCode: 500, message: "Error interno del servidor" });
};
```

---

## 3. Orden canónico en `src/app.ts`

```typescript
import express, { type Express } from "express";
import cors from "cors";
import type { AppContainer } from "./bootstrap/container";
import { loggerMiddleware } from "./middlewares/logger.middleware";
import { notFoundMiddleware } from "./middlewares/not-found.middleware";
import { errorHandlerMiddleware } from "./middlewares/error-handler.middleware";

export function buildApp(container: AppContainer, trustProxyHops = 0): Express {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", trustProxyHops);
  app.set("query parser", "simple");

  // 1. Logging y correlación
  app.use(loggerMiddleware);

  // 2. CORS
  app.use(cors());

  // 3. Health (antes de parsers y auth)
  app.get("/health", async (_req, res, next) => {
    try {
      await container.prisma.$queryRaw`SELECT 1`;
      res.status(200).json({ success: true, statusCode: 200, message: "OK", data: { status: "healthy" } });
    } catch (err: unknown) {
      next(err);
    }
  });

  // 4. Parsers con límites
  app.use(express.json({ limit: "100kb" }));
  app.use(express.urlencoded({ extended: false, limit: "100kb" }));

  // 5. Routers de negocio
  app.use("/api/v1/auth", container.routers.auth);
  app.use("/api/v1/recipes", container.routers.recipes);

  // 6. 404 y handler único de errores (siempre al final)
  app.use(notFoundMiddleware);
  app.use(errorHandlerMiddleware);

  return app;
}
```

---

## 4. Tests HTTP de borde en Express 5 (Supertest)

```typescript
it("devuelve 400 JSend ante JSON mal formado", async () => {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .set("Content-Type", "application/json")
    .send('{"email": "roto"');
  expect(res.status).toBe(400);
  expect(res.body.success).toBe(false);
});

it("devuelve 404 JSend ante ruta inexistente", async () => {
  const res = await request(app).get("/api/v1/no-existe");
  expect(res.status).toBe(404);
  expect(res.body.success).toBe(false);
});
```

---

## 5. Tabla de Migración Express 4 → Express 5 y Extensiones Post-MVP

| Express 4 | Express 5 |
|---|---|
| `express-async-errors` / wrappers | Nativo (promesas rechazadas llegan al error handler) |
| `/recipes/:id?` | `/recipes{/:id}` |
| `*` y `/files/*` | `/*splat` y `/files/*path` (`{/*splat}` si es opcional) |
| Regex embebida en string de ruta | No soportado: usar `RegExp` o rutas separadas |
| `req.query` reasignable | Getter de solo lectura → guardar en `req.valid` |
| `req.body` = `{}` sin parser | `undefined` → pasar `req.body ?? {}` |
| `query parser` `extended` | `simple` por defecto |
| `app.del`, `req.param()`, `res.send(status)` | Eliminados (`app.delete`, `req.params/query/body`, `res.sendStatus`) |

### Extensiones opcionales para Fase Alfa / Beta (requieren confirmar dependencias en `package.json`)
- **Cabeceras de seguridad:** `app.use(helmet())` inmediatamente antes de `cors`.
- **Rate limiting distribuido:** `express-rate-limit` respaldado por `rate-limit-redis` (`keyGenerator` usando `req.user?.id ?? req.ip` con `trust proxy` exacto; `10` intentos / 15 min en `/api/v1/auth/login`).
- **Colas y crons distribuidos:** `BullMQ` (`upsertJobScheduler` en Redis + proceso worker separado) en lugar de `setInterval` replicado.
- **OpenTelemetry:** cargar `instrumentation.ts` con `node --import ./dist/instrumentation.js ./dist/server.js` **antes** de importar Express.
