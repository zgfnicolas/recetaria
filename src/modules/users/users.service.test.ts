import { describe, expect, it, vi } from "vitest";
import type { Actor } from "../auth/index.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../shared/errors/app-error.js";
import type { ChangeRoleWithAuditResult, IUserAdminRepository, ManagedUser } from "./users.repository.js";
import {
  ACTOR_NOT_ACTIVE_ADMIN_MESSAGE,
  LAST_ADMIN_CONFLICT_MESSAGE,
  SELF_ROLE_CHANGE_FORBIDDEN_MESSAGE,
  USER_NOT_FOUND_MESSAGE,
  UserAdminService,
} from "./users.service.js";

const ADMIN: Actor = { id: "11111111-1111-4111-8111-111111111111", role: "ADMIN" };
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const TARGET: ManagedUser = { id: TARGET_ID, email: "destino@recetaria.com", role: "USER" };

function createMockRepository(result?: ChangeRoleWithAuditResult): {
  readonly repository: IUserAdminRepository;
  readonly changeRoleWithAudit: ReturnType<typeof vi.fn<IUserAdminRepository["changeRoleWithAudit"]>>;
} {
  const changeRoleWithAudit = vi
    .fn<IUserAdminRepository["changeRoleWithAudit"]>()
    .mockResolvedValue(result ?? { outcome: "changed", user: { ...TARGET, role: "CHEF" } });
  return { repository: { changeRoleWithAudit }, changeRoleWithAudit };
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err: unknown) {
    return err;
  }
  throw new Error("Se esperaba que la promesa fuera rechazada");
}

describe("UserAdminService.changeRole (RN-09, #53)", () => {
  it("delega actorId, destino y rol, y devuelve el usuario actualizado", async () => {
    // Arrange
    const { repository, changeRoleWithAudit } = createMockRepository();
    const service = new UserAdminService(repository);

    // Act
    const result = await service.changeRole(ADMIN, TARGET_ID, "CHEF");

    // Assert
    expect(changeRoleWithAudit).toHaveBeenCalledWith({ actorId: ADMIN.id, targetUserId: TARGET_ID, role: "CHEF" });
    expect(result).toEqual({ ...TARGET, role: "CHEF" });
  });

  it("devuelve el usuario sin error si el rol ya era el pedido (idempotente)", async () => {
    const { repository } = createMockRepository({ outcome: "unchanged", user: TARGET });
    expect(await new UserAdminService(repository).changeRole(ADMIN, TARGET_ID, "USER")).toEqual(TARGET);
  });

  it("lanza ForbiddenError 403 si el ADMIN intenta cambiar su propio rol, sin consultar la base", async () => {
    // Arrange
    const { repository, changeRoleWithAudit } = createMockRepository();

    // Act
    const err = await captureError(new UserAdminService(repository).changeRole(ADMIN, ADMIN.id, "USER"));

    // Assert
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err).toMatchObject({ statusCode: 403, message: SELF_ROLE_CHANGE_FORBIDDEN_MESSAGE });
    expect(changeRoleWithAudit).not.toHaveBeenCalled();
  });

  it.each([
    [{ outcome: "not_found" } as const, NotFoundError, 404, USER_NOT_FOUND_MESSAGE],
    [{ outcome: "actor_not_admin" } as const, ForbiddenError, 403, ACTOR_NOT_ACTIVE_ADMIN_MESSAGE],
    [{ outcome: "last_admin" } as const, ConflictError, 409, LAST_ADMIN_CONFLICT_MESSAGE],
  ])("traduce %j del repositorio al error HTTP correspondiente", async (result, ErrorClass, statusCode, message) => {
    // Arrange
    const { repository } = createMockRepository(result);

    // Act
    const err = await captureError(new UserAdminService(repository).changeRole(ADMIN, TARGET_ID, "USER"));

    // Assert
    expect(err).toBeInstanceOf(ErrorClass);
    expect(err).toMatchObject({ statusCode, message });
  });

  it("propaga errores inesperados del repositorio sin envolverlos", async () => {
    // Arrange
    const { repository, changeRoleWithAudit } = createMockRepository();
    const failure = new Error("timeout");
    changeRoleWithAudit.mockRejectedValueOnce(failure);

    // Act & Assert
    expect(await captureError(new UserAdminService(repository).changeRole(ADMIN, TARGET_ID, "CHEF"))).toBe(failure);
  });
});
