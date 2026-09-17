import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IPC } from "./ipc";

/**
 * The Mac Desktop IPC surface, checked as a contract rather than as three
 * independent files.
 *
 * A channel is only real when all three halves exist: the name, a handler in
 * the main process, and a preload method that can reach it. Drift between them
 * is silent — a missing handler surfaces as "No handler registered for …" in
 * production only, and a missing preload method type-checks fine because the
 * renderer never mentions it. Reading the sources is crude and it is the only
 * check that catches all three; mounting Electron in a unit test is not an
 * option, and a hand-maintained list of expected channels would be the fourth
 * thing to drift.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(path.join(here, relative), "utf8");

const registerIpc = read("../main/services/ipc/registerIpc.ts");
const preload = read("../preload/preload.ts");
const globals = read("../preload/global.d.ts");

const macDesktopChannelKeys = Object.keys(IPC).filter((key) => key.startsWith("macDesktop"));

describe("Mac Desktop IPC contract", () => {
  it("names a channel for every method the panel drives", () => {
    // The spec's method list. Named here so a channel deleted in a refactor is
    // a failing test rather than a panel button that stops working.
    const required = [
      "macDesktopGetStatus",
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
      "macDesktopEvent",
    ];
    expect(macDesktopChannelKeys.sort()).toEqual([...required].sort());
  });

  it("gives every channel a main-process handler", () => {
    const missing = macDesktopChannelKeys
      // The event channel is pushed to the renderer, not invoked, so it has a
      // sender rather than a handler.
      .filter((key) => key !== "macDesktopEvent")
      .filter((key) => !registerIpc.includes(`ipcMain.handle(IPC.${key},`));
    expect(missing).toEqual([]);
  });

  it("reaches every channel from the preload namespace", () => {
    const missing = macDesktopChannelKeys.filter((key) => !preload.includes(`IPC.${key}`));
    expect(missing).toEqual([]);
  });

  it("declares every preload method on window.ade.macDesktop", () => {
    const namespace = preload.slice(preload.indexOf("  macDesktop: {"));
    const body = namespace.slice(0, namespace.indexOf("\n  appControl: {"));
    const methods = [...body.matchAll(/^    ([a-zA-Z]+):/gm)].map((match) => match[1]);
    expect(methods).toContain("startStream");
    expect(methods).toContain("takeControl");
    expect(methods).toContain("resolveStreamUrl");
    const undeclared = methods.filter((method) => !globals.includes(`        ${method}: (`));
    expect(undeclared).toEqual([]);
  });

  it("routes every call through the mac_desktop action domain before the local channel", () => {
    // The runtime-backed build has no in-process service. A preload method that
    // called `ipcRenderer.invoke` directly would work in dev and throw in
    // production, which is the single most common way this codebase breaks.
    const namespace = preload.slice(preload.indexOf("  macDesktop: {"));
    const body = namespace.slice(0, namespace.indexOf("\n  appControl: {"));
    const routed = [...body.matchAll(/callMacDesktopActionOr\(/g)].length;
    const invokes = [...body.matchAll(/ipcRenderer\.invoke\(IPC\.macDesktop/g)].length;
    expect(routed).toBeGreaterThan(0);
    // Every local invoke is the fallback arm of a routed call, so the counts
    // match exactly. One more invoke than routes is a direct call.
    expect(invokes).toBe(routed);
    expect(preload).toContain('callPinnedOrBoundRuntimeActionOr(pin, "mac_desktop"');
  });
});
