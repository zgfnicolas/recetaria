# Patrones de Persistencia Prisma 7 + PostgreSQL para Recetaria API

Referencia ejecutable de [orm-persistence-js-ts](../SKILL.md) alineada a las 3 entidades activas de Recetaria API (`users`, `recipes`, `audit_logs` en [database_schema_init.sql](../../../../database_schema_init.sql) y [data_model.md](../../../../docs/data_model.md)) y a la arquitectura en 4 capas ([layered-architecture-ts](../../layered-architecture-ts/SKILL.md)).

---

## 1. Alineación a Prisma 7 GA y configuración base

> [!NOTE]
> Cuando el usuario apruebe alinear `package.json`, fijar ambos paquetes en el mismo major (`npm i -D prisma@~7` y `npm i @prisma/client@~7 @prisma/adapter-pg pg` + `npm i -D @types/pg`). En Prisma 7, `migrate dev` no corre `generate` ni `seed` automáticamente: invocarlos de forma explícita.

### 1.1 `prisma.config.ts` (Prisma 7)
```ts
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Rol DDL dedicado en staging/prod (distinto del rol DML de DATABASE_URL)
    url: env("MIGRATION_DATABASE_URL"),
  },
});
```

### 1.2 Fragmento de `prisma/schema.prisma` alineado a Recetaria
```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
}

enum Role {
  USER
  CHEF
  NUTRITIONIST
  ADMIN
}

enum RecipeStatus {
  DRAFT
  APPROVED
}

enum Difficulty {
  EASY
  MEDIUM
  HARD
  EXPERT
}

model User {
  id              String     @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  email           String     @unique @db.VarChar(255)
  passwordHash    String     @db.VarChar(255)
  firstName       String     @db.VarChar(100)
  lastName        String     @db.VarChar(100)
  role            Role       @default(USER)
  isActive        Boolean    @default(true)
  createdAt       DateTime   @default(now()) @db.Timestamptz(6)
  updatedAt       DateTime   @updatedAt @db.Timestamptz(6)

  authoredRecipes Recipe[]   @relation("RecipeAuthor")
  reviewedRecipes Recipe[]   @relation("RecipeReviewer")
  auditLogs       AuditLog[]

  @@index([role, isActive], map: "idx_users_role_isactive")
  @@map("users")
}

model Recipe {
  id              String       @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  title           String       @db.VarChar(150)
  slug            String       @unique @db.VarChar(200)
  description     String       @db.Text
  difficulty      Difficulty   @default(MEDIUM)
  status          RecipeStatus @default(DRAFT)
  prepTimeMinutes Int          @db.SmallInt
  tags            String[]     @default([]) @db.VarChar(50)
  ingredients     Json         @db.JsonB
  nutritionalInfo Json?        @db.JsonB
  coverImageUrl   String?      @db.VarChar(512)
  videoUrl        String?      @db.VarChar(512)
  authorId        String       @db.Uuid
  reviewedById    String?      @db.Uuid
  publishedAt     DateTime?    @db.Timestamptz(6)
  createdAt       DateTime     @default(now()) @db.Timestamptz(6)
  updatedAt       DateTime     @updatedAt @db.Timestamptz(6)

  // Prohibido onDelete: Cascade en tablas de negocio
  author          User         @relation("RecipeAuthor", fields: [authorId], references: [id], onDelete: Restrict)
  reviewedBy      User?        @relation("RecipeReviewer", fields: [reviewedById], references: [id], onDelete: SetNull)

  @@index([authorId], map: "idx_recipes_authorid")
  @@index([status, difficulty], map: "idx_recipes_status_difficulty")
  @@map("recipes")
}

model AuditLog {
  id         String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  entityName String   @db.VarChar(50)
  entityId   String   @db.Uuid // Sin FK a recipes por diseño (RN-06): sobrevive a DELETE físico
  action     String   @db.VarChar(50)
  userId     String?  @db.Uuid
  oldValues  Json?    @db.JsonB
  newValues  Json?    @db.JsonB
  createdAt  DateTime @default(now()) @db.Timestamptz(6)

  user       User?    @relation(fields: [userId], references: [id], onDelete: SetNull)

  @@index([entityName, entityId], map: "idx_audit_logs_entity")
  @@index([createdAt], map: "idx_audit_logs_createdat")
  @@map("audit_logs")
}
```

### 1.3 Singleton con `@prisma/adapter-pg` y cierre limpio
```ts
// src/infrastructure/database/prisma.ts
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
  max: Number(process.env.DB_POOL_MAX ?? 10),
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 5_000,
});

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    omit: { user: { passwordHash: true } },
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
```
- Cerrar `await prisma.$disconnect()` exclusivamente en el handler de `SIGTERM`/`SIGINT` de `src/server.ts` (ver [node-backend-engineering](../../node-backend-engineering/SKILL.md)).

