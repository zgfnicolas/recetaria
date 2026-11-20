---
name: git-workflow-engineering
description: >-
  Diseña y opera el flujo Git de Recetaria API (GitHub Flow sobre main, Windows y Linux) —
  detección o pregunta obligatoria del idioma, nomenclatura de ramas ASCII, Conventional
  Commits con tipos en inglés y descripción en español, merge por squash, configuración
  multiplataforma (.gitattributes, .editorconfig, .gitmessage), hooks con Husky 9 +
  lint-staged + commitlint + gitleaks replicados en CI (pr-policy.yml), firma SSH,
  trazabilidad issue→commit→PR→release y chuleta de recuperación (reflog, revert, bisect,
  worktree). Usar al configurar Git, hooks, ramas, commits, PRs o resolver incidentes Git.
---

# Ingeniería de Flujo Git (Recetaria API)

Baseline: **GitHub Flow** sobre `main` en `zgfnicolas/recetaria` ([CONTRIBUTING.md](../../../CONTRIBUTING.md)), Node.js/npm, desarrollo en Windows con despliegue Linux en Docker y preparación para Git 2.54+ / 3.0.
**Principio rector:** el workflow existe para reducir el costo de integrar y hacer rastreable cada línea en producción hasta su motivo; si una regla no reduce riesgo ni mejora trazabilidad, sobra.

> [!CAUTION]
> Respetá siempre los límites de [AGENTS.md](../../../AGENTS.md): **no ejecutes `git commit`, `git push`, `git reset`, `git checkout`/`switch` ni comandos que alteren historial sin confirmación humana explícita**.

## 0. Idioma, tono rioplatense y reglas duras (MUST)

- **Convención vigente en Recetaria API ([CONTRIBUTING.md](../../../CONTRIBUTING.md) y `git log`):**
  - **Tokens técnicos en inglés** (leídos por `commitlint`, CI y changelogs): tipos (`feat`, `fix`, `refactor`, `docs`, `test`, `perf`, `build`, `ci`, `chore`, `revert`), footers (`Refs:`, `Closes:`, `BREAKING CHANGE:`) y prefijos de rama (`feat/`, `fix/`, `hotfix/`, `refactor/`, `docs/`, `test/`, `ci/`, `chore/`).
  - **Encabezado del commit en español (presente indicativo uniforme, ≤ 72 caracteres, sin punto final):** ej. `feat(recipes): agrega filtro por dificultad`, `fix(auth): corrige expiración del JWT`, `refactor(recipes): elimina validación duplicada`. No mezcles voseo imperativo (`implementá`) ni pasado impersonal (`se creó`) en el encabezado para conservar un historial uniforme.
  - **Commits detallados en cambios no triviales:** dejá una línea en blanco tras el encabezado y redactá un cuerpo conciso explicando el **porqué**, el impacto y los footers (`Closes: #...`, `Refs: ...`, `BREAKING CHANGE:`).
  - **Ramas con descripción en español ASCII** (`kebab-case`, minúsculas, sin tildes ni `ñ`): ej. `feat/filtro-por-dificultad`, `fix/expiracion-token-jwt`, `docs/actualizar-modelo-datos`.
  - **Voz del proyecto (guías, PRs, `.gitmessage`, checklists y comentarios):** **español formal rioplatense con voseo** (*verificá*, *ejecutá*, *implementá*, *evitá*). Si trabajás en otro repo sin convención documentada, **preguntá siempre el idioma antes de proponer nombres o mensajes**.
- **Reglas duras:**
  1. `main` protegida: sin push directo, sin force push, sin borrado; merge solo vía PR con CI verde.
  2. Ramas temporales cortas (≤ 3 días en GitHub Flow), con propósito claro y borrado automático al mergear.
  3. Commits en Conventional Commits; al usar **squash**, el **título del PR** se convierte en el commit y debe validarse en CI.
  4. Toda regla crítica de hooks locales se repite obligatoriamente en CI (`--no-verify` saltea hooks locales).
  5. Escaneo de secretos en `pre-commit`, en CI (`gitleaks`) y *push protection* en GitHub; un secreto commiteado se **rota de inmediato**, no solo se borra.
  6. `.gitattributes` con normalización LF obligatoria en equipos Windows/Linux; prohibidos archivos que difieran solo en mayúsculas (previene incidentes como `agents.md` vs `AGENTS.md` en Windows).
  7. Nunca reescribas historia pública: en ramas compartidas usá `git revert`, nunca `reset --hard` ni `push --force`.
  8. Release = tag anotado (y firmado si aplica) sobre un commit verde de `main`, trazable al artefacto.

