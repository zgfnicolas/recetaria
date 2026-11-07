#!/usr/bin/env bash
# .claude/hooks/validate-bash.sh
# Event-driven safety hook for Claude Code
# Blocks destructive terminal commands, direct modifications to .env, and dangerous Git operations.

set -euo pipefail

COMMAND="${1:-}"

# Si no se pasó comando como argumento, intentar leerlo de stdin
if [ -z "$COMMAND" ] && [ ! -t 0 ]; then
  COMMAND=$(cat -)
fi

# Si no hay comando para evaluar, permitir
if [ -z "$COMMAND" ]; then
  exit 0
fi

# 1. Bloqueo de eliminación destructiva masiva
if echo "$COMMAND" | grep -Eq '(rm\s+(-[a-zA-Z]*r[a-zA-Z]*f*|-[a-zA-Z]*f[a-zA-Z]*r*)\s+[\/\*])|(rm\s+-rf\s+\.)|(rm\s+-rf\s+\.\.)'; then
  echo "❌ [HOOK BLOQUEADO] Comando destructivo prohibido detectado: '$COMMAND'" >&2
  echo "Detalle: No se permite la eliminación recursiva forzada de raíces o comodines globales." >&2
  exit 1
fi

# 2. Bloqueo de alteración directa de variables de entorno (.env)
if echo "$COMMAND" | grep -Eq '(>\s*\.env(\s|$))|(>>\s*\.env(\s|$))|(rm\s+.*\.env(\s|$))|(sed\s+.*\.env(\s|$))'; then
  echo "❌ [HOOK BLOQUEADO] Intento de modificación directa de archivo .env detectado: '$COMMAND'" >&2
  echo "Detalle: La regla inviolable de gobernanza ('Never') prohíbe tocar el archivo .env." >&2
  exit 1
fi

# 3. Bloqueo de Git push destructivo (force push)
if echo "$COMMAND" | grep -Eq 'git\s+push\s+.*(--force|-f)\b'; then
  echo "❌ [HOOK BLOQUEADO] Forzado de ramas remotas detectado: '$COMMAND'" >&2
  echo "Detalle: 'git push --force' requiere confirmación explícita humana y está restringido." >&2
  exit 1
fi

# 4. Bloqueo de eliminación accidental de base de datos
if echo "$COMMAND" | grep -Eqi 'drop\s+database\b'; then
  echo "❌ [HOOK BLOQUEADO] Comando de destrucción de base de datos detectado: '$COMMAND'" >&2
  exit 1
fi

# Comando seguro
exit 0
