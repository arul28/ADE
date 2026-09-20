import fs from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  claudeSubagentEnv,
  previewHarnessLaunchPlan,
  resolveAgentPins,
  resolveHarnessPresetForLaunch,
  resolveHarnessPresetPlan,
  resolveLaunchBrain,
  resolveTrackedCliPreset,
  stripTrailingV1,
  type HarnessPresetLaunchDeps,
} from "./harnessPresetLaunch";
import {
  buildCodexProxyConfigToml,
  credentialConfigHome,
  presetConfigHome,
  pruneOrphanedPresetConfigHomesFromMachine,
  presetsUsingCredential,
  removeCredentialLaunchHome,
  removePrivateTree,
} from "./harnessPresetConfigHomes";
import { readHarnessPresetsFromMachine } from "./harnessPresetSettings";
import { defaultReadProxyConnection } from "./harnessPresetProxyConnection";
import { cliPresetGateReason, isCliPresetGatedHarness } from "../../../shared/harnessPresetCliGate";
import { CLAUDE_BUILTIN_AGENT_TEMPLATES } from "../../../shared/claudeBuiltinAgentPrompts";
import {
  HARNESS_CREDENTIAL_STORE_PROVIDER,
  credentialStoreProviderForHarness,
} from "../../../shared/harnessCredentialProviders";
import { buildTrackedCliLaunchCommand, buildTrackedCliResumeLaunchCommand } from "../../../shared/cliLaunch";
import type { TerminalResumeMetadata } from "../../../shared/types/sessions";
import { allProviderKeySpecs } from "../../../renderer/components/settings/providers/keys/providerKeySpecs";
import type { HarnessPreset, HarnessPresetBody, HarnessPresetSource } from "../../../shared/harnessPresets";
import type { ApiCredentialSummary } from "../../../shared/types/apiCredentials";
import { createAccountSettingsStore } from "../../../../../ade-cli/src/services/account/accountSettingsStore";

let adeHome = "";

beforeEach(() => {
  adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-preset-launch-"));
});

afterEach(() => {
  fs.rmSync(adeHome, { recursive: true, force: true });
});

