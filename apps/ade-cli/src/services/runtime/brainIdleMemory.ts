import v8 from "node:v8";
import vm from "node:vm";
import type { AdeRuntime } from "../../bootstrap";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import { brainLogPath } from "../projects/machineLayout";
import { createBrainLogger } from "./brainLogger";
import { summarizeRuntimeActivity } from "./runtimeWorkSummary";

/**
 * Memory a brain gives back while nobody uses it.
 *
 * The brain keeps running after the app quits (phones, automations, sync and
 * chats need it), so what it holds then is what the machine pays for ADE with
 * no window open. Two stages, both for the clients that use this brain: a
 * desktop window, and a connection from another machine (a phone, another
 * computer, the web app, another machine's agents), which arrives as a
 * paired channel with a device id.
 *
 * 1. After the last desktop window leaves: each project's history for windows
 *    (`releaseHistory`), as before.
 * 2. After the last desktop window AND the last connection from another
 *    machine leave, with no chat running and no device on a project's sync
 *    host: each project database's statement cache, page cache and export
 *    thread (`AdeDb.releaseMemory`), each project's desktop helper
 *    (`ade-desktop-driver`) when no lane screen or recording uses it, then a
 *    full garbage collection that
 *    returns the freed heap pages to the system. V8 does not shrink an idle
 *    heap by itself: in a probe, an idle Node process kept every freed page
 *    for the whole minute, and one collection took it from 316 to 105 MB.
 *
 * Nothing here stops a service or drops data: project scopes stay open (their
 * PR polling, automations, Linear ingress, push and sync host keep working),
 * and every dropped piece rebuilds on its next use. Stage 2 waits while a
 * chat runs, so a running turn never pays for rebuilt caches; it checks again
 * each minute until it runs or a client returns. It runs at most every ten
 * minutes, apart from the first time after a window left.
 */

export type IdleMemorySources = {
  /** The project runtimes that are open now. */
  listRuntimes: () => AdeRuntime[];
};

const RELEASE_DELAY_MS = 15_000;
const RETRY_WHILE_BUSY_MS = 60_000;
/**
 * Stage 2 runs at most this often, except the first time after a desktop
 * window left: a phone that opens and closes short channels in the
 * background must not cost a full collection each time.
 */
const MIN_IDLE_RELEASE_INTERVAL_MS = 10 * 60_000;
/** `ADE_BRAIN_IDLE_MEMORY_RELEASE=0` turns stage 2 off, for a comparison run. */
const IDLE_RELEASE_ENV = "ADE_BRAIN_IDLE_MEMORY_RELEASE";

let desktopClients = 0;
let remoteClients = 0;
let historyTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let latestSources: IdleMemorySources | null = null;
let lastIdleReleaseAtMs = Number.NEGATIVE_INFINITY;
let desktopLeftSinceIdleRelease = false;

export type UserClientKind = "desktop" | "remote";

export function noteUserClientOpened(kind: UserClientKind): void {
  if (kind === "desktop") {
    desktopClients += 1;
    if (historyTimer) clearTimeout(historyTimer);
    historyTimer = null;
  } else {
    remoteClients += 1;
  }
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

/**
 * `sources` is null for a connection whose scopes end with it (a test
 * harness, an embedded runtime): it has no shared history to give back.
 */
export function noteUserClientClosed(kind: UserClientKind, sources: IdleMemorySources | null): void {
  if (kind === "desktop") desktopClients = Math.max(0, desktopClients - 1);
  else remoteClients = Math.max(0, remoteClients - 1);
  if (!sources) return;
  latestSources = sources;
  if (kind === "desktop" && desktopClients === 0) desktopLeftSinceIdleRelease = true;
  if (kind === "desktop" && desktopClients === 0 && !historyTimer) {
    historyTimer = setTimeout(() => {
      historyTimer = null;
      if (desktopClients === 0 && latestSources) releaseHistory(latestSources);
    }, RELEASE_DELAY_MS);
    historyTimer.unref?.();
  }
  if (desktopClients === 0 && remoteClients === 0 && !idleTimer) scheduleIdleRelease(RELEASE_DELAY_MS);
}

function scheduleIdleRelease(delayMs: number): void {
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (desktopClients > 0 || remoteClients > 0 || !latestSources) return;
    if (process.env[IDLE_RELEASE_ENV]?.trim() === "0") return;
    // The history goes first when both are due at once.
    if (historyTimer) {
      clearTimeout(historyTimer);
      historyTimer = null;
      releaseHistory(latestSources);
    }
    const sinceLastMs = Date.now() - lastIdleReleaseAtMs;
    if (!desktopLeftSinceIdleRelease && sinceLastMs < MIN_IDLE_RELEASE_INTERVAL_MS) {
      scheduleIdleRelease(MIN_IDLE_RELEASE_INTERVAL_MS - sinceLastMs);
      return;
    }
    const runtimes = safeList(latestSources);
    if (anyChatRunning(runtimes) || anySyncDeviceConnected(runtimes)) {
      scheduleIdleRelease(RETRY_WHILE_BUSY_MS);
      return;
    }
    lastIdleReleaseAtMs = Date.now();
    desktopLeftSinceIdleRelease = false;
    releaseIdleMemory(runtimes);
  }, delayMs);
  idleTimer.unref?.();
}

