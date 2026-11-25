# Plan — #23 [Spec 06.2] Colección exportada de Thunder Client

Fecha: 2026-11-25 · Rama propuesta: `docs/23-thunder-client-collection` (desde `main` con #58 mergeado) · Parent: `#6` · Estado: **Completado y archivado (2026-11-25)**

## 1. Objetivo
Entregar `docs/thunder-client-collection.json`, importable en Thunder Client, para que un evaluador ejecute a mano el 100 % de los endpoints y escenarios de error con los 4 usuarios semilla.
- **Estructura:** carpetas funcionales.
- **Variables:** `{{baseUrl}}`, un token por rol, `{{recipeId}}` y los ETag.
- **Sin secretos:** solo la contraseña de desarrollo del seed (`password123`, ya pública en el `README`).
- **Verificación:** una prueba en Vitest mantiene la colección válida y sincronizada con las rutas reales.

**Alcance:** archivos de `docs/` y una prueba nueva. No toca `src/`, migraciones ni `package.json`.

## 2. Estado actual (análisis)
- `docs/thunder-client-collection.json` **no existe**, aunque lo citan el `README`, `docs/sad.md` §7, el PRD §8 y `docs/testing.md`.
- **Contexto que el ticket no menciona** (es anterior a #46, #48, #53 y #56):
  - el catálogo tiene **13** endpoints, no 11: se suman `PATCH /api/v1/users/:id/role` y `/status`;
  - la aprobación exige `If-Match` con el `ETag` del detalle (`428` si falta, `412` si es viejo);
  - `/register` rechaza `role` (`400`);
  - hay rate limits: `register` 5/h por IP, `login` 10 fallos/15 min por IP. Se documentan.
- **Fuente única del catálogo:** `tests/e2e/private-routes-by-default.test.ts` ya declara las 13 rutas (`ROUTE_CATALOG`) y las compara con las registradas (#22). Se mueve a `tests/support/route-catalog.ts` para que la prueba de la colección use la misma fuente.
- **Formato del archivo (riesgo principal):** Thunder Client **no documenta** el JSON de exportación.
  - Su documentación solo describe la interfaz: *Set Env Variable* con `json.<campo>`, `header.<nombre>` y la acción `setTo`, y las variables del sistema `{{#guid}}`, `{{#email}}` y `{{#number}}`.
  - Un esquema de terceros ([apis.io](https://apis.io/schemas/thunder-client/thunder-client-collection/)) describe claves (`name`, `client`, tests `status`/`equals`, `auth.token`) que **no coinciden** con las exportaciones reales que conozco (`collectionName`, tests `res-code`/`set-env-var`, `auth.bearer`).
  - Sin calibrar contra una exportación real, la importación podría fallar o perder los tests. Ver la pregunta 1.

## 3. Diseño propuesto
### 3.1 Archivos
- **`docs/thunder-client-collection.json`:** la colección.
- **`docs/thunder-client-environment.json`:** entorno `Recetaria — Local` con:
  - `baseUrl = http://localhost:3000`;
  - las variables vacías que la colección completa sola: `userToken`, `chefToken`, `nutriToken`, `adminToken`, `recipeId`, `recipeEtag`, `chefRecipeId` y `newUserId`.

  El ticket pide "variables parametrizadas", y Thunder Client las resuelve desde un entorno, porque no documenta variables a nivel colección.
- **Precondiciones,** documentadas en el `README` y en la descripción de la colección: `npm run docker:db`, `npm run db:seed` y `npm run dev`, con un servidor recién iniciado. El store de los rate limits está en memoria; ver §5.

### 3.2 Carpetas y orden de ejecución
La colección se ejecuta completa con **Run All**: cada pedido deja en el entorno lo que el siguiente necesita.

| # | Carpeta | Casos (código esperado) |
|---|---|---|
| 1 | `Health` | `GET /health` 200 · `GET /health/ready` 200 |
| 2 | `Auth` | <ul><li>login de `user`, `chef`, `nutri` y `admin` → 200, cada uno guarda su token con `json.data.token`;</li><li>registro con `{{#email}}` → 201 (guarda `newUserId`);</li><li>email duplicado → **409**;</li><li>registro con `role` → **400** (BOPLA, `RN-08`);</li><li>contraseña errónea → **401** (genérico);</li><li>payload inválido → **400**.</li></ul> |
| 3 | `Recipes — Happy Path` | <ul><li>`POST` como `user` → **201** `DRAFT` (guarda `recipeId`);</li><li>`GET /:id` → 200 (guarda `recipeEtag` con `header.etag`);</li><li>`GET /mine` → 200;</li><li>`PUT /:id/approve` como `chef` con `If-Match: {{recipeEtag}}` → 200;</li><li>`PUT /:id` como `user` → 200 y `RESET_TO_DRAFT`;</li><li>`GET /:id` → nuevo `ETag`;</li><li>`approve` como `nutri` → 200.</li></ul> |
| 4 | `Recipes — Filtros y Paginación` | <ul><li>`?status=APPROVED`, `?difficulty=EASY`, `?authorId=`, `?page=1&limit=5` → 200;</li><li>`limit=101` → 400;</li><li>parámetro desconocido → 400;</li><li>`/mine?authorId=` → 400.</li></ul> |
| 5 | `Recipes — Errores y RBAC` | <ul><li>`POST` sin token → **401**;</li><li>`POST` con `prepTimeMinutes: 0` o `quantity: 0` → **400** (`RN-07`);</li><li>`POST` con `status` → **400** (BOPLA);</li><li>`GET /abc` → **400** (UUID);</li><li>`GET /<uuid inexistente>` → **404**;</li><li>`PUT` ajeno como `chef` → **403** (`RN-02`);</li><li>`DELETE` ajeno como `nutri` → **403** (`RN-03`);</li><li>`approve` como `user` o `admin` → **403** (`RN-04`);</li><li>`chef` aprueba su propia receta → **403** (`RN-05`);</li><li>`approve` sin `If-Match` → **428**;</li><li>`approve` con el `ETag` viejo → **412**;</li><li>doble aprobación (con el `ETag` vigente de una receta ya `APPROVED`) → **409**.</li></ul> |
| 6 | `Users — Administración` | <ul><li>`PATCH /role` del usuario nuevo a `CHEF` como `admin` → 200;</li><li>`/role` como `user` → **403**;</li><li>`admin` sobre su propio rol → **403**;</li><li>`:id` inexistente → **404**;</li><li>`PATCH /status` del usuario nuevo `false` → 200 y luego `true` → 200 (deja el estado restaurado);</li><li>body con un campo extra → **400**.</li></ul> |
| 7 | `Cleanup` | `DELETE /:id` como `admin` → 200; `DELETE` repetido → **404**. |

- **Datos frescos en cada corrida:** solo se modifican datos creados en esa corrida: el usuario nuevo y las recetas nuevas. Los 4 usuarios semilla nunca cambian de rol ni de estado, así que la colección se puede volver a correr.
- **Aserciones:** cada pedido declara la aserción de su status HTTP y, cuando aplica, la de un campo JSON (`json.success`, `json.data.status`).

### 3.3 Verificación automatizada — `tests/docs/thunder-client-collection.test.ts`
1. **Validez:** el JSON parsea y cumple un esquema Zod estricto del formato calibrado (pregunta 1). También verifica que:
   - los `_id` son únicos y todo `containerId` apunta a una carpeta existente;
   - las carpetas son las de §3.2.
2. **Cobertura del catálogo:** el conjunto `METHOD + ruta normalizada` de los pedidos (`{{recipeId}}` → `:id`, sin la query) es **igual** a `ROUTE_CATALOG`. Una ruta nueva o eliminada en la API hace fallar la prueba.
3. **Cobertura de códigos:** existe al menos un caso de cada código obligatorio (`200`, `201`, `400`, `401`, `403`, `404`, `409`) y de los adicionales (`412`, `428`). Los casos `403` cubren `RN-02`, `RN-03`, `RN-04` y `RN-05`, y los `409` cubren el email duplicado y la doble aprobación, identificados por nombre.
4. **Higiene:**
   - todas las URL empiezan con `{{baseUrl}}`;
   - no hay JWT literales (`eyJ…`);
   - los tokens van solo como `{{…Token}}`;
   - la única contraseña es la del seed;
   - el entorno no trae valores de tokens.
5. **Ejecución real (pregunta 3):** un mini-intérprete corre la colección **en orden** contra `buildApp({ prisma })` y PostgreSQL, con el seed real de `prisma/seed.ts` (`seedUsers`) y los rate limits desactivados. Su trabajo:
   - sustituye `{{var}}`, `{{#guid}}` y `{{#email}}`;
   - aplica la captura de valores (`json.*`, `header.*`);
   - evalúa la aserción de status de cada pedido.

   Así se garantiza que la colección no solo es válida, sino que **reproduce** los códigos que declara.

### 3.4 Documentación
- **`README.md`:** cómo importar la colección y el entorno, en qué orden ejecutarla, las precondiciones y la advertencia de rate limit.
- **`docs/testing.md`:** el nivel "Aceptación / API" apunta a la colección y a su prueba.
- **`docs/sad.md` §7:** se cierra el pendiente "colección Thunder Client".
- **`CHANGELOG.md`.**

## 4. Fases
### Fase 1 — Triage, calibración del formato y rama · Estado: Hecha
- [x] Resolver §6 (pregunta 1 resuelta: (b), formato nativo conocido).
- [x] Crear la rama desde `main` actualizado.

### Fase 2 — Catálogo compartido · Estado: Hecha
- [x] Mover `ROUTE_CATALOG` a `tests/support/route-catalog.ts`. `private-routes-by-default` sigue en verde.

### Fase 3 — Colección y entorno (§3.1, §3.2) · Estado: Hecha

### Fase 4 — Verificación automatizada (§3.3) · Estado: Hecha

### Fase 5 — Verificación, documentación, auditorías y cierre · Estado: Hecha
Resultado: 60 archivos · 1481 pruebas en verde (secuencial, incluido el aislamiento de la base de pruebas, ver `2026-11-25_test-database-isolation.md`); `dist/` sin tests; sin cambios en `src/`.
- **La colección:** 62 pedidos en 7 carpetas, generados con un script descartable (IDs `uuid5` y fechas deterministas). Se entrega solo el JSON.
- **Ajustes respecto a §3.2:**
  - las aserciones se limitan a `res-code` y `set-env-var`, los únicos tipos de test confirmados en la calibración;
  - el nombre de cada pedido lleva el código esperado (`[200]`), y la prueba verifica que coincide con su test;
  - se quitó el registro con payload inválido para quedar en 3 registros por corrida (límite de 5/h).
- **Mutaciones:**
  - sin los pedidos de `/status` → falla la cobertura;
  - un `428` declarado como `200` → fallan la ejecución y la cobertura de códigos;
  - un JWT literal → falla la higiene.
- [x] `npm run typecheck`, `npm run typecheck:test`, `npm run build` y `npm test` (secuencial).
- [x] Mutaciones:
  - quitar un endpoint de la colección → falla la cobertura;
  - cambiar un status esperado → falla la ejecución;
  - un JWT literal → falla la higiene.
- [ ] Prueba manual de importación en Thunder Client. *Pendiente del humano (no puedo abrir VS Code)*. El humano autorizó entregar sin ella: la colección se valida y se ejecuta completa en `npm test`, y el riesgo residual es solo de formato (`body.raw` como string).
- [x] Documentación, auditorías (`qa-tester`, `security-auditor`, `code-reviewer`) y archivar el plan.

## 5. Riesgos
- **Formato no documentado:** se mitiga calibrando contra una exportación real (pregunta 1) y con la prueba manual de importación.
- **Rate limits en corridas repetidas:** la colección hace 3 registros por corrida contra un límite de 5/h por IP, y los login fallidos cuentan para el límite de 10 cada 15 min. Una segunda corrida dentro de la misma hora puede recibir `429` en `register`. Se documenta, y reiniciar `npm run dev` limpia el store en memoria.
- **Datos acumulados:** cada corrida deja un usuario nuevo y recetas `DRAFT` (la carpeta Cleanup borra las dos recetas principales). Es aceptable en desarrollo.

## 6. Preguntas abiertas
1. **Formato de exportación**, porque no está documentado:
   - (a) exportás desde tu Thunder Client una colección mínima y me la pasás, para replicar las claves exactas: 1 pedido con auth Bearer, header, body JSON, un test de status, un *Set Env Variable* desde `json.` y otro desde `header.`, más su entorno;
   - (b) uso el formato de exportación que conozco, sin verificar;
   - (c) uso Postman v2.1, documentado y que Thunder Client importa, con el nombre pedido.

   *Recomendado: (a). Es la única forma de garantizar que "se importa directamente", que es el primer criterio del ticket.*

   **Calibración real (2026-11-25, Thunder Client 3.2.7 del humano).** La versión gratuita no ofrece exportar colecciones. Lo confirmado:
   - **Entorno:** el exportado tiene `clientName`, `environmentName`, `environmentId`, `dateExported`, `version: "1.2"` y `variables: [{ name, value }]`.
   - **Pedidos:** el almacenamiento interno de la colección (`tc_col_*.json`) confirma su forma:
     - `_id`, `colId`, `containerId`, `name`, `url` (con `{{baseUrl}}`), `method`, `sortNum`, `created`, `modified` y `headers: [{ name, value }]`;
     - `auth: { type: "bearer", bearer: "{{token}}" }`;
     - `tests: [{ type: "res-code", custom: "", action: "equal", value }]` y `[{ type: "set-env-var", custom: "json.data.token" | "header.etag", action: "setto", value: "{{var}}" }]`.

     Así se descarta el esquema de terceros de apis.io.
   - **Sin confirmar:** las claves de cabecera de la colección exportada, que se toman por analogía con el entorno (`clientName`, `collectionName`, `collectionId`, `dateExported`, `version: "1.2"`, `folders`, `requests`), y si `body.raw` va como string (exportación clásica) o como arreglo de líneas (almacenamiento interno v4). Se usa string, y la prueba manual de importación lo valida.

   **Decisión del humano (2026-11-25): (b).** Se usa el formato de exportación nativo conocido. El riesgo de alguna clave distinta en la versión instalada se cubre con la prueba manual de importación de la Fase 5: si algo no se importa, se ajusta.
2. **Alcance:** ¿incluyo `/users/:id/role` y `/status` (13 endpoints), el `ETag` (`412`/`428`) y la carpeta `Users — Administración`? *Recomendado: sí. La colección tiene que reflejar la API actual, y la prueba de cobertura la ata al catálogo real.*
3. **Verificación automatizada:**
   - (a) solo estática (validez, cobertura e higiene), como pide el ticket;
   - (b) además, ejecutar la colección contra la app real con un mini-intérprete.

   *Recomendado: (b). Detecta un caso que ya no produce el código declarado, por ejemplo cuando cambia un orden de guardas.*
4. **Entorno:** ¿publico también `docs/thunder-client-environment.json` (`baseUrl` y variables vacías), o dejo solo `baseUrl` documentado en el `README`? *Recomendado: publicarlo. Importar dos archivos deja la colección lista para **Run All** sin configurar nada a mano.*

## Auditorías (3 subagentes en paralelo, solo lectura y sin tocar la base)
- **security-auditor:** sin VETO.
  - Bajas → **resueltas**:
    - higiene de headers: solo `If-Match` con una variable o un ETag literal;
    - `postgres://`, `JWT_SECRET` y `DATABASE_URL` prohibidos;
    - el `README` aclara "solo local y desechable" y que el limitador nunca se toca en entornos compartidos.
  - Informativa **no aplicada**: guarda de entorno en `truncateAll` antes de vaciar la base. Es previa a este cambio y afecta a todas las suites, así que se propone un ticket aparte.
- **code-reviewer:** aprobado.
  - Bajas → **resueltas**:
    - exactamente un `res-code` por pedido (`.refine`);
    - una variable del sistema no emulada falla con un error explícito, con su prueba de higiene;
    - el intérprete ya no corta la corrida ante una variable sin capturar: la reporta como FALLA y sigue.
  - Nits → **resueltos**:
    - `localhost` y URLs absolutas prohibidos en toda la colección;
    - se eliminó el umbral `> 40`.
- **qa-tester:** apto. Cada uno de los pedidos llega a la guarda que declara su nombre (403 por ownership, 412 contra versión ≥ 4, 409 con el ETag vigente; el 400 de `RN-07` lo produce el servicio, no Zod).
  - Medias:
    - `README` de rate limits impreciso → **resuelto**: ahora cuenta el `429` seguro en el registro y el límite de login;
    - aserciones solo de status → **desvío deliberado y documentado**: solo `res-code`/`set-env-var` están confirmados en Thunder Client 3.2.7, y el contenido lo verifican las E2E de #22.
  - Bajas → **resueltas**:
    - higiene de contraseñas, con una *allowlist* de valores de desarrollo;
    - casos nuevos: login de una cuenta desactivada → `401`, `PUT` con `{}` → `400`, y `PUT`/`approve` de una receta inexistente → `404` (62 pedidos).
  - Informativa: el intérprete arranca con el entorno vacío y Thunder Client lo conserva entre corridas; es más estricto, así que se acepta.
