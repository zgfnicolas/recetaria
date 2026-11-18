---
trigger: glob
globs: "src/modules/**/*.ts, src/middlewares/**/*.ts"
description: "Convenciones para endpoints REST, formato JSend, códigos HTTP y validación Zod."
---

# Convenciones de API y Contratos HTTP

## 1. Versionado y Rutas
- Exponer todos los endpoints bajo el prefijo `/api/v1/` con nombres en plural y minúsculas (`/api/v1/auth`, `/api/v1/recipes`).
- Validar parámetros `:id` como UUIDv4 mediante Zod antes de llegar al controlador.
- Orden de middlewares en rutas protegidas: `validateMiddleware` -> `authMiddleware` -> `rbacMiddleware([roles])`.
- Verificar los permisos por rol y reglas de propiedad según `docs/roles.md`.

## 2. Contrato de Respuesta JSend
Todas las respuestas devuelven exactamente esta estructura:
- **Éxito (`200`, `201`):** `{ "success": true, "statusCode": 200 | 201, "message": "...", "data": ... }`
- **Error (`400`, `401`, `403`, `404`, `409`, `500`):** `{ "success": false, "statusCode": 4xx | 500, "message": "...", "errors": [{ "field": "...", "message": "..." }] }`

## 3. Códigos HTTP Semánticos
- `200 OK`: `GET`, `PUT`, `DELETE` exitosos.
- `201 Created`: `POST /api/v1/auth/register` y `POST /api/v1/recipes`.
- `400 Bad Request`: fallo de validación Zod (body, query o params).
- `401 Unauthorized`: token ausente, expirado o firma inválida; credenciales inválidas en login.
- `403 Forbidden`: rol no autorizado o usuario distinto de `authorId` (o auto-aprobación `RN-05`).
- `404 Not Found`: recurso inexistente (`P2025`).
- `409 Conflict`: violación de restricción única (`P2002`, email o slug duplicado).
- `500 Internal Server Error`: error inesperado sin exponer *stack trace* en producción.
