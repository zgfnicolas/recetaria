# Patrones de Flujo Git para Recetaria API

Referencia ejecutable de [git-workflow-engineering](../SKILL.md) adaptada a **Recetaria API** (Node.js/npm, GitHub Flow sobre `main`, Windows + Docker Linux, commits con tipos en inglés y descripción en español). Ver también [github-repository-governance](../../github-repository-governance/SKILL.md) y [github-cli-agentic](../../github-cli-agentic/SKILL.md).

---

## 1. `.gitattributes`, `.editorconfig` y `.gitmessage`

### `.gitattributes` (fuente de verdad de finales de línea Windows ↔ Linux)
```gitattributes
# Normalizar archivos de texto a LF en el repositorio y en disco
* text=auto eol=lf

# Scripts nativos de Windows requieren CRLF
*.bat text eol=crlf
*.cmd text eol=crlf
*.ps1 text eol=crlf

# Binarios sin conversión ni diff de texto
*.png   binary
*.jpg   binary
*.pdf   binary
*.zip   binary
*.woff2 binary

# Lockfile versionado sin ruido en diffs de PR
package-lock.json -diff linguist-generated
```
*(Al introducirlo en un repo existente: `git add --renormalize .` en un commit dedicado y registrar ese SHA en `.git-blame-ignore-revs`.)*

### `.editorconfig`
```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space
indent_size = 2

[*.{bat,cmd,ps1}]
end_of_line = crlf
```

### `.gitmessage` (`git config commit.template .gitmessage`)
```text
# <tipo>(<alcance>): <verbo en presente indicativo + descripción en español, ≤ 72 caracteres, sin punto final>
# Ej.: feat(recipes): agrega filtro por dificultad y tiempo máximo
#
# Explicá el porqué del cambio y su impacto (no repitas el diff).
# - Detallá las reglas de negocio afectadas (ej. RN-04, RN-06) o decisiones técnicas.
# - Indicá cómo verificaste el cambio si aporta contexto al historial.
#
# Closes: #0
# Refs: RN-00
# BREAKING CHANGE: <qué deja de funcionar y cómo migrar>
#
# Tipos: feat fix perf refactor test docs build ci chore revert
# Alcances Recetaria: auth recipes db docker ci docs agents deps
# Nota: no uses voseo imperativo ("implementá") ni pasado pasivo ("se creó") en el encabezado;
# usá presente indicativo uniforme (agrega, corrige, diseña, modifica, elimina, implementa).
```

### Catálogo de commits detallados y ramas en español ASCII (Recetaria API)

| Tipo de cambio | Rama recomendada (GitHub Flow, ASCII) | Ejemplo de commit detallado |
|---|---|---|
| Nueva funcionalidad | `feat/filtro-recetas-por-dificultad` | `feat(recipes): agrega filtro por dificultad en listado público` |
| Corrección de bug | `fix/expiracion-token-jwt` | `fix(auth): corrige validación de expiración y algoritmo HS256` |
| Refactor interno | `refactor/validacion-politicas-recetas` | `refactor(recipes): elimina lógica duplicada de permisos en servicio` |
| Documentación | `docs/actualizar-modelo-datos` | `docs(db): diseña diagrama y tabla de constraints de auditoría` |
| Docker / Infra | `chore/endurecer-imagen-produccion` | `chore(docker): modifica stage production para código solo lectura` |

```text
feat(recipes): implementa aprobación atómica con auditoría

Coordina la actualización de estado DRAFT -> APPROVED en recipes y la
inserción del registro APPROVE en audit_logs dentro de prisma.$transaction
para cumplir RN-06 y evitar inconsistencias ante fallos intermedios.

- Bloquea auto-aprobación (RN-05) y roles no profesionales (RN-04) con 403.
- Usa update condicional atómico para devolver 409 ante carreras concurrentes.

Closes: #14
Refs: RN-04, RN-05, RN-06
```

---

## 2. Validación de ramas y commits (`commitlint` + Husky 9 + CI)

### `commitlint.config.mjs`
```js
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "header-max-length": [2, "always", 72],
    "subject-case": [0], // Permite nombres propios/siglas en español (JWT, RBAC, Prisma)
    "scope-enum": [1, "always", ["auth", "recipes", "db", "docker", "ci", "docs", "agents", "deps", "scope"]],
    "footer-max-line-length": [0],
  },
};
```

### `scripts/check-branch-name.sh` (POSIX — funciona en Git Bash Windows y Linux)
```sh
#!/usr/bin/env sh
set -eu
branch="${GITHUB_HEAD_REF:-$(git rev-parse --abbrev-ref HEAD)}"
pattern='^(main|(feat|fix|hotfix|refactor|perf|docs|test|build|ci|chore|experiment)/[a-z0-9]+(-[a-z0-9]+)*|release/[0-9]+\.[0-9]+)$'
echo "$branch" | grep -Eq "$pattern" || { echo "Nombre de rama inválido: $branch"; exit 1; }
```
*(Asegurar permiso ejecutable en Windows: `git update-index --chmod=+x scripts/check-branch-name.sh`.)*

