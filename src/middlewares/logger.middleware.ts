import type { RequestHandler } from "express";

export type LogWriter = (line: string) => void;

const CONTROL_CHARS_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

const SENSITIVE_QUERY_KEYS = new Set([
  "token",
  "access_token",
  "refresh_token",
  "password",
  "passwd",
  "secret",
  "authorization",
  "apikey",
  "api_key",
  "key",
]);

function safeDecodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Elimina caracteres de control (prevención de CRLF / log injection) y redacta
 * parámetros de consulta potencialmente sensibles antes de escribir en logs.
 */
export function sanitizeUrlForLog(rawUrl: string): string {
  const withoutControls = rawUrl.replace(CONTROL_CHARS_PATTERN, "");
  const queryIndex = withoutControls.indexOf("?");
  if (queryIndex === -1) {
    return withoutControls;
  }

  const basePath = withoutControls.slice(0, queryIndex);
  const rawQuery = withoutControls.slice(queryIndex + 1);
  if (rawQuery.length === 0) {
    return withoutControls;
  }

  const sanitizedPairs = rawQuery.split("&").map((segment) => {
    const eqIndex = segment.indexOf("=");
    if (eqIndex === -1) {
      return segment;
    }

    const rawKey = segment.slice(0, eqIndex);
    const normalizedKey = safeDecodeComponent(rawKey).trim().toLowerCase();
    return SENSITIVE_QUERY_KEYS.has(normalizedKey) ? `${rawKey}=[REDACTED]` : segment;
  });

  return `${basePath}?${sanitizedPairs.join("&")}`;
}

/**
 * Construye un middleware de logging HTTP seguro (sin headers sensibles ni body).
 * Emite una línea `[ISO_DATE] METHOD /url STATUS DURATIONms` al finalizar la respuesta.
 */
export function createLoggerMiddleware(writeLine: LogWriter = console.log): RequestHandler {
  return (req, res, next) => {
    const startTime = performance.now();
    const safeMethod = req.method.replace(CONTROL_CHARS_PATTERN, "");
    const safeUrl = sanitizeUrlForLog(req.originalUrl || req.url);

    res.once("finish", () => {
      const durationMs = (performance.now() - startTime).toFixed(1);
      writeLine(
        `[${new Date().toISOString()}] ${safeMethod} ${safeUrl} ${String(res.statusCode)} ${durationMs}ms`,
      );
    });

    next();
  };
}

/** Middleware global por defecto de logging HTTP sobre `console.log`. */
export const loggerMiddleware: RequestHandler = createLoggerMiddleware();
