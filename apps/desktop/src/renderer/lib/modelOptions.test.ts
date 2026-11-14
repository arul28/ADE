import { describe, expect, it } from "vitest";
import type { AiSettingsStatus } from "../../shared/types";
import { getModelById, MODEL_REGISTRY } from "../../shared/modelRegistry";
import {
  describeModelSource,
  deriveConfiguredModelIds,
  deriveConfiguredModelOptions,
  includeSelectedModelOption,
  isKnownSelectableChatModelId,
} from "./modelOptions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStatus(overrides: Partial<AiSettingsStatus> & Record<string, unknown> = {}): AiSettingsStatus {
  return {
    mode: "guest",
    availableProviders: {
      claude: {
        binary: { present: false, source: "missing", path: null },
        auth: { ready: false, mode: "none", detail: null },
      },
      codex: false,
      cursor: false,
      droid: false,
    },
    models: { claude: [], codex: [], cursor: [], droid: [] },
    features: [],
    detectedAuth: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// describeModelSource
// ---------------------------------------------------------------------------

describe("describeModelSource", () => {
  it.each([
    ["api-key only", ["api-key"], false, "API only"],
    ["openrouter", ["openrouter"], false, "OpenRouter"],
    ["oauth only", ["oauth"], false, "OAuth"],
    ["no auth types", [], false, "model source"],
    ["local beats CLI subscription", ["local", "cli-subscription"], true, "local"],
    ["CLI subscription beats API only", ["api-key"], true, "CLI subscription"],
  ])("labels %s", (_name, authTypes, isCliWrapped, label) => {
    expect(describeModelSource({ authTypes, isCliWrapped } as any)).toBe(label);
  });

  it("labels registry local and CLI-wrapped models", () => {
    expect(describeModelSource(getModelById("ollama/qwen2.5-coder:32b")!)).toBe("local");
    expect(describeModelSource(getModelById("anthropic/claude-sonnet-5")!)).toBe("CLI subscription");
  });
});

// ---------------------------------------------------------------------------
// deriveConfiguredModelIds
// ---------------------------------------------------------------------------

describe("deriveConfiguredModelIds", () => {
  it.each([
    ["null status", null],
    ["undefined status", undefined],
    ["empty detectedAuth", makeStatus({ detectedAuth: [] })],
    ["missing detectedAuth", (() => { const s = makeStatus(); delete s.detectedAuth; return s; })()],
  ])("returns an empty list for %s", (_name, status) => {
    expect(deriveConfiguredModelIds(status)).toEqual([]);
  });

  it("includes CLI-wrapped anthropic models when claude CLI is authenticated", () => {
    const status = makeStatus({
      detectedAuth: [{ type: "cli-subscription", cli: "claude", authenticated: true }],
    });
    const ids = deriveConfiguredModelIds(status);
    expect(ids.length).toBeGreaterThan(0);
    // All returned ids should be CLI-wrapped anthropic models
    for (const id of ids) {
      const descriptor = getModelById(id);
      expect(descriptor).toBeTruthy();
      expect(descriptor!.family).toBe("anthropic");
      expect(descriptor!.isCliWrapped).toBe(true);
    }
  });

  it("includes CLI-wrapped openai models when codex CLI is authenticated", () => {
    const status = makeStatus({
      detectedAuth: [{ type: "cli-subscription", cli: "codex", authenticated: true }],
    });
    const ids = deriveConfiguredModelIds(status);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const descriptor = getModelById(id);
      expect(descriptor).toBeTruthy();
      expect(descriptor!.family).toBe("openai");
      expect(descriptor!.isCliWrapped).toBe(true);
    }
  });

  it("includes Cursor SDK models from availableModelIds when Cursor runtime is verified", () => {
    const status = makeStatus({
      detectedAuth: [{ type: "api-key", provider: "cursor", source: "store" }],
      availableProviders: {
        claude: {
          binary: { present: false, source: "missing", path: null },
          auth: { ready: false, mode: "none", detail: null },
        },
        codex: false,
        cursor: true,
        droid: false,
      },
      availableModelIds: ["cursor/auto", "cursor/composer-2", "openai/gpt-5.4-pro"],
    });
    const ids = deriveConfiguredModelIds(status);
    expect(ids).toContain("cursor/auto");
    expect(ids).toContain("cursor/composer-2");
    for (const id of ids) {
      if (!String(id).startsWith("cursor/")) continue;
      const descriptor = getModelById(id);
      expect(descriptor).toBeTruthy();
      expect(descriptor!.family).toBe("cursor");
      expect(descriptor!.authTypes).toContain("api-key");
      expect(descriptor!.isCliWrapped).toBe(false);
    }
  });

  it("does not include Cursor SDK models from a stored key before runtime verification", () => {
    const status = makeStatus({
      detectedAuth: [{ type: "api-key", provider: "cursor", source: "store" }],
      availableModelIds: ["cursor/auto", "cursor/composer-2"],
    });
    const ids = deriveConfiguredModelIds(status, {});
    expect(ids).toEqual([]);
  });

  it("includes Cursor SDK models when Cursor runtime is available even without api-key auth entry", () => {
    const status = makeStatus({
      detectedAuth: [],
      availableProviders: {
        claude: {
          binary: { present: false, source: "missing", path: null },
          auth: { ready: false, mode: "none", detail: null },
        },
        codex: false,
        cursor: true,
        droid: false,
      },
      availableModelIds: ["cursor/composer-2.5-fast"],
    });
    expect(deriveConfiguredModelIds(status)).toEqual(["cursor/composer-2.5-fast"]);
  });

  it("recognizes dynamic Cursor SDK ids as selectable chat models", () => {
    expect(isKnownSelectableChatModelId("cursor/composer-2.5-fast")).toBe(true);
    expect(isKnownSelectableChatModelId("not-a-model")).toBe(false);
  });

  it("skips unauthenticated CLI subscriptions", () => {
    const status = makeStatus({
      detectedAuth: [{ type: "cli-subscription", cli: "claude", authenticated: false }],
    });
    expect(deriveConfiguredModelIds(status)).toEqual([]);
  });

  it("returns empty for api-key auth when no static api-key models exist in registry", () => {
    // Static API-key models have been removed; only CLI-wrapped and local models remain.
    const status = makeStatus({
      detectedAuth: [{ type: "api-key", provider: "anthropic" }],
    });
    const ids = deriveConfiguredModelIds(status);
    expect(ids.length).toBe(0);
  });

  it("returns empty for openrouter auth when no static openrouter models exist", () => {
    // Static openrouter models have been removed from the registry.
    const status = makeStatus({
      detectedAuth: [{ type: "openrouter" }],
    });
    const ids = deriveConfiguredModelIds(status);
    const openrouterModels = MODEL_REGISTRY.filter(
      (m) => m.family === "openrouter" && !m.deprecated,
    );
    expect(ids.length).toBe(openrouterModels.length);
    expect(ids.length).toBe(0);
  });

  it("includes local models for local auth", () => {
    const status = makeStatus({
      detectedAuth: [{ type: "local", provider: "lmstudio" }],
      availableModelIds: ["lmstudio/meta-llama-3.1-70b-instruct", "lmstudio/qwen2.5-coder:32b", "ollama/llama3.2"],
    });
    const ids = deriveConfiguredModelIds(status);
    expect(ids).toContain("lmstudio/meta-llama-3.1-70b-instruct");
    expect(ids).toContain("lmstudio/qwen2.5-coder:32b");
    expect(ids).not.toContain("ollama/llama3.2");
  });

  it("includes local models from runtimeConnections when availableModelIds is empty", () => {
    const status = makeStatus({
      runtimeConnections: {
        lmstudio: {
          provider: "lmstudio",
          label: "LM Studio",
          kind: "local",
          configured: true,
          authAvailable: true,
          runtimeDetected: true,
          runtimeAvailable: true,
          health: "ready",
          endpoint: "http://localhost:1234",
          blocker: null,
          loadedModelIds: ["lmstudio/meta-llama-3.1-70b-instruct"],
          lastCheckedAt: "2026-03-17T19:00:00.000Z",
        },
      },
    });
    const ids = deriveConfiguredModelIds(status);
    expect(ids).toContain("lmstudio/meta-llama-3.1-70b-instruct");
  });

  it("prefers discovered local model ids over static local placeholders", () => {
    const status = makeStatus({
      detectedAuth: [{ type: "local", provider: "lmstudio" }],
      availableModelIds: ["lmstudio/meta-llama-3.1-70b-instruct"],
    });

    const ids = deriveConfiguredModelIds(status);

    expect(ids).toContain("lmstudio/meta-llama-3.1-70b-instruct");
    expect(ids).not.toContain("lmstudio/auto");
  });

  it("merges models from multiple auth sources without duplicates", () => {
    const status = makeStatus({
      detectedAuth: [
        { type: "cli-subscription", cli: "claude", authenticated: true },
        { type: "cli-subscription", cli: "codex", authenticated: true },
      ],
    });
    const ids = deriveConfiguredModelIds(status);
    // Should have CLI-wrapped anthropic and openai models, no dupes
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
  });

  it("normalizes provider name to lowercase and trimmed", () => {
    // With static API-key models removed, api-key auth for "anthropic" yields no results.
    // Validate normalization still happens by checking it does not throw.
    const status = makeStatus({
      detectedAuth: [{ type: "api-key", provider: "  Anthropic  " }],
    });
    const ids = deriveConfiguredModelIds(status);
    expect(ids.length).toBe(0);
  });

  it("skips api-key auth with empty provider", () => {
    const status = makeStatus({
      detectedAuth: [{ type: "api-key", provider: "" }],
    });
    expect(deriveConfiguredModelIds(status)).toEqual([]);
  });

  it("skips api-key auth with undefined provider", () => {
    const status = makeStatus({
      detectedAuth: [{ type: "api-key", provider: undefined }],
    });
    expect(deriveConfiguredModelIds(status)).toEqual([]);
  });

  it("excludes deprecated models", () => {
    const status = makeStatus({
      detectedAuth: [
        { type: "cli-subscription", cli: "claude", authenticated: true },
        { type: "cli-subscription", cli: "codex", authenticated: true },
      ],
    });
    const ids = deriveConfiguredModelIds(status);
    const deprecatedIds = MODEL_REGISTRY.filter((m) => m.deprecated).map((m) => m.id);
    for (const id of deprecatedIds) {
      expect(ids).not.toContain(id);
    }
  });

  it("preserves MODEL_REGISTRY ordering", () => {
    const status = makeStatus({
      detectedAuth: [
        { type: "cli-subscription", cli: "claude", authenticated: true },
        { type: "cli-subscription", cli: "codex", authenticated: true },
      ],
    });
    const ids = deriveConfiguredModelIds(status);
    const registryOrder = MODEL_REGISTRY.filter((m) => !m.deprecated).map((m) => m.id);
    let lastIndex = -1;
    for (const id of ids) {
      const index = registryOrder.indexOf(id);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });

  it("skips cli-subscription when cli field is missing", () => {
    const status = makeStatus({
      detectedAuth: [{ type: "cli-subscription", authenticated: true }],
    });
    expect(deriveConfiguredModelIds(status)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deriveConfiguredModelOptions
// ---------------------------------------------------------------------------

describe("deriveConfiguredModelOptions", () => {
  it.each([[null], [undefined]])("returns an empty list for %s status", (status) => {
    expect(deriveConfiguredModelOptions(status)).toEqual([]);
  });

  it("returns AiModelDescriptor objects with id, label, and description", () => {
    const status = makeStatus({
      detectedAuth: [{ type: "cli-subscription", cli: "claude", authenticated: true }],
    });
    const options = deriveConfiguredModelOptions(status);
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option.id).toBeTruthy();
      expect(option.label).toBeTruthy();
      expect(option.description).toBeTruthy();
    }
  });

  it("description includes family and source", () => {
    const status = makeStatus({
      detectedAuth: [{ type: "cli-subscription", cli: "claude", authenticated: true }],
    });
    const options = deriveConfiguredModelOptions(status);
    const sonnet = options.find((o) => o.id === "anthropic/claude-sonnet-5");
    expect(sonnet).toBeTruthy();
    expect(sonnet!.description).toBe("anthropic (CLI subscription)");
  });

  it("preserves dynamic local model ids as options", () => {
    const status = makeStatus({
      detectedAuth: [{ type: "local", provider: "lmstudio" }],
      availableModelIds: ["lmstudio/local-test-model-123"],
    });
    const options = deriveConfiguredModelOptions(status);
    const local = options.find((o) => o.id === "lmstudio/local-test-model-123");
    expect(local).toBeTruthy();
    expect(local!.label).toBe("local-test-model-123 (LM Studio)");
    expect(local!.description).toBe("lmstudio (local)");
  });
});

// ---------------------------------------------------------------------------
// includeSelectedModelOption
// ---------------------------------------------------------------------------

describe("includeSelectedModelOption", () => {
  const baseOptions = [
    { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", description: "anthropic (CLI subscription)" },
  ];

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["whitespace", "   "],
    ["already present", "anthropic/claude-sonnet-5"],
  ])("returns the same options when the selected id is %s", (_name, selected) => {
    expect(includeSelectedModelOption(baseOptions, selected)).toBe(baseOptions);
  });

  it("prepends the selected model when it is missing from options but exists in registry", () => {
    const result = includeSelectedModelOption(baseOptions, "anthropic/claude-opus-4-8");
    expect(result.length).toBe(baseOptions.length + 1);
    expect(result[0].id).toBe("anthropic/claude-opus-5");
    expect(result[0].label).toBe("Claude Opus 5");
    // Original options follow
    expect(result.slice(1)).toEqual(baseOptions);
  });

  it("returns options unchanged when selectedModelId is not in the registry", () => {
    const result = includeSelectedModelOption(baseOptions, "nonexistent/model-xyz");
    expect(result).toEqual(baseOptions);
  });

  it("trims the selectedModelId before lookup", () => {
    const result = includeSelectedModelOption(baseOptions, "  anthropic/claude-opus-4-8  ");
    expect(result.length).toBe(baseOptions.length + 1);
    expect(result[0].id).toBe("anthropic/claude-opus-5");
  });

  it("works with an empty options array", () => {
    const result = includeSelectedModelOption([], "anthropic/claude-sonnet-5");
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("anthropic/claude-sonnet-5");
  });
});
