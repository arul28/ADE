import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type * as NodeChildProcess from "node:child_process";

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
  __testSetSimulatorWindowCaptureHooks,
  SIMULATOR_SOURCE_DISCOVERY_BUDGET_MS,
  activeSimulatorParkingWindow,
  attachSimulatorWindowForCapture,
  followSimulatorWindowUnderAde,
  getSimulatorWindowState,
  releaseSimulatorParkingFollow,
  releaseSimulatorParkingHolder,
  retainSimulatorParkingFollow,
  type SimulatorParkingHolderSender,
} from "./simulatorWindowCapture";

type FakeWindow = {
  id: number;
  isDestroyed: () => boolean;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  getBounds: () => { x: number; y: number; width: number; height: number };
  emit: (event: string) => void;
};

let nextFakeWindowId = 1;

// Only the handful of members the parking follow touches. A real BrowserWindow
// here would drag Electron's native side into a unit test for a counter.
function fakeWindow(): FakeWindow {
  const listeners = new Map<string, Set<() => void>>();
  const add = (event: string, handler: () => void) => {
    const existing = listeners.get(event) ?? new Set<() => void>();
    existing.add(handler);
    listeners.set(event, existing);
  };
  const window: FakeWindow = {
    id: nextFakeWindowId += 1,
    isDestroyed: () => false,
    on: vi.fn((event: string, handler: () => void) => add(event, handler)),
    once: vi.fn((event: string, handler: () => void) => add(event, handler)),
    off: vi.fn((event: string, handler: () => void) => {
      listeners.get(event)?.delete(handler);
    }),
    getBounds: () => ({ x: 0, y: 0, width: 1_400, height: 900 }),
    emit: (event: string) => {
      for (const handler of [...(listeners.get(event) ?? [])]) handler();
    },
  };
  return window;
}

const asBrowserWindow = (window: FakeWindow) => window as unknown as BrowserWindow;

type FakeSender = SimulatorParkingHolderSender & {
  /** The WebContents object itself goes away: a window or webview teardown. */
  destroy: () => void;
  /** The document is swapped under a webContents that survives: a reload. */
  reload: () => void;
  /**
   * A navigation ADE cancels: `will-navigate` is preventDefaulted, so
   * `did-start-navigation` still fires but nothing ever commits and the
   * document — with the drawer in it — stays exactly where it was.
   */
  startBlockedNavigation: () => void;
  /** A `pushState` or fragment jump, which keeps the drawer alive. */
  navigateInPage: () => void;
  /** How many listeners are still armed, across both events. */
  listenerCount: () => number;
};

/**
 * A renderer's webContents: an id, the two teardown signals, and — the part
 * that matters for the leak — real add/remove semantics, so a test can see the
 * listeners a long-lived renderer accumulates.
 */
function fakeSender(id: number): FakeSender {
  const listeners = new Map<string, Set<(...args: never[]) => void>>();
  const add = (event: string, listener: (...args: never[]) => void) => {
    const set = listeners.get(event) ?? new Set();
    set.add(listener);
    listeners.set(event, set);
    return undefined;
  };
  const remove = (event: string, listener: (...args: never[]) => void) => {
    listeners.get(event)?.delete(listener);
    return undefined;
  };
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of [...(listeners.get(event) ?? [])]) {
      (listener as (...rest: unknown[]) => void)(...args);
    }
  };
  return {
    id,
    on: add as SimulatorParkingHolderSender["on"],
    off: remove as SimulatorParkingHolderSender["off"],
    destroy: () => emit("destroyed"),
    reload: () => {
      emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      emit("did-navigate", "https://ade.local/index.html");
    },
    // Identical to a reload right up to the commit that never comes: a
    // main-frame, cross-document navigation start that `will-navigate` cancels.
    startBlockedNavigation: () => emit("did-start-navigation", { isMainFrame: true, isSameDocument: false }),
    navigateInPage: () => emit("did-navigate-in-page", "https://ade.local/index.html#work"),
    listenerCount: () => {
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    },
  };
}

