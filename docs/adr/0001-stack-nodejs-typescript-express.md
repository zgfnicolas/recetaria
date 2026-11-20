# 1. Usar Node.js, TypeScript estricto, Express 5 y Zod para el backend

Fecha: 2026-11-06
Estado: Aceptada *(actualizada parcialmente por [ADR-0006](0006-estandarizacion-esm-prisma7-y-contratos-api.md): Node 24 LTS, ESM nativo y `tsx` en lugar de Node 22 y `ts-node-dev`)*

## Contexto
Recetaria requiere construir una API RESTful segura y mantenible en un plazo académico de 2 semanas (MVP), con validación rigurosa de payloads JSON complejos (`ingredients`, `nutritionalInfo`) y bajo riesgo de errores en tiempo de ejecución.

## Opciones consideradas
1. Node.js 22 + TypeScript estricto + Express 5 + Zod
2. Node.js + JavaScript plano + Express + Joi
3. Python + FastAPI + Pydantic

## Decisión
Usamos Node.js 22 con TypeScript en modo estricto, Express 5 y Zod para validación de esquemas.

## Motivos
- TypeScript estricto sin `any` previene errores de tipos en compilación (`npm run build`).
- Zod unifica la validación en tiempo de ejecución con la inferencia estática de DTOs (`z.infer<typeof schema>`), eliminando duplicación entre interfaces y validadores.
- Express 5 ofrece soporte nativo y maduro para middlewares REST encadenados y compatibilidad directa con el stack del proyecto.

## Consecuencias
- (+) Un solo lenguaje y contrato de tipos compartido entre esquemas Zod, servicios y respuestas HTTP
- (+) Integración directa con Prisma Client y `ts-node-dev` para desarrollo ágil
- (−) Requiere paso de compilación (`tsc`) antes de generar la imagen productiva en Docker
