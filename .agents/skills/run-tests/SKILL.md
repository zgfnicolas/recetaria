---
name: run-tests
description: >-
  Ejecuta las pruebas unitarias e integración de Recetaria API y diagnostica códigos de
  error de Prisma o HTTP. Usar cuando haya que correr tests o depurar fallos de API.
---

# Ejecución de Pruebas y Diagnóstico

## 1. Comandos de ejecución
1. Verificá tipos TypeScript antes de correr tests: `npm run build`.
2. Ejecutá la suite completa: `npm test`.
3. Para pruebas de integración contra Docker: asegurá PostgreSQL arriba con `npm run docker:db`.

## 2. Reglas de aislamiento
- Las pruebas unitarias (`*.service.test.ts`) solo mockean la capa `Repository`.
- Las pruebas de integración deben limpiar datos mutados (`afterEach` / `afterAll`).

## 3. Catálogo rápido de errores de Prisma
| Código | Significado | Causa habitual | Respuesta esperada |
|---|---|---|---|
| `P2002` | Unique constraint failed | Email o `slug` duplicado | `409 Conflict` |
| `P2025` | Record not found | ID inexistente en `update` / `delete` | `404 Not Found` |
| `P2003` | Foreign key failed | `authorId` o `reviewedById` inexistente | `400` o `404` |

## 4. Privacidad en logs
Nunca imprimas contraseñas en texto plano, tokens JWT completos ni cadenas `DATABASE_URL` al diagnosticar errores.
