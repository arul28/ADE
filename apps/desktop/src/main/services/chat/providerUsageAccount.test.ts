import { describe, expect, it } from "vitest";
import type { ProviderInstance } from "../../../shared/types/providerInstances";
import {
  buildInstanceUsageAccount,
  claudeUsageAccountKind,
  codexAuthModeFromAccountRead,
  codexUsageAccountKind,
  createProviderInstanceUsageLookup,
  createTurnUsageAccountResolvers,
} from "./providerUsageAccount";

const claudeBase = {
  apiKeySource: null,
  modelProvider: null,
  keyedPreset: false,
  redirectedEndpoint: false,
  instanceSignedIn: false,
};

function instance(overrides: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    id: "claude-work",
    provider: "claude",
    label: "Work",
    configHome: "/tmp/claude-work",
    isDefault: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    account: { email: "me@example.com", plan: "max" },
    signedIn: true,
    ...overrides,
  };
}

describe("Claude usage account kind", () => {
  it("reads an API key from the init apiKeySource", () => {
    for (const apiKeySource of ["ANTHROPIC_API_KEY", "apiKeyHelper", "/login managed key"]) {
      expect(claudeUsageAccountKind({ ...claudeBase, apiKeySource, instanceSignedIn: true }).kind).toBe("api_key");
    }
  });

  it("reads a claude.ai login from apiKeySource none on the first-party route", () => {
    expect(claudeUsageAccountKind({ ...claudeBase, apiKeySource: "none", modelProvider: "firstParty" }).kind)
      .toBe("subscription");
  });

  it("does not claim a plan for a cloud route, a keyed preset, or a redirected endpoint", () => {
    expect(claudeUsageAccountKind({ ...claudeBase, apiKeySource: "none", modelProvider: "bedrock" }).kind).toBe("unknown");
    expect(claudeUsageAccountKind({ ...claudeBase, apiKeySource: "none", keyedPreset: true }).kind).toBe("unknown");
    expect(claudeUsageAccountKind({ ...claudeBase, apiKeySource: "none", redirectedEndpoint: true }).kind).toBe("unknown");
  });

  it("falls back to the signed-in instance only before init reports a source", () => {
    expect(claudeUsageAccountKind({ ...claudeBase, instanceSignedIn: true }).kind).toBe("subscription");
    expect(claudeUsageAccountKind(claudeBase).kind).toBe("unknown");
    expect(claudeUsageAccountKind({ ...claudeBase, apiKeySource: "oauth", instanceSignedIn: true }).kind).toBe("unknown");
  });
});

describe("Codex usage account kind", () => {
  it("follows the account/updated auth mode", () => {
    expect(codexUsageAccountKind({ authMode: "apikey", keyedPreset: false, instanceSignedIn: true }).kind).toBe("api_key");
    expect(codexUsageAccountKind({ authMode: "chatgpt", keyedPreset: false, instanceSignedIn: false }).kind).toBe("subscription");
    expect(codexUsageAccountKind({ authMode: "chatgptAuthTokens", keyedPreset: false, instanceSignedIn: false }).kind).toBe("subscription");
    expect(codexUsageAccountKind({ authMode: "amazonBedrock", keyedPreset: false, instanceSignedIn: true }).kind).toBe("unknown");
  });

  it("marks a Bedrock auth mode as a cloud route, not the plan", () => {
    for (const authMode of ["amazonBedrock", "bedrockApiKey", "bedrockAccessKeys"]) {
      expect(codexUsageAccountKind({ authMode, keyedPreset: false, instanceSignedIn: true }))
        .toEqual({ kind: "unknown", routedAway: "cloud" });
    }
  });

  it("reads the auth mode and plan from account/read", () => {
    // The shape `codex app-server` 0.153 answers `account/read` with.
    expect(codexAuthModeFromAccountRead({
      account: { type: "chatgpt", email: "me@example.com", planType: "plus" },
      requiresOpenaiAuth: true,
    })).toEqual({ authMode: "chatgpt", planType: "plus" });
    expect(codexAuthModeFromAccountRead({ account: { type: "apiKey" }, requiresOpenaiAuth: true }))
      .toEqual({ authMode: "apikey", planType: null });
    expect(codexAuthModeFromAccountRead({ account: { type: "amazonBedrock", usesCodexManagedCredentials: false } }))
      .toEqual({ authMode: "amazonBedrock", planType: null });
    expect(codexAuthModeFromAccountRead({ account: null, requiresOpenaiAuth: true })).toBeNull();
    expect(codexAuthModeFromAccountRead({})).toBeNull();
    expect(codexAuthModeFromAccountRead({ account: { type: "somethingNew" } })).toBeNull();
  });

  it("falls back to the instance login when no auth mode arrived", () => {
    expect(codexUsageAccountKind({ authMode: null, keyedPreset: false, instanceSignedIn: true }).kind).toBe("subscription");
    expect(codexUsageAccountKind({ authMode: null, keyedPreset: true, instanceSignedIn: true }).kind).toBe("unknown");
    expect(codexUsageAccountKind({ authMode: null, keyedPreset: false, instanceSignedIn: false }).kind).toBe("unknown");
  });
});