function safeList(sources: IdleMemorySources): AdeRuntime[] {
  try {
    return sources.listRuntimes();
  } catch {
    return [];
  }
}

function releaseHistory(sources: IdleMemorySources): void {
  for (const runtime of safeList(sources)) {
    try {
      runtime.agentChatService?.releaseQuietChatHistory?.();
      runtime.eventBuffer.releaseRetained?.();
    } catch {
      // Memory only: a scope mid-teardown keeps its history until it is gone.
    }
  }
}

function anyChatRunning(runtimes: AdeRuntime[]): boolean {
  return runtimes.some((runtime) => {
    try {
      const activity = summarizeRuntimeActivity(runtime);
      return activity.activeAgentTurns > 0 || (activity.activeAgentCliSessions ?? 0) > 0;
    } catch {
      // Unknown counts as running: the release waits for the next check.
      return true;
    }
  });
}

/** A phone or another computer on a project's sync host still reads through its export thread. */
function anySyncDeviceConnected(runtimes: AdeRuntime[]): boolean {
  return runtimes.some((runtime) => {
    try {
      return (runtime.syncService?.getHostService()?.getPeerStates().length ?? 0) > 0;
    } catch {
      return true;
    }
  });
}

function releaseIdleMemory(runtimes: AdeRuntime[]): void {
  const before = process.memoryUsage();
  let desktopHelpers = 0;
  for (const runtime of runtimes) {
    try {
      runtime.db.releaseMemory?.();
    } catch {
      // Memory only.
    }
    desktopHelpers += releaseDesktopHelpers(runtime);
  }
  const collection = collectGarbage();
  const after = process.memoryUsage();
  const mb = (bytes: number) => Math.round(bytes / 1048576);
  machineLogger()?.info("brain.idle_memory_released", {
    projects: runtimes.length,
    desktopHelpers,
    gc: collection.kind,
    gcMs: collection.ms,
    heapUsedMb: [mb(before.heapUsed), mb(after.heapUsed)],
    heapTotalMb: [mb(before.heapTotal), mb(after.heapTotal)],
    rssMb: [mb(before.rss), mb(after.rss)],
  });
}

/**
 * The project's `ade-desktop-driver` processes: the lane screen helper (Mac,
 * Windows and Linux Desktop) and App Control's window recorder (macOS). A
 * window's Work tools start the first with their first status read, and the
 * helpers then ran until the brain quit (about 55 MB on a reference Mac).
 * Each stays while a lane screen, a recording or a call still uses it, and
 * the next call that needs one starts it again. Returns how many stopped.
 */
function releaseDesktopHelpers(runtime: AdeRuntime): number {
  let released = 0;
  try {
    if (runtime.macDesktopService?.releaseIdleDriver()) released += 1;
  } catch {
    // Memory only: the helper stays.
  }
  try {
    if (runtime.appControlService?.releaseIdleHelpers()) released += 1;
  } catch {
    // Memory only.
  }
  return released;
}

let brainLogger: Logger | null | undefined;

/**
 * `brain.jsonl`: the release is a fact about the brain, not one project. Opened
 * lazily and once, like the other machine records (GitHub request accounting).
 */
function machineLogger(): Logger | null {
  if (brainLogger !== undefined) return brainLogger;
  try {
    brainLogger = createBrainLogger(brainLogPath());
  } catch {
    brainLogger = null;
  }
  return brainLogger;
}

type GcFunction = (options?: { type?: "major" | "minor"; execution?: "sync" | "async"; flavor?: "regular" | "last-resort" }) => void;
let gcFunction: GcFunction | null | undefined;

/**
 * V8's `gc`, without starting the brain with `--expose-gc` (its launch command
 * stays as installed). The flag is on only while one new context is made,
 * which is the only context that gets `gc`; no other code sees it.
 */
function resolveGc(): GcFunction | null {
  if (gcFunction !== undefined) return gcFunction;
  gcFunction = null;
  try {
    const exposed = (globalThis as { gc?: unknown }).gc;
    if (typeof exposed === "function") {
      gcFunction = exposed as GcFunction;
      return gcFunction;
    }
    v8.setFlagsFromString("--expose-gc");
    try {
      const fn = vm.runInNewContext("gc") as unknown;
      if (typeof fn === "function") gcFunction = fn as GcFunction;
    } finally {
      v8.setFlagsFromString("--no-expose-gc");
    }
  } catch {
    gcFunction = null;
  }
  return gcFunction;
}

/**
 * One full collection that also returns the freed pages ("last resort": it
 * repeats until nothing more frees and shrinks the heap). About 70 ms on a
 * 170 MB heap; it runs only with no client connected.
 */
function collectGarbage(): { kind: "last-resort" | "full" | "none"; ms: number } {
  const gc = resolveGc();
  if (!gc) return { kind: "none", ms: 0 };
  const started = performance.now();
  try {
    gc({ type: "major", execution: "sync", flavor: "last-resort" });
    return { kind: "last-resort", ms: Math.round(performance.now() - started) };
  } catch {
    try {
      gc();
      return { kind: "full", ms: Math.round(performance.now() - started) };
    } catch {
      return { kind: "none", ms: 0 };
    }
  }
}
