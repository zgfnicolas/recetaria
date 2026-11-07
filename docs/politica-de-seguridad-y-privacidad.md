### Identificación del Proyecto

| Campo | Detalles |
| --- | --- |
| **Nombre del Proyecto** | Recetaria (Fase 1: MVP Backend API) |
| **Versión / Revisión** | 1.0.0 |
| **Fecha de Creación** | 07/11/2026 |
| **Estado** | Aprobado / En Implementación |
| **Responsable Técnico** | Facundo Nicolás González |
| **Fecha de Última Revisión** | 07/11/2026 |
| **Recursos** | `schema.prisma`, Trabajo práctico integrador |
| **Fecha de Vigencia** | 07/11/2026 |
| **Oficial de Protección de Datos (DPO)** | Facundo Nicolás González |
| **Ubicación de Servidores y Jurisdicción** | Despliegue en la Nube (Región sugerida: us-east-1 o sa-east-1) / Jurisdicción aplicable: Ley de Protección de Datos Personales (Argentina) y estándares GDPR. |

---

### 1. Principio de privacidad desde el diseño (Privacy by Design)

En cumplimiento con el enfoque *Shift-Left*, la privacidad en Recetaria no es un añadido posterior, sino un requisito nuclear desde la fase de concepción de la arquitectura de la base de datos relacional y el backend.

1. **Minimización de Datos:** Solo se recopilarán los datos estrictamente necesarios. El registro de usuario solo exige `email`, `firstName`, `lastName` y `passwordHash`. No se recopilan direcciones físicas ni teléfonos.
2. **Limitación de la Finalidad:** La tabla de auditoría (`audit_logs`) y el registro de sesiones (`sessions`) con captura de IP se utilizarán exclusivamente para fines de seguridad, trazabilidad de acciones críticas (aprobación de recetas clínicas) y prevención de fraude, no para perfilamiento publicitario.
3. **Transparencia:** Los usuarios que operan bajo los roles `CHEF` o `NUTRITIONIST` son informados de que sus acciones de validación (aprobación de recetas) quedan registradas inmutablemente en el sistema para garantizar la autoridad y responsabilidad del contenido dietario.

### 2. Categorización de datos y base legal

| Categoría de Dato | Ejemplos en Recetaria | Base Legal (GDPR/LPDP) |
| --- | --- | --- |
| **Identificación Básica** | Nombre, Email, ID de Usuario (UUID). | Consentimiento / Ejecución de Contrato (Uso de la App). |
| **Datos Sensibles (Salud)** | Restricciones alimentarias implícitas en las recetas creadas/buscadas (ej. Celiaquía, Diabetes). | Consentimiento Explícito del usuario al interactuar con esos filtros. |
| **Credenciales** | Contraseñas cifradas (Bcrypt Hash), Tokens JWT. | Obligación Legal / Seguridad del Sistema. |
| **Telemetría y Auditoría** | Direcciones IP, User-Agent, logs de aprobación de recetas. | Interés Legítimo / Trazabilidad Profesional. |

### 3. Medidas de seguridad técnica y organizativa

Para mitigar los riesgos de InfoSec y cumplir con los estándares OWASP Top 10, la API de Recetaria implementa:

* **Cifrado Avanzado:** Hashing unidireccional de contraseñas mediante **Bcrypt** con un factor de *salt* elevado. Protección de los datos en tránsito exigiendo que la API se exponga únicamente sobre HTTPS (TLS 1.3).
* **Gestión de Identidad (IAM):** Autenticación *stateless* mediante JSON Web Tokens (JWT). Aplicación estricta de Control de Acceso Basado en Roles (RBAC) validando a nivel de middleware si un usuario es `USER`, `CHEF`, `NUTRITIONIST` o `ADMIN` antes de permitir operaciones mutables.
* **Seguridad de Capa de Aplicación:** Uso de **Zod** para la validación de esquemas estandarizados en el 100% de los endpoints que reciben un *payload*, previniendo ataques de inyección SQL o corrupción del campo `JSONB` de ingredientes.
* **Aislamiento de Entornos:** La cadena de conexión a la base de datos (`DATABASE_URL`) y la semilla criptográfica (`JWT_SECRET`) se inyectan como variables de entorno, prohibiendo su inclusión en el control de versiones.

### 4. Derechos del titular de los datos

El esquema de base de datos y la API están diseñados para que los usuarios puedan ejercer sus derechos fundamentales:

* **Acceso y Portabilidad:** La API REST responde en formato JSON universalmente legible por máquina.
* **Derecho al Olvido:** El diseño de la base de datos implementa restricciones `ON DELETE CASCADE` en las tablas de `sessions`. Si un usuario decide eliminar su cuenta, se destruye automáticamente su acceso. Para preservar la integridad de la comunidad, las recetas de un usuario eliminado pueden anonimizarse (traspasando el `authorId` a un usuario genérico de sistema) o sufrir un *soft-delete*.
* **Rectificación:** Todos los endpoints `PUT` de la entidad de usuarios y recetas permiten la modificación directa y asíncrona por parte del propietario del recurso.

### 5. Gestión de agentes de IA y terceros

En el ecosistema del MVP y proyecciones futuras (Fase 2 y 3), el flujo de datos hacia servicios externos está regulado:

1. **Auditoría de Sub-procesadores:** Cualquier dependencia de terceros (ej. Proveedor de alojamiento de base de datos PostgreSQL, buckets S3 para imágenes) se elige garantizando que cumplen con certificaciones ISO 27001 o SOC 2.
2. **Interacción de IA:** Actualmente la arquitectura no expone datos a LLMs de terceros. Si en el futuro se implementa una IA para validación de macros nutricionales, se aplicará una política de "Zero Data Retention" (Cero retención de datos), enviando únicamente los arrays de `ingredients` anonimizados, despojados de cualquier identificador (`authorId`).

### 6. Procedimiento ante brechas de seguridad

En caso de un acceso no autorizado a la base de datos o fuga de tokens JWT, la organización se compromete a:

1. **Contención Inmediata:** Invalidación de la semilla global `JWT_SECRET` forzando el cierre de sesión masivo y la caída en cascada de los tokens emitidos.
2. **Notificación Técnica:** Identificar la superficie de ataque utilizando los `audit_logs` y la tabla de `sessions`.
3. **Comunicación Legal:** Notificar a la autoridad de control local (AAIP en Argentina) en el plazo exigido y a los titulares de los correos electrónicos filtrados si existe riesgo para su seguridad, sugiriendo el reseteo inmediato de contraseñas.

---

**Responsable del modelo:** Facundo Nicolás González
**Fecha de revisión:** 07/11/2026
**Documentos de referencia:** Trabajo práctico integrador