import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEnv } from "../../../src/config/env.js";
import { startServer, type RunningServer } from "../../../src/server.js";

type ProbeResult = Readonly<{
  status: number;
  partitionKey: string;
  remaining: number;
}>;

/**
 * Integración de extremo a extremo de #38: `startServer` real (env validado → `buildApp`
 * con `trustProxy` → rate limit del catálogo sobre PostgreSQL). La clave de partición `pk`
 * de `RateLimit-Policy` es un hash de la IP que usa el limitador: si dos solicitudes
 * comparten `pk`, comparten cuota. El par TCP de las pruebas es siempre 127.0.0.1.
 */
describe("TRUST_PROXY en startServer — IP del cliente para el rate limit (#38)", () => {
  let running: RunningServer | undefined;

  async function start(trustProxy: string | undefined): Promise<{
    readonly baseUrl: string;
    readonly logs: readonly string[];
  }> {
    const logs: string[] = [];
    const env = parseEnv({ ...process.env, NODE_ENV: "test", TRUST_PROXY: trustProxy });
    running = startServer({
      env,
      port: 0,
      registerSignals: false,
      onLog: (line) => logs.push(line),
      onError: () => undefined,
      exit: vi.fn(),
    });
    if (!running.server.listening) {
      await once(running.server, "listening");
    }
    const { port } = running.server.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${String(port)}`, logs };
  }

  /** GET al catálogo con `X-Forwarded-For`; exige `200` y headers de rate limit presentes. */
  async function probe(baseUrl: string, forwardedFor: string): Promise<ProbeResult> {
    const res = await fetch(`${baseUrl}/api/v1/recipes`, {
      headers: { "X-Forwarded-For": forwardedFor },
    });
    await res.arrayBuffer();
    const partitionKey = /pk=:([^:]+):/.exec(res.headers.get("ratelimit-policy") ?? "")?.[1];
    const remaining = /r=(\d+)/.exec(res.headers.get("ratelimit") ?? "")?.[1];

    expect(res.status).toBe(200);
    expect(partitionKey).toBeDefined();
    expect(remaining).toBeDefined();
    return { status: res.status, partitionKey: partitionKey ?? "", remaining: Number(remaining) };
  }

  afterEach(async () => {
    if (running !== undefined) {
      running.disposeListeners();
      await running.shutdown("SIGTERM");
      running = undefined;
    }
  });

  it("con TRUST_PROXY=1 usa la IP de X-Forwarded-For: clientes distintos tienen cuotas separadas", async () => {
    // Arrange
    const { baseUrl, logs } = await start("1");

    // Act
    const clientA = await probe(baseUrl, "203.0.113.10");
    const clientAAgain = await probe(baseUrl, "203.0.113.10");
    const clientB = await probe(baseUrl, "198.51.100.20");

    // Assert
    expect(clientAAgain.partitionKey).toBe(clientA.partitionKey);
    expect(clientB.partitionKey).not.toBe(clientA.partitionKey);
    expect([clientA.remaining, clientAAgain.remaining, clientB.remaining]).toEqual([119, 118, 119]);
    expect(logs).toContain("[SERVER] trust proxy: 1 salto de proxy");
  });

  it("con TRUST_PROXY=1 anteponer IPs falsas en la cadena no da cuota nueva (usa la más cercana al proxy)", async () => {
    // Arrange: el proxy real agrega la IP verdadera del cliente al final de la cadena
    const { baseUrl } = await start("1");

    // Act
    const first = await probe(baseUrl, "198.51.100.99, 203.0.113.10");
    const spoofedPrefix = await probe(baseUrl, "192.0.2.77, 203.0.113.10");

    // Assert
    expect(spoofedPrefix.partitionKey).toBe(first.partitionKey);
    expect([first.remaining, spoofedPrefix.remaining]).toEqual([119, 118]);
  });

  it("el número de saltos define qué entrada de la cadena es el cliente (1 vs 2 saltos)", async () => {
    // Arrange: cadena "cliente, proxy-interno" detrás de un segundo proxy (127.0.0.1)
    const oneHop = await start("1");
    const oneA = await probe(oneHop.baseUrl, "203.0.113.10, 10.0.0.2");
    const oneB = await probe(oneHop.baseUrl, "198.51.100.20, 10.0.0.2");
    running?.disposeListeners();
    await running?.shutdown("SIGTERM");
    running = undefined;

    // Act
    const twoHops = await start("2");
    const twoA = await probe(twoHops.baseUrl, "203.0.113.10, 10.0.0.2");
    const twoB = await probe(twoHops.baseUrl, "198.51.100.20, 10.0.0.2");

    // Assert: con 1 salto ambos se identifican como 10.0.0.2; con 2, como sus IPs reales
    expect(oneB.partitionKey).toBe(oneA.partitionKey);
    expect(twoB.partitionKey).not.toBe(twoA.partitionKey);
    expect(twoHops.logs).toContain("[SERVER] trust proxy: 2 saltos de proxy");
  });

  it("agrupa los clientes IPv6 de X-Forwarded-For por subred /56", async () => {
    // Arrange
    const { baseUrl } = await start("1");

    // Act
    const first = await probe(baseUrl, "2001:db8:0:1::1");
    const sameSubnet = await probe(baseUrl, "2001:db8:0:1::2");
    const otherSubnet = await probe(baseUrl, "2001:db8:0:100::1");

    // Assert
    expect(sameSubnet.partitionKey).toBe(first.partitionKey);
    expect(otherSubnet.partitionKey).not.toBe(first.partitionKey);
  });

  it("sin TRUST_PROXY ignora X-Forwarded-For: falsificar el header no da una cuota nueva", async () => {
    // Arrange
    const { baseUrl, logs } = await start(undefined);

    // Act
    const first = await probe(baseUrl, "203.0.113.10");
    const spoofed = await probe(baseUrl, "198.51.100.20");

    // Assert
    expect(spoofed.partitionKey).toBe(first.partitionKey);
    expect([first.remaining, spoofed.remaining]).toEqual([119, 118]);
    expect(logs).toContain("[SERVER] trust proxy: desactivado (se ignora X-Forwarded-For)");
  });

  it.each([
    ["127.0.0.1", "direcciones de confianza 127.0.0.1"],
    ["loopback", "direcciones de confianza loopback"],
    ["10.0.0.0/8, loopback", "direcciones de confianza 10.0.0.0/8,loopback"],
  ])(
    "con la lista %j que incluye al proxy real (127.0.0.1) confía en su X-Forwarded-For",
    async (trustProxy, logged) => {
      // Arrange
      const { baseUrl, logs } = await start(trustProxy);

      // Act
      const clientA = await probe(baseUrl, "203.0.113.10");
      const clientB = await probe(baseUrl, "198.51.100.20");

      // Assert
      expect(clientB.partitionKey).not.toBe(clientA.partitionKey);
      expect([clientA.remaining, clientB.remaining]).toEqual([119, 119]);
      expect(logs).toContain(`[SERVER] trust proxy: ${logged}`);
    },
  );

  it("con una lista que no incluye al par TCP (10.0.0.0/8) ignora el X-Forwarded-For de un cliente directo", async () => {
    // Arrange
    const { baseUrl } = await start("10.0.0.0/8");

    // Act
    const first = await probe(baseUrl, "203.0.113.10");
    const spoofed = await probe(baseUrl, "198.51.100.20");

    // Assert
    expect(spoofed.partitionKey).toBe(first.partitionKey);
    expect([first.remaining, spoofed.remaining]).toEqual([119, 118]);
  });

  it.each(["true", "0.0.0.0/1,128.0.0.0/1", "::ffff:0:0/96"])(
    "startServer aborta antes de escuchar ni abrir el pool si TRUST_PROXY=%j es inseguro",
    (value) => {
      // Arrange: sin `env` explícito, startServer valida process.env con loadEnv()
      vi.stubEnv("TRUST_PROXY", value);

      // Act / Assert
      expect(() =>
        startServer({ port: 0, registerSignals: false, onLog: () => undefined, exit: vi.fn() }),
      ).toThrow(/TRUST_PROXY no admite/);
    },
  );
});
