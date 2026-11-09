/**
 * Claiming a project's ready machine: the half of ready machines that starts a
 * chat, used by the desktop (the machine picker) and the brain (`ade chat
 * create --machine cloud:ready`, the `cloud` action domain). It needs only
 * ADE Cloud access, never a window, so it runs on any brain of the account.
 *
 * The pool is the provider's own metadata on each machine (see
 * `CLOUD_READY_METADATA`), so whoever claims and whoever prepares agree
 * without talking to each other. A claim marks the machine `claimed` before it
 * wakes it: from then on it is an ordinary machine of the person's, and the
 * computer that keeps the project's machine ready makes the next one.
 *
 * Account-level: it acts on the account's cloud machines, not on a lane, chat or
 * machine through its brain, so it takes no pin.
 */

import { randomUUID } from "node:crypto";
import {
  CLOUD_READY_METADATA,
  readCloudReadyMachineState,
  type CloudReadyClaim,
  type CloudReadyMachineState,
} from "../../../shared/cloudReady";
import { CloudProviderError, type CloudProvider, type CloudInstance, type CloudLogger } from "./cloudProvider";
import { getErrorMessage } from "../shared/utils";
import { CLOUD_MACHINE_KEY_METADATA } from "./cloudMachines";

/** There is no ready machine to take. `code` reaches a CLI caller's JSON. */
class CloudNoReadyMachine extends Error {
  readonly code = "cloud_no_ready_machine";
  constructor(message: string) {
    super(message);
    this.name = "CloudNoReadyMachine";
  }
}

export function cloudReadyStateOf(instance: Pick<CloudInstance, "metadata">): CloudReadyMachineState | null {
  return readCloudReadyMachineState(instance.metadata[CLOUD_READY_METADATA.state]);
}

/** Every live machine on the account that belongs to this project's pool, oldest first. */
export function cloudReadyMachinesFor(instances: readonly CloudInstance[], identity: string): CloudInstance[] {
  return instances
    .filter((instance) =>
      instance.metadata[CLOUD_READY_METADATA.project] === identity
      && instance.status !== "deleted"
      && cloudReadyStateOf(instance) != null)
    .sort((left, right) => (left.created ?? 0) - (right.created ?? 0));
}

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
/** A machine marked ready a moment ago can take a few seconds to finish going to sleep; kept under the 30 s an IPC call may wait. */
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

/**
 * Takes the project's oldest ready machine, marks it claimed and wakes it.
 * Resolves once the provider answered the wake (the machine is running); the
 * machine's ADE comes online a few seconds later, and the caller waits for
 * that before it sends anything (a machine ADE still shows offline refuses
 * work at once).
 */
