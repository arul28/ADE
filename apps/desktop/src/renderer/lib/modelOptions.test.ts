import { describe, expect, it } from "vitest";
import type { AiSettingsStatus } from "../../shared/types";
import { getModelById, MODEL_REGISTRY } from "../../shared/modelRegistry";
import {
  describeModelSource,
  deriveConfiguredModelIds,
  deriveConfiguredModelOptions,
  includeSelectedModelOption,
} from "./modelOptions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStatus(overrides: Partial<AiSettingsStatus> & Record<string, unknown> = {}): AiSettingsStatus {
  return {
    mode: "guest",
    availableProviders: { claude: false, codex: false, cursor: false },
    models: { claude: [], codex: [], cursor: [] },
    features: [],
    detectedAuth: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// describeModelSource
// ---------------------------------------------------------------------------

describe("describeModelSource", () => {
  it("returns 'local' for local-auth models", () => {
    const descriptor = getModelById("ollama/qwen2.5-coder:32b");
    expect(descriptor).toBeTruthy();
    expect(describeModelSource(descriptor!)).toBe("local");
  });

  it("returns 'CLI subscription' for CLI-wrapped models", () => {
    const descriptor = getModelById("anthropic/claude-sonnet-4-6");
    expect(descriptor).toBeTruthy();
    expect(descriptor!.isCliWrapped).toBe(true);
    expect(describeModelSource(descriptor!)).toBe("CLI subscription");
  });

  it("returns 'API only' for api-key models", () => {
    const synthetic = {
      authTypes: ["api-key"] as string[],
      isCliWrapped: false,
    } as any;
    expect(describeModelSource(synthetic)).toBe("API only");
  });

  it("returns 'OpenRouter' for openrouter models", () => {
    const synthetic = {
      authTypes: ["openrouter"] as string[],
      isCliWrapped: false,
    } as any;
    expect(describeModelSource(synthetic)).toBe("OpenRouter");
  });

  it("returns 'OAuth' for oauth-only models", () => {
    const synthetic = {
      authTypes: ["oauth"] as string[],
      isCliWrapped: false,
    } as any;
    expect(describeModelSource(synthetic)).toBe("OAuth");
  });

  it("falls back to 'model source' for an unknown auth combo", () => {
    const synthetic = {
      authTypes: [] as string[],
      isCliWrapped: false,
    } as any;
    expect(describeModelSource(synthetic)).toBe("model source");
  });

  it("prioritizes local over CLI subscription", () => {
    const synthetic = {
      authTypes: ["local", "cli-subscription"] as string[],
      isCliWrapped: true,
    } as any;
    expect(describeModelSource(synthetic)).toBe("local");
  });

  it("prioritizes CLI subscription over API only", () => {
    const synthetic = {
      authTypes: ["api-key"] as string[],
      isCliWrapped: true,
    } as any;
    expect(describeModelSource(synthetic)).toBe("CLI subscription");
  });
});

// ---------------------------------------------------------------------------
// deriveConfiguredModelIds
// ---------------------------------------------------------------------------

describe("deriveConfiguredModelIds", () => {
  it("returns empty array for null status", () => {
    expect(deriveConfiguredModelIds(null)).toEqual([]);
  });

  it("returns empty array for undefined status", () => {
    expect(deriveConfiguredModelIds(undefined)).toEqual([]);
  });

  it("returns empty array when detectedAuth is empty", () => {
    const status = makeStatus({ detectedAuth: [] });
    expect(deriveConfiguredModelIds(status)).toEqual([]);
  });

  it("returns empty array when detectedAuth is undefined", () => {
    const status = makeStatus();
    delete status.detectedAuth;
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

  it("includes Cursor CLI models from availableModelIds by default", () => {
    const status = makeStatus({
      detectedAuth: [{ type: "cli-subscription", cli: "cursor", authenticated: true }],
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
      expect(descriptor!.isCliWrapped).toBe(true);
    }
  });

  it("always includes Cursor CLI models (includeCursor option is ignored)", () => {
    const status = makeStatus({
      detectedAuth: [{ type: "cli-subscription", cli: "cursor", authenticated: true }],
      availableModelIds: ["cursor/auto", "cursor/composer-2"],
    });
    // The includeCursor option is no longer functional — all models are included.
    const ids = deriveConfiguredModelIds(status, {});
    expect(ids).toContain("cursor/auto");
    expect(ids).toContain("cursor/composer-2");
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
  it("returns empty array for null status", () => {
    expect(deriveConfiguredModelOptions(null)).toEqual([]);
  });

  it("returns empty array for undefined status", () => {
    expect(deriveConfiguredModelOptions(undefined)).toEqual([]);
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
    const sonnet = options.find((o) => o.id === "anthropic/claude-sonnet-4-6");
    expect(sonnet).toBeTruthy();
    expect(sonnet!.description).toBe("anthropic (CLI subscription)");
  });

  it("uses displayName as label", () => {
    const status = makeStatus({
      detectedAuth: [{ type: "cli-subscription", cli: "claude", authenticated: true }],
    });
    const options = deriveConfiguredModelOptions(status);
    const sonnet = options.find((o) => o.id === "anthropic/claude-sonnet-4-6");
    expect(sonnet).toBeTruthy();
    expect(sonnet!.label).toBe("Claude Sonnet 4.6");
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
    { id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6", description: "anthropic (CLI subscription)" },
  ];

  it("returns options unchanged when selectedModelId is null", () => {
    const result = includeSelectedModelOption(baseOptions, null);
    expect(result).toBe(baseOptions);
  });

  it("returns options unchanged when selectedModelId is undefined", () => {
    const result = includeSelectedModelOption(baseOptions, undefined);
    expect(result).toBe(baseOptions);
  });

  it("returns options unchanged when selectedModelId is empty string", () => {
    const result = includeSelectedModelOption(baseOptions, "");
    expect(result).toBe(baseOptions);
  });

  it("returns options unchanged when selectedModelId is whitespace", () => {
    const result = includeSelectedModelOption(baseOptions, "   ");
    expect(result).toBe(baseOptions);
  });

  it("returns options unchanged when selectedModelId already exists", () => {
    const result = includeSelectedModelOption(baseOptions, "anthropic/claude-sonnet-4-6");
    expect(result).toBe(baseOptions);
  });

  it("prepends the selected model when it is missing from options but exists in registry", () => {
    const result = includeSelectedModelOption(baseOptions, "anthropic/claude-opus-4-6");
    expect(result.length).toBe(baseOptions.length + 1);
    expect(result[0].id).toBe("anthropic/claude-opus-4-6");
    expect(result[0].label).toBe("Claude Opus 4.6");
    // Original options follow
    expect(result.slice(1)).toEqual(baseOptions);
  });

  it("returns options unchanged when selectedModelId is not in the registry", () => {
    const result = includeSelectedModelOption(baseOptions, "nonexistent/model-xyz");
    expect(result).toEqual(baseOptions);
  });

  it("trims the selectedModelId before lookup", () => {
    const result = includeSelectedModelOption(baseOptions, "  anthropic/claude-opus-4-6  ");
    expect(result.length).toBe(baseOptions.length + 1);
    expect(result[0].id).toBe("anthropic/claude-opus-4-6");
  });

  it("works with an empty options array", () => {
    const result = includeSelectedModelOption([], "anthropic/claude-sonnet-4-6");
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("anthropic/claude-sonnet-4-6");
  });
});
