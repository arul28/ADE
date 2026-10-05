/**
 * The NDJSON client for `ade-desktop-driver.exe` (the Windows driver).
 *
 * The wire is the Mac driver's, byte for byte — one JSON object per line, the
 * same `ping`/`display.*`/`window.*`/`input`/`stream.*`/`record.*` ops, the
 * same reply envelope — so the whole protocol, restart-with-backoff, and health
 * shape are reused from `macDesktopDriverClient.ts` and only three things are
 * configured here:
 *
 *   - the platform is win32,
 *   - the helper is spawned as `host --ade-home <dir>`, the mode the brain runs
 *     in the console session,
 *   - the health copy names Windows Desktop.
 *
 * The `--ade-home` value must be the same directory the brain runs against: the
 * host writes the child-session launcher it starts at logon, and that launcher
 * has to reach the same runtime the console session does.
 */

import type { spawn } from "node:child_process";
import path from "node:path";

import {
  WINDOWS_DESKTOP_WINDOWS_ONLY_MESSAGE,
  type MacDesktopDriverHealth,
} from "../../../shared/types/macDesktop";
import type { Logger } from "../logging/logger";
import {
  createMacDesktopDriverClient,
  MAC_DESKTOP_DRIVER_OPS,
  type MacDesktopDriverClient,
  type MacDesktopDriverEvent,
} from "../macDesktop/macDesktopDriverClient";
import { resolveWindowsDesktopDriverBinary } from "../native/nativeHelperPaths";

export function createWindowsDesktopDriverClient(deps: {
  logger: Logger;
  platform: NodeJS.Platform;
  /** The actual ADE home, passed to the helper as `--ade-home`. */
  adeHome: string;
  onHealthChanged: (health: MacDesktopDriverHealth) => void;
  onDriverLost: (reason: string) => void;
  requestTimeoutMs?: number;
  /** Test seam. Defaults to `child_process.spawn`. */
  spawnProcess?: typeof spawn;
}): MacDesktopDriverClient {
  return createMacDesktopDriverClient({
    logger: deps.logger,
    platform: deps.platform,
    supportedPlatforms: ["win32"],
    unsupportedMessage: WINDOWS_DESKTOP_WINDOWS_ONLY_MESSAGE,
    unsupportedTitle: "Windows Desktop needs a Windows host",
    driverLabel: "Windows Desktop",
    driverArgs: ["host", "--ade-home", deps.adeHome],
    // Windows: ask the host to quit over stdin so it can sign its child session
    // out; `kill` there is TerminateProcess and skips the native cleanup.
    gracefulQuit: true,
    resolveExecutablePath: () => resolveWindowsDesktopDriverBinary({ platform: deps.platform, logger: deps.logger }),
    onHealthChanged: deps.onHealthChanged,
    onDriverLost: deps.onDriverLost,
    ...(deps.requestTimeoutMs != null ? { requestTimeoutMs: deps.requestTimeoutMs } : {}),
    ...(deps.spawnProcess ? { spawnProcess: deps.spawnProcess } : {}),
  });
}

type SharedAttachment = {
  listeners: Set<(event: MacDesktopDriverEvent) => void>;
  onHealthChanged: (health: MacDesktopDriverHealth) => void;
  onDriverLost: (reason: string) => void;
  liveLaneIds: (() => string[]) | null;
};

type SharedDriver = {
  client: MacDesktopDriverClient;
  attachments: Set<SharedAttachment>;
  /** Which project's service a lane belongs to: the one that sent a request for it. */
  laneOwner: Map<string, SharedAttachment>;
  /**
   * Lanes with a screen asked for and not yet destroyed, by owner. A project
   * reconciles before its first screen while another project's create can
   * still wait on sign-in; that lane is not in the other project's live list
   * yet, so the reconcile keeps it from here.
   */
  heldLanes: Map<string, SharedAttachment>;
};

const sharedDrivers = new Map<string, SharedDriver>();

