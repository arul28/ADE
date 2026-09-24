import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captionMacDesktopFrame,
  clearMacDesktopFrame,
  getMacDesktopFrame,
  resetMacDesktopFrames,
  setMacDesktopFrame,
  subscribeMacDesktopFrame,
} from "./macDesktopFrameStore";

const frame = (laneId: string, dataUrl = "data:image/jpeg;base64,aaa") => ({
  laneId,
  dataUrl,
  width: 2560,
  height: 1440,
  at: 1,
  caption: null,
});

afterEach(() => resetMacDesktopFrames());

describe("macDesktopFrameStore", () => {
  it("hands the last frame to any reader", () => {
    setMacDesktopFrame(frame("lane-a"));
    expect(getMacDesktopFrame("lane-a")?.width).toBe(2560);
    expect(getMacDesktopFrame("lane-b")).toBeNull();
    expect(getMacDesktopFrame(null)).toBeNull();
  });

  it("notifies only the lane that changed", () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribeMacDesktopFrame("lane-a", a);
    subscribeMacDesktopFrame("lane-b", b);
    setMacDesktopFrame(frame("lane-a"));
    expect(a).toHaveBeenCalledTimes(1);
    // The whole reason the store is keyed: a lane streaming at a frame a second
    // must not re-render every other lane's row in the Lanes tab.
    expect(b).not.toHaveBeenCalled();
  });

  it("stops notifying an unsubscribed reader", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeMacDesktopFrame("lane-a", listener);
    unsubscribe();
    setMacDesktopFrame(frame("lane-a"));
    expect(listener).not.toHaveBeenCalled();
  });

  it("captions the frame in place, and only when the caption changed", () => {
    const listener = vi.fn();
    setMacDesktopFrame(frame("lane-a"));
    subscribeMacDesktopFrame("lane-a", listener);
    captionMacDesktopFrame("lane-a", "click · Sign in");
    expect(getMacDesktopFrame("lane-a")?.caption).toBe("click · Sign in");
    expect(getMacDesktopFrame("lane-a")?.dataUrl).toBe("data:image/jpeg;base64,aaa");
    captionMacDesktopFrame("lane-a", "click · Sign in");
    expect(listener).toHaveBeenCalledTimes(1);
    // A caption for a lane with no frame yet cannot invent one.
    captionMacDesktopFrame("lane-zzz", "anything");
    expect(getMacDesktopFrame("lane-zzz")).toBeNull();
  });

  it("clears a destroyed display's frame and says so once", () => {
    const listener = vi.fn();
    setMacDesktopFrame(frame("lane-a"));
    subscribeMacDesktopFrame("lane-a", listener);
    clearMacDesktopFrame("lane-a");
    clearMacDesktopFrame("lane-a");
    expect(getMacDesktopFrame("lane-a")).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
