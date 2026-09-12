import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE,
  type IosScreenElement,
  type IosScreenSnapshot,
  type IosSimulatorDevice,
  type IosSimulatorLogRow,
  type IosSimulatorEventPayload,
  type IosSimulatorScreenshot,
} from "../../../shared/types/iosSimulator";
import { createIosDeviceHub, type IosDeviceHubDeps } from "./iosDeviceHub";
import type { IosEventLogProcess } from "./iosEventLog";
import {
  IOS_ACCESSIBILITY_PREFERENCES,
  buildPushPayload,
  createIosDeviceTools,
  parseAppStateFromLaunchctlList,
  type IosDeviceToolsDeps,
} from "./iosDeviceTools";
import {
  buildLogPredicate,
  createIosEventLog,
  parseCompactLogLine,
  type IosEventLogDeps,
} from "./iosEventLog";
import {
  buildElementRef,
  describeElement,
  describeQuery,
  elementTapPoint,
  matchElements,
} from "./iosSemanticActions";


const UDID = "1B2C3D4E-0000-1111-2222-333344445555";
const OTHER_UDID = "9A8B7C6D-0000-1111-2222-333344445555";
/**
 * A second simulator, so a test can name a device the hub does not track.
 *
 * Built per call because the harness moves a device's state when it boots or
 * shuts one down, and a shared object would carry that into the next test.
 */
function otherDevice(): IosSimulatorDevice {
  return {
    udid: OTHER_UDID,
    name: "iPhone 17",
    state: "Shutdown",
    runtime: "iOS 26.0",
    isAvailable: true,
  };
}
const BUILD_ROOT = path.join(path.sep, "workspace", "lane-1");
const FIXED_NOW = new Date("2026-09-11T10:00:00.000Z");

type RecordedRun = { file: string; args: string[]; timeoutMs: number | undefined };

function makeElement(overrides: Partial<IosScreenElement> = {}): IosScreenElement {
  const frame = overrides.frame ?? { x: 10, y: 20, width: 100, height: 40 };
  return {
    id: "accessibility:0.1",
    source: "accessibility",
    layer: "accessibility",
    label: null,
    value: null,
    role: null,
    elementType: null,
    identifier: null,
    frame,
    pixelFrame: {
      x: frame.x * 2,
      y: frame.y * 2,
      width: frame.width * 2,
      height: frame.height * 2,
    },
    componentId: null,
    sourceFile: null,
    sourceLine: null,
    metadata: {},
    ...overrides,
  };
}

const CONTINUE_BUTTON = makeElement({ role: "button", label: "Continue" });

const SCREENSHOT: IosSimulatorScreenshot = {
  deviceUdid: UDID,
  dataUrl: "data:image/png;base64,AAAA",
  filePath: path.join(BUILD_ROOT, "screen.png"),
  width: 1170,
  height: 2532,
  capturedAt: FIXED_NOW.toISOString(),
};

function makeSnapshot(elements: IosScreenElement[]): IosScreenSnapshot {
  return {
    deviceUdid: UDID,
    capturedAt: FIXED_NOW.toISOString(),
    screenshot: SCREENSHOT,
    screen: { width: 390, height: 844, scale: 3 },
    elements,
    hitElement: null,
    providers: [{ source: "accessibility", available: true, elementCount: elements.length }],
    inspectorSnapshot: null,
  };
}

type Harness = {
  hub: ReturnType<typeof createIosDeviceHub>;
  runs: RecordedRun[];
  runArgs: () => string[][];
  /** Every tap and type, in the order the hub made them. */
  interactions: Array<{ kind: "tap" | "type"; detail: string }>;
  openSimulatorApp: ReturnType<typeof vi.fn>;
  events: IosSimulatorEventPayload[];
  writes: Array<{ filePath: string; contents: string }>;
  mkdirs: string[];
  /** Queues one snapshot per call; the last queued one repeats. */
  queueSnapshots: (snapshots: IosScreenSnapshot[]) => void;
  /** Puts one line on the running log stream. */
  emitLogLine: (line: string) => void;
  /** The predicate of every log stream the hub has spawned, in order. */
  logPredicates: Array<string | null>;
};

function createHarness(options: {
  device?: Partial<IosSimulatorDevice>;
  /** Devices `resolveDevice` can find besides the default one. */
  otherDevices?: IosSimulatorDevice[];
  elements?: IosScreenElement[];
  now?: () => Date;
  appSessionOwner?: string | null;
  /** The device the app session runs on, when a test sets an app owner. */
  appSessionDeviceUdid?: string | null;
} = {}): Harness {
  const runs: RecordedRun[] = [];
  /** One entry per spawned log stream, so a test can see what it filters on. */
  const logPredicates: Array<string | null> = [];
  let logLineHandler: ((line: string) => void) | null = null;
  const interactions: Array<{ kind: "tap" | "type"; detail: string }> = [];
  const events: IosSimulatorEventPayload[] = [];
  const writes: Array<{ filePath: string; contents: string }> = [];
  const mkdirs: string[] = [];
  let snapshots: IosScreenSnapshot[] = [makeSnapshot(options.elements ?? [CONTINUE_BUTTON])];

  const device: IosSimulatorDevice = {
    udid: UDID,
    name: "iPhone 17 Pro",
    state: "Shutdown",
    runtime: "iOS 26.0",
    isAvailable: true,
    ...options.device,
  };

  const openSimulatorApp = vi.fn();
  // The hub cannot see the app session, so the host tells it who holds one.
  // Tests that exercise the uninstall guard set this.
  const appSessionOwner = options.appSessionOwner ?? null;

  const catalog: IosSimulatorDevice[] = [device, ...(options.otherDevices ?? [])];

  const deps: IosDeviceHubDeps = {
    getAppSessionOwner: () => appSessionOwner,
    getAppSessionDeviceUdid: () => options.appSessionDeviceUdid ?? null,
    run: async (file, args, runOptions) => {
      runs.push({ file, args, timeoutMs: runOptions?.timeoutMs });
      // A booted device reports itself booted on the next read. Without that
      // the fixture would let a second open see a shut-down device, which is
      // the one state the ownership rules never have to deal with.
      if (file === "xcrun" && args[0] === "simctl" && (args[1] === "boot" || args[1] === "shutdown")) {
        const target = catalog.find((entry) => entry.udid === args[2]);
        if (target) target.state = args[1] === "boot" ? "Booted" : "Shutdown";
      }
      return { stdout: "", stderr: "" };
    },
    // A log stream the test drives by hand, so a case can put a line on the
    // wire without forking `simctl`.
    spawnLogStream: (_deviceUdid, predicate): IosEventLogProcess => {
      logPredicates.push(predicate);
      return {
        onLine: (handler) => { logLineHandler = handler; },
        onError: () => {},
        onExit: () => {},
        kill: () => { logLineHandler = null; },
      };
    },
    openSimulatorApp,
    resolveDevice: async (deviceUdid) => {
      if (!deviceUdid) return device;
      const found = catalog.find((entry) => entry.udid === deviceUdid);
      if (!found) throw new Error(`Simulator device ${deviceUdid} is not available.`);
      return found;
    },
    resolveControlDeviceUdid: async (deviceUdid) => deviceUdid ?? UDID,
    getScreenSnapshot: async () => {
      const next = snapshots.length > 1 ? snapshots.shift() : snapshots[0];
      if (!next) throw new Error("No snapshot queued.");
      return next;
    },
    // The real screenshot follows the device it is given, so the fixture does
    // too. A device-blind fixture hid every rule that compares the captured
    // device with something else.
    screenshot: async (args) => ({ ...SCREENSHOT, deviceUdid: args.deviceUdid ?? UDID }),
    tap: async ({ x, y }) => {
      interactions.push({ kind: "tap", detail: `${x},${y}` });
    },
    typeText: async ({ text }) => {
      interactions.push({ kind: "type", detail: text });
    },
    resolveBuildRoot: async () => BUILD_ROOT,
    emit: (payload) => events.push(payload),
    logger: { info: () => {}, debug: () => {} },
    now: options.now ?? (() => FIXED_NOW),
    fileSystem: {
      mkdir: async (dir) => {
        mkdirs.push(dir);
      },
      writeFile: async (filePath, contents) => {
        writes.push({ filePath, contents });
      },
    },
  };

  const hub = createIosDeviceHub(deps);
  hubs.push(hub);

  return {
    hub,
    runs,
    runArgs: () => runs.map((run) => run.args),
    interactions,
    openSimulatorApp,
    events,
    writes,
    mkdirs,
    queueSnapshots: (next) => {
      snapshots = next;
    },
    emitLogLine: (line: string) => {
      expect(logLineHandler, "the log stream must be running").toBeTruthy();
      logLineHandler?.(line);
    },
    logPredicates,
  };
}

const hubs: Array<ReturnType<typeof createIosDeviceHub>> = [];

afterEach(() => {
  for (const hub of hubs.splice(0)) hub.dispose();
  vi.useRealTimers();
});

/* ------------------------------------------------------------------------- *
 * Device sessions
 * ------------------------------------------------------------------------- */

