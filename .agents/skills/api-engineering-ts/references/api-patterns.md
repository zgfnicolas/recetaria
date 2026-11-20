# Patrones de Ingeniería de APIs (TypeScript / Express 5 / PostgreSQL) — Recetaria API

Snippets ejecutables para endurecer el MVP y escalar la API en fases posteriores.

---

## 1. BOPLA (`z.strictObject`), Límites y Timeouts de `http.Server` (MVP)

### Validación estricta de entrada (Zod 4)
Rechaza campos inesperados (`authorId`, `status`, `reviewedById`, `isActive`) con `400 Bad Request`:

```typescript
import { z } from "zod";

export const updateRecipeStrictSchema = z
  .strictObject({
    title: z.string().min(3).max(150).optional(),
    description: z.string().min(10).optional(),
    difficulty: z.enum(["EASY", "MEDIUM", "HARD", "EXPERT"]).optional(),
    prepTimeMinutes: z.number().int().optional(),
    tags: z.array(z.string().max(50)).max(20).optional(),
    coverImageUrl: z.url({ protocol: /^https$/ }).optional(),
    videoUrl: z.url({ protocol: /^https$/ }).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Debe enviar al menos un campo para actualizar",
  });
```

### Límites de payload, paginación acotada y timeouts de servidor
```typescript
// En src/app.ts
app.use(express.json({ limit: "100kb" }));

/**
 * Devuelve el límite efectivo de resultados acotado al máximo del servidor (OWASP API4).
 */
export const resolvePageLimit = (requested: number | undefined, max = 100, fallback = 25): number =>
  Math.min(Math.max(requested ?? fallback, 1), max);

// En src/server.ts (evita 502 detrás de proxies/LB con idle timeout de 60 s y mitiga slowloris)
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 30_000;
```

---

## 2. Paginación por Cursor Opaco (Evolución)

Orden total `(createdAt, id)` soportado por índice compuesto; pide `limit + 1` para determinar `nextCursor`:

```typescript
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { ValidationError } from "../../shared/errors/app-error";

const CursorSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  id: z.string().uuid(),
});
type CursorPayload = z.infer<typeof CursorSchema>;

export const encodeCursor = (p: CursorPayload): string =>
  Buffer.from(JSON.stringify(p), "utf8").toString("base64url");

export function decodeCursor(raw: string): CursorPayload {
  try {
    const json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return CursorSchema.parse(json);
  } catch {
    throw new ValidationError("Cursor de paginación inválido");
  }
}

export async function listRecipesPage(prisma: PrismaClient, limit: number, cursorRaw?: string) {
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : undefined;
  const rows = await prisma.recipe.findMany({
    where: cursor
      ? {
          OR: [
            { createdAt: { lt: new Date(cursor.createdAt) } },
            { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
          ],
        }
      : undefined,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  const nextCursor =
    hasMore && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null;

  return { items, nextCursor };
}
```

---

## 3. Concurrencia Optimista (`ETag` / `If-Match`) e `Idempotency-Key` (Evolución)

### Concurrencia optimista con `ETag`
- En `GET /api/v1/recipes/:id`: devolver `ETag: "<updatedAtIsoOrVersion>"` y `Cache-Control: private, no-cache`.
- En mutaciones críticas concurrentes: exigir `If-Match` (`428 Precondition Required` si falta) y ejecutar `UPDATE ... WHERE id = $1 AND version = $2`; si afecta `0` filas, devolver `412 Precondition Failed`.

### `Idempotency-Key` atómica en PostgreSQL
Para `POST` con efectos reintentables (evita duplicación ante reintentos de red):

```sql
CREATE TABLE idempotency_keys (
  actor_id     UUID NOT NULL,
  operation    TEXT NOT NULL,
  key          TEXT NOT NULL,
  fingerprint  BYTEA NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')),
  http_status  INT,
  response     JSONB,
  locked_until TIMESTAMPTZ NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (actor_id, operation, key)
);
```

```typescript
// Reserva atómica dentro de prisma.$transaction: solo 1 de 50 requests concurrentes gana la clave
const reserved = await tx.$queryRaw<{ key: string }[]>`
  INSERT INTO idempotency_keys (actor_id, operation, key, fingerprint, status, locked_until, expires_at)
  VALUES (${actorId}::uuid, 'recipes.create', ${key}, ${fingerprint}, 'in_progress', now() + interval '30 seconds', now() + interval '24 hours')
  ON CONFLICT (actor_id, operation, key) DO NOTHING
  RETURNING key
`;
// reserved.length === 0 -> si completada con misma huella: replay (+ Idempotent-Replayed: true);
// si en curso: 409 + Retry-After; si otra huella: 400/422 (IDEMPOTENCY_KEY_REUSED).
```

Test de concurrencia (Vitest + Supertest):
```typescript
it("50 POST concurrentes con la misma Idempotency-Key crean un único recurso", async () => {
  const key = crypto.randomUUID();
  const results = await Promise.all(
    Array.from({ length: 50 }, () =>
      request(app).post("/api/v1/recipes").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key).send(payload),
    ),
  );
  const createdIds = new Set(results.filter((r) => r.status === 201).map((r) => r.body.data.id));
  expect(createdIds.size).toBe(1);
  expect(results.every((r) => [201, 409].includes(r.status))).toBe(true);
});
```

---

## 4. Cliente HTTP Resiliente (Node 22+ `fetch` nativo)

Para futuras llamadas salientes (ej. generación de URLs o integraciones externas):

```typescript
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const retryDelayMs = (attempt: number, retryAfter: string | null): number => {
  if (retryAfter && !Number.isNaN(Number(retryAfter))) {
    return Math.min(Number(retryAfter) * 1000, 10_000);
  }
  return Math.random() * Math.min(100 * 2 ** attempt, 2_000); // full jitter
};

export async function callUpstream(
  url: string,
  init: RequestInit & { idempotent: boolean; deadlineMs: number },
): Promise<Response> {
  const maxAttempts = init.idempotent ? 3 : 1; // nunca reintentar escrituras sin idempotencia
  for (let attempt = 1; ; attempt++) {
    const remaining = init.deadlineMs - Date.now();
    if (remaining <= 0) throw new Error("UPSTREAM_TIMEOUT");
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(Math.min(2_000, remaining)) });
      if (!RETRYABLE_STATUSES.has(res.status) || attempt >= maxAttempts) return res;
      await sleep(retryDelayMs(attempt, res.headers.get("retry-after")));
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      await sleep(retryDelayMs(attempt, null));
    }
  }
}
```

---

## 5. Gobierno OpenAPI 3.1 y Deprecación en CI (Evolución)

Cuando se incorpore `contracts/openapi.yaml` versionado en el repo:
```yaml
# Extracto para .github/workflows/ci.yml
- run: spectral lint contracts/openapi.yaml
- run: docker run --rm -v $PWD:/w tufin/oasdiff breaking /w/base/openapi.yaml /w/contracts/openapi.yaml --fail-on ERR
```

Headers estándar al deprecar una ruta sin romper consumidores:
```http
Deprecation: @1798761600
Sunset: Wed, 30 Jun 2027 00:00:00 GMT
Link: <https://github.com/zgfnicolas/recetaria/blob/main/docs/sad.md>; rel="deprecation"
```
