# Patrones de Gobernanza GitHub para Recetaria API

Referencia versionable de [github-repository-governance](../SKILL.md) adaptada a `zgfnicolas/recetaria` (GitHub Flow, Node.js/npm, Prisma y Docker Compose). Ver también [git-workflow-engineering](../../git-workflow-engineering/SKILL.md), [github-cli-agentic](../../github-cli-agentic/SKILL.md) y [docker-production-containers](../../docker-production-containers/SKILL.md).

---

## 1. Rulesets y Environments como código

### `.github/rulesets/default-branch.json` (perfil TEAM; en SOLO ajustar `required_approving_review_count: 0`)
```json
{
  "name": "default-branch",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": true,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "ci / verify" },
          { "context": "pr-policy / policy" },
          { "context": "dependency-review" }
        ]
      }
    }
  ]
}
```
*(Renombrar un job en CI sin actualizar `required_status_checks` bloquea todos los PRs.)*

### `.github/rulesets/release-tags.json`
```json
{
  "name": "release-tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "bypass_actors": [{ "actor_id": 123456, "actor_type": "Integration", "bypass_mode": "always" }],
  "rules": [{ "type": "creation" }, { "type": "update" }, { "type": "deletion" }]
}
```

### `.github/environments/production.json` y `.github/settings/security_and_analysis.json`
```json
// .github/environments/production.json
{
  "wait_timer": 0,
  "prevent_self_review": true,
  "reviewers": [{ "type": "Team", "id": 7654321 }],
  "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true }
}
```
```json
// .github/settings/security_and_analysis.json
{
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" },
    "secret_scanning_validity_checks": { "status": "enabled" },
    "dependabot_security_updates": { "status": "enabled" }
  }
}
```

---

## 2. Script idempotente de bootstrap (`scripts/github/bootstrap.sh`)

> [!CAUTION]
> Operación **N3 (solo persona con permisos de Admin, fuera del agente)**.

```sh
#!/usr/bin/env sh
# Uso: sh scripts/github/bootstrap.sh zgfnicolas/recetaria
set -eu
REPO="$1"

gh repo edit "$REPO" \
  --enable-issues --enable-wiki=false --enable-projects=false --enable-discussions=false \
  --enable-squash-merge --enable-merge-commit=false --enable-rebase-merge=false \
  --enable-auto-merge --allow-update-branch --delete-branch-on-merge

gh api -X PATCH "repos/$REPO" \
  -f squash_merge_commit_title=PR_TITLE \
  -f squash_merge_commit_message=PR_BODY

gh api -X PUT "repos/$REPO/vulnerability-alerts"
gh api -X PUT "repos/$REPO/automated-security-fixes"
gh api -X PUT "repos/$REPO/private-vulnerability-reporting"
gh api -X PATCH "repos/$REPO" --input .github/settings/security_and_analysis.json

gh api -X PUT "repos/$REPO/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false

for f in .github/rulesets/*.json; do
  name=$(jq -r .name "$f")
  id=$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name==\"$name\") | .id")
  if [ -n "$id" ]; then gh api -X PUT "repos/$REPO/rulesets/$id" --input "$f"
  else gh api -X POST "repos/$REPO/rulesets" --input "$f"; fi
done

for f in .github/environments/*.json; do
  env_name=$(basename "$f" .json)
  gh api -X PUT "repos/$REPO/environments/$env_name" --input "$f"
done
```
*(Al escalar a decenas de repos en una organización, migrar estos JSON a Terraform `integrations/github` o `safe-settings` con custom properties `criticality`/`team`/`lifecycle`.)*

---

## 3. `CODEOWNERS`, `dependabot.yml`, `release.yml` y deploy por digest

### `.github/CODEOWNERS`
```text
*                       @zgfnicolas
/.github/               @zgfnicolas
/.agents/               @zgfnicolas
/scripts/               @zgfnicolas
/Dockerfile             @zgfnicolas
/compose*.yaml          @zgfnicolas
/database_schema_init.sql @zgfnicolas
/prisma/                @zgfnicolas
```
*(Al pasar a `TEAM`, reemplazar handles individuales por `@org/team`.)*