---

## 2. Mapeo de errores Prisma + `SQLSTATE` y `withRetry`

```ts
// src/infrastructure/database/db-errors.ts
import { Prisma } from "../../generated/prisma/client";
import { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from "../../shared/errors/app-error";

type ErrorCarrier = { code?: unknown; constraint?: unknown; cause?: unknown };

export function extractSqlState(err: unknown): { sqlState: string; constraint?: string } | null {
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];
  while (queue.length > 0) {
    const cur = queue.shift() as ErrorCarrier | undefined;
    if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    if (typeof cur.code === "string" && /^[0-9A-Z]{5}$/.test(cur.code)) {
      return { sqlState: cur.code, constraint: typeof cur.constraint === "string" ? cur.constraint : undefined };
    }
    queue.push(cur.cause);
  }
  return null;
}

export function isRetryableDbError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034") return true;
  const sqlState = extractSqlState(err)?.sqlState ?? "";
  return sqlState === "40001" || sqlState === "40P01";
}

export function mapPersistenceError(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case "P2002":
        throw new ConflictError("Ya existe un registro con ese identificador único.");
      case "P2025":
        throw new NotFoundError("El recurso solicitado no existe.");
      case "P2003":
        throw new ConflictError("La referencia indicada no existe o tiene registros dependientes.");
      case "P2034":
        throw new ConflictError("Conflicto de concurrencia al actualizar el recurso.");
    }
  }

  const info = extractSqlState(err);
  switch (info?.sqlState) {
    case "23505": throw new ConflictError("Ya existe un registro con esos datos.");
    case "23503": throw new ConflictError("La referencia no existe o está en uso.");
    case "23514":
    case "23502": throw new ValidationError("Los datos incumplen una restricción de integridad.");
    case "55P03":
    case "57014": throw new ServiceUnavailableError("La base de datos está temporalmente ocupada.");
  }

  throw err;
}

export async function withDbRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableDbError(err) || attempt >= maxAttempts) throw err;
      const delayMs = 20 * 2 ** attempt + Math.random() * 20;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
```

---

## 3. Repositorio transaccional (`RN-06`) y queries seguras

### 3.1 Aprobación atómica (`recipes` + `audit_logs` en `prisma.$transaction`)
```ts
// Dentro de src/modules/recipes/recipe.repository.ts
async approveWithAudit(params: {
  recipeId: string;
  reviewerId: string;
  previousSnapshot: Prisma.InputJsonValue;
}) {
  try {
    return await this.prisma.$transaction(
      async (tx) => {
        // Update condicional atómico: exige DRAFT y bloquea auto-aprobación (RN-04, RN-05)
        const updated = await tx.recipe.updateMany({
          where: {
            id: params.recipeId,
            status: "DRAFT",
            authorId: { not: params.reviewerId },
          },
          data: {
            status: "APPROVED",
            reviewedById: params.reviewerId,
            publishedAt: new Date(),
          },
        });

        if (updated.count === 0) return null; // El servicio distingue 404 / 403 / 409

        const recipe = await tx.recipe.findUniqueOrThrow({
          where: { id: params.recipeId },
          select: {
            id: true,
            title: true,
            slug: true,
            status: true,
            reviewedById: true,
            publishedAt: true,
            updatedAt: true,
          },
        });

        await tx.auditLog.create({
          data: {
            entityName: "Recipe",
            entityId: recipe.id,
            action: "APPROVE",
            userId: params.reviewerId,
            oldValues: params.previousSnapshot,
            newValues: { status: recipe.status, reviewedById: recipe.reviewedById },
          },
        });

        return recipe;
      },
      { timeout: 5_000 }
    );
  } catch (err) {
    mapPersistenceError(err);
  }
}
```

### 3.2 Ordenamiento dinámico seguro (whitelist) y keyset con `TypedSQL` / `$queryRaw`
```ts
const RECIPE_ORDER_WHITELIST = {
  createdAt: { createdAt: "desc" as const },
  prepTimeMinutes: { prepTimeMinutes: "asc" as const },
} as const;

export type RecipeSortKey = keyof typeof RECIPE_ORDER_WHITELIST;

// SQL parametrizado seguro (jamás $queryRawUnsafe con input del usuario)
// Usar prisma/sql/*.sql (TypedSQL) cuando la consulta es estable y frecuente.
```

### 3.3 RLS multi-tenant (solo si Recetaria evoluciona a multi-tenant)
```ts
export function withTenant<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    // set_config(..., true) es local a la transacción -> compatible con PgBouncer transaction mode
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}
```
- Nunca usar `$extends` abriendo una transacción separada por query para RLS dentro de una transacción interactiva: la sesión quedaría en otra conexión del pool.

