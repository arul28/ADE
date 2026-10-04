import fs from "node:fs";
import path from "node:path";

import type { Logger } from "../logging/logger";
import type { DevServerRegistry } from "./devServerRegistry";
import { onAgentShellActivity } from "./devServerRegistry";
import {
  scanListeningProcesses,
  type ProcessLocation,
  type RunText,
} from "./devServerListenerScan";

/**
 * Keeps the dev-server registry true to what is actually listening.
 *
 * Reading terminal output finds a server that announces itself. This finds
 * the rest, a server an agent started in the background whose output nobody
 * captured, and drops a server that has stopped.
 *
 * Cost is the design constraint. A machine can run many chats at once, so
 * this never polls on a timer:
 * - An agent's shell command finishing schedules two looks, shortly after
 *   and a few seconds later, because a backgrounded server binds a moment after
 *   the command that started it returns.
 * - Someone asking for the list (a Browser pane or launchpad on screen, on any
 *   machine) is the other cue.
 * Each look is ONE machine-wide listener query (tens of milliseconds with
 * `lsof`), throttled, with concurrent asks sharing a single run. Nothing ever
 * connects to a port it finds.
 */

/** No two scans closer than this, however many chats ask. */
const MIN_SCAN_INTERVAL_MS = 4_000;
/** Windows pays for a PowerShell start per scan, so it looks less often. */
const WINDOWS_MIN_SCAN_INTERVAL_MS = 15_000;

function minScanIntervalMs(platform: NodeJS.Platform): number {
  return platform === "win32" ? WINDOWS_MIN_SCAN_INTERVAL_MS : MIN_SCAN_INTERVAL_MS;
}
/** After a shell command: right away-ish, then once more for slow starters. */
const AFTER_SHELL_DELAYS_MS = [1_500, 6_000] as const;
/** Below this a port is a system service, not a dev server. */
const MIN_DEV_SERVER_PORT = 1_024;
/**
 * Ports dev tooling opens that are not pages: the Chrome DevTools endpoint an
 * Electron app under debug opens, the Node inspector, Vite's HMR socket, and
 * the databases a lane commonly runs next to its app.
 */
const NON_PAGE_PORTS = new Set([5432, 3306, 6379, 9222, 9229, 9230, 24678, 27017]);
/** Process names that never serve a dev page even when started in a worktree. */
const NON_PAGE_COMMANDS = /^(postgres|mysqld|redis-server|mongod|ssh|sshd)$/i;

export type DevServerLaneRoot = { laneId: string; root: string };

type ScanResult = NonNullable<Awaited<ReturnType<typeof scanListeningProcesses>>>;

/**
 * One scan for the whole process. A brain hosts several projects, each with
 * its own watcher; they share the machine's listener table instead of each
 * asking the OS for it.
 */
const sharedLocationCache = new Map<number, ProcessLocation>();
let sharedScan: { at: number; promise: Promise<ScanResult | null> } | null = null;

function scanMachine(platform: NodeJS.Platform, run: RunText | undefined): Promise<ScanResult | null> {
  const now = Date.now();
  if (sharedScan && now - sharedScan.at < minScanIntervalMs(platform)) return sharedScan.promise;
  const promise = scanListeningProcesses({ platform, run, knownLocations: sharedLocationCache })
    .then((result) => {
      if (!result) return null;
      // Forget pids that stopped listening, so a reused pid is looked up afresh.
      const livePids = new Set(result.sockets.map((socket) => socket.pid));
      for (const pid of [...sharedLocationCache.keys()]) {
        if (!livePids.has(pid)) sharedLocationCache.delete(pid);
      }
      for (const [pid, location] of result.locations) sharedLocationCache.set(pid, location);
      return result;
    })
    .catch(() => null);
  sharedScan = { at: now, promise };
  return promise;
}

export type DevServerWatcher = {
  /** Look now if the last look is stale. Resolves when the registry is current. */
  refresh(): Promise<void>;
  dispose(): void;
};

/**
 * The OS reports a process's real directory (`/private/tmp/…` for `/tmp/…` on
 * macOS), so lane roots are compared by their real path too.
 */