describe("iosDeviceHub device sessions", () => {
  it("boots a shut-down device and records that ADE booted it", async () => {
    const harness = createHarness();
    const session = await harness.hub.openDevice({ chatSessionId: "chat-a", laneId: "lane-1" });

    expect(harness.runs).toEqual([
      { file: "xcrun", args: ["simctl", "boot", UDID], timeoutMs: 120_000 },
      { file: "xcrun", args: ["simctl", "bootstatus", UDID, "-b"], timeoutMs: 120_000 },
    ]);
    expect(session).toMatchObject({
      deviceUdid: UDID,
      deviceName: "iPhone 17 Pro",
      chatSessionId: "chat-a",
      laneId: "lane-1",
      bootedByAde: true,
    });
    expect(harness.openSimulatorApp).toHaveBeenCalledTimes(1);
    expect(harness.events[0]).toEqual({ type: "device-session-started", deviceSession: session });
  });

  it("adopts a device that is already booted", async () => {
    const harness = createHarness({ device: { state: "Booted" } });
    const session = await harness.hub.openDevice({ chatSessionId: "chat-a" });

    expect(harness.runs).toEqual([]);
    expect(session.bootedByAde).toBe(false);
  });

  it("keeps the device headless when the caller asks for no window", async () => {
    const harness = createHarness();
    await harness.hub.openDevice({ chatSessionId: "chat-a", openWindow: false });
    expect(harness.openSimulatorApp).not.toHaveBeenCalled();
  });

  it("shuts the device down on close only when ADE booted it", async () => {
    const harness = createHarness();
    await harness.hub.openDevice({ chatSessionId: "chat-a" });
    const result = await harness.hub.closeDevice({ chatSessionId: "chat-a" });

    expect(harness.runs.at(-1)).toEqual({
      file: "xcrun",
      args: ["simctl", "shutdown", UDID],
      timeoutMs: 60_000,
    });
    expect(result).toMatchObject({ released: true, shutdown: true });
    expect(harness.hub.getDeviceSession()).toBeNull();
  });

  it("leaves a device the user started running", async () => {
    const harness = createHarness({ device: { state: "Booted" } });
    await harness.hub.openDevice({ chatSessionId: "chat-a" });
    const result = await harness.hub.closeDevice({ chatSessionId: "chat-a" });

    // Shutting this one down would kill a simulator the user opened for
    // something else, which is the whole reason `bootedByAde` exists.
    expect(harness.runArgs()).not.toContainEqual(["simctl", "shutdown", UDID]);
    expect(result.shutdown).toBe(false);
  });

  it("shuts down a device ADE did not boot when the caller insists", async () => {
    const harness = createHarness({ device: { state: "Booted" } });
    await harness.hub.openDevice({ chatSessionId: "chat-a" });
    const result = await harness.hub.closeDevice({ chatSessionId: "chat-a", shutdownDevice: true });

    expect(harness.runArgs()).toContainEqual(["simctl", "shutdown", UDID]);
    expect(result.shutdown).toBe(true);
  });

  it("closes nothing when the caller names a device that is not the open one", async () => {
    // The CLI forwards `close-device --device <udid>`. Before this the hub
    // ignored that value and released whatever it tracked, so naming device B
    // shut down device A.
    const harness = createHarness();
    await harness.hub.openDevice({ chatSessionId: "chat-a" });

    const result = await harness.hub.closeDevice({ chatSessionId: "chat-a", deviceUdid: OTHER_UDID });
    expect(result).toEqual({ released: false, shutdown: false, previousDeviceSession: null });
    expect(harness.runArgs()).not.toContainEqual(["simctl", "shutdown", UDID]);
    expect(harness.hub.getDeviceSession()?.deviceUdid).toBe(UDID);

    // Naming the device that IS open still closes it.
    const closed = await harness.hub.closeDevice({ chatSessionId: "chat-a", deviceUdid: UDID });
    expect(closed.released).toBe(true);
    expect(harness.runArgs()).toContainEqual(["simctl", "shutdown", UDID]);
  });

  it("keeps ADE's shutdown claim when the same device is opened twice", async () => {
    const harness = createHarness();
    const first = await harness.hub.openDevice({ chatSessionId: "chat-a" });
    expect(first.bootedByAde).toBe(true);

    // The second call finds the device booted, so reading the state alone
    // recorded `bootedByAde: false` and left the simulator ADE started running
    // after the close.
    const second = await harness.hub.openDevice({ chatSessionId: "chat-a" });
    expect(second.bootedByAde).toBe(true);

    const result = await harness.hub.closeDevice({ chatSessionId: "chat-a" });
    expect(result.shutdown).toBe(true);
    expect(harness.runArgs()).toContainEqual(["simctl", "shutdown", UDID]);
  });

  it("shuts the previous simulator down when a takeover names another device", async () => {
    const harness = createHarness({ otherDevices: [otherDevice()] });
    await harness.hub.openDevice({ chatSessionId: "chat-a" });

    const taken = await harness.hub.openDevice({
      chatSessionId: "chat-b",
      deviceUdid: OTHER_UDID,
      force: true,
    });

    expect(taken.deviceUdid).toBe(OTHER_UDID);
    // The old session is gone from the hub, so nothing would ever shut this
    // device down again. It is released here instead of being orphaned.
    expect(harness.runArgs()).toContainEqual(["simctl", "shutdown", UDID]);
    expect(harness.events.map((event) => event.type)).toEqual([
      "device-session-started",
      "device-session-released",
      "device-session-started",
    ]);
    expect(harness.events[1]).toMatchObject({
      type: "device-session-released",
      previousDeviceSession: { deviceUdid: UDID },
    });
  });

  it("leaves a user-started simulator running when a takeover names another device", async () => {
    const harness = createHarness({ device: { state: "Booted" }, otherDevices: [otherDevice()] });
    await harness.hub.openDevice({ chatSessionId: "chat-a" });

    await harness.hub.openDevice({ chatSessionId: "chat-b", deviceUdid: OTHER_UDID, force: true });

    expect(harness.runArgs()).not.toContainEqual(["simctl", "shutdown", UDID]);
    expect(harness.events.some((event) => event.type === "device-session-released")).toBe(true);
  });

  it("refuses a second chat and names the owner", async () => {
    const harness = createHarness();
    await harness.hub.openDevice({ chatSessionId: "chat-a" });

    await expect(harness.hub.openDevice({ chatSessionId: "chat-b" })).rejects.toMatchObject({
      code: IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE,
      ownerChatSessionId: "chat-a",
    });
    await expect(harness.hub.closeDevice({ chatSessionId: "chat-b" })).rejects.toMatchObject({
      code: IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE,
    });
    expect(harness.hub.getDeviceSession()?.chatSessionId).toBe("chat-a");
  });

  it("serializes two overlapping opens so the second sees the first chat's session", async () => {
    // The ownership check ran before the resolve and the boot, so two calls
    // that started together both read an empty session and both passed. Each
    // booted a simulator, the second assignment dropped the first session, and
    // the simulator it named stayed booted with no session left to close it.
    const harness = createHarness({ otherDevices: [otherDevice()] });

    const first = harness.hub.openDevice({ chatSessionId: "chat-a", deviceUdid: UDID });
    const second = harness.hub.openDevice({ chatSessionId: "chat-b", deviceUdid: OTHER_UDID });

    await expect(first).resolves.toMatchObject({ chatSessionId: "chat-a", deviceUdid: UDID });
    await expect(second).rejects.toMatchObject({
      code: IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE,
      ownerChatSessionId: "chat-a",
    });
    expect(harness.hub.getDeviceSession()?.deviceUdid).toBe(UDID);
    // The device the losing call named was never booted, so nothing leaked.
    expect(harness.runArgs()).not.toContainEqual(["simctl", "boot", OTHER_UDID]);
  });

  it("refuses an event log with no app scope", async () => {
    // `log stream` reads the whole device. Without a bundle id the predicate is
    // empty, so the rows handed back are every other app's and the system's.
    const harness = createHarness();

    await expect(harness.hub.startEventLog({ deviceUdid: UDID, bundleId: "" }))
      .rejects.toThrow(/without a bundle id/);
    await expect(harness.hub.startEventLog({ deviceUdid: UDID, bundleId: "   " }))
      .rejects.toThrow(/without a bundle id/);
    await expect(harness.hub.getEventLog({ deviceUdid: UDID })).resolves.toMatchObject({ running: false });
  });

  it("refuses an event-log start and stop from a chat that does not own the device", async () => {
    // One log process serves the whole host, so a second chat that could start
    // or stop it would take the first chat's log away. Disabling the drawer
    // control is not the guard: the IPC method is callable on its own.
    const harness = createHarness();
    await harness.hub.openDevice({ chatSessionId: "chat-a" });
    await harness.hub.startEventLog({
      deviceUdid: UDID,
      bundleId: "com.example.app",
      chatSessionId: "chat-a",
    });

    await expect(harness.hub.startEventLog({
      deviceUdid: UDID,
      bundleId: "com.other.app",
      chatSessionId: "chat-b",
    })).rejects.toMatchObject({ code: IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE });
    expect(() => harness.hub.stopEventLog({ chatSessionId: "chat-b" }))
      .toThrow(expect.objectContaining({ code: IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE }));

    // The owner still reads its own rows, so the guard refused the other chat
    // rather than killing the stream.
    harness.emitLogLine("2026-09-11 11:24:03.512 Df MyApp[1:2] still here");
    const page = await harness.hub.getEventLog({ deviceUdid: UDID });
    expect(page.rows.at(-1)?.message).toContain("still here");
    expect(harness.hub.stopEventLog({ chatSessionId: "chat-a" }).running).toBe(false);
  });

  it("guards the event log against the app-session owner, not only the device owner", async () => {
    // The common shape is a chat that ran `launch`: it holds an APP session and
    // no device session at all. A guard that only knew about device sessions
    // returned early for every caller in exactly the case the log is most used,
    // so a second chat could take the host's one log process.
    const harness = createHarness({ appSessionOwner: "chat-app" });

    await expect(harness.hub.startEventLog({
      deviceUdid: UDID,
      bundleId: "com.example.app",
      chatSessionId: "chat-other",
    })).rejects.toMatchObject({ code: IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE });
    expect(() => harness.hub.stopEventLog({ chatSessionId: "chat-other" }))
      .toThrow(expect.objectContaining({ code: IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE }));

    // The lane-scoped surface drives a simulator it does not own on purpose.
    await expect(harness.hub.startEventLog({
      deviceUdid: UDID,
      bundleId: "com.example.app",
      chatSessionId: "chat-other",
      force: true,
    })).resolves.toMatchObject({ running: true });
  });

  it("follows the new app when the log is restarted with another bundle id", async () => {
    // A start for the device that is already streaming was answered as a
    // no-op without comparing the predicate, so moving to another app kept the
    // old `subsystem BEGINSWITH` filter while reporting `running: true`. The
    // bundle id is required precisely so a log is scoped to one app, and this
    // path defeated that scoping with no signal.
    const harness = createHarness();
    await harness.hub.startEventLog({ deviceUdid: UDID, bundleId: "com.example.a" });
    harness.emitLogLine("2026-09-11 11:24:03.512 Df AppA[1:2] from the first app");
    await harness.hub.startEventLog({ deviceUdid: UDID, bundleId: "com.example.b" });

    expect(harness.logPredicates).toEqual([
      'subsystem BEGINSWITH "com.example.a"',
      'subsystem BEGINSWITH "com.example.b"',
    ]);
    // The first app's rows go with it. Left in the ring they render under the
    // second app's header, which is the same lie as mixing two devices.
    const page = await harness.hub.getEventLog({ deviceUdid: UDID });
    expect(page.rows.map((row) => row.message).join("\n")).not.toContain("from the first app");

    // The drawer re-mounting with the same app still must not restart it.
    harness.emitLogLine("2026-09-11 11:24:04.512 Df AppB[1:2] from the second app");
    await harness.hub.startEventLog({ deviceUdid: UDID, bundleId: "com.example.b" });
    expect(harness.logPredicates).toHaveLength(2);
    const kept = await harness.hub.getEventLog({ deviceUdid: UDID });
    expect(kept.rows.map((row) => row.message).join("\n")).toContain("from the second app");

    // Through a stop, too. `stop` keeps the device and the rows, so keying the
    // clear on the session alone let the second app's rows survive into a
    // third app — and closing the tools column stops the log, which makes this
    // the ordinary path, not a corner.
    harness.hub.stopEventLog();
    await harness.hub.startEventLog({ deviceUdid: UDID, bundleId: "com.example.c" });
    const afterStop = await harness.hub.getEventLog({ deviceUdid: UDID });
    expect(afterStop.rows.map((row) => row.message).join("\n")).not.toContain("from the second app");
  });

  it("does not let a proof capture eat the drawer's dropped-row count", async () => {
    // `read` resets the counter, and the drawer's poll is the reader that
    // shows the gap. A proof capture that consumed it left the next page
    // reporting no gap for rows the reader never saw.
    const harness = createHarness();
    await harness.hub.startEventLog({ deviceUdid: UDID, bundleId: "com.example.app" });
    // The ring holds 500, so this overruns it and leaves a real gap to report.
    for (let index = 0; index < 520; index += 1) {
      harness.emitLogLine(`2026-09-11 11:24:03.512 Df MyApp[1:2] row ${index}`);
    }

    await harness.hub.captureProofBundle({ deviceUdid: UDID });

    // The gap is the 20 rows the ring pushed out. A count near zero means the
    // proof consumed it and the drawer is about to hide a gap it never saw.
    // `toBeGreaterThan(0)` is not enough: the proof writes its own `ade` rows
    // into a full ring, which drops a row or two and puts the count back above
    // zero either way.
    const page = await harness.hub.getEventLog({ deviceUdid: UDID });
    expect(page.dropped).toBeGreaterThanOrEqual(20);
  });

  it("leaves a simulator running when another chat runs an app on it", async () => {
    // The two sessions can name the same simulator and belong to different
    // chats. A chat that goes away releases its own claim; shutting the device
    // down would hand the app-session chat a dead device and a session that
    // still says it is running.
    const harness = createHarness({
      appSessionOwner: "chat-app",
      appSessionDeviceUdid: UDID,
    });
    await harness.hub.openDevice({ chatSessionId: "chat-device" });

    const released = await harness.hub.releaseDeviceIfOwnedBy("chat-device");

    expect(released.released).toBe(true);
    expect(released.shutdown).toBe(false);
    expect(harness.runArgs()).not.toContainEqual(["simctl", "shutdown", UDID]);
  });

  it("still honours an explicit forced shutdown while another chat runs an app", async () => {
    // The guard protects implicit cleanup, not the human. `close-device
    // --force` says it closes a device another chat owns, and this release is
    // the only place in ADE that runs `simctl shutdown`, so an absolute guard
    // would leave a simulator no command could shut down.
    const harness = createHarness({
      appSessionOwner: "chat-app",
      appSessionDeviceUdid: UDID,
    });
    await harness.hub.openDevice({ chatSessionId: "chat-device" });

    const closed = await harness.hub.closeDevice({
      chatSessionId: "chat-device",
      shutdownDevice: true,
      force: true,
    });

    expect(closed.shutdown).toBe(true);
    expect(harness.runArgs()).toContainEqual(["simctl", "shutdown", UDID]);
  });

  it("still shuts down its own simulator when the app session is elsewhere", async () => {
    // The guard above must not keep every simulator alive. An app session on
    // ANOTHER device is no reason to leave this one booted.
    const harness = createHarness({
      appSessionOwner: "chat-app",
      appSessionDeviceUdid: OTHER_UDID,
    });
    await harness.hub.openDevice({ chatSessionId: "chat-device" });

    const released = await harness.hub.releaseDeviceIfOwnedBy("chat-device");

    expect(released.shutdown).toBe(true);
    expect(harness.runArgs()).toContainEqual(["simctl", "shutdown", UDID]);
  });

  it("leaves another device's rows out of a proof bundle", async () => {
    // The log follows one device and a proof can name another. Rows from a
    // device the screenshot did not come from are not evidence for it.
    const harness = createHarness({ otherDevices: [otherDevice()] });
    await harness.hub.startEventLog({ deviceUdid: UDID, bundleId: "com.example.app" });
    harness.emitLogLine("2026-09-11 11:24:03.512 Df MyApp[1:2] hello");

    const bundle = await harness.hub.captureProofBundle({ deviceUdid: OTHER_UDID });

    expect(bundle.logPath).toBeNull();
    const metadata = harness.writes.find((write) => write.filePath === bundle.metadataPath);
    expect(JSON.parse(metadata?.contents ?? "{}").logOmittedReason).toContain(UDID);

    // The device the log does follow still gets its rows.
    const owned = await harness.hub.captureProofBundle({ deviceUdid: UDID });
    expect(owned.logPath).not.toBeNull();
  });

  it("guards uninstall against the app-session owner, not only the device owner", async () => {
    // The common shape: a chat ran `launch`, so it holds an APP session and no
    // device session at all. A guard that only knew about device sessions
    // protected nothing in exactly that case, and an uninstall is the one
    // device tool that cannot be undone.
    const harness = createHarness({ appSessionOwner: "chat-app" });

    await expect(harness.hub.uninstallApp({ bundleId: "com.example.app", chatSessionId: "chat-other" }))
      .rejects.toMatchObject({ code: IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE });
    // An anonymous caller is not the owner either.
    await expect(harness.hub.uninstallApp({ bundleId: "com.example.app" }))
      .rejects.toMatchObject({ code: IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE });
    expect(harness.runs.some((call) => call.args.includes("uninstall"))).toBe(false);

    // The owner itself, and a caller that insists, both get through.
    await harness.hub.uninstallApp({ bundleId: "com.example.app", chatSessionId: "chat-app" });
    await harness.hub.uninstallApp({ bundleId: "com.example.app", force: true });
    expect(harness.runs.filter((call) => call.args.includes("uninstall"))).toHaveLength(2);
  });

  it("lets an unowned simulator be uninstalled by anyone", async () => {
    // No app session and no device session means nobody has staked a claim, so
    // the cooperative rule has nothing to protect.
    const harness = createHarness();
    await harness.hub.uninstallApp({ bundleId: "com.example.app" });
    expect(harness.runs.some((call) => call.args.includes("uninstall"))).toBe(true);
  });

  it("answers an event-log read for a device the log is not following with no rows", async () => {
    // Switching the drawer to another device used to keep appending the old
    // device's lines under the new device's header. Reading the page also
    // consumes the dropped-row counter, so the check has to happen first or the
    // legitimate reader silently loses a gap it was owed.
    const harness = createHarness();
    await harness.hub.startEventLog({ deviceUdid: "DEVICE-A", bundleId: "com.example.app" });
    harness.emitLogLine("2026-09-11 11:24:03.512 Df MyApp[1:2] hello");

    const other = await harness.hub.getEventLog({ deviceUdid: "DEVICE-B" });
    expect(other.rows).toEqual([]);
    expect(other.deviceUdid).toBe("DEVICE-A");
    expect(other.dropped).toBe(0);

    // The device it IS following still gets its rows, and its drop count.
    const owned = await harness.hub.getEventLog({ deviceUdid: "DEVICE-A" });
    expect(owned.rows).toHaveLength(1);
    expect(owned.rows[0]?.message).toContain("hello");
  });

  it("lets a second chat take the device over", async () => {
    const harness = createHarness();
    await harness.hub.openDevice({ chatSessionId: "chat-a" });

    const taken = await harness.hub.openDevice({ chatSessionId: "chat-b", force: true });
    expect(taken.chatSessionId).toBe("chat-b");

    const closed = await harness.hub.closeDevice({ chatSessionId: "chat-c", ignoreOwnership: true });
    expect(closed.released).toBe(true);
  });

  it("releases only the session the departing chat owns", async () => {
    const harness = createHarness();
    await harness.hub.openDevice({ chatSessionId: "chat-a" });

    expect(await harness.hub.releaseDeviceIfOwnedBy("chat-b")).toEqual({
      released: false,
      shutdown: false,
      previousDeviceSession: null,
    });
    expect(harness.hub.getDeviceSession()?.chatSessionId).toBe("chat-a");

    const released = await harness.hub.releaseDeviceIfOwnedBy("chat-a");
    expect(released.released).toBe(true);
    expect(harness.hub.getDeviceSession()).toBeNull();
  });
});