---

## 4. Migraciones en equipo, CI y Docker

| Entorno / acción | Comando seguro | Prohibido |
|---|---|---|
| Desarrollo local (crear SQL revisable) | `npx prisma migrate dev --create-only --name <desc>` | `prisma db push` sobre bases compartidas |
| Revisión previa | Auditar `migration.sql` (evitar `DROP + ADD` en renames; añadir `lock_timeout` / `NOT VALID` / `CONCURRENTLY` según [postgresql-engineering](../../postgresql-engineering/SKILL.md)) | Editar una migración ya aplicada |
| Validación en CI | `npx prisma validate` + `npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code` | Saltar drift check |
| Despliegue (job único antes del rollout) | `npx prisma migrate deploy` usando `MIGRATION_DATABASE_URL` | Correr `migrate dev` o `migrate deploy` dentro del arranque simultáneo de N réplicas |

- **Seeds:** separar datos de referencia idempotentes (`upsert` por clave natural `email`) de fixtures de desarrollo; nunca depender de IDs secuenciales fijos.
- **Coordinación con Docker:** ejecutar `migrate deploy` como job único en el pipeline o comando puntual con conexión directa a `postgres` (sin pasar por pooler en `transaction mode`) antes de recrear `api` (ver [docker-production-containers](../../docker-production-containers/SKILL.md)).

---

## 5. Testing contra PostgreSQL 15 real (Testcontainers / Docker)

```ts
// tests/global-setup.ts (ejemplo con Testcontainers fijado al mismo major que compose.yaml)
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";

export default async function setup() {
  const pg = await new PostgreSqlContainer(`postgres:${process.env.PG_MAJOR ?? "15"}-alpine`).start();
  process.env.DATABASE_URL = pg.getConnectionUri();
  process.env.MIGRATION_DATABASE_URL = pg.getConnectionUri();
  execSync("npx prisma migrate deploy", { stdio: "inherit" });
  return async () => {
    await pg.stop();
  };
}
```

- **Aislamiento entre tests:** `TRUNCATE TABLE audit_logs, recipes, users RESTART IDENTITY;` (o base/esquema dedicado por worker).
- **Casos obligatorios de persistencia:**
  1. Violación `UNIQUE` (`P2002` en `users.email` / `recipes.slug`) mapeada a `409`.
  2. Atomicidad y rollback de `RN-06` (si falla la inserción en `audit_logs`, no persiste el cambio en `recipes`).
  3. Concurrencia real (2 promesas/conexiones simultáneas aprobando o editando la misma receta).
  4. Reintento en `P2034` / `40001` / `40P01`.
  5. Mocks del repositorio únicamente en unit tests de `*.service.test.ts`, nunca para probar constraints SQL.

---

## 6. Evolución futura de ORM, Antipatrones, KPIs y DoD

- **Cambiar de ORM (solo tras ADR medible):** congelar migraciones en el dueño actual, introducir el adaptador nuevo detrás de los interfaces de `repository.ts` por módulo (*strangler*) compartiendo el presupuesto de conexiones, validar tests de contrato en verde y transferir la propiedad de migraciones al finalizar.
- **Antipatrones:** mezclar `prisma` v8 RC con `@prisma/client` v7 · `npx prisma@latest` · `prisma db push` en producción · `PrismaClient` en `controller`/`service` · pool por request o sin `connectionTimeoutMillis` · `data: req.body` · `SELECT *` o exponer `passwordHash` · `$queryRawUnsafe` con input · `orderBy` sin whitelist · `DROP + ADD` inadvertido en renames · backfills pesados dentro de una migración · transacciones con llamadas HTTP adentro · logs con parámetros SQL · testear contra motores distintos de PostgreSQL 15.
- **KPIs:** queries por request p95 constante (sin crecer con `N`) · latencia p95/p99 por repositorio · conexiones en espera del pool (`~0`) · tasa de retries `P2034`/`40001`/`40P01` · incidentes de drift (`0`).
- **Definition of Done:** versiones `prisma` y `@prisma/client` alineadas en el mismo major · `PrismaPg` singleton con timeouts y shutdown en `SIGTERM` · `omit: { user: { passwordHash: true } }` + `select` explícito · transacciones `RN-06` atómicas y cortas · errores `P2002`/`P2025`/`P2003`/`P2034`/`SQLSTATE` mapeados a `AppError` → JSend · roles DML/DDL separados · migraciones auditadas con `migrate dev --create-only` y aplicadas con `migrate deploy` · tests de integración verdes contra PostgreSQL 15 real.
