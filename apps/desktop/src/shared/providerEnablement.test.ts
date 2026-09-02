import { describe, expect, it } from "vitest";
import {
  disabledProviderSet,
  enabledProviderGroups,
  isProviderDisabled,
  toggleDisabledProvider,
} from "./providerEnablement";

describe("provider enablement", () => {
  it("treats an absent or empty list as everything enabled", () => {
    expect(isProviderDisabled(undefined, "grok")).toBe(false);
    expect(isProviderDisabled({ disabledProviders: [] }, "grok")).toBe(false);
    expect(enabledProviderGroups(null)).toContain("grok");
  });

  it("matches ids case-insensitively and ignores blank entries", () => {
    const ai = { disabledProviders: ["  GROK ", "", "   "] };
    expect(isProviderDisabled(ai, "grok")).toBe(true);
    expect(isProviderDisabled(ai, "Grok")).toBe(true);
    expect(isProviderDisabled(ai, "kimi")).toBe(false);
    expect(disabledProviderSet(ai).size).toBe(1);
  });

  // The list crosses the sync wire. A machine on an older build must round-trip
  // an id it does not recognise rather than dropping it, or toggling a provider
  // off on one device would silently undo itself from another.
  it("keeps ids it does not recognise when toggling", () => {
    const ai = { disabledProviders: ["grok", "some-future-provider"] };
    expect(toggleDisabledProvider(ai, "grok", false)).toEqual(["some-future-provider"]);
    expect(toggleDisabledProvider(ai, "kimi", true)).toEqual([
      "grok",
      "some-future-provider",
      "kimi",
    ]);
  });

  it("does not duplicate an id that is already disabled", () => {
    expect(toggleDisabledProvider({ disabledProviders: ["kimi"] }, "kimi", true)).toEqual(["kimi"]);
  });

  it("filters provider groups down to the ones still switched on", () => {
    const enabled = enabledProviderGroups({ disabledProviders: ["grok", "copilot"] });
    expect(enabled).not.toContain("grok");
    expect(enabled).not.toContain("copilot");
    expect(enabled).toContain("qwen");
    expect(enabled).toContain("claude");
  });
});