function realPathOrResolved(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function normalizeRoot(value: string, platform: NodeJS.Platform): string {
  const resolved = realPathOrResolved(value);
  const trimmed = resolved.endsWith(path.sep) ? resolved.slice(0, -1) : resolved;
  return platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

function isWithin(child: string, root: string, separator: string): boolean {
  return child === root || child.startsWith(`${root}${separator}`);
}

/** The lane whose worktree a process runs from; the deepest root wins. */
function laneForLocation(
  location: ProcessLocation | undefined,
  roots: Array<{ laneId: string; root: string }>,
  platform: NodeJS.Platform,
): string | null {
  if (!location) return null;
  const separator = platform === "win32" ? "\\" : "/";
  if (location.cwd) {
    const cwd = normalizeRoot(location.cwd, platform);
    for (const entry of roots) {
      if (isWithin(cwd, entry.root, separator)) return entry.laneId;
    }
    return null;
  }
  if (location.commandLine) {
    const commandLine = platform === "win32" ? location.commandLine.toLowerCase() : location.commandLine;
    for (const entry of roots) {
      if (commandLine.includes(entry.root)) return entry.laneId;
    }
  }
  return null;
}

export function createDevServerWatcher(args: {
  registry: DevServerRegistry;
  projectRoot: string;
  listLaneRoots: () => Promise<DevServerLaneRoot[]>;
  logger?: Logger | null;
  /** Processes that are ADE itself (this runtime, its sync listener). */
  excludePids?: number[];
  platform?: NodeJS.Platform;
  run?: RunText;
}): DevServerWatcher {
  const platform = args.platform ?? process.platform;
  const excludePids = new Set([process.pid, ...(args.excludePids ?? [])]);
  let lastScanAt = 0;
  let inFlight: Promise<void> | null = null;
  let disposed = false;
  let shellTimers: Array<ReturnType<typeof setTimeout>> = [];

  const scan = async (): Promise<void> => {
    const result = await scanMachine(platform, args.run);
    if (!result || disposed) return;
    const roots = (await args.listLaneRoots().catch(() => []))
      .filter((entry) => entry.laneId && entry.root)
      .map((entry) => ({ laneId: entry.laneId, root: normalizeRoot(entry.root, platform) }))
      .sort((left, right) => right.root.length - left.root.length);

    const listeningPorts = new Set(result.sockets.map((socket) => socket.port));
    const found = new Map<string, { laneId: string; port: number }>();
    for (const socket of result.sockets) {
      if (excludePids.has(socket.pid)) continue;
      if (socket.port < MIN_DEV_SERVER_PORT || NON_PAGE_PORTS.has(socket.port)) continue;
      if (socket.command && NON_PAGE_COMMANDS.test(socket.command)) continue;
      const laneId = laneForLocation(result.locations.get(socket.pid), roots, platform);
      if (!laneId) continue;
      found.set(`${laneId}:${socket.port}`, { laneId, port: socket.port });
    }

    // This project's records only; another project's watcher owns the rest.
    const projectRoot = normalizeRoot(args.projectRoot, platform);
    const known = args.registry.list().filter((record) =>
      record.source.projectRoot != null && normalizeRoot(record.source.projectRoot, platform) === projectRoot);
    const knownKeys = new Set(known.map((record) => `${record.source.laneId ?? ""}:${record.port}`));
    for (const [key, entry] of found) {
      if (knownKeys.has(key)) continue;
      args.registry.record({
        port: entry.port,
        url: `http://localhost:${entry.port}/`,
        laneId: entry.laneId,
        projectRoot: args.projectRoot,
      });
      args.logger?.info("dev_servers.listener_detected", { laneId: entry.laneId, port: entry.port });
    }
    // A record whose port nothing listens on any more is a stopped server.
    for (const record of known) {
      if (listeningPorts.has(record.port)) continue;
      args.registry.forget(record.source.laneId, record.port);
    }
  };

  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (inFlight) return inFlight;
    if (Date.now() - lastScanAt < minScanIntervalMs(platform)) return Promise.resolve();
    lastScanAt = Date.now();
    inFlight = scan()
      .catch((error) => {
        args.logger?.debug("dev_servers.listener_scan_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const unsubscribeShell = onAgentShellActivity((activity) => {
    if (!activity.finished || disposed) return;
    for (const timer of shellTimers) clearTimeout(timer);
    shellTimers = AFTER_SHELL_DELAYS_MS.map((delay) => {
      const timer = setTimeout(() => {
        void refresh();
      }, delay);
      timer.unref?.();
      return timer;
    });
  });

  return {
    refresh,
    dispose() {
      disposed = true;
      unsubscribeShell();
      for (const timer of shellTimers) clearTimeout(timer);
      shellTimers = [];
    },
  };
}
