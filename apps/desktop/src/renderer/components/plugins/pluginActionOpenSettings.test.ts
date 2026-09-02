import { describe, expect, it, vi } from "vitest";

import { applyPluginActionOpenSettings } from "./pluginActionOpenSettings";

const navigateToAppTarget = vi.hoisted(() => vi.fn());

vi.mock("../../lib/openExternal", () => ({
  navigateToAppTarget: (...args: unknown[]) => navigateToAppTarget(...args),
}));

describe("applyPluginActionOpenSettings", () => {
  it("opens the Cursor provider settings page", () => {
    navigateToAppTarget.mockClear();
    expect(applyPluginActionOpenSettings(
      { openSettings: "agents.provider.cursor" },
      { pluginId: "ade-cursor-cloud", actionId: "openCursorSettings" },
    )).toBe(true);
    expect(navigateToAppTarget).toHaveBeenCalledWith({
      kind: "settings",
      tab: "agents",
      anchor: "ai-provider-cursor",
    });
  });

  it("opens the Secrets tab for a plugin that cannot put values on a panel", () => {
    navigateToAppTarget.mockClear();
    expect(applyPluginActionOpenSettings(
      { openSettings: "secrets.secrets" },
      { pluginId: "ade-cursor-cloud", actionId: "openSecretsSettings" },
    )).toBe(true);
    expect(navigateToAppTarget).toHaveBeenCalledWith({
      kind: "settings",
      tab: "secrets",
      anchor: "secrets",
    });
  });

  it("refuses an unknown page rather than guessing", () => {
    navigateToAppTarget.mockClear();
    expect(applyPluginActionOpenSettings(
      { openSettings: "billing.plans" },
      { pluginId: "ade-cursor-cloud", actionId: "openCursorSettings" },
    )).toBe(false);
    expect(navigateToAppTarget).not.toHaveBeenCalled();
  });
});
