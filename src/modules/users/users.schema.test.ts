import { describe, expect, it } from "vitest";
import { USER_ROLES } from "../auth/index.js";
import { changeRoleSchema, userIdParamsSchema } from "./users.schema.js";

describe("changeRoleSchema (#53)", () => {
  it.each(USER_ROLES)("acepta el rol %s", (role) => {
    expect(changeRoleSchema.parse({ role })).toEqual({ role });
  });

  it.each(["SUPERADMIN", "admin", "", null, 1, ["ADMIN"]])("rechaza el rol inválido %j", (role) => {
    const result = changeRoleSchema.safeParse({ role });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["role"], message: "Rol inválido" });
  });

  it("rechaza {} (role obligatorio)", () => {
    expect(changeRoleSchema.safeParse({}).success).toBe(false);
  });

  it.each(["isActive", "email", "passwordHash", "id", "Role"])("rechaza el campo extra %s (BOPLA)", (key) => {
    const result = changeRoleSchema.safeParse({ role: "CHEF", [key]: "x" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ code: "unrecognized_keys", keys: [key] });
  });
});

describe("userIdParamsSchema", () => {
  it("acepta un UUID v4", () => {
    const id = "6f1c2d3e-4b5a-4c6d-8e7f-0123456789ab";
    expect(userIdParamsSchema.parse({ id })).toEqual({ id });
  });

  it.each(["abc", "6f1c2d3e-4b5a-1c6d-8e7f-0123456789ab", ""])("rechaza %j", (id) => {
    expect(userIdParamsSchema.safeParse({ id }).success).toBe(false);
  });
});
