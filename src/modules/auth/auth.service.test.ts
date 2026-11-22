import * as bcrypt from "bcrypt";
import { describe, expect, it, vi } from "vitest";
import { ConflictError } from "../../shared/errors/app-error.js";
import { AuthService, BCRYPT_SALT_ROUNDS } from "./auth.service.js";
import type { CreateUserInput, IUserRepository, UserRecord } from "./user.repository.js";

function createMockRepository(): {
  readonly repository: IUserRepository;
  readonly findByEmail: ReturnType<typeof vi.fn<IUserRepository["findByEmail"]>>;
  readonly findById: ReturnType<typeof vi.fn<IUserRepository["findById"]>>;
  readonly create: ReturnType<typeof vi.fn<IUserRepository["create"]>>;
} {
  const findByEmail = vi.fn<IUserRepository["findByEmail"]>().mockResolvedValue(null);
  const findById = vi.fn<IUserRepository["findById"]>().mockResolvedValue(null);
  const create = vi.fn<IUserRepository["create"]>();
  return {
    repository: { findByEmail, findById, create },
    findByEmail,
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
