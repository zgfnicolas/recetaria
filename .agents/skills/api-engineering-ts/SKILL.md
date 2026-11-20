---
name: api-engineering-ts
description: >-
  Diseña, implementa, revisa y opera APIs REST en TypeScript y Express 5 para
  Recetaria API — semántica HTTP estricta sobre contrato JSend, prevención de
  BOPLA/mass assignment con Zod 4 (z.strictObject), límites de body y paginación
  (OWASP API4), timeouts de http.Server y event loop sin bloqueos, salud (/health),
  versionado/deprecación (RFC 9745/8594) y patrones de evolución (OpenAPI gates,
  paginación por cursor, ETag/If-Match, Idempotency-Key, cliente HTTP resiliente y
  observabilidad RED). Usar al diseñar endpoints, revisar contratos HTTP, agregar
  paginación, configurar límites/timeouts o auditar resiliencia de la API.
---

# Ingeniería de APIs REST (TypeScript / Express 5) — Recetaria API

**Prioridades:** Correctitud → Seguridad → Contrato → Resiliencia → Observabilidad → Rendimiento → Simplicidad.

**Estilo por defecto:** REST/HTTP + JSON sobre Express 5 y TypeScript estricto. Adoptar cualquier otro estilo o patrón condicional (outbox, caché distribuida, breakers, colas) exige un ADR corto en `docs/adr/` con problema medido, alternativa más simple descartada y cómo se prueba.

*(Delegaciones: capas y composition root → `layered-architecture-ts`; JWT/Bcrypt/RBAC/BOLA → `identity-sessions-authorization`; runtime/supply chain/shutdown → `js-project-configuration`; alta paso a paso de rutas → `nuevo-endpoint`; contenedores → `docker-deploy`.)*

## 1. Reglas duras (MUST)

- **Semántica HTTP real sobre JSend:** `GET` seguro y sin efectos; `PUT` y `DELETE` idempotentes; `POST` crea recursos (`201`). **Nunca** responder HTTP `200` con `"success": false`.
- **Contrato único de respuesta (JSend extendido, `ADR-0004`):** toda respuesta sigue `{ success, statusCode, message, data | errors }` (`docs/sad.md`), sin exponer *stack traces*, SQL ni rutas internas en producción.
- **Prevención de BOPLA / *mass assignment* (OWASP API3):** validar `body`, `query` y `params` con allowlist usando **`z.strictObject(...)`** en Zod 4 (rechaza campos inyectados como `authorId`, `status`, `reviewedById`, `isActive`) y proyectar explícitamente las respuestas (nunca devolver el modelo ORM crudo con `passwordHash`).
- **Límites en todo (OWASP API4):** tope explícito de payload (`express.json({ limit: "100kb" })`), `limit` máximo de paginación acotado en servidor, filtros y ordenamiento solo por allowlist de Zod (nunca interpolados), y rate limiting (`429 + Retry-After`) al exponer a producción.
- **Event loop libre:** prohibido `*Sync` pesado, parsing de payloads sin cota o CPU intensiva en handlers; concurrencia acotada para lotes y streams (`stream/promises.pipeline`) para archivos/exports.
- **Llamadas remotas con presupuesto:** todo `fetch` saliente lleva `AbortSignal.timeout` acotado; reintentos solo en fallos transitorios (`429`, `502`, `503`, `504`) con backoff + *full jitter* y **nunca** en escrituras sin clave de idempotencia.
- **Observabilidad segura:** logs estructurados con `requestId`/`traceId`, ruta como plantilla (`/api/v1/recipes/:id`, nunca URL con UUID como etiqueta de métrica) y redacción de `authorization`, `password` y secretos.

## 2. Semántica HTTP y Versionado (`/api/v1`)

| Situación | Código HTTP | Contrato en Recetaria |
|---|---|---|
| Consulta, actualización o borrado exitoso | `200 OK` | JSend `success: true` con `data` |
| Creación de recurso (`POST /register`, `POST /recipes`) | `201 Created` | JSend `success: true` (+ header `Location` recomendado) |
| Sin contenido (operaciones sin cuerpo) | `204 No Content` | Cuerpo vacío |
| Validación Zod fallida, JSON mal formado o dominio de entrada | `400 Bad Request` | JSend `success: false` con array `errors` |
| Sin token válido o credenciales erróneas | `401 Unauthorized` | JSend `success: false` (+ `WWW-Authenticate: Bearer`) |
| Rol insuficiente, no autor o auto-aprobación (`RN-02`–`RN-05`) | `403 Forbidden` | JSend `success: false` |
| Recurso inexistente (`P2025`) | `404 Not Found` | JSend `success: false` |
| Unicidad (`P2002`), receta ya `APPROVED` o idempotencia en curso | `409 Conflict` | JSend `success: false` |
| Precondición faltante / `If-Match` desactualizado *(evolución)* | `428` / `412` | JSend `success: false` |
| Cuota / rate limit excedido *(evolución)* | `429 Too Many Requests` | JSend `success: false` + header `Retry-After` |
| Error inesperado o falla de upstream | `500` / `502` / `503` / `504` | JSend `success: false` sin detalle interno |

