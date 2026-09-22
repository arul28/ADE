import { afterEach, describe, expect, it } from "vitest";
import { resolveClaudeCliModelAlias } from "./claudeCliModels";
import { MODEL_MANIFEST_PROVIDER_GROUPS, modelManifestGateAllows, parseModelManifest, type ModelManifest } from "./modelManifest";
import {
  adoptHostModelManifest,
  applyModelManifest,
  BUNDLED_MODEL_MANIFEST,
  getActiveModelManifest,
  getAppDefaultModelDescriptor,
  getDefaultModelDescriptor,
  getModelById,
  listModelDescriptorsForProvider,
  MODEL_PROVIDER_GROUPS,
  MODEL_REGISTRY,
  onModelManifestApplied,
  resolveModelAlias,
} from "./modelRegistry";

const NEW_CODEX_FIELDS = {
  shortId: "gpt-7-nova",
  aliases: ["gpt-7-nova"],
  displayName: "GPT-7 Nova",
  family: "openai",
  authTypes: ["cli-subscription"],
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  capabilities: { tools: true, vision: true, reasoning: true, streaming: true },
  reasoningTiers: ["low", "medium", "high"],
  color: "#10A37F",
  providerRoute: "codex-cli",
  providerModelId: "gpt-7-nova",
  cliCommand: "codex",
  isCliWrapped: true,
  inputPricePer1M: 3,
  outputPricePer1M: 15,
} as const;

function manifest(overrides: Partial<ModelManifest>): ModelManifest {
  return {
    version: 1,
    updatedAt: "2030-01-01T00:00:00Z",
    models: [],
    ...overrides,
  };
}

afterEach(() => {
  applyModelManifest(BUNDLED_MODEL_MANIFEST);
});

describe("bundled model manifest", () => {
  it("adds GPT-6 Sol, GPT-6 Luna, and Claude Opus 5.5 with their verified wire ids", () => {
    expect(getModelById("openai/gpt-6-sol")?.providerModelId).toBe("gpt-6-sol");
    expect(getModelById("openai/gpt-6-luna")?.providerModelId).toBe("gpt-6-luna");
    expect(getModelById("anthropic/claude-opus-5-5")?.providerModelId).toBe("claude-opus-5-5");
    expect(resolveModelAlias("sol")?.id).toBe("openai/gpt-6-sol");
    expect(resolveModelAlias("luna")?.id).toBe("openai/gpt-6-luna");
    expect(resolveModelAlias("opus")?.id).toBe("anthropic/claude-opus-5-5");
    // The older generation stays reachable by its full id.
    expect(resolveModelAlias("gpt-5.6-sol")?.id).toBe("openai/gpt-5.6-sol");
    expect(resolveModelAlias("opus-5")?.id).toBe("anthropic/claude-opus-5");
  });

  it("orders the new Codex rows right after Astra", () => {
    const ids = listModelDescriptorsForProvider("codex").map((model) => model.id);
    expect(ids.slice(0, 3)).toEqual(["openai/gpt-6-astra", "openai/gpt-6-sol", "openai/gpt-6-luna"]);
  });

  it("makes Claude Opus 5.5 the app-wide and Claude default, keeping Astra for Codex", () => {
    expect(getAppDefaultModelDescriptor()?.id).toBe("anthropic/claude-opus-5-5");
    expect(getDefaultModelDescriptor("claude")?.id).toBe("anthropic/claude-opus-5-5");
    expect(getDefaultModelDescriptor("codex")?.id).toBe("openai/gpt-6-astra");
    expect(listModelDescriptorsForProvider("claude")[0]?.id).toBe("anthropic/claude-opus-5-5");
  });
});