/* ------------------------------------------------------------------------- *
 * Device tools
 * ------------------------------------------------------------------------- */

describe("iosDeviceHub device tools", () => {
  async function adeCommands(harness: Harness): Promise<Array<string | null | undefined>> {
    const page = await harness.hub.getEventLog({});
    return page.rows.filter((row) => row.source === "ade").map((row) => row.command);
  }

  it("logs a reproducible ade command for every device tool", async () => {
    const harness = createHarness();
    const hub = harness.hub;

    await hub.setAppearance({ appearance: "dark" });
    await hub.setContentSize({ contentSize: "extra-large" });
    await hub.setAccessibilityOption({ option: "reduce-motion", enabled: true });
    await hub.setLocation({ latitude: 37.7749, longitude: -122.4194 });
    await hub.clearLocation({});
    await hub.setPermission({ bundleId: "com.ade.ios", service: "photos", action: "grant" });
    await hub.sendPushNotification({ bundleId: "com.ade.ios", title: "Hi", body: "There" });
    await hub.openUrl({ url: "https://ade.dev/lane/1" });
    await hub.terminateApp({ bundleId: "com.ade.ios" });
    await hub.uninstallApp({ bundleId: "com.ade.ios" });
    await hub.setStatusBar({ time: "9:41" });
    await hub.clearStatusBar({});

    expect(await adeCommands(harness)).toEqual([
      `ade ios-sim appearance dark --device ${UDID}`,
      `ade ios-sim content-size extra-large --device ${UDID}`,
      `ade ios-sim accessibility reduce-motion on --device ${UDID}`,
      `ade ios-sim location 37.7749 -122.4194 --device ${UDID}`,
      `ade ios-sim location --clear --device ${UDID}`,
      `ade ios-sim permission grant photos --bundle-id com.ade.ios --device ${UDID}`,
      `ade ios-sim push --bundle-id com.ade.ios --device ${UDID}`,
      `ade ios-sim open-url https://ade.dev/lane/1 --device ${UDID}`,
      `ade ios-sim terminate --bundle-id com.ade.ios --device ${UDID}`,
      `ade ios-sim uninstall --bundle-id com.ade.ios --device ${UDID}`,
      `ade ios-sim status-bar --device ${UDID}`,
      `ade ios-sim status-bar --clear --device ${UDID}`,
    ]);
  });

  it("leaves the bundle id out of the row and the command for a permission reset", async () => {
    // A reset takes the whole service back to its default and has no bundle id,
    // so the row used to read "reset photos for undefined." and offer a command
    // carrying `--bundle-id undefined`.
    const harness = createHarness();
    await harness.hub.setPermission({ service: "photos", action: "reset" });

    const page = await harness.hub.getEventLog({});
    const row = page.rows.find((entry) => entry.source === "ade");
    expect(row?.message).toBe("reset photos.");
    expect(row?.command).toBe(`ade ios-sim permission reset photos --device ${UDID}`);
  });

  it("marks the ade rows as actions so the drawer can tell them apart", async () => {
    const harness = createHarness();
    await harness.hub.setAppearance({ appearance: "light" });

    const page = await harness.hub.getEventLog({});
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      source: "ade",
      level: "action",
      message: "Set appearance to light.",
    });
  });

  it("re-reads the settings after a write so the caller sees the device, not the request", async () => {
    const harness = createHarness();
    const settings = await harness.hub.setAppearance({ appearance: "dark" });

    const lines = harness.runArgs().map((args) => args.join(" "));
    const wroteAt = lines.indexOf(`simctl ui ${UDID} appearance dark`);
    const readAt = lines.indexOf(`simctl ui ${UDID} appearance`);
    expect(wroteAt).toBeGreaterThanOrEqual(0);
    expect(readAt).toBeGreaterThan(wroteAt);
    expect(settings.deviceUdid).toBe(UDID);
    expect(harness.events.some((event) => event.type === "device-settings-changed")).toBe(true);
  });

  it("remembers the location it set, because simctl cannot read one back", async () => {
    const harness = createHarness();
    await harness.hub.setLocation({ latitude: 37.7749, longitude: -122.4194 });

    expect(harness.runArgs()).toContainEqual(["simctl", "location", UDID, "set", "37.7749,-122.4194"]);
    const afterSet = await harness.hub.getDeviceSettings({});
    expect(afterSet.location).toEqual({ latitude: 37.7749, longitude: -122.4194 });

    await harness.hub.clearLocation({});
    const afterClear = await harness.hub.getDeviceSettings({});
    expect(afterClear.location).toBeNull();
  });

  it("reports the status bar override it applied and the one it cleared", async () => {
    const harness = createHarness();
    await harness.hub.setStatusBar({ time: "9:41" });
    expect((await harness.hub.getDeviceSettings({})).statusBarOverridden).toBe(true);

    await harness.hub.clearStatusBar({});
    expect((await harness.hub.getDeviceSettings({})).statusBarOverridden).toBe(false);
  });
});

/* ------------------------------------------------------------------------- *
 * Semantic actions
 * ------------------------------------------------------------------------- */

