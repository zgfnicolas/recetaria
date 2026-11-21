# Plan: [Spec 01.3] Script de seed idempotente para los 4 roles RBAC y verificación de repetibilidad (#9)

Fecha: 2026-11-21 · Rama: `feat/9-seed-idempotente-roles-rbac` · Parent: `#1` · Estado: **Completado y archivado (2026-11-21)**

## Objetivo
Proveer un script de *seed* repetible e idempotente (`prisma/seed.ts`, invocable con `npx prisma db seed` y `npm run db:seed` vía `tsx`) que garantice la existencia de los 4 usuarios semilla correspondientes a todos los roles RBAC del MVP (`USER`, `CHEF`, `NUTRITIONIST`, `ADMIN`) con `isActive = true` y contraseñas cifradas mediante Bcrypt (`>= 10` *salt rounds*, `RN-08`), reutilizando la conexión con `@prisma/adapter-pg` y cerrando ordenadamente el cliente Prisma y el `pg.Pool`, respaldado por pruebas reales de integración en Vitest contra PostgreSQL 15.

## Decisiones aprobadas
1. **Separación función exportable vs entrypoint CLI (`prisma/seed.ts`):**
   - Exportar `SEED_USERS`, `DEFAULT_SEED_PASSWORD` (`"password123"`), `BCRYPT_SALT_ROUNDS` (`10`) y `seedUsers(prisma: AppPrismaClient, options?)` para que Vitest pueda ejecutar la lógica directamente sin disparar efectos laterales al importar.
   - Ejecutar `runSeed()` únicamente cuando el archivo se invoca directamente como entrypoint CLI, cargando `dotenv/config`, usando `getDatabase()` (`@prisma/adapter-pg`) y cerrando siempre con `await disconnect()` dentro de `try / catch / finally` (con `process.exitCode = 1` en error, sin `process.exit(0)` abrupto).
2. **Idempotencia atómica y seguridad criptográfica (`RN-08`):**
   - Usar `prisma.user.createMany({ data, skipDuplicates: true })` (`INSERT ... ON CONFLICT DO NOTHING`): atómico incluso en ejecuciones concurrentes, un solo viaje a PostgreSQL, sin disparar triggers `BEFORE UPDATE` ni mutar `id`, `createdAt`, `updatedAt` ni `passwordHash` en re-ejecuciones.
   - Calcular un hash Bcrypt independiente por usuario (`Promise.all` con `bcrypt.hash(password, BCRYPT_SALT_ROUNDS)` con `BCRYPT_SALT_ROUNDS = 10`) para garantizar salts únicos por cuenta.
   - Nunca imprimir contraseñas ni hashes en logs (solo resumen seguro con conteo).
3. **Guarda de entorno productiva (*fail closed*):**
   - Rechazar la ejecución del *seed* CLI cuando `NODE_ENV === "production"` para impedir sembrar credenciales conocidas de desarrollo en producción.
4. **Tipado estricto y script alias:**
   - Incluir `"prisma/seed.ts"` en `tsconfig.test.json` para cubrirlo con `npm run typecheck:test` (`strict`, `0 any`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `erasableSyntaxOnly`).
   - Agregar el alias `"db:seed": "prisma db seed"` en `package.json` (confirmado explícitamente por el usuario).

## Fases

### Fase 1 — Rama y registro del plan · Estado: Hecha
- [x] Crear la rama `feat/9-seed-idempotente-roles-rbac` desde `main` actualizado (`4f2794e`).
- [x] Registrar este plan en `docs/plans/2026-11-21_spec-01-3-seed-idempotente-rbac.md`.

Criterio de salida: rama creada y plan persistido. **Detenerse para revisión humana.**

---

