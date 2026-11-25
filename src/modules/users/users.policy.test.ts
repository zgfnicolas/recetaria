import { describe, expect, it } from "vitest";
import { canChangeRole, canChangeStatus } from "./users.policy.js";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";

describe("canChangeRole — RN-09", () => {
  it("permite cambiar el rol de otro usuario", () => {
    expect(canChangeRole({ id: ADMIN_ID, role: "ADMIN" }, "22222222-2222-4222-8222-222222222222")).toBe(true);
  });

  it("prohíbe que un ADMIN cambie su propio rol", () => {
    expect(canChangeRole({ id: ADMIN_ID, role: "ADMIN" }, ADMIN_ID)).toBe(false);
  });
});

describe("canChangeStatus — RN-10", () => {
  it("permite cambiar el estado de otra cuenta y prohíbe el de la propia", () => {
    const admin = { id: ADMIN_ID, role: "ADMIN" } as const;
    expect(canChangeStatus(admin, "22222222-2222-4222-8222-222222222222")).toBe(true);
    expect(canChangeStatus(admin, ADMIN_ID)).toBe(false);
  });
});
