# Privacidad y cumplimiento

Última actualización: 2026-11-18 · Responsable: Facundo Nicolás González  
Normativa aplicable: [Ley 25.326 de Protección de Datos Personales (Argentina)](https://www.argentina.gob.ar/normativa/nacional/ley-25326-64790) y buenas prácticas OWASP Top 10.

## 1. Principios de privacidad desde el diseño
- **Minimización:** el registro solicita únicamente `email`, `firstName`, `lastName` y `password` (hasheado). No se solicitan ni almacenan domicilios, teléfonos ni documentos de identidad en el MVP.
- **Limitación de finalidad:** `audit_logs` se destina exclusivamente a trazabilidad de aprobaciones, reinicios a borrador y eliminaciones de recetas (`APPROVE`, `RESET_TO_DRAFT`, `DELETE`).
- **Transparencia:** las acciones críticas ejecutadas sobre recetas quedan registradas de forma inmutable en `audit_logs`.

## 2. Clasificación de datos y tratamiento
La referencia de campos sensibles vive en [`data_model.md`](data_model.md#datos-sensibles):

| Categoría | Datos | Base legal / Tratamiento |
|---|---|---|
| Identificación básica | `email`, `firstName`, `lastName`, `id` (UUID) | Ejecución del servicio y consentimiento al registrarse |
| Credenciales | `passwordHash`, tokens JWT stateless | Hash unidireccional Bcrypt (`>= 10` rounds); jamás incluidos en respuestas o logs |
| Salud implícita (dato sensible) | Etiquetas dietarias (`tags`) y `nutritionalInfo` en recetas | Validación estricta Zod; aprobación restringida a perfiles `CHEF` / `NUTRITIONIST` |
| Auditoría | `audit_logs` (`entityId`, `action`, `userId`) | Trazabilidad e integridad operativa del catálogo |

## 3. Controles técnicos y derechos del titular
- **Cifrado y transporte:** despliegue sobre HTTPS (TLS) en producción; secretos (`DATABASE_URL`, `JWT_SECRET`) inyectados exclusivamente vía entorno, nunca versionados.
- **Preservación de trazabilidad e integridad:** el usuario con recetas asociadas impide el borrado físico directo (`ON DELETE RESTRICT`) para proteger autoría; en caso de baja lógica (`isActive = false`) o eliminación de usuario, `audit_logs` conserva el registro histórico con `userId = NULL` (`SET NULL`).
- **Respuesta ante incidentes:** ante sospecha de fuga de tokens JWT, rotar inmediatamente `JWT_SECRET`, auditar `audit_logs`, y notificar según lo establecido ante la AAIP y los usuarios afectados.
