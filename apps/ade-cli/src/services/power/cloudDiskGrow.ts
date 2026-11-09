/**
 * Grows a paid cloud computer's disk when it's near full. Runs only when the
 * computer is idle (a disk grow restarts it). The server enforces the plan and
 * the shared 40 GB: a free computer stays at 4 GB, so what's refused here turns
 * into a plain sentence on the computer's card, once the disk is truly full.
 */

import fs from "node:fs";
import { CLOUD_DISK_FULL_METADATA, cloudCatalogOf, type CloudDiskFullReason } from "../../../../desktop/src/shared/adeCloud";
import type { CloudProvider } from "../../../../desktop/src/main/services/adeCloud/cloudProvider";
import { CloudProviderError } from "../../../../desktop/src/main/services/adeCloud/cloudProvider";
import { patchCloudMetadata } from "../../../../desktop/src/main/services/adeCloud/cloudReadyClaim";

/** Near full: at this much used, try to grow. */
const NEAR_FULL = 0.85;
/** Full: at this much used and refused a grow, the computer's card says so. */
const FULL = 0.95;
/** A refused grow is asked again only this often: a plan or the account's disk changes rarely. */
const REFUSED_RETRY_MS = 60 * 60_000;

function usedFraction(path: string): number | null {
  try {
    const stats = fs.statfsSync(path);
    return stats.blocks > 0 ? 1 - stats.bavail / stats.blocks : null;
  } catch {
    return null;
  }
}

export function createCloudDiskGrower(deps: {
  instanceId: string;
  client: () => Promise<CloudProvider | null>;
  /** The path whose filesystem is the computer's disk. */
  path: string;
  logger?: { info(event: string, data?: unknown): void; warn(event: string, data?: unknown): void };
  now?: () => number;
}) {
  const now = deps.now ?? (() => Date.now());
  let refusedAt: number | null = null;
  /** The reason shown on the card, once it's been written. */
  let shown: CloudDiskFullReason | null = null;

  const setNotice = async (client: CloudProvider, reason: CloudDiskFullReason | null): Promise<void> => {
    if (reason === shown) return;
    await patchCloudMetadata(client, deps.instanceId, { [CLOUD_DISK_FULL_METADATA]: reason ?? "" });
    shown = reason;
  };

  return {
    /** True when a grow started; the computer restarts and the idle sleep waits for that. */
    async growIfNeeded(): Promise<boolean> {
      const used = usedFraction(deps.path);
      if (used == null) return false;
      if (used < NEAR_FULL) {
        if (shown) {
          const client = await deps.client();
          if (client) await setNotice(client, null);
        }
        refusedAt = null;
        return false;
      }
      if (refusedAt != null && now() - refusedAt < REFUSED_RETRY_MS) return false;
      const client = await deps.client();
      if (!client) return false;
      const instance = await client.getInstance(deps.instanceId);
      if (!instance.resources) return false;
      const account = await client.getAccount().catch((error: unknown) => {
        deps.logger?.warn("cloud.disk_catalog_read_failed", { error: error instanceof Error ? error.message : String(error) });
        return null;
      });
      const { diskStepGb } = cloudCatalogOf(account);
      try {
        const { cpu, memory, disk } = instance.resources;
        await client.resizeInstance(deps.instanceId, { cpu, memory, disk: disk + diskStepGb }, { computerIdle: true });
        deps.logger?.info("cloud.disk_grown", { instanceId: deps.instanceId, toGb: disk + diskStepGb });
        await setNotice(client, null);
        return true;
      } catch (error) {
        if (error instanceof CloudProviderError && (error.code === "needs_paid_plan" || error.code === "disk_limit")) {
          refusedAt = now();
          if (used >= FULL) await setNotice(client, error.code === "needs_paid_plan" ? "free_limit" : "account_limit");
          deps.logger?.info("cloud.disk_grow_refused", { code: error.code });
          return false;
        }
        throw error;
      }
    },
  };
}
