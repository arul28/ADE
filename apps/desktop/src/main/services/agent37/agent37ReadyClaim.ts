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
  readAgent37ReadyMachineState,
  type Agent37ReadyClaim,
  type Agent37ReadyMachineState,
} from "../../../shared/agent37";
import { Agent37Error, type Agent37Client, type Agent37Instance, type Agent37Logger } from "./agent37Client";
import { getErrorMessage } from "../shared/utils";
import { AGENT37_MACHINE_KEY_METADATA } from "./agent37Machines";

/** There is no ready machine to take. `code` reaches a CLI caller's JSON. */
export class Agent37NoReadyMachine extends Error {
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
  options: { logger?: Agent37Logger; now?: () => number } = {},
): Promise<Agent37ReadyClaim> {
  const now = options.now ?? (() => Date.now());
  const logger = options.logger ?? {};
  const pool = agent37ReadyMachinesFor(await client.listInstances(), identity);
  const ready = pool.filter((instance) => agent37ReadyStateOf(instance) === "ready" && instance.status !== "failed");
  const pick = ready[0];
  if (!pick) {
    const preparing = pool.some((instance) => agent37ReadyStateOf(instance) === "preparing");
    throw new Agent37NoReadyMachine(
      preparing
        ? "This project's ready machine is still being prepared. Try again in a few minutes, or pick another machine."
        : "This project has no ready machine. Turn on \"Keep a cloud machine ready\" in Settings › Integrations › Agent 37.",
    );
  }
  const claimedAt = now();
  const claimToken = randomUUID();
  const metadata = await patchAgent37Metadata(client, pick.id, {
    [AGENT37_READY_METADATA.state]: "claimed",
    [AGENT37_READY_METADATA.claimedAt]: String(claimedAt),
    [AGENT37_READY_METADATA.claimToken]: claimToken,
  });
  const wakeStarted = now();
  try {
    // A machine that is already awake (a claim right after preparing) answers at once.
    if (pick.status !== "running") await client.startInstance(pick.id);
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
    machineKey: metadata[AGENT37_MACHINE_KEY_METADATA] ?? null,
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
