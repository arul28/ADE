import fs from "node:fs";
import path from "node:path";

import type { Logger } from "../logging/logger";
import {
  MAC_DESKTOP_DRIVER_UNAVAILABLE_CODE,
  MAC_DESKTOP_WINDOW_NOT_FOUND_CODE,
  type MacDesktopHandedOffWindow,
} from "../../../shared/types/macDesktop";

/** Where an exiting helper writes the apps it handed off, under the project. */
export const MAC_DESKTOP_HANDOFF_FILE = path.join(".ade", "cache", "mac-desktop-handoff.json");

/** Keep in sync with handoffMaxAgeMs in native/ADEDesktopDriver/Sources/ADEDesktopDriver/main.swift. */
const MAC_DESKTOP_HANDOFF_MAX_AGE_MS = 15 * 60_000;

type HandedOffApp = {
  laneId: string;
  pid: number;
  handedOffAt: number;
  appName: string;
  bundleId: string | null;
  launchedAt: number | null;
  launched: boolean;
  windows: MacDesktopHandedOffWindow[];
};

type HandoffLane = { laneId: string; width: number; height: number };

type HandoffFile = {
  lanes: Map<string, { width: number; height: number }>;
  apps: HandedOffApp[];
};

type HandoffFileOnDisk = {
  lanes: HandoffLane[];
  apps: HandedOffApp[];
};