describe("iosDeviceHub semantic actions", () => {
  it("taps the centre of the matched element and reports the match count", async () => {
    const harness = createHarness({
      elements: [CONTINUE_BUTTON, makeElement({ role: "button", label: "Cancel" })],
    });
    const result = await harness.hub.tapElement({ query: { label: "Continue" } });

    expect(result.ok).toBe(true);
    expect(result.matchCount).toBe(1);
    expect(harness.interactions).toEqual([{ kind: "tap", detail: "60,40" }]);

    const page = await harness.hub.getEventLog({});
    expect(page.rows.at(-1)?.command).toBe('ade ios-sim tap-element label "Continue"');
  });

  it("counts every match so an ambiguous query is visible", async () => {
    const harness = createHarness({
      elements: [CONTINUE_BUTTON, makeElement({ role: "button", label: "Continue" })],
    });
    const result = await harness.hub.tapElement({ query: { label: "Continue" } });
    expect(result.matchCount).toBe(2);
  });

  it("taps nothing when the query matches nothing, and says why", async () => {
    const harness = createHarness();
    const result = await harness.hub.tapElement({ query: { label: "Sign out" } });

    expect(result.ok).toBe(false);
    expect(result.matchCount).toBe(0);
    expect(result.message).toContain("Sign out");
    // A tap on a guess is the failure mode the semantic layer exists to remove.
    expect(harness.interactions).toEqual([]);
  });

  it("focuses the field before it types", async () => {
    const harness = createHarness({
      elements: [makeElement({ role: "textField", label: "Email" })],
    });
    const result = await harness.hub.fillElement({
      query: { label: "Email" },
      text: "ada@ade.dev",
    });

    expect(result.ok).toBe(true);
    expect(harness.interactions).toEqual([
      { kind: "tap", detail: "60,40" },
      { kind: "type", detail: "ada@ade.dev" },
    ]);
  });

  it("skips the focus tap when the caller says the field already has focus", async () => {
    const harness = createHarness({
      elements: [makeElement({ role: "textField", label: "Email" })],
    });
    await harness.hub.fillElement({
      query: { label: "Email" },
      text: "ada@ade.dev",
      focusFirst: false,
    });

    expect(harness.interactions).toEqual([{ kind: "type", detail: "ada@ade.dev" }]);
  });

  it("returns as soon as the element appears", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const harness = createHarness({ now: () => new Date() });
    harness.queueSnapshots([makeSnapshot([]), makeSnapshot([CONTINUE_BUTTON])]);

    const pending = harness.hub.waitForElement({ query: { label: "Continue" }, timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(400);
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(result.match?.element.label).toBe("Continue");
    // Every poll is a fresh snapshot, so the wait ends on the poll that sees it.
    expect(result.waitedMs).toBeGreaterThanOrEqual(350);
    expect(result.waitedMs).toBeLessThan(5_000);
  });

  it("gives up with a reason when the element never appears", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const harness = createHarness({ elements: [], now: () => new Date() });

    const pending = harness.hub.waitForElement({ query: { label: "Continue" }, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_500);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.match).toBeNull();
    expect(result.waitedMs).toBeGreaterThanOrEqual(1_000);
    expect(result.message).toContain("Continue");
  });

  it("is satisfied when the element disappears", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const harness = createHarness({ now: () => new Date() });
    harness.queueSnapshots([makeSnapshot([CONTINUE_BUTTON]), makeSnapshot([])]);

    const pending = harness.hub.waitForElement({
      query: { label: "Continue" },
      state: "gone",
      timeoutMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(400);
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(result.match).toBeNull();
  });
});

/* ------------------------------------------------------------------------- *
 * Proof
 * ------------------------------------------------------------------------- */

describe("iosDeviceHub proof bundle", () => {
  it("writes the metadata, the elements and the log under the build root", async () => {
    const harness = createHarness();
    await harness.hub.openDevice({ chatSessionId: "chat-a" });

    const bundle = await harness.hub.captureProofBundle({
      laneId: "lane-1",
      caption: "Continue is on screen after the tap",
    });

    const proofRoot = path.join(BUILD_ROOT, ".ade", "proof");
    expect(bundle.dir.startsWith(`${proofRoot}${path.sep}ios-sim-`)).toBe(true);
    expect(harness.mkdirs).toEqual([bundle.dir]);
    expect(bundle.screenshotPath).toBe(SCREENSHOT.filePath);
    expect(bundle.metadataPath).toBe(path.join(bundle.dir, "metadata.json"));
    expect(bundle.elementsPath).toBe(path.join(bundle.dir, "elements.json"));
    expect(bundle.logPath).toBe(path.join(bundle.dir, "log.json"));
    const { elementsPath, logPath } = bundle;
    if (!elementsPath || !logPath) throw new Error("The bundle wrote no elements or log file.");

    const written = new Map(harness.writes.map((write) => [write.filePath, write.contents]));
    expect([...written.keys()]).toEqual([elementsPath, logPath, bundle.metadataPath]);

    // The first questions a reviewer asks are which simulator, which build root
    // and what the agent had just done. The bundle answers them next to the PNG.
    const metadata = JSON.parse(written.get(bundle.metadataPath) ?? "{}") as Record<string, unknown>;
    expect(metadata).toMatchObject({
      deviceUdid: UDID,
      deviceName: "iPhone 17 Pro",
      buildRoot: BUILD_ROOT,
      laneId: "lane-1",
      caption: "Continue is on screen after the tap",
      capturedAt: SCREENSHOT.capturedAt,
    });

    const elements = JSON.parse(written.get(elementsPath) ?? "{}") as {
      elements: Array<{ ref: string; label: string | null }>;
    };
    expect(elements.elements[0]?.label).toBe("Continue");
    expect(elements.elements[0]?.ref).toMatch(/^label:[0-9a-f]{12}$/);

    const rows = JSON.parse(written.get(logPath) ?? "[]") as Array<{ command: string | null }>;
    expect(rows[0]?.command).toBe(`ade ios-sim open-device --device ${UDID}`);
  });

  it("writes into a caller-named directory relative to the build root", async () => {
    const harness = createHarness();
    const bundle = await harness.hub.captureProofBundle({ outDir: "proof/tap-continue" });

    expect(bundle.dir).toBe(path.resolve(BUILD_ROOT, "proof/tap-continue"));
    // No log rows yet, so there is nothing to write and no empty file to read.
    expect(bundle.logPath).toBeNull();
  });

  it("skips the element dump when the caller does not want one", async () => {
    const harness = createHarness();
    const bundle = await harness.hub.captureProofBundle({ includeElements: false });

    expect(bundle.elementsPath).toBeNull();
    expect(harness.writes.map((write) => write.filePath)).toEqual([bundle.metadataPath]);
  });
});

describe("captureProofBundle containment", () => {
  const roots: string[] = [];
  const make = (prefix: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    roots.push(dir);
    return dir;
  };

  afterAll(() => {
    for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A hub on the real filesystem.
   *
   * The containment rule is about real paths, so these cases cannot use the
   * injected `fileSystem` the rest of the file uses: a fake writer cannot tell
   * a symlink from a directory.
   */
  const hubFor = (buildRoot: string) => createIosDeviceHub({
    run: async () => ({ stdout: "", stderr: "" }),
    spawnLogStream: (): IosEventLogProcess => {
      throw new Error("No containment test starts the log stream.");
    },
    openSimulatorApp: () => {},
    resolveDevice: async () => { throw new Error("unused"); },
    resolveControlDeviceUdid: async () => "UDID",
    getScreenSnapshot: async () => { throw new Error("unused"); },
    screenshot: async (args) => ({
      deviceUdid: "UDID",
      dataUrl: "",
      filePath: String(args.outPath),
      width: 1,
      height: 1,
      capturedAt: "2026-01-01T00:00:00.000Z",
    }),
    tap: async () => {},
    typeText: async () => {},
    resolveBuildRoot: async () => buildRoot,
    getAppSessionOwner: () => null,
    getAppSessionDeviceUdid: () => null,
    emit: () => {},
    logger: { info: () => {}, debug: () => {} },
  });

  it("writes into the build root by default", async () => {
    const root = make("ade-real-");
    const bundle = await hubFor(root).captureProofBundle({ includeElements: false, logRowLimit: 0 });
    expect(bundle.dir.startsWith(root)).toBe(true);
  });

  it("accepts a build root reached through a symlink", async () => {
    // The macOS case: the caller names /tmp/... and the real path is
    // /private/tmp/.... Resolving only one side would reject every path.
    const real = make("ade-real-");
    const link = path.join(make("ade-link-"), "root");
    fs.symlinkSync(real, link);
    const bundle = await hubFor(link).captureProofBundle({ includeElements: false, logRowLimit: 0 });
    expect(bundle.dir.startsWith(link)).toBe(true);
  });

  it("refuses a relative path that climbs out of the build root", async () => {
    const root = make("ade-real-");
    await expect(hubFor(root).captureProofBundle({ outDir: "../escape" }))
      .rejects.toThrow(/IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT/);
  });

  it("refuses an absolute path outside the build root", async () => {
    const root = make("ade-real-");
    const outside = make("ade-out-");
    await expect(hubFor(root).captureProofBundle({ outDir: outside }))
      .rejects.toThrow(/IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT/);
  });

  it("refuses a symlink inside the build root that points outside it", async () => {
    // The case the lexical check cannot see: every segment is under the root,
    // and the write still lands wherever the link points.
    const root = make("ade-real-");
    const outside = make("ade-out-");
    fs.symlinkSync(outside, path.join(root, "escape"));
    await expect(hubFor(root).captureProofBundle({ outDir: "escape/bundle" }))
      .rejects.toThrow(/IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT/);
  });
});

/* ------------------------------------------------------------------------- *
 * iosDeviceTools: the simctl calls behind every device tool.
 *
 * Merged here because the hub is this module's only consumer. One feature, one
 * suite: a failure that spans the hub and its helper now reads in one place.
 * ------------------------------------------------------------------------- */

type ToolsRecordedCall = { file: string; args: string[]; timeoutMs: number | undefined };

type ToolsHarness = {
  tools: ReturnType<typeof createIosDeviceTools>;
  calls: ToolsRecordedCall[];
  tempWrites: string[];
  removed: string[];
};

const TOOLS_DEVICE_UDID = "1B2C3D4E-0000-1111-2222-333344445555";

/**
 * `respond` answers one call by the simctl subcommand line, for example
 * "ui appearance" or "spawn defaults read ReduceMotionEnabled". A missing key
 * resolves to an empty stdout.
 */
function toolsCreateHarness(options: {
  respond?: (args: string[]) => { stdout?: string; stderr?: string } | Error | undefined;
  writeTempFile?: IosDeviceToolsDeps["writeTempFile"];
  removeFile?: IosDeviceToolsDeps["removeFile"];
} = {}): ToolsHarness {
  const calls: ToolsRecordedCall[] = [];
  const tempWrites: string[] = [];
  const removed: string[] = [];

  const tools = createIosDeviceTools({
    run: async (file, args, runOptions) => {
      calls.push({ file, args, timeoutMs: runOptions?.timeoutMs });
      const reply = options.respond?.(args);
      if (reply instanceof Error) {
        throw reply;
      }
      return { stdout: reply?.stdout ?? "", stderr: reply?.stderr ?? "" };
    },
    writeTempFile:
      options.writeTempFile ??
      (async (contents, extension) => {
        tempWrites.push(contents);
        return `/tmp/push-payload${extension}`;
      }),
    removeFile:
      options.removeFile ??
      (async (filePath) => {
        removed.push(filePath);
      }),
    now: () => new Date("2026-09-11T10:00:00.000Z"),
  });

  return { tools, calls, tempWrites, removed };
}

function toolsLastArgs(harness: ToolsHarness): string[] {
  const call = harness.calls[harness.calls.length - 1];
  if (!call) {
    throw new Error("No command ran.");
  }
  return call.args;
}

describe("createIosDeviceTools setters", () => {
  it("sets the appearance through simctl ui", async () => {
    const harness = toolsCreateHarness();
    await harness.tools.setAppearance(TOOLS_DEVICE_UDID, "dark");
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.file).toBe("xcrun");
    expect(harness.calls[0]?.args).toEqual(["simctl", "ui", TOOLS_DEVICE_UDID, "appearance", "dark"]);
    expect(harness.calls[0]?.timeoutMs).toBe(20_000);
  });

  it("sets the content size through simctl ui", async () => {
    const harness = toolsCreateHarness();
    await harness.tools.setContentSize(TOOLS_DEVICE_UDID, "accessibility-extra-large");
    expect(toolsLastArgs(harness)).toEqual(["simctl", "ui", TOOLS_DEVICE_UDID, "content_size", "accessibility-extra-large"]);
  });

  it("sets increase contrast through simctl ui, with no defaults write", async () => {
    const harness = toolsCreateHarness();
    await harness.tools.setAccessibilityOption(TOOLS_DEVICE_UDID, "increase-contrast", true);
    expect(harness.calls).toHaveLength(1);
    expect(toolsLastArgs(harness)).toEqual(["simctl", "ui", TOOLS_DEVICE_UDID, "increase_contrast", "enabled"]);
  });

  it("writes the preference and then posts the notification for reduce motion", async () => {
    const harness = toolsCreateHarness();
    await harness.tools.setAccessibilityOption(TOOLS_DEVICE_UDID, "reduce-motion", true);
    expect(harness.calls.map((call) => call.args)).toEqual([
      ["simctl", "spawn", TOOLS_DEVICE_UDID, "defaults", "write", "com.apple.Accessibility", "ReduceMotionEnabled", "-bool", "true"],
      ["simctl", "spawn", TOOLS_DEVICE_UDID, "notifyutil", "-p", "com.apple.Accessibility.ReduceMotionEnabledChanged"],
    ]);
  });

  it("writes false and notifies when a preference toggle goes off", async () => {
    const harness = toolsCreateHarness();
    await harness.tools.setAccessibilityOption(TOOLS_DEVICE_UDID, "voice-over", false);
    expect(harness.calls.map((call) => call.args)).toEqual([
      [
        "simctl",
        "spawn",
        TOOLS_DEVICE_UDID,
        "defaults",
        "write",
        "com.apple.Accessibility",
        "VoiceOverTouchEnabled",
        "-bool",
        "false",
      ],
      ["simctl", "spawn", TOOLS_DEVICE_UDID, "notifyutil", "-p", "com.apple.Accessibility.VoiceOverTouchEnabledChanged"],
    ]);
  });

  it("uses the documented key and notification for every preference toggle", () => {
    expect(IOS_ACCESSIBILITY_PREFERENCES).toEqual({
      "reduce-motion": {
        key: "ReduceMotionEnabled",
        notification: "com.apple.Accessibility.ReduceMotionEnabledChanged",
      },
      "reduce-transparency": {
        key: "ReduceTransparencyEnabled",
        notification: "com.apple.Accessibility.ReduceTransparencyEnabledChanged",
      },
      "bold-text": {
        key: "BoldTextEnabled",
        notification: "com.apple.Accessibility.BoldTextEnabledChanged",
      },
      "invert-colors": {
        key: "InvertColorsEnabled",
        notification: "com.apple.Accessibility.InvertColorsEnabledChanged",
      },
      grayscale: {
        key: "GrayscaleEnabled",
        notification: "com.apple.Accessibility.GrayscaleEnabledChanged",
      },
      "voice-over": {
        key: "VoiceOverTouchEnabled",
        notification: "com.apple.Accessibility.VoiceOverTouchEnabledChanged",
      },
    });
  });

  it("sets and clears the location", async () => {
    const harness = toolsCreateHarness();
    await harness.tools.setLocation(TOOLS_DEVICE_UDID, { latitude: 37.7749, longitude: -122.4194 });
    expect(toolsLastArgs(harness)).toEqual(["simctl", "location", TOOLS_DEVICE_UDID, "set", "37.7749,-122.4194"]);
    await harness.tools.clearLocation(TOOLS_DEVICE_UDID);
    expect(toolsLastArgs(harness)).toEqual(["simctl", "location", TOOLS_DEVICE_UDID, "clear"]);
  });

  it("passes a bundle id for grant and revoke, and none for reset", async () => {
    const harness = toolsCreateHarness();
    await harness.tools.setPermission({ deviceUdid: TOOLS_DEVICE_UDID, service: "photos", action: "grant", bundleId: "com.ade.ios" });
    expect(toolsLastArgs(harness)).toEqual(["simctl", "privacy", TOOLS_DEVICE_UDID, "grant", "photos", "com.ade.ios"]);

    await harness.tools.setPermission({
      deviceUdid: TOOLS_DEVICE_UDID,
      service: "microphone",
      action: "revoke",
      bundleId: "com.ade.ios",
    });
    expect(toolsLastArgs(harness)).toEqual(["simctl", "privacy", TOOLS_DEVICE_UDID, "revoke", "microphone", "com.ade.ios"]);

    await harness.tools.setPermission({ deviceUdid: TOOLS_DEVICE_UDID, service: "all", action: "reset", bundleId: "" });
    expect(toolsLastArgs(harness)).toEqual(["simctl", "privacy", TOOLS_DEVICE_UDID, "reset", "all"]);
  });

  it("opens a url, terminates an app, and uninstalls with a longer timeout", async () => {
    const harness = toolsCreateHarness();
    await harness.tools.openUrl(TOOLS_DEVICE_UDID, "https://ade.dev/lane/1");
    expect(toolsLastArgs(harness)).toEqual(["simctl", "openurl", TOOLS_DEVICE_UDID, "https://ade.dev/lane/1"]);

    await harness.tools.terminateApp(TOOLS_DEVICE_UDID, "com.ade.ios");
    expect(toolsLastArgs(harness)).toEqual(["simctl", "terminate", TOOLS_DEVICE_UDID, "com.ade.ios"]);

    await harness.tools.uninstallApp(TOOLS_DEVICE_UDID, "com.ade.ios");
    expect(toolsLastArgs(harness)).toEqual(["simctl", "uninstall", TOOLS_DEVICE_UDID, "com.ade.ios"]);
    expect(harness.calls[harness.calls.length - 1]?.timeoutMs).toBe(30_000);
  });

  it("builds the status bar override from the fields that are present", async () => {
    const harness = toolsCreateHarness();
    await harness.tools.setStatusBar({
      deviceUdid: TOOLS_DEVICE_UDID,
      time: "9:41",
      dataNetwork: "wifi",
      wifiBars: 3,
      cellularBars: 4,
      batteryState: "charging",
      batteryLevel: 88,
    });
    expect(toolsLastArgs(harness)).toEqual([
      "simctl",
      "status_bar",
      TOOLS_DEVICE_UDID,
      "override",
      "--time",
      "9:41",
      "--dataNetwork",
      "wifi",
      "--wifiBars",
      "3",
      "--cellularBars",
      "4",
      "--batteryState",
      "charging",
      "--batteryLevel",
      "88",
    ]);
  });

  it("omits the fields that are absent from a status bar override", async () => {
    const harness = toolsCreateHarness();
    await harness.tools.setStatusBar({ deviceUdid: TOOLS_DEVICE_UDID, batteryLevel: 0 });
    expect(toolsLastArgs(harness)).toEqual(["simctl", "status_bar", TOOLS_DEVICE_UDID, "override", "--batteryLevel", "0"]);
  });

  it("clears the status bar", async () => {
    const harness = toolsCreateHarness();
    await harness.tools.clearStatusBar(TOOLS_DEVICE_UDID);
    expect(toolsLastArgs(harness)).toEqual(["simctl", "status_bar", TOOLS_DEVICE_UDID, "clear"]);
  });
});

describe("readSettings", () => {
  function respondWithDefaults(args: string[]): { stdout: string } | Error | undefined {
    const line = args.join(" ");
    if (line.includes("ui") && line.endsWith("appearance")) {
      return { stdout: "dark\n" };
    }
    if (line.endsWith("content_size")) {
      return { stdout: "extra-large\n" };
    }
    if (line.endsWith("increase_contrast")) {
      return { stdout: "enabled\n" };
    }
    if (line.includes("defaults read")) {
      if (line.endsWith("ReduceMotionEnabled")) {
        return { stdout: "1\n" };
      }
      if (line.endsWith("BoldTextEnabled")) {
        return { stdout: "0\n" };
      }
      // Every other key was never written, which simctl reports as a failure.
      return new Error("The domain/default pair of (com.apple.Accessibility, X) does not exist");
    }
    return undefined;
  }

  it("maps every toggle, and reads an unset defaults key as false", async () => {
    const harness = toolsCreateHarness({ respond: respondWithDefaults });
    const settings = await harness.tools.readSettings(TOOLS_DEVICE_UDID);

    expect(settings).toEqual({
      deviceUdid: TOOLS_DEVICE_UDID,
      appearance: "dark",
      contentSize: "extra-large",
      accessibility: {
        "increase-contrast": true,
        "reduce-motion": true,
        "reduce-transparency": false,
        "bold-text": false,
        "invert-colors": false,
        grayscale: false,
        "voice-over": false,
      },
      location: null,
      statusBarOverridden: false,
      readAt: "2026-09-11T10:00:00.000Z",
    });
  });

  it("keeps an unsupported appearance and reads an unsupported contrast option as null", async () => {
    const harness = toolsCreateHarness({
      respond: (args) => {
        const line = args.join(" ");
        if (line.endsWith("appearance")) {
          return { stdout: "unsupported\n" };
        }
        if (line.endsWith("increase_contrast")) {
          return { stdout: "unsupported\n" };
        }
        if (line.endsWith("content_size")) {
          return { stdout: "large\n" };
        }
        return new Error("does not exist");
      },
    });
    const settings = await harness.tools.readSettings(TOOLS_DEVICE_UDID);
    expect(settings.appearance).toBe("unsupported");
    expect(settings.accessibility["increase-contrast"]).toBeNull();
    expect(settings.contentSize).toBe("large");
  });

  it("does not fail the read when a simctl ui call fails", async () => {
    const harness = toolsCreateHarness({
      respond: () => new Error("Invalid device: not booted"),
    });
    const settings = await harness.tools.readSettings(TOOLS_DEVICE_UDID);
    expect(settings.appearance).toBe("unknown");
    expect(settings.contentSize).toBe("unknown");
    expect(settings.accessibility["increase-contrast"]).toBeNull();
    expect(settings.accessibility["reduce-motion"]).toBe(false);
  });

  it("reads every toggle concurrently in one pass", async () => {
    const harness = toolsCreateHarness({ respond: respondWithDefaults });
    await harness.tools.readSettings(TOOLS_DEVICE_UDID);
    // appearance + content_size + increase_contrast + 6 defaults reads.
    expect(harness.calls).toHaveLength(9);
  });

  it("rejects an empty device udid", async () => {
    const harness = toolsCreateHarness();
    await expect(harness.tools.readSettings("  ")).rejects.toThrow("A device udid is required.");
    expect(harness.calls).toHaveLength(0);
  });
});

describe("validation", () => {
  it("rejects a content size that is not a known category", async () => {
    const harness = toolsCreateHarness();
    await expect(
      harness.tools.setContentSize(TOOLS_DEVICE_UDID, "enormous" as never),
    ).rejects.toThrow(/Unsupported content size "enormous"\. Allowed values: extra-small, /);
    expect(harness.calls).toHaveLength(0);
  });

  it("rejects an unknown privacy service", async () => {
    const harness = toolsCreateHarness();
    await expect(
      harness.tools.setPermission({
        deviceUdid: TOOLS_DEVICE_UDID,
        service: "bluetooth" as never,
        action: "grant",
        bundleId: "com.ade.ios",
      }),
    ).rejects.toThrow(/Unsupported privacy service "bluetooth"\. Allowed values: all, /);
    expect(harness.calls).toHaveLength(0);
  });

  it("rejects a grant with no bundle id", async () => {
    const harness = toolsCreateHarness();
    await expect(
      harness.tools.setPermission({ deviceUdid: TOOLS_DEVICE_UDID, service: "photos", action: "grant", bundleId: "" }),
    ).rejects.toThrow('A bundle id for a "grant" is required.');
    expect(harness.calls).toHaveLength(0);
  });

  it("rejects a revoke with no bundle id", async () => {
    const harness = toolsCreateHarness();
    await expect(
      harness.tools.setPermission({ deviceUdid: TOOLS_DEVICE_UDID, service: "photos", action: "revoke", bundleId: "   " }),
    ).rejects.toThrow('A bundle id for a "revoke" is required.');
  });

  it("rejects an unknown privacy action", async () => {
    const harness = toolsCreateHarness();
    await expect(
      harness.tools.setPermission({
        deviceUdid: TOOLS_DEVICE_UDID,
        service: "photos",
        action: "allow" as never,
        bundleId: "com.ade.ios",
      }),
    ).rejects.toThrow('Unsupported privacy action "allow". Allowed values: grant, revoke, reset.');
  });

  it("rejects a latitude outside -90 to 90", async () => {
    const harness = toolsCreateHarness();
    await expect(harness.tools.setLocation(TOOLS_DEVICE_UDID, { latitude: 91, longitude: 0 })).rejects.toThrow(
      'Invalid latitude "91". Allowed range: -90 to 90.',
    );
    expect(harness.calls).toHaveLength(0);
  });

  it("rejects a longitude outside -180 to 180", async () => {
    const harness = toolsCreateHarness();
    await expect(harness.tools.setLocation(TOOLS_DEVICE_UDID, { latitude: 0, longitude: -181 })).rejects.toThrow(
      'Invalid longitude "-181". Allowed range: -180 to 180.',
    );
  });

  it("rejects a non-finite coordinate", async () => {
    const harness = toolsCreateHarness();
    await expect(harness.tools.setLocation(TOOLS_DEVICE_UDID, { latitude: Number.NaN, longitude: 0 })).rejects.toThrow(
      /Invalid latitude/,
    );
  });

  it("rejects an appearance that simctl does not know", async () => {
    const harness = toolsCreateHarness();
    await expect(harness.tools.setAppearance(TOOLS_DEVICE_UDID, "sepia" as never)).rejects.toThrow(
      'Unsupported appearance "sepia". Allowed values: light, dark.',
    );
  });

  it("rejects an empty bundle id for terminate and uninstall", async () => {
    const harness = toolsCreateHarness();
    await expect(harness.tools.terminateApp(TOOLS_DEVICE_UDID, "")).rejects.toThrow("A bundle id is required.");
    await expect(harness.tools.uninstallApp(TOOLS_DEVICE_UDID, "  ")).rejects.toThrow("A bundle id is required.");
    expect(harness.calls).toHaveLength(0);
  });

  it("rejects a url that does not parse", async () => {
    const harness = toolsCreateHarness();
    await expect(harness.tools.openUrl(TOOLS_DEVICE_UDID, "not a url")).rejects.toThrow(
      'Invalid url "not a url". Allowed values: an absolute url such as https://example.com.',
    );
    expect(harness.calls).toHaveLength(0);
  });

  it("rejects wifiBars outside 0 to 3", async () => {
    const harness = toolsCreateHarness();
    await expect(harness.tools.setStatusBar({ deviceUdid: TOOLS_DEVICE_UDID, wifiBars: 4 })).rejects.toThrow(
      'Invalid wifiBars "4". Allowed range: 0 to 3.',
    );
  });

  it("rejects cellularBars outside 0 to 4", async () => {
    const harness = toolsCreateHarness();
    await expect(harness.tools.setStatusBar({ deviceUdid: TOOLS_DEVICE_UDID, cellularBars: -1 })).rejects.toThrow(
      'Invalid cellularBars "-1". Allowed range: 0 to 4.',
    );
  });

  it("rejects a batteryLevel outside 0 to 100", async () => {
    const harness = toolsCreateHarness();
    await expect(harness.tools.setStatusBar({ deviceUdid: TOOLS_DEVICE_UDID, batteryLevel: 140 })).rejects.toThrow(
      'Invalid batteryLevel "140". Allowed range: 0 to 100.',
    );
    expect(harness.calls).toHaveLength(0);
  });

  it("rejects an unknown batteryState", async () => {
    const harness = toolsCreateHarness();
    await expect(
      harness.tools.setStatusBar({ deviceUdid: TOOLS_DEVICE_UDID, batteryState: "full" as never }),
    ).rejects.toThrow('Invalid batteryState "full". Allowed values: charging, charged, discharging.');
  });

  it("rejects a status bar override with no fields", async () => {
    const harness = toolsCreateHarness();
    await expect(harness.tools.setStatusBar({ deviceUdid: TOOLS_DEVICE_UDID })).rejects.toThrow(
      /A status bar override needs at least one field/,
    );
  });
});

describe("buildPushPayload", () => {
  it("builds an aps alert when no payload is given", () => {
    expect(buildPushPayload({ bundleId: "com.ade.ios", title: "Build done", body: "Lane 42 is green" })).toEqual({
      aps: { alert: { title: "Build done", body: "Lane 42 is green" }, sound: "default" },
      "Simulator Target Bundle": "com.ade.ios",
    });
  });

  it("fills aps.alert from the title and body when a payload has no aps", () => {
    expect(
      buildPushPayload({
        bundleId: "com.ade.ios",
        payload: { laneId: "42" },
        title: "Build done",
        body: "Lane 42 is green",
      }),
    ).toEqual({
      laneId: "42",
      aps: { alert: { title: "Build done", body: "Lane 42 is green" } },
      "Simulator Target Bundle": "com.ade.ios",
    });
  });

  it("keeps an aps that the payload already carries", () => {
    expect(
      buildPushPayload({
        bundleId: "com.ade.ios",
        payload: { aps: { alert: "Raw string alert", badge: 3 } },
        title: "Ignored",
      }),
    ).toEqual({
      aps: { alert: "Raw string alert", badge: 3 },
      "Simulator Target Bundle": "com.ade.ios",
    });
  });

  it("rejects a payload that is not a plain object", () => {
    expect(() => buildPushPayload({ bundleId: "com.ade.ios", payload: [] as never })).toThrow(
      "Invalid push payload. Allowed values: a plain JSON object.",
    );
    expect(() => buildPushPayload({ bundleId: "com.ade.ios", payload: "hi" as never })).toThrow(
      "Invalid push payload. Allowed values: a plain JSON object.",
    );
  });

  it("rejects a push with no payload, title, or body", () => {
    expect(() => buildPushPayload({ bundleId: "com.ade.ios" })).toThrow(
      "A push needs a payload, a title, or a body.",
    );
  });

  it("rejects an empty bundle id", () => {
    expect(() => buildPushPayload({ bundleId: "", title: "Hi" })).toThrow("A bundle id is required.");
  });
});

describe("sendPush", () => {
  it("writes the payload file, pushes it, and deletes it", async () => {
    const harness = toolsCreateHarness();
    await harness.tools.sendPush({ deviceUdid: TOOLS_DEVICE_UDID, bundleId: "com.ade.ios", title: "Hi", body: "There" });

    expect(toolsLastArgs(harness)).toEqual(["simctl", "push", TOOLS_DEVICE_UDID, "com.ade.ios", "/tmp/push-payload.json"]);
    expect(JSON.parse(harness.tempWrites[0] ?? "{}")).toEqual({
      aps: { alert: { title: "Hi", body: "There" }, sound: "default" },
      "Simulator Target Bundle": "com.ade.ios",
    });
    expect(harness.removed).toEqual(["/tmp/push-payload.json"]);
  });

  it("deletes the payload file when the push fails", async () => {
    const harness = toolsCreateHarness({
      respond: () => new Error("Failed to send push notification"),
    });
    await expect(
      harness.tools.sendPush({ deviceUdid: TOOLS_DEVICE_UDID, bundleId: "com.ade.ios", title: "Hi" }),
    ).rejects.toThrow("Failed to send push notification");
    expect(harness.removed).toEqual(["/tmp/push-payload.json"]);
  });

  it("writes no temp file when the payload is invalid", async () => {
    const writeTempFile = vi.fn(async () => "/tmp/unused.json");
    const harness = toolsCreateHarness({ writeTempFile });
    await expect(
      harness.tools.sendPush({ deviceUdid: TOOLS_DEVICE_UDID, bundleId: "com.ade.ios", payload: 5 as never }),
    ).rejects.toThrow("Invalid push payload. Allowed values: a plain JSON object.");
    expect(writeTempFile).not.toHaveBeenCalled();
    expect(harness.calls).toHaveLength(0);
  });
});

describe("getAppState", () => {
  const runningList = [
    "PID\tStatus\tLabel",
    "-\t0\tcom.apple.backboardd",
    "4821\t0\tUIKitApplication:com.ade.ios[0x8f3c][rb-legacy]",
    "-\t0\tUIKitApplication:com.example.other[0x1111][rb-legacy]",
  ].join("\n");

  it("reads the pid of a running app", async () => {
    const harness = toolsCreateHarness({ respond: () => ({ stdout: runningList }) });
    const state = await harness.tools.getAppState(TOOLS_DEVICE_UDID, "com.ade.ios");
    expect(toolsLastArgs(harness)).toEqual(["simctl", "spawn", TOOLS_DEVICE_UDID, "launchctl", "list"]);
    expect(state).toEqual({
      bundleId: "com.ade.ios",
      running: true,
      pid: 4821,
      checkedAt: "2026-09-11T10:00:00.000Z",
    });
  });

  it("reports a loaded but not running app as stopped", async () => {
    const harness = toolsCreateHarness({ respond: () => ({ stdout: runningList }) });
    const state = await harness.tools.getAppState(TOOLS_DEVICE_UDID, "com.example.other");
    expect(state.running).toBe(false);
    expect(state.pid).toBeNull();
  });

  it("reports an app that does not appear in the list as stopped", async () => {
    const harness = toolsCreateHarness({ respond: () => ({ stdout: runningList }) });
    const state = await harness.tools.getAppState(TOOLS_DEVICE_UDID, "com.missing.app");
    expect(state).toEqual({
      bundleId: "com.missing.app",
      running: false,
      pid: null,
      checkedAt: "2026-09-11T10:00:00.000Z",
    });
  });

  it("does not match a bundle id that is only a prefix of another", () => {
    expect(parseAppStateFromLaunchctlList(runningList, "com.ade")).toEqual({ running: false, pid: null });
  });

  it("reports a shut down device as stopped instead of failing", async () => {
    const harness = toolsCreateHarness({ respond: () => new Error("Unable to boot device") });
    const state = await harness.tools.getAppState(TOOLS_DEVICE_UDID, "com.ade.ios");
    expect(state.running).toBe(false);
    expect(state.pid).toBeNull();
  });
});


/* ------------------------------------------------------------------------- *
 * iosEventLog: the log stream reader and its ring.
 *
 * Merged here because the hub is this module's only consumer. One feature, one
 * suite: a failure that spans the hub and its helper now reads in one place.
 * ------------------------------------------------------------------------- */

const LOG_ROW_AT = "2026-09-11T11:24:03.512Z";

type LogFakeProcess = IosEventLogProcess & {
  deviceUdid: string;
  predicate: string | null;
  kills: number;
  emitLine: (line: string) => void;
  emitError: (error: Error) => void;
  emitExit: (code: number | null) => void;
};

function logCreateFakeProcess(deviceUdid: string, predicate: string | null): LogFakeProcess {
  const lineHandlers: ((line: string) => void)[] = [];
  const errorHandlers: ((error: Error) => void)[] = [];
  const exitHandlers: ((code: number | null) => void)[] = [];
  const fake: LogFakeProcess = {
    deviceUdid,
    predicate,
    kills: 0,
    onLine: (handler) => {
      lineHandlers.push(handler);
    },
    onError: (handler) => {
      errorHandlers.push(handler);
    },
    onExit: (handler) => {
      exitHandlers.push(handler);
    },
    kill: () => {
      fake.kills += 1;
    },
    emitLine: (line) => {
      for (const handler of lineHandlers) {
        handler(line);
      }
    },
    emitError: (error) => {
      for (const handler of errorHandlers) {
        handler(error);
      }
    },
    emitExit: (code) => {
      for (const handler of exitHandlers) {
        handler(code);
      }
    },
  };
  return fake;
}

function logCreateHarness(overrides: Partial<IosEventLogDeps> = {}) {
  const spawned: LogFakeProcess[] = [];
  let tick = 0;
  const deps: IosEventLogDeps = {
    spawnLogStream: (deviceUdid, predicate) => {
      const fake = logCreateFakeProcess(deviceUdid, predicate);
      spawned.push(fake);
      return fake;
    },
    now: () => {
      tick += 1;
      return new Date(Date.UTC(2026, 8, 11, 11, 0, 0) + tick * 1_000);
    },
    ...overrides,
  };
  const log = createIosEventLog(deps);
  const last = (): LogFakeProcess => {
    const process = spawned[spawned.length - 1];
    if (!process) {
      throw new Error("No log stream was spawned.");
    }
    return process;
  };
  return { log, spawned, last };
}

function logDeviceLine(index: number): string {
  return `2026-09-11 11:24:0${index % 10}.512 Df MyApp[4127:9f2a1] [com.acme.app:Core] line ${index}`;
}

describe("parseCompactLogLine", () => {
  it("reads a compact line that carries a subsystem and a category", () => {
    const row = parseCompactLogLine(
      "2026-09-11 11:24:03.512 Df MyApp[4127:9f2a1] [com.acme.app:Networking] request finished",
      7,
      LOG_ROW_AT,
    );
    expect(row).toEqual({
      id: 7,
      at: LOG_ROW_AT,
      source: "device",
      level: "debug",
      process: "MyApp",
      subsystem: "com.acme.app",
      category: "Networking",
      message: "request finished",
      command: null,
    });
  });

  it("reads a compact line that carries no subsystem", () => {
    const row = parseCompactLogLine(
      "2026-09-11 11:24:03.512 Er MyApp[4127:9f2a1] could not reach the host",
      2,
      LOG_ROW_AT,
    );
    expect(row.level).toBe("error");
    expect(row.process).toBe("MyApp");
    expect(row.subsystem).toBeNull();
    expect(row.category).toBeNull();
    expect(row.message).toBe("could not reach the host");
  });

  it("keeps a malformed line whole instead of dropping it", () => {
    const row = parseCompactLogLine("log: unable to open the stream", 3, LOG_ROW_AT);
    expect(row).toEqual({
      id: 3,
      at: LOG_ROW_AT,
      source: "device",
      level: "default",
      process: null,
      subsystem: null,
      category: null,
      message: "log: unable to open the stream",
      command: null,
    });
  });

  it("maps every type code to a level", () => {
    const cases: [string, IosSimulatorLogRow["level"]][] = [
      ["Df", "debug"],
      ["Dg", "debug"],
      ["I ", "info"],
      ["In", "info"],
      ["Er", "error"],
      ["Fa", "fault"],
      ["Zz", "default"],
    ];
    for (const [code, level] of cases) {
      const row = parseCompactLogLine(
        `2026-09-11 11:24:03.512 ${code} MyApp[4127:9f2a1] body`,
        1,
        LOG_ROW_AT,
      );
      expect({ code, level: row.level, process: row.process, message: row.message }).toEqual({
        code,
        level,
        process: "MyApp",
        message: "body",
      });
    }
  });

  it("reads a record that prints no type code at the default level", () => {
    const row = parseCompactLogLine("2026-09-11 11:24:03.512 MyApp[4127:9f2a1] body", 1, LOG_ROW_AT);
    expect(row.level).toBe("default");
    expect(row.process).toBe("MyApp");
    expect(row.message).toBe("body");
  });
});

describe("buildLogPredicate", () => {
  it("has no raw-predicate escape hatch", () => {
    // `log stream` reads the whole device, so an arbitrary predicate returns
    // every other app's rows and the system's besides. Nothing in the product
    // asked for that, and the option is gone rather than validated.
    const withExtra = buildLogPredicate({
      bundleId: "com.acme.app",
      predicate: 'process == "Other"',
    } as { bundleId?: string | null });
    expect(withExtra).toBe('subsystem BEGINSWITH "com.acme.app"');
  });

  it("filters on the subsystem for a bundle id", () => {
    expect(buildLogPredicate({ bundleId: "com.acme.app" })).toBe(
      'subsystem BEGINSWITH "com.acme.app"',
    );
  });

  it("returns null when there is nothing to filter by", () => {
    expect(buildLogPredicate({})).toBeNull();
    expect(buildLogPredicate({ bundleId: "  " })).toBeNull();
  });

  it("rejects a bundle id that can break out of the predicate string", () => {
    expect(() => buildLogPredicate({ bundleId: 'com.acme" OR process == "Evil' })).toThrow(
      /quote or a backslash/,
    );
    expect(() => buildLogPredicate({ bundleId: "com.acme\\app" })).toThrow(
      /quote or a backslash/,
    );
  });
});

describe("createIosEventLog", () => {
  it("passes the built predicate to the spawner and reports the device", () => {
    const { log, last } = logCreateHarness();
    log.start({ deviceUdid: "UDID-A", bundleId: "com.acme.app" });
    expect(last().deviceUdid).toBe("UDID-A");
    expect(last().predicate).toBe('subsystem BEGINSWITH "com.acme.app"');
    expect(log.isRunning()).toBe(true);
    expect(log.activeDeviceUdid()).toBe("UDID-A");
  });

  it("returns the newest rows in chronological order when no sinceId is given", () => {
    const { log, last } = logCreateHarness();
    log.start({ deviceUdid: "UDID-A" });
    for (let index = 1; index <= 5; index += 1) {
      last().emitLine(logDeviceLine(index));
    }
    const page = log.read({ limit: 3 });
    expect(page.rows.map((row) => row.message)).toEqual(["line 3", "line 4", "line 5"]);
    expect(page.cursor).toBe(5);
    expect(page.running).toBe(true);
    expect(page.deviceUdid).toBe("UDID-A");
    expect(page.lastError).toBeNull();
  });

  it("drops the oldest rows, reports the count once, then resets it", () => {
    const { log, last } = logCreateHarness({ capacity: 3 });
    log.start({ deviceUdid: "UDID-A" });
    for (let index = 1; index <= 5; index += 1) {
      last().emitLine(logDeviceLine(index));
    }
    const first = log.read({});
    expect(first.dropped).toBe(2);
    expect(first.rows.map((row) => row.message)).toEqual(["line 3", "line 4", "line 5"]);
    const second = log.read({});
    expect(second.dropped).toBe(0);
    expect(second.rows).toHaveLength(3);
  });

  it("keeps ids monotonic across a drop so sinceId stays correct", () => {
    const { log, last } = logCreateHarness({ capacity: 3 });
    log.start({ deviceUdid: "UDID-A" });
    for (let index = 1; index <= 5; index += 1) {
      last().emitLine(logDeviceLine(index));
    }
    expect(log.read({}).rows.map((row) => row.id)).toEqual([3, 4, 5]);
    const afterDrop = log.read({ sinceId: 2 });
    expect(afterDrop.rows.map((row) => row.id)).toEqual([3, 4, 5]);
    expect(afterDrop.cursor).toBe(5);
  });

  it("pages forward from a cursor and reports an empty page at the end", () => {
    const { log, last } = logCreateHarness();
    log.start({ deviceUdid: "UDID-A" });
    for (let index = 1; index <= 5; index += 1) {
      last().emitLine(logDeviceLine(index));
    }
    const first = log.read({ sinceId: 0, limit: 2 });
    expect(first.rows.map((row) => row.id)).toEqual([1, 2]);
    expect(first.cursor).toBe(2);
    const second = log.read({ sinceId: first.cursor, limit: 2 });
    expect(second.rows.map((row) => row.id)).toEqual([3, 4]);
    const third = log.read({ sinceId: second.cursor, limit: 2 });
    expect(third.rows.map((row) => row.id)).toEqual([5]);
    const fourth = log.read({ sinceId: third.cursor, limit: 2 });
    expect(fourth.rows).toEqual([]);
    expect(fourth.cursor).toBe(5);
  });

  it("ignores a start for the device that is already streaming", () => {
    const { log, spawned, last } = logCreateHarness();
    log.start({ deviceUdid: "UDID-A" });
    last().emitLine(logDeviceLine(1));
    log.start({ deviceUdid: "UDID-A" });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].kills).toBe(0);
    expect(log.read({}).rows).toHaveLength(1);
  });

  it("clears the buffer when a start names a different device", () => {
    const { log, spawned, last } = logCreateHarness();
    log.start({ deviceUdid: "UDID-A" });
    last().emitLine(logDeviceLine(1));
    last().emitLine(logDeviceLine(2));
    log.start({ deviceUdid: "UDID-B" });
    expect(spawned).toHaveLength(2);
    expect(spawned[0].kills).toBe(1);
    const page = log.read({});
    expect(page.rows).toEqual([]);
    expect(page.deviceUdid).toBe("UDID-B");
    last().emitLine(logDeviceLine(3));
    // The ids keep counting, so a sinceId taken before the switch cannot match
    // a row from the new device.
    expect(log.read({}).rows.map((row) => row.id)).toEqual([3]);
  });

  it("ignores a line that arrives after stop", () => {
    const { log, last } = logCreateHarness();
    log.start({ deviceUdid: "UDID-A" });
    const stream = last();
    stream.emitLine(logDeviceLine(1));
    log.stop();
    stream.emitLine(logDeviceLine(2));
    expect(stream.kills).toBe(1);
    expect(log.isRunning()).toBe(false);
    const page = log.read({});
    expect(page.rows.map((row) => row.message)).toEqual(["line 1"]);
    expect(page.running).toBe(false);
  });

  it("records an exit in lastError and leaves the rows readable", () => {
    const { log, last } = logCreateHarness();
    log.start({ deviceUdid: "UDID-A" });
    const stream = last();
    stream.emitLine(logDeviceLine(1));
    stream.emitExit(9);
    const page = log.read({});
    expect(page.lastError).toBe("log stream exited with status 9.");
    expect(page.running).toBe(false);
    expect(page.rows.map((row) => row.message)).toEqual(["line 1"]);
    expect(log.isRunning()).toBe(false);
  });

  it("names an exit that carries no status code", () => {
    const { log, last } = logCreateHarness();
    log.start({ deviceUdid: "UDID-A" });
    last().emitExit(null);
    expect(log.read({}).lastError).toBe("log stream exited without a status code.");
  });

  it("records a stream error and clears it on the next start", () => {
    const { log, last } = logCreateHarness();
    log.start({ deviceUdid: "UDID-A" });
    last().emitError(new Error("spawn simctl ENOENT"));
    expect(log.read({}).lastError).toBe("spawn simctl ENOENT");
    log.stop();
    log.start({ deviceUdid: "UDID-A" });
    expect(log.read({}).lastError).toBeNull();
  });

  it("interleaves ADE rows with device rows in id order", () => {
    const { log, last } = logCreateHarness();
    log.start({ deviceUdid: "UDID-A" });
    last().emitLine(logDeviceLine(1));
    const action = log.record({
      message: "Set the appearance to dark.",
      command: "xcrun simctl ui UDID-A appearance dark",
    });
    last().emitLine(logDeviceLine(2));
    const page = log.read({});
    expect(page.rows.map((row) => [row.id, row.source, row.level, row.message])).toEqual([
      [1, "device", "debug", "line 1"],
      [2, "ade", "action", "Set the appearance to dark."],
      [3, "device", "debug", "line 2"],
    ]);
    expect(action.command).toBe("xcrun simctl ui UDID-A appearance dark");
    expect(page.rows[0].command).toBeNull();
  });

  it("keeps an explicit level on an ADE row", () => {
    const { log } = logCreateHarness();
    const row = log.record({ message: "The launch failed.", level: "error" });
    expect(row.source).toBe("ade");
    expect(row.level).toBe("error");
    expect(row.command).toBeNull();
  });

  it("records ADE rows before any stream starts", () => {
    const { log } = logCreateHarness();
    log.record({ message: "Booting the device." });
    const page = log.read({});
    expect(page.deviceUdid).toBeNull();
    expect(page.running).toBe(false);
    expect(page.rows).toHaveLength(1);
  });

  it("caps the read limit", () => {
    const { log, last } = logCreateHarness({ capacity: 1_200 });
    log.start({ deviceUdid: "UDID-A" });
    for (let index = 0; index < 1_100; index += 1) {
      last().emitLine(logDeviceLine(index));
    }
    expect(log.read({ limit: 5_000 }).rows).toHaveLength(1_000);
    expect(log.read({}).rows).toHaveLength(200);
  });

  it("kills the process and drops every handler on dispose", () => {
    const { log, last } = logCreateHarness();
    log.start({ deviceUdid: "UDID-A" });
    const stream = last();
    stream.emitLine(logDeviceLine(1));
    log.dispose();
    stream.emitLine(logDeviceLine(2));
    stream.emitExit(1);
    expect(stream.kills).toBe(1);
    expect(log.isRunning()).toBe(false);
    const page = log.read({});
    expect(page.rows).toEqual([]);
    expect(page.deviceUdid).toBeNull();
    expect(page.lastError).toBeNull();
  });

  it("refuses to start without a device udid", () => {
    const { log, spawned } = logCreateHarness();
    expect(() => log.start({ deviceUdid: "  " })).toThrow(/device udid/);
    expect(spawned).toHaveLength(0);
  });

  it("refuses to start with a bundle id that can break the predicate", () => {
    const { log, spawned } = logCreateHarness();
    expect(() => log.start({ deviceUdid: "UDID-A", bundleId: 'a" OR 1 == "1' })).toThrow(
      /quote or a backslash/,
    );
    expect(spawned).toHaveLength(0);
  });
});


