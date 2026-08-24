import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  desktopCapturer: { getSources: vi.fn(async () => []) },
  screen: {
    getDisplayMatching: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1_920, height: 1_080 } })),
    getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1_920, height: 1_080 } })),
  },
  shell: { openExternal: vi.fn() },
  systemPreferences: { getMediaAccessStatus: vi.fn(() => "granted") },
}));

import type { BrowserWindow } from "electron";
import {
  activeSimulatorParkingWindow,
  followSimulatorWindowUnderAde,
  releaseSimulatorParkingFollow,
  releaseSimulatorParkingHolder,
  retainSimulatorParkingFollow,
} from "./simulatorWindowCapture";

type FakeWindow = {
  isDestroyed: () => boolean;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  getBounds: () => { x: number; y: number; width: number; height: number };
  closed: () => void;
};

// Only the handful of members the parking follow touches. A real BrowserWindow
// here would drag Electron's native side into a unit test for a counter.
function fakeWindow(): FakeWindow {
  const listeners = new Map<string, () => void>();
  const window: FakeWindow = {
    isDestroyed: () => false,
    on: vi.fn((event: string, handler: () => void) => {
      listeners.set(event, handler);
    }),
    once: vi.fn((event: string, handler: () => void) => {
      listeners.set(event, handler);
    }),
    off: vi.fn(),
    getBounds: () => ({ x: 0, y: 0, width: 1_400, height: 900 }),
    closed: () => listeners.get("closed")?.(),
  };
  return window;
}

const asBrowserWindow = (window: FakeWindow) => window as unknown as BrowserWindow;

// One Simulator.app, many ADE windows and many drawers inside each of them.
// The claim is per window; the holders are the capture surfaces inside it.
describe("simulator window parking holders", () => {
  beforeEach(() => {
    // The module owns process-wide state; start every case unparked.
    releaseSimulatorParkingFollow();
  });

  it("ignores a release from a window that does not own the claim", () => {
    const claimant = fakeWindow();
    const other = fakeWindow();
    followSimulatorWindowUnderAde(asBrowserWindow(claimant));
    retainSimulatorParkingFollow(asBrowserWindow(claimant));

    expect(releaseSimulatorParkingHolder(asBrowserWindow(other))).toBe(false);
    expect(activeSimulatorParkingWindow()).toBe(claimant);
  });

  it("keeps the follow until the last holder in the claiming window releases", () => {
    const claimant = fakeWindow();
    followSimulatorWindowUnderAde(asBrowserWindow(claimant));
    // A chat pane's drawer and the Work sidebar's iOS tab, same window.
    retainSimulatorParkingFollow(asBrowserWindow(claimant));
    retainSimulatorParkingFollow(asBrowserWindow(claimant));

    expect(releaseSimulatorParkingHolder(asBrowserWindow(claimant))).toBe(false);
    expect(activeSimulatorParkingWindow()).toBe(claimant);

    expect(releaseSimulatorParkingHolder(asBrowserWindow(claimant))).toBe(true);
    expect(activeSimulatorParkingWindow()).toBeNull();
  });

  it("does not let a double release drive the count negative", () => {
    const claimant = fakeWindow();
    followSimulatorWindowUnderAde(asBrowserWindow(claimant));
    retainSimulatorParkingFollow(asBrowserWindow(claimant));

    expect(releaseSimulatorParkingHolder(asBrowserWindow(claimant))).toBe(true);
    // The failed-capture path releases and unmount releases again.
    expect(releaseSimulatorParkingHolder(asBrowserWindow(claimant))).toBe(false);

    // A negative count would have survived the next claim's single release.
    followSimulatorWindowUnderAde(asBrowserWindow(claimant));
    retainSimulatorParkingFollow(asBrowserWindow(claimant));
    expect(releaseSimulatorParkingHolder(asBrowserWindow(claimant))).toBe(true);
    expect(activeSimulatorParkingWindow()).toBeNull();
  });

  it("zeroes the holders of a window that closes", () => {
    const first = fakeWindow();
    followSimulatorWindowUnderAde(asBrowserWindow(first));
    retainSimulatorParkingFollow(asBrowserWindow(first));
    retainSimulatorParkingFollow(asBrowserWindow(first));

    first.closed();
    expect(activeSimulatorParkingWindow()).toBeNull();

    // A leaked count would keep the next window's follow alive past its own
    // release.
    const second = fakeWindow();
    followSimulatorWindowUnderAde(asBrowserWindow(second));
    retainSimulatorParkingFollow(asBrowserWindow(second));
    expect(releaseSimulatorParkingHolder(asBrowserWindow(second))).toBe(true);
    expect(activeSimulatorParkingWindow()).toBeNull();
  });

  it("refuses a holder from a window that lost the claim race", () => {
    const claimant = fakeWindow();
    const loser = fakeWindow();
    followSimulatorWindowUnderAde(asBrowserWindow(claimant));
    retainSimulatorParkingFollow(asBrowserWindow(claimant));
    retainSimulatorParkingFollow(asBrowserWindow(loser));

    // The loser's holder was never counted, so the claimant's single release
    // still drops the follow.
    expect(releaseSimulatorParkingHolder(asBrowserWindow(claimant))).toBe(true);
    expect(activeSimulatorParkingWindow()).toBeNull();
  });
});
