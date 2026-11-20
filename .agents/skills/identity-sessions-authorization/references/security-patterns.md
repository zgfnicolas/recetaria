# Patrones de Seguridad e Identidad (TypeScript / Express / Prisma) — Recetaria API

Snippets de referencia divididos en **MVP actual** (listos para `src/`) y **evolución post-MVP** (Fase Alfa/Beta).

---

## 1. Patrones del MVP (Recetaria v1 — Bearer JWT Stateless + Bcrypt + RBAC)

### 1.1 Verificación endurecida de JWT (`src/modules/auth/jwt.ts`)
Lista blanca de algoritmo (`HS256`) + validación estricta de claims con Zod (`fail closed`):

```typescript
import jwt from "jsonwebtoken";
import { z } from "zod";
import { UnauthorizedError } from "../../shared/errors/app-error";

const AccessTokenPayloadSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(["USER", "CHEF", "NUTRITIONIST", "ADMIN"]),
});

export type Actor = z.infer<typeof AccessTokenPayloadSchema>;

export function signAccessToken(actor: Actor, secret: string, expiresIn: string): string {
  return jwt.sign(actor, secret, {
    algorithm: "HS256",
    expiresIn: expiresIn as jwt.SignOptions["expiresIn"],
  });
}

export function verifyAccessToken(token: string, secret: string): Actor {
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
    const parsed = AccessTokenPayloadSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new UnauthorizedError("Token inválido");
    }
    return parsed.data;
  } catch {
    throw new UnauthorizedError("Token inválido o expirado");
  }
}
```

### 1.2 Comparación de contraseña sin enumeración (`AuthService.login`)
Cuando el email no existe, comparar contra un hash Bcrypt válido ficticio para igualar latencia:

```typescript
import bcrypt from "bcrypt";
import { UnauthorizedError } from "../../shared/errors/app-error";

// Hash Bcrypt válido (cost 10) de una clave ficticia para homogeneizar tiempos de respuesta
const DUMMY_BCRYPT_HASH = "$2b$10$EpRnTzVlqHNP0.fUbXUwSOyuiXe/QLSUG6xNekdHgTGmrpHEfIoxm";

export async function verifyCredentialsTimingSafe(
  plainPassword: string,
  storedHash: string | null,
): Promise<void> {
  const hashToCompare = storedHash ?? DUMMY_BCRYPT_HASH;
  const isValid = await bcrypt.compare(plainPassword, hashToCompare);
  if (!storedHash || !isValid) {
    throw new UnauthorizedError("Email o contraseña incorrectos");
  }
}
```

### 1.3 Políticas puras de autorización (`src/modules/recipes/recipe.policy.ts`)
Sin dependencias de Express ni Prisma; testeables en milisegundos:

```typescript
import type { Actor } from "../auth";
import { ConflictError, ForbiddenError } from "../../shared/errors/app-error";

type RecipeAuthzTarget = Readonly<{
  authorId: string;
  status: "DRAFT" | "APPROVED";
}>;

export const recipePolicy = {
  canEdit: (actor: Actor, recipe: RecipeAuthzTarget): boolean =>
    recipe.authorId === actor.id,

  canDelete: (actor: Actor, recipe: RecipeAuthzTarget): boolean =>
    recipe.authorId === actor.id || actor.role === "ADMIN",

  canApprove: (actor: Actor, recipe: RecipeAuthzTarget): boolean =>
    (actor.role === "CHEF" || actor.role === "NUTRITIONIST") &&
    recipe.authorId !== actor.id,
};

export function assertCanEdit(actor: Actor, recipe: RecipeAuthzTarget): void {
  if (!recipePolicy.canEdit(actor, recipe)) {
    throw new ForbiddenError("Solo el autor puede editar esta receta");
  }
}

export function assertCanDelete(actor: Actor, recipe: RecipeAuthzTarget): void {
  if (!recipePolicy.canDelete(actor, recipe)) {
    throw new ForbiddenError("Solo el autor o un administrador pueden eliminar esta receta");
  }
}

export function assertCanApprove(actor: Actor, recipe: RecipeAuthzTarget): void {
  if (!recipePolicy.canApprove(actor, recipe)) {
    throw new ForbiddenError("Solo un chef o nutricionista distinto del autor puede aprobar esta receta");
  }
  if (recipe.status === "APPROVED") {
    throw new ConflictError("La receta ya se encuentra aprobada");
  }
}
```

### 1.4 Test de rutas privadas por defecto (Supertest)
Verifica que ninguna mutación quede expuesta sin `authMiddleware`:

