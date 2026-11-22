import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import {
  assertValidJwtConfig,
  JWT_ALGORITHM,
  MIN_JWT_SECRET_LENGTH,
  signAccessToken,
  type JwtConfig,
} from "./jwt.js";

const EXPECTED_MVP_ROLES = ["USER", "CHEF", "NUTRITIONIST", "ADMIN"] as const;
const TEST_JWT_SECRET = "test-jwt-secret-".repeat(3);

describe("jwt (signAccessToken HS256 y validación fail-closed)", () => {
  it("firma token Bearer JWT con header alg HS256, claims mínimos { id, role } y expiración exacta", () => {
    // Arrange
    const config: JwtConfig = { secret: TEST_JWT_SECRET, expiresIn: "1h" };
    const actorWithExtraFields = {
      id: "11111111-1111-4111-8111-111111111111",
      role: "CHEF" as const,
      email: "chef@recetaria.com",
      passwordHash: "no-debe-incluirse",
    };

    // Act
    const token = signAccessToken(actorWithExtraFields, config);
    const decodedComplete = jwt.decode(token, { complete: true });
    const verified = jwt.verify(token, TEST_JWT_SECRET, { algorithms: ["HS256"] });

    // Assert
    expect(JWT_ALGORITHM).toBe("HS256");
    expect(MIN_JWT_SECRET_LENGTH).toBe(32);
    expect(decodedComplete).not.toBeNull();
    expect(decodedComplete?.header.alg).toBe("HS256");
    expect(decodedComplete?.header.typ).toBe("JWT");

    expect(typeof verified).toBe("object");
    expect(verified).not.toBeNull();
    if (typeof verified === "object" && verified !== null) {
      expect(Object.keys(verified).sort()).toEqual(["exp", "iat", "id", "role"]);
      expect(verified["id"]).toBe("11111111-1111-4111-8111-111111111111");
      expect(verified["role"]).toBe("CHEF");
      expect(typeof verified.iat).toBe("number");
      expect(typeof verified.exp).toBe("number");
      if (typeof verified.iat === "number" && typeof verified.exp === "number") {
        expect(verified.exp - verified.iat).toBe(3600);
      }
    }
  });

  it.each([
    { expiresIn: "15m" as const, expectedSeconds: 900 },
    { expiresIn: "1h" as const, expectedSeconds: 3600 },
    { expiresIn: "1d" as const, expectedSeconds: 86_400 },
  ])("respeta la ventana de expiración configurada ($expiresIn -> $expectedSeconds s)", ({ expiresIn, expectedSeconds }) => {
    // Arrange
    const config: JwtConfig = { secret: TEST_JWT_SECRET, expiresIn };

    // Act
    const token = signAccessToken(
      { id: "11111111-1111-4111-8111-111111111111", role: "USER" },
      config,
    );
    const verified = jwt.verify(token, TEST_JWT_SECRET, { algorithms: ["HS256"] });

    // Assert
    expect(typeof verified).toBe("object");
    expect(verified).not.toBeNull();
    if (typeof verified === "object" && verified !== null) {
      expect(typeof verified.iat).toBe("number");
      expect(typeof verified.exp).toBe("number");
      if (typeof verified.iat === "number" && typeof verified.exp === "number") {
        expect(verified.exp - verified.iat).toBe(expectedSeconds);
      }
    }
  });

  it.each(EXPECTED_MVP_ROLES)("emite JWT verificable preservando el rol %s", (role) => {
    // Arrange
    const config: JwtConfig = { secret: TEST_JWT_SECRET, expiresIn: "15m" };

    // Act
    const token = signAccessToken({ id: "22222222-2222-4222-8222-222222222222", role }, config);
    const verified = jwt.verify(token, TEST_JWT_SECRET, { algorithms: ["HS256"] });

    // Assert
    expect(typeof verified).toBe("object");
    expect(verified).not.toBeNull();
    if (typeof verified === "object" && verified !== null) {
      expect(verified["id"]).toBe("22222222-2222-4222-8222-222222222222");
      expect(verified["role"]).toBe(role);
    }
  });

  it("falla verificación criptográfica al validar con un secreto diferente", () => {
    // Arrange
    const token = signAccessToken(
      { id: "11111111-1111-4111-8111-111111111111", role: "USER" },
      { secret: TEST_JWT_SECRET, expiresIn: "1h" },
    );

    // Act & Assert
    expect(() =>
      jwt.verify(token, "wrong-jwt-secret-".repeat(3), { algorithms: ["HS256"] }),
    ).toThrow();
  });

  it.each([
    { label: "secreto vacío", secret: "" },
    { label: "secreto menor a 32 chars", secret: "a".repeat(31) },
    { label: "solo espacios", secret: " ".repeat(40) },
    { label: "31 chars reales rellenados con espacios", secret: `${"a".repeat(31)}${" ".repeat(10)}` },
  ])("rechaza fail-closed $label con RangeError", ({ secret }) => {
    // Arrange
    const invalidConfig: JwtConfig = { secret, expiresIn: "1d" };

    // Act & Assert
    expect(() => assertValidJwtConfig(invalidConfig)).toThrow(RangeError);
    expect(() =>
      signAccessToken(
        { id: "11111111-1111-4111-8111-111111111111", role: "USER" },
        invalidConfig,
      ),
    ).toThrow(RangeError);
  });

  it.each(["0s", "-5m"] as const)(
    "rechaza fail-closed expiración JWT inválida (%s) con RangeError",
    (invalidExpires) => {
      // Arrange
      const invalidConfig: JwtConfig = {
        secret: TEST_JWT_SECRET,
        expiresIn: invalidExpires,
      };

      // Act & Assert
      expect(() => assertValidJwtConfig(invalidConfig)).toThrow(RangeError);
      expect(() =>
        signAccessToken(
          { id: "11111111-1111-4111-8111-111111111111", role: "USER" },
          invalidConfig,
        ),
      ).toThrow(RangeError);
    },
  );
});
