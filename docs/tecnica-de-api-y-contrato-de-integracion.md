### Identificación del Proyecto

| Campo | Detalles |
| --- | --- |
| **Nombre del Proyecto** | Recetaria (Fase 1: MVP Backend API) |
| **Versión / Revisión** | 1.0.0 |
| **Fecha de Creación** | 06/11/2026 |
| **Estado** | En Revisión |
| **Responsable Técnico** | Facundo Nicolás González |
| **Fecha de Última Revisión** | 06/11/2026 |
| **Recursos** | TP integrador - Tu propia API REST_1.pdf |
| **Versión de la API** | v1 |

### 1. Estándares de comunicación

Para asegurar la interoperabilidad, escalabilidad nativa y cumplir con los criterios de evaluación del Trabajo Práctico Integrador, se adoptan los siguientes estándares para la capa backend:

* **Protocolo:** HTTP/1.1 (preparado para HTTPS con cifrado en tránsito en despliegues cloud).
* **Estilo arquitectónico:** RESTful con arquitectura sin estado (stateless).
* **Formato de intercambio:** JSON (UTF-8) exclusivo para peticiones y respuestas.
* **Documentación viva:** Colección exportada de **Thunder Client** con pruebas documentadas para todos los endpoints (casos de éxito y error), complementario a una especificación OpenAPI 3.0 futura.

### 2. Contrato de respuesta universal (Standard JSend)

Todas las respuestas de la API de Recetaria seguirán una estructura inmutable. Esto facilita el manejo en cualquier consumidor genérico (herramientas de testing, scripts o futuros frontends) y estandariza el manejo de errores capturados por los middlewares:

| Campo | Tipo | Descripción |
| --- | --- | --- |
| `success` | Boolean | `true` para códigos 2xx, `false` para 4xx/5xx. |
| `statusCode` | Number | Código de estado HTTP semántico (ej. 200, 404). |
| `data` | Object / Array | Carga útil (payload) de la respuesta. |
| `message` | String | Descripción legible del resultado para humanos. |
| `errors` | Array | Detalles técnicos o de validación de Zod (opcional, solo en fallos). |

### 3. Seguridad y autenticación

Basado en el principio de "Seguridad por Diseño" y cumpliendo con el requisito de autenticación del TP:

* **Esquema:** `Bearer Token` utilizando JSON Web Tokens (JWT). El consumidor debe enviar el token en el header: `Authorization: Bearer <token>`.
* **Gestión de Secretos:** Algoritmo de firma asimétrica/simétrica respaldado por variables de entorno (archivo `.env` y `JWT_SECRET`).
* **Protección Base:** Encriptación unidireccional de contraseñas mediante **Bcrypt** antes de la inserción en la base de datos.
* **Autorización (RBAC):** Middleware de control de acceso que intercepta y decodifica el JWT, inyectando el usuario en el ciclo de vida de Express (`req.user`) y validando si su `role` permite la acción solicitada.

### 4. Definición de Endpoints y servicios

A continuación se detalla la estructura para la especificación de recursos. El módulo central es `Recipes`, soportado por el módulo de identidad `Auth`.

**4.1. Módulo: Auth (Identidad)**

| Método | Endpoint | Descripción | Roles Requeridos |
| --- | --- | --- | --- |
| POST | `/api/v1/auth/register` | Creación de cuenta y hash de password. | Público |
| POST | `/api/v1/auth/login` | Validación de credenciales y emisión de JWT. | Público |

**4.2. Recurso: Recipes (Recetas)**

| Método | Endpoint | Descripción | Roles Requeridos |
| --- | --- | --- | --- |
| GET | `/api/v1/recipes` | Listado general (Soporta `?difficulty=` y `?status=`). | Público |
| GET | `/api/v1/recipes/{id}` | Obtención de detalle por ID (UUID). | Público |
| POST | `/api/v1/recipes` | Creación de una nueva receta (Inicia en estado `DRAFT`). | USER, CHEF, NUTRITIONIST |
| PUT | `/api/v1/recipes/{id}` | Actualización completa (idempotente). | Owner (Autor de la receta) |
| DELETE | `/api/v1/recipes/{id}` | Eliminación (física en MVP, lógica en Fase 2). | Owner o ADMIN |
| PUT | `/api/v1/recipes/{id}/approve` | **Endpoint de Negocio:** Cambia estado a `APPROVED`. | CHEF, NUTRITIONIST |

### 5. Manejo de errores y códigos de estado

La API utiliza códigos semánticos estrictos para comunicar estados operativos, asegurando el cumplimiento de la rúbrica de evaluación:

* **200 OK:** Solicitud exitosa (usado en GET, PUT, DELETE).
* **201 Created:** Recurso creado exitosamente (usado en POST /register y POST /recipes).
* **400 Bad Request:** Error de validación (esquemas de Zod fallidos, ej. faltan campos o tipos incorrectos, detallado en el array `errors`).
* **401 Unauthorized:** Falta de token, firma inválida o token expirado.
* **403 Forbidden:** Token válido pero permisos insuficientes (ej. un `USER` intentando aprobar una receta).
* **404 Not Found:** El recurso (receta o usuario) solicitado mediante ID no existe en la base de datos.
* **500 Internal Server Error:** Error inesperado en el servidor (ej. base de datos caída). Capturado por el `try/catch` global.

### 6. Versionado y evolución

* **Estrategia:** Versionado explícito en la URL base de Express (router seteado en `/api/v1/`).
* **Depreciación y Cambios:** El diseño basado en PostgreSQL y Prisma asegura que agregar nuevos campos no obligatorios en el futuro (ej. URL de videos) no romperá el contrato de la `v1` ni afectará a los consumidores actuales.

### 7. Guía de integración para consumidores

Dado que esta fase no contempla el desarrollo del frontend, las siguientes directrices están orientadas a cualquier cliente HTTP (como Thunder Client, Postman o scripts cURL) que consuma la API:

1. **Gestión de Estado (Stateless):** La API no guarda sesiones en memoria. El cliente es responsable de almacenar el JWT devuelto en el `/login` y adjuntarlo en el header `Authorization` en cada petición posterior hacia rutas protegidas.
2. **Validación de UUID:** Los parámetros de ruta (`:id`) utilizan UUIDv4. El cliente recibirá automáticamente un `400 Bad Request` si envía un ID con formato inválido antes de que la consulta llegue a la base de datos.
3. **Filtros de Búsqueda:** Para el endpoint `GET /api/v1/recipes`, los parámetros de query (`req.query`) son opcionales pero fuertemente tipados. Ejemplo de integración válida: `GET /api/v1/recipes?difficulty=EASY&status=APPROVED`.

**Responsable del modelo:** Facundo Nicolás González
**Fecha de revisión:** 06/11/2026
**Documentos de referencia:** Trabajo práctico integrador