### Fase 2 — Implementación de `prisma/seed.ts`, tipado estricto y alias `db:seed` · Estado: Hecha
- [x] Crear `prisma/seed.ts` con `SEED_USERS` (`user@recetaria.com`, `chef@recetaria.com`, `nutri@recetaria.com`, `admin@recetaria.com`), `DEFAULT_SEED_PASSWORD`, `BCRYPT_SALT_ROUNDS = 10`, `seedUsers(prisma, options?)` y `runSeed()` con allowlist `NODE_ENV=development|test`, `getDatabase()` y cierre garantizado en `finally`.
- [x] Agregar `"prisma/seed.ts"` a `"include"` en `tsconfig.test.json`.
- [x] Agregar `"db:seed": "prisma db seed"` en `package.json`.
- [x] Verificar compilación y repetibilidad real contra PostgreSQL 15 en Docker:
  ```bash
  npm run typecheck && npm run typecheck:test && npm run build
  npx prisma db seed
  npx prisma db seed
  npm run db:seed
  ```

Criterio de salida: 0 errores de tipos/build y ejecuciones repetidas del seed exitosas sin errores ni fugas de conexiones. **Detenerse para revisión humana.**

---

### Fase 3 — Suite de integración de repetibilidad en Vitest · Estado: Hecha
- [x] Crear `tests/integration/database/seed.test.ts` (patrón AAA, `TRUNCATE TABLE "audit_logs", "recipes", "users" RESTART IDENTITY;` en `beforeEach`/`afterEach`, `disconnect()` en `afterAll`):
  1. **Creación de los 4 roles RBAC:** verifica los 4 emails exactos, roles (`USER`, `CHEF`, `NUTRITIONIST`, `ADMIN`), `firstName`/`lastName`, `isActive === true` y conteo exacto `4`.
  2. **Seguridad Bcrypt (`RN-08`):** leyendo con `omit: { passwordHash: false }`, verifica que el hash no es texto plano, `bcrypt.getRounds(hash) >= 10`, 4 hashes distintos (salts únicos), `bcrypt.compare("password123", hash) === true` y control negativo `bcrypt.compare("clave-incorrecta", hash) === false`.
  3. **Idempotencia secuencial y concurrente:** ejecutar `seedUsers(db.prisma)` dos veces consecutivas y en paralelo (`Promise.all`) mantiene exactamente `4` usuarios sin errores `P2002` y conserva `id`, `createdAt`, `updatedAt` y `passwordHash` intactos.
  4. **Guarda de entorno, cero fugas en logs y cierre limpio del pool:** verifica que el runner CLI rechaza `NODE_ENV=production`, no imprime `password123` ni `$2b$` en logs, y cierra Prisma + `pg.Pool` (`pool.ended === true`, `pool.totalCount === 0`) tanto en éxito como ante error.
- [x] Verificar con `npm run typecheck`, `npm run typecheck:test`, `npm run build`, `npm test` y chequeo estático `0 any` / `0 .only`/`.skip`.

Criterio de salida: todas las suites en verde (`connectivity` + `relational-integrity` + `seed`) bajo `sequence.shuffle: true` y salida `CLEAN`. **Detenerse para revisión humana.**

---

### Fase 4 — Documentación, auditorías obligatorias y cierre · Estado: Hecha
- [x] Actualizar `docs/data_model.md` (`Seed inicial`), `docs/prd.md` (reemplazar referencia heredada a `database_schema_init.sql`), `README.md` (arranque local + script `db:seed`) y `CHANGELOG.md` (`Sin publicar`).
- [x] Archivar este plan en `docs/plans/archivo/2026-11-21_spec-01-3-seed-idempotente-rbac.md`.
- [x] Ejecutar revisiones obligatorias de `GEMINI.md`: `@code-reviewer`, `@security-auditor` y `@qa-tester`.
- [x] Verificación final (`npm run db:validate`, `npm run typecheck`, `npm run typecheck:test`, `npm run build`, `npm test`, `npx prisma db seed` x2, `git status --short`).

---

## Regla de parada
Ejecutar **una fase por vez** y detenerse al finalizar cada fase para revisión humana antes de continuar con la siguiente.
