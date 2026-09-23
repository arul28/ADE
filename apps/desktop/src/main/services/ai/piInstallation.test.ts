import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  piModelDescriptorsFromInventory,
  probePiProfileInventory,
  readPiProfileInventory,
  resolvePiInstallation,
} from "./piInstallation";

const pool = vi.hoisted(() => ({ availableModels: [] as unknown[] }));
vi.mock("../chat/piSdkPool", () => ({
  acquirePiSdkConnection: vi.fn(async () => ({
    generation: 1,
    pooled: {
      ready: { availableModels: pool.availableModels },
      requestAuth: async () => [],
      waitForExit: async () => undefined,
    },
  })),
  releasePiSdkConnection: vi.fn(),
}));

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A Pi profile with the given models.json providers and, optionally, auth.json entries. */
function profile(
  providers: Record<string, unknown>,
  auth?: Record<string, unknown>,
): ReturnType<typeof resolvePiInstallation> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pi-install-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers }));
  if (auth) fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify(auth));
  return resolvePiInstallation({ ...process.env, PI_CODING_AGENT_DIR: agentDir });
}

function providerById(installation: ReturnType<typeof resolvePiInstallation>, id: string) {
  return readPiProfileInventory(installation).providers.find((entry) => entry.id === id);
}

describe("Pi provider classification", () => {
  // LM Studio ships `apiKey: "lmstudio"` in models.json — a placeholder its
  // OpenAI-compatible endpoint requires and ignores. Reading that as a
  // credential classified a server the user runs as an API provider: ADE
  // offered to sign in to localhost and reported it connected on the strength
  // of a config file rather than a reachable server.
  it("treats a loopback provider as local even when it carries a placeholder key", () => {
    const installation = profile({
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        models: [{ id: "gemma-4" }],
      },
    });

    const lmstudio = providerById(installation, "lmstudio");
    expect(lmstudio?.authType).toBe("local");
    expect(lmstudio?.authMethods).toEqual(["local"]);
    expect(lmstudio?.baseUrl).toBe("http://127.0.0.1:1234/v1");
  });

  it("classifies every loopback spelling as local", () => {
    for (const baseUrl of [
      "http://localhost:1234/v1",
      "http://127.0.0.1:11434",
      "http://0.0.0.0:8080/v1",
      "http://[::1]:1234/v1",
    ]) {
      const installation = profile({ server: { baseUrl, apiKey: "placeholder" } });
      expect(providerById(installation, "server")?.authType).toBe("local");
    }
  });

  // A remote provider reached through a custom base URL is still remote, and
  // the user does have to authenticate to it.
  it("keeps a remote provider on a custom base URL an api-key provider", () => {
    const installation = profile({
      proxied: { baseUrl: "https://gateway.example.com/v1", apiKey: "sk-real-key" },
    });

    const proxied = providerById(installation, "proxied");
    expect(proxied?.authType).toBe("api-key");
    expect(proxied?.baseUrl).toBeUndefined();
  });

  it("leaves a provider with neither a key nor a base URL unclassified", () => {
    const installation = profile({ bare: { models: [{ id: "m" }] } });
    expect(providerById(installation, "bare")?.authType).toBeNull();
  });
});

/**
 * Settings shows what it showed before usage telemetry, for every input: the
 * per-turn account classification is richer, and must never leak in here.
 * Each expectation is HEAD's output for the same files and environment.
 */
