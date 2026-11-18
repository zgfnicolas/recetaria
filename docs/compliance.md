# Privacidad y cumplimiento

Última actualización: 2026-11-17 · Responsable: Facundo Nicolás González  
Normativa aplicable: [Ley 25.326 de Protección de Datos Personales (Argentina)](https://www.argentina.gob.ar/normativa/nacional/ley-25326-64790) y buenas prácticas OWASP Top 10.

## 1. Principios de privacidad desde el diseño
- **Minimización:** el registro solicita únicamente `email`, `firstName`, `lastName` y `password` (hasheado). No se solicitan ni almacenan domicilios, teléfonos ni documentos de identidad en el MVP.
- **Limitación de finalidad:** `audit_logs` y `sessions` (`ipAddress`, `userAgent`) se destinan exclusivamente a seguridad, prevención de fraude y trazabilidad clínica/gastronómica de aprobaciones.
- **Transparencia:** las acciones de validación ejecutadas por `CHEF` y `NUTRITIONIST` quedan registradas de forma inmutable en `audit_logs`.

## 2. Clasificación de datos y tratamiento
La referencia de campos sensibles vive en [`data_model.md`](data_model.md#datos-sensibles):

| Categoría | Datos | Base legal / Tratamiento |
|---|---|---|
| Identificación básica | `email`, `firstName`, `lastName`, `id` (UUID) | Ejecución del servicio y consentimiento al registrarse |
| Credenciales | `passwordHash`, tokens JWT | Hash unidireccional Bcrypt (`saltRounds >= 10`); jamás incluidos en respuestas o logs |
| Salud implícita (dato sensible) | Etiquetas dietarias (`tags`) y `nutritionalInfo` en recetas | Validación estricta Zod; revisión restringida a perfiles autorizados |
| Telemetría y auditoría | `sessions.ipAddress`, `sessions.userAgent`, `audit_logs` | Interés legítimo de seguridad y trazabilidad profesional |

## 3. Controles técnicos y derechos del titular
- **Cifrado y transporte:** despliegue sobre HTTPS (TLS) en producción; secretos (`DATABASE_URL`, `JWT_SECRET`) inyectados exclusivamente vía entorno, nunca versionados.
- **Derecho al olvido y preservación de trazabilidad:** eliminar un usuario revoca sus sesiones activas en cascada (`sessions` usa `ON DELETE CASCADE`), mientras las recetas existentes impiden el borrado físico directo (`RESTRICT`) para optar por baja lógica (`isActive = false`) o anonimización, y `audit_logs` conserva el registro con `userId = NULL` (`SET NULL`).
- **Respuesta ante incidentes:** ante sospecha de fuga de tokens, rotar inmediatamente `JWT_SECRET`, auditar `sessions` y `audit_logs`, y notificar según lo establecido ante la AAIP y los usuarios afectados.
