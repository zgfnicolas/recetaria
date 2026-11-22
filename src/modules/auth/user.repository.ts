import type { AppPrismaClient } from "../../infrastructure/database/prisma.js";
import { ConflictError } from "../../shared/errors/app-error.js";
import type { UserRole } from "./auth.schema.js";

/** Proyección pública de Usuario sin `passwordHash` (`RN-08`). */
export type UserRecord = Readonly<{
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}>;

/** Proyección interna exclusiva para verificación de credenciales en login (`RN-08`). */
export type UserAuthRecord = Readonly<{
  id: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  passwordHash: string;
}>;

export type CreateUserInput = Readonly<{
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  role: UserRole;
}>;

export interface IUserRepository {
  findByEmail(email: string): Promise<UserRecord | null>;
  findAuthByEmail(email: string): Promise<UserAuthRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  create(data: CreateUserInput): Promise<UserRecord>;
}

const USER_PUBLIC_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

const USER_AUTH_SELECT = {
  id: true,
  email: true,
  role: true,
  isActive: true,
  passwordHash: true,
} as const;

function isPrismaUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === "P2002"
  );
}

/**
 * Repositorio Prisma exclusivo del módulo `Auth`.
 * Aplica proyección explícita sin `passwordHash` en lecturas generales y mapea `P2002` a `ConflictError`.
 */
export class UserRepository implements IUserRepository {
  readonly #prisma: AppPrismaClient;

  constructor(prisma: AppPrismaClient) {
    this.#prisma = prisma;
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    return this.#prisma.user.findUnique({
      where: { email },
      select: USER_PUBLIC_SELECT,
    });
  }

  async findAuthByEmail(email: string): Promise<UserAuthRecord | null> {
    return this.#prisma.user.findUnique({
      where: { email },
      select: USER_AUTH_SELECT,
    });
  }

  async findById(id: string): Promise<UserRecord | null> {
    return this.#prisma.user.findUnique({
      where: { id },
      select: USER_PUBLIC_SELECT,
    });
  }

  async create(data: CreateUserInput): Promise<UserRecord> {
    try {
      return await this.#prisma.user.create({
        data: {
          email: data.email,
          passwordHash: data.passwordHash,
          firstName: data.firstName,
          lastName: data.lastName,
          role: data.role,
        },
        select: USER_PUBLIC_SELECT,
      });
    } catch (err: unknown) {
      if (isPrismaUniqueConstraintError(err)) {
        throw new ConflictError("El correo electrónico ya está registrado", { cause: err });
      }
      throw err;
    }
  }
}