describe("parseModelManifest", () => {
  it("rejects an unknown schema version and non-patchable fields", () => {
    expect(parseModelManifest({ version: 2, updatedAt: "2030-01-01T00:00:00Z", models: [] }).ok).toBe(false);
    const bad = parseModelManifest({
      version: 1,
      updatedAt: "2030-01-01T00:00:00Z",
      models: [{ id: "openai/gpt-6-sol", fields: { harnessProfile: "verified" } }],
    });
    expect(bad.ok).toBe(false);
  });

  it("only accepts routes ADE runs, each launching its own CLI", () => {
    const base = { version: 1, updatedAt: "2030-01-01T00:00:00Z" };
    const withFields = (fields: Record<string, unknown>) =>
      parseModelManifest({ ...base, models: [{ id: "openai/gpt-7-nova", fields }] }).ok;
    expect(withFields({ providerRoute: "codex-cli", cliCommand: "codex" })).toBe(true);
    expect(withFields({ providerRoute: "codex-cli", cliCommand: "claude" })).toBe(false);
    expect(withFields({ cliCommand: "/bin/sh" })).toBe(false);
    expect(withFields({ providerRoute: "shell" })).toBe(false);
    expect(withFields({ providerModelId: "gpt-7 --dangerous" })).toBe(false);
    expect(withFields({ color: "red; background: url(x)" })).toBe(false);
    expect(withFields({ reasoningTiers: ["low", "turbo"] })).toBe(false);
  });

  it("rejects a defaults key that is not a provider ADE knows", () => {
    const parsed = parseModelManifest({
      version: 1,
      updatedAt: "2030-01-01T00:00:00Z",
      defaults: { providers: { cladue: [{ model: "anthropic/claude-opus-5-5" }] } },
      models: [],
    });
    expect(parsed.ok).toBe(false);
    // The manifest's own list must track the registry's provider groups.
    expect([...MODEL_MANIFEST_PROVIDER_GROUPS].sort()).toEqual([...MODEL_PROVIDER_GROUPS].sort());
  });

  it("rejects a malformed version gate instead of ignoring it", () => {
    const parsed = parseModelManifest({
      version: 1,
      updatedAt: "2030-01-01T00:00:00Z",
      models: [{ id: "openai/gpt-5.6-sol", minAdeVersion: "1.2", fields: { deprecated: true } }],
    });
    expect(parsed.ok).toBe(false);
    const badDefault = parseModelManifest({
      version: 1,
      updatedAt: "2030-01-01T00:00:00Z",
      defaults: { app: [{ model: "openai/gpt-5.6-sol", maxAdeVersionExclusive: "next" }] },
      models: [],
    });
    expect(badDefault.ok).toBe(false);
  });

  it("rejects wrongly typed values rather than applying half a file", () => {
    const bad = parseModelManifest({
      version: 1,
      updatedAt: "2030-01-01T00:00:00Z",
      models: [{ id: "openai/gpt-6-sol", fields: { contextWindow: "big" } }],
    });
    expect(bad.ok).toBe(false);
  });
});

describe("modelManifestGateAllows", () => {
  it("gates release builds by ADE version", () => {
    const gate = { minAdeVersion: "1.2.80", maxAdeVersionExclusive: "1.3.0" };
    expect(modelManifestGateAllows(gate, "1.2.79")).toBe(false);
    expect(modelManifestGateAllows(gate, "1.2.80")).toBe(true);
    expect(modelManifestGateAllows(gate, "v1.2.99")).toBe(true);
    expect(modelManifestGateAllows(gate, "1.3.0")).toBe(false);
  });

  it("lets dev, prerelease, and unknown builds see every entry", () => {
    const gate = { minAdeVersion: "9.9.9" };
    expect(modelManifestGateAllows(gate, "1.0.0-beta.1")).toBe(true);
    expect(modelManifestGateAllows(gate, "0.0.0")).toBe(true);
    expect(modelManifestGateAllows(gate, null)).toBe(true);
  });
});

