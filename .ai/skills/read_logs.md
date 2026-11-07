# Skill: Lectura y Diagnóstico de Logs (`read_logs`)

| Metadata | Valor |
| :--- | :--- |
| **Identificador** | `skl_read_logs` |
| **Tipo** | Funcionalidad Atómica Ejecutable (Nivel 2) |
| **Herramientas Asociadas** | Consola de Node.js, Morgan / Winston, Errores de Prisma |
| **Estándar** | SKL-PRO-001 |

---

## 1. Propósito y Cuándo Usar

Instruir al agente sobre cómo diagnosticar errores de ejecución a partir de los logs del servidor Express y del motor de base de datos PostgreSQL/Prisma.

---

## 2. Catálogo de Errores Comunes de Prisma

| Código | Significado | Causa Frecuente | Acción Sugerida |
| :--- | :--- | :--- | :--- |
| **`P2002`** | Unique constraint failed | Email duplicado o slug de receta ya existente. | Retornar `409 Conflict` con mensaje claro al cliente. |
| **`P2025`** | Record to update/delete not found | Intentar modificar un ID inexistente. | Retornar `404 Not Found`. |
| **`P2003`** | Foreign key constraint failed | `authorId` o `reviewedById` no apunta a un usuario existente. | Validar existencia de la relación antes de persistir. |

---

## 3. Protocolo de Diagnóstico

1. **Inspección del Código de Estado HTTP:** Verificar si el error fue capturado por el middleware global (`400`, `401`, `403`, `404`, `500`).
2. **Validación de Payloads:** Si el error es `400 Bad Request`, inspeccionar el array `errors` devuelto por el validador de Zod para identificar qué campo incumplió la regla.
3. **Privacidad de Logs:** Ningún log en consola o archivo debe imprimir contraseñas en texto plano, tokens JWT completos ni secretos de entorno.
