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

Requisitos previos: [Node.js 24 LTS](https://nodejs.org/) y [Docker Desktop](https://www.docker.com/products/docker-desktop/) con Compose v2.

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
```

`JWT_EXPIRES_IN` define la vigencia del token (por defecto `1d`). Como no hay refresh tokens, **el máximo es `1d` (86 400 s)**: un valor mayor (`2d`, `1w`, `1y`, …) hace que la API no arranque y muestre `JWT_EXPIRES_IN no puede superar 1d (86400 s)` (#52). Se aceptan `15m`, `1h`, `12h`, `24h`, `1440m`, `86400s` o `1d`.

`TRUST_PROXY` indica en qué proxies confiar para leer la IP real del cliente desde `X-Forwarded-For` (la usa el rate limit del catálogo):
- `0` o vacío (por defecto): la API recibe las conexiones directamente; `X-Forwarded-For` se ignora.
- `1`: hay exactamente un proxy inverso delante (Nginx, Traefik, un balanceador); usar el número **exacto** de saltos (máximo `10`). Un valor mayor que los proxies reales, o `1` con la API expuesta sin proxy, permite que el cliente elija su IP con `X-Forwarded-For`.
- Lista de IPs, rangos CIDR o presets (`loopback`, `linklocal`, `uniquelocal`), p. ej. `TRUST_PROXY=172.18.0.10`: confía solo en esas direcciones y es la opción más estricta. Preferí la IP exacta del proxy: un preset o rango amplio (p. ej. `uniquelocal` o la red de Docker completa) deja que cualquier otro host de esa red falsifique su IP.
- Se rechazan al arrancar `true`, `false` y rangos más amplios que `/8` en IPv4 o `/16` en IPv6 (`0.0.0.0/0`, `0.0.0.0/1`, `::/0`, `::ffff:0:0/96`, …): equivaldrían a confiar en cualquier cliente.

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
  2. En Thunder Client, importar el **entorno** (pestaña *Env* → *Import*) y activarlo, y después la **colección** (pestaña *Collections* → *Import*).
  3. Ejecutar **Run All** sobre la colección. El orden importa:
     - los login guardan `userToken`, `chefToken`, `nutriToken` y `adminToken`;
     - el detalle guarda el `ETag` (`recipeEtag`) que exige la aprobación (#46).
  4. Cada pedido lleva en el nombre el código esperado (`[200]`, `[403]`, `[409]`, …) y un test que lo verifica. Las aserciones son de código HTTP: el contenido de las respuestas (estados, auditoría, filtros) lo verifican las suites E2E de `tests/e2e/` (#22).

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
| `npm run docker:dev` | Levanta API y PostgreSQL en Docker con hot-reload (ejecutar antes `npm run db:generate` en el host) |
| `npm run docker:debug` | Levanta PostgreSQL y Adminer en `http://127.0.0.1:8080` |
| `npm run docker:prod` | Levanta la imagen endurecida de producción (`compose.yaml`) |
| `npm run docker:down` | Detiene y remueve los contenedores preservando los datos |

## Documentación
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
En desarrollo — versión 0.1.0 (MVP Backend)

## Licencia
MIT — ver [LICENSE](LICENSE)
