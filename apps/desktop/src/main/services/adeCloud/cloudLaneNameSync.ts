/**
 * One lane, one name. A cloud computer keeps the name of its one lane in its
 * metadata (`ade_lane_name`): the dashboard, the Work list of a sleeping
 * computer and the lanes without a computer read that copy. Its own name and
 * its account machine's name follow the lane too (the AI name a launch gives
 * it, or a person's rename), as a moved lane's computer does. The writes go
 * through the account server, which never wakes a computer for them (and this
 * computer is awake anyway: it just renamed), and which checks the computer
 * and the machine are this account's.
 *
 * Runs on the cloud computer's brain only, for its own computer
 * (`ADE_CLOUD_INSTANCE_ID`) and its own machine (the key on that computer),
 * so it holds whoever started the launch: a desktop, the phone, the web or
 * nobody watching. Renames apply in order; a burst writes only the last
 * name. A write that failed is tried again a few times with a doubling wait,
 * never for a computer that is gone, and never once a newer rename came. The
 * machine's key lands on the computer up to a minute after it joins: a
 * rename before then retries the machine's part the same way.
 */

import { CLOUD_LANE_ID_METADATA, CLOUD_LANE_NAME_METADATA } from "../../../shared/cloudLaneLaunch";
import { getErrorMessage } from "../shared/utils";
import { normalizeCloudMachineName } from "./cloudMachineCreator";
import { CLOUD_MACHINE_KEY_METADATA } from "./cloudMachines";
import { CloudProviderError, type CloudProvider } from "./cloudProvider";

type Logger = { warn: (event: string, meta?: Record<string, unknown>) => void };

/** Same cap the launch writes the first name with. */
const MAX_LANE_NAME_LENGTH = 200;
/** A failed write is tried this many times in all, the first retry after this wait, then twice as long each time. */
const WRITE_ATTEMPTS = 3;
const RETRY_FIRST_MS = 30_000;

export function createCloudLaneNameSync(deps: {
  instanceId: string;
  client: () => Promise<Pick<CloudProvider, "getInstance" | "setInstanceMetadata" | "setInstanceName"> | null>;
  /** The account machine's rename (`PATCH /account/machines/:key`); unset leaves the machine's name as it is. */
  renameMachine?: (machineKey: string, name: string) => Promise<unknown>;
  logger: Logger;
  /** Waits before a retry; a test passes its own clock. */
  setTimer?: (run: () => void, ms: number) => void;
}) {
  const setTimer = deps.setTimer ?? ((run: () => void, ms: number) => { setTimeout(run, ms).unref?.(); });
  let wanted: { laneId: string; name: string; attempt: number } | null = null;
  /** Bumped on every rename: a retry runs only while no newer rename came after the write it retries. */
  let generation = 0;
  let chain: Promise<void> = Promise.resolve();
  /** What landed last, so a repeat of it writes nothing: set only once a write succeeded. */
  const named = { computer: null as string | null, machine: null as string | null };

  const write = async (next: { laneId: string; name: string }): Promise<void> => {
    const client = await deps.client();
    if (!client) return;
    const instance = await client.getInstance(deps.instanceId);
    // A write replaces the whole map, so it starts from what is there.
    const metadata = { ...instance.metadata };
    // Only the lane this computer was made for; any other lane is not its name.
    if (metadata[CLOUD_LANE_ID_METADATA] !== next.laneId) return;
    const laneName = next.name.slice(0, MAX_LANE_NAME_LENGTH);
    if (metadata[CLOUD_LANE_NAME_METADATA] !== laneName) {
      await client.setInstanceMetadata(deps.instanceId, { ...metadata, [CLOUD_LANE_NAME_METADATA]: laneName });
    }
    // Control characters out, spaces folded, cut to the server's 60.
    const computerName = normalizeCloudMachineName(next.name);
    if (named.computer !== computerName && instance.name !== computerName) {
      await client.setInstanceName(deps.instanceId, computerName);
    }
    named.computer = computerName;
    if (!deps.renameMachine || named.machine === computerName) return;
    const machineKey = metadata[CLOUD_MACHINE_KEY_METADATA]?.trim();
    // Not recorded yet (the first minute after the join): the retry names the machine.
    if (!machineKey) throw new Error("This computer's machine key isn't recorded yet.");
    await deps.renameMachine(machineKey, computerName);
    named.machine = computerName;
  };

  const run = (): void => {
    chain = chain.then(async () => {
      const next = wanted;
      wanted = null;
      if (!next) return;
      const startedIn = generation;
      try {
        await write(next);
      } catch (error) {
        const gone = error instanceof CloudProviderError && error.status === 404;
        deps.logger.warn("cloud.lane_name_sync_failed", { laneId: next.laneId, attempt: next.attempt, gone, error: getErrorMessage(error) });
        // A newer rename replaces this one; a gone computer has nothing to name.
        if (gone || next.attempt >= WRITE_ATTEMPTS || generation !== startedIn) return;
        const retry = { ...next, attempt: next.attempt + 1 };
        setTimer(() => {
          // A newer rename came meanwhile (written, or failed and retrying on its own): this one is stale.
          if (generation !== startedIn) return;
          wanted = retry;
          run();
        }, RETRY_FIRST_MS * 2 ** (next.attempt - 1));
      }
    });
  };

  return {
    noteRenamed(laneId: string, name: string): void {
      const trimmed = name.trim();
      if (!deps.instanceId || !laneId || !trimmed) return;
      generation += 1;
      wanted = { laneId, name: trimmed, attempt: 1 };
      run();
    },
  };
}

export type CloudLaneNameSync = ReturnType<typeof createCloudLaneNameSync>;
