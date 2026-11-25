import type { JwtConfig } from "../../src/modules/auth/index.js";

/** Configuración JWT compartida por las suites End-to-End (#22). Solo para pruebas. */
export const E2E_JWT_CONFIG: JwtConfig = Object.freeze({
  secret: "test-jwt-secret-".repeat(3),
  expiresIn: "1h",
});