describe("Pi provider classification in Settings stays as it was", () => {
  it("reads an untyped { key } auth entry as oauth", () => {
    const installation = profile({ custom: { models: [{ id: "m" }] } }, { custom: { key: "x" }, stored: { key: "y" } });
    const inventory = readPiProfileInventory(installation);
    const custom = inventory.providers.find((entry) => entry.id === "custom");
    expect(custom).toMatchObject({ authType: "oauth", authMethods: ["oauth"] });
    expect(inventory.providers.find((entry) => entry.id === "stored")).toMatchObject({
      authType: "oauth",
      authMethods: ["oauth"],
      authSource: "stored",
    });
    expect(piModelDescriptorsFromInventory(inventory)[0]?.authTypes).toEqual(["oauth"]);
  });

  it("ignores a provider key in the environment", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-env");
    vi.stubEnv("CEREBRAS_API_KEY", "sk-env");
    const installation = profile({
      anthropic: { models: [{ id: "claude" }] },
      cerebras: { baseUrl: "https://api.cerebras.ai/v1", models: [{ id: "llama" }] },
    });
    // No base URL and an env-only key: unclassified.
    expect(providerById(installation, "anthropic")).toMatchObject({ authType: null, authMethods: [] });
    // A non-loopback base URL and an env-only key: an endpoint the user configured.
    const cerebras = providerById(installation, "cerebras");
    expect(cerebras).toMatchObject({ authType: "local", authMethods: ["local"] });
    expect(cerebras?.baseUrl).toBeUndefined();
  });

  it("knows only its five loopback spellings", () => {
    for (const baseUrl of ["http://127.0.0.2:11434", "http://studio.localhost:1234/v1", "http://[::]:8080"]) {
      const withKey = providerById(profile({ server: { baseUrl, apiKey: "placeholder" } }), "server");
      expect(withKey, baseUrl).toMatchObject({ authType: "api-key", authMethods: ["api-key"] });
      expect(withKey?.baseUrl, baseUrl).toBeUndefined();
      const withoutKey = providerById(profile({ server: { baseUrl } }), "server");
      expect(withoutKey, baseUrl).toMatchObject({ authType: "local", authMethods: ["local"] });
      expect(withoutKey?.baseUrl, baseUrl).toBeUndefined();
    }
    const trimmed = providerById(profile({ server: { baseUrl: "  http://LOCALHOST:1234/v1  ", apiKey: "k" } }), "server");
    expect(trimmed).toMatchObject({ authType: "local", baseUrl: "http://LOCALHOST:1234/v1" });
  });

  it("lets a stored entry win over a loopback URL and keeps an unknown one unknown", () => {
    const installation = profile(
      {
        gateway: { baseUrl: "http://127.0.0.1:4000", apiKey: "k" },
        odd: { baseUrl: "http://127.0.0.1:4000" },
      },
      { gateway: { type: "api_key", key: "k" }, odd: { note: "x" } },
    );
    expect(providerById(installation, "gateway")).toMatchObject({
      authType: "api-key",
      authMethods: ["api-key"],
      baseUrl: "http://127.0.0.1:4000",
    });
    expect(providerById(installation, "odd")).toMatchObject({ authType: "unknown", authMethods: [] });
  });
});

describe("Pi effort choices", () => {
  const base = {
    installed: true,
    sdkAvailable: true,
    cliAvailable: true,
    cliPath: null,
    packageRoot: "/pi",
    version: "0.84.0",
    agentDir: "/agent",
    settingsPath: "/agent/settings.json",
    authPath: "/agent/auth.json",
    modelsPath: "/agent/models.json",
    modelsStorePath: "/agent/models-store.json",
    blocker: null,
    providers: [],
    stale: false,
    authFileDetected: false,
    modelsFileDetected: false,
    settingsFileDetected: false,
  };

  // The picker offers exactly the thinking levels Pi reports for each model.
  it("offers the levels Pi reported for each model as its reasoning tiers", () => {
    const thinker = "pi/default/openai/gpt-5";
    const plain = "pi/default/local/llama";
    const [gpt, llama] = piModelDescriptorsFromInventory({
      ...base,
      availableModelIds: [thinker, plain],
      modelThinkingLevels: {
        [thinker]: ["off", "minimal", "low", "medium", "high", "xhigh"],
        [plain]: ["off"],
      },
    });
    expect(gpt?.reasoningTiers).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
    expect(gpt?.capabilities.reasoning).toBe(true);
    // "off" alone is not a choice, and the model is not a reasoning model.
    expect(llama?.reasoningTiers).toBeUndefined();
    expect(llama?.capabilities.reasoning).toBe(false);
  });

  it("carries the levels Pi's runtime reports from the inventory probe to the picker", async () => {
    pool.availableModels = [
      { provider: "openai", id: "gpt-5", reasoning: true, thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"] },
      { provider: "local", id: "llama", reasoning: false, thinkingLevels: ["off"] },
    ];
    const installation = {
      ...profile({}),
      sdkAvailable: true,
      packageRoot: "/pi",
      packageEntry: "/pi/dist/index.js",
    };
    const inventory = await probePiProfileInventory(installation);
    expect(inventory.modelThinkingLevels).toEqual({
      "pi/default/openai/gpt-5": ["off", "minimal", "low", "medium", "high", "xhigh"],
      "pi/default/local/llama": ["off"],
    });
    const byId = new Map(piModelDescriptorsFromInventory(inventory).map((model) => [model.id, model]));
    expect(byId.get("pi/default/openai/gpt-5")?.reasoningTiers).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
    expect(byId.get("pi/default/local/llama")?.reasoningTiers).toBeUndefined();
  });

  it("offers no tiers when only Pi's profile files were read", () => {
    const [model] = piModelDescriptorsFromInventory({ ...base, availableModelIds: ["pi/default/openai/gpt-5"] });
    expect(model?.reasoningTiers).toBeUndefined();
  });
});