function sharedDriverKey(adeHome: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(adeHome);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * The Windows driver for one ADE home, shared by every project the brain has
 * open.
 *
 * The brain builds one lane-screen service per open project. On a Mac each one
 * starts its own helper, and each helper owns its own virtual displays. The
 * Windows host is one per ADE home (one private child session per PC, held by a
 * named lock), so a second project's own host was refused at start and its
 * service ended in a crash loop: Windows Desktop then worked in one open
 * project and not in the other. Every project now reaches the one host:
 *
 *   - requests go to the shared client; a request that names a lane records
 *     which project that lane belongs to;
 *   - a lane's events go to that project only, so no project records another
 *     project's windows; events with no lane (a lock, a phase) go to all;
 *   - `display.reconcile` destroys every display not in its list, so the list
 *     sent is every attached project's live lanes, plus every screen a
 *     project asked for and has not destroyed, never one project's alone;
 *   - health changes and a lost driver reach every project;
 *   - the host stops only when the last project releases it.
 */
export function acquireSharedWindowsDesktopDriverClient(deps: {
  logger: Logger;
  platform: NodeJS.Platform;
  adeHome: string;
  onHealthChanged: (health: MacDesktopDriverHealth) => void;
  onDriverLost: (reason: string) => void;
  /** This project's live lanes, for the shared reconcile. */
  liveLaneIds?: (() => string[]) | null;
  requestTimeoutMs?: number;
  /** Test seam. Defaults to `child_process.spawn`. */
  spawnProcess?: typeof spawn;
}): MacDesktopDriverClient {
  const key = sharedDriverKey(deps.adeHome, deps.platform);
  let shared = sharedDrivers.get(key);
  if (!shared) {
    const attachments = new Set<SharedAttachment>();
    const laneOwner = new Map<string, SharedAttachment>();
    const heldLanes = new Map<string, SharedAttachment>();
    const client = createWindowsDesktopDriverClient({
      logger: deps.logger,
      platform: deps.platform,
      adeHome: deps.adeHome,
      onHealthChanged: (health) => {
        for (const attachment of [...attachments]) attachment.onHealthChanged(health);
      },
      onDriverLost: (reason) => {
        laneOwner.clear();
        heldLanes.clear();
        for (const attachment of [...attachments]) attachment.onDriverLost(reason);
      },
      ...(deps.requestTimeoutMs != null ? { requestTimeoutMs: deps.requestTimeoutMs } : {}),
      ...(deps.spawnProcess ? { spawnProcess: deps.spawnProcess } : {}),
    });
    client.onEvent((event) => {
      const laneId = typeof event.laneId === "string" ? event.laneId : null;
      const owner = laneId ? laneOwner.get(laneId) : undefined;
      // A lane no project has named yet (an event racing the create reply)
      // goes to every project, as it did with one client per project.
      const targets = owner && attachments.has(owner) ? [owner] : [...attachments];
      for (const target of targets) {
        for (const listener of [...target.listeners]) listener(event);
      }
      if (laneId && event.event === "display-destroyed") {
        laneOwner.delete(laneId);
        heldLanes.delete(laneId);
      }
    });
    shared = { client, attachments, laneOwner, heldLanes };
    sharedDrivers.set(key, shared);
  }
  const { client, attachments, laneOwner, heldLanes } = shared;
  const attachment: SharedAttachment = {
    listeners: new Set(),
    onHealthChanged: deps.onHealthChanged,
    onDriverLost: deps.onDriverLost,
    liveLaneIds: deps.liveLaneIds ?? null,
  };
  attachments.add(attachment);
  let released = false;

  const request: MacDesktopDriverClient["request"] = async (op, payload = {}, options = {}) => {
    const laneId = typeof payload.laneId === "string" ? payload.laneId : null;
    if (laneId) laneOwner.set(laneId, attachment);
    if (op === MAC_DESKTOP_DRIVER_OPS.reconcileDisplays) {
      const live = new Set<string>(Array.isArray(payload.liveLaneIds) ? payload.liveLaneIds.map(String) : []);
      for (const other of attachments) {
        if (other === attachment) continue;
        for (const id of other.liveLaneIds?.() ?? []) live.add(id);
      }
      for (const [id, owner] of heldLanes) if (owner !== attachment) live.add(id);
      return await client.request(op, { ...payload, liveLaneIds: [...live] }, options);
    }
    if (laneId && op === MAC_DESKTOP_DRIVER_OPS.createDisplay) {
      heldLanes.set(laneId, attachment);
      try {
        return await client.request(op, payload, options);
      } catch (error) {
        if (heldLanes.get(laneId) === attachment) heldLanes.delete(laneId);
        throw error;
      }
    }
    if (laneId && op === MAC_DESKTOP_DRIVER_OPS.destroyDisplay) heldLanes.delete(laneId);
    return await client.request(op, payload, options);
  };

  return {
    ...client,
    request,
    onEvent(listener) {
      attachment.listeners.add(listener);
      return () => {
        attachment.listeners.delete(listener);
      };
    },
    dispose() {
      if (released) return;
      released = true;
      attachments.delete(attachment);
      for (const [laneId, owner] of [...laneOwner]) if (owner === attachment) laneOwner.delete(laneId);
      for (const [laneId, owner] of [...heldLanes]) if (owner === attachment) heldLanes.delete(laneId);
      if (attachments.size > 0) return;
      sharedDrivers.delete(key);
      client.dispose();
    },
  };
}
