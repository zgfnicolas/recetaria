---
name: node-backend-engineering
description: >-
  Construye y opera el runtime Node.js de Recetaria API (Express 5, TypeScript
  estricto, Docker) — clasificación I/O vs CPU y libuv Worker Pool (bcrypt, fs,
  dns), modelo asíncrono sin errores (sin promesas flotantes, return await en
  try/catch, catch unknown, concurrencia acotada, AbortSignal), streams con
  pipeline y backpressure, memoria acotada al contenedor (512m), contexto con
  AsyncLocalStorage.run(), métricas de event-loop delay/ELU, seguridad del runtime
  (safePath, spawn, Permission Model) y lint de promesas. Usar al escribir lógica
  async compleja, paralelizar I/O, manejar streams/archivos, diagnosticar bloqueos
  del event loop o revisar código TypeScript asíncrono.
---

# Ingeniería de Runtime Node.js — Recetaria API (Express 5 / TypeScript)

**Prioridades:** Correctitud → Seguridad → Resiliencia → Observabilidad → Rendimiento → Escalabilidad → Simplicidad.

*(Delegaciones: arquitectura en 4 capas y composition root → `layered-architecture-ts`; tipado estricto TS 7, `Result`/`AppError`, Big-O y límites de complejidad → [typescript-engineering](../typescript-engineering/SKILL.md); runtime LTS, npm/pnpm, `env.ts` y graceful shutdown → `js-project-configuration`; semántica HTTP, JSend, timeouts de servidor y `fetch` resiliente → `api-engineering-ts`; JWT/Bcrypt/RBAC → `identity-sessions-authorization`; Docker multi-stage y PID 1 → `docker-deploy` / `docker-production-containers`.)*

## 1. Reglas duras (MUST)

- **Cero operaciones bloqueantes en requests:** prohibido `fs.*Sync`, `bcrypt.*Sync`, `crypto.*Sync`, `zlib.*Sync`, `execSync`, parsing de JSON de megabytes o regex con *backtracking* catastrófico (ReDoS) sobre input del usuario (`title`, `tags`, búsquedas).
- **Cero promesas flotantes:** toda promesa se espera (`await`), se devuelve o maneja explícitamente su rechazo (verificado por `typescript-eslint`). Prohibido `forEach(async ...)` y `new Promise(async ...)`.
- **`return await` dentro de `try/catch`:** en los controladores de Recetaria (que envuelven cada método en `try/catch`) y servicios, usar siempre `return await fn()` para que el bloque `catch` capture rechazos; nunca `catch (e: any)` — estrechar `catch (e: unknown)`.
- **Concurrencia acotada:** toda colección de promesas dependiente del input usa concurrencia fija (`mapLimit`), nunca `Promise.all` sin cota sobre listas arbitrarias.
- **Cancelación propagada:** pasar `AbortSignal` a operaciones largas o llamadas remotas; usar `setTimeout` de `node:timers/promises` con `{ signal }` (nunca `Promise.race` con timers que quedan colgados).
- **Recursos en memoria acotados:** toda caché, cola, `Map`/`Set` o lista de listeners ligada al tráfico lleva tamaño máximo y TTL (`LRUCache` + limpieza en `finally`); `MaxListenersExceededWarning` es un bug.
- **Contexto con `AsyncLocalStorage.run()`:** usar `run()` en el middleware de entrada para correlacionar `requestId`; nunca `enterWith()`.
- **Errores fatales terminan el proceso:** `uncaughtException` y `unhandledRejection` (modo default `throw`) loguean y apagan ordenadamente para que el orquestador reinicie; nunca "loguear y seguir".

## 2. Modelo de ejecución y clasificación I/O vs. CPU

| Tipo de trabajo | Ejemplos en Recetaria | Estrategia |
|---|---|---|
| **I/O de red (SO)** | Queries PostgreSQL vía Prisma, llamadas HTTP salientes | `async/await` + pools + timeouts + `AbortSignal` |
| **Worker Pool de `libuv` (4 hilos default)** | `bcrypt.hash` / `bcrypt.compare`, `fs/promises`, `dns.lookup`, `zlib` async | Usar siempre la versión async; ajustar `UV_THREADPOOL_SIZE` solo si se mide saturación |
| **CPU liviana (< 2 ms)** | Validación Zod, generación de `slug`, mapeo JSend | Directamente en el event loop |
| **CPU pesada (futuro Alfa/Beta)** | Procesamiento de imágenes, compresión masiva, exports grandes | Pool de `Worker Threads` acotado (`Piscina` con `maxQueue` → `503`) o job en cola |

