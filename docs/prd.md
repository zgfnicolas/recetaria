### Identificación del Proyecto

| Campo | Detalles |
| --- | --- |
| **Nombre del Proyecto** | Recetaria (Fase 1: MVP Backend API) |
| **Versión / Revisión** | 1.0.0 |
| **Fecha de Creación** | 06/11/2026 |
| **Estado** | En Revisión |
| **Responsable Técnico** | Facundo Nicolás González |
| **Responsable Estratégico** | Facundo Nicolás González |
| **Fecha de Emisión** | 06/11/2026 |

### 1. Resumen ejecutivo

**1.1. Definición del problema**
Los usuarios finales sufren desinformación nutricional y frustración al buscar recetas que se adapten a sus condiciones de salud específicas (celiaquía, diabetes, etc.) en plataformas genéricas. Al mismo tiempo, los profesionales (nutricionistas y chefs) carecen de un espacio centralizado donde puedan validar contenido, aportar autoridad y construir su reputación digital de forma estructurada.

**1.2. Solución propuesta**
Se desarrollará una API REST escalable que centraliza un motor de recetas. El sistema permitirá a los usuarios buscar, filtrar y publicar recetas, integrando un flujo de validación basado en roles (RBAC) donde profesionales de la salud y la gastronomía auditan y aprueban el contenido. Esto alivia el problema de la desinformación garantizando un catálogo de recetas confiable y clínicamente seguro.

**1.3. Valor diferenciador**
Recetaria es única porque cruza el Contenido Generado por el Usuario (UGC) con un sistema de auditoría profesional estricta. Técnicamente, se diferencia por una arquitectura basada en componentes con Node.js, TypeScript y PostgreSQL (Prisma), garantizando integridad referencial estricta, validaciones de esquema (Zod) previas a la base de datos y un diseño de datos preparado nativamente para escalar hacia una red social interactiva.

### 2. Objetivos y métricas de éxito (KPIs)

| Métrica | Definición | Objetivo (Target) |
| --- | --- | --- |
| **Velocidad de Entrega** | Cumplimiento del alcance funcional para el TP Integrador dentro del plazo estricto. | 100% de los endpoints requeridos en 2 semanas. |
| **Calidad del Código** | Número de defectos detectados en pruebas de integración (Thunder Client / Supertest). | < 5% error rate (Cobertura total de validaciones HTTP 400/401/404). |
| **Rendimiento (P95)** | Latencia máxima en el 95% de las solicitudes de lectura (GET Recipes). | < 150ms |
| **Trazabilidad** | Porcentaje de acciones críticas (aprobación/rechazo de recetas) registradas en auditoría. | 100% |

### 3. Alcance del Producto Mínimo Viable (MVP)

**3.1. Funcionalidades incluidas (En alcance)**

* **Núcleo de negocio:** CRUD completo de recetas con filtrado por parámetros (ej. `?difficulty=EASY`). Gestión de estados de publicación (`DRAFT`, `PENDING_REVIEW`, `APPROVED`).
* **Seguridad:** Registro y autenticación mediante Bcrypt y JWT. Middleware de autorización basado en Roles (RBAC: `USER`, `CHEF`, `NUTRITIONIST`, `ADMIN`).
* **Arquitectura de Datos:** Base de datos relacional PostgreSQL gestionada mediante Prisma ORM, implementando arrays nativos y JSONB para metadatos nutricionales e ingredientes.
* **Observabilidad:** Middlewares de logging de peticiones HTTP en consola y tabla de auditoría (`audit_logs`) para cambios de estado.

**3.2. Fuera de alcance (Exclusiones)**

* Funcionalidades sociales secundarias: Likes, comentarios, seguidores y perfiles de usuario extendidos (reservado para Fase 2).
* Subida física de archivos multimedia a buckets (AWS S3) y validación documental automatizada (KYC) de matrículas profesionales.
* Generador automático de planes alimenticios semanales y listas del supermercado.

### 4. Historias de usuario y prioridades

**4.1. Sistema de priorización**

* **P0 (Crítico):** Bloquea el flujo principal y los requisitos de aprobación del MVP.
* **P1 (Alto):** Flujo secundario de alto valor (roles y auditoría).
* **P2 (Medio):** Mejora la eficiencia (filtros avanzados).
* **P3 (Bajo):** Pulido y casos de borde.

**4.2. Catálogo de historias**

**AUTH-001: [Registro de Usuario Seguro] (P0)**
Como usuario no autenticado,
Quiero registrarme en la plataforma con mi email y contraseña,
Para poder crear y gestionar mis propias recetas.
*Criterios de Aceptación (Gherkin):*