## 1. Workflow, ramas, commits e integración

- **Workflow vigente:** **GitHub Flow** (1 rama permanente `main`, ramas temporales `feat/*`, `fix/*`, `refactor/*`, `docs/*`, `test/*`, `ci/*`, `chore/*`, `hotfix/*` de 1–3 días, merge por **squash**). No adoptes **Git Flow** (`develop`) por inercia en una API con despliegue continuo; evaluá `release/x.y` o Git Flow solo si necesitás sostener múltiples versiones simultáneas en producción.
- **Nomenclatura de ramas:** `<prefijo-en>/<ticket-opcional>-<descripcion-es-ascii>` — minúsculas, ASCII sin tildes ni `ñ`, ≤ 60 caracteres, sin nombres de personas.
- **Commits:** commiteá seguido en local como puntos de guardado y curá antes del PR (`git add -p`, `--fixup` + `rebase -i --autosquash`, sin mezclar formateo masivo con lógica). En cambios relevantes usá commits detallados (encabezado + cuerpo + footers). PR ideal ≤ 400 líneas (sin generados).
- **Integración:** actualizá tu rama propia con `git fetch && git rebase origin/main` y subí con `git push --force-with-lease --force-if-includes`; en ramas compartidas usá `git merge origin/main`.

## 2. Multiplataforma (Windows↔Linux), hooks y recuperación

- **Multiplataforma:** `.gitattributes` (`* text=auto eol=lf`, `*.ps1`/`*.bat`/`*.cmd` en `crlf`, `package-lock.json -diff linguist-generated`), `core.autocrlf=false`, `core.longpaths=true` en Windows y permiso `+x` en scripts `sh` (`git update-index --chmod=+x`).
- **Hooks JS/TS:** **Husky 9 + `lint-staged` + `commitlint` + `gitleaks`** (`pre-commit` < 5 s, `commit-msg` < 1 s, `pre-push` valida nombre de rama y checks rápidos < 60 s), replicados al 100 % en `.github/workflows/pr-policy.yml`.
- **Seguridad y firma:** firma SSH (`gpg.format=ssh`), `.gitignore` bloqueando `.env*` (salvo `.env.example`), `secrets/`, `*.pem`/`*.key` y `safe.bareRepository=explicit`.
- **Recuperación:** error local → `commit --amend` o `reset --soft HEAD~1`; error publicado → `git revert <sha>`; pérdida por reset/rebase → `git reflog`; regresión → `git bisect run`; trabajo paralelo → `git worktree`.

## 3. Colaboración y delegación

| Necesidad | Skill |
|---|---|
| Rulesets de `main` y tags `v*`, `CODEOWNERS`, políticas Actions y deploy | [github-repository-governance](../github-repository-governance/SKILL.md) |
| Ejecutar operaciones de Git/GitHub con `gh` bajo niveles N0–N3 | [github-cli-agentic](../github-cli-agentic/SKILL.md) |
| `package.json`, `npm ci`, CI base y Dependabot/Renovate | [js-project-configuration](../js-project-configuration/SKILL.md) |
| Status checks obligatorios y quality gates de testing en PR | [critical-path-testing](../critical-path-testing/SKILL.md) |

Para archivos completos (`.gitattributes`, `.editorconfig`, `.gitmessage`, `commitlint.config.mjs`, `check-branch-name.sh`, Husky, `pr-policy.yml`, `~/.gitconfig`), chuleta de recuperación, antipatrones, KPIs y **Definition of Done**, consultá [references/git-patterns.md](./references/git-patterns.md).
