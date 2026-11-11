/**
 * Two small provider operations on one cloud machine that several services
 * share: a metadata write that keeps the other keys, and a wake that rides
 * through the provider's "still changing state" answers.
 *
 * Account-level: they act on the account's cloud machines, not on a lane,
 * chat or machine through its brain, so they take no pin.
 */

import { CloudProviderError, type CloudProvider } from "./cloudProvider";

/**
 * Writes `patch` into the machine's metadata, keeping every other key (the provider
 * replaces metadata on write). Reads the machine first, so a key another
 * computer wrote a moment ago survives.
 */
export async function patchCloudMetadata(
  client: CloudProvider,
  instanceId: string,
  patch: Record<string, string>,
): Promise<Record<string, string>> {
  const instance = await client.getInstance(instanceId);
  const next = { ...instance.metadata, ...patch };
  await client.setInstanceMetadata(instanceId, next);
  return next;
}

/** the provider answers these while a machine is mid-transition (still going to sleep, say). */
const WAKE_TRANSIENT_CODES = new Set(["try_again", "wake_failed", "wake_timeout", "host_mesh_not_ready"]);
/** A machine put to sleep a moment ago can take a few seconds to finish going to sleep; kept under the 30 s an IPC call may wait. */
const WAKE_RETRY_DEADLINE_MS = 15_000;
const WAKE_RETRY_DELAY_MS = 500;

/** Wakes (or starts) a box, retrying through the provider's "still changing state" answers for a few seconds. */
export async function wakeThroughTransition(
  client: CloudProvider,
  instanceId: string,
  now: () => number = () => Date.now(),
  options?: { reason?: "push_work" },
): Promise<void> {
  const deadline = now() + WAKE_RETRY_DEADLINE_MS;
  for (;;) {
    try {
      await client.startInstance(instanceId, options);
      return;
    } catch (error) {
      if (!(error instanceof CloudProviderError) || !WAKE_TRANSIENT_CODES.has(error.code) || now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, WAKE_RETRY_DELAY_MS));
    }
  }
}