/* ------------------------------------------------------------------------- *
 * iosSemanticActions: element refs and query matching.
 *
 * Merged here because the hub is this module's only consumer. One feature, one
 * suite: a failure that spans the hub and its helper now reads in one place.
 * ------------------------------------------------------------------------- */

const ELEMENT_BLANK_FRAME = { x: 0, y: 0, width: 0, height: 0 };

function elemMakeElement(overrides: Partial<IosScreenElement> = {}): IosScreenElement {
  const frame = overrides.frame ?? { x: 10, y: 20, width: 100, height: 40 };
  return {
    id: "accessibility:0.1",
    source: "accessibility",
    layer: "accessibility",
    label: null,
    value: null,
    role: null,
    elementType: null,
    identifier: null,
    frame,
    pixelFrame: overrides.pixelFrame ?? {
      x: frame.x * 2,
      y: frame.y * 2,
      width: frame.width * 2,
      height: frame.height * 2,
    },
    componentId: null,
    sourceFile: null,
    sourceLine: null,
    metadata: {},
    ...overrides,
  };
}

describe("buildElementRef", () => {
  it("uses the identifier tier first", () => {
    const ref = buildElementRef(elemMakeElement({ identifier: "continue-button", componentId: "Button#3", label: "Continue" }));
    expect(ref).toMatch(/^id:[0-9a-f]{12}$/);
  });

  it("prefers the raw accessibilityIdentifier over the best-effort identifier", () => {
    const fromMetadata = buildElementRef(elemMakeElement({
      identifier: "Button#3",
      metadata: { accessibilityIdentifier: "continue-button" },
    }));
    const fromIdentifier = buildElementRef(elemMakeElement({ identifier: "continue-button" }));
    expect(fromMetadata).toBe(fromIdentifier);
  });

  it("falls back to the component tier", () => {
    const ref = buildElementRef(elemMakeElement({ componentId: "ContinueButton", label: "Continue" }));
    expect(ref).toMatch(/^component:[0-9a-f]{12}$/);
  });

  it("falls back to the label tier", () => {
    const ref = buildElementRef(elemMakeElement({ role: "button", label: "Continue" }));
    expect(ref).toMatch(/^label:[0-9a-f]{12}$/);
  });

  it("falls back to the positional tier when the element carries no identity", () => {
    const ref = buildElementRef(elemMakeElement({ id: "accessibility:0.3.1" }));
    expect(ref).toMatch(/^pos:[0-9a-f]{12}$/);
  });

  it("separates the label tier by role and value, not by label alone", () => {
    const button = buildElementRef(elemMakeElement({ role: "button", label: "Continue" }));
    const staticText = buildElementRef(elemMakeElement({ role: "staticText", label: "Continue" }));
    expect(button).not.toBe(staticText);
  });

  it("survives a re-render that only moves the positional id for tiers 1 to 3", () => {
    const identified = { identifier: "continue-button" };
    const component = { componentId: "ContinueButton" };
    const labelled = { role: "button", label: "Continue" };
    for (const identity of [identified, component, labelled]) {
      const before = buildElementRef(elemMakeElement({ id: "accessibility:0.3.1", ...identity }));
      const after = buildElementRef(elemMakeElement({ id: "accessibility:0.4.2.0", ...identity }));
      expect(after).toBe(before);
    }
  });

  it("does not survive a re-render at the positional tier", () => {
    const before = buildElementRef(elemMakeElement({ id: "accessibility:0.3.1" }));
    const after = buildElementRef(elemMakeElement({ id: "accessibility:0.4.2" }));
    expect(after).not.toBe(before);
  });
});

