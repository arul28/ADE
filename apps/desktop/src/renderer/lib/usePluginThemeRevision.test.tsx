/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PLUGIN_THEME_CHANGED_EVENT } from "./pluginTheme";
import {
  getPluginThemeRevision,
  readThemeColor,
  usePluginThemeRevision,
} from "./usePluginThemeRevision";

function Probe({ onValue }: { onValue: (value: number) => void }) {
  const revision = usePluginThemeRevision();
  onValue(revision);
  return null;
}

function fireThemeChanged(): void {
  act(() => {
    window.dispatchEvent(new Event(PLUGIN_THEME_CHANGED_EVENT));
  });
}

/** Counts only this module's listener, ignoring anything else React installs. */
function themeListenerCalls(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter((call) => call[0] === PLUGIN_THEME_CHANGED_EVENT).length;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("style");
});

describe("usePluginThemeRevision", () => {
  it("advances the revision and notifies every subscriber when the theme changes", () => {
    const first: number[] = [];
    const second: number[] = [];
    render(
      <>
        <Probe onValue={(value) => first.push(value)} />
        <Probe onValue={(value) => second.push(value)} />
      </>,
    );

    const before = getPluginThemeRevision();
    expect(first.at(-1)).toBe(before);
    expect(second.at(-1)).toBe(before);

    fireThemeChanged();

    expect(getPluginThemeRevision()).toBe(before + 1);
    expect(first.at(-1)).toBe(before + 1);
    expect(second.at(-1)).toBe(before + 1);

    fireThemeChanged();

    expect(first.at(-1)).toBe(before + 2);
    expect(second.at(-1)).toBe(before + 2);
  });

  it("installs one window listener for all subscribers and removes it with the last", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const first = render(<Probe onValue={() => undefined} />);
    const second = render(<Probe onValue={() => undefined} />);
    expect(themeListenerCalls(addSpy)).toBe(1);

    first.unmount();
    expect(themeListenerCalls(removeSpy)).toBe(0);

    second.unmount();
    expect(themeListenerCalls(removeSpy)).toBe(1);

    // With nobody subscribed the counter must stand still: the listener is gone,
    // so a later theme change cannot silently keep incrementing it.
    const idle = getPluginThemeRevision();
    window.dispatchEvent(new Event(PLUGIN_THEME_CHANGED_EVENT));
    expect(getPluginThemeRevision()).toBe(idle);

    // Re-subscribing re-installs exactly one listener.
    const third = render(<Probe onValue={() => undefined} />);
    expect(themeListenerCalls(addSpy)).toBe(2);
    third.unmount();
    expect(themeListenerCalls(removeSpy)).toBe(2);
  });
});

describe("readThemeColor", () => {
  it("returns the declared value of a custom property", () => {
    document.documentElement.style.setProperty("--ade-test-color", "#123456");
    expect(readThemeColor("--ade-test-color", "#000000")).toBe("#123456");
  });

  it("trims the declared value", () => {
    document.documentElement.style.setProperty("--ade-test-color", "  #abcdef  ");
    expect(readThemeColor("--ade-test-color", "#000000")).toBe("#abcdef");
  });

  it("returns the fallback when the property is unset", () => {
    expect(readThemeColor("--ade-never-declared", "#fallback")).toBe("#fallback");
  });
});
