import { CLOUD_JOIN_WATCH_MS } from "../../../shared/adeCloud";
import { getErrorMessage } from "../shared/utils";
import { CONNECT_RETRY_MS, LaunchStepError, type Logger } from "./cloudLaneLaunchSteps";
import { deleteCloudInstanceConfirmed } from "./cloudPendingCreates";
import { CloudProviderError, type CloudInstance, type CloudProvider } from "./cloudProvider";
import { BRAND } from "../../../shared/brand";

/**
 * Steps a new ADE Cloud computer goes through on this machine, shared by a
 * cloud lane launch (`cloudLaneComputerStages.ts`) and the CTO's cloud home
 * (`ctoCloudHomeService.ts`): pairing and connecting once it joins, and
 * deleting what a cancelled request made.
 */

/**
 * Pairs a computer that joined the account and connects to it, retrying while
 * its account row and relay route come up. `holder.targetId` keeps a pairing
 * across tries and retries; one that is gone is paired again.
 */
export async function pairAndConnectWithRetry(args: {
  machineKey: string;
  holder: { targetId: string | null };
  pairMachine: (machineKey: string) => Promise<{ targetId: string }>;
  /** Resolving to `false` (rather than throwing) means "not yet". */
  connect: (targetId: string) => Promise<unknown>;
  /** Throws when the caller was cancelled. */
  assertActive: () => void;
  /** After each pairing is known, e.g. to save it. */
  onPaired?: () => void;
  sleep: (ms: number) => Promise<void>;
  logger: Logger;
  timedOutEvent: string;
  logFields?: Record<string, unknown>;
}): Promise<string> {
  const startedAt = Date.now();
  let lastError: unknown = null;
  for (;;) {
    args.assertActive();
    try {
      const targetId = args.holder.targetId ?? (await args.pairMachine(args.machineKey)).targetId;
      args.holder.targetId = targetId;
      args.onPaired?.();
      if ((await args.connect(targetId)) !== false) return targetId;
    } catch (error) {
      lastError = error;
      if (/target was not found/i.test(getErrorMessage(error))) args.holder.targetId = null;
    }
    if (Date.now() - startedAt >= CLOUD_JOIN_WATCH_MS) break;
    await args.sleep(CONNECT_RETRY_MS);
  }
  args.logger.warn(args.timedOutEvent, { ...args.logFields, error: lastError ? getErrorMessage(lastError) : null });
  throw new LaunchStepError(`${BRAND.NAME} couldn't connect to the new computer in time.`);
}

/**
 * Deletes only the computers made for one request (its `ade_request_id`),
 * then, once every one is gone, takes the joined one off the account and
 * forgets saved connections to it.
 *
 * `accountRowLeft`: every computer is gone but its account row couldn't be
 * removed; keep the machine key for a later cleanup.
 */
export async function deleteComputersForRequest(args: {
  client: CloudProvider;
  requestId: string;
  knownInstanceId: string | null;
  machineKey: string | null;
  reason: string;
  logger: Logger;
  sleep: (ms: number) => Promise<void>;
  removeAccountMachine: (machineKey: string) => Promise<unknown>;
  forgetMachineConnections?: (args: { machineKey: string | null; instanceId: string }) => void;
  /** `cloud_lane_launch`, `cto_cloud_home`: the start of each log event. */
  logPrefix: string;
  logFields?: Record<string, unknown>;
}): Promise<{ found: number; deleted: number; accountRowLeft: boolean; connectionsForgotten: boolean }> {
  const { client, requestId, knownInstanceId, machineKey, logger, logPrefix } = args;
  const own = new Map<string, CloudInstance>();
  if (knownInstanceId) {
    try {
      const instance = await client.getInstance(knownInstanceId);
      if (instance.metadata.ade_request_id === requestId && instance.status !== "deleted") own.set(instance.id, instance);
    } catch (error) {
      if (!(error instanceof CloudProviderError && error.status === 404)) throw error;
    }
  }
  for (const instance of await client.listInstances()) {
    if (instance.metadata.ade_request_id === requestId && instance.status !== "deleted") own.set(instance.id, instance);
  }
  let deleted = 0;
  for (const instance of own.values()) {
    if (await deleteCloudInstanceConfirmed(client, instance.id, { logger, sleep: args.sleep, reason: args.reason })) {
      deleted += 1;
      logger.info(`${logPrefix}.computer_deleted`, { ...args.logFields, instanceId: instance.id });
    }
  }
  // Every computer is gone, including one deleted elsewhere already (then
  // none is found here): its account row and saved connections go too.
  let accountRowLeft = false;
  let connectionsForgotten = false;
  if (deleted === own.size) {
    if (machineKey) {
      const removed = await args.removeAccountMachine(machineKey).then(() => true, (error: unknown) => {
        logger.warn(`${logPrefix}.account_row_left`, { ...args.logFields, error: getErrorMessage(error) });
        return false;
      });
      accountRowLeft = !removed;
    }
    // A saved connection left behind points at a computer that is gone, and
    // the Connections list shows it as a machine that never answers.
    const gone = new Set([...own.keys(), ...(knownInstanceId ? [knownInstanceId] : [])]);
    for (const instanceId of gone) {
      try {
        args.forgetMachineConnections?.({ machineKey, instanceId });
      } catch (error) {
        logger.warn(`${logPrefix}.connection_left`, { ...args.logFields, error: getErrorMessage(error) });
      }
    }
    connectionsForgotten = gone.size > 0;
  }
  return { found: own.size, deleted, accountRowLeft, connectionsForgotten };
}