* **Scenario:** Registro exitoso con datos válidos
* **Given** un payload válido con email no registrado y contraseña fuerte
* **When** el sistema procesa la solicitud POST en `/api/auth/register`
* **Then** se crea el usuario, se hashea la contraseña y se retorna un HTTP 201.

**REC-001: [Creación de Receta Base] (P0)**
Como usuario autenticado,
Quiero publicar una nueva receta con sus ingredientes y tiempos,
Para compartirla con la comunidad.
*Criterios de Aceptación (Gherkin):*

* **Scenario:** Creación de receta asignada al autor
* **Given** un token JWT válido en el header
* **When** el usuario envía un POST a `/api/recipes` con el esquema de datos correcto
* **Then** se inserta la receta en estado `DRAFT` vinculada a su `authorId`.

**REV-001: [Aprobación Profesional de Receta] (P1)**
Como Nutricionista o Chef autenticado,
Quiero cambiar el estado de una receta pendiente a "Aprobada",
Para validar su contenido frente a los usuarios finales.
*Criterios de Aceptación (Gherkin):*

* **Scenario:** Validación de permisos en cambio de estado
* **Given** un usuario con rol `USER` que intenta actualizar el `status`
* **When** ejecuta un PUT a `/api/recipes/:id/approve`
* **Then** el middleware intercepta la petición y devuelve un HTTP 403 Forbidden.

### 5. Requisitos técnicos y No Funcionales

**5.1. Arquitectura y Escalabilidad**

* **Arquitectura limpia:** Organización estructurada por componentes (Features: Auth, Users, Recipes). Capas lógicas divididas estrictamente en Rutas, Controladores (manejo HTTP), Servicios (Reglas de negocio puro) y Repositorios (Aislamiento de Prisma ORM).
* **Validaciones:** Esquemas estrictos de entrada y salida utilizando la librería Zod acoplada a middlewares de Express.
* **Base de Datos:** PostgreSQL para garantizar relaciones robustas (ACID), con transacciones atómicas para operaciones que involucren auditoría simultánea.

**5.2. Seguridad y Cumplimiento**

* **Estándares:** JWT sin carga útil sensible (solo IDs y roles), contraseñas ofuscadas con Bcrypt y gestión estricta de secretos mediante variables de entorno (`.env` excluido del control de versiones).
* **Auditoría:** Registro de código con marcas de tiempo automáticas (`updatedAt` a nivel base de datos) y trazabilidad completa mediante el modelo `AuditLog`.

**5.3. Accesibilidad e Internacionalización**

* **Accesibilidad (Backend):** Estructuración del campo `nutritionalInfo` en JSON estructurado para facilitar su posterior consumo por lectores de pantalla y generadores semánticos en el frontend. Mensajes de error HTTP claros y descriptivos.

### 6. Plan de proyecto y hitos críticos

| Hito | Entregable | Fecha Estimada |
| --- | --- | --- |
| **M1: Especificación y Base** | Diseño de base de datos Prisma y configuración del proyecto Node/Express. | Fin Día 3 |
| **M2: Desarrollo Core** | Conexión DB, CRUD de Entidad y Punto de Control 1. | Fin Semana 1 |
| **M3: Seguridad y Reglas** | Autenticación JWT, Middlewares de validación Zod, Filtros y RBAC. | Mediados Semana 2 |
| **M4: Lanzamiento y Entrega** | Pruebas completas en Thunder Client (Casos de éxito y error), README documentado y código pusheado. | Fin Semana 2 |

### 7. Análisis de riesgos y mitigación

* **Técnicos:** Riesgo de *Scope Creep* (intentar abarcar la funcionalidad de red social en la primera fase) que impida llegar a la fecha de entrega del TP.
* *Mitigación:* Congelar estrictamente el esquema de datos según el alcance de este documento. Cualquier funcionalidad social (likes, seguimientos) se enviará directamente al backlog de la Fase 2.


* **Operativos:** Complejidad en la manipulación de arrays y JSONB en PostgreSQL a través de Prisma.
* *Mitigación:* Restringir las operaciones de filtrado iniciales a campos planos indexados (dificultad, categoría) y dejar el parseo avanzado del JSONB de ingredientes para el lado del cliente (Frontend) o futuras iteraciones.

**Responsable del modelo:** Facundo Nicolás González
**Fecha de revisión:** 06/11/2026
**Documentos de referencia:** Trabajo práctico integrador