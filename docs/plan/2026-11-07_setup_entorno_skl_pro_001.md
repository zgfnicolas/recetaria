# Plan de Orquestación Activa: Setup del Repositorio Consciente (SKL-PRO-001)

| Metadata | Valor |
| :--- | :--- |
| **Fecha de Inicio** | 07/11/2026 |
| **Código de Skill** | SKL-PRO-001 (v1.1.0) |
| **Responsable Técnico** | Facundo Nicolás González |
| **Agente Ejecutor** | Antigravity AI Engine |
| **Estado Global** | [Implementado] |
| **Flujo de Control** | Human-in-the-Loop (HITL) |

---

## 1. Definición y Alcance

Estructurar el repositorio de **Recetaria (MVP Backend API)** implementando la arquitectura modular de 4 niveles para la optimización de la ventana de contexto de modelos de lenguaje, garantizando trazabilidad, reusabilidad, bajo consumo de tokens y mitigación de desviaciones arquitectónicas.

---

## 2. Fases de Batalla y Registro de Estados

### Fase 1: Setup del Nivel 1 — La Raíz Consciente
- [x] Creación de `llm.txt` con especificación hiper-densa del sistema.
- [x] Creación de `architecture.md` con mapa macro y restricciones de capas.
- [x] Creación de `instructions.md` con directivas canónicas operativas.
- [x] Ajuste de `AGENTS.md` y `README.md` con las referencias del nuevo árbol.
- **Estado de Fase:** [Implementado]
- **Validación Humana (ACK/NACK):** ACK (Aprobado mediante plan inicial)

### Fase 2: Configuración del Nivel 2 — Arsenal Táctico (`.ai/`)
- [x] Inicialización de `.ai/skills/` (`run_tests.md`, `read_logs.md`, `db_migration.md`).
- [x] Inicialización de `.ai/agents_custom/` (`auditor_seguridad.md`, `qa_tester.md`).
- [x] Inicialización de `.ai/prompts/` (`plan_template.md`, `refactor.md`, `unit_test_generation.md`).
- **Estado de Fase:** [Implementado]
- **Validación Humana (ACK/NACK):** ACK (Aprobado mediante plan inicial)

### Fase 3: Despliegue del Nivel 3 — Especificación Técnica (`doc/`)
- [x] Creación de subdirectorios `doc/architecture/`, `doc/rules/`, `doc/modules/`.
- [x] Migración y categorización de los archivos existentes de `docs/` hacia `doc/`.
- [x] Creación de `doc/rules/reglas_de_negocio_recetas.md`.
- [x] Creación de `doc/modules/modulo_auth.md` y `doc/modules/modulo_recipes.md`.
- **Estado de Fase:** [Implementado]
- **Validación Humana (ACK/NACK):** ACK (Aprobado mediante plan inicial)

### Fase 4: Verificación Integral y Cierre DoD
- [x] Validación estática de existencia de archivos de los 4 niveles (26 archivos verificados).
- [x] Validación de ausencia de secretos o credenciales (RNF-03).
- [x] Verificación de enlaces cruzados y consistencia de tipos.
- **Estado de Fase:** [Implementado]
- **Validación Humana (ACK/NACK):** ACK (Aprobado y verificado)
