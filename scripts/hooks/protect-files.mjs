#!/usr/bin/env node
/**
 * Hook PreToolUse para Antigravity CLI.
 * Lee el evento JSON desde stdin y bloquea acceso a secretos, migraciones
 * o comandos destructivos sin confirmación explícita del usuario.
 */

import fs from 'node:fs';

function allow() {
  process.stdout.write(JSON.stringify({ decision: 'allow' }));
}

function deny(reason) {
  process.stdout.write(JSON.stringify({ decision: 'deny', reason }));
}

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8').trim();
  } catch {
    allow();
    return;
  }

  if (!raw) {
    allow();
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    allow();
    return;
  }

  const toolName = String(payload?.toolCall?.name ?? '').toLowerCase();
  const args = payload?.toolCall?.args ?? {};

  const targetPath = String(
    args.Path ?? args.path ?? args.TargetFile ?? args.file_path ?? ''
  ).trim();
  const commandLine = String(
    args.CommandLine ?? args.command ?? args.cmd ?? ''
  ).trim();

  // 1. Verificación para herramientas de archivos
  if (targetPath) {
    const normalized = targetPath.replace(/\\/g, '/');
    const isEnvExample = /(^|\/)\.env\.example$/i.test(normalized);

    if (!isEnvExample && /(^|\/)\.env(\.|$)/i.test(normalized)) {
      deny('Archivo protegido (.env). La regla Never prohíbe leer o modificar archivos .env reales.');
      return;
    }

    if (/(^|\/)secrets(\/|$)/i.test(normalized)) {
      deny('Carpeta protegida (secrets/). Pedile al usuario que gestione los secretos.');
      return;
    }

    if (/(^|\/)prisma\/migrations(\/|$)/i.test(normalized)) {
      deny('Ruta protegida (prisma/migrations/). Modificar migraciones requiere confirmación explícita del usuario.');
      return;
    }
  }

  // 2. Verificación para herramientas de ejecución de comandos
  if (commandLine) {
    const cmdWithoutEnvExample = commandLine.replace(/\.env\.example\b/gi, '');

    if (/(^|[\s"'`=\/>\\])\.env(\.[^\s"'`\\\/]+)?([\s"'`]|$)/i.test(cmdWithoutEnvExample)) {
      deny('Comando bloqueado: intento de acceso o modificación de .env.');
      return;
    }

    if (/(^|[\s"'`\/\\])secrets[\/\\]|prisma[\/\\]migrations/i.test(commandLine)) {
      deny('Comando bloqueado: acceso a ruta protegida (secrets/ o prisma/migrations/).');
      return;
    }

    if (/\bprisma\s+(migrate\s+(dev|deploy|reset)|db\s+push)\b/i.test(commandLine)) {
      deny('Comando bloqueado: las migraciones de Prisma requieren confirmación explícita del usuario.');
      return;
    }

    if (/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/i.test(commandLine)) {
      deny('Comando destructivo bloqueado (rm -rf). Pedí confirmación al usuario.');
      return;
    }

    if (/\bgit\s+push\b[^\n]*(\s--force\b|\s-f\b)/i.test(commandLine)) {
      deny('Comando destructivo bloqueado (git push --force / -f).');
      return;
    }

    if (/\bdrop\s+database\b/i.test(commandLine)) {
      deny('Comando destructivo bloqueado (DROP DATABASE).');
      return;
    }
  }

  // 3. Respaldo para otras herramientas que pasen rutas en otros campos
  if (!targetPath && !commandLine && toolName) {
    const sanitized = JSON.stringify(args).replace(/\.env\.example\b/gi, '');
    if (/(^|["'\/\\])\.env(\.|$|["'\\\/])|secrets[\/\\]|prisma[\/\\]migrations/i.test(sanitized)) {
      deny('Acceso a recurso protegido (.env, secrets/ o prisma/migrations/).');
      return;
    }
  }

  allow();
}

main();
