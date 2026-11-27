# Recetaria API

API RESTful para publicar y consultar recetas gastronómicas validadas clínica y culinariamente por nutricionistas y chefs mediante control de acceso basado en roles (RBAC) y auditoría transaccional.

## Funcionalidades principales
- Registro y autenticación con Bcrypt (`>= 10` rounds) y JSON Web Tokens (JWT) sin sesiones; la autorización usa el estado vigente del usuario (una cuenta desactivada o degradada pierde el acceso de inmediato, ADR-0009)
- Gestión CRUD completa de recetas con validación estricta mediante Zod 4 (`z.strictObject`) y reglas de negocio explícitas en la capa de servicio (`RN-01`–`RN-10`)
- Filtrado (`status`, `difficulty`, `authorId`), paginación acotada (`page`, `limit`) y consulta privada de recetas propias (`GET /api/v1/recipes/mine`)
- Aprobación profesional exclusiva (`CHEF`, `NUTRITIONIST`) con bloqueo de auto-aprobación y auditoría atómica en `audit_logs` (`prisma.$transaction`)

## Stack
Backend: Node.js 24 LTS (ESM) + Express 5 + TypeScript 7 (`tsx`) · Base de datos: PostgreSQL 15 + Prisma 7 GA (`@prisma/adapter-pg`) · Validación y Seguridad: Zod 4 + Bcrypt + JWT + `dotenv` · Testing: Vitest + Supertest + Thunder Client · Contenedores: Docker Compose v2

## Inicio rápido