- **Convenciones:** rutas en plural `kebab-case` bajo `/api/v1/`, JSON en `camelCase`, fechas RFC 3339 en UTC, UUIDv4/v7.
- **Evolución compatible:** preferir agregar campos/filtros opcionales antes de abrir `/v2`. Si un endpoint se retira en el futuro, anunciar con headers `Deprecation` (RFC 9745), `Sunset` (RFC 8594) y `Link`.

## 3. Seguridad de Borde, Runtime y Salud

- **SSRF (OWASP API7):** para campos URL (`coverImageUrl`, `videoUrl` y futuros webhooks/importadores), exigir esquema `https:` en producción y, si el servidor descarga la URL, resolver DNS y bloquear rangos privados/link-local/metadata (`169.254.169.254`) sin seguir redirects ciegos.
- **CORS y configuración (OWASP API8):** allowlist explícita de orígenes en producción (nunca `*` con credenciales); sin endpoints de debug expuestos.
- **Timeouts de `http.Server`:** configurar `keepAliveTimeout` mayor al idle timeout del proxy/LB (ej. `65_000 ms`), `headersTimeout` mayor a `keepAliveTimeout` (`66_000 ms`) y `requestTimeout` (`30_000 ms`) para cortar requests lentas.
- **Health checks (`ADR-0006`):** `GET /health` es liveness liviano **sin** consultar PostgreSQL (usado por el `HEALTHCHECK` del `Dockerfile` para evitar reinicios en cascada); `GET /health/ready` es readiness verificando PostgreSQL (`SELECT 1`), devolviendo `200` o `503`.

## 4. Patrones de Evolución y Testing (Referencia bajo demanda)

Consultá [`references/api-patterns.md`](./references/api-patterns.md) cuando necesites implementar o revisar:
- `z.strictObject` contra BOPLA, `express.json({ limit })`, `resolvePageLimit` y timeouts de `http.Server`.
- Paginación por cursor compuesto `(createdAt, id)` en Prisma/PostgreSQL.
- Concurrencia optimista (`ETag` / `If-Match` → `412`) e `Idempotency-Key` atómica en PostgreSQL (`INSERT ... ON CONFLICT DO NOTHING`) con test de 50 `POST` concurrentes.
- Cliente `fetch` resiliente con `AbortSignal.timeout`, *full jitter* y `Retry-After`.
- Gobierno OpenAPI 3.1 en CI (`spectral`, `oasdiff`, `schemathesis`) y headers `Deprecation`/`Sunset`.

## 5. Antipatrones a evitar

- Responder `200 OK` con `"success": false` o devolver siempre `200`/`500`.
- Esquemas de entrada sin `z.strictObject` que permiten sobrescribir `authorId`, `status` o `role` en mutaciones.
- `limit` sin tope máximo en listados, `express.json()` sin `limit` explícito o `sort` interpolado en SQL.
- Llamar `fetch` externo sin timeout, reintentar `POST` sin clave de idempotencia o usar un `Map` en memoria para idempotencia.
- `await` secuencial sobre operaciones independientes o `Promise.all` sin cota sobre miles de elementos.
- `keepAliveTimeout` menor que el idle timeout del LB o `/live` consultando la base de datos.
- Métricas con UUIDs o URLs concretas como etiquetas (explosión de cardinalidad) o logs con headers `Authorization`.

## 6. Definition of Done

Una entrega o revisión de API está terminada solo cuando cumple todo:
- [ ] Rutas, métodos y códigos HTTP respetan la tabla de §2 bajo el sobre JSend sin fugas internas.
- [ ] Todos los esquemas de mutación usan `z.strictObject` (BOPLA cubierto con tests negativos) y proyectan salidas sin campos sensibles.
- [ ] `express.json({ limit })`, `resolvePageLimit` y `GET /health` están configurados y probados.
- [ ] La colección `docs/thunder-client-collection.json` (y OpenAPI si existe) refleja el contrato real y los tests de integración cubren `200`/`201`/`400`/`401`/`403`/`404`/`409`.
- [ ] Ninguna llamada remota carece de timeout y el event loop permanece libre de operaciones bloqueantes.
