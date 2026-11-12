/**
 * Grows a cloud computer's disk before ADE's storage guard has to stop work
 * on it. A grow restarts the computer, so it runs only when nothing runs
 * there: at the idle point once the disk is near full, and at once (the next
 * keep-awake check) once the guard would soon stop turns. The server enforces
 * the plan's disk at one time, extra disk and each size's limit; what it
 * refuses turns into a plain sentence on the computer's card and in the
 * chat's refusal. The card reads the exact reason; builds before plans read
 * the older key.
 *
 * The lines come from this computer's own disk (`diskPressureThresholdsForSize`):
 * the guard stops agent turns at "exhausted", the grow comes at "critical" or
 * earlier, so on any disk size the grow is asked for before a turn is refused.
 */

import fs from "node:fs";
import path from "node:path";
import {
  CLOUD_DISK_FULL_METADATA,
  CLOUD_DISK_FULL_REASON_METADATA,
  cloudCatalogOf,
  cloudDiskFullLegacyReason,
  cloudDiskGrowRefusedWayOut,
} from "../../../../desktop/src/shared/adeCloud";
import type { CloudProvider } from "../../../../desktop/src/main/services/adeCloud/cloudProvider";
import { CloudProviderError } from "../../../../desktop/src/main/services/adeCloud/cloudProvider";
import { patchCloudMetadata } from "../../../../desktop/src/main/services/adeCloud/cloudInstanceOps";
import {
  classifyDiskPressure,
  diskPressureThresholdsForSize,
  type DiskPressureState,
} from "../../../../desktop/src/main/services/storage/diskPressure";
import { CLOUD_DISK_GROW_STARTED_COOLDOWN_MS, type CloudDiskGrowState } from "./cloudDiskGuard";

export { cloudDiskGrowStatePath } from "./cloudDiskGuard";

/** Near full: at this much used (or the guard's warning, if that comes first), grow at the idle point. */
const NEAR_FULL = 0.85;
/** A refused grow is asked again only this often: a plan, extra disk or the account's disk changes rarely. */
const REFUSED_RETRY_MS = 60 * 60_000;
/** After a grow started the computer restarts; if it somehow doesn't, no second grow for this long. */
const GROW_STARTED_COOLDOWN_MS = CLOUD_DISK_GROW_STARTED_COOLDOWN_MS;

const SEVERITY: Record<DiskPressureState, number> = { normal: 0, warning: 1, critical: 2, exhausted: 3 };

type DiskSpace = { freeBytes: number; totalBytes: number };

function readDiskSpace(target: string): DiskSpace | null {
  try {
    const stats = fs.statfsSync(target);
    if (!(stats.blocks > 0)) return null;
    return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
  } catch {
    return null;
  }
}

/** The guard's state for this disk, by the same size-scaled lines the brain's guard uses. */
function pressureOf(space: DiskSpace): DiskPressureState {
  return classifyDiskPressure(
    { freeBytes: space.freeBytes, freeFraction: space.freeBytes / space.totalBytes },
    diskPressureThresholdsForSize(space.totalBytes),
  );
}