Requisitos previos: [Node.js 24 LTS](https://nodejs.org/) y Docker con Compose v2: [Docker Desktop](https://www.docker.com/products/docker-desktop/) en Windows y macOS, o Docker Desktop / Docker Engine en Linux. Si `npm run docker:db` falla, ver [Solución de problemas](#solución-de-problemas).

```bash
git clone https://github.com/zgfnicolas/recetaria.git
cd recetaria
cp .env.example .env
# Completar .env con los valores locales indicados abajo
npm install
npm run db:generate
npm run docker:db
npx prisma migrate deploy
npm run db:seed
npm run dev
```

La API queda disponible en `http://localhost:3000` (alternativa 100 % contenerizada: `npm run docker:dev`).

### Variables de entorno locales (`.env`)
El archivo `.env.example` contiene únicamente los nombres de variables sin valores. Para desarrollo local, completá `.env` (ignorado en `.gitignore`) con valores de ejemplo como:

```env
NODE_ENV=development
PORT=3000
IMAGE_TAG=1.0.0
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=recetaria
POSTGRES_PORT=5432
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/recetaria?schema=public"
JWT_SECRET="reemplazar_por_secreto_criptografico_local_de_al_menos_64_caracteres"
JWT_EXPIRES_IN="1d"
TRUST_PROXY=0
PRISMA_HIDE_UPDATE_MESSAGE=1
```

`JWT_EXPIRES_IN` define la vigencia del token (por defecto `1d`). Como no hay refresh tokens, **el máximo es `1d` (86 400 s)**: un valor mayor (`2d`, `1w`, `1y`, …) hace que la API no arranque y muestre `JWT_EXPIRES_IN no puede superar 1d (86400 s)` (#52). Se aceptan `15m`, `1h`, `12h`, `24h`, `1440m`, `86400s` o `1d`.

`TRUST_PROXY` indica en qué proxies confiar para leer la IP real del cliente desde `X-Forwarded-For` (la usa el rate limit del catálogo):
- `0` o vacío (por defecto): la API recibe las conexiones directamente; `X-Forwarded-For` se ignora.
- `1`: hay exactamente un proxy inverso delante (Nginx, Traefik, un balanceador); usar el número **exacto** de saltos (máximo `10`). Un valor mayor que los proxies reales, o `1` con la API expuesta sin proxy, permite que el cliente elija su IP con `X-Forwarded-For`.
- Lista de IPs, rangos CIDR o presets (`loopback`, `linklocal`, `uniquelocal`), p. ej. `TRUST_PROXY=172.18.0.10`: confía solo en esas direcciones y es la opción más estricta. Preferí la IP exacta del proxy: un preset o rango amplio (p. ej. `uniquelocal` o la red de Docker completa) deja que cualquier otro host de esa red falsifique su IP.
- Se rechazan al arrancar `true`, `false` y rangos más amplios que `/8` en IPv4 o `/16` en IPv6 (`0.0.0.0/0`, `0.0.0.0/1`, `::/0`, `::ffff:0:0/96`, …): equivaldrían a confiar en cualquier cliente.

## Guía para evaluadores

1. **Levantar el entorno:** seguir el [Inicio rápido](#inicio-rápido). Con `node -v` se verifica que sea `v24.x`, y la API responde en `http://localhost:3000/health`.
2. **Pruebas automáticas:** `npm run build` (0 errores de TypeScript) y `npm test` (unitarias, integración, E2E, arquitectura y ejecución de la colección de Thunder Client). Usan una base aparte, `recetaria_test`, y no tocan la de desarrollo.
3. **Thunder Client:** importar el entorno y las dos partes de la colección y ejecutarlas en orden (ver [Pruebas](#pruebas-vitest--supertest--thunder-client)).
4. **Usuarios semilla** (contraseña `password123`): `user@recetaria.com`, `chef@recetaria.com`, `nutri@recetaria.com` y `admin@recetaria.com`.

### Requisitos de la consigna

| # | Requisito | Dónde se cumple |
|---|---|---|
| 1 | Node.js + Express + TypeScript, estructura por componentes | `src/modules/{auth,recipes,users}/` |
| 2 | PostgreSQL con ORM y modelos `User` + entidad | Prisma 7: `User`, `Recipe` (y `AuditLog`) en `prisma/schema.prisma` |
| 3 | CRUD completo | `GET /api/v1/recipes`, `GET /:id`, `POST`, `PUT /:id`, `DELETE /:id` |
| 4 | Arquitectura en capas | `*.router.ts` → `*.controller.ts` → `*.service.ts` → `*.repository.ts`; lo verifica `tests/architecture/layer-boundaries.test.ts` |
| 5 | ≥ 2 validaciones de negocio en el servicio | `RecipeService` (`src/modules/recipes/recipe.service.ts`): `prepTimeMinutes` en `[1, 1440]` e ingredientes con `quantity > 0` (`RN-07`), más ownership y auto-aprobación |
| 6 | Registro y login con Bcrypt y JWT | `POST /api/v1/auth/register` y `/login` (`src/modules/auth/`) |
| 7 | Rutas que escriben protegidas con middleware JWT | `src/middlewares/auth.middleware.ts`; sin token → `401` |
| 8 | Códigos `200`, `201`, `400`, `401`, `404`, `500` | Colección de Thunder Client; el `500` lo cubre `npm test` (`tests/e2e/owasp-abuse-matrix.test.ts`) |
| 9 | `try/catch` en todos los controladores | `src/modules/*/*.controller.ts` |
| 10 | Secretos en `.env` con `dotenv`, ignorado y con `.env.example` | `src/config/env.ts`, `.gitignore` y `.env.example` |

Los 4 extras opcionales están en [Extras opcionales implementados](#extras-opcionales-implementados).

### Solución de problemas

- **`Cannot connect to the Docker daemon` / `error during connect`:** Docker no está corriendo. En Windows y macOS, abrí Docker Desktop y esperá a que diga *Engine running*. En Linux con Docker Engine, ejecutá `sudo systemctl start docker`.
- **`ports are not available … address already in use` al correr `npm run docker:db`:** otro proceso ya usa el puerto de `POSTGRES_PORT`. Ver [Docker en Windows, macOS y Linux](#docker-en-windows-macos-y-linux).

#### Docker en Windows, macOS y Linux

El proyecto funciona igual con Docker Desktop (Windows, macOS y Linux), Docker Engine (Linux) u otros motores compatibles (OrbStack o Colima en macOS), siempre que traigan **Compose v2** (`docker compose version`).

**1. Ver qué ocupa el puerto** (reemplazá `5432` por el valor de `POSTGRES_PORT`):

| Sistema | Comando |
|---|---|
| Linux | `ss -ltnp \| grep 5432` |
| macOS | `lsof -nP -iTCP:5432 -sTCP:LISTEN` |
| Windows (PowerShell) | `Get-NetTCPConnection -LocalPort 5432 -State Listen` (el `OwningProcess` se busca con `Get-Process -Id <pid>`) |

**2. Según quién lo ocupe:**
- **Un PostgreSQL instalado en el sistema** (lo más común en `5432`): cambiá `POSTGRES_PORT` en el `.env` (p. ej. `5433`) y usá **el mismo puerto** en `DATABASE_URL`. Después repetí `npm run docker:db`.
- **Otro contenedor de Recetaria que ya está corriendo:** no hace falta hacer nada; la base ya está arriba (`docker ps` lo muestra).
- **Dos motores de Docker en la misma máquina:** pasa si conviven Docker Engine y Docker Desktop en Linux, Docker Desktop y un Docker instalado dentro de WSL en Windows, o Docker Desktop y OrbStack/Colima en macOS. Cada motor tiene sus propios contenedores, así que uno puede tener la base corriendo y el otro choca contra su puerto. Para resolverlo:
  ```bash
  docker context ls                       # el activo lleva "*"
  docker --context <otro> ps              # revisar qué corre en el otro motor
  docker context use <contexto>           # quedarse siempre con el mismo
  docker --context <otro> rm -f recetaria-postgres-1   # borrar la copia que no arrancó (si quedó en "Created")
  ```
  Si la base queda en el otro motor, empieza vacía: repetí `npx prisma migrate deploy` y `npm run db:seed`.

**Copiar el `.env` en Windows:** `cp .env.example .env` funciona en PowerShell y Git Bash. En `cmd`, usá `copy .env.example .env`.
- **Thunder Client: `No matching import provider found`:** se está importando un archivo que no es la exportación de esta versión del repositorio. Importá los archivos de `docs/` tal como están.
- **Thunder Client: `The Free Version supports a maximum of 50 requests…`:** importá las dos partes de `docs/thunder-client/` en lugar de la colección completa.
- **Todos los pedidos fallan o apuntan a una URL vacía:** el entorno activo no es `Recetaria — Local` (Thunder Client trae uno de muestra).
- **`429 Too Many Requests` al repetir corridas:** los límites de login y registro viven en memoria; reiniciá `npm run dev` para limpiarlos (solo en local).
- **El seed no corre:** `npm run db:seed` exige `NODE_ENV=development` o `test` en el `.env`.

## Catálogo de Endpoints

Todos los endpoints de negocio responden bajo el sobre **JSend extendido**:
- **Éxito (`200`, `201`):** `{ "success": true, "statusCode": 200, "message": "...", "data": { ... } }`
- **Error (`400`, `401`, `403`, `404`, `409`, `429`, `500`, `503`):** `{ "success": false, "statusCode": 400, "message": "...", "errors": [{ "field": "...", "message": "..." }] }`

| Método | Ruta | Acceso / Rol | Descripción | Códigos HTTP |
|---|---|---|---|---|
| `GET` | `/health` | Público | Liveness liviano del proceso (sin consulta a DB; usado por Docker `HEALTHCHECK`) | `200` |
| `GET` | `/health/ready` | Público | Readiness verificando conectividad a PostgreSQL (`SELECT 1`) | `200`, `503` |
| `POST` | `/api/v1/auth/register` | Público | Registra usuario con Bcrypt (`>= 10` rounds) y rol `USER` asignado por el servidor; enviar `role` → `400` (ADR-0007). Los roles privilegiados de evaluación se obtienen con `npm run db:seed`; rate limit de 5 registros por hora por IP | `201`, `400`, `409`, `429` |
| `POST` | `/api/v1/auth/login` | Público | Autentica credenciales y devuelve Bearer JWT (`{ id, role }`); rechaza `isActive = false`; rate limit contra fuerza bruta de 10 intentos fallidos por IP y 20 por cuenta cada 15 min (los exitosos no cuentan) | `200`, `400`, `401`, `429` |
| `GET` | `/api/v1/recipes` | Público | Lista recetas paginadas (`?status=&difficulty=&authorId=&page=1&limit=20`, `limit` máx. `100`, `page × limit` ≤ `10000`) ordenadas por `createdAt DESC, id DESC`; rate limit de 120 req/min por IP (headers `RateLimit`, `RateLimit-Policy` y `Retry-After`) | `200`, `400`, `429` |
| `GET` | `/api/v1/recipes/mine` | Autenticado (JWT) | Lista paginada exclusivamente de las recetas creadas por el usuario autenticado (`authorId === req.user.id`; acepta `?status=&difficulty=&page=&limit=`, rechaza `authorId` con `400`) | `200`, `400`, `401` |
| `GET` | `/api/v1/recipes/:id` | Público | Obtiene el detalle de una receta (`DRAFT` o `APPROVED`) por UUID v4 con `ETag` fuerte de su versión (`If-None-Match` → `304`); comparte el rate limit de 120 req/min por IP del catálogo | `200`, `304`, `400`, `404`, `429` |
| `POST` | `/api/v1/recipes` | Autenticado (JWT) | Crea una receta en estado `DRAFT` con `slug` automático y validaciones `RN-07` en servicio | `201`, `400`, `401`, `409` |
| `PUT` | `/api/v1/recipes/:id` | Autor (`RN-02`) | Actualiza parcial o totalmente la receta propia (al menos 1 campo; solo cambia lo enviado; `null` vacía `nutritionalInfo`/`coverImageUrl`/`videoUrl`; `title` regenera el `slug`); si estaba `APPROVED`, reinicia a `DRAFT` con registro `RESET_TO_DRAFT` en `audit_logs` | `200`, `400`, `401`, `403`, `404`, `409` |
| `DELETE` | `/api/v1/recipes/:id` | Autor o `ADMIN` (`RN-03`) | Elimina físicamente la receta dentro de `$transaction` registrando `DELETE` con snapshot `{ title, authorId, status }` en `audit_logs` (sobrevive al borrado); responde `data: { id }` | `200`, `400`, `401`, `403`, `404` |
| `PUT` | `/api/v1/recipes/:id/approve` | `CHEF` o `NUTRITIONIST` ≠ Autor (`RN-04`, `RN-05`) | Aprueba receta `DRAFT → APPROVED` dentro de `$transaction` registrando `APPROVE` en `audit_logs`; **exige `If-Match`** con el `ETag` de la versión revisada (de `GET /:id`) | `200`, `400`, `401`, `403`, `404`, `409`, `412`, `428` |
| `PATCH` | `/api/v1/users/:id/role` | `ADMIN` (`RN-09`) | Cambia el rol de otro usuario (`{ role }`), revalidando al actor en la base, nunca el propio y sin dejar el sistema sin `ADMIN`; registra `ROLE_CHANGED` en `audit_logs` (ADR-0008). El rol nuevo rige de inmediato (ADR-0009) | `200`, `400`, `401`, `403`, `404`, `409` |
| `PATCH` | `/api/v1/users/:id/status` | `ADMIN` (`RN-10`) | Activa o desactiva la cuenta de otro usuario (`{ isActive }`), nunca la propia ni al último `ADMIN` activo; registra `ACCOUNT_ACTIVATED`/`ACCOUNT_DEACTIVATED` en `audit_logs`. Desactivar corta de inmediato todas sus rutas protegidas | `200`, `400`, `401`, `403`, `404`, `409` |

## Extras opcionales implementados
- **Filtros con `req.query`:** `GET /api/v1/recipes?status=APPROVED&difficulty=EASY&authorId=<uuid>&page=1&limit=20`.
- **Roles (RBAC):** 4 roles (`USER`, `CHEF`, `NUTRITIONIST`, `ADMIN`) — solo `CHEF`/`NUTRITIONIST` aprueban recetas de terceros (`RN-04`/`RN-05`), y solo Autor o `ADMIN` eliminan (`RN-03`).
- **Relación entre modelos:** `Recipe.authorId → User.id` (`ON DELETE RESTRICT`), `Recipe.reviewedById → User.id` (`ON DELETE SET NULL`), `AuditLog.userId → User.id`, con filtro `?authorId=` y endpoint dedicado `GET /api/v1/recipes/mine`.
- **Middleware de logging:** `loggerMiddleware` imprime en consola método, URL, código HTTP y duración de cada petición sin exponer headers sensibles.

## Pruebas (Vitest + Supertest + Thunder Client)
- **Base de pruebas aislada:** `npm test` crea y migra sola una base `<base>_test` (por ejemplo `recetaria_test`) y **nunca** modifica la base de desarrollo de `DATABASE_URL`, así que los datos y los usuarios semilla de `npm run dev` sobreviven a las pruebas. Ver [`docs/testing.md`](docs/testing.md).
- **Automatizadas:** `npm test` ejecuta pruebas unitarias (`*.service.test.ts`, mockeando solo `Repository`) e integración con Supertest contra PostgreSQL Docker. Incluye, además, las suites End-to-End de `tests/e2e/` (ciclo de vida completo, rutas privadas por defecto y matriz OWASP) y la prueba de fronteras de capas de `tests/architecture/` (#22); detalle en [`docs/testing.md`](docs/testing.md).
- **Thunder Client** (#23): colección `docs/thunder-client-collection.json` (62 pedidos en 7 carpetas) y entorno `docs/thunder-client-environment.json`, con formato calibrado contra Thunder Client 3.2.7.
  1. Levantar la API con datos semilla: `npm run docker:db`, `npm run db:seed` y `npm run dev`.
  2. En Thunder Client, importar el **entorno** `docs/thunder-client-environment.json` (pestaña *Env* → *Import*) y activarlo (*⋯* → *Set Active*; la barra de estado de VS Code debe decir `Current Env: Recetaria — Local`).
  3. Importar la colección (pestaña *Collections* → *Import*):
     - **Plan gratuito (lo habitual):** las dos partes de `docs/thunder-client/`, `recetaria-parte-1-de-2.json` (Health → Errores y RBAC, 48 pedidos) y `recetaria-parte-2-de-2.json` (Users y Cleanup, 14 pedidos). El plan gratuito no ejecuta colecciones de más de 50 pedidos, ni siquiera una carpeta suelta, porque cuenta la colección entera.
     - **Plan pago:** la colección completa `docs/thunder-client-collection.json` (62 pedidos).
  4. Ejecutar **Run All** (*⋯* de la colección → *Run All* → *Run*), con las partes **en orden**: primero la 1 y después la 2. El orden importa porque los datos pasan por el entorno:
     - los login guardan `userToken`, `chefToken`, `nutriToken` y `adminToken`;
     - el detalle guarda el `ETag` (`recipeEtag`) que exige la aprobación (#46).

     Las partes se derivan de la colección completa con `npx tsx scripts/thunder-client/split-collection.ts`, y `tests/docs/thunder-client-parts.test.ts` falla si quedan desincronizadas.
  5. Resultado esperado: la columna **Tests** queda en verde en todos los pedidos. La columna **Status** muestra también `400`, `401`, `403`, `404`, `409`, `412` y `428`: son los casos de error que la colección prueba a propósito.
  6. Cada pedido lleva en el nombre el código esperado (`[200]`, `[403]`, `[409]`, …) y un test que lo verifica. Las aserciones son de código HTTP: el contenido de las respuestas (estados, auditoría, filtros) lo verifican las suites E2E de `tests/e2e/` (#22).

  **Qué cubre:** los 13 endpoints y los códigos `200`, `201`, `400`, `401`, `403` (`RN-02`…`RN-05`, `RN-09`, `RN-10`), `404`, `409`, `412` y `428`.

  **Se puede volver a ejecutar:** solo modifica datos que crea en cada corrida (un usuario con email aleatorio y sus recetas). Los usuarios semilla no cambian.

  **Rate limits** (store en memoria por proceso):
  - **Registro:** cada corrida hace 3 registros y el límite es de 5 por hora por IP. En una segunda corrida dentro de la hora, el tercer registro **recibe** `429`.
  - **Login:** cada corrida suma 3 intentos fallidos por IP y el límite es de 10 cada 15 minutos. A partir de la cuarta corrida en esa ventana, todos los login responden `429`, también los válidos, y los pedidos siguientes fallan por falta de token.

  Para repetir corridas, reiniciá `npm run dev`, que limpia los contadores. Esto vale solo en local: nunca desactivar ni reiniciar el limitador en entornos compartidos.

  **Solo para entornos locales y desechables:** cada corrida deja un `USER` activo de prueba (`evaluador-*@recetaria.com`) con una contraseña de prueba pública. No la ejecutes contra una base con datos reales.

  `npm test` valida la colección (`tests/docs/thunder-client-collection.test.ts`): formato, cobertura exacta del catálogo de rutas, higiene y su **ejecución completa** contra la app real.
- **Usuarios semilla (contraseña `password123`):** `user@recetaria.com`, `chef@recetaria.com`, `nutri@recetaria.com` y `admin@recetaria.com`.

## Scripts disponibles

| Script | Propósito |
| :--- | :--- |
| `npm run dev` | Inicia el servidor local en desarrollo con `tsx watch src/server.ts` |
| `npm run build` | Compila TypeScript a `dist/` verificando tipos |
| `npm run typecheck` | Valida tipos sin emitir archivos (`tsc --noEmit`) |
| `npm run typecheck:test` | Valida tipos en `src/`, `tests/`, `vitest.config.ts`, `prisma.config.ts` y `prisma/seed.ts` sin emitir archivos |
| `npm start` | Ejecuta el compilado en producción (`dist/server.js`) |
| `npm test` | Ejecuta la suite de pruebas con Vitest |
| `npm run db:validate` | Valida `prisma/schema.prisma` (no requiere `.env`) |
| `npm run db:format` | Formatea `prisma/schema.prisma` |
| `npm run db:generate` | Genera el cliente en `src/generated/prisma/` (ignorado en Git; corre automáticamente antes de `build`, `typecheck`, `typecheck:test` y `test`) |
| `npm run db:seed` | Ejecuta el seed idempotente (`prisma/seed.ts`) para los 4 roles RBAC (solo `NODE_ENV=development|test`) |
| `npm run docker:db` | Levanta solo PostgreSQL 15 en segundo plano |
| `npm run docker:dev` | Levanta API y PostgreSQL en Docker con hot-reload. El servicio `migrate` aplica las migraciones y siembra los 4 usuarios. Requiere `npm run db:generate` en el host, porque `./src` se monta en solo lectura; si falta, el contenedor lo avisa |
| `npm run docker:debug` | Levanta PostgreSQL y Adminer en `http://127.0.0.1:8080` |
| `npm run docker:prod` | ⚠️ En un servidor, usá siempre `docker:prod` (o `docker compose -f compose.yaml …`): un `docker compose up` sin `-f` carga también `compose.override.yaml`, que es el modo **dev**, con un `JWT_SECRET` de respaldo y seed con contraseñas públicas. Levanta la imagen endurecida de producción (`compose.yaml`): Node 24 Bookworm slim, usuario `node`, `read_only`, `NODE_ENV=production` fijo y `HEALTHCHECK` sobre `/health`. El servicio `migrate` aplica las migraciones antes de la API, sin seed. No publica puertos: va detrás de un proxy inverso |
| `npm run docker:down` | Detiene y remueve los contenedores preservando los datos |
| `npm run docker:smoke` | Pruebas de humo del despliegue (#24): levanta prod y dev en proyectos aislados y efímeros (no usa tu `.env` ni tu base) y verifica salud, endurecimiento, respuestas JSend y ADR-0006. Opciones: `-- --only=prod\|dev`, `-- --keep`. Puertos: `SMOKE_PORT` (3100), `SMOKE_DEV_PORT` (3101) y `SMOKE_DEV_DB_PORT` (55432) |

## Documentación
- [Runbook de despliegue post-#48: auditar cuentas privilegiadas y rotar `JWT_SECRET`](docs/runbooks/post-48-deploy.md) (#51)
- [Requisitos del producto (PRD)](docs/prd.md)
- [Roles y permisos](docs/roles.md)
- [Reglas de negocio](docs/business_rules.md)
- [Arquitectura del sistema (SAD)](docs/sad.md)
- [Modelo de datos](docs/data_model.md)
- [Decisiones de arquitectura (ADR)](docs/adr/)
- [Roadmap del producto](docs/roadmap.md)
- [Estrategia de testing](docs/testing.md)
- [Privacidad y cumplimiento](docs/compliance.md)
- [Cómo contribuir](CONTRIBUTING.md)

## Estado
Versión 1.0.0 (MVP Backend)

## Licencia
MIT — ver [LICENSE](LICENSE)