type FakeRun = { stdout?: string; stderr?: string; code?: number | null };

/** Which `osascript` this module runs, told apart by a marker in its script. */
type MacCall = "open" | "state" | "measure" | "apply";

function classifyCall(command: string, args: string[]): MacCall {
  if (command === "open") return "open";
  const script = args[args.length - 1] ?? "";
  if (script.includes('"not-running|false|0|0"')) return "state";
  if (script.includes('"nowindow"')) return "measure";
  return "apply";
}

function installSpawn(responder: (call: MacCall) => FakeRun) {
  const calls: MacCall[] = [];
  const spawn = ((command: string, args: string[]) => {
    const call = classifyCall(command, args);
    calls.push(call);
    const result = responder(call);
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => boolean;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    setImmediate(() => {
      if (result.stdout) child.stdout.emit("data", Buffer.from(result.stdout));
      if (result.stderr) child.stderr.emit("data", Buffer.from(result.stderr));
      child.emit("exit", result.code ?? 0);
    });
    return child;
    // The module only touches stdout/stderr/kill/exit, so the shape above is
    // the whole contract.
  }) as unknown as typeof NodeChildProcess.spawn;
  return { spawn, calls };
}

let restoreHooks: (() => void) | null = null;

function installCaptureHooks(responder: (call: MacCall) => FakeRun) {
  const installed = installSpawn(responder);
  restoreHooks?.();
  restoreHooks = __testSetSimulatorWindowCaptureHooks({ spawn: installed.spawn, platform: "darwin" });
  return installed;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  // The module owns process-wide state (the parked frame, the suspension flag,
  // the holders); start every case with a claim that is then torn down, because
  // only the teardown resets all three.
  followSimulatorWindowUnderAde(asBrowserWindow(fakeWindow()));
  releaseSimulatorParkingFollow();
});

afterEach(() => {
  restoreHooks?.();
  restoreHooks = null;
});

// A budget below the ceilings it wraps is not a cap, it is a guaranteed
// timeout: the re-attach guard (`remainingMs() > 700`) becomes unreachable on
// exactly the path it exists for, and discovery reports "timed out" before the
// first sweep has had a fair chance.
it("budgets more wall time than the subprocess ceilings discovery wraps", () => {
  const windowStateRead = 900;
  // open + measure + apply + confirm, per park.
  const park = 900 + 900 + 1_200 + 900;
  const attachSettle = 300;
  const reattachSettle = 600;
  const closingReMeasure = 900;

  expect(SIMULATOR_SOURCE_DISCOVERY_BUDGET_MS).toBeGreaterThan(
    windowStateRead + park + attachSettle + park + reattachSettle + closingReMeasure,
  );
});

