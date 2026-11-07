/**
 * Claiming a project's ready machine: the half of ready machines that starts a
 * chat, used by the desktop (the machine picker) and the brain (`ade chat
 * create --machine agent37:ready`, the `agent37` action domain). It needs only
 * the Agent37 key, never a window, so it runs anywhere the key is readable.
 *
 * The pool is Agent37's own metadata on each machine (see
 * `AGENT37_READY_METADATA`), so whoever claims and whoever prepares agree
 * without talking to each other. A claim marks the machine `claimed` before it
 * wakes it: from then on it is an ordinary machine of the person's, and the
 * computer that keeps the project's machine ready makes the next one.
 *
 * Account-level: it acts on the Agent37 workspace, not on a lane, chat or
 * machine through its brain, so it takes no pin.
 */

import { randomUUID } from "node:crypto";
import {
  AGENT37_READY_METADATA,
  agent37CapReachedMessage,
  readAgent37ReadyMachineState,
  type Agent37ReadyClaim,
  type Agent37ReadyMachineState,
  type Agent37Spending,
} from "../../../shared/agent37";
import { Agent37Error, type Agent37Client, type Agent37Instance, type Agent37Logger } from "./agent37Client";
import { getErrorMessage } from "../shared/utils";
import { AGENT37_MACHINE_KEY_METADATA } from "./agent37Machines";

/** There is no ready machine to take. `code` reaches a CLI caller's JSON. */
class Agent37NoReadyMachine extends Error {
  readonly code = "agent37_no_ready_machine";
  constructor(message: string) {
    super(message);
    this.name = "Agent37NoReadyMachine";
  }
}

export function agent37ReadyStateOf(instance: Pick<Agent37Instance, "metadata">): Agent37ReadyMachineState | null {
  return readAgent37ReadyMachineState(instance.metadata[AGENT37_READY_METADATA.state]);
}

/** Every live machine in the workspace that belongs to this project's pool, oldest first. */
export function agent37ReadyMachinesFor(instances: readonly Agent37Instance[], identity: string): Agent37Instance[] {
  return instances
    .filter((instance) =>
      instance.metadata[AGENT37_READY_METADATA.project] === identity
      && instance.status !== "deleted"
      && agent37ReadyStateOf(instance) != null)
    .sort((left, right) => (left.created ?? 0) - (right.created ?? 0));
}

/**
 * Writes `patch` into the machine's metadata, keeping every other key (Agent37
 * replaces metadata on write). Reads the machine first, so a key another
 * computer wrote a moment ago survives.
 */
export async function patchAgent37Metadata(
  client: Agent37Client,
  instanceId: string,
  patch: Record<string, string>,
): Promise<Record<string, string>> {
  const instance = await client.getInstance(instanceId);
  const next = { ...instance.metadata, ...patch };
  await client.setInstanceMetadata(instanceId, next);
  return next;
}

/** Agent 37 answers these while a machine is mid-transition (still going to sleep, say). */
const WAKE_TRANSIENT_CODES = new Set(["try_again", "wake_failed", "wake_timeout", "host_mesh_not_ready"]);
/** A machine marked ready a moment ago can take a few seconds to finish going to sleep; kept under the 30 s an IPC call may wait. */
const WAKE_RETRY_DEADLINE_MS = 15_000;
const WAKE_RETRY_DELAY_MS = 500;

/** Wakes (or starts) a box, retrying through Agent 37's "still changing state" answers for a few seconds. */
export async function wakeThroughTransition(client: Agent37Client, instanceId: string, now: () => number = () => Date.now()): Promise<void> {
  const deadline = now() + WAKE_RETRY_DEADLINE_MS;
  for (;;) {
    try {
      await client.startInstance(instanceId);
      return;
    } catch (error) {
      if (!(error instanceof Agent37Error) || !WAKE_TRANSIENT_CODES.has(error.code) || now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, WAKE_RETRY_DELAY_MS));
    }
  }
}

/**
 * Takes the project's oldest ready machine, marks it claimed and wakes it.
 * Resolves once Agent37 answered the wake (the machine is running); the
 * machine's ADE comes online a few seconds later, and the caller waits for
 * that before it sends anything (a machine ADE still shows offline refuses
 * work at once).
 */