```typescript
const PROTECTED_MUTATIONS: ReadonlyArray<readonly ["post" | "put" | "delete", string]> = [
  ["post", "/api/v1/recipes"],
  ["put", "/api/v1/recipes/550e8400-e29b-41d4-a716-446655440000"],
  ["delete", "/api/v1/recipes/550e8400-e29b-41d4-a716-446655440000"],
  ["put", "/api/v1/recipes/550e8400-e29b-41d4-a716-446655440000/approve"],
];

it.each(PROTECTED_MUTATIONS)("rechaza %s %s sin token Bearer con 401", async (method, path) => {
  const res = await request(app)[method](path).send({});
  expect(res.status).toBe(401);
  expect(res.body.success).toBe(false);
});
```

---

## 2. Patrones de Evolución Post-MVP (Fase Alfa / Beta / Producción)

Aplicar cuando Recetaria incorpore frontend web, cookies de sesión, refresh tokens o endurecimiento adicional de cuentas.

### 2.1 Chequeo de contraseñas filtradas (`k-anonymity` HIBP)
Solo viajan los primeros 5 caracteres del SHA-1; la contraseña nunca sale del servidor:

```typescript
import { createHash } from "node:crypto";

export async function isPwnedPassword(password: string): Promise<boolean> {
  const sha1 = createHash("sha1").update(password).digest("hex").toUpperCase();
  const [prefix, suffix] = [sha1.slice(0, 5), sha1.slice(5)];
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { "Add-Padding": "true" },
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return false;
    return (await res.text())
      .split("\n")
      .some((line) => line.startsWith(suffix) && !line.trimEnd().endsWith(":0"));
  } catch {
    return false; // degrada a lista de bloqueo local sin tumbar el registro
  }
}
```

### 2.2 Protección CSRF con Fetch Metadata + Origin (Express)
Obligatoria si en el futuro se autentican mutaciones mediante cookies:

```typescript
import type { RequestHandler } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function createCsrfMiddleware(allowedOrigins: ReadonlySet<string>): RequestHandler {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();

    const fetchSite = req.header("sec-fetch-site");
    if (fetchSite) {
      if (fetchSite === "same-origin" || fetchSite === "none") return next();
      res.status(403).json({ success: false, statusCode: 403, message: "Origen cross-site bloqueado" });
      return;
    }

    const origin = req.header("origin");
    if (origin && allowedOrigins.has(origin)) return next();

    res.status(403).json({ success: false, statusCode: 403, message: "Origen no permitido" });
  };
}
```

### 2.3 Refresh tokens rotados con detección de reutilización (Prisma `$transaction`)
Si se agregan refresh tokens persistentes para apps móviles o clientes multi-dispositivo:

```typescript
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { UnauthorizedError } from "../../shared/errors/app-error";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export async function rotateRefreshToken(prisma: PrismaClient, presentedToken: string) {
  return prisma.$transaction(async (tx) => {
    const record = await tx.refreshToken.findUnique({
      where: { tokenHash: sha256(presentedToken) },
    });

    if (!record || record.revokedAt || record.expiresAt < new Date()) {
      throw new UnauthorizedError("Refresh token inválido o expirado");
    }

    if (record.usedAt) {
      // Reutilización detectada: revocar toda la familia inmediatamente
      await tx.refreshToken.updateMany({
        where: { familyId: record.familyId },
        data: { revokedAt: new Date() },
      });
      console.error("[SECURITY_ALERT] refresh_token.reuse", {
        userId: record.userId,
        familyId: record.familyId,
      });
      throw new UnauthorizedError("Sesión revocada por seguridad");
    }

    await tx.refreshToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });

    const nextRawToken = randomBytes(32).toString("base64url");
    await tx.refreshToken.create({
      data: {
        id: randomUUID(),
        familyId: record.familyId,
        userId: record.userId,
        parentId: record.id,
        tokenHash: sha256(nextRawToken),
        expiresAt: record.expiresAt, // nunca extender la vida absoluta de la familia
      },
    });

    return { userId: record.userId, refreshToken: nextRawToken };
  });
}
```

### 2.4 Sesiones opacas server-side (`__Host-session`)
Para un futuro frontend web first-party (evitando JWT en `localStorage`):
- Generar `rawId = randomBytes(32).toString("base64url")` (256 bits) y guardar en Redis/DB únicamente `sha256(rawId)` como clave.
- Emitir cookie `__Host-session=<rawId>; Path=/; Secure; HttpOnly; SameSite=Lax` (sin `Domain`).
- Aplicar timeout de inactividad (ej. 30 min) **y** timeout absoluto (ej. 8 h), más `permissionVersion` en el usuario para invalidar sesiones previas al cambiar contraseña o rol.
- Regenerar el ID de sesión en cada login y destruir en el servidor al hacer logout.