export async function claimCloudReadyMachine(
  client: CloudProvider,
  identity: string,
  options: { logger?: CloudLogger; now?: () => number } = {},
): Promise<CloudReadyClaim> {
  const now = options.now ?? (() => Date.now());
  const logger = options.logger ?? {};
  const pool = cloudReadyMachinesFor(await client.listInstances(), identity);
  const ready = pool.filter((instance) => cloudReadyStateOf(instance) === "ready" && instance.status !== "failed");
  // Without its ADE machine recorded, no caller can tell which computer it is:
  // tagged failed (the keeper deletes it and prepares another), never handed out.
  for (const broken of ready.filter((instance) => !instance.metadata[CLOUD_MACHINE_KEY_METADATA])) {
    logger.warn?.("cloud.ready_machine_without_key", { instanceId: broken.id });
    await patchCloudMetadata(client, broken.id, { [CLOUD_READY_METADATA.state]: "failed" }).catch((error: unknown) => {
      // Still skipped here; the next claim tries the tag again.
      logger.warn?.("cloud.ready_mark_failed_failed", { instanceId: broken.id, error: getErrorMessage(error) });
    });
  }
  // the provider has no conditional write, so each candidate is read fresh (still
  // ready?), tagged, and read back: a caller whose token didn't stick lost a
  // race to another caller and moves on to the next machine.
  let pick: CloudInstance | null = null;
  let pickMachineKey = "";
  let claimToken = "";
  let claimedAt = 0;
  for (const candidate of ready) {
    const machineKey = candidate.metadata[CLOUD_MACHINE_KEY_METADATA];
    if (!machineKey) continue;
    const fresh = await client.getInstance(candidate.id).catch((error: unknown) => {
      logger.warn?.("cloud.ready_claim_read_failed", { instanceId: candidate.id, error: getErrorMessage(error) });
      return null;
    });
    if (!fresh || cloudReadyStateOf(fresh) !== "ready") continue;
    claimToken = randomUUID();
    claimedAt = now();
    const written = {
      ...fresh.metadata,
      [CLOUD_READY_METADATA.state]: "claimed",
      [CLOUD_READY_METADATA.claimedAt]: String(claimedAt),
      [CLOUD_READY_METADATA.claimToken]: claimToken,
    };
    await client.setInstanceMetadata(fresh.id, written);
    // Unreadable back: ours is the last write we know of, so it is taken (a
    // claimed machine left asleep and unused would never return to the pool).
    const check = await client.getInstance(fresh.id).catch((error: unknown) => {
      logger.warn?.("cloud.ready_claim_read_failed", { instanceId: fresh.id, error: getErrorMessage(error) });
      return null;
    });
    if (!check || check.metadata[CLOUD_READY_METADATA.claimToken] === claimToken) {
      pick = check ?? { ...fresh, metadata: written };
      pickMachineKey = machineKey;
      break;
    }
    logger.info?.("cloud.ready_claim_lost", { instanceId: fresh.id });
  }
  if (!pick) {
    const preparing = pool.some((instance) => cloudReadyStateOf(instance) === "preparing");
    throw new CloudNoReadyMachine(
      preparing
        ? "This project's ready machine is still being prepared. Try again in a few minutes, or pick another machine."
        : "This project has no ready machine. Turn on \"Keep a cloud machine ready\" in Settings › Integrations › ADE Cloud.",
    );
  }
  const metadata = pick.metadata;
  const wakeStarted = now();
  try {
    // A machine that is already awake (a claim right after preparing) answers at once.
    if (pick.status !== "running") await wakeThroughTransition(client, pick.id, now);
  } catch (error) {
    // Not woken, so not taken: put it back for the next chat.
    await patchCloudMetadata(client, pick.id, { [CLOUD_READY_METADATA.state]: "ready" }).catch((restoreError: unknown) => {
      logger.warn?.("cloud.ready_claim_restore_failed", { instanceId: pick.id, error: getErrorMessage(restoreError) });
    });
    logger.warn?.("cloud.ready_wake_failed", {
      instanceId: pick.id,
      code: error instanceof CloudProviderError ? error.code : null,
      error: getErrorMessage(error),
    });
    throw error;
  }
  const wakeMs = now() - wakeStarted;
  logger.info?.("cloud.ready_claimed", { instanceId: pick.id, wakeMs, waitedMs: wakeStarted - claimedAt });
  return {
    instanceId: pick.id,
    machineKey: pickMachineKey,
    name: pick.name ?? pick.id,
    projectPath: metadata[CLOUD_READY_METADATA.path] ?? null,
    laneId: metadata[CLOUD_READY_METADATA.lane] ?? null,
    wakeMs,
    claimToken,
  };
}

/**
 * Gives a claim back before any chat started on it (the person picked another
 * machine, the CLI failed before sending): ready again, and asleep. Only the
 * claim that took it can, by its token, so one caller never sleeps a machine
 * another caller's chat is on. A claim older than `maxAgeMs` is left alone.
 */
export async function releaseCloudReadyMachine(
  client: CloudProvider,
  instanceId: string,
  claimToken: string,
  options: { logger?: CloudLogger; now?: () => number; maxAgeMs?: number } = {},
): Promise<boolean> {
  const now = options.now ?? (() => Date.now());
  const instance = await client.getInstance(instanceId);
  if (cloudReadyStateOf(instance) !== "claimed") return false;
  if (!claimToken || instance.metadata[CLOUD_READY_METADATA.claimToken] !== claimToken) return false;
  const claimedAt = Number(instance.metadata[CLOUD_READY_METADATA.claimedAt] ?? "");
  if (Number.isFinite(claimedAt) && now() - claimedAt > (options.maxAgeMs ?? 30 * 60_000)) return false;
  await client.setInstanceMetadata(instanceId, { ...instance.metadata, [CLOUD_READY_METADATA.state]: "ready" });
  try {
    await client.sleepInstance(instanceId);
  } catch (error) {
    // Ready but awake: it bills until the next prepare pass sleeps it.
    options.logger?.warn?.("cloud.ready_release_sleep_failed", { instanceId, error: getErrorMessage(error) });
  }
  options.logger?.info?.("cloud.ready_released", { instanceId });
  return true;
}
