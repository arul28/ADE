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
    // The flavor-agnostic ("all") check needs BOTH sources fresh, so it is
    // stale too — only the SDK source was refreshed.
    expect(runtimeCatalogProviderIsFresh("cursor")).toBe(false);
  });

  it("an sdk-scoped refresh leaves the cli surface stale even with dual-capable rows", () => {
    // The catalog carries dual-capable rows (cli AND sdk), but the refresh
    // only probed the SDK source. The CLI surface must stay stale so a later
    // Work-tab CLI picker still forces its own probe (per-source freshness),
    // rather than trusting the SDK refresh because dual rows happen to be cli.
    rememberRuntimeCatalog(cursorCatalog({ sdk: true, cli: true }), {
      mode: "force",
      refreshProvider: "cursor",
      cursorSource: "sdk",
    });

    expect(runtimeCatalogProviderIsFresh("cursor", "sdk")).toBe(true);
    expect(runtimeCatalogProviderIsFresh("cursor", "cli")).toBe(false);
  });

  it("treats both surfaces as fresh once the catalog carries CLI and SDK rows", () => {
    rememberRuntimeCatalog(cursorCatalog({ sdk: true, cli: true }), {
      mode: "force",
      refreshProvider: "cursor",
    });

    expect(runtimeCatalogProviderIsFresh("cursor", "sdk")).toBe(true);
    expect(runtimeCatalogProviderIsFresh("cursor", "cli")).toBe(true);
    expect(runtimeCatalogProviderIsFresh("cursor")).toBe(true);
  });

  it("reports cursor stale for every flavor before any catalog is cached", () => {
    expect(runtimeCatalogProviderIsFresh("cursor", "sdk")).toBe(false);
    expect(runtimeCatalogProviderIsFresh("cursor", "cli")).toBe(false);
    expect(runtimeCatalogProviderIsFresh("cursor")).toBe(false);
  });
});
