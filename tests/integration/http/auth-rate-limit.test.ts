import type express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../src/app.js";
import type { AuthRateLimitOptions } from "../../../src/bootstrap/container.js";
import {
  disconnect,
  getDatabase,
  type Database,
} from "../../../src/infrastructure/database/prisma.js";
import {
  AUTH_RATE_LIMIT_EXCEEDED_MESSAGE,
  DEFAULT_AUTH_LOGIN_ACCOUNT_RATE_LIMIT,
  DEFAULT_AUTH_LOGIN_IP_RATE_LIMIT,
  DEFAULT_AUTH_REGISTER_RATE_LIMIT,
  type JwtConfig,
} from "../../../src/modules/auth/index.js";
import { truncateAll } from "../../support/database.js";

const TEST_JWT_CONFIG: JwtConfig = {
  secret: "test-jwt-secret-".repeat(3),
  expiresIn: "1h",
};

const VICTIM_EMAIL = "victima@recetaria.com";
const VICTIM_PASSWORD = "clave-correcta-123";
const WRONG_PASSWORD = "clave-incorrecta-999";

const RATE_LIMITED_BODY = {
  success: false,
  statusCode: 429,
  message: AUTH_RATE_LIMIT_EXCEEDED_MESSAGE,
  errors: [],
};

async function truncateTables(db: Database): Promise<void> {
  await truncateAll(db);
}

