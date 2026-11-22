import * as bcrypt from "bcrypt";
import { ConflictError } from "../../shared/errors/app-error.js";
import type { RegisterDTO, UserRole } from "./auth.schema.js";
import type { IUserRepository } from "./user.repository.js";

/** Factor de costo mínimo exigido para Bcrypt (`RN-08`). */
export const BCRYPT_SALT_ROUNDS = 10;
const MAX_BCRYPT_SALT_ROUNDS = 31;

export type AuthServiceOptions = Readonly<{
  saltRounds?: number | undefined;
}>;

export type RegisteredUser = Readonly<{
  id: string;
  email: string;
  role: UserRole;
}>;

export interface IAuthService {
  register(dto: RegisterDTO): Promise<RegisteredUser>;
}

/**
 * Servicio de autenticación y registro de usuarios desacoplado de Express y Prisma.
 */
export class AuthService implements IAuthService {
  readonly #userRepository: IUserRepository;
  readonly #saltRounds: number;

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

    this.#userRepository = userRepository;
    this.#saltRounds = saltRounds;
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
}
