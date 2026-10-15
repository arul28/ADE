import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What the spawned agent answers to `session/new`, and how many agents were started. */
const agent = vi.hoisted(() => ({ sessionNew: {} as Record<string, unknown>, started: 0 }));

vi.mock("./acpConnection", () => ({
  createAcpConnection: () => {
    agent.started += 1;
    return {
      request: async (method: string) => (method === "session/new" ? agent.sessionNew : {}),
      dispose: () => undefined,
    };
  },
  initializeAcpConnection: async () => ({ agentCapabilities: {} }),
}));
vi.mock("../../ai/acpExecutables", () => ({
  resolveAcpExecutable: (provider: string) => ({ path: provider, source: "path" }),
}));
vi.mock("../../ai/acpAuthProbe", () => ({ acpProbeConfigHome: () => undefined }));

function modelOption(ids: string[]): Record<string, unknown> {
  return {
    sessionId: "probe-session",
    configOptions: ids.length
      ? [{ id: "model", name: "Model", value: ids[0], options: ids.map((id) => ({ id, name: id })) }]
      : [],
  };
}

/** A fresh process: new registry and discovery state, the same cache file on disk. */
async function loadModules() {
  vi.resetModules();
  const registry = await import("../../../../shared/modelRegistry");
  const discovery = await import("./acpModelDiscovery");
  const shownIds = (provider: Parameters<typeof registry.listModelDescriptorsForProvider>[0]) =>
    registry.listModelDescriptorsForProvider(provider).map((model) => model.providerModelId);
  return { registry, discovery, shownIds };
}

/** A logger whose lines can be awaited: warms run in the background and say when they finish. */
function waitableLogger() {
  const lines: string[] = [];
  const waiters: Array<{ line: string; resolve: () => void }> = [];
  const record = (line: string) => {
    lines.push(line);
    for (const waiter of waiters.filter((entry) => entry.line === line)) waiter.resolve();
  };
  return {
    logger: {
      info: (event: string, meta?: Record<string, unknown>) => record(`${event} ${String(meta?.provider)}`),
      warn: (event: string, meta?: Record<string, unknown>) => record(`${event} ${String(meta?.provider)}`),
    },
    /** Resolves on the line, after the warm that logged it has let go of its provider. */
    next: (line: string) =>
      new Promise<void>((resolve) => waiters.push({ line, resolve })).then(() => new Promise<void>((resolve) => setImmediate(resolve))),
    lines,
  };
}

describe("ACP model discovery", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-acp-catalog-"));
    vi.stubEnv("ADE_HOME", home);
    agent.started = 0;
    agent.sessionNew = {};
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("shows exactly the list a chat reported, keeps it across a restart, and merges Devin's partial lists", async () => {
    const first = await loadModules();
    const report = (provider: "copilot" | "devin", ids: string[]) =>
      first.discovery.recordAcpSessionModelCatalog(
        provider,
        first.discovery.buildLiveAcpModelDescriptors({ provider, models: ids.map((id) => ({ id })) }),
      );

    report("copilot", ["model-alpha", "model-beta"]);
    expect(first.shownIds("copilot")).toEqual(["model-alpha", "model-beta"]);
    // A newer complete list replaces the old one: a dropped model leaves the picker.
    report("copilot", ["model-beta", "model-gamma"]);
    expect(first.shownIds("copilot")).toEqual(["model-beta", "model-gamma"]);
    // A Devin session lists families next to the variants it already has.
    report("devin", ["devin-variant-1", "devin-variant-2"]);
    report("devin", ["devin-family"]);
    expect(new Set(first.shownIds("devin"))).toEqual(new Set(["devin-variant-1", "devin-variant-2", "devin-family"]));

    const restarted = await loadModules();
    restarted.discovery.applyPersistedAcpModelCatalogs();
    expect(restarted.shownIds("copilot")).toEqual(["model-beta", "model-gamma"]);
    expect(new Set(restarted.shownIds("devin"))).toEqual(new Set(["devin-variant-1", "devin-variant-2", "devin-family"]));
    expect(agent.started).toBe(0);
  });

  it("asks the provider only when its list is missing or old, and again after a sign-in change", async () => {
    const { discovery, shownIds } = await loadModules();
    const log = waitableLogger();
    agent.sessionNew = modelOption(["model-alpha", "model-beta"]);

    const firstWarm = log.next("ai.acp_model_discovery.ready copilot");
    discovery.warmAcpModelCatalog("copilot", { logger: log.logger });
    await firstWarm;
    expect(shownIds("copilot")).toEqual(["model-alpha", "model-beta"]);
    expect(agent.started).toBe(1);

    // Fresh: no agent. Warms run one at a time, so a probe this had started
    // would finish before the Kimi one below.
    discovery.warmAcpModelCatalog("copilot", { logger: log.logger });
    agent.sessionNew = modelOption(["kimi-model"]);
    const kimiWarm = log.next("ai.acp_model_discovery.ready kimi");
    discovery.warmAcpModelCatalog("kimi", { logger: log.logger });
    await kimiWarm;
    expect(agent.started).toBe(2);

    // Signed in again, maybe as someone else: the old list stays until the new one arrives.
    discovery.markAcpModelCatalogStale("copilot");
    expect(shownIds("copilot")).toEqual(["model-alpha", "model-beta"]);
    agent.sessionNew = modelOption(["model-delta"]);
    const afterSignIn = log.next("ai.acp_model_discovery.ready copilot");
    discovery.warmAcpModelCatalog("copilot", { logger: log.logger });
    await afterSignIn;
    expect(shownIds("copilot")).toEqual(["model-delta"]);
    expect(agent.started).toBe(3);
  });

  it("does not ask again for a provider that answered with no list, until its sign-in changes", async () => {
    const { discovery, shownIds } = await loadModules();
    const log = waitableLogger();
    const curated = shownIds("copilot");
    expect(curated.length, "curated Copilot rows").toBeGreaterThan(0);

    // An Auto-only plan: the session has no model option.
    agent.sessionNew = modelOption([]);
    const emptyAnswer = log.next("ai.acp_model_discovery.empty copilot");
    discovery.warmAcpModelCatalog("copilot", { logger: log.logger });
    await emptyAnswer;
    expect(shownIds("copilot")).toEqual(curated);

    discovery.warmAcpModelCatalog("copilot", { logger: log.logger });
    agent.sessionNew = modelOption(["kimi-model"]);
    const kimiWarm = log.next("ai.acp_model_discovery.ready kimi");
    discovery.warmAcpModelCatalog("kimi", { logger: log.logger });
    await kimiWarm;
    expect(agent.started).toBe(2);

    discovery.markAcpModelCatalogStale("copilot");
    agent.sessionNew = modelOption(["model-alpha"]);
    const afterSignIn = log.next("ai.acp_model_discovery.ready copilot");
    discovery.warmAcpModelCatalog("copilot", { logger: log.logger });
    await afterSignIn;
    expect(shownIds("copilot")).toEqual(["model-alpha"]);
    expect(agent.started).toBe(3);
  });
});