### Hooks locales (Husky 9 + `lint-staged` + `gitleaks`)
```sh
# .husky/pre-commit (< 5 s)
npx --no-install lint-staged
gitleaks git --pre-commit --staged --redact --no-banner

# .husky/commit-msg (< 1 s)
npx --no-install commitlint --edit "$1"

# .husky/pre-push (< 60 s)
sh scripts/check-branch-name.sh
```

### Réplica obligatoria en CI (`.github/workflows/pr-policy.yml`)
```yaml
name: pr-policy
on:
  pull_request:
    types: [opened, edited, synchronize, reopened]
permissions:
  contents: read
  pull-requests: read

jobs:
  policy:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@<commit-sha>
        with:
          fetch-depth: 0
          persist-credentials: false
      - name: Validar nombre de rama
        run: sh scripts/check-branch-name.sh
      - name: Validar título del PR (commit de squash)
        env:
          TITLE: "${{ github.event.pull_request.title }}"
        run: |
          printf '%s\n' "$TITLE" | grep -Eq '^(feat|fix|perf|refactor|test|docs|build|ci|chore|revert)(\([a-z0-9-]+\))?!?: .{1,72}$'
      - name: Validar commits del PR
        run: npx --no-install commitlint --from "${{ github.event.pull_request.base.sha }}" --to "${{ github.event.pull_request.head.sha }}"
      - name: Escanear secretos en el rango del PR
        run: gitleaks git --log-opts="${{ github.event.pull_request.base.sha }}..${{ github.event.pull_request.head.sha }}" --redact
      - name: Detectar colisiones de mayúsculas y nombres inválidos en Windows
        run: |
          test -z "$(git ls-files | sort -f | uniq -di)"
          ! git ls-files | grep -Eiq '(^|/)(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|/|$)|[<>:"|?*]|[ .]$'
      - uses: actions/dependency-review-action@<commit-sha>
```

---

## 3. `~/.gitconfig` base recomendada (Windows / Linux / macOS)

```ini
[init]
    defaultBranch = main
[core]
    autocrlf = false
    longpaths = true                  # imprescindible en Windows
    fsmonitor = true
[commit]
    gpgsign = true
    verbose = true
[tag]
    gpgsign = true
    sort = version:refname
[gpg]
    format = ssh
[pull]
    ff = only
[fetch]
    prune = true
    pruneTags = true
    fsckObjects = true
[transfer]
    fsckObjects = true
[push]
    default = simple
    autoSetupRemote = true
    followTags = true
[rebase]
    autoSquash = true
    autoStash = true
    updateRefs = true
[merge]
    conflictStyle = zdiff3
[rerere]
    enabled = true
    autoUpdate = true
[diff]
    algorithm = histogram
    colorMoved = default
[safe]
    bareRepository = explicit
```

---

## 4. Chuleta de recuperación, hotfixes y Git 3.0

| Situación | Comando seguro |
|---|---|
| Descartar cambios locales de un archivo | `git restore <ruta>` |
| Sacar del stage sin perder ediciones | `git restore --staged <ruta>` |
| Corregir último commit local (no pusheado) | `git commit --amend` |
| Deshacer último commit local conservando cambios | `git reset --soft HEAD~1` |
| Revertir commit ya publicado en `main` | `git revert <sha>` |
| Rescatar commit perdido tras reset/rebase | `git reflog` → `git switch -c rescate <sha>` |
| Encontrar commit que introdujo regresión | `git bisect start` → `bad` / `good <ref>` → `git bisect run <script>` |
| Trabajar en un hotfix sin tocar el árbol actual | `git worktree add ../recetaria-hotfix fix/urgente` |
| Limpiar ramas locales ya mergeadas | `git fetch --prune` y borrar ramas mergeadas distintas de `main` |
| Secreto commiteado por error | **1.** Rotar credencial ya · **2.** `git filter-repo` coordinado si aplica · **3.** Invalidar cachés |

- **Hotfix en GitHub Flow:** rama `fix/<desc>` desde `main` → PR con label `hotfix` → CI verde → squash a `main` → tag/deploy (*fix-forward*).
- **Preparación Git 3.0:** no asumir hashes de 40 caracteres ni leer `.git/refs/` como archivos en scripts (SHA-256 + `reftable`), y mantener `safe.bareRepository=explicit`.

---

## 5. Antipatrones, KPIs y Definition of Done

- **Antipatrones:** ramas con mayúsculas/tildes/`ñ` · traducir `feat:`/`fix:`/`Refs:` rompiendo parsers · squash sin validar título del PR · hooks locales como única barrera · scripts sh con CRLF · colisiones de mayúsculas en Windows · `push --force` o `rebase` en ramas compartidas · `reset --hard` sin revisar `status`/`reflog` · borrar un secreto en un commit nuevo sin rotarlo · tokens en URLs de remotes.
- **KPIs:** `0` pushes directos/force a `main` · `0` secretos post-merge · vida media de ramas `< 2 días` · `100 %` commits/títulos válidos · `0` colisiones de nombres Windows.
- **Definition of Done:** idioma documentado en `CONTRIBUTING.md` · `.gitattributes`, `.editorconfig`, `.gitignore`, `.gitmessage` y `pull_request_template.md` consistentes · hooks instalados y replicados al 100 % en `pr-policy.yml` · ruleset activo en `main` (ver [github-repository-governance](../../github-repository-governance/SKILL.md)).
