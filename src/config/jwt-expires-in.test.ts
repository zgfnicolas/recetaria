import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import {
  hasValidJwtExpiresInFormat,
  isAllowedJwtExpiresIn,
  JWT_DURATION_UNIT_SECONDS,
  jwtExpiresInToSeconds,
  MAX_JWT_EXPIRES_IN_LABEL,
  MAX_JWT_EXPIRES_IN_SECONDS,
} from "./jwt-expires-in.js";

describe("jwtExpiresInToSeconds — semántica de `ms` (jsonwebtoken)", () => {
  it.each([
    ["1s", 1],
    ["15m", 900],
    ["2h", 7_200],
    ["1d", 86_400],
    ["1w", 604_800],
    ["1y", 31_557_600],
    ["999999y", 999_999 * 31_557_600],
  ])("convierte %s a %d s", (value, expected) => {
    expect(jwtExpiresInToSeconds(value)).toBe(expected);
  });

  it.each(Object.keys(JWT_DURATION_UNIT_SECONDS))(
    "coincide con el exp - iat real de jsonwebtoken para la unidad %s (el tope no se desfasa)",
    (unit) => {
      // Arrange
      const value = `3${unit}`;

      // Act
      const decoded = jwt.decode(
        jwt.sign({}, "secreto-de-prueba-".repeat(3), {
          algorithm: "HS256",
          expiresIn: value as jwt.SignOptions["expiresIn"] & string,
        }),
      );

      // Assert
      expect(typeof decoded).toBe("object");
      if (typeof decoded === "object" && decoded !== null) {
        expect(Number(decoded.exp) - Number(decoded.iat)).toBe(jwtExpiresInToSeconds(value));
      }
    },
  );

  it.each(["", "0d", "-5m", "15min", "abc", "1.5h", "3600", "500ms", "1000000s", " 1d", "1D", "01d"])(
    "devuelve null para el formato inválido %j",
    (value) => {
      expect(jwtExpiresInToSeconds(value)).toBeNull();
      expect(hasValidJwtExpiresInFormat(value)).toBe(false);
      expect(isAllowedJwtExpiresIn(value)).toBe(false);
    },
  );
});

describe("isAllowedJwtExpiresIn — tope de 1d (#52)", () => {
  it("fija el tope en 1d = 86400 s", () => {
    expect(MAX_JWT_EXPIRES_IN_SECONDS).toBe(86_400);
    expect(MAX_JWT_EXPIRES_IN_LABEL).toBe("1d");
    expect(jwtExpiresInToSeconds(MAX_JWT_EXPIRES_IN_LABEL)).toBe(MAX_JWT_EXPIRES_IN_SECONDS);
  });

  it.each(["30s", "15m", "2h", "86400s", "1440m", "24h", "1d"])("acepta %s (borde o por debajo)", (value) => {
    expect(isAllowedJwtExpiresIn(value)).toBe(true);
  });

  it.each(["86401s", "1441m", "25h", "2d", "1w", "1y", "999999y"])(
    "rechaza %s por superar el tope, aunque el formato sea válido",
    (value) => {
      expect(hasValidJwtExpiresInFormat(value)).toBe(true);
      expect(isAllowedJwtExpiresIn(value)).toBe(false);
    },
  );
});