export async function claimAgent37ReadyMachine(
  client: Agent37Client,
  identity: string,
  options: { logger?: Agent37Logger; now?: () => number; spending?: () => Promise<Agent37Spending | null> } = {},
): Promise<Agent37ReadyClaim> {
  const now = options.now ?? (() => Date.now());
  const logger = options.logger ?? {};
  // A claim wakes a sleeping machine, and at the cap ADE wakes nothing.
  const month = await options.spending?.().catch(() => null) ?? null;
  if (month?.capReached) throw new Error(agent37CapReachedMessage(month));
  const pool = agent37ReadyMachinesFor(await client.listInstances(), identity);
  const ready = pool.filter((instance) => agent37ReadyStateOf(instance) === "ready" && instance.status !== "failed");
  // Without its ADE machine recorded, no caller can tell which computer it is:
  // tagged failed (the keeper deletes it and prepares another), never handed out.
  for (const broken of ready.filter((instance) => !instance.metadata[AGENT37_MACHINE_KEY_METADATA])) {
    logger.warn?.("agent37.ready_machine_without_key", { instanceId: broken.id });
    await patchAgent37Metadata(client, broken.id, { [AGENT37_READY_METADATA.state]: "failed" }).catch((error: unknown) => {
      // Still skipped here; the next claim tries the tag again.
      logger.warn?.("agent37.ready_mark_failed_failed", { instanceId: broken.id, error: getErrorMessage(error) });
    });
  }
  // Agent 37 has no conditional write, so each candidate is read fresh (still
  // ready?), tagged, and read back: a caller whose token didn't stick lost a
  // race to another caller and moves on to the next machine.
  let pick: Agent37Instance | null = null;
  let pickMachineKey = "";
  let claimToken = "";
  let claimedAt = 0;
  for (const candidate of ready) {
    const machineKey = candidate.metadata[AGENT37_MACHINE_KEY_METADATA];
    if (!machineKey) continue;
    const fresh = await client.getInstance(candidate.id).catch((error: unknown) => {
      logger.warn?.("agent37.ready_claim_read_failed", { instanceId: candidate.id, error: getErrorMessage(error) });
      return null;
    });
    if (!fresh || agent37ReadyStateOf(fresh) !== "ready") continue;
    claimToken = randomUUID();
    claimedAt = now();
    const written = {
      ...fresh.metadata,
      [AGENT37_READY_METADATA.state]: "claimed",
      [AGENT37_READY_METADATA.claimedAt]: String(claimedAt),
      [AGENT37_READY_METADATA.claimToken]: claimToken,
    };
    await client.setInstanceMetadata(fresh.id, written);
    // Unreadable back: ours is the last write we know of, so it is taken (a
    // claimed machine left asleep and unused would never return to the pool).
    const check = await client.getInstance(fresh.id).catch((error: unknown) => {
      logger.warn?.("agent37.ready_claim_read_failed", { instanceId: fresh.id, error: getErrorMessage(error) });
      return null;
    });
    if (!check || check.metadata[AGENT37_READY_METADATA.claimToken] === claimToken) {
      pick = check ?? { ...fresh, metadata: written };
      pickMachineKey = machineKey;
      break;
    }
    logger.info?.("agent37.ready_claim_lost", { instanceId: fresh.id });
  }
  if (!pick) {
    const preparing = pool.some((instance) => agent37ReadyStateOf(instance) === "preparing");
    throw new Agent37NoReadyMachine(
      preparing
        ? "This project's ready machine is still being prepared. Try again in a few minutes, or pick another machine."
        : "This project has no ready machine. Turn on \"Keep a cloud machine ready\" in Settings › Integrations › Agent 37.",
    );
  }
  const metadata = pick.metadata;
  const wakeStarted = now();
  try {
    // A machine that is already awake (a claim right after preparing) answers at once.
    if (pick.status !== "running") await wakeThroughTransition(client, pick.id, now);
  } catch (error) {
    // Not woken, so not taken: put it back for the next chat.
    await patchAgent37Metadata(client, pick.id, { [AGENT37_READY_METADATA.state]: "ready" }).catch((restoreError: unknown) => {
      logger.warn?.("agent37.ready_claim_restore_failed", { instanceId: pick.id, error: getErrorMessage(restoreError) });
    });
    logger.warn?.("agent37.ready_wake_failed", {
      instanceId: pick.id,
      code: error instanceof Agent37Error ? error.code : null,
      error: getErrorMessage(error),
    });
    throw error;
  }
  const wakeMs = now() - wakeStarted;
  logger.info?.("agent37.ready_claimed", { instanceId: pick.id, wakeMs, waitedMs: wakeStarted - claimedAt });
  return {
    instanceId: pick.id,
    machineKey: pickMachineKey,
    name: pick.name ?? pick.id,
    projectPath: metadata[AGENT37_READY_METADATA.path] ?? null,
    laneId: metadata[AGENT37_READY_METADATA.lane] ?? null,
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
export async function releaseAgent37ReadyMachine(
  client: Agent37Client,
  instanceId: string,
  claimToken: string,
  options: { logger?: Agent37Logger; now?: () => number; maxAgeMs?: number } = {},
): Promise<boolean> {
  const now = options.now ?? (() => Date.now());
  const instance = await client.getInstance(instanceId);
  if (agent37ReadyStateOf(instance) !== "claimed") return false;
  if (!claimToken || instance.metadata[AGENT37_READY_METADATA.claimToken] !== claimToken) return false;
  const claimedAt = Number(instance.metadata[AGENT37_READY_METADATA.claimedAt] ?? "");
  if (Number.isFinite(claimedAt) && now() - claimedAt > (options.maxAgeMs ?? 30 * 60_000)) return false;
  await client.setInstanceMetadata(instanceId, { ...instance.metadata, [AGENT37_READY_METADATA.state]: "ready" });
  try {
    await client.sleepInstance(instanceId);
  } catch (error) {
    // Ready but awake: it bills until the next prepare pass sleeps it.
    options.logger?.warn?.("agent37.ready_release_sleep_failed", { instanceId, error: getErrorMessage(error) });
  }
  options.logger?.info?.("agent37.ready_released", { instanceId });
  return true;
}
