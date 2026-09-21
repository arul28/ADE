import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildKeySourceLaunch,
  previewHarnessLaunchPlan,
  resolveHarnessPresetPlan,
  type HarnessPresetLaunchDeps,
} from "./harnessPresetLaunch";
import {
  listLaunchableCredentials,
  resolveCredentialForLaunch,
} from "./harnessPresetCredentialCatalog";
import {
  buildCodexPresetConfigToml,
  credentialConfigHome,
  presetConfigHome,
} from "./harnessPresetConfigHomes";
import type { HarnessPreset } from "../../../shared/harnessPresets";
import type { ApiCredentialSummary } from "../../../shared/types/apiCredentials";
import { buildTrackedCliLaunchCommand, buildTrackedCliResumeLaunchCommand } from "../../../shared/cliLaunch";
import type { TerminalResumeMetadata } from "../../../shared/types/sessions";

let adeHome = "";

beforeEach(() => {
  adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-preset-credential-catalog-"));
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

describe("buildKeySourceLaunch", () => {
  it("points Claude at a preset-owned config home with a gateway token", () => {
    const result = buildKeySourceLaunch({
      harness: "claude",
      credential: credential({ baseUrl: "https://gw.example.com/v1" }),
      key: "sk-abc",
      adeHome,
      configHomeId: "hp_1",
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.env.CLAUDE_CONFIG_DIR).toBe(presetConfigHome(adeHome, "hp_1"));
    expect(result.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-abc");
    expect(result.env.ANTHROPIC_BASE_URL).toBe("https://gw.example.com");
    expect(result.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(fs.existsSync(result.env.CLAUDE_CONFIG_DIR!)).toBe(true);
  });

  it("empties ANTHROPIC_API_KEY for an OpenRouter endpoint", () => {
    const result = buildKeySourceLaunch({
      harness: "claude",
      credential: credential({ baseUrl: "https://openrouter.ai/api/v1" }),
      key: "sk-or",
      adeHome,
      configHomeId: "hp_1",
    });
    if (result.status !== "ready") throw new Error("expected ready");
    expect(result.env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    expect(result.env.ANTHROPIC_API_KEY).toBe("");
  });

  it("omits ANTHROPIC_BASE_URL when the key has no endpoint", () => {
    const result = buildKeySourceLaunch({
      harness: "claude",
      credential: credential(),
      key: "sk-direct",
      adeHome,
      configHomeId: "hp_1",
    });
    if (result.status !== "ready") throw new Error("expected ready");
    expect(result.env).not.toHaveProperty("ANTHROPIC_BASE_URL");
  });

  it("writes Codex a config.toml in its own CODEX_HOME and never elsewhere", () => {
    const result = buildKeySourceLaunch({
      harness: "codex",
      credential: credential({ provider: "openai", baseUrl: "https://gw.example.com/v1" }),
      key: "sk-openai",
      adeHome,
      configHomeId: "hp_codex",
    });
    if (result.status !== "ready") throw new Error("expected ready");
    const home = presetConfigHome(adeHome, "hp_codex");
    expect(result.env.CODEX_HOME).toBe(home);
    expect(result.env.ADE_PRESET_OPENAI_API_KEY).toBe("sk-openai");
    expect(result.codexConfigHome).toBe(home);
    const toml = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    expect(toml).toContain('model_provider = "ade"');
    expect(toml).toContain("[model_providers.ade]");
    expect(toml).toContain('base_url = "https://gw.example.com/v1"');
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).toContain('env_key = "ADE_PRESET_OPENAI_API_KEY"');
    expect(toml).not.toContain("sk-openai");
  });

  it("defaults the Codex base_url to OpenAI when the key names no endpoint", () => {
    expect(buildCodexPresetConfigToml(undefined)).toContain('base_url = "https://api.openai.com/v1"');
  });

  it("writes OpenCode's provider block to an ADE-owned config path", () => {
    const result = buildKeySourceLaunch({
      harness: "opencode",
      credential: credential({
        provider: "opencode",
        credentialId: "gw",
        label: "Gateway",
        baseUrl: "https://gw.example.com/v1",
        models: ["gw/model-a", "gw/model-b"],
      }),
      key: "sk-gw",
      adeHome,
      configHomeId: "hp_oc",
    });
    if (result.status !== "ready") throw new Error("expected ready");
    expect(result.env.OPENCODE_CONFIG).toBe(path.join(adeHome, "provider-homes", "preset", "hp_oc", "opencode.json"));
    const config = JSON.parse(fs.readFileSync(result.env.OPENCODE_CONFIG!, "utf8")) as {
      provider: Record<string, { options: { apiKey?: string; baseURL: string }; models: Record<string, unknown> }>;
    };
    expect(config.provider.opencode?.options).toEqual({
      baseURL: "https://gw.example.com/v1",
      apiKey: "sk-gw",
    });
    expect(config.provider.opencode?.models).toEqual({ "gw/model-a": {}, "gw/model-b": {} });
    expect(result.openCodeProvider?.id).toBe("opencode");
    expect(result.openCodeProvider?.block.options).toEqual({
      baseURL: "https://gw.example.com/v1",
      apiKey: "sk-gw",
    });
    expect(Object.keys(result.openCodeProvider?.block.models ?? {})).toEqual(["gw/model-a", "gw/model-b"]);
  });

  it("refuses an OpenCode key with no endpoint", () => {
    const result = buildKeySourceLaunch({
      harness: "opencode",
      credential: credential({ provider: "opencode", models: ["m"] }),
      key: "sk-gw",
      adeHome,
      configHomeId: "hp_oc",
    });
    expect(result.status).toBe("unsupported");
  });

  it("writes Droid custom models into a preset-owned FACTORY_HOME_OVERRIDE", () => {
    const result = buildKeySourceLaunch({
      harness: "droid",
      credential: credential({
        provider: "droid",
        baseUrl: "https://gw.example.com/v1",
        models: ["gw-model"],
      }),
      key: "sk-factory",
      adeHome,
      configHomeId: "hp_droid",
    });
    if (result.status !== "ready") throw new Error("expected ready");
    const home = presetConfigHome(adeHome, "hp_droid");
    expect(result.env.FACTORY_HOME_OVERRIDE).toBe(home);
    const settings = JSON.parse(
      fs.readFileSync(path.join(home, ".factory", "settings.json"), "utf8"),
    ) as { custom_models: Array<{ model: string; base_url: string; api_key: string }> };
    expect(settings.custom_models).toHaveLength(1);
    expect(settings.custom_models[0]).toMatchObject({
      model: "gw-model",
      base_url: "https://gw.example.com/v1",
      api_key: "sk-factory",
    });
  });

  it("applies owner-only ACLs to every credential-bearing home and file on Windows", () => {
    const calls: Array<[string, string[]]> = [];
    const security = {
      platform: "win32" as const,
      currentWindowsUser: "ADEBOX\\arul",
      aclRunner: (command: string, args: string[]) => {
        calls.push([command, args]);
        return { status: 0 };
      },
    };
    const common = { adeHome, key: "sk-secret", ...security };

    buildKeySourceLaunch({ harness: "claude", credential: credential({ provider: "anthropic" }), configHomeId: "hp_claude", ...common });
    buildKeySourceLaunch({ harness: "codex", credential: credential({ provider: "openai" }), configHomeId: "hp_codex_acl", ...common });
    buildKeySourceLaunch({ harness: "opencode", credential: credential({ provider: "opencode", baseUrl: "https://gw.example.com", models: ["m"] }), configHomeId: "hp_opencode_acl", ...common });
    buildKeySourceLaunch({ harness: "droid", credential: credential({ provider: "droid", models: ["m"] }), configHomeId: "hp_droid_acl", ...common });

    const securedPaths = calls.flatMap(([, args]) => args[0] ? [args[0]] : []);
    expect(calls.every(([command]) => command.toLowerCase().endsWith("icacls.exe"))).toBe(true);
    expect(securedPaths).toEqual([
      presetConfigHome(adeHome, "hp_claude"),
      presetConfigHome(adeHome, "hp_codex_acl"),
      presetConfigHome(adeHome, "hp_opencode_acl"),
      presetConfigHome(adeHome, "hp_droid_acl"),
      path.join(presetConfigHome(adeHome, "hp_droid_acl"), ".factory"),
    ]);

    buildKeySourceLaunch({ harness: "claude", credential: credential({ provider: "anthropic" }), configHomeId: "hp_claude", ...common });
    expect(calls).toHaveLength(5);
  });

  it("keeps unrelated keys in an existing Droid settings.json", () => {
    const home = presetConfigHome(adeHome, "hp_droid");
    fs.mkdirSync(path.join(home, ".factory"), { recursive: true });
    fs.writeFileSync(path.join(home, ".factory", "settings.json"), JSON.stringify({ theme: "dark" }));
    buildKeySourceLaunch({
      harness: "droid",
      credential: credential({ provider: "droid", models: ["gw-model"] }),
      key: "sk-factory",
      adeHome,
      configHomeId: "hp_droid",
    });
    const settings = JSON.parse(fs.readFileSync(path.join(home, ".factory", "settings.json"), "utf8")) as Record<string, unknown>;
    expect(settings.theme).toBe("dark");
    expect(settings.custom_models).toBeDefined();
  });

  it("turns a private-home security failure into an unsupported launch", () => {
    const result = buildKeySourceLaunch({
      harness: "claude",
      credential: credential({ provider: "anthropic" }),
      key: "sk-fails-securely",
      adeHome,
      configHomeId: "hp_acl_failure",
      platform: "win32",
      currentWindowsUser: "ADEBOX\\arul",
      aclRunner: () => ({ status: 1, stderr: "access denied" }),
    });
    expect(result).toMatchObject({ status: "unsupported", unsupported: expect.stringMatching(/Unable to secure Windows path/) });

    const subscriptionResult = resolveHarnessPresetPlan(
      preset({ harness: "codex", source: { kind: "subscription", provider: "codex" } }),
      deps({
        platform: "win32",
        currentWindowsUser: "ADEBOX\\arul",
        aclRunner: () => ({ status: 1, stderr: "access denied" }),
        readProxyConnection: () => ({ port: 8123, apiKey: "proxy-key", prefix: "oai" }),
      }),
    );
    expect(subscriptionResult).toMatchObject({ status: "unsupported", unsupported: expect.stringMatching(/Unable to secure Windows path/) });
  });

  it.each([
    ["qwen", { OPENAI_API_KEY: "sk-x", OPENAI_BASE_URL: "https://dash.example/v1" }],
    ["kimi", { MOONSHOT_API_KEY: "sk-x" }],
    ["grok", { XAI_API_KEY: "sk-x" }],
    ["copilot", { GITHUB_TOKEN: "sk-x" }],
  ] as const)("exports %s's own variable", (harness, expected) => {
    const result = buildKeySourceLaunch({
      harness,
      credential: credential({ provider: harness, baseUrl: "https://dash.example/v1" }),
      key: "sk-x",
      adeHome,
      configHomeId: "hp_x",
    });
    if (result.status !== "ready") throw new Error("expected ready");
    for (const [key, value] of Object.entries(expected)) expect(result.env[key]).toBe(value);
  });

  it.each(["cursor", "pi"] as const)("reports %s as unsupported with a reason", (harness) => {
    const result = buildKeySourceLaunch({
      harness,
      credential: credential({ provider: harness }),
      key: "sk-x",
      adeHome,
      configHomeId: "hp_x",
    });
    expect(result.status).toBe("unsupported");
    if (result.status !== "unsupported") return;
    expect(result.unsupported.length).toBeGreaterThan(20);
  });
});

describe("resolveCredentialForLaunch — a key with no preset", () => {
  it("previews credential and subscription launches without writing config homes", () => {
    for (const [provider, summary] of [
      ["codex", credential({ provider: "openai", baseUrl: "https://gw.example/v1" })],
      ["opencode", credential({ provider: "opencode", baseUrl: "https://gw.example/v1", models: ["gw/model"] })],
      ["droid", credential({ provider: "droid", baseUrl: "https://gw.example/v1", models: ["gw/model"] })],
    ] as const) {
      const preview = previewHarnessLaunchPlan(
        { provider, credentialId: "work" },
        deps({ getCredentialSummary: () => summary }),
      );
      expect(preview.status).toBe("ready");
    }

    const subscriptionPreview = previewHarnessLaunchPlan(
      { provider: "codex", presetId: "hp_subscription" },
      deps({
        readPresets: () => [preset({
          id: "hp_subscription",
          harness: "codex",
          source: { kind: "subscription", provider: "codex" },
        })],
        readProxyConnection: () => ({ port: 8123, apiKey: "proxy-key", prefix: "oai" }),
      }),
    );
    expect(subscriptionPreview.status).toBe("ready");
    expect(fs.existsSync(path.join(adeHome, "provider-homes"))).toBe(false);
  });

  it("routes a bare key through the same per-harness table", () => {
    const result = resolveCredentialForLaunch("claude", "work", deps({
      getCredentialSummary: () => credential({ baseUrl: "https://openrouter.ai/api" }),
    }));
    if (result?.status !== "ready") throw new Error("expected ready");
    expect(result.presetId).toBeNull();
    expect(result.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-test-key");
    expect(result.env.ANTHROPIC_API_KEY).toBe("");
    expect(result.env.CLAUDE_CONFIG_DIR).toBe(credentialConfigHome(adeHome, "anthropic", "work"));
  });

  it("returns null when no credential is named", () => {
    expect(resolveCredentialForLaunch("claude", null, deps())).toBeNull();
  });

  it("decodes a custom OpenCode provider credential id for lookup and launch", () => {
    const result = resolveCredentialForLaunch("opencode", "custom:acme:work", deps({
      getCredentialSummary: (provider, credentialId) => provider === "acme" && credentialId === "work"
        ? credential({ provider: "acme", credentialId: "work", baseUrl: "https://acme.example/v1", models: ["acme/model"] })
        : null,
      getCredentialKey: (provider, credentialId) => provider === "acme" && credentialId === "work" ? "sk-acme" : null,
    }));
    if (result?.status !== "ready") throw new Error("expected ready");
    expect(result.env.OPENCODE_CONFIG).toBe(path.join(credentialConfigHome(adeHome, "acme", "work"), "opencode.json"));
    expect(JSON.parse(fs.readFileSync(result.env.OPENCODE_CONFIG!, "utf8"))).toMatchObject({
      provider: { acme: { options: { apiKey: "sk-acme" } } },
    });
  });

  it("lists OpenCode credentials from every configured custom provider", () => {
    const rows = listLaunchableCredentials("opencode", {
      customProviderIds: ["acme"],
      listCredentials: (provider) => provider === "opencode"
        ? [credential({ provider: "opencode", credentialId: "default", models: ["native/model"] })]
        : provider === "acme"
          ? [credential({ provider: "acme", credentialId: "work", models: ["acme/model"] })]
          : [],
    });
    expect(rows.map((row) => `${row.provider}:${row.credentialId}`)).toEqual(["opencode:default", "acme:work"]);
  });

  it("carries key and subscription OpenCode config paths through fresh and resumed launches", () => {
    const keyPlan = resolveCredentialForLaunch("opencode", "custom:acme:work", deps({
      getCredentialSummary: (provider, credentialId) => provider === "acme" && credentialId === "work"
        ? credential({ provider: "acme", credentialId: "work", baseUrl: "https://acme.example/v1", models: ["acme/model"] })
        : null,
      getCredentialKey: () => "sk-acme",
    }));
    const subscriptionPlan = resolveHarnessPresetPlan(
      preset({ harness: "opencode", source: { kind: "subscription", provider: "claude" } }),
      deps({ readProxyConnection: () => ({ port: 8123, apiKey: "proxy-key", prefix: "anth" }) }),
    );
    const plans = [keyPlan, subscriptionPlan];
    for (const plan of plans) {
      if (plan?.status !== "ready") throw new Error("expected ready");
      const presetLaunch = { env: plan.env, passthroughModelId: true as const };
      const fresh = buildTrackedCliLaunchCommand({
        provider: "opencode",
        permissionMode: "default",
        model: plan.model || "acme/model",
        preset: presetLaunch,
      });
      expect(fresh.env?.OPENCODE_CONFIG).toBe(plan.env.OPENCODE_CONFIG);
      const metadata: TerminalResumeMetadata = {
        provider: "opencode",
        targetKind: "session",
        targetId: "ses_1",
        launch: { permissionMode: "default", model: plan.model || "acme/model" },
      };
      const resumed = buildTrackedCliResumeLaunchCommand(metadata, { preset: presetLaunch });
      expect(resumed.env?.OPENCODE_CONFIG).toBe(plan.env.OPENCODE_CONFIG);
    }
  });
});
