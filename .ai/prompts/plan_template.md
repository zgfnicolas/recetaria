# Plantilla Canónica de Plan de Orquestación Activa (Nivel 4)

```markdown
# Plan de Orquestación Activa: [Título de la Tarea]

| Metadata | Valor |
| :--- | :--- |
| **Fecha de Inicio** | YYYY-MM-DD |
| **Identificador de Tarea** | [ID-TASK / Issue #] |
| **Responsable Técnico** | Facundo Nicolás González |
| **Agente Ejecutor** | [Nombre del Agente / Modelo] |
| **Estado Global** | [Pendiente / En Progreso / Implementado] |
| **Flujo de Control** | Human-in-the-Loop (HITL) |

---

## 1. Definición y Alcance

[Descripción clara del problema a resolver o de la feature a incorporar, indicando qué está dentro y fuera del alcance].

---

## 2. Fases de Batalla y Registro de Estados

### Fase 1: [Nombre de Fase 1]
- [ ] Tarea atómica 1
- [ ] Tarea atómica 2
- **Estado de Fase:** [Pendiente / En Progreso / Implementado]
- **Validación Humana (ACK/NACK):** Pendiente

### Fase 2: [Nombre de Fase 2]
- [ ] Tarea atómica 1
- [ ] Tarea atómica 2
- **Estado de Fase:** [Pendiente / En Progreso / Implementado]
- **Validación Humana (ACK/NACK):** Pendiente

---

## 3. Criterios de Aceptación (Definition of Done - DoD)
- [ ] Código TypeScript compila sin errores ni tipo 'any'.
- [ ] Cobertura de validaciones Zod para nuevos payloads.
- [ ] Controladores protegidos con try/catch y retorno JSend.
- [ ] Pruebas de integración o colección Thunder Client actualizadas.
- [ ] Documentación en /doc/ sincronizada (cero Context Rot).
```
