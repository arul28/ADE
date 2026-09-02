import { describe, expect, it, vi } from "vitest";

import { applyPluginActionOpenSettings } from "./pluginActionOpenSettings";

const navigateToAppTarget = vi.hoisted(() => vi.fn());
const showToast = vi.hoisted(() => vi.fn());

vi.mock("../../lib/openExternal", () => ({
  navigateToAppTarget: (...args: unknown[]) => navigateToAppTarget(...args),
}));

vi.mock("../app/toast/toastStore", () => ({ showToast }));

vi.mock("../../state/appStore", () => ({
  rootAppStoreApi: {
    getState: () => ({
      installedPlugins: [{ pluginId: "ade-cursor-cloud", displayName: "Cursor Cloud" }],
    }),
  },
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

  it("refuses an unknown page rather than guessing, and says so", () => {
    // The console line is the record for the plugin's author. The toast is the
    // answer for the person who pressed the button, to whom a press that opens
    // nothing looks exactly like a plugin that crashed.
    navigateToAppTarget.mockClear();
    showToast.mockClear();
    expect(applyPluginActionOpenSettings(
      { openSettings: "billing.plans" },
      { pluginId: "ade-cursor-cloud", actionId: "openCursorSettings" },
    )).toBe(false);
    expect(navigateToAppTarget).not.toHaveBeenCalled();

    expect(showToast).toHaveBeenCalledTimes(1);
    const toast = showToast.mock.calls[0]?.[0] as { title: string; message: string; tone: string };
    expect(toast.tone).toBe("error");
    // Named, both ways: which plugin asked, and which page does not exist.
    expect(toast.title).toContain("Cursor Cloud");
    expect(toast.message).toContain("billing.plans");
    // The ids that DO exist, because the reader is usually the author.
    expect(toast.message).toContain("agents.provider.cursor");
    expect(toast.message).toContain("secrets.secrets");
  });

  it("refuses the nested shape by the id it named", () => {
    navigateToAppTarget.mockClear();
    showToast.mockClear();
    expect(applyPluginActionOpenSettings(
      { openSettings: { entryId: "  billing.plans  " } },
      { pluginId: "ade-cursor-cloud", actionId: "openCursorSettings" },
    )).toBe(false);
    const toast = showToast.mock.calls[0]?.[0] as { message: string };
    expect(toast.message).toContain("billing.plans");
  });

  it("refuses an empty id without quoting nothing back", () => {
    navigateToAppTarget.mockClear();
    showToast.mockClear();
    expect(applyPluginActionOpenSettings(
      { openSettings: "   " },
      { pluginId: "ade-cursor-cloud", actionId: "openCursorSettings" },
    )).toBe(false);
    const toast = showToast.mock.calls[0]?.[0] as { message: string };
    expect(toast.message).toContain("has no name");
  });

  it("never quotes an unbounded id back into the toast", () => {
    // The id crosses from the plugin child, so its LENGTH is untrusted too.
    navigateToAppTarget.mockClear();
    showToast.mockClear();
    applyPluginActionOpenSettings(
      { openSettings: "x".repeat(5_000) },
      { pluginId: "ade-cursor-cloud", actionId: "openCursorSettings" },
    );
    const toast = showToast.mock.calls[0]?.[0] as { message: string };
    expect(toast.message.length).toBeLessThan(200);
  });

  it("says nothing at all when the result asked for no settings page", () => {
    // The silent path stays silent: a toast on every action that merely did not
    // use this verb would be worse than the bug it replaces.
    navigateToAppTarget.mockClear();
    showToast.mockClear();
    expect(applyPluginActionOpenSettings(
      { message: "Saved." },
      { pluginId: "ade-cursor-cloud", actionId: "logIt" },
    )).toBe(false);
    expect(showToast).not.toHaveBeenCalled();
  });

  it("draws no toast on a known id", () => {
    navigateToAppTarget.mockClear();
    showToast.mockClear();
    expect(applyPluginActionOpenSettings(
      { openSettings: "secrets.secrets" },
      { pluginId: "ade-cursor-cloud", actionId: "openSecretsSettings" },
    )).toBe(true);
    expect(showToast).not.toHaveBeenCalled();
  });
});
