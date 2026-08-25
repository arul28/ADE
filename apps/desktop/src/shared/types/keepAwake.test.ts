import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEEP_AWAKE_PREFERENCES,
  INERT_KEEP_AWAKE_SNAPSHOT,
  normalizeKeepAwakePreferences,
  systemSleepStopsAgents,
} from "./keepAwake";

describe("INERT_KEEP_AWAKE_SNAPSHOT", () => {
  it("says off on every field, so a missing service cannot look like a held lock", () => {
    // Four surfaces report "nothing is held here": main without the service,
    // the hosted web adapter, the browser preview, and the settings section
    // before its first read. They share this literal so a field added to the
    // snapshot cannot be remembered in three of them and forgotten in the
    // fourth — and the value that gets forgotten is always the dangerous one.
    expect(INERT_KEEP_AWAKE_SNAPSHOT).toEqual({
      preferences: DEFAULT_KEEP_AWAKE_PREFERENCES,
      lidClosedSupported: false,
      lidClosedActive: false,
      levelError: null,
      systemSleep: null,
    });
    expect(INERT_KEEP_AWAKE_SNAPSHOT.preferences.level).toBe("never");
    expect(systemSleepStopsAgents(INERT_KEEP_AWAKE_SNAPSHOT.systemSleep)).toBe(false);
  });

  it("is frozen through the nested object, not just documented as shared", () => {
    // The main process structured-clones its copy across IPC, but the web and
    // browser-mock paths hand this exact identity into React state. A caller
    // that mutated it in place would rewrite what every other surface reads as
    // "off", silently and everywhere at once.
    expect(Object.isFrozen(INERT_KEEP_AWAKE_SNAPSHOT)).toBe(true);
    expect(Object.isFrozen(INERT_KEEP_AWAKE_SNAPSHOT.preferences)).toBe(true);
    expect(() => {
      (INERT_KEEP_AWAKE_SNAPSHOT.preferences as { level: string }).level = "lid-closed";
    }).toThrow();
    expect(INERT_KEEP_AWAKE_SNAPSHOT.preferences.level).toBe("never");
  });

  it("survives a round trip through the preference normalizer", () => {
    expect(normalizeKeepAwakePreferences(INERT_KEEP_AWAKE_SNAPSHOT.preferences))
      .toEqual(DEFAULT_KEEP_AWAKE_PREFERENCES);
  });
});
