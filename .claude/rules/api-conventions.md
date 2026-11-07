---
description: Convenciones RESTful, versionado y especificación de contratos HTTP para Recetaria API
globs: ["src/modules/**/router.ts", "src/modules/**/controller.ts"]
---

# Convenciones de API y Contratos de Integración

## 1. Versionado y Rutas Base
- Todos los recursos deben exponerse bajo el prefijo canónico de versión: `/api/v1/`.
- Nombres de recursos en plural y minúsculas: `/api/v1/recipes`, `/api/v1/auth`.
- Parámetros de ruta basados estrictamente en UUIDv4: `/api/v1/recipes/:id`.

## 2. Contrato de Respuesta Universal (JSend)
Toda salida debe contener un objeto JSON con los siguientes campos obligatorios:

### Envoltorio de Éxito (2xx)
```typescript
interface JSendSuccess<T> {
  success: true;
  statusCode: 200 | 201;
  message: string;
  data: T;
}
```

### Envoltorio de Error (4xx / 5xx)
```typescript
interface JSendError {
  success: false;
  statusCode: 400 | 401 | 403 | 404 | 409 | 500;
  message: string;
  errors?: Array<{ field?: string; message: string }>;
}
```

## 3. Códigos de Estado Semánticos
- `200 OK`: Petición exitosa de consulta (`GET`), actualización idempotente (`PUT`) o eliminación (`DELETE`).
- `201 Created`: Creación de recurso exitosa (`POST /register`, `POST /recipes`).
- `400 Bad Request`: Payload inválido detectado por middleware Zod o formato UUID incorrecto.
- `401 Unauthorized`: Token ausente, firma inválida o token expirado.
- `403 Forbidden`: Token válido pero rol insuficiente (ej. usuario no profesional intentando aprobar receta).
- `404 Not Found`: Receta o usuario inexistente para el ID provisto.
- `409 Conflict`: Conflicto de restricción única (ej. email duplicado en registro).
- `500 Internal Server Error`: Excepción no controlada en el servidor (capturada sin exponer stack trace en producción).
