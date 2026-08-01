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
      automaticRevealEnabled: true,
      tickerEnabled: true,
    });

    window.localStorage.setItem("ade:attention:notch-reveal-mode", "telepathy");
    expect(readActivityNotchPresentation().revealMode).toBe("hover");
  });

  it("round-trips every presentation mode independently from full disable", () => {
    for (const revealMode of ["minimal", "hover", "click"] as const) {
      writeActivityNotchPresentation({
        revealMode,
        expandedPanelEnabled: false,
        automaticRevealEnabled: false,
        tickerEnabled: true,
      });
      expect(readActivityNotchPresentation()).toEqual({
        revealMode,
        expandedPanelEnabled: false,
        automaticRevealEnabled: false,
        tickerEnabled: true,
      });
    }
    writeActivityNotchEnabled(false);

    expect(activityNotchSettingsFromPreferences(DEFAULT_ATTENTION_PREFERENCES))
      .toMatchObject({
        enabled: false,
        revealMode: "click",
        expandedPanelEnabled: false,
      });
  });

  it("persists native context-menu changes and notifies the renderer", () => {
    let observed: ReturnType<typeof activityNotchSettingsFromPreferences> | null = null;
    const unsubscribe = onActivityNotchSettingsChanged((settings) => {
      observed = settings;
    });
    persistActivityNotchSettings({
      enabled: false,
      revealMode: "minimal",
      expandedPanelEnabled: false,
      automaticRevealEnabled: false,
      tickerEnabled: false,
      preferredDisplayId: null,
      hideDetails: true,
      celebrationsEnabled: true,
      soundsEnabled: false,
    });

    expect(readActivityNotchEnabled()).toBe(false);
    expect(readActivityNotchPresentation()).toEqual({
      revealMode: "minimal",
      expandedPanelEnabled: false,
      automaticRevealEnabled: false,
      tickerEnabled: false,
    });
    expect(observed).toMatchObject({
      enabled: false,
      revealMode: "minimal",
      expandedPanelEnabled: false,
    });
    unsubscribe();
  });

  it("prefers the synced presentation and falls back to this Mac's cache", () => {
    writeActivityNotchPresentation({
      revealMode: "click",
      expandedPanelEnabled: false,
      automaticRevealEnabled: false,
      tickerEnabled: false,
    });

    // Nothing synced yet: the local cache is the whole answer, so an offline or
    // signed-out launch opens the notch the way this Mac last had it.
    expect(resolveActivityNotchPresentation(null)).toEqual({
      revealMode: "click",
      expandedPanelEnabled: false,
      automaticRevealEnabled: false,
      tickerEnabled: false,
    });

    const synced = activityPreferencesWithNotchPresentation(DEFAULT_ATTENTION_PREFERENCES, {
      revealMode: "minimal",
      expandedPanelEnabled: true,
      automaticRevealEnabled: true,
      tickerEnabled: true,
    });
    expect(resolveActivityNotchPresentation(synced)).toEqual({
      revealMode: "minimal",
      expandedPanelEnabled: true,
      automaticRevealEnabled: true,
      tickerEnabled: true,
    });
  });

  it("ignores a synced reveal mode this build has never heard of", () => {
    writeActivityNotchPresentation({
      revealMode: "minimal",
      expandedPanelEnabled: true,
      automaticRevealEnabled: true,
      tickerEnabled: true,
    });
    const preferences = {
      ...DEFAULT_ATTENTION_PREFERENCES,
      account: {
        ...DEFAULT_ATTENTION_PREFERENCES.account,
        notchRevealMode: "telepathy" as never,
      },
    };

    expect(resolveActivityNotchPresentation(preferences).revealMode).toBe("minimal");
  });
});
