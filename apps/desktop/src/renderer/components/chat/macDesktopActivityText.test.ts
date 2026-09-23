import { describe, expect, it } from "vitest";

import { macDesktopNotParkedSentence } from "./macDesktopActivityText";

describe("macDesktopNotParkedSentence", () => {
  it("never prints a code it does not know", () => {
    const sentence = macDesktopNotParkedSentence("localhost:5173", "window_not_movable");
    expect(sentence).toBe("Couldn't move localhost:5173 to the lane's screen. It stays on your main screen.");
    expect(sentence).not.toContain("window_not_movable");
  });

  it("names the codes it knows in plain words", () => {
    expect(macDesktopNotParkedSentence("Xcode", "gave_up")).toBe("Xcode keeps leaving the lane's screen. It is on your main screen.");
    expect(macDesktopNotParkedSentence("Xcode", "ax_not_trusted"))
      .toBe("Couldn't move Xcode: Accessibility is off. It stays on your main screen.");
  });

  it("falls back to a generic window name", () => {
    expect(macDesktopNotParkedSentence("  ", "whatever")).toMatch(/^Couldn't move A window/);
  });
});