## 3. Disciplina asíncrona (Promesas, `async/await` e Iteradores)

- **Orden y microtareas:** evitar cadenas recursivas de promesas o `process.nextTick` que hambreen el I/O; no escribir lógica dependiente del orden entre `nextTick`, promesas y timers.
- **Promesas paralelas seguras:** nunca lanzar dos promesas y esperarlas secuencialmente (`const a = f(); const b = g(); await a; await b;`), porque si `b` rechaza mientras se espera `a` genera un rechazo no manejado; usar `Promise.all([f(), g()])` o `Promise.allSettled(...)` con *type guard*.
- **Expresividad de errores y callbacks:** rechazar siempre con instancias de `Error` (`new AppError(..., { cause })`), nunca strings u objetos planos. En Express 5 los rechazos de handlers `async` se propagan automáticamente a `errorHandlerMiddleware`, complementando el `try/catch` de controladores.
- **Volúmenes sin cota:** usar `AsyncGenerator<T>` (`for await`) y `stream/promises.pipeline` para exportaciones/archivos con backpressure y liberación en `try/finally` (o `await using`).

## 4. Memoria, Observabilidad y Seguridad del Runtime

- **Memoria en Docker (`compose.yaml` fija `mem_limit: 512m` y `cpus: 1.0`):** fijar `--max-old-space-size=384` (~75 % del límite del contenedor) si se ajusta heap; configurar `maxThreads` de worker pools desde variables de entorno según la cuota del contenedor, nunca ciegamente desde `os.availableParallelism()`.
- **Métricas del runtime (`node:perf_hooks`):** monitorear *event-loop delay* (alerta p99 > `100 ms`), *ELU* (alerta > `0.8` sostenido), `heapUsed` (> `85 %` del límite) y saturación del pool de DB.
- **Seguridad del proceso:** ejecutar subprocesos solo con `spawn(bin, args, { shell: false })`; validar rutas de disco con `safePath` contra *path traversal*; evitar *prototype pollution* (`Object.create(null)` para diccionarios dinámicos, sin *deep merge* de input sin validar); evaluar `--permission` (Permission Model) en staging como defensa en profundidad junto a `USER node` y `read_only: true`.

## 5. Patrones y Tooling (Referencia bajo demanda)

Consultá [`references/runtime-patterns.md`](./references/runtime-patterns.md) cuando necesites:
- Reglas obligatorias de `typescript-eslint` para promesas y `async/await`.
- `mapLimit` con cancelación `AbortController` y helper `clientSignal(res)` para Express 5.
- Middleware `requestContextMiddleware` con `AsyncLocalStorage.run()`.
- Colector de métricas de event loop (`monitorEventLoopDelay` + `eventLoopUtilization`).
- Streams con límite de bytes (`stream/promises.pipeline`), `safePath` y pool de workers `Piscina`.

## 6. Antipatrones a evitar

- Usar `bcrypt.hashSync`/`compareSync` o `fs.readFileSync` dentro de una ruta HTTP.
- `items.forEach(async ...)` o `EventEmitter.on` con función `async` sin captura de rechazo.
- `return repo.findById(id)` sin `await` dentro de un `try/catch`.
- `Promise.race` con `setTimeout` sin `AbortSignal`, o no abortar trabajo caro cuando el cliente cierra la conexión.
- `new Worker()` por request, `Map` global sin TTL/tamaño máximo, `.pipe()` sin manejo de errores o `AsyncLocalStorage.enterWith()`.
- Registrar un handler de `unhandledRejection` que solo loguea y deja el proceso en estado corrupto.

## 7. Definition of Done

El código de runtime Node.js está listo solo cuando cumple todo:
- [ ] Ninguna operación síncrona bloqueante ni regex vulnerable a ReDoS en rutas HTTP.
- [ ] Cero promesas flotantes, `return await` en `try/catch`, `catch (e: unknown)` y `AbortSignal` propagado en I/O largo.
- [ ] Concurrencia, cachés en RAM y colas de workers tienen límites explícitos.
- [ ] `AsyncLocalStorage.run()` correlaciona logs sin esconder `actor`/permisos; fatales terminan el proceso ordenadamente.
- [ ] Tests verifican cancelación/timeout, concurrencia acotada y limpieza de recursos en fallos.
