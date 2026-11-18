#!/usr/bin/env bash
# Referencia Bash equivalente a scripts/hooks/protect-files.mjs para entornos Unix con jq.
set -euo pipefail

payload=$(cat -)
args=$(echo "$payload" | jq -c '.toolCall.args // {}' 2>/dev/null || echo '{}')
sanitized=$(echo "$args" | sed 's/\.env\.example//g')

if echo "$sanitized" | grep -Eiq '(^|["'\''\/])\.env(\b|\.|["'\''])|secrets/|prisma/migrations/|rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)|git\s+push\s+.*(--force|-f)|drop\s+database'; then
  echo '{"decision":"deny","reason":"Recurso o comando protegido (.env, secrets/, migraciones o comando destructivo). Pedí confirmación al usuario."}'
else
  echo '{"decision":"allow"}'
fi
