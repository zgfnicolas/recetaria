import { describe, expect, it } from "vitest";
import { USER_ROLES, type Actor, type UserRole } from "../auth/index.js";
import { canApprove, canDelete, canEdit, RECIPE_APPROVER_ROLES } from "./recipe.policy.js";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_AUTHOR_ID = "22222222-2222-4222-8222-222222222222";

function actor(role: UserRole): Actor {
  return { id: ACTOR_ID, role };
}

describe("RECIPE_APPROVER_ROLES — Revisores Profesionales (RN-04)", () => {
  it("contiene exactamente CHEF y NUTRITIONIST", () => {
    expect([...RECIPE_APPROVER_ROLES].sort()).toEqual(["CHEF", "NUTRITIONIST"]);
  });
});

describe("canApprove — rol profesional (RN-04) y separación de funciones (RN-05)", () => {
  const expectations: Record<UserRole, Readonly<{ ofOther: boolean; own: boolean }>> = {
    USER: { ofOther: false, own: false },
    ADMIN: { ofOther: false, own: false },
    CHEF: { ofOther: true, own: false },
    NUTRITIONIST: { ofOther: true, own: false },
  };

  it.each(USER_ROLES.map((role) => [role, expectations[role].ofOther] as const))(
    "%s sobre una receta de otro Autor → %s",
    (role, expected) => {
      expect(canApprove(actor(role), { authorId: OTHER_AUTHOR_ID })).toBe(expected);
    },
  );

  it.each(USER_ROLES.map((role) => [role, expectations[role].own] as const))(
    "%s sobre su propia receta → %s (nunca auto-aprobación)",
    (role, expected) => {
      expect(canApprove(actor(role), { authorId: ACTOR_ID })).toBe(expected);
    },
  );
});

describe("canEdit — propiedad exclusiva del Autor (RN-02)", () => {
  it.each(USER_ROLES)("%s puede editar su propia receta", (role) => {
    expect(canEdit(actor(role), { authorId: ACTOR_ID })).toBe(true);
  });

  it.each(USER_ROLES)("%s no puede editar una receta ajena (sin excepción para ADMIN)", (role) => {
    expect(canEdit(actor(role), { authorId: OTHER_AUTHOR_ID })).toBe(false);
  });
});

describe("canDelete — Autor o ADMIN (RN-03)", () => {
  it.each(USER_ROLES)("%s puede eliminar su propia receta", (role) => {
    expect(canDelete(actor(role), { authorId: ACTOR_ID })).toBe(true);
  });

  it.each(USER_ROLES.map((role) => [role, role === "ADMIN"] as const))(
    "%s sobre una receta ajena → %s (solo ADMIN modera)",
    (role, expected) => {
      expect(canDelete(actor(role), { authorId: OTHER_AUTHOR_ID })).toBe(expected);
    },
  );
});
