// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_ATTENTION_PREFERENCES } from "../../../shared/types";
import {
  activityNotchSettingsFromPreferences,
  activityPreferencesWithNotchPresentation,
  onActivityNotchSettingsChanged,
  persistActivityNotchSettings,
  readActivityNotchEnabled,
  readActivityNotchPresentation,
  resolveActivityNotchPresentation,
  writeActivityNotchEnabled,
  writeActivityNotchPresentation,
} from "./activityNotchLocalSettings";

/**
 * These key strings are the regression guard for the Attention → Activity
 * rename. Every symbol around them moved; renaming one of these would silently
 * reset the notch on every Mac that has ever configured it.
 */
describe("Activity notch local settings", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults safely and falls back from an unreadable reveal mode", () => {
    expect(readActivityNotchEnabled()).toBe(true);
    expect(readActivityNotchPresentation()).toEqual({
      revealMode: "hover",
      expandedPanelEnabled: true,
    });

    window.localStorage.setItem("ade:attention:notch-reveal-mode", "telepathy");
    expect(readActivityNotchPresentation().revealMode).toBe("hover");
  });

  it("round-trips both presentation modes independently from full disable", () => {
    for (const revealMode of ["always", "hover"] as const) {
      writeActivityNotchPresentation({
        revealMode,
        expandedPanelEnabled: false,
      });
      expect(readActivityNotchPresentation()).toEqual({
        revealMode,
        expandedPanelEnabled: false,
      });
    }
    writeActivityNotchEnabled(false);

    expect(activityNotchSettingsFromPreferences(DEFAULT_ATTENTION_PREFERENCES))
      .toMatchObject({
        enabled: false,
        revealMode: "hover",
        expandedPanelEnabled: false,
      });
  });

  /**
   * The two retired modes both kept a strip on the menu bar, so an upgrade must
   * land on `always`. Mapping them to the default instead would hide the notch
   * on every Mac that had ever chosen "Click only" — a setting silently
   * becoming the opposite of itself.
   */
  it("maps the retired reveal modes forward instead of hiding the notch", () => {
    for (const legacy of ["minimal", "click"]) {
      window.localStorage.setItem("ade:attention:notch-reveal-mode", legacy);
      expect(readActivityNotchPresentation().revealMode).toBe("always");
    }
  });

  /**
   * Automatic reveal and the live ticker are not settings any more — the native
   * helper reads neither — so a value an older build left behind must not come
   * back as a presentation field, and nothing here may write one either. The
   * stored keys are deliberately left where they are rather than cleared: a
   * downgrade should still find its own choice.
   */
  it("neither reads nor writes the retired reveal and ticker keys", () => {
    window.localStorage.setItem("ade:attention:notch-auto-reveal", "false");
    window.localStorage.setItem("ade:attention:notch-ticker", "false");

    expect(readActivityNotchPresentation()).toEqual({
      revealMode: "hover",
      expandedPanelEnabled: true,
    });
    expect(resolveActivityNotchPresentation(DEFAULT_ATTENTION_PREFERENCES)).toEqual({
      revealMode: "hover",
      expandedPanelEnabled: true,
    });

    writeActivityNotchPresentation({ revealMode: "always", expandedPanelEnabled: true });
    expect(window.localStorage.getItem("ade:attention:notch-auto-reveal")).toBe("false");
    expect(window.localStorage.getItem("ade:attention:notch-ticker")).toBe("false");

    const synced = activityPreferencesWithNotchPresentation(DEFAULT_ATTENTION_PREFERENCES, {
      revealMode: "always",
      expandedPanelEnabled: true,
    });
    expect(Object.keys(synced.account)).not.toContain("notchAutomaticReveal");
    expect(Object.keys(synced.account)).not.toContain("notchTicker");
  });

  it("persists native context-menu changes and notifies the renderer", () => {
    let observed: ReturnType<typeof activityNotchSettingsFromPreferences> | null = null;
    const unsubscribe = onActivityNotchSettingsChanged((settings) => {
      observed = settings;
    });
    persistActivityNotchSettings({
      enabled: false,
      revealMode: "always",
      expandedPanelEnabled: false,
      preferredDisplayId: null,
      hideDetails: true,
      celebrationsEnabled: true,
      soundsEnabled: false,
    });

    expect(readActivityNotchEnabled()).toBe(false);
    expect(readActivityNotchPresentation()).toEqual({
      revealMode: "always",
      expandedPanelEnabled: false,
    });
    expect(observed).toMatchObject({
      enabled: false,
      revealMode: "always",
      expandedPanelEnabled: false,
    });
    unsubscribe();
  });

  it("prefers the synced presentation and falls back to this Mac's cache", () => {
    writeActivityNotchPresentation({
      revealMode: "always",
      expandedPanelEnabled: false,
    });

    // Nothing synced yet: the local cache is the whole answer, so an offline or
    // signed-out launch opens the notch the way this Mac last had it.
    expect(resolveActivityNotchPresentation(null)).toEqual({
      revealMode: "always",
      expandedPanelEnabled: false,
    });

    const synced = activityPreferencesWithNotchPresentation(DEFAULT_ATTENTION_PREFERENCES, {
      revealMode: "hover",
      expandedPanelEnabled: true,
    });
    expect(resolveActivityNotchPresentation(synced)).toEqual({
      revealMode: "hover",
      expandedPanelEnabled: true,
    });
  });

  it("ignores a synced reveal mode this build has never heard of", () => {
    writeActivityNotchPresentation({
      revealMode: "always",
      expandedPanelEnabled: true,
    });
    const preferences = {
      ...DEFAULT_ATTENTION_PREFERENCES,
      account: {
        ...DEFAULT_ATTENTION_PREFERENCES.account,
        notchRevealMode: "telepathy" as never,
      },
    };

    // Unknown from a newer host: the shipped default, not this Mac's cache —
    // an unrecognized mode is not evidence of anything.
    expect(resolveActivityNotchPresentation(preferences).revealMode).toBe("hover");
  });
});
