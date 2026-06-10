import { beforeEach, describe, expect, it } from "vitest";
import {
  rememberRuntimeCatalog,
  resetModelPickerRuntimeCatalogForTests,
  runtimeCatalogProviderIsFresh,
} from "./runtimeCatalogCache";
import type { AgentChatModelCatalog } from "../../../../shared/types";

function cursorCatalog(availability: { sdk: boolean; cli: boolean }): AgentChatModelCatalog {
  return {
    fetchedAt: new Date().toISOString(),
    groups: [
      {
        key: "cursor",
        displayName: "Cursor",
        providers: [
          {
            key: "cursor",
            displayName: "Cursor",
            badgeColor: "#60A5FA",
            modelCount: 1,
            subsections: [
              {
                key: "cursor",
                label: "Cursor",
                models: [
                  {
                    id: "cursor/composer-2",
                    runtimeModelId: "cursor/composer-2",
                    provider: "cursor",
                    providerKey: "cursor",
                    groupKey: "cursor",
                    displayName: "Composer 2",
                    isDefault: true,
                    isAvailable: true,
                    supportsReasoning: true,
                    supportsTools: true,
                    cursorAvailability: availability,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("runtimeCatalogCache flavor-aware cursor freshness", () => {
  beforeEach(() => {
    resetModelPickerRuntimeCatalogForTests();
  });

  it("does not let an SDK-only refresh satisfy a CLI-surface freshness check", () => {
    // A chat surface refreshed cursor through the SDK; only SDK rows are
    // available in the cached catalog.
    rememberRuntimeCatalog(cursorCatalog({ sdk: true, cli: false }), {
      mode: "force",
      refreshProvider: "cursor",
    });

    // The SDK surface sees its models as fresh...
    expect(runtimeCatalogProviderIsFresh("cursor", "sdk")).toBe(true);
    // ...but a CLI-flavored surface must still treat cursor as stale, because
    // none of the cached rows are runnable through the cursor-agent CLI.
    expect(runtimeCatalogProviderIsFresh("cursor", "cli")).toBe(false);
    // The flavor-agnostic check (modelCount > 0) stays fresh — the generic
    // path is unchanged for non-flavored callers.
    expect(runtimeCatalogProviderIsFresh("cursor")).toBe(true);
  });

  it("treats both surfaces as fresh once the catalog carries CLI and SDK rows", () => {
    rememberRuntimeCatalog(cursorCatalog({ sdk: true, cli: true }), {
      mode: "force",
      refreshProvider: "cursor",
    });

    expect(runtimeCatalogProviderIsFresh("cursor", "sdk")).toBe(true);
    expect(runtimeCatalogProviderIsFresh("cursor", "cli")).toBe(true);
  });

  it("reports cursor stale for every flavor before any catalog is cached", () => {
    expect(runtimeCatalogProviderIsFresh("cursor", "sdk")).toBe(false);
    expect(runtimeCatalogProviderIsFresh("cursor", "cli")).toBe(false);
    expect(runtimeCatalogProviderIsFresh("cursor")).toBe(false);
  });
});
