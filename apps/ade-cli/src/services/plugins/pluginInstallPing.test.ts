import { createHash, createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { pluginInstallPingsEnabled, reportPluginInstall } from "./pluginInstallPing";

const MACHINE_KEY = "a".repeat(32);
const MACHINE_SECRET = "s".repeat(48);

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function store(overrides: { claimed?: boolean } = {}) {
  return {
    isClaimed: () => overrides.claimed ?? true,
    getOrCreateIdentity: () => ({ machineKey: MACHINE_KEY, machineSecret: MACHINE_SECRET }),
  } as never;
}

/** The worker's canonical base, recomputed independently of the client. */
function expectedSignature(pathname: string, timestamp: string, body: string): string {
  const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
  const base = `${timestamp}.POST.${pathname}.${bodyHash}`;
  return `sha256=${createHmac("sha256", MACHINE_SECRET).update(base, "utf8").digest("hex")}`;
}

describe("plugin install ping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends only the plugin id and version, signed as the machine", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    const outcome = await reportPluginInstall(
      { store: store(), logger, baseUrl: "https://relay.example", env: {}, fetchImpl: fetchImpl as never },
      { pluginId: "graph", version: "1.2.0" },
    );

    expect(outcome).toBe("sent");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://relay.example/machines/${MACHINE_KEY}/plugin-installs`);
    // The payload IS the contract. Anything else here would be a usage log.
    expect(JSON.parse(init.body as string)).toEqual({ pluginId: "graph", version: "1.2.0" });

    const headers = init.headers as Record<string, string>;
    expect(headers["x-ade-push-signature"]).toBe(expectedSignature(
      `/machines/${MACHINE_KEY}/plugin-installs`,
      headers["x-ade-push-timestamp"]!,
      init.body as string,
    ));
  });

  it("never registers a machine just to report telemetry", async () => {
    const fetchImpl = vi.fn();
    const outcome = await reportPluginInstall(
      {
        store: store({ claimed: false }),
        logger,
        baseUrl: "https://relay.example",
        env: {},
        fetchImpl: fetchImpl as never,
      },
      { pluginId: "graph", version: "1.2.0" },
    );
    expect(outcome).toBe("skipped");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is switched off by one environment variable", async () => {
    const fetchImpl = vi.fn();
    for (const value of ["0", "false", "off", "no", "OFF"]) {
      expect(pluginInstallPingsEnabled({ ADE_PLUGIN_INSTALL_PINGS: value })).toBe(false);
      const outcome = await reportPluginInstall(
        {
          store: store(),
          logger,
          baseUrl: "https://relay.example",
          env: { ADE_PLUGIN_INSTALL_PINGS: value },
          fetchImpl: fetchImpl as never,
        },
        { pluginId: "graph", version: "1.2.0" },
      );
      expect(outcome).toBe("skipped");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(pluginInstallPingsEnabled({})).toBe(true);
  });

  it("swallows a failure — an install that worked must not report an error", async () => {
    const failures: Array<() => Promise<Response>> = [
      async () => {
        throw new Error("offline");
      },
      async () => new Response("nope", { status: 500 }),
    ];
    for (const fail of failures) {
      const outcome = await reportPluginInstall(
        {
          store: store(),
          logger,
          baseUrl: "https://relay.example",
          env: {},
          fetchImpl: vi.fn(fail) as never,
        },
        { pluginId: "graph", version: "1.2.0" },
      );
      expect(outcome).toBe("failed");
    }
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("does not report an id or version the relay would refuse", async () => {
    const fetchImpl = vi.fn();
    for (const install of [
      { pluginId: "../escape", version: "1.0.0" },
      { pluginId: "Graph", version: "1.0.0" },
      { pluginId: "graph", version: "latest" },
    ]) {
      expect(await reportPluginInstall(
        { store: store(), logger, baseUrl: "https://relay.example", env: {}, fetchImpl: fetchImpl as never },
        install,
      )).toBe("skipped");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
