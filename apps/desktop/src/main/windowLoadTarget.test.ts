import { describe, expect, it } from "vitest";
import { isWindowLoadTargetGone } from "./windowLoadTarget";

describe("isWindowLoadTargetGone", () => {
  it("is false only while both the window and its webContents are alive", () => {
    expect(isWindowLoadTargetGone({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false },
    })).toBe(false);
  });

  it("is true when a quit closed the webContents out from under an in-flight load", () => {
    // Measured on Electron 41.5.0: `app.quit()` during `loadURL` rejects the
    // load with ERR_FAILED and leaves the window reporting itself alive while
    // its webContents is already gone.
    expect(isWindowLoadTargetGone({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => true },
    })).toBe(true);
  });

  it("is true for a destroyed window without asking it for its webContents", () => {
    // Electron throws `Object has been destroyed` for `webContents` on a
    // destroyed window, so reading it before `isDestroyed()` turns a window the
    // user closed into a throw on the way out.
    expect(isWindowLoadTargetGone({
      isDestroyed: () => true,
      get webContents(): { isDestroyed: () => boolean } {
        throw new Error("Object has been destroyed");
      },
    })).toBe(true);
  });
});