describe("matchElements fields", () => {
  it("matches a ref", () => {
    const target = elemMakeElement({ identifier: "continue-button" });
    const other = elemMakeElement({ identifier: "cancel-button" });
    const outcome = matchElements([other, target], { ref: buildElementRef(target) });
    expect(outcome.matches).toEqual([target]);
    expect(outcome.selected).toBe(target);
    expect(outcome.reason).toBeNull();
  });

  it("matches an identifier exactly and case-sensitively", () => {
    const target = elemMakeElement({ identifier: "continueButton" });
    expect(matchElements([target], { identifier: "continueButton" }).selected).toBe(target);
    expect(matchElements([target], { identifier: "continuebutton" }).selected).toBeNull();
    expect(matchElements([target], { identifier: "continue" }).selected).toBeNull();
  });

  it("matches an identifier that only the metadata carries", () => {
    const target = elemMakeElement({ metadata: { accessibilityIdentifier: "continue-button" } });
    expect(matchElements([target], { identifier: "continue-button" }).selected).toBe(target);
  });

  it("matches a label exactly, ignoring case and surrounding space", () => {
    const target = elemMakeElement({ label: "  Continue  " });
    expect(matchElements([target], { label: "continue" }).selected).toBe(target);
    expect(matchElements([target], { label: " CONTINUE " }).selected).toBe(target);
    expect(matchElements([target], { label: "Contin" }).selected).toBeNull();
  });

  it("matches text as a case-insensitive substring of the label or the value", () => {
    const labelled = elemMakeElement({ label: "Continue with Apple" });
    const valued = elemMakeElement({ id: "accessibility:0.2", value: "hello@example.com" });
    expect(matchElements([labelled, valued], { text: "with app" }).selected).toBe(labelled);
    expect(matchElements([labelled, valued], { text: "EXAMPLE.COM" }).selected).toBe(valued);
  });

  it("matches a role against role or elementType, ignoring case", () => {
    const byRole = elemMakeElement({ role: "Button", label: "One" });
    const byType = elemMakeElement({ id: "accessibility:0.2", elementType: "XCUIElementTypeButton", label: "Two" });
    expect(matchElements([byRole], { role: "button" }).selected).toBe(byRole);
    expect(matchElements([byType], { role: "xcuielementtypebutton" }).selected).toBe(byType);
  });

  it("combines fields with AND, not OR", () => {
    const button = elemMakeElement({ id: "a", label: "Continue", role: "button" });
    const text = elemMakeElement({ id: "b", label: "Continue", role: "staticText" });
    const outcome = matchElements([button, text], { label: "Continue", role: "button" });
    expect(outcome.matches).toEqual([button]);
  });

  it("reports an empty query instead of matching everything", () => {
    const outcome = matchElements([elemMakeElement({ label: "Continue" })], {});
    expect(outcome.matches).toEqual([]);
    expect(outcome.selected).toBeNull();
    expect(outcome.reason).toBe("The query is empty. Supply ref, identifier, label, text or role to name an element.");
  });

  it("ignores an index-only query", () => {
    expect(matchElements([elemMakeElement({ label: "Continue" })], { index: 0 }).selected).toBeNull();
  });
});

