export { AuthController } from "./auth.controller.js";
export {
  AUTH_RATE_LIMIT_EXCEEDED_MESSAGE,
  DEFAULT_AUTH_LOGIN_ACCOUNT_RATE_LIMIT,
  DEFAULT_AUTH_LOGIN_IP_RATE_LIMIT,
  DEFAULT_AUTH_REGISTER_RATE_LIMIT,
  loginAccountRateLimitKey,
} from "./auth.rate-limit.js";
export { createAuthRouter, type AuthRouterOptions } from "./auth.router.js";
export {
  loginSchema,
  MAX_BCRYPT_PASSWORD_BYTES,
  registerSchema,
  USER_ROLES,
  type LoginDTO,
  type RegisterDTO,
  type UserRole,
} from "./auth.schema.js";
export {
  AuthService,
  BCRYPT_SALT_ROUNDS,
  DUMMY_BCRYPT_HASH,
  INVALID_CREDENTIALS_MESSAGE,
  SELF_REGISTERED_ROLE,
  type AuthServiceOptions,
  type AuthSession,
  type IAuthService,
  type RegisteredUser,
} from "./auth.service.js";
export {
  accessTokenPayloadSchema,
  assertValidJwtConfig,
  assertValidJwtSecret,
  INVALID_TOKEN_MESSAGE,
  JWT_ALGORITHM,
  MIN_JWT_SECRET_LENGTH,
  signAccessToken,
  verifyAccessToken,
  type Actor,
  type JwtConfig,
} from "./jwt.js";
export {
  UserRepository,
  type CreateUserInput,
  type IUserRepository,
  type UserAuthRecord,
  type UserRecord,
} from "./user.repository.js";