// The window state is the only thing standing between the drawer and a blank
// live view, and every branch of it is a parse of one `osascript` line.
describe("getSimulatorWindowState", () => {
  it("reports a Simulator that is not running", async () => {
    installCaptureHooks(() => ({ stdout: "not-running|false|0|0" }));

    const state = await getSimulatorWindowState();

    expect(state).toMatchObject({
      appRunning: false,
      windowCount: 0,
      capturable: false,
      issue: "not-running",
      message: "The simulator is not running. Launch it from ADE again.",
    });
  });

  it("classifies a hidden process, a window-less process, and an all-minimized one", async () => {
    const cases: Array<{ raw: string; issue: string }> = [
      { raw: "false|1|0", issue: "hidden" },
      { raw: "true|0|0", issue: "no-window" },
      { raw: "true|2|2", issue: "minimized" },
    ];
    for (const { raw, issue } of cases) {
      installCaptureHooks(() => ({ stdout: `${raw}\n` }));
      const state = await getSimulatorWindowState();
      expect({ raw, issue: state.issue, capturable: state.capturable })
        .toEqual({ raw, issue, capturable: false });
      expect(state.message).toBeTruthy();
    }
  });

  it("reports a capturable window when only some windows are minimized", async () => {
    installCaptureHooks(() => ({ stdout: "true|2|1" }));

    const state = await getSimulatorWindowState();

    expect(state).toMatchObject({
      appRunning: true,
      visible: true,
      windowCount: 2,
      minimizedWindowCount: 1,
      capturable: true,
      issue: null,
      message: null,
    });
  });

  // The single branch that decides "show the Automation permission card" versus
  // "ADE has no idea". Getting it wrong either hides a fixable blocker or
  // accuses the user of a permission they already granted.
  it("reads a refused Automation grant off stderr and names it", async () => {
    installCaptureHooks(() => ({
      code: 1,
      stderr: "execution error: Not authorized to send Apple events to System Events. (-1743)",
    }));

    const state = await getSimulatorWindowState();

    expect(state).toMatchObject({
      appRunning: true,
      capturable: false,
      issue: "automation-denied",
      message: "Automation is off for ADE. Turn it on so ADE can manage the simulator window.",
    });
  });

  it("leaves an unexplained osascript failure as unknown rather than a permission card", async () => {
    installCaptureHooks(() => ({ code: 1, stderr: "execution error: something else entirely (-1728)" }));

    const state = await getSimulatorWindowState();

    expect(state).toMatchObject({ issue: "unknown", capturable: null, message: null });
  });
});

// Simulator.app constrains its window to the device's aspect ratio, so what ADE
// asks for is almost never what it gets. Recording the request suspended the
// follow on its own first park.
describe("simulator window follow", () => {
  it("keeps following after its own attach instead of reading the resize as a user takeover", async () => {
    // The attach asks for 440x780 beside ADE; Simulator lands on 402x860.
    const constrained = "ok|true|false|112|72|402|860";
    const installed = installCaptureHooks((call) => (call === "measure" ? { stdout: constrained } : { stdout: "" }));
    const window = fakeWindow();

    followSimulatorWindowUnderAde(asBrowserWindow(window));
    await attachSimulatorWindowForCapture(asBrowserWindow(window));

    // First ADE window move: the follow nudges the Simulator along.
    window.emit("move");
    await wait(400);
    const afterFirstMove = installed.calls.filter((call) => call === "apply").length;
    expect(afterFirstMove).toBeGreaterThan(1);

    // Second move. Recording the *requested* frame made the comparison above
    // mismatch and suspend the follow, so this one did nothing at all.
    window.emit("move");
    await wait(400);
    expect(installed.calls.filter((call) => call === "apply").length).toBeGreaterThan(afterFirstMove);
  });
});

