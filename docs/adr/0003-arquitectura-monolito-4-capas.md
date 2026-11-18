# 3. Adoptar monolito modular en 4 capas con aislamiento de Prisma

Fecha: 2026-11-06
Estado: Aceptada

## Contexto
El backend del MVP será desarrollado y revisado con apoyo de agentes de IA y debe facilitar pruebas unitarias de la lógica de negocio sin acoplar los controladores HTTP ni los servicios al cliente de base de datos.

## Opciones consideradas
1. Monolito modular en 4 capas (`Router -> Controller -> Service -> Repository`)
2. Controladores directos con llamadas a Prisma en las rutas
3. Microservicios separados (`auth-service`, `recipes-service`)

## Decisión
Adoptamos un monolito modular organizado por componente funcional (`src/modules/auth/`, `src/modules/recipes/`) en 4 capas estrictas, restringiendo el uso de Prisma Client exclusivamente a la capa `Repository`.

## Motivos
- Evita la complejidad operativa y de red innecesaria de microservicios en un MVP de 2 semanas.
- Aislar Prisma en `Repository` permite testear `Service` de forma unitaria mockeando únicamente el repositorio.
- Define fronteras claras (`AGENTS.md` y `.agents/rules/`) que previenen código espagueti cuando trabajan múltiples desarrolladores o agentes.

## Consecuencias
- (+) Alta cohesión por módulo y bajo acoplamiento respecto al motor ORM
- (+) Pruebas unitarias rápidas en servicios sin depender de base de datos real
- (−) Mayor cantidad de archivos y boilerplate inicial por cada recurso REST