function credential(overrides: Partial<ApiCredentialSummary> = {}): ApiCredentialSummary {
  return {
    provider: "anthropic",
    credentialId: "work",
    label: "Work key",
    source: "store",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function preset(overrides: Partial<HarnessPreset> = {}): HarnessPreset {
  return {
    id: "hp_1",
    name: "Opus on work",
    harness: "claude",
    source: { kind: "key", provider: "anthropic", credentialId: "work", label: "Work key" },
    model: "claude-opus-4-5",
    subagentModel: "inherit",
    agentOverrides: {},
    permissionMode: "default",
    accentColor: "#7c5ce0",
    logo: { kind: "ade" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Deps that read only from the temp home — no key store, no instance registry. */
function deps(overrides: Partial<HarnessPresetLaunchDeps> = {}): HarnessPresetLaunchDeps {
  return {
    adeHome,
    getCredentialSummary: () => credential(),
    getCredentialKey: () => "sk-test-key",
    resolveInstance: (provider, instanceId) =>
      instanceId
        ? {
          id: String(instanceId),
          provider: provider === "codex" ? "codex" : "claude",
          configHome: path.join(adeHome, "provider-homes", String(provider), String(instanceId)),
        }
        : null,
    readProxyConnection: () => null,
    ...overrides,
  };
}

describe("credentialStoreProviderForHarness", () => {
  // The vendor a harness reads a key from is not the harness's own id, and
  // getting this wrong files the key where nothing looks for it.
  it.each([
    ["claude", "anthropic"],
    ["codex", "openai"],
    ["kimi", "moonshotai"],
    ["grok", "xai"],
    ["opencode", "opencode"],
    ["droid", "droid"],
  ])("files %s keys under %s", (harness, store) => {
    expect(credentialStoreProviderForHarness(harness)).toBe(store);
  });

  it("uses the shared mapping in every renderer provider-key spec", () => {
    for (const spec of allProviderKeySpecs()) {
      expect(spec.credentialProvider).toBe(
        HARNESS_CREDENTIAL_STORE_PROVIDER[spec.provider as HarnessPresetBody],
      );
    }
  });
});

describe("stripTrailingV1", () => {
  it("removes exactly one /v1 suffix and any trailing slashes", () => {
    expect(stripTrailingV1("https://openrouter.ai/api/v1")).toBe("https://openrouter.ai/api");
    expect(stripTrailingV1("https://openrouter.ai/api/v1/")).toBe("https://openrouter.ai/api");
    expect(stripTrailingV1("https://openrouter.ai/api")).toBe("https://openrouter.ai/api");
    // Only the suffix is a version marker — a path segment named v1 stays.
    expect(stripTrailingV1("https://gw.example.com/v1/proxy")).toBe("https://gw.example.com/v1/proxy");
  });
});


describe("resolveHarnessPresetPlan — account source", () => {
  it("points the harness at the account's config home", () => {
    const source: HarnessPresetSource = { kind: "account", provider: "claude", instanceId: "work" };
    const plan = resolveHarnessPresetPlan(preset({ source }), deps());
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    expect(plan.instanceId).toBe("work");
    expect(plan.env.CLAUDE_CONFIG_DIR).toContain(path.join("provider-homes", "claude", "work"));
    expect(plan.passthroughModelId).toBe(true);
  });

  it("uses CODEX_HOME for a codex account", () => {
    const plan = resolveHarnessPresetPlan(
      preset({
        harness: "codex",
        model: "gpt-5.3-codex",
        source: { kind: "account", provider: "codex", instanceId: "personal" },
      }),
      deps(),
    );
    if (plan.status !== "ready") throw new Error("expected ready");
    expect(plan.env.CODEX_HOME).toBeDefined();
    expect(plan.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
  });

  it("refuses a cross-provider account rather than signing in with the wrong one", () => {
    // A Claude account cannot sign Codex in; the proxy exists for that, and
    // this preset did not ask for it.
    const plan = resolveHarnessPresetPlan(
      preset({
        harness: "codex",
        source: { kind: "account", provider: "claude", instanceId: "work" },
      }),
      deps({ resolveInstance: () => ({ id: "work", provider: "claude", configHome: "/tmp/claude" }) }),
    );
    expect(plan.status).toBe("unsupported");
  });

  it("reports a removed account rather than launching on the wrong one", () => {
    const plan = resolveHarnessPresetPlan(
      preset({ source: { kind: "account", provider: "claude", instanceId: "gone" } }),
      deps({ resolveInstance: () => null }),
    );
    expect(plan).toMatchObject({
      status: "unsupported",
      unsupported: "The account this preset signs in with is no longer on this machine.",
    });
  });
});

describe("resolveHarnessPresetPlan — subscription source", () => {
  it("says so when the proxy has no login for that provider", () => {
    const plan = resolveHarnessPresetPlan(
      preset({ source: { kind: "subscription", provider: "claude" } }),
      deps(),
    );
    expect(plan).toMatchObject({
      status: "unsupported",
      unsupported: "Sign-in through ADE's proxy is not available yet.",
    });
  });

  it("reports a stopped proxy distinctly from a missing login", () => {
    const plan = resolveHarnessPresetPlan(
      preset({ source: { kind: "subscription", provider: "claude" } }),
      deps({ readProxyConnection: () => ({ reason: "proxy-stopped" }) }),
    );
    expect(plan).toMatchObject({
      status: "unsupported",
      unsupported: "Sign-in through ADE's proxy is stopped; start the proxy and try again.",
    });
  });

  it("builds Claude's gateway env from the proxy connection", () => {
    const plan = resolveHarnessPresetPlan(
      preset({ model: "opus", source: { kind: "subscription", provider: "claude" } }),
      deps({ readProxyConnection: () => ({ port: 8123, apiKey: "proxy-key", prefix: "anth" }) }),
    );
    if (plan.status !== "ready") throw new Error("expected ready");
    expect(plan.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8123");
    expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBe("proxy-key");
    // The proxy routes by a prefixed id, so the launch model is the proxy's
    // spelling, not the preset's raw one.
    expect(plan.model).toBe("anth/opus");
    expect(plan.env.ANTHROPIC_MODEL).toBe("anth/opus");
  });

  it("writes Codex's proxy provider into a preset-owned CODEX_HOME", () => {
    const plan = resolveHarnessPresetPlan(
      preset({
        harness: "codex",
        model: "gpt-5.3-codex",
        source: { kind: "subscription", provider: "codex" },
      }),
      deps({ readProxyConnection: () => ({ port: 8123, apiKey: "proxy-key", prefix: "oai" }) }),
    );
    if (plan.status !== "ready") throw new Error("expected ready");
    const home = presetConfigHome(adeHome, "hp_1");
    expect(plan.env.CODEX_HOME).toBe(home);
    expect(plan.codexConfigHome).toBe(home);
    const toml = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    expect(toml).toContain('model_provider = "ade-proxy"');
    expect(toml).toContain("[model_providers.ade-proxy]");
    expect(toml).toContain("http://127.0.0.1:8123/v1");
  });

  it("gives OpenCode a proxy provider block", () => {
    const plan = resolveHarnessPresetPlan(
      preset({
        harness: "opencode",
        model: "sonnet",
        source: { kind: "subscription", provider: "claude" },
      }),
      deps({ readProxyConnection: () => ({ port: 8123, apiKey: "proxy-key", prefix: "anth" }) }),
    );
    if (plan.status !== "ready") throw new Error("expected ready");
    expect(plan.openCodeProvider?.id).toBe("ade-proxy");
    expect(plan.openCodeProvider?.block.options.baseURL).toBe("http://127.0.0.1:8123/v1");
    expect(Object.keys(plan.openCodeProvider?.block.models ?? {})).toEqual(["anth/sonnet"]);
    expect(plan.env.OPENCODE_CONFIG).toBe(path.join(adeHome, "provider-homes", "preset", "hp_1", "opencode.json"));
    expect(JSON.parse(fs.readFileSync(plan.env.OPENCODE_CONFIG!, "utf8"))).toMatchObject({
      provider: { "ade-proxy": { options: { apiKey: "proxy-key" } } },
    });
  });

  it("refuses a harness the proxy cannot drive", () => {
    const plan = resolveHarnessPresetPlan(
      preset({ harness: "droid", source: { kind: "subscription", provider: "claude" } }),
      deps({ readProxyConnection: () => ({ port: 8123, apiKey: "k", prefix: "anth" }) }),
    );
    expect(plan.status).toBe("unsupported");
  });

  it("adds model_provider to the fragment proxyEnv supplies", () => {
    const toml = buildCodexProxyConfigToml('[model_providers.ade-proxy]\nbase_url = "x"');
    expect(toml.split("\n").filter((line) => line === 'model_provider = "ade-proxy"')).toHaveLength(1);
    expect(toml).toContain("[model_providers.ade-proxy]");
  });
});

describe("defaultReadProxyConnection", () => {
  function writeProxyState(state: Record<string, unknown>): void {
    fs.mkdirSync(path.join(adeHome, "proxy"), { recursive: true });
    fs.writeFileSync(path.join(adeHome, "proxy", "state.json"), JSON.stringify({ version: "test", ...state }));
  }

  function writeProxyConfig(key = "k"): void {
    fs.mkdirSync(path.join(adeHome, "proxy"), { recursive: true });
    fs.writeFileSync(
      path.join(adeHome, "proxy", "config.yaml"),
      `api-keys:\n  - ${key}\nauth-dir: ${path.join(adeHome, "proxy", "auth")}\n`,
    );
  }

  function writeAuthFile(name: string, file: Record<string, unknown>): void {
    fs.mkdirSync(path.join(adeHome, "proxy", "auth"), { recursive: true });
    fs.writeFileSync(path.join(adeHome, "proxy", "auth", name), JSON.stringify(file));
  }

  it("returns null when the proxy has never run", () => {
    expect(defaultReadProxyConnection(adeHome)("claude")).toEqual({ reason: "proxy-stopped" });
  });

  it("returns null when no enabled login exists for the provider", () => {
    writeProxyState({ port: 9000, pid: process.pid, startedAt: Date.now(), healthyAt: Date.now() });
    writeProxyConfig();
    writeAuthFile("a.json", { id: "a", provider: "codex", prefix: "oai" });
    writeAuthFile("b.json", { id: "b", provider: "claude", prefix: "anth", disabled: true });
    expect(defaultReadProxyConnection(adeHome)("claude")).toBeNull();
  });

  it("does not follow an auth-dir outside the ADE-owned proxy tree", () => {
    const outsideAuthDir = path.join(adeHome, "outside-auth");
    fs.mkdirSync(outsideAuthDir, { recursive: true });
    fs.writeFileSync(
      path.join(outsideAuthDir, "claude.json"),
      JSON.stringify({ id: "outside", provider: "claude", prefix: "stolen" }),
    );
    writeProxyState({ port: 9000, pid: process.pid, startedAt: Date.now(), healthyAt: Date.now() });
    fs.mkdirSync(path.join(adeHome, "proxy"), { recursive: true });
    fs.writeFileSync(
      path.join(adeHome, "proxy", "config.yaml"),
      `api-keys:\n  - k\nauth-dir: ${outsideAuthDir}\n`,
    );

    expect(defaultReadProxyConnection(adeHome)("claude")).toBeNull();
  });

  it("reads the port, key and prefix off disk without touching the network", () => {
    writeProxyState({ port: 9000, pid: process.pid, startedAt: Date.now(), healthyAt: Date.now() });
    writeProxyConfig();
    writeAuthFile("a.json", { id: "a", provider: "claude", prefix: "anth" });
    expect(defaultReadProxyConnection(adeHome)("claude")).toEqual({
      port: 9000,
      apiKey: "k",
      prefix: "anth",
    });
  });

  it("skips an unreadable auth file rather than hiding the others", () => {
    writeProxyState({ port: 9000, pid: process.pid, startedAt: Date.now(), healthyAt: Date.now() });
    writeProxyConfig();
    fs.mkdirSync(path.join(adeHome, "proxy", "auth"), { recursive: true });
    fs.writeFileSync(path.join(adeHome, "proxy", "auth", "broken.json"), "{not json");
    writeAuthFile("good.json", { id: "a", provider: "claude", prefix: "anth" });
    const result = defaultReadProxyConnection(adeHome)("claude");
    expect(result && "prefix" in result ? result.prefix : null).toBe("anth");
  });

  it.each([
    [{ port: 9000, pid: null }, "explicit stop"],
    [{ port: 9000, pid: Number.MAX_SAFE_INTEGER, startedAt: Date.now(), healthyAt: Date.now() }, "stale state"],
  ])("reports %s as stopped when the supervisor is not live", (state, _label) => {
    writeProxyState(state);
    writeProxyConfig();
    expect(defaultReadProxyConnection(adeHome)("claude")).toEqual({ reason: "proxy-stopped" });
  });

  it("rejects a health stamp from the future rather than trusting a skewed clock", () => {
    // `age >= 0` is the guard: a state.json written by a machine whose clock ran
    // ahead would otherwise look permanently fresh and keep handing provider
    // credentials to a proxy that may be long gone.
    writeProxyState({
      port: 9000,
      pid: process.pid,
      startedAt: Date.now(),
      healthyAt: Date.now() + 10 * 60_000,
    });
    writeProxyConfig();
    writeAuthFile("a.json", { id: "a", provider: "claude", prefix: "anth" });

    expect(defaultReadProxyConnection(adeHome)("claude")).toEqual({ reason: "proxy-stopped" });
  });

  it("rejects a live PID with stale health unless an injected probe succeeds", () => {
    writeProxyState({
      port: 9000,
      pid: process.pid,
      startedAt: Date.now() - 120_000,
      healthyAt: Date.now() - 61_000,
    });
    writeProxyConfig();
    writeAuthFile("a.json", { id: "a", provider: "claude", prefix: "anth" });

    expect(defaultReadProxyConnection(adeHome)("claude")).toEqual({ reason: "proxy-stopped" });
    expect(defaultReadProxyConnection(adeHome, { healthCheck: () => true })("claude")).toEqual({
      port: 9000,
      apiKey: "k",
      prefix: "anth",
    });
  });

  it("uses the bounded loopback probe and refreshes a stale health stamp", async () => {
    const healthServer = spawn(process.execPath, [
      "-e",
      "const http=require('node:http'); const server=http.createServer((_request,response)=>{response.writeHead(200);response.end('ok');}); server.listen(0,'127.0.0.1',()=>process.stdout.write(String(server.address().port)));",
    ], { stdio: ["ignore", "pipe", "ignore"] });
    const port = await new Promise<number>((resolve, reject) => {
      healthServer.once("error", reject);
      healthServer.stdout?.once("data", (chunk) => {
        const parsed = Number(String(chunk).trim());
        if (Number.isInteger(parsed) && parsed > 0) resolve(parsed);
        else reject(new Error(`invalid health server port: ${String(chunk)}`));
      });
    });
    try {
      const staleHealthyAt = Date.now() - 61_000;
      writeProxyState({
        port,
        pid: process.pid,
        startedAt: staleHealthyAt,
        healthyAt: staleHealthyAt,
      });
      writeProxyConfig();
      writeAuthFile("a.json", { id: "a", provider: "claude", prefix: "anth" });

      expect(defaultReadProxyConnection(adeHome)("claude")).toEqual({
        port,
        apiKey: "k",
        prefix: "anth",
      });
      const refreshed = JSON.parse(fs.readFileSync(path.join(adeHome, "proxy", "state.json"), "utf8")) as {
        healthyAt?: number;
      };
      expect(refreshed.healthyAt).toBeGreaterThan(staleHealthyAt);
    } finally {
      healthServer.kill("SIGTERM");
      await new Promise<void>((resolve) => healthServer.once("exit", () => resolve()));
    }
  });
});

describe("Claude subagents and built-in pins", () => {
  it("forces the subagent model so a per-agent setting cannot override it", () => {
    expect(claudeSubagentEnv("haiku")).toEqual({
      CLAUDE_CODE_SUBAGENT_MODEL: "haiku",
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
    });
    expect(claudeSubagentEnv(undefined)).toEqual({});
  });

  it("leaves the subagent env empty when the preset inherits", () => {
    const plan = resolveHarnessPresetPlan(preset({ subagentModel: "inherit" }), deps());
    if (plan.status !== "ready") throw new Error("expected ready");
    expect(plan.env).not.toHaveProperty("CLAUDE_CODE_SUBAGENT_MODEL");
    expect(plan.subagentModel).toBeUndefined();
  });

  it("resolves a `follows` pin to the subagent model", () => {
    expect(resolveAgentPins(preset({
      subagentModel: "haiku",
      agentOverrides: { explore: "follows", plan: "sonnet" },
    }))).toEqual({ explore: "haiku", plan: "sonnet" });
  });

  it("resolves a `follows` pin to the main model when subagents inherit", () => {
    expect(resolveAgentPins(preset({
      subagentModel: "inherit",
      agentOverrides: { generalPurpose: "follows" },
    }))).toEqual({ generalPurpose: "claude-opus-4-5" });
  });

  it("emits SDK agent entries carrying ADE's prompt and the built-in's tool denials", () => {
    const plan = resolveHarnessPresetPlan(
      preset({ subagentModel: "haiku", agentOverrides: { explore: "follows" } }),
      deps(),
    );
    if (plan.status !== "ready") throw new Error("expected ready");
    expect(plan.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("haiku");
    const explore = plan.claudeAgents?.Explore;
    expect(explore?.model).toBe("haiku");
    expect(explore?.prompt).toBe(CLAUDE_BUILTIN_AGENT_TEMPLATES.explore.prompt);
    // Pinning must not quietly turn a read-only built-in into a writing one.
    expect(explore?.disallowedTools).toContain("Write");
    expect(explore?.disallowedTools).toContain("Edit");
  });

  it("emits no agents when the preset pinned none", () => {
    const plan = resolveHarnessPresetPlan(preset(), deps());
    if (plan.status !== "ready") throw new Error("expected ready");
    expect(plan.claudeAgents).toBeUndefined();
  });

  it("notes that a non-Claude harness cannot honour a subagent model", () => {
    const plan = resolveHarnessPresetPlan(
      preset({
        harness: "codex",
        subagentModel: "gpt-5.3-mini",
        source: { kind: "account", provider: "codex", instanceId: "work" },
      }),
      deps(),
    );
    if (plan.status !== "ready") throw new Error("expected ready");
    expect(plan.subagentModel).toBeUndefined();
    expect(plan.notes?.join(" ")).toContain("subagents");
  });
});

describe("resolveHarnessPresetForLaunch", () => {
  it("returns null when no preset is named", () => {
    expect(resolveHarnessPresetForLaunch(null, deps())).toBeNull();
    expect(resolveHarnessPresetForLaunch("  ", deps())).toBeNull();
  });

  it("reports a deleted preset rather than throwing", () => {
    fs.mkdirSync(presetConfigHome(adeHome, "orphan"), { recursive: true });
    const plan = resolveHarnessPresetForLaunch("hp_gone", deps({ readPresets: () => [] }));
    expect(plan).toMatchObject({
      status: "unsupported",
      unsupported: "This harness preset no longer exists on this account.",
    });
    expect(fs.existsSync(presetConfigHome(adeHome, "orphan"))).toBe(false);
  });

  it.each([".", "..", "../outside", "..\\outside"]) ("rejects unsafe preset id %s before building a path", (unsafeId) => {
    expect(() => presetConfigHome(adeHome, unsafeId)).toThrow(/Unsafe provider-home identifier/);
    expect(resolveHarnessPresetForLaunch(unsafeId, deps())).toMatchObject({
      status: "unsupported",
      unsupported: expect.stringMatching(/unsafe/),
    });
  });

  it("does not prune a live direct-credential home with orphaned presets", () => {
    const direct = resolveLaunchBrain({ provider: "claude", credentialId: "work" }, deps());
    if (direct?.status !== "ready") throw new Error("expected a direct credential launch");
    const credentialHome = credentialConfigHome(adeHome, "anthropic", "work");
    expect(fs.existsSync(credentialHome)).toBe(true);
    const legacyCredentialHome = path.join(adeHome, "provider-homes", "preset", "credential-anthropic-legacy");
    fs.mkdirSync(legacyCredentialHome, { recursive: true });
    fs.mkdirSync(presetConfigHome(adeHome, "orphan"), { recursive: true });

    resolveHarnessPresetForLaunch("hp_gone", deps({ readPresets: () => [] }));

    expect(fs.existsSync(credentialHome)).toBe(true);
    expect(fs.existsSync(legacyCredentialHome)).toBe(true);
    expect(fs.existsSync(presetConfigHome(adeHome, "orphan"))).toBe(false);
    removeCredentialLaunchHome("anthropic", "legacy", adeHome);
  });

  it("removes preset homes that still contain a revoked credential", () => {
    const dependent = preset({
      id: "hp_credential",
      source: { kind: "key", provider: "anthropic", credentialId: "work", label: "Work key" },
    });
    fs.mkdirSync(presetConfigHome(adeHome, dependent.id), { recursive: true });
    fs.writeFileSync(path.join(presetConfigHome(adeHome, dependent.id), "secret.json"), "sk-work");

    removeCredentialLaunchHome("anthropic", "work", adeHome, {
      readPresets: () => [dependent],
    });

    expect(fs.existsSync(presetConfigHome(adeHome, dependent.id))).toBe(false);
  });

  it("bounds locked Windows cleanup and logs without blocking the caller", () => {
    let attempts = 0;
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    removePrivateTree("C:\\ADE\\provider-home", {
      platform: "win32",
      rmSync: () => {
        attempts += 1;
        throw Object.assign(new Error("locked"), { code: "EPERM" });
      },
      scheduleRetry: (retry) => retry(),
      logger: { warn: (message, meta) => warnings.push({ message, meta }) },
    });

    expect(attempts).toBe(5);
    expect(warnings).toEqual([{
      message: "chat.harness_private_home_cleanup_failed",
      meta: expect.objectContaining({ code: "EPERM", attempts: 5 }),
    }]);
  });

  it("passes the model id through untouched", () => {
    const plan = resolveHarnessPresetForLaunch("hp_1", deps({
      readPresets: () => [preset({ model: "anthropic/claude-opus-4.5" })],
    }));
    if (plan?.status !== "ready") throw new Error("expected ready");
    // An endpoint's own spelling, which ADE's alias table would rewrite.
    expect(plan.model).toBe("anthropic/claude-opus-4.5");
    expect(plan.passthroughModelId).toBe(true);
  });

  it("carries the preset's effort and permission mode", () => {
    const plan = resolveHarnessPresetForLaunch("hp_1", deps({
      readPresets: () => [preset({ reasoningEffort: "high", permissionMode: "plan" })],
    }));
    if (plan?.status !== "ready") throw new Error("expected ready");
    expect(plan.reasoningEffort).toBe("high");
    expect(plan.permissionMode).toBe("plan");
  });

  it("reports a key that is no longer in the store", () => {
    const plan = resolveHarnessPresetForLaunch("hp_1", deps({
      readPresets: () => [preset()],
      getCredentialSummary: () => null,
    }));
    expect(plan).toMatchObject({ status: "unsupported" });
  });
});

describe("readHarnessPresetsFromMachine", () => {
  // The settings cache joins scope and key with a NUL, which neither can
  // contain. Built rather than written literally so the fixture cannot drift
  // into a space and pass against a reader that also used one.
  const cacheKey = ["all", "harnessPresets"].join(String.fromCharCode(0));

  it("reads the account-scoped list out of the settings cache", () => {
    fs.writeFileSync(
      path.join(adeHome, "account-settings.json"),
      JSON.stringify({ version: 1, settings: { [cacheKey]: { value: [preset()] } } }),
    );
    const presets = readHarnessPresetsFromMachine(adeHome);
    expect(presets).toHaveLength(1);
    expect(presets?.[0]?.id).toBe("hp_1");
  });

  it("ignores a row under another scope", () => {
    const otherScope = ["project", "harnessPresets"].join(String.fromCharCode(0));
    fs.writeFileSync(
      path.join(adeHome, "account-settings.json"),
      JSON.stringify({ version: 1, settings: { [otherScope]: { value: [preset()] } } }),
    );
    expect(readHarnessPresetsFromMachine(adeHome)).toEqual([]);
  });

  // Regression (A1): a cache that cannot be read must answer "unknown", never
  // "no presets" — the caller prunes every private home the list omits, so an
  // empty answer from a cold or corrupt cache deletes live presets' API keys.
  it("answers null rather than an empty list on a cold or corrupt cache", () => {
    expect(readHarnessPresetsFromMachine(adeHome)).toBeNull();
    fs.writeFileSync(path.join(adeHome, "account-settings.json"), "{not json");
    expect(readHarnessPresetsFromMachine(adeHome)).toBeNull();
    fs.writeFileSync(path.join(adeHome, "account-settings.json"), JSON.stringify({ version: 1 }));
    expect(readHarnessPresetsFromMachine(adeHome)).toBeNull();
  });

  it("prunes an orphan after a confirmed preset-list write", () => {
    const orphan = presetConfigHome(adeHome, "deleted_preset");
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(
      path.join(adeHome, "account-settings.json"),
      JSON.stringify({ version: 1, settings: { [cacheKey]: { value: [] } } }),
    );

    pruneOrphanedPresetConfigHomesFromMachine(adeHome);

    expect(fs.existsSync(orphan)).toBe(false);
  });

  // Seam test: the reader and the writer are different modules in different
  // packages, and a hand-written fixture only ever proves the reader agrees
  // with itself. Writing through the real settings store is what proves a
  // preset saved in Settings is the preset a launch finds — the field name the
  // cache serializes under is the store's to choose, not this file's to guess.
  it("reads a list written by the real account settings store", () => {
    const store = createAccountSettingsStore({
      adeDir: adeHome,
      relay: null,
      getAccountUserId: () => "user_seam",
    });
    store.set("all", "harnessPresets", [preset()]);

    const presets = readHarnessPresetsFromMachine(adeHome);
    expect(presets).toHaveLength(1);
    expect(presets?.[0]?.id).toBe("hp_1");
  });

  // The same seam, one level up: an unreadable list is not merely an empty
  // picker, it silently downgrades `--preset` to the provider default.
  it("resolves a preset saved through the real store instead of reporting it gone", () => {
    const store = createAccountSettingsStore({
      adeDir: adeHome,
      relay: null,
      getAccountUserId: () => "user_seam",
    });
    store.set("all", "harnessPresets", [preset()]);

    const result = resolveHarnessPresetForLaunch("hp_1", deps());
    expect(result?.status).toBe("ready");
  });
});


describe("resolveLaunchBrain", () => {
  it("prefers the preset when both ids arrive", () => {
    const result = resolveLaunchBrain(
      { provider: "claude", presetId: "hp_1", credentialId: "work" },
      deps({ readPresets: () => [preset({ model: "pinned" })] }),
    );
    if (result?.status !== "ready") throw new Error("expected ready");
    expect(result.presetId).toBe("hp_1");
    expect(result.model).toBe("pinned");
  });

  it("costs nothing when a launch names neither", () => {
    expect(resolveLaunchBrain({ provider: "claude" }, deps())).toBeNull();
  });

  it("ignores a credential on a provider that is not a harness", () => {
    expect(resolveLaunchBrain({ provider: "shell", credentialId: "work" }, deps())).toBeNull();
  });

  it("returns one tracked-CLI preset handshake including the exact model override", () => {
    expect(resolveTrackedCliPreset(
      "claude",
      { presetId: "hp_1", credentialId: null },
      deps({ readPresets: () => [preset({ model: "gateway/opus" })] }),
    )).toEqual({
      preset: {
        env: expect.objectContaining({ CLAUDE_CONFIG_DIR: expect.any(String) }),
        passthroughModelId: true,
      },
      model: "gateway/opus",
      gateReason: null,
    });
  });
});

describe("previewHarnessLaunchPlan", () => {
  it("projects direct credential env with secrets redacted", () => {
    const preview = previewHarnessLaunchPlan(
      { provider: "claude", credentialId: "work" },
      deps({ getCredentialSummary: () => credential({ baseUrl: "https://gw.example.com/v1" }) }),
    );

    expect(preview).toMatchObject({
      status: "ready",
      model: null,
      env: {
        CLAUDE_CONFIG_DIR: credentialConfigHome(adeHome, "anthropic", "work"),
        ANTHROPIC_AUTH_TOKEN: "<redacted>",
        ANTHROPIC_BASE_URL: "https://gw.example.com",
      },
    });
    expect(JSON.stringify(preview)).not.toContain("sk-test-key");
  });

  it("does not resolve or preview a gated CLI brain", () => {
    const preview = previewHarnessLaunchPlan(
      { provider: "grok", presetId: "hp_grok", mode: "cli" },
      deps({
        readPresets: () => {
          throw new Error("the CLI gate should run before resolving the preset");
        },
      }),
    );

    expect(preview).toMatchObject({
      status: "gated",
      presetId: "hp_grok",
      model: null,
      env: {},
      reason: expect.stringMatching(/own sign-in/),
    });
  });

  it("projects Claude base-url and non-inherit subagent env", () => {
    const preview = previewHarnessLaunchPlan(
      { provider: "claude", presetId: "hp_claude" },
      deps({
        readPresets: () => [preset({
          id: "hp_claude",
          model: "anthropic/claude-opus-4.5",
          subagentModel: "haiku",
        })],
        getCredentialSummary: () => credential({ baseUrl: "https://openrouter.ai/api/v1" }),
      }),
    );

    expect(preview).toMatchObject({
      status: "ready",
      model: "anthropic/claude-opus-4.5",
      env: {
        ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "<redacted>",
        CLAUDE_CODE_SUBAGENT_MODEL: "haiku",
        CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
      },
    });
  });

  it("projects the proxy-prefixed model for subscription presets", () => {
    const preview = previewHarnessLaunchPlan(
      { provider: "claude", presetId: "hp_subscription" },
      deps({
        readPresets: () => [preset({
          id: "hp_subscription",
          model: "opus",
          source: { kind: "subscription", provider: "claude" },
        })],
        readProxyConnection: () => ({ port: 8123, apiKey: "proxy-key", prefix: "anth" }),
      }),
    );

    expect(preview).toMatchObject({
      status: "ready",
      model: "anth/opus",
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8123",
        ANTHROPIC_AUTH_TOKEN: "<redacted>",
        ANTHROPIC_MODEL: "anth/opus",
      },
    });
    expect(JSON.stringify(preview)).not.toContain("proxy-key");
  });

  it.each(["cursor", "pi"] as const)("reports %s credential presets as unsupported", (provider) => {
    const preview = previewHarnessLaunchPlan(
      { provider, presetId: `hp_${provider}` },
      deps({
        readPresets: () => [preset({
          id: `hp_${provider}`,
          harness: provider,
          source: { kind: "key", provider, credentialId: "work", label: "Work key" },
        })],
        getCredentialSummary: () => credential({ provider }),
      }),
    );

    expect(preview).toMatchObject({ status: "unsupported", model: null, env: {} });
  });
});

describe("CLI preset gate", () => {
  it.each(["grok", "cursor", "copilot", "kimi"] as const)("gates %s with a reason", (harness) => {
    expect(isCliPresetGatedHarness(harness)).toBe(true);
    expect(cliPresetGateReason(harness)).toMatch(/own sign-in/);
  });

  it.each(["claude", "codex", "opencode", "droid", "pi", "qwen"] as const satisfies readonly HarnessPresetBody[])(
    "lets %s take a preset",
    (harness) => {
      expect(isCliPresetGatedHarness(harness)).toBe(false);
      expect(cliPresetGateReason(harness)).toBeNull();
    },
  );
});
