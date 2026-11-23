# Plan: Corregir el nombre de `agents.md` → `AGENTS.md` (sensibilidad a mayúsculas)

Fecha: 2026-11-23 · Rama: `docs/agents-md-filename-case` · Estado: **En revisión (PR abierto; archivar al mergear)**

## Objetivo
El archivo de contexto raíz está versionado como `agents.md` (minúsculas), pero todo el repositorio lo referencia como `AGENTS.md`. En sistemas con sistema de archivos sensible a mayúsculas (Linux, CI, contenedores) esto rompe:
1. El import `@AGENTS.md` de `CLAUDE.md`: Claude Code no carga las reglas del proyecto de forma automática.
2. Los enlaces relativos `../../../AGENTS.md` de `.agents/skills/*` (docker-production-containers, git-workflow-engineering, github-cli-agentic, orm-persistence-js-ts) y `.github/copilot-instructions.md`.
3. La convención `AGENTS.md` que leen Antigravity, Copilot y Codex.

## Contexto que el agente debe leer
- `agents.md`, `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`
- `CHANGELOG.md` (sección `[Unreleased]`)

## Decisiones propuestas
1. **Renombrar el archivo, no las referencias.** `AGENTS.md` es el estándar de la industria y ya es el nombre usado en 20+ referencias; cambiar el archivo es 1 operación frente a editar todas las referencias.
2. Usar `git mv agents.md AGENTS.md` para preservar el historial (`git log --follow`). En Linux el rename de solo mayúsculas funciona directo (`core.ignorecase` no está activo); se documenta el paso intermedio (`git mv agents.md tmp && git mv tmp AGENTS.md`) para colaboradores en macOS/Windows.
3. Sin cambios de contenido en `AGENTS.md` (su encabezado ya dice `# AGENTS.md`).
4. Fuera de alcance: agregar `.gitattributes` / chequeo de CI contra archivos que difieren solo en mayúsculas (queda como sugerencia para el roadmap de CI/CD Alfa).

## Fases

### Fase 1 — Renombrado · Estado: Hecha
- [x] `git mv agents.md AGENTS.md`
- [x] Verificar que no quede ninguna referencia a `agents.md` en minúsculas: `grep -rn --exclude-dir={node_modules,.git,dist} "agents\.md"` (solo deben aparecer menciones históricas en `docs/plans/archivo/` y la nota de `git-workflow-engineering`)
- [x] Verificar que los enlaces relativos `AGENTS.md` de `.agents/skills/*` y `.github/copilot-instructions.md` resuelvan a un archivo existente
Criterio: `test -f AGENTS.md && ! test -e agents.md` y `git status` muestra `renamed: agents.md -> AGENTS.md`.

### Fase 2 — Registro y verificación · Estado: Hecha
- [x] Agregar entrada en `CHANGELOG.md` → `[Unreleased]` → `### Fixed`: renombrado de `agents.md` a `AGENTS.md` para que `@AGENTS.md` (`CLAUDE.md`) y los enlaces relativos resuelvan en sistemas sensibles a mayúsculas
- [x] Confirmar que el import `@AGENTS.md` de `CLAUDE.md` resuelve: verificado mecánicamente (la ruta relativa a `CLAUDE.md` existe y `git ls-files` lista `AGENTS.md`); validar con `/memory` en una sesión nueva tras el merge
- [x] `npm run build` y `npm test` (sanidad; no se toca código) — build OK, 23 archivos · 428 pruebas en verde
Criterio: CHANGELOG actualizado y el import de `CLAUDE.md` carga el contenido.

### Fase 3 — Entrega · Estado: En curso (aprobada por el usuario)
- [x] Commit: `fix(docs): renombrar agents.md a AGENTS.md para resolver import de CLAUDE.md`
- [x] Push de la rama y PR contra `main` usando `.github/pull_request_template.md`
- [ ] Al mergear, mover este plan a `docs/plans/archivo/`
Criterio: PR abierto y revisado.

## Riesgos
- Clones existentes en macOS/Windows (FS insensible) pueden no reflejar el cambio de mayúsculas tras `git pull`; mitigación: nota en la descripción del PR con `git mv -f agents.md AGENTS.md` o re-clonar.