### `.github/dependabot.yml` (alineado a `min-release-age=3` de `js-project-configuration`)
```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule: { interval: weekly, day: monday }
    cooldown: { default-days: 3, semver-major-days: 14 }
    groups:
      prod-minor: { dependency-type: production, update-types: [minor, patch] }
      dev: { dependency-type: development }
    open-pull-requests-limit: 5
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: weekly }
  - package-ecosystem: docker
    directory: /
    schedule: { interval: weekly }
```

### `.github/release.yml`
```yaml
changelog:
  exclude: { labels: [skip-changelog], authors: [dependabot] }
  categories:
    - { title: "Breaking changes", labels: [breaking-change] }
    - { title: "Funcionalidades", labels: [type:feat] }
    - { title: "Correcciones", labels: [type:fix] }
    - { title: "Otros cambios", labels: ["*"] }
```

### Extracto `.github/workflows/deploy.yml` (mismo digest en `staging` → `production`)
```yaml
on:
  push: { branches: [main] }
  workflow_dispatch:
    inputs:
      ref: { description: "SHA o tag a desplegar / rollback", required: false }
permissions: { contents: read }

jobs:
  build:
    uses: ./.github/workflows/image.yml # produce digest @sha256 + Trivy + SBOM/Cosign
    with: { ref: "${{ inputs.ref || github.sha }}" }
  staging:
    needs: build
    environment: { name: staging }
    concurrency: { group: deploy-staging, cancel-in-progress: false }
    permissions: { contents: read, id-token: write }
    runs-on: ubuntu-24.04
    steps:
      - run: sh scripts/deploy.sh staging "${{ needs.build.outputs.digest }}"
  production:
    needs: [build, staging]
    environment: { name: production }
    concurrency: { group: deploy-production, cancel-in-progress: false }
    permissions: { contents: read, id-token: write }
    runs-on: ubuntu-24.04
    steps:
      - run: sh scripts/deploy.sh production "${{ needs.build.outputs.digest }}"
```

---

## 4. Fallbacks según plan, validación, antipatrones y DoD

| Control no incluido en el plan | Fallback verificable |
|---|---|
| Rulesets en repo privado Free | CI obligatorio + revisión documentada + alertas ante pushes directos |
| Secret scanning / push protection | `gitleaks` en `pre-commit` y obligatorio en `pr-policy.yml` |
| Code scanning (CodeQL) | `Semgrep` / CodeQL CLI en CI guardando SARIF como artifact |
| Required reviewers en environments | `workflow_dispatch` acotado + registro en issue de release |
| Artifact attestations en privados | Firma `Cosign` + SBOM adjunto en el release |

**Pruebas de validación de controles:** push directo a `main` rechazado · PR con check rojo bloqueado · secreto de prueba bloqueado por push protection/CI · cambio en `.github/workflows/` exige revisión de `CODEOWNERS` · deploy desde rama no permitida rechazado por environment · auto-aprobación de deploy rechazada (`prevent_self_review`) · tag `v*` protegido y `gh release verify` verde · PR de agente requiere revisión humana · rollback con `workflow_dispatch` probado.

**Antipatrones:** configurar a mano en UI sin JSON/script · bypass para admins · PATs clásicos de una persona en CI · `permissions: write-all` · `${{ github.event.* }}` interpolado en `run:` · reconstruir imagen para producción · deploy sin `concurrency` ni rollback probado · auto-merge de majors de Dependabot · agentes con secretos de prod o auto-aprobándose · repos archivados con secrets activos.

**KPIs y DoD:** `0` drift entre JSON versionados y GitHub · `0` bypasses humanos · `0` workflows con permisos excesivos · `100 %` deployments trazables (commit + digest + aprobador) · `0` PRs de agentes mergeados sin revisión humana · pruebas de validación ejecutadas y registradas.
