# Plantilla de Prompt: Generación de Pruebas Unitarias

```markdown
Actúa como un Especialista en QA y Testing de APIs en Node.js con TypeScript.
Necesito generar una suite de pruebas unitarias para el siguiente servicio o función:

1. ARCHIVO A PROBAR: [Ruta del servicio/función, ej. src/modules/recipes/recipe.service.ts]
2. CASOS DE PRUEBA REQUERIDOS:
   - Caso exitoso con entradas válidas (Happy Path).
   - Casos de validación fallida (Bad Request / Zod schemas).
   - Casos de restricción de permisos o rol insuficiente (Forbidden).
   - Casos de entidad inexistente (Not Found).

RESTRICCIONES TÉCNICAS:
- Framework: Vitest o Jest con Supertest.
- Mocking: Mockear únicamente la capa inferior inmediata (Repository), nunca la lógica de negocio del servicio.
- Aserciones: Verificar explícitamente tanto el valor retornado como las excepciones lanzadas con sus códigos semánticos.
- Ubicación del archivo de prueba: Junto al archivo fuente (ej. `recipe.service.test.ts`).

FORMATO DE ENTREGA:
- Código completo de la prueba en TypeScript estricto, sin any, con tipado de mocks explícito.
```
