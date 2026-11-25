# Plan — Aislamiento de la base de datos de pruebas (ampliación de #23)

Fecha: 2026-11-25 · Rama: `docs/23-thunder-client-collection` (commit `test(db): …` aparte dentro del PR de #23) · Origen: hallazgo informativo de `security-auditor` en #23 · Estado: **Completado (2026-11-25); pendiente commit/PR junto con #23**

## 1. Problema
- **Las pruebas usan la base de desarrollo.** `tests/setup/env.ts` carga el mismo `.env` que `npm run dev`, así que `npm test` usa la **misma base** (`recetaria`).
- **Las suites la vacían sin guarda.** 18 suites (más `truncateAll` en `tests/support/e2e.ts`) ejecutan `TRUNCATE "audit_logs", "recipes", "users"` antes y después de cada caso, sin comprobar a qué base apuntan. Todas obtienen la conexión de `process.env.DATABASE_URL`, a través de `getDatabase()` o de una lectura directa en `connectivity` y `seed`.

**Impacto:**
1. **Hoy, en local:** cada `npm test` borra los usuarios semilla y los datos cargados a mano. Después de correr las pruebas, la colección Thunder Client (#23) falla en los login hasta volver a correr `npm run db:seed`.
2. **Peor caso:** si `.env` apunta a una base compartida o remota (staging, una demo para el evaluador), `npm test` la vacía de forma irreversible.

**Contexto verificado:**
- No hay workflows de CI (`.github/` solo tiene plantillas), así que no hay pipeline que adaptar.
- `pg` es dependencia directa y alcanza para crear la base, sin dependencias nuevas.
- `prisma.config.ts` usa `MIGRATION_DATABASE_URL` **antes** que `DATABASE_URL`. Al migrar la base de test hay que fijar **las dos**, o las migraciones podrían ir a la base de desarrollo.
- El usuario `postgres` del contenedor local es superusuario y puede ejecutar `CREATE DATABASE`.

## 2. Diseño (opción B: base de test automática + guarda)
### 2.1 Resolución de la URL de test (pura y con pruebas unitarias) — `tests/support/test-database.ts`
- `resolveTestDatabaseUrl(env)`:
  - Si existe `TEST_DATABASE_URL`, se usa tal cual. Es opcional, para quien quiera otro host o credenciales.
  - Si no, se **deriva** de `DATABASE_URL` cambiando solo el nombre de la base: `recetaria` → `recetaria_test`. Si ya termina en `_test`, se conserva. Se mantienen el host, las credenciales y `?schema=public`.
- `assertTestDatabaseName(name)`: exige `^[a-z0-9_]+_test$`. Garantiza el sufijo y, de paso, que el nombre sea un identificador seguro para `CREATE DATABASE`.

  Cualquier otro valor **aborta** con un mensaje accionable, *fail closed*: también una `TEST_DATABASE_URL` sin sufijo `_test`.

### 2.2 Preparación única antes de toda la suite — `tests/setup/global-database.ts` (`globalSetup` de Vitest)
Corre una sola vez en el proceso principal, antes de los workers:
1. Carga `.env` y resuelve la URL de test (§2.1).
2. Se conecta a la base de mantenimiento `postgres` del mismo servidor, con `pg`, y crea la de test si no existe (`SELECT 1 FROM pg_database WHERE datname = $1` → `CREATE DATABASE "<nombre validado>"`).
3. Ejecuta `prisma migrate deploy` contra la base de test. Usa el binario local (`node_modules/.bin/prisma`) con `DATABASE_URL` **y** `MIGRATION_DATABASE_URL` fijadas a la URL de test. Es idempotente: si no hay migraciones pendientes, no hace nada.
4. Si falla, por ejemplo si el usuario no tiene permiso `CREATEDB`, aborta toda la suite con instrucciones: crear la base a mano o definir `TEST_DATABASE_URL`.

### 2.3 Cada worker apunta a la base de test — `tests/setup/env.ts` (`setupFiles`, ya existe)
- Después de `dotenv`, **sobrescribe** `process.env.DATABASE_URL` y `MIGRATION_DATABASE_URL` con la URL de test y vuelve a ejecutar la guarda.
- Así `getDatabase()` y las lecturas directas de `connectivity` y `seed` quedan en la base de test **sin cambiar código de producción**.
- Las pruebas unitarias que fijan `DATABASE_URL` con `vi.stubEnv` siguen funcionando, porque `unstubEnvs` restaura la URL de test.

### 2.4 Defensa en profundidad al borrar — `truncateAll` único
- `truncateAll(db)` (`tests/support/e2e.ts`, que pasa a `tests/support/database.ts`) consulta `SELECT current_database()` y **se niega** a ejecutar el `TRUNCATE` si el nombre no termina en `_test`. Así protege incluso si una suite construyera su propia conexión.
- Los 18 `TRUNCATE` repetidos se reemplazan por `truncateAll(db)`, con el mismo comportamiento. Antes de unificarlos se verifica que todos vacían las mismas tablas.
- Una prueba nueva fija la invariante: no queda ningún `TRUNCATE` fuera de `truncateAll` en `tests/`. La regla de arquitectura de #22 se amplía con un chequeo similar.

### 2.5 Sin cambios en
`src/`, `prisma/` y las migraciones, `package.json`, Docker y `.env`. Solo se documenta `TEST_DATABASE_URL` como opcional en `.env.example`.

## 3. Fases
### Fase 1 — Resolución y guarda (§2.1) · Estado: Hecha
- [x] `tests/support/test-database.ts`, con pruebas unitarias:
  - derivación (`recetaria` → `recetaria_test`);
  - conservación de `_test`, de la query y de las credenciales;
  - `TEST_DATABASE_URL` válida e inválida;
  - nombres peligrosos (`"x; DROP …"`, mayúsculas, vacío);
  - una URL sin base.

### Fase 2 — Preparación y redirección (§2.2, §2.3) · Estado: Hecha
- [x] `globalSetup` en `vitest.config.ts` y la sobrescritura en `tests/setup/env.ts`.

### Fase 3 — `truncateAll` con guarda y unificación (§2.4) · Estado: Hecha
- [x] Guarda con `current_database()`, con prueba positiva (base de test) y negativa (un cliente falso que reporta `recetaria`: lanza y **no** ejecuta el `TRUNCATE`).
- [x] Reemplazo de los 18 `TRUNCATE` y la prueba de invariante.

### Fase 4 — Verificación · Estado: Hecha
- [x] `npm run typecheck`, `npm run typecheck:test`, `npm run build` y `npm test`, dos veces seguidas, para comprobar que la preparación es idempotente.
- [x] **Prueba de aislamiento real:**
  - el conteo de `users` en la base de desarrollo, solo con lecturas, es **igual** antes y después de `npm test`;
  - la base `recetaria_test` existe y está migrada.
- [x] Mutaciones:
  - quitar la sobrescritura de `env.ts` → la guarda aborta la suite, no borra la base de desarrollo;
  - quitar la guarda de `truncateAll` → falla la prueba negativa;
  - un `TRUNCATE` suelto en una suite → falla la invariante.

### Fase 5 — Documentación, auditorías y cierre · Estado: Hecha
Resultado: 60 archivos · 1481 pruebas en verde. Las corridas completas son idempotentes, y la base de desarrollo conserva sus filas después de cada una.
- **Aislamiento verificado:** la base de desarrollo, sembrada con 4 usuarios, conservó sus filas después de las corridas, y `recetaria_test` existe y está migrada.
- **Hallazgo durante la mutación (a):** una prueba nueva escribía **antes** de llamar a `truncateAll`. Sin la redirección, dejó 1 fila en desarrollo (`guarda@recetaria.com`, con un hash inválido que no permite iniciar sesión), aunque sin borrar nada. Se corrigió de raíz:
  - la guarda de `env.ts` valida la `DATABASE_URL` **efectiva** del worker;
  - la prueba limpia antes de escribir.

  Re-mutación: sin la redirección, la suite aborta con *no tests* y no hay ninguna fila nueva. Queda **pendiente de autorización del humano** borrar esa fila de la base de desarrollo.
- **Mutaciones:**
  - sin la redirección → aborta antes de las pruebas;
  - sin la guarda de `truncateAll` → falla la prueba negativa;
  - con un `TRUNCATE` suelto → falla la invariante.
- [x] `docs/testing.md`: "Aislamiento de datos", con la base `<db>_test` automática, la guarda y `TEST_DATABASE_URL`.
- [x] `README.md`: requisitos de las pruebas. Se elimina la necesidad de volver a sembrar después de `npm test`.
- [x] `.env.example` y `CHANGELOG.md`.
- [x] Auditorías: `security-auditor` y `qa-tester` en paralelo. Se archiva el plan junto con el de #23.

## 4. Riesgos
- **Permisos:** si el usuario de la base no puede ejecutar `CREATE DATABASE` (un servidor gestionado), la suite aborta con instrucciones claras: crear la base a mano o definir `TEST_DATABASE_URL`. Nunca cae a la base de desarrollo.
- **Tiempo:** `migrate deploy` suma alrededor de 1 a 2 s por corrida, una sola vez.
- **Base de test vieja:** si se edita una migración ya aplicada, una práctica que el proyecto no sigue, `migrate deploy` falla con el error de Prisma. Se documenta el arreglo: `DROP DATABASE recetaria_test`, y se recrea sola.
- **Datos previos en desarrollo:** las corridas anteriores de `npm test` ya vaciaron la base de desarrollo. Con este cambio deja de pasar, pero los datos borrados no se recuperan: hay que volver a correr `npm run db:seed` una vez.

## 5. Decisiones tomadas (sin preguntas abiertas)
- **Opción B**, elegida por el humano.
- **Ubicación:** commit propio, `test(db): aislar la base de datos de pruebas`, dentro del PR de #23. Es un problema que la colección hace visible, pero es independiente de ella.
- **`TEST_DATABASE_URL` opcional y documentada en `.env.example`:** la ruta automática no la necesita.

## Auditorías (2 subagentes en paralelo, solo lectura y sin tocar ninguna base)
- **security-auditor:** sin VETO. No queda ningún camino por el que `npm test` modifique la base de desarrollo.
  - Media, huecos de la invariante → **resuelta**:
    - regex sin distinguir mayúsculas;
    - `TRUNCATE` sin `TABLE`;
    - `DROP SCHEMA`/`DATABASE`;
    - `deleteMany()`;
    - también se analizan `src/**/*.test.ts`;
    - **invariante nueva:** ninguna conexión con una URL literal que no sea `_test` o del puerto 1, que es la única vía para esquivar la guarda de `env.ts`.
  - Baja, `sslmode` perdido en la URL de mantenimiento → **resuelta**: solo se quita `schema`.
  - Info, credenciales en el error de la preparación → **resuelta**: `redactCredentials` y sin `cause`, que arrastraba stdout/stderr crudos.
- **qa-tester:** apto.
  - Media, la preparación siempre usaba la base `postgres` → **resuelta**: se conecta primero a la base de test y solo usa `postgres` ante `3D000`. Además conserva `sslmode` y suma `connectionTimeoutMillis` de 5 s.
  - Bajas → **resueltas**:
    - la prueba negativa espía también `$executeRawUnsafe` y `$transaction`;
    - casos unitarios nuevos: `TEST_DATABASE_URL` con espacios, nombre con guion, `sslmode` y redacción;
    - documentado que una `DATABASE_URL` que ya es `*_test` se usa tal cual;
    - orden de imports.
  - Hueco **aceptado**: no hay prueba automatizada del `globalSetup` (requeriría otro servidor o permisos). Queda cubierto por la ejecución real de cada corrida y por la mutación (a).
