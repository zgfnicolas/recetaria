### Identificación del Proyecto

| Campo | Detalles |
| --- | --- |
| **Nombre del Proyecto** | Recetaria (Fase 1: MVP Backend API) |
| **Versión / Revisión** | 1.0.0 |
| **Fecha de Creación** | 06/11/2026 |
| **Estado** | En Revisión |
| **Responsable Técnico** | Facundo Nicolás González |
| **Fecha de Última Revisión** | 06/11/2026 |
| **Recursos** | Trabajo práctico integrador |

### Ficha del Documento

| Fecha | Revisión | Autor | Verificado |
| --- | --- | --- | --- |
| 06/11/2026 | 1.0 | Facundo Nicolás González | Facundo Nicolás González |

---

### 1. Introducción

La ingeniería de requisitos es el proceso fundamental para establecer los servicios que el cliente requiere y los límites operativos del sistema.

**1.1 Propósito**
Definir los objetivos, la estructura y las restricciones técnicas del backend (API RESTful) para el sistema "Recetaria", estableciendo un contrato claro de desarrollo para el cumplimiento de los criterios del Bootcamp y sentando las bases para futuras iteraciones del producto.

**1.2 Alcance**
El producto a desarrollar en esta fase es exclusivamente la capa de servicios backend y la persistencia de datos (MVP). El sistema gestionará la identidad de los usuarios y el ciclo de vida de las recetas, asegurando la consistencia de los datos y exponiendo endpoints seguros para el consumo futuro de aplicaciones cliente (Frontend Web o Mobile).

**1.3 Personal involucrado**

| Nombre | Rol | Responsabilidades |
| --- | --- | --- |
| Facundo Nicolás González | Líder Técnico & Desarrollador | Diseño arquitectónico, modelado de base de datos, programación de la API y pruebas de integración. |
| Equipo Docente (Bootcamp) | Stakeholders / Auditores | Evaluación del cumplimiento de los requisitos del trabajo práctico integrador. |

---

### 2. Descripción general

**2.1 Perspectiva del producto**
Recetaria nace como una solución para combatir la desinformación nutricional y culinaria. En su fase inicial, operará como un sistema centralizado e independiente (Monolito API) construido en Node.js y PostgreSQL, diseñado para integrarse más adelante con clientes front-end y servicios de almacenamiento en la nube (AWS S3).

**2.2 Funcionalidad del producto**
Las funciones principales que el software realizará en esta fase son:

* Gestión de identidades de usuario y control de acceso basado en roles (RBAC: `USER`, `CHEF`, `NUTRITIONIST`, `ADMIN`).
* Operaciones CRUD (Crear, Leer, Actualizar, Eliminar) completas sobre la entidad `Recipe` (Recetas).
* Motor de búsqueda y filtrado de recetas a través de parámetros URL (Query Params).
* Flujo de validación de negocio para la aprobación de recetas por parte de perfiles profesionales.

**2.3 Restricciones, suposiciones y dependencias**

* **Restricciones de tiempo:** El desarrollo y las pruebas deben completarse estrictamente en un plazo de 2 semanas, con un punto de control al finalizar la primera semana.
* **Restricciones tecnológicas:** Uso obligatorio de Node.js, Express, TypeScript, una base de datos relacional (PostgreSQL) gestionada a través de un ORM (Prisma), y validación de esquemas (Zod).
* **Dependencias:** El entorno de ejecución requiere Node.js (v18+). Las variables de entorno (cadenas de conexión a base de datos y secretos JWT) deben estar aisladas y provistas por el entorno de despliegue.

---

### 3. Requisitos Específicos

#### 3.1 Requisitos Funcionales

Definen las acciones fundamentales que el software debe realizar al procesar información y producir resultados.

| ID | Requisito Funcional | Descripción Detallada |
| --- | --- | --- |
| **RF-001** | Gestión de Autenticación y Registro | El sistema permitirá el registro de usuarios y el login emitiendo un JSON Web Token (JWT). |
| **RF-002** | Gestión de Recetas (CRUD) | El sistema expondrá endpoints para la creación, edición, lectura y borrado (solo por el autor) de recetas. |
| **RF-003** | Auditoría y Aprobación de Contenido | El sistema permitirá a usuarios con rol `NUTRITIONIST` o `CHEF` modificar el estado de una receta de `PENDING_REVIEW` a `APPROVED`. |

**Detalle técnico de requisito crítico (RF-001 - Login):**

* **Entradas:** Email y contraseña en texto plano (Payload JSON validado por Zod).
* **Secuencia de operaciones:** Validación de formato Zod -> Búsqueda del usuario por email en Prisma -> Comparación de hash criptográfico usando Bcrypt -> Generación de JWT firmado con `JWT_SECRET` incluyendo `id` y `role` como payload.
* **Salidas:** Confirmación de acceso (HTTP 200) entregando el Token JWT, o rechazo (HTTP 401 Unauthorized) sin revelar si el fallo fue el email o la contraseña.

#### 3.2 Requisitos No Funcionales (RNF)

Restricciones de los servicios o funciones ofrecidas por el sistema.

**3.2.1 Rendimiento y Escalabilidad**

* Tiempo de respuesta inferior a 150 milisegundos para el 95% (P95) de las peticiones de lectura (`GET /api/v1/recipes`).
* Diseño *stateless* (sin estado) para permitir una futura escalabilidad horizontal en balanceadores de carga sin requerir persistencia de sesiones en memoria del servidor.

**3.2.2 Seguridad y Privacidad**

* Almacenamiento de contraseñas de forma unidireccional utilizando el algoritmo de hash Bcrypt con un factor de trabajo (salt rounds) adecuado.
* Protección estricta de rutas de modificación de datos (`POST`, `PUT`, `DELETE`) mediante un middleware decodificador de JWT.
* Implementación del principio de Privilegio Mínimo: Un usuario solo puede editar o eliminar las recetas cuyo `authorId` coincida con su token de sesión.

**3.2.3 Fiabilidad y Disponibilidad**

* Robustez de transacciones (ACID): Las operaciones que impliquen cambios de estado acoplados a registros de auditoría se ejecutarán dentro de bloques `$transaction` de Prisma.
* Manejo global de excepciones: Todos los controladores estarán envueltos en bloques `try/catch` (o *async wrappers*) para interceptar errores fatales y devolver un código HTTP 500 estructurado, evitando la caída (crash) del proceso de Node.js.

**3.2.4 Mantenibilidad y Portabilidad**

* El código fuente seguirá una arquitectura limpia y modularizada por componentes (Carpetas: `routes`, `controllers`, `services`, `repositories`), asegurando el bajo acoplamiento.
* Uso estricto de TypeScript para garantizar el tipado estático durante el tiempo de desarrollo.
* Configuración aislada mediante el uso del paquete `dotenv`. La cadena de conexión `DATABASE_URL` y el secreto `JWT_SECRET` no se incluirán en el repositorio. Se proveerá un archivo `.env.example`.

---

### 4. Apéndices

* **Modelo de Datos Inicial (ERD):** Definido en el archivo `prisma/schema.prisma`.
* **Documentación de API:** Definida mediante exportación de colección de **Thunder Client**, detallando rutas, métodos, *headers* requeridos y respuestas esperadas, listos para pruebas de control de calidad (QA) y auditoría docente.