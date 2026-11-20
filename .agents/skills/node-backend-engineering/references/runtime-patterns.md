# Patrones de Runtime Node.js (Express 5 / TypeScript) — Recetaria API

Snippets ejecutables de referencia para asincronía segura, concurrencia acotada, cancelación, streams, contexto y métricas del runtime.

---

## 1. Reglas de lint para promesas (`typescript-eslint` con información de tipos)

Configurar con `projectService: true` en `eslint.config.js`:

```js
export const asyncSafetyRules = {
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": "error",
  "@typescript-eslint/await-thenable": "error",
  "@typescript-eslint/require-await": "error",
  "@typescript-eslint/return-await": ["error", "in-try-catch"],
  "@typescript-eslint/promise-function-async": "error",
  "@typescript-eslint/only-throw-error": "error",
  "@typescript-eslint/prefer-promise-reject-errors": "error",
  "@typescript-eslint/use-unknown-in-catch-callback-variable": "error",
  "no-async-promise-executor": "error",
  "no-promise-executor-return": "error",
};
```

---

## 2. Concurrencia acotada (`mapLimit`) y cancelación por cliente en Express 5

```typescript
// src/shared/async/map-limit.ts
export async function mapLimit<T, R>(
  items: Iterable<T>,
  limit: number,
  fn: (item: T, signal: AbortSignal) => Promise<R>,
  outer?: AbortSignal,
): Promise<R[]> {
  const stop = new AbortController();
  const signal = outer ? AbortSignal.any([outer, stop.signal]) : stop.signal;
  const it = items[Symbol.iterator]();
  const results: R[] = [];
  let next = 0;

  const worker = async (): Promise<void> => {
    for (let r = it.next(); !r.done; r = it.next()) {
      signal.throwIfAborted();
      const idx = next++;
      try {
        results[idx] = await fn(r.value, signal);
      } catch (err: unknown) {
        stop.abort(err); // cancela el resto al primer error
        throw err;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, limit) }, worker));
  return results;
}
```

```typescript
// src/shared/http/client-signal.ts — cancela trabajo caro si el cliente corta la conexión
import type { Response } from "express";

export function createClientSignal(res: Response, timeoutMs = 10_000): AbortSignal {
  const ac = new AbortController();
  const onClose = (): void => {
    if (!res.writableFinished) ac.abort(new Error("CLIENT_DISCONNECTED"));
  };
  res.once("close", onClose);
  res.once("finish", () => res.off("close", onClose));
  return AbortSignal.any([ac.signal, AbortSignal.timeout(timeoutMs)]);
}
```

---

## 3. Contexto por request con `AsyncLocalStorage.run()` (Express 5)

Solo para correlación de observabilidad (`requestId`); `actor` (`{ id, role }`) viaja explícitamente como parámetro al servicio:

```typescript
// src/shared/observability/request-context.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

export type RequestContext = Readonly<{ requestId: string }>;
export const requestContext = new AsyncLocalStorage<RequestContext>();

export const requestContextMiddleware: RequestHandler = (req, res, next) => {
  const headerId = req.header("x-request-id");
  const requestId = headerId && headerId.length <= 128 ? headerId : randomUUID();
  res.setHeader("x-request-id", requestId);
  requestContext.run({ requestId }, next); // siempre run(), nunca enterWith()
};

export const getRequestId = (): string | undefined => requestContext.getStore()?.requestId;
```

---

## 4. Métricas del Event Loop y Heap (`node:perf_hooks`)

```typescript
// src/shared/observability/runtime-metrics.ts
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

export function startRuntimeMetrics(
  onSample: (sample: { delayP99Ms: number; elu: number; heapUsedBytes: number }) => void,
  intervalMs = 10_000,
): () => void {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let lastElu = performance.eventLoopUtilization();

  const timer = setInterval(() => {
    const now = performance.eventLoopUtilization();
    const elu = performance.eventLoopUtilization(now, lastElu).utilization;
    lastElu = now;
    onSample({
      delayP99Ms: Number((delay.percentile(99) / 1e6).toFixed(2)),
      elu: Number(elu.toFixed(3)),
      heapUsedBytes: process.memoryUsage().heapUsed,
    });
    delay.reset();
  }, intervalMs);

  timer.unref(); // no impide el graceful shutdown del proceso
  return () => {
    clearInterval(timer);
    delay.disable();
  };
}
```

---

## 5. Streams con Backpressure, `safePath` y Worker Pool Acotado (Evolución Alfa/Beta)

### Stream con límite estricto de bytes (evita cargar uploads en RAM)
```typescript
import { pipeline } from "node:stream/promises";
import { Transform, type Readable, type Writable } from "node:stream";
import { AppError } from "../errors/app-error";

export async function pipeWithByteLimit(
  source: Readable,
  dest: Writable,
  maxBytes: number,
  signal: AbortSignal,
): Promise<number> {
  let seen = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      cb(seen > maxBytes ? new AppError(413, `Payload excede ${maxBytes} bytes`) : null, chunk);
    },
  });
  await pipeline(source, limiter, dest, { signal });
  return seen;
}
```

### Validación de rutas contra *path traversal*
```typescript
import { resolve, sep } from "node:path";
import { ForbiddenError } from "../errors/app-error";

export function resolveSafePath(rootDir: string, relativePath: string): string {
  const root = resolve(rootDir);
  const full = resolve(root, relativePath);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new ForbiddenError("Ruta de archivo fuera del directorio permitido");
  }
  return full;
}
```

### Pool de Worker Threads acotado para CPU pesada
Si en fases futuras se procesan imágenes o archivos grandes en Node, crear **un solo pool por proceso** con cuota de contenedor (`cpus: 1.0` en `compose.yaml`) y cola acotada (`maxQueue`):
```typescript
// import { Piscina } from "piscina";
// const pool = new Piscina({
//   filename: new URL("./workers/process.js", import.meta.url).href,
//   maxThreads: env.CPU_WORKERS, // desde env, nunca os.availableParallelism() sin cota
//   maxQueue: 200,               // si se llena -> rechazar con 503 + Retry-After
//   idleTimeout: 30_000,
// });
```
