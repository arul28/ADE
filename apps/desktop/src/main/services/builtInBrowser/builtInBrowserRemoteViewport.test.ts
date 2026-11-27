import { describe, expect, it, vi } from "vitest";
import type { BuiltInBrowserEmulationState } from "../../../shared/types/builtInBrowser";
import { createRemoteViewport } from "./builtInBrowserRemoteViewport";
import type { BrowserTabState } from "./builtInBrowserService";

/*
  Phone size is applied over awaited CDP calls, and the watch, the desktop and
  the tab can all move during those awaits. These are the races where the
  tab could be left at phone size with nobody watching, lose a size someone
  else set, or get state recorded against a tab that already closed.
*/

const PHONE = { width: 390, height: 700, deviceScaleFactor: 3 };
const PRESET = { presetId: "iphone-17", label: "iPhone 17", width: 402, height: 874 } as BuiltInBrowserEmulationState;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  let destroyed = false;
  const tab = {
    id: "tab-1",
    emulation: null,
    webContents: { isDestroyed: () => destroyed },
    debuggerHolds: new Set<string>(),
    recording: null,
    recordingStarting: false,
    devToolsMode: null,
    handoff: null,
  } as unknown as BrowserTabState;
  let watched = true;
  // Each CDP send waits for the test to let it land.
  const sends: Array<{ next: BuiltInBrowserEmulationState | null; land: () => void }> = [];
  const viewport = createRemoteViewport({
    logger: () => null,
    tabById: (tabId) => (tabId === tab.id && !destroyed ? tab : null),
    isWatched: () => watched,
    acquireDebuggerHold: async (target, owner) => { target.debuggerHolds.add(owner); },
    releaseDebuggerHold: (target, owner) => { target.debuggerHolds.delete(owner); },
    sendEmulationCommands: (_target, next) => {
      const gate = deferred();
      sends.push({ next, land: gate.resolve });
      return gate.promise;
    },
    reapplyTabEmulation: vi.fn(),
    onLayoutChanged: () => {},
  });
  /** Lets every queued CDP send land, in order, until the tab is idle. */
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 20; round += 1) {
      await new Promise((done) => setImmediate(done));
      const next = sends.shift();
      if (next) next.land();
    }
  };
  return {
    tab,
    viewport,
    sends,
    settle,
    endWatch: () => { watched = false; viewport.end(tab.id); },
    close: () => { destroyed = true; viewport.forget(tab.id); },
  };
}

describe("remote viewport (phone size)", () => {
  it("comes off when the watch lapses while the first apply is on its way", async () => {
    const { tab, viewport, sends, settle, endWatch } = setup();
    viewport.sync(tab, PHONE);
    await new Promise((done) => setImmediate(done));
    expect(sends.map((send) => send.next?.width)).toEqual([390]);
    endWatch();
    await settle();
    expect(tab.emulation).toBeNull();
    expect(tab.debuggerHolds.has("emulation")).toBe(false);
  });

  it("keeps a size someone set while phone size was coming off", async () => {
    const { tab, viewport, sends, settle, endWatch } = setup();
    viewport.sync(tab, PHONE);
    await settle();
    expect(tab.emulation?.width).toBe(390);
    endWatch();
    await new Promise((done) => setImmediate(done));
    expect(sends.map((send) => send.next)).toEqual([null]);
    // The toolbar's device control lands during the clear's await.
    tab.debuggerHolds.add("emulation");
    tab.emulation = PRESET;
    await settle();
    expect(tab.emulation).toBe(PRESET);
    expect(tab.debuggerHolds.has("emulation")).toBe(true);
  });

  it("records nothing against a tab that closed during the apply", async () => {
    const { tab, viewport, sends, settle, close } = setup();
    viewport.sync(tab, PHONE);
    await new Promise((done) => setImmediate(done));
    expect(sends).toHaveLength(1);
    close();
    await settle();
    expect(tab.emulation).toBeNull();
  });

  it("is off once release resolves, before a recording or DevTools takes the tab", async () => {
    const { tab, viewport, settle } = setup();
    viewport.sync(tab, PHONE);
    await settle();
    expect(tab.emulation?.width).toBe(390);
    tab.recordingStarting = true;
    const released = viewport.release(tab);
    await settle();
    await released;
    expect(tab.emulation).toBeNull();
    expect(tab.debuggerHolds.has("emulation")).toBe(false);
    // A read while the recording starts does not put it back.
    expect(viewport.sync(tab, PHONE)).toMatchObject({ viewportApplied: false });
  });
});
