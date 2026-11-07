# Plantilla de Prompt: Refactorización Atómica Segura

```markdown
Actúa como un Ingeniero de Software Senior en TypeScript y Node.js.
Necesito refactorizar el siguiente componente respetando estrictamente los axiomas del proyecto:

1. ARCHIVO A MODIFICAR: [Ruta absoluta o relativa del archivo]
2. OBJETIVO DEL REFACTOR: [Explicar qué problema de diseño, duplicidad o legibilidad se busca resolver]

RESTRICCIONES INVIOLABLES:
- No modificar los contratos de entrada/salida (la firma pública de la función o endpoint debe ser idéntica).
- Mantener la separación de capas: si es un Servicio, no llamar a Prisma directamente; delegar al Repositorio.
- No introducir dependencias externas adicionales sin autorización.
- Preservar o mejorar el tipado estático con TypeScript estricto.

FORMATO DE RESPUESTA:
- Explicar brevemente el análisis previo de la causa raíz.
- Proveer el diff exacto o bloque de reemplazo listo para aplicar.
- Especificar qué pruebas deben ejecutarse para validar que no hubo regresión.
```
