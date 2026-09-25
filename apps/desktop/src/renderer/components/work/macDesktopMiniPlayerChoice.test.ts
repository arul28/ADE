/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import {
  MAC_DESKTOP_MINI_PLAYER_STORAGE_KEY,
  normalizeMacDesktopMiniPlayerChoice,
  readMacDesktopMiniPlayerChoice,
  writeMacDesktopMiniPlayerChoice,
} from "./macDesktopMiniPlayerChoice";

afterEach(() => {
  window.localStorage.clear();
});

describe("macDesktopMiniPlayerChoice", () => {
  it("round-trips a width and a place", () => {
    writeMacDesktopMiniPlayerChoice({ width: 401.6, position: { x: 20.2, y: 30.7 } });
    expect(readMacDesktopMiniPlayerChoice()).toEqual({ width: 402, position: { x: 20, y: 31 } });
  });

  it("reads junk as never moved, and forgets an empty choice", () => {
    window.localStorage.setItem(MAC_DESKTOP_MINI_PLAYER_STORAGE_KEY, "{not json");
    expect(readMacDesktopMiniPlayerChoice()).toBeNull();
    expect(normalizeMacDesktopMiniPlayerChoice({ width: -4, position: { x: "a", y: 2 } })).toBeNull();
    expect(normalizeMacDesktopMiniPlayerChoice({ width: 300, position: null }))
      .toEqual({ width: 300, position: null });
    writeMacDesktopMiniPlayerChoice({ width: null, position: null });
    expect(window.localStorage.getItem(MAC_DESKTOP_MINI_PLAYER_STORAGE_KEY)).toBeNull();
  });
});
