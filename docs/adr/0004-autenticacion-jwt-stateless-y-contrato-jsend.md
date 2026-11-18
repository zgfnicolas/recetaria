# 4. Autenticación JWT stateless y contrato de respuesta JSend extendido

Fecha: 2026-11-06
Estado: Aceptada

## Contexto
La API será consumida por colecciones de Thunder Client, pruebas automatizadas con Supertest y futuros clientes web/mobile. Se necesita un esquema de autenticación sin estado en servidor y un formato homogéneo de respuestas de éxito y error.

## Opciones consideradas
1. Bearer JWT stateless + sobre JSON JSend extendido (`{ success, statusCode, message, data/errors }`)
2. Sesiones con cookies en memoria / Redis + respuestas JSON ad-hoc por endpoint
3. OAuth2 completo con servidor de identidad externo

## Decisión
Usamos tokens Bearer JWT firmados (`{ id, role }`) validados por middleware y un contrato único JSend extendido para todas las respuestas HTTP de la API.

## Motivos
- El diseño stateless evita infraestructura adicional (Redis) en la Fase 1 y habilita escalado horizontal futuro.
- El sobre JSend estandariza cómo el cliente y los tests interpretan códigos `200`, `201`, `400`, `401`, `403`, `404`, `409` y `500`, especialmente los arrays de errores de validación de Zod.

## Consecuencias
- (+) Cualquier consumidor HTTP parsea respuestas exitosas y fallos con el mismo esquema
- (+) Simplicidad para probar RBAC en Thunder Client y Supertest
- (−) Los access tokens JWT emitidos no se invalidan hasta su expiración salvo rotación de `JWT_SECRET` (mitigado con expiración acotada y tabla `sessions` para refresh tokens)
