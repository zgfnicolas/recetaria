import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "../../shared/errors/app-error.js";
import {
  assertValidJwtConfig,
  assertValidJwtSecret,
  INVALID_TOKEN_MESSAGE,
  JWT_ALGORITHM,
  JWT_CLOCK_TOLERANCE_SECONDS,
  MIN_JWT_SECRET_LENGTH,
  signAccessToken,
  verifyAccessToken,
  type JwtConfig,
} from "./jwt.js";
import { MAX_JWT_EXPIRES_IN_SECONDS } from "../../config/jwt-expires-in.js";

const EXPECTED_MVP_ROLES = ["USER", "CHEF", "NUTRITIONIST", "ADMIN"] as const;
const TEST_JWT_SECRET = "test-jwt-secret-".repeat(3);
const OTHER_JWT_SECRET = "other-jwt-secret-".repeat(3);
const VALID_UUID = "11111111-1111-4111-8111-111111111111";

function toBase64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

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
    { expiresIn: "86400s" as const, expectedSeconds: 86_400 },
    { expiresIn: "1440m" as const, expectedSeconds: 86_400 },
    { expiresIn: "24h" as const, expectedSeconds: 86_400 },
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

  it.each(["86401s", "1441m", "25h", "2d", "1w", "1y", "999999y"] as const)(
    "rechaza fail-closed al firmar una expiración que supera el tope de 1d (%s), aunque la app se arme a mano",
    (excessive) => {
      // Arrange
      const config: JwtConfig = { secret: TEST_JWT_SECRET, expiresIn: excessive };

      // Act & Assert — mensaje de tope (no de formato) y sin filtrar el secreto
      expect(() => assertValidJwtConfig(config)).toThrow(RangeError);
      expect(() => assertValidJwtConfig(config)).toThrow(/no puede superar 1d/);
      expect(() => assertValidJwtConfig(config)).not.toThrow(TEST_JWT_SECRET);
      expect(() =>
        signAccessToken({ id: "11111111-1111-4111-8111-111111111111", role: "USER" }, config),
      ).toThrow(RangeError);
    },
  );

  describe("verifyAccessToken — defensa en profundidad del tope (#52)", () => {
    const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
    const nowSeconds = (): number => Math.floor(Date.now() / 1000);

    it("rechaza un token firmado con el secreto pero sin exp", () => {
      const token = jwt.sign({ id: ACTOR_ID, role: "ADMIN" }, TEST_JWT_SECRET, { algorithm: "HS256" });
      expect(() => verifyAccessToken(token, TEST_JWT_SECRET)).toThrow(UnauthorizedError);
    });

    it("rechaza un token sin iat aunque tenga exp", () => {
      const token = jwt.sign(
        { id: ACTOR_ID, role: "ADMIN", exp: nowSeconds() + 60 },
        TEST_JWT_SECRET,
        { algorithm: "HS256", noTimestamp: true },
      );
      expect(() => verifyAccessToken(token, TEST_JWT_SECRET)).toThrow(UnauthorizedError);
    });

    it("rechaza un token con vigencia declarada mayor al tope (exp - iat > 1d), aún no vencido", () => {
      const token = jwt.sign(
        { id: ACTOR_ID, role: "ADMIN", exp: nowSeconds() + 7 * 86_400 },
        TEST_JWT_SECRET,
        { algorithm: "HS256" },
      );
      expect(() => verifyAccessToken(token, TEST_JWT_SECRET)).toThrow(UnauthorizedError);
    });

    it("rechaza un token con iat más antiguo que el tope (maxAge) aunque su exp siga en el futuro", () => {
      const iat = nowSeconds() - (MAX_JWT_EXPIRES_IN_SECONDS + 60);
      const token = jwt.sign({ id: ACTOR_ID, role: "ADMIN", iat, exp: nowSeconds() + 60 }, TEST_JWT_SECRET, {
        algorithm: "HS256",
      });
      expect(() => verifyAccessToken(token, TEST_JWT_SECRET)).toThrow(UnauthorizedError);
    });

    describe("iat en el futuro (#22): no puede extender la vigencia más allá del tope", () => {
      const FIXED_NOW_MS = Date.UTC(2026, 10, 24, 12, 0, 0);
      const fixedNow = FIXED_NOW_MS / 1000;
      const signAt = (iat: number, lifetime = 3600) =>
        jwt.sign({ id: ACTOR_ID, role: "ADMIN", iat, exp: iat + lifetime }, TEST_JWT_SECRET, { algorithm: "HS256" });

      afterEach(() => {
        vi.useRealTimers();
      });

      it("rechaza un token con iat 10 años en el futuro aunque exp - iat ≤ 1d", () => {
        vi.useFakeTimers({ now: FIXED_NOW_MS });
        const token = signAt(fixedNow + 10 * 365 * 86_400);
        expect(() => verifyAccessToken(token, TEST_JWT_SECRET)).toThrow(UnauthorizedError);
      });

      it("rechaza un iat apenas por encima de la tolerancia de reloj", () => {
        vi.useFakeTimers({ now: FIXED_NOW_MS });
        const token = signAt(fixedNow + JWT_CLOCK_TOLERANCE_SECONDS + 1);
        expect(() => verifyAccessToken(token, TEST_JWT_SECRET)).toThrow(INVALID_TOKEN_MESSAGE);
      });

      it("acepta un iat dentro de la tolerancia de reloj (desfase legítimo entre servidores)", () => {
        vi.useFakeTimers({ now: FIXED_NOW_MS });
        const token = signAt(fixedNow + JWT_CLOCK_TOLERANCE_SECONDS);
        expect(verifyAccessToken(token, TEST_JWT_SECRET)).toEqual({ id: ACTOR_ID, role: "ADMIN" });
      });

      it("la tolerancia es acotada (≤ 5 min) para no reabrir la ventana", () => {
        expect(JWT_CLOCK_TOLERANCE_SECONDS).toBeGreaterThan(0);
        expect(JWT_CLOCK_TOLERANCE_SECONDS).toBeLessThanOrEqual(300);
      });
    });

    it("acepta un token emitido con la vigencia máxima permitida (1d)", () => {
      const token = signAccessToken({ id: ACTOR_ID, role: "CHEF" }, { secret: TEST_JWT_SECRET, expiresIn: "1d" });
      expect(verifyAccessToken(token, TEST_JWT_SECRET)).toEqual({ id: ACTOR_ID, role: "CHEF" });
    });
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

describe("jwt (verifyAccessToken HS256 y validación fail-closed)", () => {
  it("assertValidJwtSecret acepta secreto de exactamente 32 caracteres no blancos y rechaza menores con RangeError", () => {
    // Arrange
    const exact32Secret = "a".repeat(32);
    const short31Secret = "a".repeat(31);

    // Act & Assert
    expect(() => assertValidJwtSecret(exact32Secret)).not.toThrow();
    expect(() => assertValidJwtSecret(short31Secret)).toThrow(RangeError);
  });

  it.each(EXPECTED_MVP_ROLES)(
    "verifica token HS256 para rol %s retornando Actor congelado con claves exactas { id, role }",
    (role) => {
      // Arrange
      const token = signAccessToken(
        { id: VALID_UUID, role },
        { secret: TEST_JWT_SECRET, expiresIn: "1h" },
      );

      // Act
      const actor = verifyAccessToken(token, TEST_JWT_SECRET);

      // Assert
      expect(Object.isFrozen(actor)).toBe(true);
      expect(Object.keys(actor).sort()).toEqual(["id", "role"]);
      expect(actor).toEqual({ id: VALID_UUID, role });
    },
  );

  it("descarta claims extra del payload JWT retornando únicamente { id, role } congelado", () => {
    // Arrange
    const tokenWithExtraClaims = jwt.sign(
      {
        id: VALID_UUID,
        role: "NUTRITIONIST",
        email: "nutri@recetaria.com",
        passwordHash: "hash-oculto",
        isAdmin: true,
      },
      TEST_JWT_SECRET,
      { algorithm: "HS256", expiresIn: "15m" },
    );

    // Act
    const actor = verifyAccessToken(tokenWithExtraClaims, TEST_JWT_SECRET);

    // Assert
    expect(Object.isFrozen(actor)).toBe(true);
    expect(Object.keys(actor).sort()).toEqual(["id", "role"]);
    expect(actor).toEqual({ id: VALID_UUID, role: "NUTRITIONIST" });
  });

  it.each([
    { label: "token vacío", buildToken: () => "" },
    { label: "token con espacio", buildToken: () => "a.b.c extra" },
    { label: "token con salto de línea", buildToken: () => "a.b.c\n" },
    {
      label: "token válido con sufijo CRLF",
      buildToken: () =>
        `${signAccessToken({ id: VALID_UUID, role: "USER" }, { secret: TEST_JWT_SECRET, expiresIn: "1h" })}\r\n`,
    },
    {
      label: "token válido con espacio inicial",
      buildToken: () =>
        ` ${signAccessToken({ id: VALID_UUID, role: "USER" }, { secret: TEST_JWT_SECRET, expiresIn: "1h" })}`,
    },
    { label: "formato no-JWT", buildToken: () => "not-a-jwt" },
    { label: "solo dos segmentos", buildToken: () => "a.b" },
    {
      label: "firma generada con otro secreto",
      buildToken: () =>
        signAccessToken({ id: VALID_UUID, role: "USER" }, { secret: OTHER_JWT_SECRET, expiresIn: "1h" }),
    },
    {
      label: "payload manipulado USER -> ADMIN manteniendo firma",
      buildToken: () => {
        const userToken = signAccessToken(
          { id: VALID_UUID, role: "USER" },
          { secret: TEST_JWT_SECRET, expiresIn: "1h" },
        );
        const [headerSeg, , signatureSeg] = userToken.split(".");
        return `${headerSeg ?? ""}.${toBase64Url({ id: VALID_UUID, role: "ADMIN" })}.${signatureSeg ?? ""}`;
      },
    },
    {
      label: "token expirado",
      buildToken: () => {
        const now = Math.floor(Date.now() / 1000);
        return jwt.sign(
          { id: VALID_UUID, role: "USER", iat: now - 120, exp: now - 10 },
          TEST_JWT_SECRET,
          { algorithm: "HS256" },
        );
      },
    },
    {
      label: "token con nbf futuro",
      buildToken: () => {
        const now = Math.floor(Date.now() / 1000);
        return jwt.sign(
          { id: VALID_UUID, role: "USER", nbf: now + 60 },
          TEST_JWT_SECRET,
          { algorithm: "HS256", expiresIn: "1h" },
        );
      },
    },
  ])(
    "rechaza con UnauthorizedError 401 genérico ante $label",
    ({ buildToken }) => {
      // Arrange
      const candidateToken = buildToken();

      // Act
      let caughtError: unknown;
      try {
        verifyAccessToken(candidateToken, TEST_JWT_SECRET);
      } catch (err: unknown) {
        caughtError = err;
      }

      // Assert
      expect(caughtError).toBeInstanceOf(UnauthorizedError);
      if (caughtError instanceof UnauthorizedError) {
        expect(caughtError.statusCode).toBe(401);
        expect(caughtError.message).toBe(INVALID_TOKEN_MESSAGE);
        expect(caughtError.errors).toBeUndefined();
      }
    },
  );

  it.each([
    {
      label: "alg: none",
      buildTokenAndSecret: () => ({
        token: `${toBase64Url({ alg: "none", typ: "JWT" })}.${toBase64Url({ id: VALID_UUID, role: "ADMIN" })}.`,
        secret: TEST_JWT_SECRET,
      }),
    },
    {
      label: "alg: HS384",
      buildTokenAndSecret: () => ({
        token: jwt.sign({ id: VALID_UUID, role: "ADMIN" }, TEST_JWT_SECRET, {
          algorithm: "HS384",
          expiresIn: "1h",
        }),
        secret: TEST_JWT_SECRET,
      }),
    },
    {
      label: "alg: HS512",
      buildTokenAndSecret: () => ({
        token: jwt.sign({ id: VALID_UUID, role: "ADMIN" }, TEST_JWT_SECRET, {
          algorithm: "HS512",
          expiresIn: "1h",
        }),
        secret: TEST_JWT_SECRET,
      }),
    },
    {
      label: "alg: RS256 validado contra TEST_JWT_SECRET",
      buildTokenAndSecret: () => {
        const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        return {
          token: jwt.sign({ id: VALID_UUID, role: "ADMIN" }, privateKey, {
            algorithm: "RS256",
            expiresIn: "1h",
          }),
          secret: TEST_JWT_SECRET,
        };
      },
    },
    {
      label: "alg: RS256 validado contra clave pública PEM (algorithm confusion)",
      buildTokenAndSecret: () => {
        const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
        return {
          token: jwt.sign({ id: VALID_UUID, role: "ADMIN" }, privateKey, {
            algorithm: "RS256",
            expiresIn: "1h",
          }),
          secret: publicPem,
        };
      },
    },
  ])(
    "rechaza algoritmos fuera de lista blanca ['HS256'] ($label) con UnauthorizedError 401",
    ({ buildTokenAndSecret }) => {
      // Arrange
      const { token, secret } = buildTokenAndSecret();

      // Act
      let caughtError: unknown;
      try {
        verifyAccessToken(token, secret);
      } catch (err: unknown) {
        caughtError = err;
      }

      // Assert
      expect(caughtError).toBeInstanceOf(UnauthorizedError);
      if (caughtError instanceof UnauthorizedError) {
        expect(caughtError.statusCode).toBe(401);
        expect(caughtError.message).toBe(INVALID_TOKEN_MESSAGE);
        expect(caughtError.errors).toBeUndefined();
      }
    },
  );

  it.each([
    { label: "payload string plano", payload: "plain-text-payload" },
    { label: "objeto vacío", payload: {} },
    { label: "falta id", payload: { role: "USER" } },
    { label: "id no UUID", payload: { id: "not-a-uuid", role: "USER" } },
    { label: "falta role", payload: { id: VALID_UUID } },
    { label: "role fuera de USER_ROLES", payload: { id: VALID_UUID, role: "SUPERADMIN" } },
  ])(
    "rechaza con UnauthorizedError 401 payloads inválidos ($label) aunque la firma HS256 sea válida",
    ({ payload }) => {
      // Arrange
      const tokenWithBadPayload =
        typeof payload === "string"
          ? jwt.sign(payload, TEST_JWT_SECRET, { algorithm: "HS256" })
          : jwt.sign(payload, TEST_JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });

      // Act
      let caughtError: unknown;
      try {
        verifyAccessToken(tokenWithBadPayload, TEST_JWT_SECRET);
      } catch (err: unknown) {
        caughtError = err;
      }

      // Assert
      expect(caughtError).toBeInstanceOf(UnauthorizedError);
      if (caughtError instanceof UnauthorizedError) {
        expect(caughtError.statusCode).toBe(401);
        expect(caughtError.message).toBe(INVALID_TOKEN_MESSAGE);
        expect(caughtError.errors).toBeUndefined();
      }
    },
  );

  it.each(["", "a".repeat(31), " ".repeat(40)])(
    "falla fail-closed con RangeError (no 401) si verifyAccessToken recibe secreto inválido (%j)",
    (invalidSecret) => {
      // Arrange
      const validToken = signAccessToken(
        { id: VALID_UUID, role: "USER" },
        { secret: TEST_JWT_SECRET, expiresIn: "1h" },
      );

      // Act & Assert
      expect(() => verifyAccessToken(validToken, invalidSecret)).toThrow(RangeError);
    },
  );
});
