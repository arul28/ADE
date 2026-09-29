import { afterEach, describe, expect, it } from "vitest";
import { resetModelPickerRuntimeCatalogForTests } from "../../shared/ModelPicker/runtimeCatalogCache";
import { descriptorsFromAgentChatModelCatalog } from "../../shared/ModelPicker/modelCatalog";
import { harnessModelLabel } from "./harnessModels";
import { readStoredKeySources } from "./harnessSources";

afterEach(() => {
  resetModelPickerRuntimeCatalogForTests();
});

describe("harness model labels", () => {
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
    expect(sources.map((source) => `${source.provider}:${source.credentialId}`))
      .toEqual(["acme:work", "other:work"]);
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
