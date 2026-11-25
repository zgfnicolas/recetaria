# Estrategia de pruebas y QA

## 1. Objetivos y enfoque
Adoptamos el modelo **Testing Trophy** priorizando pruebas de integración HTTP y aceptación en API para verificar la cadena completa `Router -> Zod -> Auth/RBAC -> Controller -> Service -> Repository -> PostgreSQL`.

| Nivel | Peso | Herramienta | Enfoque |
|---|:-:|---|---|
| **Unitarias** | 20 % | Vitest | Lógica pura de negocio en `*.service.ts` y validaciones Zod 4 |
| **Integración** | 50 % | Supertest + PostgreSQL Docker | Endpoints reales, middlewares, transacciones `$transaction` y errores Prisma |
| **End-to-End (regresión y abuso)** | — | Supertest + PostgreSQL Docker sobre `buildApp({ prisma })` | Ciclo de vida completo, rutas privadas por defecto y matriz OWASP en `tests/e2e/` (#22) |
| **Arquitectura** | — | Vitest (análisis estático de imports) | Fronteras de las 4 capas (ADR-0003) en `tests/architecture/` |
| **Aceptación / API** | 30 % | Thunder Client | `docs/thunder-client-collection.json` + `docs/thunder-client-environment.json` (#23): 13 endpoints y los códigos obligatorios, ejecutable con *Run All*. `tests/docs/thunder-client-collection.test.ts` valida su formato, su cobertura exacta del catálogo (`tests/support/route-catalog.ts`) y su higiene, y la **ejecuta** en orden contra la app real con el seed |

## 2. Convenciones de pruebas
- **Ubicación:**
  - pruebas unitarias junto al archivo fuente (`recipe.service.test.ts`);
  - integración por endpoint en `tests/integration/`;
  - suites End-to-End en `tests/e2e/`;
  - fronteras de capas en `tests/architecture/`;
  - helpers compartidos en `tests/support/`.
- **Patrón AAA:** cada test se organiza en *Arrange* (preparar), *Act* (ejecutar) y *Assert* (verificar código HTTP, sobre JSend y estado persistido).
- **Regla de mocking:** en tests unitarios de `Service` solo se mockea la capa inmediata inferior (`Repository`). Nunca se mockea lógica interna del servicio bajo prueba.
- **Aislamiento de datos (base de pruebas dedicada):** `npm test` **nunca** usa la base de `DATABASE_URL`, la de desarrollo.
  - `tests/setup/global-database.ts` (`globalSetup`) deriva la base hermana `<base>_test` (`recetaria` → `recetaria_test`), la crea si falta en el mismo servidor y le aplica `prisma migrate deploy`. Fija `DATABASE_URL` **y** `MIGRATION_DATABASE_URL`, porque `prisma.config.ts` prioriza la segunda.
  - `tests/setup/env.ts` redirige cada worker a esa base y valida la URL **efectiva**: si no termina en `_test`, la suite aborta antes de conectarse.
  - El único borrado es `truncateAll` (`tests/support/database.ts`). Antes de `TRUNCATE` consulta `current_database()` y se niega si la base no es `_test`.
  - `tests/architecture/test-database-isolation.test.ts` impide que aparezca un `TRUNCATE`, `DELETE FROM` o `DROP TABLE` fuera de él.
  - Se puede usar otra base con `TEST_DATABASE_URL`, que también debe terminar en `_test`. Si la base de `DATABASE_URL` ya se llama `*_test`, las pruebas la usan tal cual (por diseño: ya es una base de pruebas).
  - Si la base de pruebas ya existe, la preparación solo se conecta a ella. Recurre a la base de mantenimiento `postgres` únicamente para crearla, y conserva parámetros como `sslmode`.
  - Si la base de pruebas quedara inconsistente, por ejemplo al editar una migración ya aplicada: `DROP DATABASE recetaria_test`, y se recrea sola en la siguiente corrida.

## 3. Matriz de cobertura HTTP requerida
Todo módulo (`Auth`, `Recipes`) debe contar con pruebas verificando:

| Código | Escenario obligatorio |
|---|---|
| `200 OK` / `201 Created` | Flujo exitoso con payload válido y rol autorizado |
| `400 Bad Request` | Body inválido por Zod o parámetro `:id` sin formato UUIDv4 |
| `401 Unauthorized` | Ruta protegida sin header `Authorization: Bearer` o con token expirado/inválido |
| `403 Forbidden` | Usuario `USER` intentando aprobar (`RN-04`), no autor intentando editar (`RN-02`) o auto-aprobación (`RN-05`) |
| `404 Not Found` | Recurso inexistente por ID válido (`P2025`) |
| `409 Conflict` | Registro con email duplicado, `slug` repetido (`P2002`), receta ya aprobada o quitar el último `ADMIN` activo |
| `412` / `428` | `If-Match` con una versión obsoleta / ausente en la aprobación (#46) |
| `429 Too Many Requests` | Rate limits del catálogo público y de `/auth` |

## 3.1. Suites End-to-End y de arquitectura (#22)
Las suites E2E corren contra la app real (`buildApp`) y PostgreSQL. Las que escriben datos limpian con `truncateAll` (`tests/support/e2e.ts`) antes y después de cada prueba; la de rutas privadas no escribe. La de arquitectura analiza el código fuente sin usar la base. Ninguna agrega dependencias.

| Suite | Qué garantiza |
|---|---|
| `tests/e2e/recipe-lifecycle.test.ts` | El flujo productivo encadenado, en este orden: <ol><li>`ADMIN` sembrado;</li><li>registro (`USER`);</li><li>promoción por `/role`;</li><li>alta en `DRAFT`;</li><li>lecturas pública y `/mine`;</li><li>`APPROVE` (`CHEF`, con `ETag`);</li><li>edición → `RESET_TO_DRAFT` (el `ETag` viejo da `412`);</li><li>`APPROVE` (`NUTRITIONIST`);</li><li>`DELETE` (`ADMIN`).</li></ol>Verifica la secuencia exacta de `audit_logs` de `Recipe` y de `User`. |
| `tests/e2e/private-routes-by-default.test.ts` | Descubre las rutas registradas (introspección de Express 5) y exige que coincidan con un catálogo declarado `public: true/false`: una ruta nueva sin clasificar hace fallar la suite.<br>Toda ruta privada, también con `HEAD`, responde `401` en tres casos: sin token, con una firma inválida y con el JWT de un usuario inexistente.<br>Incluye una autoverificación con un router sin guarda. |
| `tests/e2e/owasp-abuse-matrix.test.ts` | Matriz OWASP API Top 10 ↔ `RN-xx` contra las rutas reales: BOPLA (con el campo rechazado), BOLA, BFLA, auto-aprobación, cuenta inactiva y manipulación de JWT (`alg: none`, firma, expirado, `HS512`, sin `exp`, `Basic`, claim de rol inflado). Cada caso verifica que no hubo **ningún** efecto en la base.<br>Además:<ul><li>BOLA por query (`/mine?authorId=`);</li><li>`ADMIN` degradado o desactivado con JWT vigente;</li><li>`428` sin `If-Match`;</li><li>tokens en query o cookie;</li><li>un `401` de login indistinguible (inactiva / contraseña errónea / inexistente);</li><li>un `500` redactado.</li></ul> |
| `tests/architecture/layer-boundaries.test.ts` | Solo los repositorios, la infraestructura y la raíz de composición importan Prisma. Ninguna capa importa una capa que no le corresponde (se aceptan los `import type`, salvo hacia Prisma). Fuera de los repositorios y servicios, nadie obtiene una clase `*Repository` ni `Prisma` como valor, tampoco a través de un barrel. No hay `import()` con argumento no literal. El analizador (que respeta strings y template literals al quitar comentarios) se autoverifica con *fixtures*. |

Todas las respuestas de las suites E2E pasan por `createExposureRecorder` (`tests/support/exposure.ts`), que al cierre verifica que ninguna exponga `passwordHash`, hashes Bcrypt, *stack traces*, el secreto JWT ni la contraseña de prueba.

**Defensa en profundidad observada:** quitar `authGuard` de una ruta real no la abre. Sin él, `rbacMiddleware` o `readActorId` del controlador responden igual `401`. La detección de una fuga real se demuestra con la autoverificación.

## 4. Comandos
```bash
npm test                 # Ejecuta pruebas unitarias, de integración, E2E y de arquitectura
npx vitest run tests/e2e tests/architecture   # Solo las suites de regresión, abuso y fronteras (#22)
npm run test:watch       # Modo observador durante desarrollo
```
