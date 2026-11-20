# Patrones y Tooling de Arquitectura — Recetaria API

Snippets y configuraciones ejecutables de referencia para el stack **Node.js 22 + Express 5 + TypeScript + Prisma ORM + Zod + JSend**.

---

## 1. Reglas de dependencia verificables (`.dependency-cruiser.cjs`)

Valida automáticamente en CI las fronteras de `src/modules/`, `src/middlewares/` y `src/shared/`:

```js
// .dependency-cruiser.cjs
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "domain-is-pure",
      severity: "error",
      from: { path: "^src/modules/[^/]+/domain/" },
      to: {
        path: [
          "/(presentation|application|infrastructure)/",
          "\\.(router|controller|repository)\\.ts$",
          "node_modules/(@prisma|express|zod|bcrypt|jsonwebtoken)",
        ],
      },
    },
    {
      name: "service-no-prisma-no-http",
      severity: "error",
      from: { path: ["^src/modules/[^/]+/.*\\.service\\.ts$", "^src/modules/[^/]+/application/"] },
      to: {
        path: [
          "\\.(router|controller)\\.ts$",
          "/(presentation|infrastructure)/",
          "node_modules/(@prisma/client|express)",
        ],
      },
    },
    {
      name: "controller-no-prisma-no-repository",
      severity: "error",
      from: { path: "^src/modules/[^/]+/.*\\.controller\\.ts$" },
      to: {
        path: ["\\.repository\\.ts$", "node_modules/@prisma/client"],
      },
    },
    {
      name: "other-features-only-via-public-api",
      severity: "error",
      from: { path: "^src/modules/([^/]+)/" },
      to: {
        path: "^src/modules/[^/]+/.+",
        pathNot: ["^src/modules/$1/", "^src/modules/[^/]+/index\\.ts$"],
      },
    },
    {
      name: "shared-does-not-know-features",
      severity: "error",
      from: { path: "^src/shared/" },
      to: { path: "^src/modules/" },
    },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    doNotFollow: { path: "node_modules" },
  },
};
```

---

## 2. Composition Root (`container.ts`, `app.ts`, `server.ts`)

Separar `buildApp` de `server.ts` permite correr Supertest sin abrir puertos TCP y asegura apagado limpio en Docker (`stop_grace_period: 15s` en `compose.yaml`).

```typescript
// src/bootstrap/container.ts
import { PrismaClient } from "@prisma/client";
import type { Env } from "../config/env";
import { UserRepository, AuthService, AuthController, createAuthRouter } from "../modules/auth";
import { RecipeRepository, RecipeService, RecipeController, createRecipeRouter } from "../modules/recipes";

export function buildContainer(env: Env) {
  const prisma = new PrismaClient();

  const userRepository = new UserRepository(prisma);
  const authService = new AuthService(userRepository, {
    jwtSecret: env.JWT_SECRET,
    jwtExpiresIn: env.JWT_EXPIRES_IN,
  });
  const authRouter = createAuthRouter(new AuthController(authService));

  const recipeRepository = new RecipeRepository(prisma);
  const recipeService = new RecipeService(recipeRepository);
  const recipeRouter = createRecipeRouter(new RecipeController(recipeService), env.JWT_SECRET);

  return {
    prisma,
    routers: { auth: authRouter, recipes: recipeRouter },
    dispose: async (): Promise<void> => {
      await prisma.$disconnect();
    },
  };
}

export type AppContainer = ReturnType<typeof buildContainer>;
```

```typescript
// src/app.ts (sin listen() para habilitar Supertest)
import express, { type Express } from "express";
import cors from "cors";
import type { AppContainer } from "./bootstrap/container";
import { loggerMiddleware } from "./middlewares/logger.middleware";
import { errorHandlerMiddleware } from "./middlewares/error-handler.middleware";

export function buildApp(container: AppContainer): Express {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(loggerMiddleware);

  app.get("/health", async (_req, res, next) => {
    try {
      await container.prisma.$queryRaw`SELECT 1`;
      res.status(200).json({ success: true, statusCode: 200, message: "OK", data: { status: "healthy" } });
    } catch (err) {
      next(err);
    }
  });

  app.use("/api/v1/auth", container.routers.auth);
  app.use("/api/v1/recipes", container.routers.recipes);

  app.use(errorHandlerMiddleware);
  return app;
}
```

```typescript
// src/server.ts
import { loadEnv } from "./config/env";
import { buildContainer } from "./bootstrap/container";
import { buildApp } from "./app";

const env = loadEnv();
const container = buildContainer(env);
const app = buildApp(container);

const server = app.listen(env.PORT, () => {
  console.log(`[Recetaria API] Escuchando en http://localhost:${env.PORT}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close(async () => {
      await container.dispose();
      process.exit(0);
    });
  });
}
```

---

## 3. Jerarquía `AppError` y Traductor JSend

Los servicios lanzan errores semánticos independientes de Express; `errorHandlerMiddleware` los traduce una sola vez al sobre JSend definido en `docs/sad.md`.

```typescript
// src/shared/errors/app-error.ts
export type ErrorField = Readonly<{ field?: string; message: string }>;

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly errors?: readonly ErrorField[],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, errors?: readonly ErrorField[]) {
    super(400, message, errors);
  }
}
export class UnauthorizedError extends AppError {
  constructor(message = "No autorizado") {
    super(401, message);
  }
}
export class ForbiddenError extends AppError {
  constructor(message = "Permisos insuficientes") {
    super(403, message);
  }
}
export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(404, `${resource} no encontrado`);
  }
}
export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, message);
  }
}
```

```typescript
// src/middlewares/error-handler.middleware.ts
import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { AppError } from "../shared/errors/app-error";

export const errorHandlerMiddleware: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    const errors = err.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    }));
    res.status(400).json({ success: false, statusCode: 400, message: "Error de validación", errors });
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

  const prismaCode = typeof err === "object" && err !== null && "code" in err ? String(err.code) : undefined;
  if (prismaCode === "P2002") {
    res.status(409).json({ success: false, statusCode: 409, message: "Conflicto: el recurso ya existe" });
    return;
  }
  if (prismaCode === "P2025") {
    res.status(404).json({ success: false, statusCode: 404, message: "Recurso no encontrado" });
    return;
  }

  console.error("[UNEXPECTED_ERROR]", err);
  res.status(500).json({ success: false, statusCode: 500, message: "Error interno del servidor" });
};
```

---

## 4. Patrón `UnitOfWork` (cuando un módulo asciende a L2)

En L1 basta con métodos transaccionales en `RecipeRepository` (`approveWithAudit`, `updateWithOptionalReset`, `deleteWithAudit`). Si en fases futuras un caso de uso coordina varios repositorios (por ejemplo, `recipes` + `auditLogs` + `outbox`), extraé un `UnitOfWork`:

```typescript
// application/ports.ts
export type TxRepos = Readonly<{
  recipes: IRecipeRepository;
  auditLogs: IAuditLogRepository;
}>;
export type UnitOfWork = <T>(work: (repos: TxRepos) => Promise<T>) => Promise<T>;

// infrastructure/prisma-unit-of-work.ts
import type { PrismaClient } from "@prisma/client";
import type { UnitOfWork } from "../application/ports";

export const makePrismaUnitOfWork = (prisma: PrismaClient): UnitOfWork => (work) =>
  prisma.$transaction(
    (tx) =>
      work({
        recipes: new RecipeRepository(tx),
        auditLogs: new AuditLogRepository(tx),
      }),
    { timeout: 5_000 },
  );
```
