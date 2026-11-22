import * as bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { describe, expect, it, vi } from "vitest";
import { AppError, ConflictError, UnauthorizedError } from "../../shared/errors/app-error.js";
import {
  AuthService,
  BCRYPT_SALT_ROUNDS,
  DUMMY_BCRYPT_HASH,
  INVALID_CREDENTIALS_MESSAGE,
} from "./auth.service.js";
import type { JwtConfig } from "./jwt.js";
import type {
  CreateUserInput,
  IUserRepository,
  UserAuthRecord,
  UserRecord,
} from "./user.repository.js";

const TEST_JWT_CONFIG: JwtConfig = {
  secret: "test-jwt-secret-".repeat(3),
  expiresIn: "1h",
};

function createMockRepository(): {
  readonly repository: IUserRepository;
  readonly findByEmail: ReturnType<typeof vi.fn<IUserRepository["findByEmail"]>>;
  readonly findAuthByEmail: ReturnType<typeof vi.fn<IUserRepository["findAuthByEmail"]>>;
  readonly findById: ReturnType<typeof vi.fn<IUserRepository["findById"]>>;
  readonly create: ReturnType<typeof vi.fn<IUserRepository["create"]>>;
} {
  const findByEmail = vi.fn<IUserRepository["findByEmail"]>().mockResolvedValue(null);
  const findAuthByEmail = vi.fn<IUserRepository["findAuthByEmail"]>().mockResolvedValue(null);
  const findById = vi.fn<IUserRepository["findById"]>().mockResolvedValue(null);
  const create = vi.fn<IUserRepository["create"]>();
  return {
    repository: { findByEmail, findAuthByEmail, findById, create },
    findByEmail,
    findAuthByEmail,
    findById,
    create,
  };
}

function buildPersistedUser(overrides?: Partial<UserRecord>): UserRecord {
  return {
    id: overrides?.id ?? "11111111-1111-4111-8111-111111111111",
    email: overrides?.email ?? "ana@recetaria.com",
    firstName: overrides?.firstName ?? "Ana",
    lastName: overrides?.lastName ?? "López",
    role: overrides?.role ?? "USER",
    isActive: overrides?.isActive ?? true,
    createdAt: overrides?.createdAt ?? new Date("2026-11-22T10:00:00.000Z"),
    updatedAt: overrides?.updatedAt ?? new Date("2026-11-22T10:00:00.000Z"),
  };
}

