import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { IPC } from "./ipc";
import { createMacDesktopBridge } from "../preload/macDesktopPreload";

/**
 * The Mac Desktop IPC surface, checked as a contract rather than as three
 * independent files.
 *
 * A channel is only real when all three halves exist: the name, a handler in
 * the main process, and a preload method that can reach it. Drift between them
 * is silent — a missing handler surfaces as "No handler registered for …" in
 * production only, and a missing preload method type-checks fine because the
 * renderer never mentions it.
 *
 * The preload half is exercised, not read: `createMacDesktopBridge` is the
 * namespace, so this calls every method on it against fakes. The main-process
 * half is still a text check, because mounting Electron in a unit test is not
 * an option and a hand-maintained list of expected channels would be the fourth
 * thing to drift.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(path.join(here, relative), "utf8");

const registerIpc = read("../main/services/ipc/registerIpc.ts");

const macDesktopChannelKeys = Object.keys(IPC).filter((key) => key.startsWith("macDesktop"));

/** Every bridge method that routes, with the arguments its signature wants. */
const ROUTED_CALLS: Array<[string, unknown]> = [
  ["getStatus", { laneId: "lane-1" }],
  ["recheckPermissions", { restartDriver: true }],
  ["requestPermission", { which: "screenRecording" }],
  ["start", { laneId: "lane-1" }],
  ["stop", { laneId: "lane-1" }],
  ["listWindows", { laneId: "lane-1" }],
  ["open", { laneId: "lane-1", app: "Safari" }],
  ["claimWindow", { laneId: "lane-1", windowId: 1 }],
  ["releaseWindow", { laneId: "lane-1", windowId: 1 }],
  ["observe", { laneId: "lane-1" }],
  ["click", { laneId: "lane-1", x: 1, y: 2 }],
  ["type", { laneId: "lane-1", text: "hi" }],
  ["press", { laneId: "lane-1", key: "return" }],
  ["scroll", { laneId: "lane-1", direction: "down" }],
  ["drag", { laneId: "lane-1", from: { x: 1, y: 1 }, to: { x: 2, y: 2 } }],
  ["move", { laneId: "lane-1", x: 1, y: 2 }],
  ["wait", { laneId: "lane-1", text: "Done" }],
  ["screenshot", { laneId: "lane-1" }],
  ["startRecording", { laneId: "lane-1" }],
  ["stopRecording", { laneId: "lane-1" }],
  ["startStream", { laneId: "lane-1" }],
  ["stopStream", { laneId: "lane-1" }],
  ["getStreamStatus", { laneId: "lane-1" }],
  ["takeControl", { laneId: "lane-1", controllerId: "ade-window:1" }],
  ["returnControl", { laneId: "lane-1", controllerId: "ade-window:1" }],
  ["renewLease", { laneId: "lane-1", holderId: "ade-window:1" }],
  ["present", { laneId: "lane-1", destination: "main" }],
];

type Routed = { action: string; args: unknown; pin: unknown };

function harness() {
  const routed: Routed[] = [];
  const invoked: Array<{ channel: string; args: unknown }> = [];
  const resolveStreamUrl = vi.fn(async () => ({ url: null, forwarded: false, error: null }));
  const onEvent = vi.fn(() => () => {});
  const setEscapeHotkey = vi.fn(async () => ({ armed: true }));
  const onEscapeHotkey = vi.fn(() => () => {});
  const bridge = createMacDesktopBridge({
    callAction: async <T,>(
      pin: unknown,
      action: string,
      request: { args?: Record<string, unknown> },
      local: () => Promise<T>,
    ) => {
      routed.push({ action, args: request.args, pin });
      return local();
    },
    invoke: async (channel: string, args: unknown) => {
      invoked.push({ channel, args });
      return null;
    },
    resolveStreamUrl,
    setEscapeHotkey,
    onEscapeHotkey,
    onEvent,
  });
  return { bridge, routed, invoked, resolveStreamUrl, onEvent, setEscapeHotkey };
}

