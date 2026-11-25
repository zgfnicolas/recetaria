import type request from "supertest";
import { expect } from "vitest";

/** Patrones que ninguna respuesta HTTP puede contener (OWASP API3/API8, `RN-08`). */
const SENSITIVE_PATTERNS: readonly Readonly<{ label: string; pattern: RegExp }>[] = [
  { label: "passwordHash", pattern: /passwordHash/i },
  { label: "hash Bcrypt", pattern: /\$2[aby]\$\d{2}\$/ },
  { label: "stack trace", pattern: /(?:\\n|\n)\s+at\s|"stack"\s*:/ },
];

/**
 * Registra cada respuesta de una suite para verificar al final que ninguna expone credenciales,
 * hashes ni *stack traces* (#22). `track` dispara la solicitud (Supertest es perezoso).
 */
export function createExposureRecorder(secrets: readonly string[] = []) {
  const responses: { label: string; res: request.Response }[] = [];
  return {
    track(test: request.Test): Promise<request.Response> {
      const target = `${test.method} ${new URL(test.url).pathname}`;
      return test.then((res) => {
        responses.push({ label: `${target} → ${String(res.status)}`, res });
        return res;
      });
    },
    get count(): number {
      return responses.length;
    },
    assertNoSensitiveExposure(): void {
      for (const { label, res } of responses) {
        const raw = `${JSON.stringify(res.headers)}\n${res.text}`;
        for (const { label: what, pattern } of SENSITIVE_PATTERNS) {
          expect(pattern.test(raw), `${what} expuesto en ${label}`).toBe(false);
        }
        for (const secret of secrets) {
          expect(raw.includes(secret), `secreto expuesto en ${label}`).toBe(false);
        }
      }
    },
  };
}