export type MacDesktopHandoffDeps = {
  logger: Logger;
  now: () => number;
  handoffPath: string | null;
  isDisposed: () => boolean;
  resolveLaneWorktreePath?: ((laneId: string) => Promise<string | null> | string | null) | null;
  hasDisplay: (laneId: string) => boolean;
  startLane: (laneId: string, size: { width: number; height: number } | null) => Promise<unknown>;
  adopt: (app: HandedOffApp) => Promise<boolean>;
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const errorCode = (error: unknown): string | null => {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const asNullableString = (value: unknown): string | null => typeof value === "string" ? value : null;

export function createMacDesktopHandoff(deps: MacDesktopHandoffDeps) {
  const cancelledAt = new Map<string, number>();
  let disposed = false;
  let restoreTimer: ReturnType<typeof setTimeout> | null = null;
  let timerDelay: number | null = null;
  let restoring: Promise<void> | null = null;
  let rerunRequested = false;
  let rerunDelay: number | null = null;

  const isProcessAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM") return true;
      if (code === "ESRCH") return false;
      deps.logger.warn("mac_desktop.handoff_process_check_failed", { pid, error: errorMessage(error) });
      return false;
    }
  };

  const isCancelled = (app: HandedOffApp): boolean => {
    const cancelledAtMs = cancelledAt.get(app.laneId);
    return cancelledAtMs !== undefined && app.handedOffAt <= cancelledAtMs;
  };

  const parseHandoff = (raw: string, file: string): HandoffFile | null => {
    try {
      const parsed = asRecord(JSON.parse(raw));
      if (!parsed || !Array.isArray(parsed.apps) || !Array.isArray(parsed.lanes)) {
        deps.logger.warn("mac_desktop.handoff_invalid", { file, reason: "missing apps or lanes" });
        return null;
      }
      const apps: HandedOffApp[] = [];
      for (const entry of parsed.apps) {
        const app = asRecord(entry);
        const laneId = asNullableString(app?.laneId)?.trim();
        const pid = app?.pid;
        const handedOffAt = app?.handedOffAt;
        if (!laneId || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
          deps.logger.info("mac_desktop.handoff_entry_skipped", { reason: "invalid app identity" });
          continue;
        }
        if (typeof handedOffAt !== "number" || !Number.isFinite(handedOffAt)) {
          deps.logger.info("mac_desktop.handoff_entry_skipped", { laneId, pid, reason: "invalid handedOffAt" });
          continue;
        }
        const windows = (Array.isArray(app?.windows) ? app.windows : []).flatMap((entry): MacDesktopHandedOffWindow[] => {
          const window = asRecord(entry);
          if (typeof window?.id !== "number" || !Number.isFinite(window.id)) {
            deps.logger.info("mac_desktop.handoff_entry_skipped", { laneId, pid, reason: "invalid window id" });
            return [];
          }
          const number = (value: unknown): number =>
            typeof value === "number" && Number.isFinite(value) ? value : 0;
          return [{
            id: window.id,
            x: number(window.x),
            y: number(window.y),
            width: number(window.width),
            height: number(window.height),
            minimized: window.minimized === true,
          }];
        });
        apps.push({
          laneId,
          pid,
          handedOffAt,
          appName: asNullableString(app?.appName) ?? `pid ${pid}`,
          bundleId: asNullableString(app?.bundleId),
          launchedAt: typeof app?.launchedAt === "number" && Number.isFinite(app.launchedAt) ? app.launchedAt : null,
          launched: app?.launched !== false,
          windows,
        });
      }
      const lanes = new Map<string, { width: number; height: number }>();
      for (const entry of parsed.lanes) {
        const lane = asRecord(entry);
        const laneId = asNullableString(lane?.laneId)?.trim();
        if (laneId
          && typeof lane?.width === "number" && Number.isFinite(lane.width) && lane.width > 0
          && typeof lane?.height === "number" && Number.isFinite(lane.height) && lane.height > 0) {
          lanes.set(laneId, { width: lane.width, height: lane.height });
        } else {
          deps.logger.info("mac_desktop.handoff_entry_skipped", { reason: "invalid lane size" });
        }
      }
      return { lanes, apps };
    } catch (error) {
      deps.logger.warn("mac_desktop.handoff_parse_failed", { file, error: errorMessage(error) });
      return null;
    }
  };

  const readAndClaim = (file: string): HandoffFile | null => {
    const claimPath = `${file}.claim-${process.pid}-${deps.now()}`;
    try {
      fs.renameSync(file, claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      deps.logger.warn("mac_desktop.handoff_claim_failed", { file, error: errorMessage(error) });
      return null;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(claimPath, "utf8");
    } catch (error) {
      deps.logger.warn("mac_desktop.handoff_read_failed", { file: claimPath, error: errorMessage(error) });
      return null;
    } finally {
      try {
        fs.rmSync(claimPath, { force: true });
      } catch (error) {
        deps.logger.warn("mac_desktop.handoff_claim_remove_failed", { file: claimPath, error: errorMessage(error) });
      }
    }

    return parseHandoff(raw, file);
  };

  const writeBack = (handoff: HandoffFile, apps: HandedOffApp[]): void => {
    const file = deps.handoffPath;
    if (!file || apps.length === 0) return;
    const now = deps.now();
    const requeuedLaneIds = new Set(apps.map((app) => app.laneId));
    const lanes = new Map<string, HandoffLane>();
    for (const [laneId, size] of handoff.lanes) {
      if (requeuedLaneIds.has(laneId)) lanes.set(laneId, { laneId, ...size });
    }
    const mergedApps = new Map<number, HandedOffApp>();
    // The helper and brain may write during the same shutdown window, so preserve entries the other writer owns.
    try {
      if (fs.existsSync(file)) {
        const existing = parseHandoff(fs.readFileSync(file, "utf8"), file);
        if (existing) {
          for (const app of existing.apps) mergedApps.set(app.pid, app);
          for (const [laneId, size] of existing.lanes) lanes.set(laneId, { laneId, ...size });
        }
      }
    } catch (error) {
      deps.logger.warn("mac_desktop.handoff_merge_read_failed", { file, error: errorMessage(error) });
    }
    for (const app of apps) {
      mergedApps.set(app.pid, app);
    }
    const keptApps = [...mergedApps.values()].filter((app) => {
      const ageMs = now - app.handedOffAt;
      if (ageMs <= MAC_DESKTOP_HANDOFF_MAX_AGE_MS) return true;
      deps.logger.info("mac_desktop.handoff_expired", { laneId: app.laneId, pid: app.pid, ageMs });
      return false;
    });
    const keptLaneIds = new Set(keptApps.map((app) => app.laneId));
    const body: HandoffFileOnDisk = {
      lanes: [...lanes.values()].filter((lane) => keptLaneIds.has(lane.laneId)),
      apps: keptApps,
    };
    const temporary = `${file}.tmp-${process.pid}-${now}`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(body), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, file);
      deps.logger.info("mac_desktop.handoff_requeued", { count: keptApps.length, lanes: [...keptLaneIds] });
    } catch (error) {
      deps.logger.warn("mac_desktop.handoff_requeue_failed", { file, count: apps.length, error: errorMessage(error) });
      try {
        fs.rmSync(temporary, { force: true });
      } catch (cleanupError) {
        deps.logger.warn("mac_desktop.handoff_temp_remove_failed", { file: temporary, error: errorMessage(cleanupError) });
      }
    }
  };

  const restore = async (file: string): Promise<void> => {
    const handoff = readAndClaim(file);
    if (!handoff || handoff.apps.length === 0) return;

    const byLane = new Map<string, HandedOffApp[]>();
    const now = deps.now();
    for (const app of handoff.apps) {
      const ageMs = now - app.handedOffAt;
      if (ageMs > MAC_DESKTOP_HANDOFF_MAX_AGE_MS) {
        deps.logger.info("mac_desktop.handoff_expired", { laneId: app.laneId, pid: app.pid, ageMs });
        continue;
      }
      if (!isProcessAlive(app.pid)) {
        deps.logger.info("mac_desktop.handoff_app_skipped", { laneId: app.laneId, pid: app.pid, reason: "process exited" });
        continue;
      }
      const laneApps = byLane.get(app.laneId);
      if (laneApps) laneApps.push(app);
      else byLane.set(app.laneId, [app]);
    }

    let restored = 0;
    const requeue: HandedOffApp[] = [];
    const cancelled = (app: HandedOffApp): boolean => {
      if (!isCancelled(app)) return false;
      deps.logger.info("mac_desktop.handoff_lane_cancelled", { laneId: app.laneId, pid: app.pid });
      return true;
    };
    const keepUncancelled = (apps: HandedOffApp[]): HandedOffApp[] => apps.filter((app) => !cancelled(app));
    for (const [laneId, laneApps] of byLane) {
      let apps = keepUncancelled(laneApps);
      if (apps.length === 0) continue;
      if (deps.isDisposed()) {
        requeue.push(...apps.filter((app) => isProcessAlive(app.pid)));
        continue;
      }

      try {
        if (deps.resolveLaneWorktreePath) {
          const worktree = await Promise.resolve(deps.resolveLaneWorktreePath(laneId));
          apps = keepUncancelled(apps);
          if (apps.length === 0) continue;
          if (!worktree) {
            deps.logger.info("mac_desktop.handoff_lane_skipped", { laneId, reason: "lane no longer exists" });
            continue;
          }
        }
      } catch (error) {
        apps = keepUncancelled(apps);
        if (apps.length === 0) continue;
        deps.logger.warn("mac_desktop.handoff_lane_lookup_failed", { laneId, error: errorMessage(error) });
        continue;
      }

      if (deps.isDisposed()) {
        requeue.push(...apps.filter((app) => isProcessAlive(app.pid)));
        continue;
      }

      if (!deps.hasDisplay(laneId)) {
        try {
          await deps.startLane(laneId, handoff.lanes.get(laneId) ?? null);
        } catch (error) {
          apps = keepUncancelled(apps);
          if (apps.length === 0) continue;
          deps.logger.warn("mac_desktop.handoff_lane_start_failed", {
            laneId,
            error: errorMessage(error),
            code: errorCode(error),
          });
          requeue.push(...apps.filter((app) => isProcessAlive(app.pid)));
          continue;
        }
        apps = keepUncancelled(apps);
        if (apps.length === 0) continue;
      }

      for (let index = 0; index < apps.length; index += 1) {
        const app = apps[index];
        if (deps.isDisposed()) {
          requeue.push(...apps.slice(index).filter((pending) => !cancelled(pending) && isProcessAlive(pending.pid)));
          break;
        }
        if (!isProcessAlive(app.pid)) {
          deps.logger.info("mac_desktop.handoff_app_skipped", { laneId, pid: app.pid, reason: "process exited" });
          continue;
        }
        try {
          const adopted = await deps.adopt(app);
          if (cancelled(app)) break;
          if (adopted) {
            restored += 1;
          } else {
            deps.logger.info("mac_desktop.handoff_app_skipped", { laneId, pid: app.pid, reason: "driver refused adoption" });
          }
        } catch (error) {
          if (cancelled(app)) break;
          const code = errorCode(error);
          const pidWasReused = code === MAC_DESKTOP_WINDOW_NOT_FOUND_CODE;
          const transient = !pidWasReused && (code === MAC_DESKTOP_DRIVER_UNAVAILABLE_CODE || !deps.hasDisplay(laneId));
          if (transient && isProcessAlive(app.pid)) {
            requeue.push(app, ...apps.slice(index + 1).filter((pending) => !cancelled(pending) && isProcessAlive(pending.pid)));
            deps.logger.warn("mac_desktop.handoff_app_requeued", { laneId, pid: app.pid, error: errorMessage(error), code });
            break;
          }
          deps.logger.info("mac_desktop.handoff_app_skipped", { laneId, pid: app.pid, error: errorMessage(error), code });
        }
      }
    }

    writeBack(handoff, requeue);
    deps.logger.info("mac_desktop.handoff_restored", {
      handedOff: handoff.apps.length,
      restored,
      requeued: requeue.length,
      lanes: [...byLane.keys()],
    });
  };

  const arm = (delayMs: number): void => {
    const file = deps.handoffPath;
    if (!file || disposed || deps.isDisposed()) return;
    if (restoring) {
      rerunRequested = true;
      rerunDelay = rerunDelay === null ? delayMs : Math.min(rerunDelay, delayMs);
      return;
    }
    if (restoreTimer && timerDelay !== null && timerDelay <= delayMs) return;
    if (restoreTimer) clearTimeout(restoreTimer);
    timerDelay = delayMs;
    restoreTimer = setTimeout(() => {
      restoreTimer = null;
      timerDelay = null;
      if (disposed || deps.isDisposed()) return;
      restoring = restore(file).catch((error) => {
        deps.logger.warn("mac_desktop.handoff_restore_failed", { file, error: errorMessage(error) });
      }).finally(() => {
        restoring = null;
        if (rerunRequested && !disposed && !deps.isDisposed()) {
          const nextDelay = rerunDelay ?? 0;
          rerunRequested = false;
          rerunDelay = null;
          arm(nextDelay);
        }
      });
    }, Math.max(0, delayMs));
    restoreTimer.unref?.();
  };

  return {
    schedule: arm,
    cancelLane(laneId: string): void {
      if (!deps.handoffPath) return;
      const trimmed = laneId.trim();
      if (trimmed) cancelledAt.set(trimmed, deps.now());
    },
    dispose(): void {
      disposed = true;
      rerunRequested = false;
      rerunDelay = null;
      if (restoreTimer) clearTimeout(restoreTimer);
      restoreTimer = null;
      timerDelay = null;
    },
  };
}
