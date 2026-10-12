/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_THEME_ID } from "../../shared/theme";

const PREFERENCES_KEY = "ade.userPreferences.v1";

// The hosted client's sign-in screen paints before the app store exists. These
// tests load the module alone, as that screen does.
async function loadWithoutAppStore() {
  vi.resetModules();
  return await import("./appearanceStore");
}

describe("appearance before the app store loads", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.matchMedia = vi.fn(() => ({ matches: false })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("reads the saved look, follows the system scheme, and saves only the painted mode", async () => {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify({
      theme: "dark",
      themeId: DEFAULT_THEME_ID,
      themeFollowsSystem: true,
      interfacePreferences: { sansFont: "system", reduceMotion: true },
      smartTooltipsEnabled: false,
      chatFontSizePx: 15,
    }));
    const { getAppearanceState } = await loadWithoutAppStore();

    expect(getAppearanceState()).toMatchObject({
      theme: "dark",
      themeId: DEFAULT_THEME_ID,
      themeFollowsSystem: true,
      systemColorScheme: "dark",
      smartTooltipsEnabled: false,
      interfacePreferences: { sansFont: "system", monoFont: "jetbrains", reduceMotion: true },
    });

    getAppearanceState().setSystemColorScheme("light");
    expect(getAppearanceState()).toMatchObject({ theme: "light", systemColorScheme: "light", themeId: DEFAULT_THEME_ID });

    getAppearanceState().setInterfacePreferences({ reduceMotion: false });
    expect(getAppearanceState().interfacePreferences).toMatchObject({ sansFont: "system", reduceMotion: false });

    // The choice and every preference the gate does not own stay as they were saved.
    expect(JSON.parse(window.localStorage.getItem(PREFERENCES_KEY)!)).toMatchObject({
      theme: "light",
      themeId: DEFAULT_THEME_ID,
      themeFollowsSystem: true,
      chatFontSizePx: 15,
      interfacePreferences: { sansFont: "system", reduceMotion: false },
    });
  });

  it.each([
    // [stored value, value read]: a whole number from 1 to the grid cap, else Automatic (null).
    [4, 4],
    [1, 1],
    [6, 6],
    ["4", null],
    [0, null],
    [7, null],
    [4.5, null],
    [undefined, null],
  ])("reads a stored Focus grid chats-per-page of %j as %j", async (stored, read) => {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify({
      theme: "dark",
      themeId: DEFAULT_THEME_ID,
      interfacePreferences: { focusGridMaxChats: stored },
    }));
    const { getAppearanceState } = await loadWithoutAppStore();
    expect(getAppearanceState().interfacePreferences.focusGridMaxChats).toBe(read);

    // A write goes through the same rule, and the other preferences keep their values.
    getAppearanceState().setInterfacePreferences({ focusGridMaxChats: 3 });
    expect(getAppearanceState().interfacePreferences).toMatchObject({ focusGridMaxChats: 3, sansFont: "geist" });
    getAppearanceState().setInterfacePreferences({ focusGridMaxChats: 99 });
    expect(getAppearanceState().interfacePreferences.focusGridMaxChats).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(PREFERENCES_KEY)!).interfacePreferences.focusGridMaxChats).toBeNull();
  });

  it("falls back to the legacy keys and writes no partial record that would hide them from the app's migration", async () => {
    window.localStorage.setItem("ade.theme", "light");
    window.localStorage.setItem("ade.smartTooltips", "false");
    const { getAppearanceState } = await loadWithoutAppStore();

    expect(getAppearanceState()).toMatchObject({
      theme: "light",
      themeId: "light",
      themeFollowsSystem: false,
      smartTooltipsEnabled: false,
    });

    getAppearanceState().setInterfacePreferences({ reduceMotion: true });
    getAppearanceState().setSystemColorScheme("light");
    expect(getAppearanceState().interfacePreferences.reduceMotion).toBe(true);
    expect(window.localStorage.getItem(PREFERENCES_KEY)).toBeNull();
    expect(window.localStorage.getItem("ade.theme")).toBe("light");
  });
});