describe("Mac Desktop IPC contract", () => {
  it("names a channel for every method the panel drives", () => {
    // The spec's method list. Named here so a channel deleted in a refactor is
    // a failing test rather than a panel button that stops working.
    const required = [
      "macDesktopGetStatus",
      "macDesktopRecheckPermissions",
      "macDesktopRequestPermission",
      "macDesktopStart",
      "macDesktopStop",
      "macDesktopListWindows",
      "macDesktopOpen",
      "macDesktopClaimWindow",
      "macDesktopReleaseWindow",
      "macDesktopObserve",
      "macDesktopClick",
      "macDesktopType",
      "macDesktopPress",
      "macDesktopScroll",
      "macDesktopDrag",
      "macDesktopMove",
      "macDesktopWait",
      "macDesktopScreenshot",
      "macDesktopStartRecording",
      "macDesktopStopRecording",
      "macDesktopStartStream",
      "macDesktopStopStream",
      "macDesktopGetStreamStatus",
      "macDesktopTakeControl",
      "macDesktopReturnControl",
      "macDesktopRenewLease",
      "macDesktopPresent",
      "macDesktopSetEscapeHotkey",
      "macDesktopEvent",
      "macDesktopEscapeHotkeyPressed",
    ];
    expect(macDesktopChannelKeys.sort()).toEqual([...required].sort());
  });

  it("gives every channel a main-process handler", () => {
    const missing = macDesktopChannelKeys
      // The event channel is pushed to the renderer, not invoked, so it has a
      // sender rather than a handler.
      .filter((key) => key !== "macDesktopEvent" && key !== "macDesktopEscapeHotkeyPressed")
      .filter((key) => !registerIpc.includes(`ipcMain.handle(IPC.${key},`));
    expect(missing).toEqual([]);
  });

  it("exposes exactly the bridge methods the renderer declares", () => {
    const { bridge } = harness();
    expect(Object.keys(bridge).sort()).toEqual(
      [
        ...ROUTED_CALLS.map(([method]) => method),
        "resolveStreamUrl",
        // Never routed: the accelerator belongs to this Electron app, not the
        // runtime that owns the display.
        "setEscapeHotkey",
        "onEscapeHotkey",
        "onEvent",
      ].sort(),
    );
  });

  it("routes every call through the mac_desktop action domain before the local channel", async () => {
    // The runtime-backed build has no in-process service. A preload method that
    // called `ipcRenderer.invoke` directly would work in dev and throw in
    // production, which is the single most common way this codebase breaks.
    const { bridge, routed, invoked } = harness();
    const methods = bridge as unknown as Record<
      string,
      (args: unknown, pin?: unknown) => Promise<unknown>
    >;
    for (const [method, args] of ROUTED_CALLS) {
      await methods[method](args, { kind: "remote" });
    }
    expect(routed.map((entry) => entry.action)).toEqual(ROUTED_CALLS.map(([method]) => method));
    expect(routed.map((entry) => entry.args)).toEqual(ROUTED_CALLS.map(([, args]) => args));
    // Every local invoke is the fallback arm of a routed call, so the counts
    // match exactly. One more invoke than routes would be a direct call.
    expect(invoked).toHaveLength(routed.length);
    for (const entry of routed) expect(entry.pin).toEqual({ kind: "remote" });
  });

  it("reaches every channel from the preload bridge", async () => {
    const { bridge, invoked } = harness();
    const methods = bridge as unknown as Record<
      string,
      (args: unknown, pin?: unknown) => Promise<unknown>
    >;
    for (const [method, args] of ROUTED_CALLS) await methods[method](args);
    const reached = new Set(invoked.map((entry) => entry.channel));
    const missing = macDesktopChannelKeys
      // Neither pushed channel is invoked, and `setEscapeHotkey` is not a
      // routed call: it is this app's own keyboard, never the lane host's.
      .filter((key) => key !== "macDesktopEvent"
        && key !== "macDesktopEscapeHotkeyPressed"
        && key !== "macDesktopSetEscapeHotkey")
      .filter((key) => !reached.has(IPC[key as keyof typeof IPC]));
    expect(missing).toEqual([]);
  });

  it("keeps the two calls this process owns off the action domain", () => {
    const { bridge, routed, resolveStreamUrl, onEvent } = harness();
    void bridge.resolveStreamUrl("http://127.0.0.1:1/x");
    bridge.onEvent(() => {});
    expect(resolveStreamUrl).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(routed).toEqual([]);
  });

  it("defaults the optional-argument reads to an empty payload", async () => {
    const { bridge, routed } = harness();
    await bridge.getStatus();
    await bridge.listWindows();
    expect(routed.map((entry) => entry.args)).toEqual([{}, {}]);
  });
});
