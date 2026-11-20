---
name: github-repository-governance
description: >-
  Configura y gobierna el repositorio GitHub de Recetaria API (zgfnicolas/recetaria) como
  código — clasificación SOLO→TEAM→CRITICAL, settings, rulesets JSON para main y tags v*,
  environments staging/production, CODEOWNERS, políticas seguras de GitHub Actions
  (GITHUB_TOKEN read-only, SHA pinning, pull_request_target), despliegue por digest,
  Dependabot agrupado con cooldown (npm/actions/docker), gobernanza de agentes IA,
  releases inmutables con attestations, fallbacks por plan y pruebas de validación.
  Usar al configurar GitHub, rulesets, environments, seguridad del repo o pipelines de deploy.
---

# Gobernanza del Repositorio GitHub (Recetaria API)

Baseline: `zgfnicolas/recetaria` en GitHub.com — perfil inicial **SOLO** (`A0`, `C1`, MVP backend Node.js/Docker) con transición limpia a **TEAM** / **CRITICAL** al incorporar colaboradores o salir a producción.
**Principio rector:** configurar solo controles que reduzcan riesgo o costo real, siempre versionados como código y reproducibles (la UI de GitHub solo sirve para inspeccionar).

## 0. Clasificación y reglas duras (MUST)

Antes de tocar settings, fijar perfil: `SOLO` (`A0`, `C0–C1`), `TEAM` (`A1–A2`, `C1–C2`) o `CRITICAL` (`A2–A3` o `C2–C3`), verificando siempre qué controles soporta el plan y la visibilidad del repo (§2 fallbacks).

**Reglas duras:**
1. Toda configuración vive como código (`.github/rulesets/*.json`, `.github/environments/*.json`, script idempotente con `gh` o Terraform al escalar a decenas de repos); lo no automatizable queda documentado con dueño y fecha.
2. `main` protegida por un ruleset (sin borrado ni force push; squash + checks); tags `refs/tags/v*` protegidos por otro ruleset.
3. Bypass de rulesets **solo** para una GitHub App de release/automatización, nunca para personas ni admins en general.
4. `GITHUB_TOKEN` con permisos `read` por defecto (`permissions:` explícito por job); Actions **nunca** aprueba PRs; SHA pinning obligatorio en `CRITICAL` (recomendado en `TEAM`).
5. Cero credenciales cloud de larga vida si existe OIDC; cero PATs clásicos para automatización (usar GitHub Apps o fine-grained PATs con vencimiento ≤ 90 días).
6. Ambiente `production` restringido a `main` o `v*`, con secretos propios, `concurrency` sin cancelar y `required reviewers` (`prevent_self_review: true`) en `TEAM`/`CRITICAL`.
7. *Push protection* de secretos activo donde el plan lo permita; en su defecto, `gitleaks` obligatorio en CI.
8. Agentes IA (Antigravity, Copilot u otros) tratados como colaboradores externos: sin secretos de producción, bajo los mismos rulesets y **nunca** auto-aprueban ni mergean su propio PR.
9. Trazabilidad punta a punta: `Issue → PR (Closes #) → commit squash → CI run → imagen @sha256 + attestation → deployment → release`.

## 1. Perfiles, rulesets, roles y políticas de Actions

| Control | `SOLO` *(MVP actual)* | `TEAM` | `CRITICAL` |
|---|---|---|---|
| Borrado y force push en `main` | Bloqueado | Bloqueado | Bloqueado |
| Merge a `main` | Squash (`PR_TITLE` + `PR_BODY`), borrado auto de rama | Squash + auto-merge + 1 aprobación + `CODEOWNERS` | + 2 aprobaciones + `required_signatures` + merge queue |
| Status checks requeridos | `ci / verify` + `pr-policy` | + `dependency-review` + CodeQL | + escaneo de contenedores (`Trivy`) |
| `CODEOWNERS` protegido | Recomendado (`/.github/`, `/.agents/`, `/prisma/`, `Dockerfile`) | Obligatorio (por team) | Obligatorio (platform + security) |
| Secretos / vulnerabilidades | Dependabot + `gitleaks` / push protection | + CodeQL + `SECURITY.md` | + SLA formal y bypass auditado |

- **Identidad humana y máquinas:** 2FA obligatorio, commits firmados con SSH, permisos por *team* (≤ 2 admins). Para automatización: GitHub App propia (`actions/create-github-app-token`, token de 1 h y commits verificados).
- **Seguridad en Actions:** prohibido `pull_request_target` salvo política auditada; nunca interpolar `${{ github.event.* }}` dentro de `run:` (pasar siempre vía `env:`); auditar workflows con `actionlint`/`zizmor`.

## 2. Despliegue por digest, Dependabot, fallbacks y validación

- **Estrategia de deploy recomendada para Recetaria:** construir la imagen Docker **una sola vez** por digest (`@sha256:...`) → `staging` automático en push a `main` → `production` con aprobación humana en el environment (o disparo por tag `v*` inmutable). Rollback = `workflow_dispatch` hacia el digest/SHA anterior (nunca reconstruir para prod).
- **Dependabot:** configurado en `.github/dependabot.yml` con **cooldown ≥ 3 días** (14 días en majors) y grupos para `npm`, `github-actions` y `docker`; jamás auto-merge de majors o dependencias de runtime críticas.
- **Fallbacks por plan (Free/privado):** si el plan no incluye *secret scanning*, *code scanning*, *required reviewers* o *attestations* en privados, sustituir con `gitleaks` en CI, `Semgrep`/CodeQL CLI con SARIF, `workflow_dispatch` restringido y firma `Cosign` + SBOM, documentando el riesgo residual.
- **Operación:** ejecutar *drift check* semanal comparando los JSON versionados contra la API y probar los controles negativos (push directo a `main`, check rojo, secreto de prueba, auto-aprobación de deploy).

## 3. Colaboración y delegación

| Necesidad | Skill |
|---|---|
| Convenciones locales de ramas, commits, `.gitattributes`, hooks y `pr-policy.yml` | [git-workflow-engineering](../git-workflow-engineering/SKILL.md) |
| Ejecutar `bootstrap.sh`, consultas y operaciones de GitHub vía `gh` | [github-cli-agentic](../github-cli-agentic/SKILL.md) |
| Imagen por digest `@sha256`, Buildx, Trivy, SBOM y Cosign | [docker-production-containers](../docker-production-containers/SKILL.md) |
| CI base de Node/npm (`npm ci`, `lockfile-lint`, `allowScripts`, cooldown) | [js-project-configuration](../js-project-configuration/SKILL.md) |
| Checks P0 obligatorios y quality gates que exige el ruleset | [critical-path-testing](../critical-path-testing/SKILL.md) |

Para JSONs completos (`default-branch.json`, `release-tags.json`, `production.json`, `security_and_analysis.json`), `bootstrap.sh`, `CODEOWNERS`, `dependabot.yml`, `release.yml`, `deploy.yml` por digest, fallbacks, pruebas de validación, KPIs y **Definition of Done**, consultá [references/governance-patterns.md](./references/governance-patterns.md).
