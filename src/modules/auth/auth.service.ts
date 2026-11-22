import * as bcrypt from "bcrypt";
import { AppError, ConflictError, UnauthorizedError } from "../../shared/errors/app-error.js";
import {
  MAX_BCRYPT_PASSWORD_BYTES,
  type LoginDTO,
  type RegisterDTO,
  type UserRole,
} from "./auth.schema.js";
import { assertValidJwtConfig, signAccessToken, type JwtConfig } from "./jwt.js";
import type { IUserRepository } from "./user.repository.js";

/** Factor de costo mínimo exigido para Bcrypt (`RN-08`). */
export const BCRYPT_SALT_ROUNDS = 10;
const MAX_BCRYPT_SALT_ROUNDS = 31;

/** Mensaje genérico compartido para todo fallo de autenticación (`RN-08`). */
export const INVALID_CREDENTIALS_MESSAGE = "Credenciales inválidas";

/** Hash Bcrypt válido (costo 10) usado en comparaciones timing-safe cuando el email no existe. */
export const DUMMY_BCRYPT_HASH =
  "$2b$10$EpRnTzVlqHNP0.fUbXUwSOyuiXe/QLSUG6xNekdHgTGmrpHEfIoxm";

const DUMMY_COMPARE_PASSWORD = "invalid-dummy-compare-password";

export type AuthServiceOptions = Readonly<{
  saltRounds?: number | undefined;
  jwt?: JwtConfig | undefined;
}>;

export type RegisteredUser = Readonly<{
  id: string;
  email: string;
  role: UserRole;
}>;

export type AuthSession = Readonly<{
  token: string;
  user: RegisteredUser;
}>;

export interface IAuthService {
  register(dto: RegisterDTO): Promise<RegisteredUser>;
  login(dto: LoginDTO): Promise<AuthSession>;
}

/**
 * Servicio de autenticación y registro de usuarios desacoplado de Express y Prisma.
 */
export class AuthService implements IAuthService {
  readonly #userRepository: IUserRepository;
  readonly #saltRounds: number;
  readonly #dummyPasswordHash: string;
  readonly #jwtConfig: JwtConfig | undefined;

  constructor(userRepository: IUserRepository, options?: AuthServiceOptions) {
    const saltRounds = options?.saltRounds ?? BCRYPT_SALT_ROUNDS;
    if (
      !Number.isInteger(saltRounds) ||
      saltRounds < BCRYPT_SALT_ROUNDS ||
      saltRounds > MAX_BCRYPT_SALT_ROUNDS
    ) {
      throw new RangeError(
        `saltRounds debe ser un entero entre ${String(BCRYPT_SALT_ROUNDS)} y ${String(MAX_BCRYPT_SALT_ROUNDS)} (RN-08)`,
      );
    }

    if (options?.jwt !== undefined) {
      assertValidJwtConfig(options.jwt);
      this.#jwtConfig = Object.freeze({
        secret: options.jwt.secret,
        expiresIn: options.jwt.expiresIn,
      });
    } else {
      this.#jwtConfig = undefined;
    }

    this.#userRepository = userRepository;
    this.#saltRounds = saltRounds;
    this.#dummyPasswordHash =
      saltRounds === BCRYPT_SALT_ROUNDS
        ? DUMMY_BCRYPT_HASH
        : bcrypt.hashSync(DUMMY_COMPARE_PASSWORD, saltRounds);
  }

  /**
   * Registra un usuario nuevo verificando unicidad de email, cifrando la contraseña
   * con Bcrypt (`>= 10` rounds) y devolviendo únicamente `{ id, email, role }`.
   */
  async register(dto: RegisterDTO): Promise<RegisteredUser> {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const existingUser = await this.#userRepository.findByEmail(normalizedEmail);
    if (existingUser !== null) {
      throw new ConflictError("El correo electrónico ya está registrado");
    }

    const passwordHash = await bcrypt.hash(dto.password, this.#saltRounds);
    const createdUser = await this.#userRepository.create({
      email: normalizedEmail,
      passwordHash,
      firstName: dto.firstName.trim(),
      lastName: dto.lastName.trim(),
      role: dto.role,
    });

    return {
      id: createdUser.id,
      email: createdUser.email,
      role: createdUser.role,
    };
  }

  /**
   * Autentica un usuario activo emitiendo un JWT `HS256` stateless con payload mínimo `{ id, role }`.
   * Ejecuta comparación timing-safe ante email inexistente, clave errónea o cuenta inactiva (`RN-08`).
   */
  async login(dto: LoginDTO): Promise<AuthSession> {
    if (this.#jwtConfig === undefined) {
      throw new AppError(500, "Configuración JWT no inicializada", { isOperational: false });
    }

    const normalizedEmail = dto.email.trim().toLowerCase();
    const user = await this.#userRepository.findAuthByEmail(normalizedEmail);

    const isWithinBcryptLimit =
      Buffer.byteLength(dto.password, "utf8") <= MAX_BCRYPT_PASSWORD_BYTES;
    const candidatePassword = isWithinBcryptLimit ? dto.password : DUMMY_COMPARE_PASSWORD;
    const hashToCompare = user?.passwordHash ?? this.#dummyPasswordHash;
    const passwordMatches = await bcrypt.compare(candidatePassword, hashToCompare);

    if (user === null || !user.isActive || !isWithinBcryptLimit || !passwordMatches) {
      throw new UnauthorizedError(INVALID_CREDENTIALS_MESSAGE);
    }

    const token = signAccessToken({ id: user.id, role: user.role }, this.#jwtConfig);

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
    };
  }
}
