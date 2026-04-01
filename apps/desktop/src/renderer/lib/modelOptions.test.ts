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

function makeStatus(overrides: Partial<AiSettingsStatus> = {}): AiSettingsStatus {
  return {
    mode: "guest",
    availableProviders: { claude: false, codex: false },
    models: { claude: [], codex: [] },
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
    const descriptor = getModelById("anthropic/claude-opus-4-6-api");
    expect(descriptor).toBeTruthy();
    expect(describeModelSource(descriptor!)).toBe("API only");
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

  it("includes Cursor CLI models from availableModelIds when cursor CLI is authenticated", () => {
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

  it("skips unauthenticated CLI subscriptions", () => {
    const status = makeStatus({
      detectedAuth: [{ type: "cli-subscription", cli: "claude", authenticated: false }],
    });
    expect(deriveConfiguredModelIds(status)).toEqual([]);
  });

  it("includes API-key models for the given provider", () => {
    const status = makeStatus({
      detectedAuth: [{ type: "api-key", provider: "anthropic" }],
    });
    const ids = deriveConfiguredModelIds(status);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const descriptor = getModelById(id);
      expect(descriptor).toBeTruthy();
      expect(descriptor!.family).toBe("anthropic");
      expect(descriptor!.isCliWrapped).toBe(false);
    }
  });

  it("includes openrouter models for openrouter auth", () => {
    const status = makeStatus({
      detectedAuth: [{ type: "openrouter" }],
    });
    const ids = deriveConfiguredModelIds(status);
    // Only check if there are openrouter models in the registry
    const openrouterModels = MODEL_REGISTRY.filter(
      (m) => m.family === "openrouter" && !m.deprecated,
    );
    expect(ids.length).toBe(openrouterModels.length);
  });

  it("includes local models for local auth", () => {
    const status = makeStatus({
      detectedAuth: [{ type: "local", provider: "ollama" }],
    });
    const ids = deriveConfiguredModelIds(status);
    const ollamaModels = MODEL_REGISTRY.filter(
      (m) => m.family === "ollama" && !m.deprecated && !m.isCliWrapped,
    );
    expect(ids.length).toBe(ollamaModels.length);
  });

  it("merges models from multiple auth sources without duplicates", () => {
    const status = makeStatus({
      detectedAuth: [
        { type: "cli-subscription", cli: "claude", authenticated: true },
        { type: "api-key", provider: "anthropic" },
      ],
    });
    const ids = deriveConfiguredModelIds(status);
    // Should have both CLI-wrapped and API-key anthropic models, no dupes
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
  });

  it("normalizes provider name to lowercase and trimmed", () => {
    const status = makeStatus({
      detectedAuth: [{ type: "api-key", provider: "  Anthropic  " }],
    });
    const ids = deriveConfiguredModelIds(status);
    expect(ids.length).toBeGreaterThan(0);
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
        { type: "api-key", provider: "openai" },
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
        { type: "api-key", provider: "anthropic" },
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
