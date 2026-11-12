/**
 * A cloud computer keeps the name of its one lane in its metadata
 * (`ade_lane_name`). The dashboard, the Work list of a sleeping computer and
 * the lanes without a computer read that copy, so a rename here writes it
 * too. The write goes through the account server, which never wakes a
 * computer for it (and this computer is awake anyway: it just renamed).
 *
 * Runs on the cloud computer's brain only. Renames apply in order; a burst
 * writes only the last name.
 */

import { CLOUD_LANE_ID_METADATA, CLOUD_LANE_NAME_METADATA } from "../../../shared/cloudLaneLaunch";
import { getErrorMessage } from "../shared/utils";
import type { CloudProvider } from "./cloudProvider";

type Logger = { warn: (event: string, meta?: Record<string, unknown>) => void };

/** Same cap the launch writes the first name with. */
const MAX_LANE_NAME_LENGTH = 200;

export function createCloudLaneNameSync(deps: {
  instanceId: string;
  client: () => Promise<Pick<CloudProvider, "getInstance" | "setInstanceMetadata"> | null>;
  logger: Logger;
}) {
  let wanted: { laneId: string; name: string } | null = null;
  let chain: Promise<void> = Promise.resolve();

  const write = async (): Promise<void> => {
    const next = wanted;
    wanted = null;
    if (!next) return;
    const client = await deps.client();
    if (!client) return;
    // A write replaces the whole map, so it starts from what is there.
    const metadata = { ...(await client.getInstance(deps.instanceId)).metadata };
    // Only the lane this computer was made for; any other lane is not its name.
    if (metadata[CLOUD_LANE_ID_METADATA] !== next.laneId) return;
    const name = next.name.slice(0, MAX_LANE_NAME_LENGTH);
    if (metadata[CLOUD_LANE_NAME_METADATA] === name) return;
    await client.setInstanceMetadata(deps.instanceId, { ...metadata, [CLOUD_LANE_NAME_METADATA]: name });
  };

  return {
    noteRenamed(laneId: string, name: string): void {
      const trimmed = name.trim();
      if (!deps.instanceId || !laneId || !trimmed) return;
      wanted = { laneId, name: trimmed };
      chain = chain.then(write).catch((error: unknown) => {
        // The next rename writes it again; the old name stays until then.
        deps.logger.warn("cloud.lane_name_sync_failed", { laneId, error: getErrorMessage(error) });
      });
    },
  };
}

export type CloudLaneNameSync = ReturnType<typeof createCloudLaneNameSync>;