describe("AuthService.register (RN-08)", () => {
  it("normaliza email/nombres, conserva espacios de password, cifra con Bcrypt (>= 10 rounds, salts únicos) y devuelve { id, email, role } (RN-08)", async () => {
    // Arrange
    const { repository, findByEmail, create } = createMockRepository();
    const capturedInputs: CreateUserInput[] = [];
    create.mockImplementation(async (input) => {
      capturedInputs.push(input);
      return buildPersistedUser({
        id:
          capturedInputs.length === 1
            ? "11111111-1111-4111-8111-111111111111"
            : "22222222-2222-4222-8222-222222222222",
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        role: input.role,
      });
    });

    const service = new AuthService(repository);
    const plainWithSpaces = "  MiPasswordSegura123  ";

    // Act
    const firstResult = await service.register({
      email: "  Ana.Lopez@Recetaria.COM ",
      password: plainWithSpaces,
      firstName: "  Ana  ",
      lastName: "  López  ",
      role: "CHEF",
    });
    const secondResult = await service.register({
      email: "otro@recetaria.com",
      password: plainWithSpaces,
      firstName: "Otro",
      lastName: "Usuario",
      role: "USER",
    });

    // Assert
    expect(BCRYPT_SALT_ROUNDS).toBe(10);
    expect(findByEmail).toHaveBeenNthCalledWith(1, "ana.lopez@recetaria.com");
    expect(findByEmail).toHaveBeenNthCalledWith(2, "otro@recetaria.com");
    expect(create).toHaveBeenCalledTimes(2);

    const firstCreateInput = capturedInputs[0];
    const secondCreateInput = capturedInputs[1];
    expect(firstCreateInput).toBeDefined();
    expect(secondCreateInput).toBeDefined();
    if (firstCreateInput !== undefined && secondCreateInput !== undefined) {
      expect(firstCreateInput.email).toBe("ana.lopez@recetaria.com");
      expect(firstCreateInput.firstName).toBe("Ana");
      expect(firstCreateInput.lastName).toBe("López");
      expect(firstCreateInput.role).toBe("CHEF");
      expect(firstCreateInput.passwordHash).not.toBe(plainWithSpaces);
      expect(bcrypt.getRounds(firstCreateInput.passwordHash)).toBe(10);
      expect(bcrypt.getRounds(firstCreateInput.passwordHash)).toBeGreaterThanOrEqual(10);
      expect(await bcrypt.compare(plainWithSpaces, firstCreateInput.passwordHash)).toBe(true);
      expect(await bcrypt.compare(plainWithSpaces.trim(), firstCreateInput.passwordHash)).toBe(false);
      expect(await bcrypt.compare("clave-erronea", firstCreateInput.passwordHash)).toBe(false);
      expect(firstCreateInput.passwordHash).not.toBe(secondCreateInput.passwordHash);
    }

    expect(firstResult).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      email: "ana.lopez@recetaria.com",
      role: "CHEF",
    });
    expect(Object.keys(firstResult).sort()).toEqual(["email", "id", "role"]);
    expect("passwordHash" in firstResult).toBe(false);
    expect(secondResult.role).toBe("USER");
  });

  it("rechaza con ConflictError 409 cuando el email normalizado ya existe sin invocar create (RN-08)", async () => {
    // Arrange
    const { repository, findByEmail, create } = createMockRepository();
    findByEmail.mockResolvedValueOnce(buildPersistedUser({ email: "duplicado@recetaria.com" }));
    const service = new AuthService(repository);

    // Act
    let caughtError: unknown;
    try {
      await service.register({
        email: "  DUPLICADO@Recetaria.com ",
        password: "password123",
        firstName: "Usuario",
        lastName: "Duplicado",
        role: "USER",
      });
    } catch (err: unknown) {
      caughtError = err;
    }

    // Assert
    expect(findByEmail).toHaveBeenCalledWith("duplicado@recetaria.com");
    expect(create).not.toHaveBeenCalled();
    expect(caughtError).toBeInstanceOf(ConflictError);
    if (caughtError instanceof ConflictError) {
      expect(caughtError.statusCode).toBe(409);
      expect(caughtError.message).toBe("El correo electrónico ya está registrado");
    }
  });

  it("propaga ConflictError 409 si create falla por colisión concurrente (RN-08)", async () => {
    // Arrange
    const { repository, findByEmail, create } = createMockRepository();
    findByEmail.mockResolvedValueOnce(null);
    create.mockRejectedValueOnce(new ConflictError("El correo electrónico ya está registrado"));
    const service = new AuthService(repository);

    // Act
    let caughtError: unknown;
    try {
      await service.register({
        email: "carrera@recetaria.com",
        password: "password123",
        firstName: "Carrera",
        lastName: "Concurrente",
        role: "USER",
      });
    } catch (err: unknown) {
      caughtError = err;
    }

    // Assert
    expect(caughtError).toBeInstanceOf(ConflictError);
    if (caughtError instanceof ConflictError) {
      expect(caughtError.statusCode).toBe(409);
      expect(caughtError.message).toBe("El correo electrónico ya está registrado");
    }
  });

  it("propaga el error original si findByEmail falla sin invocar create", async () => {
    // Arrange
    const { repository, findByEmail, create } = createMockRepository();
    const dbDownError = new Error("DB caída");
    findByEmail.mockRejectedValueOnce(dbDownError);
    const service = new AuthService(repository);

    // Act
    let caughtError: unknown;
    try {
      await service.register({
        email: "error@recetaria.com",
        password: "password123",
        firstName: "Error",
        lastName: "Conexion",
        role: "USER",
      });
    } catch (err: unknown) {
      caughtError = err;
    }

    // Assert
    expect(create).not.toHaveBeenCalled();
    expect(caughtError).toBe(dbDownError);
  });

  it("permite configurar saltRounds superiores (>= 10) generando un hash verificable con Bcrypt", async () => {
    // Arrange
    const { repository, create } = createMockRepository();
    let storedHash = "";
    create.mockImplementation(async (input) => {
      storedHash = input.passwordHash;
      return buildPersistedUser({ email: input.email, role: input.role });
    });

    // Act
    const customService = new AuthService(repository, { saltRounds: 11 });
    await customService.register({
      email: "rounds11@recetaria.com",
      password: "password123",
      firstName: "Rondas",
      lastName: "Once",
      role: "USER",
    });

    // Assert
    expect(bcrypt.getRounds(storedHash)).toBe(11);
    expect(await bcrypt.compare("password123", storedHash)).toBe(true);
  });

  it.each([0, 9, 32, 10.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rechaza saltRounds inválido (%s) con RangeError",
    (invalidRounds) => {
      // Arrange
      const { repository } = createMockRepository();

      // Act & Assert
      expect(() => new AuthService(repository, { saltRounds: invalidRounds })).toThrow(RangeError);
    },
  );
});

