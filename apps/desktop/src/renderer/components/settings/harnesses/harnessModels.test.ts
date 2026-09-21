import { afterEach, describe, expect, it } from "vitest";
import { resetModelPickerRuntimeCatalogForTests } from "../../shared/ModelPicker/runtimeCatalogCache";
import { descriptorsFromAgentChatModelCatalog } from "../../shared/ModelPicker/modelCatalog";
import { harnessModelLabel, modelChoicesForSource, sourceNeedsFreeTextModel } from "./harnessModels";
import { readStoredKeySources, sourceMatchesRow, type HarnessKeySource } from "./harnessSources";
import { cursorCatalog } from "./harnessTestCatalog";

const cursorKey: HarnessKeySource = {
  kind: "key",
  provider: "cursor",
  credentialId: "default",
  label: "Cursor",
};

afterEach(() => {
  resetModelPickerRuntimeCatalogForTests();
});

describe("harness model choices", () => {
  it("lists a runtime-discovered Cursor model instead of asking for a typed id", () => {
    const source = { kind: "key", provider: "cursor", credentialId: "default", label: "Cursor" } as const;
    const catalog = cursorCatalog();
    const choices = modelChoicesForSource(source, cursorKey, catalog);

    expect(choices).toContainEqual({ id: "cursor/composer-9", label: "Composer 9" });
    // A preset is only selectable for a chat, and a chat session rejects a
    // Cursor model its SDK cannot reach. Offering one would save cleanly and
    // fail at launch.
    expect(choices.map((choice) => choice.id)).not.toContain("cursor/cli-only");
    // The catalog is what makes the list non-empty, so it is what turns the
    // text box off. Without it this same source has nothing to offer.
    expect(sourceNeedsFreeTextModel(source, cursorKey, catalog)).toBe(false);
  });

  it("falls back to the static registry when no catalog is available", () => {
    const source = { kind: "account", provider: "claude", instanceId: "claude" } as const;
    const choices = modelChoicesForSource(source, null, null);

    expect(choices.length).toBeGreaterThan(0);
    expect(sourceNeedsFreeTextModel(source, null)).toBe(false);
  });

  it("asks for a typed id when neither the registry nor the catalog lists the provider", () => {
    // OpenRouter, Google, DeepSeek, Mistral, Groq and Together are first-class
    // key providers with no static registry rows and no catalog group that maps
    // back to them. Without this branch the wizard offers an empty select and
    // the preset can never be finished.
    const source = { kind: "key", provider: "openrouter", credentialId: "default", label: "OpenRouter" } as const;
    const key: HarnessKeySource = {
      kind: "key",
      provider: "openrouter",
      credentialId: "default",
      label: "OpenRouter",
    };

    expect(modelChoicesForSource(source, key, cursorCatalog())).toEqual([]);
    expect(sourceNeedsFreeTextModel(source, key, cursorCatalog())).toBe(true);
  });

  it("asks for a typed id for a custom endpoint that declares no models", () => {
    const source = { kind: "key", provider: "acme", credentialId: "default", label: "Acme" } as const;
    const endpoint: HarnessKeySource = {
      kind: "key",
      provider: "acme",
      credentialId: "default",
      label: "Acme",
      baseUrl: "https://acme.test/v1",
    };

    expect(sourceNeedsFreeTextModel(source, endpoint)).toBe(true);
    // The same endpoint, once it declares its own models, gets a list.
    expect(sourceNeedsFreeTextModel(source, { ...endpoint, models: ["acme/one"] })).toBe(false);
    expect(modelChoicesForSource(source, { ...endpoint, models: ["acme/one"] })).toEqual([
      { id: "acme/one", label: "acme/one" },
    ]);
  });

  it("names a runtime-only model from the caller's catalog bucket, not the default one", () => {
    // The composer's picker can be pinned to a machine, so its preset rows read
    // that machine's bucket. Resolving against the default one printed the raw
    // slug — the exact failure the runtime-first lookup was added to remove.
    // An id no registry rule can parse, so the catalog bucket is the only
    // thing that can name it.
    const hostOnly = {
      fetchedAt: "2026-01-01T00:00:00.000Z",
      groups: [{
        key: "opencode",
        providers: [{
          key: "opencode",
          subsections: [{ models: [{ id: "acme-gateway-7", displayName: "Acme Gateway 7", groupKey: "opencode" }] }],
        }],
      }],
    } as unknown as Parameters<typeof descriptorsFromAgentChatModelCatalog>[0];
    descriptorsFromAgentChatModelCatalog(hostOnly, undefined, "machine-a");

    expect(harnessModelLabel("acme-gateway-7", "machine-a")).toBe("Acme Gateway 7");
    expect(harnessModelLabel("acme-gateway-7")).toBe("acme-gateway-7");
    expect(harnessModelLabel("acme-gateway-7", "machine-b")).toBe("acme-gateway-7");
  });
});

describe("harness key source identity", () => {
  it("keeps OpenCode custom provider credentials distinct when ids match", () => {
    const sources = readStoredKeySources(null, [], [
      {
        provider: "acme",
        credentialId: "work",
        label: "Acme",
        source: "store",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
      {
        provider: "other",
        credentialId: "work",
        label: "Other",
        source: "store",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
    expect(sources).toHaveLength(2);
    expect(sourceMatchesRow(
      { kind: "key", provider: "acme", credentialId: "work", label: "Acme" },
      sources[0]!,
    )).toBe(true);
    expect(sourceMatchesRow(
      { kind: "key", provider: "other", credentialId: "work", label: "Other" },
      sources[0]!,
    )).toBe(false);
  });

  it("uses the shared default credential id for legacy provider rows", () => {
    const sources = readStoredKeySources(null, ["openai"], []);

    expect(sources).toEqual([
      expect.objectContaining({
        kind: "key",
        provider: "openai",
        credentialId: "default",
      }),
    ]);
  });
});