describe("matchElements ordering and selection", () => {
  it("puts an app-layer element before an accessibility-layer element", () => {
    const accessibility = elemMakeElement({ id: "accessibility:0.1", label: "Continue" });
    const app = elemMakeElement({
      id: "ade-inspector:7",
      source: "ade-inspector",
      layer: "app",
      label: "Continue",
      sourceFile: "Onboarding.swift",
      sourceLine: 42,
    });
    const outcome = matchElements([accessibility, app], { label: "Continue" });
    expect(outcome.matches).toEqual([app, accessibility]);
    expect(outcome.selected).toBe(app);
  });

  it("keeps the snapshot order inside one layer", () => {
    const first = elemMakeElement({ id: "accessibility:0.1", label: "Row" });
    const second = elemMakeElement({ id: "accessibility:0.2", label: "Row" });
    const third = elemMakeElement({ id: "accessibility:0.3", label: "Row" });
    expect(matchElements([first, second, third], { label: "Row" }).matches).toEqual([first, second, third]);
  });

  it("selects by index", () => {
    const first = elemMakeElement({ id: "accessibility:0.1", label: "Row" });
    const second = elemMakeElement({ id: "accessibility:0.2", label: "Row" });
    const outcome = matchElements([first, second], { label: "Row", index: 1 });
    expect(outcome.selected).toBe(second);
    expect(outcome.reason).toBeNull();
  });

  it("states the count when the index is out of range", () => {
    const elements = [
      elemMakeElement({ id: "accessibility:0.1", label: "Row" }),
      elemMakeElement({ id: "accessibility:0.2", label: "Row" }),
      elemMakeElement({ id: "accessibility:0.3", label: "Row" }),
    ];
    const outcome = matchElements(elements, { label: "Row", index: 5 });
    expect(outcome.matches).toHaveLength(3);
    expect(outcome.selected).toBeNull();
    expect(outcome.reason).toBe('3 elements match label "Row". Index 5 is out of range.');
  });

  it("rejects a negative index", () => {
    const outcome = matchElements([elemMakeElement({ label: "Row" })], { label: "Row", index: -1 });
    expect(outcome.selected).toBeNull();
    expect(outcome.reason).toBe('1 element matches label "Row". Index -1 is out of range.');
  });
});