describe("instance usage account", () => {
  it("attaches the login's email and plan only to a subscription turn", () => {
    expect(buildInstanceUsageAccount({ provider: "claude", kind: "subscription", instance: instance() })).toEqual({
      provider: "claude",
      kind: "subscription",
      instanceId: "claude-work",
      email: "me@example.com",
      plan: "max",
    });
    expect(buildInstanceUsageAccount({ provider: "claude", kind: "api_key", instance: instance() })).toEqual({
      provider: "claude",
      kind: "api_key",
      instanceId: "claude-work",
    });
    expect(buildInstanceUsageAccount({ provider: "codex", kind: "unknown", instance: null, routedAway: "preset" }))
      .toEqual({ provider: "codex", kind: "unknown", routedAway: "preset" });
  });

  it("caches the instance lookup so a done event does not read the registry", () => {
    let calls = 0;
    let now = 0;
    const lookup = createProviderInstanceUsageLookup((_provider, instanceId) => {
      calls += 1;
      return instance({ id: instanceId ?? "claude" });
    }, () => now);
    expect(lookup("claude", "claude-work")?.id).toBe("claude-work");
    expect(lookup("claude", " claude-work ")?.id).toBe("claude-work");
    expect(calls).toBe(1);
    expect(lookup("claude", undefined)?.id).toBe("claude");
    expect(calls).toBe(2);
    now = 61_000;
    lookup("claude", "claude-work");
    expect(calls).toBe(3);
  });

  it("treats a throwing store as no instance", () => {
    const lookup = createProviderInstanceUsageLookup(() => {
      throw new Error("registry unreadable");
    });
    expect(lookup("codex", null)).toBeNull();
  });
});