describe("applyModelManifest", () => {
  it("adds a new model, patches an existing one, and reverts both on the next apply", () => {
    const astra = getModelById("openai/gpt-6-astra")!;
    const originalPrice = astra.inputPricePer1M;
    const result = applyModelManifest(manifest({
      models: [
        { id: "openai/gpt-7-nova", after: "openai/gpt-6-astra", fields: { ...NEW_CODEX_FIELDS, aliases: [...NEW_CODEX_FIELDS.aliases], authTypes: ["cli-subscription"], reasoningTiers: [...NEW_CODEX_FIELDS.reasoningTiers], capabilities: { ...NEW_CODEX_FIELDS.capabilities } } },
        { id: "openai/gpt-6-astra", fields: { inputPricePer1M: 99 } },
      ],
    }));
    expect(result).toMatchObject({ applied: true, added: ["openai/gpt-7-nova"], patched: ["openai/gpt-6-astra"] });
    expect(getModelById("gpt-7-nova")?.displayName).toBe("GPT-7 Nova");
    expect(getModelById("openai/gpt-6-astra")?.inputPricePer1M).toBe(99);
    const ids = MODEL_REGISTRY.map((model) => model.id);
    expect(ids.indexOf("openai/gpt-7-nova")).toBe(ids.indexOf("openai/gpt-6-astra") + 1);

    applyModelManifest(manifest({ models: [] }));
    expect(getModelById("openai/gpt-7-nova")).toBeUndefined();
    expect(getModelById("openai/gpt-6-astra")?.inputPricePer1M).toBe(originalPrice);
  });

  it("hides a model with deprecated and moves defaults without a release", () => {
    applyModelManifest(manifest({
      defaults: { app: [{ model: "openai/gpt-5.6-sol" }], providers: { codex: [{ model: "openai/gpt-5.6-luna" }] } },
      models: [{ id: "anthropic/claude-haiku-4-5", fields: { deprecated: true } }],
    }));
    expect(getAppDefaultModelDescriptor()?.id).toBe("openai/gpt-5.6-sol");
    expect(getDefaultModelDescriptor("codex")?.id).toBe("openai/gpt-5.6-luna");
    expect(listModelDescriptorsForProvider("claude").some((model) => model.id === "anthropic/claude-haiku-4-5")).toBe(false);
  });

  it("skips entries gated above this ADE version", () => {
    const result = applyModelManifest(
      manifest({
        defaults: { app: [{ model: "openai/gpt-7-nova", minAdeVersion: "1.3.0" }] },
        models: [{ id: "openai/gpt-7-nova", minAdeVersion: "1.3.0", fields: { ...NEW_CODEX_FIELDS, aliases: ["gpt-7-nova"], authTypes: ["cli-subscription"], reasoningTiers: ["low"], capabilities: { ...NEW_CODEX_FIELDS.capabilities } } }],
      }),
      { adeVersion: "1.2.90" },
    );
    expect(result.skipped).toEqual(["openai/gpt-7-nova"]);
    expect(getModelById("openai/gpt-7-nova")).toBeUndefined();
    expect(getAppDefaultModelDescriptor()?.id).not.toBe("openai/gpt-7-nova");
  });

  it("keeps the previous manifest when a new one would collide on an alias", () => {
    const listenerCalls: number[] = [];
    const unsubscribe = onModelManifestApplied(() => listenerCalls.push(1));
    const result = applyModelManifest(manifest({
      models: [{ id: "openai/gpt-5.6-luna", fields: { aliases: ["astra"] } }],
    }));
    unsubscribe();
    expect(result.applied).toBe(false);
    expect(listenerCalls).toHaveLength(0);
    expect(getActiveModelManifest()?.manifest).toBe(BUNDLED_MODEL_MANIFEST);
    expect(resolveModelAlias("astra")?.id).toBe("openai/gpt-6-astra");
    // Rows the bundled manifest added survive the rejected apply.
    expect(getModelById("openai/gpt-6-sol")).toBeDefined();
  });

  it("rejects the whole manifest when a new model is incomplete, keeping the last good one", () => {
    const result = applyModelManifest(manifest({
      defaults: { app: [{ model: "openai/gpt-5.6-sol" }] },
      models: [{ id: "openai/gpt-7-nova", fields: { displayName: "GPT-7 Nova" } }],
    }));
    expect(result.applied).toBe(false);
    expect(result.errors[0]).toContain("openai/gpt-7-nova");
    expect(getModelById("openai/gpt-7-nova")).toBeUndefined();
    // The rest of the file did not half-apply.
    expect(getAppDefaultModelDescriptor()?.id).toBe("anthropic/claude-opus-5-5");
    expect(getActiveModelManifest()?.manifest).toBe(BUNDLED_MODEL_MANIFEST);
  });

  it("refuses to re-route a model the build ships", () => {
    const result = applyModelManifest(manifest({
      models: [{ id: "openai/gpt-6-astra", fields: { providerRoute: "claude-cli", cliCommand: "claude" } }],
    }));
    expect(result.applied).toBe(false);
    expect(getModelById("openai/gpt-6-astra")?.providerRoute).toBe("codex-cli");
  });
});

