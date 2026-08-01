// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_ATTENTION_PREFERENCES } from "../../../shared/types";
import {
  attentionNotchSettingsFromPreferences,
  attentionPreferencesWithNotchPresentation,
  onAttentionNotchSettingsChanged,
  persistAttentionNotchSettings,
  readAttentionNotchEnabled,
  readAttentionNotchPresentation,
  resolveAttentionNotchPresentation,
  writeAttentionNotchEnabled,
  writeAttentionNotchPresentation,
} from "./attentionNotchLocalSettings";

/**
 * These key strings are the regression guard for the Attention → Activity
 * rename. Every symbol around them moved; renaming one of these would silently
 * reset the notch on every Mac that has ever configured it.
 */
describe("attention notch local settings", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults safely and falls back from an unreadable reveal mode", () => {
    expect(readAttentionNotchEnabled()).toBe(true);
    expect(readAttentionNotchPresentation()).toEqual({
      revealMode: "hover",
      expandedPanelEnabled: true,
      automaticRevealEnabled: true,
      tickerEnabled: true,
    });

    window.localStorage.setItem("ade:attention:notch-reveal-mode", "telepathy");
    expect(readAttentionNotchPresentation().revealMode).toBe("hover");
  });

  it("round-trips every presentation mode independently from full disable", () => {
    for (const revealMode of ["minimal", "hover", "click"] as const) {
      writeAttentionNotchPresentation({
        revealMode,
        expandedPanelEnabled: false,
        automaticRevealEnabled: false,
        tickerEnabled: true,
      });
      expect(readAttentionNotchPresentation()).toEqual({
        revealMode,
        expandedPanelEnabled: false,
        automaticRevealEnabled: false,
        tickerEnabled: true,
      });
    }
    writeAttentionNotchEnabled(false);

    expect(attentionNotchSettingsFromPreferences(DEFAULT_ATTENTION_PREFERENCES))
      .toMatchObject({
        enabled: false,
        revealMode: "click",
        expandedPanelEnabled: false,
      });
  });

  it("persists native context-menu changes and notifies the renderer", () => {
    let observed: ReturnType<typeof attentionNotchSettingsFromPreferences> | null = null;
    const unsubscribe = onAttentionNotchSettingsChanged((settings) => {
      observed = settings;
    });
    persistAttentionNotchSettings({
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

    expect(readAttentionNotchEnabled()).toBe(false);
    expect(readAttentionNotchPresentation()).toEqual({
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
    writeAttentionNotchPresentation({
      revealMode: "click",
      expandedPanelEnabled: false,
      automaticRevealEnabled: false,
      tickerEnabled: false,
    });

    // Nothing synced yet: the local cache is the whole answer, so an offline or
    // signed-out launch opens the notch the way this Mac last had it.
    expect(resolveAttentionNotchPresentation(null)).toEqual({
      revealMode: "click",
      expandedPanelEnabled: false,
      automaticRevealEnabled: false,
      tickerEnabled: false,
    });

    const synced = attentionPreferencesWithNotchPresentation(DEFAULT_ATTENTION_PREFERENCES, {
      revealMode: "minimal",
      expandedPanelEnabled: true,
      automaticRevealEnabled: true,
      tickerEnabled: true,
    });
    expect(resolveAttentionNotchPresentation(synced)).toEqual({
      revealMode: "minimal",
      expandedPanelEnabled: true,
      automaticRevealEnabled: true,
      tickerEnabled: true,
    });
  });

  it("ignores a synced reveal mode this build has never heard of", () => {
    writeAttentionNotchPresentation({
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

    expect(resolveAttentionNotchPresentation(preferences).revealMode).toBe("minimal");
  });
});