describe("turn usage account resolvers", () => {
  type Session = { instanceId?: string; presetInstanceId?: string | null; hasPreset?: boolean; isolatedStore?: string };
  const resolvers = (env: NodeJS.ProcessEnv = {}) => {
    const lookups: Array<[string, string | null]> = [];
    const accounts = createTurnUsageAccountResolvers<Session>({
      resolveInstance: (provider, instanceId) => {
        lookups.push([provider, instanceId]);
        return instance({ id: instanceId ?? `${provider}-default`, provider });
      },
      launchPlan: (session) => session.hasPreset ? { instanceId: session.presetInstanceId ?? null } : null,
      sessionInstanceId: (session) => session.instanceId,
      openCodeLocalEndpoint: (providerID) => providerID === "lmstudio" ? "http://me:pw@127.0.0.1:1234/v1" : null,
      openCodeDataDirs: (session) => session.isolatedStore ? [session.isolatedStore] : undefined,
      env: () => env,
    });
    return { accounts, lookups };
  };

  it("names the Claude login that paid, and no login on a keyed preset or a redirected endpoint", () => {
    const { accounts, lookups } = resolvers();
    expect(accounts.claude({ instanceId: "claude-work" }, { apiKeySource: "none", modelProvider: "firstParty" })).toEqual({
      provider: "claude",
      kind: "subscription",
      instanceId: "claude-work",
      email: "me@example.com",
      plan: "max",
    });
    expect(lookups).toEqual([["claude", "claude-work"]]);
    // A preset naming an account wins over the session's own instance.
    expect(accounts.claude({ instanceId: "claude-work", hasPreset: true, presetInstanceId: "claude-team" }, {
      apiKeySource: "none",
      modelProvider: null,
    }).instanceId).toBe("claude-team");
    // A keyed preset or a redirected endpoint is marked, so the subscription
    // burn rate leaves the turn out instead of counting it against the plan.
    // `upstream` is never the marker: it names only a model vendor.
    const preset = accounts.claude({ hasPreset: true }, { apiKeySource: "none", modelProvider: null });
    expect(preset).toMatchObject({ kind: "unknown", routedAway: "preset" });
    expect(preset).not.toHaveProperty("upstream");
    expect(resolvers({ ANTHROPIC_BASE_URL: "https://gw.example" }).accounts
      .claude({}, { apiKeySource: "none", modelProvider: null })).toMatchObject({ kind: "unknown", routedAway: "endpoint" });
    expect(resolvers({ ANTHROPIC_AUTH_TOKEN: "token" }).accounts
      .claude({}, { apiKeySource: "none", modelProvider: null }).routedAway).toBe("endpoint");
    const bedrock = accounts.claude({}, { apiKeySource: "none", modelProvider: "bedrock" });
    expect(bedrock).toMatchObject({ kind: "unknown", routedAway: "cloud" });
    expect(bedrock).not.toHaveProperty("upstream");
    // A plan turn on the first-party route is never marked.
    expect(accounts.claude({}, { apiKeySource: "none", modelProvider: "firstParty" })).not.toHaveProperty("routedAway");
  });

  it("marks only a turn the plan did not pay for", () => {
    // A ChatGPT login pays even under a keyed preset: never marked.
    expect(codexUsageAccountKind({ authMode: "chatgpt", keyedPreset: true, instanceSignedIn: true }))
      .toEqual({ kind: "subscription", routedAway: null });
    // The cloud route wins over a preset and an endpoint.
    expect(claudeUsageAccountKind({
      ...claudeBase,
      apiKeySource: "none",
      modelProvider: "vertex",
      keyedPreset: true,
      redirectedEndpoint: true,
    })).toEqual({ kind: "unknown", routedAway: "cloud" });
    expect(claudeUsageAccountKind({ ...claudeBase, apiKeySource: "ANTHROPIC_API_KEY", keyedPreset: true }))
      .toEqual({ kind: "api_key", routedAway: "preset" });
    expect(codexUsageAccountKind({ authMode: "apikey", keyedPreset: true, instanceSignedIn: false }))
      .toEqual({ kind: "api_key", routedAway: "preset" });
    expect(claudeUsageAccountKind({ ...claudeBase, redirectedEndpoint: true }))
      .toEqual({ kind: "unknown", routedAway: "endpoint" });
    expect(claudeUsageAccountKind({ ...claudeBase, modelProvider: "firstParty" }))
      .toEqual({ kind: "unknown", routedAway: null });
    expect(claudeUsageAccountKind({ ...claudeBase, apiKeySource: "none", modelProvider: "firstParty" }))
      .toEqual({ kind: "subscription", routedAway: null });
  });

  it("names the Codex account from the reported auth mode", () => {
    const { accounts } = resolvers();
    expect(accounts.codex({}, "apikey")).toEqual({ provider: "codex", kind: "api_key", instanceId: "codex-default" });
    expect(accounts.codex({}, "chatgpt")).toMatchObject({ kind: "subscription", email: "me@example.com" });
    expect(accounts.codex({ hasPreset: true }, null)).toMatchObject({ kind: "unknown", routedAway: "preset" });
    // The preset ran on the ChatGPT login, so the plan paid: no marker.
    expect(accounts.codex({ hasPreset: true }, "chatgpt")).not.toHaveProperty("routedAway");
  });

  it("uses the runtime's plan only when the login record has none", () => {
    const accounts = createTurnUsageAccountResolvers<Record<string, never>>({
      resolveInstance: (provider) => instance({ id: `${provider}-default`, provider, account: { email: "me@example.com" } }),
      launchPlan: () => null,
      sessionInstanceId: () => null,
      openCodeLocalEndpoint: () => null,
      openCodeDataDirs: () => undefined,
      env: () => ({}),
    });
    expect(accounts.codex({}, "chatgpt", "pro")).toMatchObject({ kind: "subscription", plan: "pro" });
    // An API-key turn names no plan, whatever the runtime said.
    expect(accounts.codex({}, "apikey", "pro")).not.toHaveProperty("plan");
    const { accounts: withPlan } = resolvers();
    expect(withPlan.codex({}, "chatgpt", "plus")).toMatchObject({ plan: "max" });
  });

  it("names an OpenCode local server by its endpoint's origin", () => {
    const { accounts } = resolvers();
    expect(accounts.openCode({}, "lmstudio")).toEqual({
      provider: "opencode",
      kind: "local",
      upstream: "lmstudio",
      endpoint: "http://127.0.0.1:1234",
    });
    expect(accounts.openCode({ isolatedStore: "/nonexistent/opencode" }, "anthropic")).toEqual({
      provider: "opencode",
      kind: "unknown",
      upstream: "anthropic",
    });
  });
});