describe("matchElements failure reasons", () => {
  it("names the closest near miss", () => {
    const elements = [
      elemMakeElement({ id: "accessibility:0.1", label: "Continue with Apple" }),
      elemMakeElement({ id: "accessibility:0.2", label: "Cancel" }),
    ];
    const outcome = matchElements(elements, { label: "Continue" });
    expect(outcome.reason).toBe('No element has the label "Continue". The closest is "Continue with Apple".');
  });

  it("omits the near miss when nothing is close", () => {
    const outcome = matchElements([elemMakeElement({ label: "Cancel" })], { label: "Continue" });
    expect(outcome.reason).toBe('No element has the label "Continue".');
  });

  it("describes every supplied field when more than one field is set", () => {
    const outcome = matchElements([elemMakeElement({ label: "Cancel", role: "button" })], { label: "Submit", role: "button" });
    expect(outcome.reason).toBe('No element matches label "Submit" and role "button".');
  });

  it("uses a field-specific sentence for identifier, text and role", () => {
    const elements = [elemMakeElement({ label: "Cancel", role: "button", identifier: "cancel" })];
    expect(matchElements(elements, { identifier: "submit" }).reason).toBe('No element has the identifier "submit".');
    expect(matchElements(elements, { text: "zzz" }).reason).toBe('No element contains the text "zzz".');
    expect(matchElements(elements, { role: "slider" }).reason).toBe('No element has the role "slider".');
  });

  it("gives no near miss for a ref, because a ref is a hash", () => {
    const outcome = matchElements([elemMakeElement({ label: "Continue" })], { ref: "id:000000000000" });
    expect(outcome.reason).toBe('No element matches the ref "id:000000000000".');
  });
});

describe("matchElements visibility", () => {
  it("never matches an element with a zero-size frame", () => {
    const hidden = elemMakeElement({ label: "Continue", frame: ELEMENT_BLANK_FRAME, pixelFrame: ELEMENT_BLANK_FRAME });
    const outcome = matchElements([hidden], { label: "Continue" });
    expect(outcome.matches).toEqual([]);
    expect(outcome.selected).toBeNull();
    expect(outcome.reason).toBe('No element has the label "Continue".');
  });

  it("never matches an element with a negative size", () => {
    const negative = { x: 10, y: 10, width: -4, height: 20 };
    const broken = elemMakeElement({ label: "Continue", frame: negative, pixelFrame: negative });
    expect(matchElements([broken], { label: "Continue" }).matches).toEqual([]);
  });

  it("does not offer an invisible element as a near miss", () => {
    const hidden = elemMakeElement({ label: "Continue with Apple", frame: ELEMENT_BLANK_FRAME, pixelFrame: ELEMENT_BLANK_FRAME });
    expect(matchElements([hidden], { label: "Continue" }).reason).toBe('No element has the label "Continue".');
  });
});

describe("elementTapPoint", () => {
  it("returns the centre of the device-point frame, not the pixel frame", () => {
    const element = elemMakeElement({
      frame: { x: 10, y: 20, width: 100, height: 40 },
      pixelFrame: { x: 30, y: 60, width: 300, height: 120 },
    });
    expect(elementTapPoint(element)).toEqual({ x: 60, y: 40 });
  });

  it("rounds the centre to whole points", () => {
    const element = elemMakeElement({ frame: { x: 10.4, y: 20.2, width: 15, height: 9 } });
    expect(elementTapPoint(element)).toEqual({ x: 18, y: 25 });
  });

  it("falls back to the pixel frame when the device-point frame is unusable", () => {
    const element = elemMakeElement({
      frame: ELEMENT_BLANK_FRAME,
      pixelFrame: { x: 0, y: 0, width: 100, height: 50 },
    });
    expect(elementTapPoint(element)).toEqual({ x: 50, y: 25 });
  });

  it("returns null when neither frame is usable", () => {
    expect(elementTapPoint(elemMakeElement({ frame: ELEMENT_BLANK_FRAME, pixelFrame: ELEMENT_BLANK_FRAME }))).toBeNull();
  });
});

describe("describeElement", () => {
  it("describes an element that only has a role", () => {
    const element = elemMakeElement({ role: "button", frame: ELEMENT_BLANK_FRAME, pixelFrame: ELEMENT_BLANK_FRAME });
    expect(describeElement(element)).toBe("[accessibility] button");
  });

  it("falls back to the element type and then to the word element", () => {
    const typed = elemMakeElement({ elementType: "XCUIElementTypeButton", frame: ELEMENT_BLANK_FRAME, pixelFrame: ELEMENT_BLANK_FRAME });
    expect(describeElement(typed)).toBe("[accessibility] XCUIElementTypeButton");
    const bare = elemMakeElement({ frame: ELEMENT_BLANK_FRAME, pixelFrame: ELEMENT_BLANK_FRAME });
    expect(describeElement(bare)).toBe("[accessibility] element");
  });

  it("includes the label, the identifier, the frame and the source", () => {
    const element = elemMakeElement({
      layer: "app",
      source: "ade-inspector",
      role: "button",
      label: "Continue",
      identifier: "continue-button",
      frame: { x: 10.4, y: 20.6, width: 100, height: 44 },
      sourceFile: "Onboarding.swift",
      sourceLine: 42,
    });
    expect(describeElement(element)).toBe('[app] button "Continue" #continue-button at 10,21 100x44 (Onboarding.swift:42)');
  });

  it("shows the value when the element has no label", () => {
    const element = elemMakeElement({ role: "textField", value: "hello@example.com", frame: ELEMENT_BLANK_FRAME, pixelFrame: ELEMENT_BLANK_FRAME });
    expect(describeElement(element)).toBe('[accessibility] textField value="hello@example.com"');
  });
});

describe("describeQuery", () => {
  it("names one field", () => {
    expect(describeQuery({ label: "Continue" })).toBe('label "Continue"');
  });

  it("joins two fields with and", () => {
    expect(describeQuery({ label: "Continue", role: "button" })).toBe('label "Continue" and role "button"');
  });

  it("joins three fields with commas and a final and", () => {
    expect(describeQuery({ identifier: "a", label: "b", role: "c" })).toBe('identifier "a", label "b" and role "c"');
  });

  it("leaves the index out", () => {
    expect(describeQuery({ label: "Continue", index: 2 })).toBe('label "Continue"');
  });

  it("reports an empty query", () => {
    expect(describeQuery({})).toBe("an empty query");
  });
});