async function buildAuthRecord(options: {
  readonly id?: string;
  readonly email?: string;
  readonly role?: UserAuthRecord["role"];
  readonly isActive?: boolean;
  readonly password?: string;
}): Promise<UserAuthRecord> {
  return {
    id: options.id ?? "11111111-1111-4111-8111-111111111111",
    email: options.email ?? "ana@recetaria.com",
    role: options.role ?? "CHEF",
    isActive: options.isActive ?? true,
    passwordHash: await bcrypt.hash(options.password ?? "password123", 10),
  };
}

describe("AuthService.login (RN-08)", () => {
  it("normaliza email, verifica contraseña con espacios sin findByEmail y emite JWT HS256 con payload mínimo (RN-08)", async () => {
    // Arrange
    const { repository, findByEmail, findAuthByEmail } = createMockRepository();
    const passwordWithSpaces = "  test password spaces  ";
    findAuthByEmail.mockResolvedValueOnce(
      await buildAuthRecord({
        email: "ana@recetaria.com",
        role: "CHEF",
        isActive: true,
        password: passwordWithSpaces,
      }),
    );
    const service = new AuthService(repository, { jwt: TEST_JWT_CONFIG });

    // Act
    const authSession = await service.login({
      email: "  ANA@Recetaria.COM  ",
      password: passwordWithSpaces,
    });

    // Assert
    expect(findAuthByEmail).toHaveBeenCalledTimes(1);
    expect(findAuthByEmail).toHaveBeenCalledWith("ana@recetaria.com");
    expect(findByEmail).not.toHaveBeenCalled();

    expect(Object.keys(authSession).sort()).toEqual(["token", "user"]);
    expect(Object.keys(authSession.user).sort()).toEqual(["email", "id", "role"]);
    expect(authSession.user).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      email: "ana@recetaria.com",
      role: "CHEF",
    });

    const decoded = jwt.decode(authSession.token, { complete: true });
    const verified = jwt.verify(authSession.token, TEST_JWT_CONFIG.secret, {
      algorithms: ["HS256"],
    });
    expect(decoded?.header.alg).toBe("HS256");
    expect(typeof verified).toBe("object");
    if (typeof verified === "object" && verified !== null) {
      expect(Object.keys(verified).sort()).toEqual(["exp", "iat", "id", "role"]);
      expect(verified["id"]).toBe("11111111-1111-4111-8111-111111111111");
      expect(verified["role"]).toBe("CHEF");
    }
  });

  it("expone DUMMY_BCRYPT_HASH válido de 60 caracteres y costo 10 para defensa timing-safe", async () => {
    // Arrange
    const candidate = "password123";

    // Act
    const rounds = bcrypt.getRounds(DUMMY_BCRYPT_HASH);
    const matches = await bcrypt.compare(candidate, DUMMY_BCRYPT_HASH);

    // Assert
    expect(DUMMY_BCRYPT_HASH).toHaveLength(60);
    expect(rounds).toBe(10);
    expect(matches).toBe(false);
  });

  it.each([
    { label: "email inexistente", scenario: "missing" as const },
    { label: "contraseña incorrecta", scenario: "wrongPassword" as const },
    { label: "cuenta inactiva (isActive === false) con clave correcta", scenario: "inactive" as const },
  ])(
    "rechaza con el mismo UnauthorizedError 401 ejecutando bcrypt.compare real ante $label (RN-08)",
    async ({ scenario }) => {
      // Arrange
      const { repository, findAuthByEmail } = createMockRepository();
      if (scenario === "missing") {
        findAuthByEmail.mockResolvedValueOnce(null);
      } else if (scenario === "wrongPassword") {
        findAuthByEmail.mockResolvedValueOnce(
          await buildAuthRecord({ isActive: true, password: "password123" }),
        );
      } else {
        findAuthByEmail.mockResolvedValueOnce(
          await buildAuthRecord({ isActive: false, password: "password123" }),
        );
      }
      const service = new AuthService(repository, { jwt: TEST_JWT_CONFIG });
      const candidatePassword = scenario === "wrongPassword" ? "wrong-password-test" : "password123";

      // Act
      const startedAt = performance.now();
      let caughtError: unknown;
      try {
        await service.login({ email: "ana@recetaria.com", password: candidatePassword });
      } catch (err: unknown) {
        caughtError = err;
      }
      const elapsedMs = performance.now() - startedAt;

      // Assert
      expect(elapsedMs).toBeGreaterThanOrEqual(5);
      expect(caughtError).toBeInstanceOf(UnauthorizedError);
      if (caughtError instanceof UnauthorizedError) {
        expect(caughtError.statusCode).toBe(401);
        expect(caughtError.message).toBe(INVALID_CREDENTIALS_MESSAGE);
        expect(caughtError.message).toBe("Credenciales inválidas");
        expect(caughtError.errors).toBeUndefined();
      }
    },
  );

  it.each([
    {
      label: "ASCII 72 bytes vs 73 bytes",
      exact72: "a".repeat(72),
      overlong: `${"a".repeat(72)}X`,
    },
    {
      label: "UTF-8 multi-byte 36 chars (72 bytes) vs 37 chars (74 bytes)",
      exact72: "á".repeat(36),
      overlong: "á".repeat(37),
    },
    {
      label: "UTF-8 multi-byte 36 chars (72 bytes) vs 37 chars (73 bytes)",
      exact72: "á".repeat(36),
      overlong: `${"á".repeat(36)}X`,
    },
  ])(
    "evita bypass por truncado de Bcrypt ($label) ejecutando ruta timing-safe y rechazando > 72 bytes con 401 (RN-08)",
    async ({ exact72, overlong }) => {
      // Arrange
      expect(Buffer.byteLength(exact72, "utf8")).toBe(72);
      expect(Buffer.byteLength(overlong, "utf8")).toBeGreaterThan(72);
      const { repository, findAuthByEmail } = createMockRepository();
      const record = await buildAuthRecord({ password: exact72, isActive: true });
      findAuthByEmail.mockResolvedValue(record);
      const service = new AuthService(repository, { jwt: TEST_JWT_CONFIG });

      // Act
      const validSession = await service.login({
        email: "ana@recetaria.com",
        password: exact72,
      });
      const startedAt = performance.now();
      let overlongError: unknown;
      try {
        await service.login({
          email: "ana@recetaria.com",
          password: overlong,
        });
      } catch (err: unknown) {
        overlongError = err;
      }
      const elapsedMs = performance.now() - startedAt;

      // Assert
      expect(validSession.user.email).toBe("ana@recetaria.com");
      expect(elapsedMs).toBeGreaterThanOrEqual(5);
      expect(overlongError).toBeInstanceOf(UnauthorizedError);
      if (overlongError instanceof UnauthorizedError) {
        expect(overlongError.statusCode).toBe(401);
        expect(overlongError.message).toBe("Credenciales inválidas");
        expect(overlongError.errors).toBeUndefined();
      }
    },
  );

  it("rechaza fail-closed secreto JWT inválido en constructor y ausencia de jwt al invocar login()", async () => {
    // Arrange
    const { repository, findAuthByEmail } = createMockRepository();
    const serviceWithoutJwt = new AuthService(repository);

    // Act & Assert constructor
    expect(
      () => new AuthService(repository, { jwt: { secret: "short-secret", expiresIn: "1d" } }),
    ).toThrow(RangeError);

    // Act login sin jwt
    let caughtError: unknown;
    try {
      await serviceWithoutJwt.login({ email: "ana@recetaria.com", password: "password123" });
    } catch (err: unknown) {
      caughtError = err;
    }

    // Assert login sin jwt
    expect(findAuthByEmail).not.toHaveBeenCalled();
    expect(caughtError).toBeInstanceOf(AppError);
    if (caughtError instanceof AppError) {
      expect(caughtError.statusCode).toBe(500);
      expect(caughtError.isOperational).toBe(false);
    }
  });

  it("computa dummy hash acorde a saltRounds > 10 y ejecuta bcrypt.compare real ante email inexistente", async () => {
    // Arrange
    const { repository, findAuthByEmail } = createMockRepository();
    findAuthByEmail.mockResolvedValueOnce(null);
    const customService = new AuthService(repository, { saltRounds: 11, jwt: TEST_JWT_CONFIG });

    // Act
    const startedAt = performance.now();
    let missingError: unknown;
    try {
      await customService.login({ email: "ausente@recetaria.com", password: "password123" });
    } catch (err: unknown) {
      missingError = err;
    }
    const elapsedMs = performance.now() - startedAt;

    // Assert
    expect(elapsedMs).toBeGreaterThanOrEqual(5);
    expect(missingError).toBeInstanceOf(UnauthorizedError);
    if (missingError instanceof UnauthorizedError) {
      expect(missingError.statusCode).toBe(401);
      expect(missingError.message).toBe("Credenciales inválidas");
      expect(missingError.errors).toBeUndefined();
    }
  });

  it("propaga errores inesperados de findAuthByEmail sin envolverlos en 401", async () => {
    // Arrange
    const { repository, findAuthByEmail } = createMockRepository();
    const dbError = new Error("DB timeout");
    findAuthByEmail.mockRejectedValueOnce(dbError);
    const service = new AuthService(repository, { jwt: TEST_JWT_CONFIG });

    // Act
    let propagatedError: unknown;
    try {
      await service.login({ email: "error@recetaria.com", password: "password123" });
    } catch (err: unknown) {
      propagatedError = err;
    }

    // Assert
    expect(propagatedError).toBe(dbError);
    expect(propagatedError).not.toBeInstanceOf(UnauthorizedError);
  });
});