describe("Rate limit de /api/v1/auth contra fuerza bruta (#39, OWASP API2/API4)", () => {
  let db: Database;

  /** App con `trust proxy` de 1 salto para simular clientes con IPs distintas vía `X-Forwarded-For`. */
  function createApp(authRateLimit?: AuthRateLimitOptions | false): express.Express {
    return buildApp({
      prisma: db.prisma,
      jwt: TEST_JWT_CONFIG,
      trustProxy: 1,
      authRateLimit,
      onLog: () => undefined,
      onError: () => undefined,
    });
  }

  function login(
    app: express.Express,
    ip: string,
    body: Record<string, unknown>,
  ): request.Test {
    return request(app).post("/api/v1/auth/login").set("X-Forwarded-For", ip).send(body);
  }

  async function registerVictim(app: express.Express): Promise<void> {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .set("X-Forwarded-For", "192.0.2.1")
      .send({ email: VICTIM_EMAIL, password: VICTIM_PASSWORD, firstName: "Víctima", lastName: "Prueba" });
    expect(res.status).toBe(201);
  }

  beforeAll(() => {
    db = getDatabase();
  });

  beforeEach(async () => {
    await truncateTables(db);
  });

  afterEach(async () => {
    await truncateTables(db);
  });

  afterAll(async () => {
    await disconnect();
  });

  it("aplica por defecto auth-login-ip (10/15 min) y auth-register-ip (5/h) con headers; auth-login-account no los emite", async () => {
    // Arrange
    const app = createApp();

    // Act
    const loginRes = await login(app, "203.0.113.1", { email: "nadie@recetaria.com", password: "x" });
    const registerRes = await request(app)
      .post("/api/v1/auth/register")
      .set("X-Forwarded-For", "203.0.113.1")
      .send({});

    // Assert
    expect(loginRes.status).toBe(401);
    expect(loginRes.headers["ratelimit-policy"]).toMatch(/^"auth-login-ip"; q=10; w=900; pk=:[^:]+:$/);
    expect(String(loginRes.headers["ratelimit"])).not.toContain("auth-login-account");
    expect(registerRes.status).toBe(400);
    expect(registerRes.headers["ratelimit-policy"]).toMatch(/^"auth-register-ip"; q=5; w=3600;/);
  });

  it("cablea por defecto 20 fallos por cuenta: 10 + 10 desde dos IPs y el 21.º desde una tercera da 429", async () => {
    // Arrange: defaults reales (10 por IP no se superan en ninguna IP)
    const app = createApp();
    await registerVictim(app);
    for (const ip of ["203.0.113.201", "203.0.113.202"]) {
      for (let i = 0; i < 10; i += 1) {
        expect((await login(app, ip, { email: VICTIM_EMAIL, password: WRONG_PASSWORD })).status).toBe(401);
      }
    }

    // Act
    const blocked = await login(app, "203.0.113.203", { email: VICTIM_EMAIL, password: VICTIM_PASSWORD });

    // Assert
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual(RATE_LIMITED_BODY);
  });

  describe("Login por IP", () => {
    const IP_LIMIT_3: AuthRateLimitOptions = {
      login: { ...DEFAULT_AUTH_LOGIN_IP_RATE_LIMIT, limit: 3 },
      loginAccount: false,
    };

    it("los logins exitosos no consumen cuota; 3 fallidos bloquean con 429 JSend y Retry-After", async () => {
      // Arrange
      const app = createApp(IP_LIMIT_3);
      await registerVictim(app);

      // Act
      const successes: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        successes.push((await login(app, "203.0.113.10", { email: VICTIM_EMAIL, password: VICTIM_PASSWORD })).status);
      }
      const failures: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        failures.push((await login(app, "203.0.113.10", { email: VICTIM_EMAIL, password: WRONG_PASSWORD })).status);
      }
      const blocked = await login(app, "203.0.113.10", { email: VICTIM_EMAIL, password: WRONG_PASSWORD });

      // Assert
      expect(successes).toEqual([200, 200, 200, 200, 200]);
      expect(failures).toEqual([401, 401, 401]);
      expect(blocked.status).toBe(429);
      expect(blocked.body).toEqual(RATE_LIMITED_BODY);
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    });

    it("una IP bloqueada no puede entrar ni con la clave correcta; otra IP sí", async () => {
      // Arrange
      const app = createApp(IP_LIMIT_3);
      await registerVictim(app);
      for (let i = 0; i < 3; i += 1) {
        await login(app, "203.0.113.20", { email: `otro${String(i)}@recetaria.com`, password: WRONG_PASSWORD });
      }

      // Act
      const sameIp = await login(app, "203.0.113.20", { email: VICTIM_EMAIL, password: VICTIM_PASSWORD });
      const otherIp = await login(app, "198.51.100.20", { email: VICTIM_EMAIL, password: VICTIM_PASSWORD });

      // Assert
      expect(sameIp.status).toBe(429);
      expect(otherIp.status).toBe(200);
    });

    it("los 400 de validación consumen cuota (el límite corre antes de Zod)", async () => {
      // Arrange
      const app = createApp(IP_LIMIT_3);

      // Act
      const statuses: number[] = [];
      for (const body of [{}, { email: "no-es-email" }, { email: VICTIM_EMAIL }]) {
        statuses.push((await login(app, "203.0.113.30", body)).status);
      }
      const blocked = await login(app, "203.0.113.30", { email: VICTIM_EMAIL, password: "x" });

      // Assert
      expect(statuses).toEqual([400, 400, 400]);
      expect(blocked.status).toBe(429);
    });

    it("cuenta una cuenta inactiva (401 de RN-08) como intento fallido aunque la clave sea correcta", async () => {
      // Arrange
      const app = createApp(IP_LIMIT_3);
      await registerVictim(app);
      await db.prisma.user.update({ where: { email: VICTIM_EMAIL }, data: { isActive: false } });

      // Act
      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        statuses.push((await login(app, "203.0.113.35", { email: VICTIM_EMAIL, password: VICTIM_PASSWORD })).status);
      }

      // Assert
      expect(statuses).toEqual([401, 401, 401, 429]);
    });

    it("con fallos en paralelo (mientras corre bcrypt) deja pasar exactamente 3 y bloquea el resto", async () => {
      // Arrange
      const app = createApp(IP_LIMIT_3);
      await registerVictim(app);
      const findUniqueSpy = vi.spyOn(db.prisma.user, "findUnique");

      // Act
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          login(app, "203.0.113.36", { email: VICTIM_EMAIL, password: WRONG_PASSWORD }),
        ),
      );

      // Assert
      const statuses = responses.map((res) => res.status).sort();
      expect(statuses).toEqual([401, 401, 401, 429, 429, 429, 429, 429]);
      expect(findUniqueSpy).toHaveBeenCalledTimes(3);
    });

    it("restablece la cuota al vencer la ventana", async () => {
      // Arrange
      const app = createApp({ login: { ...DEFAULT_AUTH_LOGIN_IP_RATE_LIMIT, limit: 1, windowMs: 1_000 }, loginAccount: false });
      await registerVictim(app);
      await login(app, "203.0.113.37", { email: VICTIM_EMAIL, password: WRONG_PASSWORD });
      const blocked = await login(app, "203.0.113.37", { email: VICTIM_EMAIL, password: VICTIM_PASSWORD });
      expect(blocked.status).toBe(429);

      // Act
      await new Promise((resolve) => {
        setTimeout(resolve, 1_500);
      });
      const afterWindow = await login(app, "203.0.113.37", { email: VICTIM_EMAIL, password: VICTIM_PASSWORD });

      // Assert
      expect(afterWindow.status).toBe(200);
    });

    it("un 429 no llega al servicio: no consulta la base (y por lo tanto no ejecuta bcrypt.compare)", async () => {
      // Arrange
      const app = createApp(IP_LIMIT_3);
      for (let i = 0; i < 3; i += 1) {
        await login(app, "203.0.113.40", { email: VICTIM_EMAIL, password: WRONG_PASSWORD });
      }
      const findUniqueSpy = vi.spyOn(db.prisma.user, "findUnique");

      // Act
      const blocked = await Promise.all(
        Array.from({ length: 5 }, () =>
          login(app, "203.0.113.40", { email: VICTIM_EMAIL, password: WRONG_PASSWORD }),
        ),
      );

      // Assert
      expect(blocked.map((res) => res.status)).toEqual([429, 429, 429, 429, 429]);
      expect(findUniqueSpy).not.toHaveBeenCalled();
    });
  });

  describe("Login por cuenta (ataque distribuido)", () => {
    const ACCOUNT_LIMIT_3: AuthRateLimitOptions = {
      login: false,
      loginAccount: { ...DEFAULT_AUTH_LOGIN_ACCOUNT_RATE_LIMIT, limit: 3 },
    };

    it("bloquea la cuenta tras 3 fallos desde IPs distintas; otra cuenta desde la misma IP no se ve afectada", async () => {
      // Arrange
      const app = createApp(ACCOUNT_LIMIT_3);
      await registerVictim(app);
      for (const ip of ["203.0.113.51", "203.0.113.52", "203.0.113.53"]) {
        await login(app, ip, { email: VICTIM_EMAIL, password: WRONG_PASSWORD });
      }

      // Act
      const victim = await login(app, "203.0.113.54", { email: VICTIM_EMAIL, password: VICTIM_PASSWORD });
      const otherAccount = await login(app, "203.0.113.54", {
        email: "otra@recetaria.com",
        password: WRONG_PASSWORD,
      });

      // Assert
      expect(victim.status).toBe(429);
      expect(victim.body).toEqual(RATE_LIMITED_BODY);
      expect(otherAccount.status).toBe(401);
    });

    it("responde el mismo 429 para un email existente y uno inexistente (anti-enumeración RN-08)", async () => {
      // Arrange
      const app = createApp(ACCOUNT_LIMIT_3);
      await registerVictim(app);
      for (const email of [VICTIM_EMAIL, "fantasma@recetaria.com"]) {
        for (let i = 0; i < 3; i += 1) {
          await login(app, `203.0.113.${String(60 + i)}`, { email, password: WRONG_PASSWORD });
        }
      }

      // Act
      const existing = await login(app, "203.0.113.70", { email: VICTIM_EMAIL, password: WRONG_PASSWORD });
      const ghost = await login(app, "203.0.113.70", {
        email: "fantasma@recetaria.com",
        password: WRONG_PASSWORD,
      });

      // Assert
      expect(existing.status).toBe(429);
      expect(ghost.status).toBe(429);
      expect(ghost.body).toEqual(existing.body);
    });

    it("las variantes de mayúsculas y espacios del email comparten cuota", async () => {
      // Arrange
      const app = createApp(ACCOUNT_LIMIT_3);
      const variants = ["victima@recetaria.com", " VICTIMA@recetaria.com", "Victima@Recetaria.COM  "];
      for (const [i, email] of variants.entries()) {
        await login(app, `203.0.113.${String(80 + i)}`, { email, password: WRONG_PASSWORD });
      }

      // Act
      const blocked = await login(app, "203.0.113.90", { email: "VICTIMA@RECETARIA.COM", password: "x" });

      // Assert
      expect(blocked.status).toBe(429);
    });

    it("no emite headers: no revela a terceros cuántos fallos tuvo un email ni cuándo se bloquea (ni en el 429)", async () => {
      // Arrange
      const app = createApp(ACCOUNT_LIMIT_3);
      const responses = [];
      for (let i = 0; i < 4; i += 1) {
        responses.push(await login(app, `203.0.113.${String(91 + i)}`, { email: VICTIM_EMAIL, password: WRONG_PASSWORD }));
      }

      // Assert
      expect(responses.map((res) => res.status)).toEqual([401, 401, 401, 429]);
      for (const res of responses) {
        expect(res.headers["ratelimit"]).toBeUndefined();
        expect(res.headers["ratelimit-policy"]).toBeUndefined();
        expect(res.headers["retry-after"]).toBeUndefined();
      }
    });

    it("un 429 por cuenta tampoco llega a la base", async () => {
      // Arrange
      const app = createApp(ACCOUNT_LIMIT_3);
      for (let i = 0; i < 3; i += 1) {
        await login(app, `203.0.113.${String(140 + i)}`, { email: VICTIM_EMAIL, password: WRONG_PASSWORD });
      }
      const findUniqueSpy = vi.spyOn(db.prisma.user, "findUnique");

      // Act
      const blocked = await login(app, "203.0.113.150", { email: VICTIM_EMAIL, password: VICTIM_PASSWORD });

      // Assert
      expect(blocked.status).toBe(429);
      expect(findUniqueSpy).not.toHaveBeenCalled();
    });

    it("un cuerpo sin email utilizable no se limita por cuenta (solo aplica el límite por IP)", async () => {
      // Arrange
      const app = createApp(ACCOUNT_LIMIT_3);

      // Act
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        statuses.push((await login(app, "203.0.113.160", { password: "x" })).status);
      }

      // Assert
      expect(statuses).toEqual([400, 400, 400, 400, 400]);
    });
  });

  describe("Login con ambos limitadores activos", () => {
    const BOTH: AuthRateLimitOptions = {
      login: { ...DEFAULT_AUTH_LOGIN_IP_RATE_LIMIT, limit: 3 },
      loginAccount: { ...DEFAULT_AUTH_LOGIN_ACCOUNT_RATE_LIMIT, limit: 5 },
    };

    it("cuando bloquea la IP, el intento no suma a la cuenta: desde otra IP la víctima entra", async () => {
      // Arrange
      const app = createApp(BOTH);
      await registerVictim(app);
      for (let i = 0; i < 3; i += 1) {
        await login(app, "203.0.113.170", { email: VICTIM_EMAIL, password: WRONG_PASSWORD });
      }

      // Act
      const blockedByIp = await Promise.all(
        Array.from({ length: 4 }, () =>
          login(app, "203.0.113.170", { email: VICTIM_EMAIL, password: WRONG_PASSWORD }),
        ),
      );
      const victimFromOtherIp = await login(app, "198.51.100.170", {
        email: VICTIM_EMAIL,
        password: VICTIM_PASSWORD,
      });

      // Assert: la cuenta lleva 3 de 5 fallos; los 4 bloqueos por IP no la incrementaron
      expect(blockedByIp.map((res) => res.status)).toEqual([429, 429, 429, 429]);
      expect(victimFromOtherIp.status).toBe(200);
    });

    it("reintentar contra una cuenta bloqueada no agota la cuota de la IP (NAT): otra cuenta desde esa IP entra", async () => {
      // Arrange: la cuenta de la víctima queda bloqueada con 5 fallos repartidos en 5 IPs
      const app = createApp(BOTH);
      await registerVictim(app);
      const other = await request(app)
        .post("/api/v1/auth/register")
        .set("X-Forwarded-For", "192.0.2.2")
        .send({ email: "vecina@recetaria.com", password: VICTIM_PASSWORD, firstName: "Vecina", lastName: "Prueba" });
      expect(other.status).toBe(201);
      for (let i = 0; i < 5; i += 1) {
        await login(app, `203.0.113.${String(180 + i)}`, { email: VICTIM_EMAIL, password: WRONG_PASSWORD });
      }

      // Act: desde la IP compartida, 6 reintentos de la víctima (todos 429 por cuenta)
      const retries: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        retries.push((await login(app, "203.0.113.190", { email: VICTIM_EMAIL, password: VICTIM_PASSWORD })).status);
      }
      const neighbour = await login(app, "203.0.113.190", {
        email: "vecina@recetaria.com",
        password: VICTIM_PASSWORD,
      });

      // Assert
      expect(retries).toEqual([429, 429, 429, 429, 429, 429]);
      expect(neighbour.status).toBe(200);
    });
  });

  describe("Registro por IP", () => {
    it("cuenta también los registros rechazados (400 y 409 por email duplicado)", async () => {
      // Arrange
      const app = createApp({
        login: false,
        loginAccount: false,
        register: { ...DEFAULT_AUTH_REGISTER_RATE_LIMIT, limit: 2 },
      });
      await registerVictim(app);
      const fromAttacker = (): request.Test =>
        request(app).post("/api/v1/auth/register").set("X-Forwarded-For", "203.0.113.110");

      // Act
      const invalid = await fromAttacker().send({});
      const duplicate = await fromAttacker().send({
        email: VICTIM_EMAIL,
        password: VICTIM_PASSWORD,
        firstName: "Otra",
        lastName: "Persona",
      });
      const valid = await fromAttacker().send({
        email: "nueva@recetaria.com",
        password: VICTIM_PASSWORD,
        firstName: "Nueva",
        lastName: "Persona",
      });

      // Assert
      expect([invalid.status, duplicate.status, valid.status]).toEqual([400, 409, 429]);
      expect(await db.prisma.user.count()).toBe(1);
    });

    it("bloquea el 3.er registro de la misma IP sin afectar al login ni al catálogo", async () => {
      // Arrange
      const app = createApp({
        login: false,
        loginAccount: false,
        register: { ...DEFAULT_AUTH_REGISTER_RATE_LIMIT, limit: 2 },
      });
      const register = (i: number): request.Test =>
        request(app)
          .post("/api/v1/auth/register")
          .set("X-Forwarded-For", "203.0.113.100")
          .send({ email: `nuevo${String(i)}@recetaria.com`, password: "clave-segura-123", firstName: "Nuevo", lastName: "Usuario" });

      // Act
      const statuses = [(await register(1)).status, (await register(2)).status];
      const blocked = await register(3);
      const loginRes = await login(app, "203.0.113.100", {
        email: "nuevo1@recetaria.com",
        password: "clave-segura-123",
      });
      const catalog = await request(app).get("/api/v1/recipes").set("X-Forwarded-For", "203.0.113.100");

      // Assert
      expect(statuses).toEqual([201, 201]);
      expect(blocked.status).toBe(429);
      expect(blocked.body).toEqual(RATE_LIMITED_BODY);
      expect(await db.prisma.user.count()).toBe(2);
      expect(loginRes.status).toBe(200);
      expect(catalog.status).toBe(200);
    });
  });

  it("authRateLimit: false desactiva todos los límites de /auth (sin headers ni 429)", async () => {
    // Arrange
    const app = createApp(false);

    // Act
    const responses = [];
    for (let i = 0; i < 12; i += 1) {
      responses.push(await login(app, "203.0.113.200", { email: VICTIM_EMAIL, password: WRONG_PASSWORD }));
    }

    // Assert
    expect(responses.every((res) => res.status === 401)).toBe(true);
    expect(responses[0]?.headers["ratelimit-policy"]).toBeUndefined();
  });
});