export function createCloudDiskGrower(deps: {
  instanceId: string;
  client: () => Promise<CloudProvider | null>;
  /** The path whose filesystem is the computer's disk. */
  path: string;
  /** Where `CloudDiskGrowState` is written (`cloudDiskGrowStatePath`); none, nothing is written. */
  stateFile?: string;
  logger?: { info(event: string, data?: unknown): void; warn(event: string, data?: unknown): void };
  now?: () => number;
}) {
  const now = deps.now ?? (() => Date.now());
  let refusedAt: number | null = null;
  let grewAt: number | null = null;
  /** One grow at a time: a check that comes while one runs answers false. */
  let inFlight = false;
  /**
   * The exact reason shown on the card: undefined until this brain wrote or
   * read it. A notice an earlier boot wrote (before a grow, a resize or Clear
   * caches made room) is read once and cleared.
   */
  let shown: string | null | undefined = undefined;
  let stateWritten = false;

  const setNotice = async (client: CloudProvider, reason: string | null): Promise<void> => {
    if (reason === shown) return;
    if (shown === undefined && reason === null) {
      const metadata = (await client.getInstance(deps.instanceId)).metadata;
      if (!metadata[CLOUD_DISK_FULL_METADATA] && !metadata[CLOUD_DISK_FULL_REASON_METADATA]) {
        shown = null;
        return;
      }
    }
    await patchCloudMetadata(client, deps.instanceId, {
      [CLOUD_DISK_FULL_METADATA]: reason ? cloudDiskFullLegacyReason(reason) : "",
      [CLOUD_DISK_FULL_REASON_METADATA]: reason ?? "",
    });
    shown = reason;
  };

  const writeState = (state: CloudDiskGrowState | null): void => {
    if (!deps.stateFile) return;
    try {
      if (!state) {
        if (stateWritten || fs.existsSync(deps.stateFile)) fs.rmSync(deps.stateFile, { force: true });
        stateWritten = false;
        return;
      }
      fs.mkdirSync(path.dirname(deps.stateFile), { recursive: true });
      const tmp = `${deps.stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, deps.stateFile);
      stateWritten = true;
    } catch (error) {
      deps.logger?.warn("cloud.disk_grow_state_write_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  /** The disk as the grow sees it, or null when unreadable. */
  const measure = (): { space: DiskSpace; used: number; pressure: DiskPressureState } | null => {
    const space = readDiskSpace(deps.path);
    if (!space) return null;
    return { space, used: 1 - space.freeBytes / space.totalBytes, pressure: pressureOf(space) };
  };

  const grow = async (stillIdle: () => boolean | Promise<boolean>): Promise<boolean> => {
    const disk = measure();
    if (!disk) return false;
    const nearFull = disk.used >= NEAR_FULL || SEVERITY[disk.pressure] >= SEVERITY.warning;
    if (!nearFull) {
      if (shown !== null) {
        // Never in the way of the idle sleep that follows: tried again at the next idle point.
        try {
          const client = await deps.client();
          if (client) await setNotice(client, null);
        } catch (error) {
          deps.logger?.warn("cloud.disk_notice_clear_failed", { error: error instanceof Error ? error.message : String(error) });
        }
      }
      writeState(null);
      refusedAt = null;
      return false;
    }
    if (refusedAt != null && now() - refusedAt < REFUSED_RETRY_MS) return false;
    if (grewAt != null && now() - grewAt < GROW_STARTED_COOLDOWN_MS) return false;
    const client = await deps.client();
    if (!client) return false;
    const instance = await client.getInstance(deps.instanceId);
    if (!instance.resources) return false;
    const account = await client.getAccount().catch((error: unknown) => {
      deps.logger?.warn("cloud.disk_catalog_read_failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    });
    const catalog = cloudCatalogOf(account);
    // A grow restarts the computer, and work may have started during those reads.
    if (!(await stillIdle())) return false;
    const { cpu, memory, disk: diskGb } = instance.resources;
    const toGb = diskGb + catalog.diskStepGb;
    try {
      writeState({ v: 1, state: "growing", toGb, at: now() });
      await client.resizeInstance(deps.instanceId, { cpu, memory, disk: toGb }, { computerIdle: true, origin: "auto" });
      grewAt = now();
      deps.logger?.info("cloud.disk_grown", { instanceId: deps.instanceId, toGb, pressure: disk.pressure });
      await setNotice(client, null);
      return true;
    } catch (error) {
      if (error instanceof CloudProviderError && (error.code === "needs_paid_plan" || error.code === "disk_limit")) {
        refusedAt = now();
        // A server before plans sends no reason: its two codes map onto the nearest exact one.
        const reason = error.detail.reason ?? (error.code === "needs_paid_plan" ? "plan_disk" : "account_limit");
        writeState({ v: 1, state: "refused", reason, wayOut: cloudDiskGrowRefusedWayOut(null, catalog, reason) ?? "It can't grow right now.", at: now() });
        // The card says "full" once the guard stops heavy work; the chat's refusal says it at once.
        if (SEVERITY[disk.pressure] >= SEVERITY.critical) await setNotice(client, reason);
        deps.logger?.info("cloud.disk_grow_refused", { code: error.code, reason });
        return false;
      }
      // Not refused, just failed: the next check tries again.
      writeState(null);
      throw error;
    }
  };

  return {
    /**
     * At the idle point: grows the disk if it's near full. True when a grow
     * started; the computer restarts and the idle sleep waits for that.
     */
    async growIfNeeded(stillIdle: () => boolean | Promise<boolean>): Promise<boolean> {
      if (inFlight) return false;
      inFlight = true;
      try {
        return await grow(stillIdle);
      } finally {
        inFlight = false;
      }
    },
    /**
     * Whether the disk is close enough to the guard's stop line that the grow
     * shouldn't wait for the idle point: a local `statfs`, no server call.
     * False while a refused grow or a started one still holds.
     */
    growDueNow(): boolean {
      if (inFlight) return false;
      if (refusedAt != null && now() - refusedAt < REFUSED_RETRY_MS) return false;
      if (grewAt != null && now() - grewAt < GROW_STARTED_COOLDOWN_MS) return false;
      const disk = measure();
      return disk != null && SEVERITY[disk.pressure] >= SEVERITY.critical;
    },
  };
}
