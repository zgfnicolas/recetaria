# Plan: estandarización documental y configuración para Antigravity CLI

Fecha: 2026-11-17 · Estado: Completada

## Objetivo
Alinear el repositorio `recetaria` con la Guía de documentación para proyectos de software y la Guía de configuración para Antigravity CLI (`agy`), eliminando duplicación de contexto y configurando `.agents/` de forma nativa.

## Contexto que el agente debe leer
- `AGENTS.md`
- `README.md`
- `docs/prd.md`
- `database_schema_init.sql`

## Fases

### Fase 1 — Archivos de la raíz · Estado: Hecha
- [x] Crear `LICENSE` (MIT) y `CHANGELOG.md`; actualizar `package.json`, `.gitignore` y `.dockerignore`
- [x] Simplificar `README.md` y `CONTRIBUTING.md` con enlaces relativos limpios
- [x] Eliminar `LICENSE.md`, `llm.txt`, `llms-full.txt`, `architecture.md`, `instructions.md`, `CLAUDE.local.md` y `.mcp.json`
Criterio: raíz limpia con enlaces relativos válidos y sin archivos de contexto duplicados.

### Fase 2 — Documentos de negocio en `docs/` · Estado: Hecha
- [x] Unificar requisitos en `docs/prd.md` (incluyendo RNF) y eliminar `docs/srs.md`
- [x] Crear `docs/roles.md` con matriz de permisos (`✓`) y reglas especiales
- [x] Crear `docs/business_rules.md` con reglas numeradas (`RN-01`..`RN-08`), origen y lugar de aplicación
Criterio: cada regla de negocio y rol tiene un único lugar de verdad e ID verificable.

### Fase 3 — Documentación técnica, ADRs y aplanado de `docs/` · Estado: Hecha
- [x] Crear `docs/sad.md` (arc42 en 7 secciones + C4 niveles 1 y 2)
- [x] Crear `docs/data_model.md` (`erDiagram`, diccionario, políticas referenciales y datos sensibles)
- [x] Crear `docs/adr/0000-template.md` y ADRs `0001` a `0004`
- [x] Consolidar `docs/roadmap.md`, `docs/testing.md`, `docs/compliance.md`, `docs/plans/` y limpiar subcarpetas viejas
Criterio: estructura plana en `docs/` sin duplicación ni párrafos conversacionales.

### Fase 4 — Plantillas de gestión en `.github/` · Estado: Hecha
- [x] Crear `.github/pull_request_template.md` y `.github/ISSUE_TEMPLATE/`
- [x] Crear `.github/copilot-instructions.md` apuntando a `AGENTS.md`
Criterio: templates reconocidos por GitHub y puntero en una línea.

### Fase 5 — Configuración de Antigravity CLI · Estado: Hecha
- [x] Actualizar `AGENTS.md` (< 150 líneas), crear `GEMINI.md` y reducir `CLAUDE.md` a `@AGENTS.md`
- [x] Crear reglas en `.agents/rules/` con frontmatter `trigger` válido
- [x] Migrar skills a `.agents/skills/<nombre>/SKILL.md` y subagentes a `.agents/agents/`
- [x] Crear `.agents/hooks.json`, `scripts/hooks/protect-files.mjs`, `.agents/mcp_config.json` y `docs/antigravity-settings.example.json`
Criterio: reglas, skills, subagentes y hooks cumplen el formato nativo de Antigravity CLI.

### Fase 6 — Limpieza final y verificación · Estado: Hecha
- [x] Eliminar carpetas obsoletas `.ai/`, `.claude/`, `.cursor/` y `.devin/`
- [x] Validar JSONs, verificar tamaño de `AGENTS.md` y probar `protect-files.mjs`
Criterio: hook bloquea `.env` y permite `.env.example`; cero enlaces rotos ni JSON inválido.

## Notas de revisión
- Plan aprobado por el usuario con las 3 definiciones: mantener `prd.md`, quitar skills de Prisma Cloud y enfocar el repo 100 % en Antigravity CLI.
