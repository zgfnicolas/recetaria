# Changelog

Todos los cambios notables de este proyecto se documentarán en este archivo.

El formato está basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/),
y este proyecto adhiere a [Versionado Semántico](https://semver.org/lang/es/).

## [Sin publicar]

### Agregado
- Configuración nativa para Antigravity CLI en `.agents/` (reglas modulares, skills, subagentes, hooks `PreToolUse` y `mcp_config.json`), más `GEMINI.md` y `scripts/hooks/protect-files.mjs`.
- Registros de decisiones de arquitectura (`docs/adr/0000-template.md` y `0001` a `0004`).
- Plantillas de Pull Request, Issues y puntero `copilot-instructions.md` en `.github/`.
- Plantilla de permisos y sandbox recomendada en `docs/antigravity-settings.example.json`.

### Cambiado
- Reestructuración plana de `docs/` (`prd.md`, `roles.md`, `business_rules.md`, `sad.md`, `data_model.md`, `roadmap.md`, `testing.md`, `compliance.md`, `plans/`).
- Unificación de requisitos del producto y requisitos no funcionales en `docs/prd.md`.
- Simplificación de `README.md`, `CONTRIBUTING.md`, `AGENTS.md` y `CLAUDE.md` (`@AGENTS.md`).
- Licencia formal en `LICENSE` (MIT) alineada con `package.json`.

### Eliminado
- Archivos redundantes en la raíz (`llm.txt`, `llms-full.txt`, `architecture.md`, `instructions.md`, `CLAUDE.local.md`, `.mcp.json`, `LICENSE.md`).
- Documento duplicado `docs/srs.md` y carpetas obsoletas `.ai/`, `.claude/`, `.cursor/`, `.devin/`.

## [0.1.0] - 2026-11-07

### Agregado
- Arquitectura inicial de contenedores Docker multi-stage (`Dockerfile`, `compose.yaml`, `compose.override.yaml` y `.dockerignore`).
- Esquema SQL inicial de PostgreSQL 15 en `database_schema_init.sql` (`users`, `recipes`, `sessions`, `audit_logs`).
- Documentación fundacional del MVP Backend de Recetaria API y plantilla `.env.example`.
