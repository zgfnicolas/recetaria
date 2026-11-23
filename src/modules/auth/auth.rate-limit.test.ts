import type { Request } from "express";
import { describe, expect, it } from "vitest";
import {
  AUTH_RATE_LIMIT_EXCEEDED_MESSAGE,
  DEFAULT_AUTH_LOGIN_ACCOUNT_RATE_LIMIT,
  DEFAULT_AUTH_LOGIN_IP_RATE_LIMIT,
  DEFAULT_AUTH_REGISTER_RATE_LIMIT,
  loginAccountRateLimitKey,
} from "./auth.rate-limit.js";

function requestWithBody(body: unknown): Request {
  return { body } as Request;
}

describe("Políticas de rate limit de /auth (#39)", () => {
  it("define 10 fallidos por IP y 20 por cuenta cada 15 minutos, y 5 registros por hora", () => {
    expect(DEFAULT_AUTH_LOGIN_IP_RATE_LIMIT).toEqual({
      windowMs: 900_000,
      limit: 10,
      identifier: "auth-login-ip",
      countOnlyFailures: true,
      ignoreRateLimitedResponses: true,
      message: AUTH_RATE_LIMIT_EXCEEDED_MESSAGE,
    });
    expect(DEFAULT_AUTH_LOGIN_ACCOUNT_RATE_LIMIT).toEqual({
      windowMs: 900_000,
      limit: 20,
      identifier: "auth-login-account",
      countOnlyFailures: true,
      exposeHeaders: false,
      message: AUTH_RATE_LIMIT_EXCEEDED_MESSAGE,
    });
    expect(DEFAULT_AUTH_REGISTER_RATE_LIMIT).toEqual({
      windowMs: 3_600_000,
      limit: 5,
      identifier: "auth-register-ip",
      message: AUTH_RATE_LIMIT_EXCEEDED_MESSAGE,
    });
    for (const policy of [
      DEFAULT_AUTH_LOGIN_IP_RATE_LIMIT,
      DEFAULT_AUTH_LOGIN_ACCOUNT_RATE_LIMIT,
      DEFAULT_AUTH_REGISTER_RATE_LIMIT,
    ]) {
      expect(Object.isFrozen(policy)).toBe(true);
    }
  });

  it("usa un mensaje genérico que no revela si la cuenta existe (RN-08)", () => {
    expect(AUTH_RATE_LIMIT_EXCEEDED_MESSAGE).toBe("Demasiados intentos, intentá nuevamente más tarde");
  });
});

describe("loginAccountRateLimitKey (#39)", () => {
  it("normaliza el email como emailFieldSchema: mayúsculas y espacios comparten clave", () => {
    // Act
    const keys = ["ana@recetaria.com", "  ANA@Recetaria.COM ", "Ana@recetaria.com"].map((email) =>
      loginAccountRateLimitKey(requestWithBody({ email, password: "x" })),
    );

    // Assert
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^login-account:[0-9a-f]{64}$/);
  });

  it("emails distintos producen claves distintas", () => {
    expect(loginAccountRateLimitKey(requestWithBody({ email: "a@recetaria.com" }))).not.toBe(
      loginAccountRateLimitKey(requestWithBody({ email: "b@recetaria.com" })),
    );
  });

  it("no guarda el email en claro en la clave (store en memoria, Ley 25.326)", () => {
    // Act
    const key = loginAccountRateLimitKey(requestWithBody({ email: "victima@recetaria.com" }));

    // Assert
    expect(key).not.toContain("victima");
    expect(key).not.toContain("recetaria");
  });

  it.each([
    ["cuerpo ausente", undefined],
    ["cuerpo null", null],
    ["cuerpo no objeto", "email=a@b.com"],
    ["sin email", { password: "x" }],
    ["email numérico", { email: 123 }],
    ["email arreglo", { email: ["a@recetaria.com"] }],
    ["email vacío", { email: "   " }],
    ["email de más de 255 caracteres", { email: `${"a".repeat(250)}@recetaria.com` }],
  ])("devuelve undefined con %s (solo aplica el límite por IP)", (_label, body) => {
    expect(loginAccountRateLimitKey(requestWithBody(body))).toBeUndefined();
  });

  it("aplica a cualquier email, exista o no la cuenta (no consulta la base)", () => {
    expect(loginAccountRateLimitKey(requestWithBody({ email: "no-existe@recetaria.com" }))).toMatch(
      /^login-account:/,
    );
  });
});