describe("adoptHostModelManifest", () => {
  it("re-gates the same file for a host on a different ADE version", () => {
    const gated = manifest({
      models: [{ id: "openai/gpt-5.6-terra", minAdeVersion: "1.3.0", fields: { deprecated: true } }],
    });
    expect(adoptHostModelManifest({ manifest: gated, adeVersion: "1.2.90" })).toBe(true);
    expect(getModelById("openai/gpt-5.6-terra")?.deprecated).toBeFalsy();
    // Same updatedAt, newer host: the gate now opens.
    expect(adoptHostModelManifest({ manifest: gated, adeVersion: "1.3.1" })).toBe(true);
    expect(getModelById("openai/gpt-5.6-terra")?.deprecated).toBe(true);
    // Same file, same host version: nothing to do.
    expect(adoptHostModelManifest({ manifest: gated, adeVersion: "1.3.1" })).toBe(false);
    // Switching to a host with an older file still takes that host's view.
    const olderUngated = manifest({ updatedAt: "2029-01-01T00:00:00Z" });
    expect(adoptHostModelManifest({ manifest: olderUngated, adeVersion: "1.2.90" })).toBe(true);
    expect(getModelById("openai/gpt-5.6-terra")?.deprecated).toBeFalsy();
  });

  it("adopts only a manifest newer than the active one", () => {
    const older = manifest({ updatedAt: "2020-01-01T00:00:00Z", defaults: { app: [{ model: "openai/gpt-5.6-luna" }] } });
    expect(adoptHostModelManifest({ manifest: older, adeVersion: null })).toBe(false);
    const newer = manifest({ defaults: { app: [{ model: "openai/gpt-5.6-luna" }] } });
    expect(adoptHostModelManifest({ manifest: newer, adeVersion: null })).toBe(true);
    expect(getAppDefaultModelDescriptor()?.id).toBe("openai/gpt-5.6-luna");
  });
});

describe("resolveClaudeCliModelAlias", () => {
  it("passes Claude Opus 5.5 through instead of snapping it to Opus 5", () => {
    expect(resolveClaudeCliModelAlias("claude-opus-5-5[1m]", null)).toBe("claude-opus-5-5");
    expect(resolveClaudeCliModelAlias("anthropic/claude-opus-5-5-1m", null)).toBe("claude-opus-5-5");
    expect(resolveClaudeCliModelAlias("claude-opus-5-5", null)).toBe("claude-opus-5-5");
    expect(resolveClaudeCliModelAlias("anthropic/claude-opus-5-5", null)).toBe("claude-opus-5-5");
    expect(resolveClaudeCliModelAlias("opus", null)).toBe("claude-opus-5-5");
    expect(resolveClaudeCliModelAlias("claude-opus-5", null)).toBe("claude-opus-5");
  });
});