// One Simulator.app, many ADE windows and many drawers inside each of them.
// The claim is per window; the holders are the capture surfaces inside it.
describe("simulator window parking holders", () => {
  it("ignores a release from a window that does not own the claim", () => {
    const claimant = fakeWindow();
    const other = fakeWindow();
    followSimulatorWindowUnderAde(asBrowserWindow(claimant));
    retainSimulatorParkingFollow(asBrowserWindow(claimant), fakeSender(1));

    expect(releaseSimulatorParkingHolder(asBrowserWindow(other), fakeSender(2))).toBe(false);
    expect(activeSimulatorParkingWindow()).toBe(claimant);
  });

  it("keeps the follow until the last holder in the claiming window releases", () => {
    const claimant = fakeWindow();
    followSimulatorWindowUnderAde(asBrowserWindow(claimant));
    // A chat pane's drawer and the Work sidebar's iOS tab, same window, so the
    // same renderer takes both holders.
    const renderer = fakeSender(1);
    retainSimulatorParkingFollow(asBrowserWindow(claimant), renderer);
    retainSimulatorParkingFollow(asBrowserWindow(claimant), renderer);

    expect(releaseSimulatorParkingHolder(asBrowserWindow(claimant), renderer)).toBe(false);
    expect(activeSimulatorParkingWindow()).toBe(claimant);

    expect(releaseSimulatorParkingHolder(asBrowserWindow(claimant), renderer)).toBe(true);
    expect(activeSimulatorParkingWindow()).toBeNull();
  });

  it("does not let a double release drive the count negative", () => {
    const claimant = fakeWindow();
    const renderer = fakeSender(1);
    followSimulatorWindowUnderAde(asBrowserWindow(claimant));
    retainSimulatorParkingFollow(asBrowserWindow(claimant), renderer);

    expect(releaseSimulatorParkingHolder(asBrowserWindow(claimant), renderer)).toBe(true);
    // The failed-capture path releases and unmount releases again.
    expect(releaseSimulatorParkingHolder(asBrowserWindow(claimant), renderer)).toBe(false);

    // A negative count would have survived the next claim's single release.
    followSimulatorWindowUnderAde(asBrowserWindow(claimant));
    retainSimulatorParkingFollow(asBrowserWindow(claimant), renderer);
    expect(releaseSimulatorParkingHolder(asBrowserWindow(claimant), renderer)).toBe(true);
    expect(activeSimulatorParkingWindow()).toBeNull();
  });

  it("zeroes the holders of a window that closes", () => {
    const first = fakeWindow();
    followSimulatorWindowUnderAde(asBrowserWindow(first));
    retainSimulatorParkingFollow(asBrowserWindow(first), fakeSender(1));
    retainSimulatorParkingFollow(asBrowserWindow(first), fakeSender(2));

    first.emit("closed");
    expect(activeSimulatorParkingWindow()).toBeNull();

    // A leaked count would keep the next window's follow alive past its own
    // release.
    const second = fakeWindow();
    followSimulatorWindowUnderAde(asBrowserWindow(second));
    retainSimulatorParkingFollow(asBrowserWindow(second), fakeSender(3));
    expect(releaseSimulatorParkingHolder(asBrowserWindow(second), fakeSender(3))).toBe(true);
    expect(activeSimulatorParkingWindow()).toBeNull();
  });

  it("refuses a holder from a window that lost the claim race", () => {
    const claimant = fakeWindow();
    const loser = fakeWindow();
    followSimulatorWindowUnderAde(asBrowserWindow(claimant));
    expect(retainSimulatorParkingFollow(asBrowserWindow(claimant), fakeSender(1))).toBe(true);
    // Reported, not silent: a surface told nothing would assume it held one and
    // release it later, decrementing the claimant's only holder.
    expect(retainSimulatorParkingFollow(asBrowserWindow(loser), fakeSender(2))).toBe(false);

    // The loser's holder was never counted, so the claimant's single release
    // still drops the follow.
    expect(releaseSimulatorParkingHolder(asBrowserWindow(claimant), fakeSender(1))).toBe(true);
    expect(activeSimulatorParkingWindow()).toBeNull();
  });

  // A renderer reload throws away the React tree without running any cleanup,
  // and it neither closes the window nor destroys the webContents: the object,
  // its id and its listeners all survive a navigation. Watching only for
  // `destroyed` therefore left the pre-reload holder booked under the same
  // sender id, the reloaded drawer retained on top of it, and the count never
  // came back to zero — every later real release answered false and every ADE
  // window move went on repositioning the user's Simulator with no drawer open.
  it("drops a reloaded renderer's holders once its navigation commits", () => {
    const claimant = fakeWindow();
    const renderer = fakeSender(1);
    followSimulatorWindowUnderAde(asBrowserWindow(claimant));
    retainSimulatorParkingFollow(asBrowserWindow(claimant), renderer);

    renderer.reload();

    expect(activeSimulatorParkingWindow()).toBeNull();
  });

  // The reload path, played out the way the leak actually presented: the new
  // document's drawer takes its own holder, and the single release it later
  // issues has to be enough to drop the follow.
  it("lets the reloaded drawer's own release drop the follow", () => {
    const claimant = fakeWindow();
    const renderer = fakeSender(1);
    followSimulatorWindowUnderAde(asBrowserWindow(claimant));
    retainSimulatorParkingFollow(asBrowserWindow(claimant), renderer);

    renderer.reload();
    // The reload dropped the last holder, so the claim went with it; the new
    // document's drawer re-arms discovery and claims again.
    followSimulatorWindowUnderAde(asBrowserWindow(claimant));
    retainSimulatorParkingFollow(asBrowserWindow(claimant), renderer);

    expect(releaseSimulatorParkingHolder(asBrowserWindow(claimant), renderer)).toBe(true);
    expect(activeSimulatorParkingWindow()).toBeNull();
  });

  // ADE preventDefaults every main-frame navigation that is not the renderer
  // URL — a file dropped outside a drop zone is enough to start one. The
  // navigation still *starts*, so watching `did-start-navigation` tore the
  // follow down under a fully live document that then never re-retained, and
  // the Simulator silently stopped following ADE until the user restarted the
  // live view. A navigation that never commits must leave the holders alone.
  it("keeps the holders of a renderer whose navigation is cancelled", () => {
    const claimant = fakeWindow();
    const renderer = fakeSender(1);
    followSimulatorWindowUnderAde(asBrowserWindow(claimant));
    retainSimulatorParkingFollow(asBrowserWindow(claimant), renderer);

    renderer.startBlockedNavigation();

    expect(activeSimulatorParkingWindow()).toBe(claimant);
    expect(releaseSimulatorParkingHolder(asBrowserWindow(claimant), renderer)).toBe(true);
  });

  // `pushState` and fragment jumps keep the document — and the drawer holding
  // the claim — alive, so they must not be read as a reload.
  it("keeps the holders of a renderer that navigates in place", () => {
    const claimant = fakeWindow();
    const renderer = fakeSender(1);
    followSimulatorWindowUnderAde(asBrowserWindow(claimant));
    retainSimulatorParkingFollow(asBrowserWindow(claimant), renderer);

    renderer.navigateInPage();

    expect(activeSimulatorParkingWindow()).toBe(claimant);
    expect(releaseSimulatorParkingHolder(asBrowserWindow(claimant), renderer)).toBe(true);
  });

  // A webview or window teardown is the other way holders die, and it still has
  // to work — it is what the `closed` sweep cannot see for a webContents that
  // is not the window's own.
  it("drops a renderer's holders when its webContents is destroyed", () => {
    const claimant = fakeWindow();
    const renderer = fakeSender(1);
    followSimulatorWindowUnderAde(asBrowserWindow(claimant));
    retainSimulatorParkingFollow(asBrowserWindow(claimant), renderer);

    renderer.destroy();

    expect(activeSimulatorParkingWindow()).toBeNull();
  });

  it("keeps the follow when one of two renderers reloads", () => {
    const claimant = fakeWindow();
    const reloaded = fakeSender(1);
    const survivor = fakeSender(2);
    followSimulatorWindowUnderAde(asBrowserWindow(claimant));
    retainSimulatorParkingFollow(asBrowserWindow(claimant), reloaded);
    retainSimulatorParkingFollow(asBrowserWindow(claimant), survivor);

    reloaded.reload();
    expect(activeSimulatorParkingWindow()).toBe(claimant);

    expect(releaseSimulatorParkingHolder(asBrowserWindow(claimant), survivor)).toBe(true);
    expect(activeSimulatorParkingWindow()).toBeNull();
  });

  // The renderer outlives every drawer inside it, so a listener armed per
  // holder and never removed is a permanent accumulation on one webContents:
  // Node warns at 11 and the leak is real long before that.
  it("does not stack teardown listeners across drawer open/close cycles", () => {
    const claimant = fakeWindow();
    const renderer = fakeSender(1);

    for (let cycle = 0; cycle < 12; cycle += 1) {
      followSimulatorWindowUnderAde(asBrowserWindow(claimant));
      retainSimulatorParkingFollow(asBrowserWindow(claimant), renderer);
      expect(releaseSimulatorParkingHolder(asBrowserWindow(claimant), renderer)).toBe(true);
    }

    expect(renderer.listenerCount()).toBe(0);
  });
});
