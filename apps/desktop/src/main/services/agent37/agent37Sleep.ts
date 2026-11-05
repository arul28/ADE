/**
 * Sleep and money for Agent 37 machines: turning Agent 37's own idle sleep on
 * for a box once its brain keeps it awake while it works, the person's sleep
 * setting per box, waking a box for use, and the account's monthly cap.
 *
 * Why Agent 37's sleep and not ADE's: Agent 37 sleeps a box once nothing has
 * reached its URLs for the idle timeout, and does it whether or not any ADE
 * window is open, so a laptop that closes never leaves a box billing. Its
 * timer alone would sleep a working brain (the relay is outbound traffic it
 * doesn't count), so the box's brain requests the box's own wake URL while a
 * chat, a command or a setup runs (agent37KeepAwake.ts). ADE turns the sleep
 * on only when that brain is on the box.
 *
 * No Electron here: the desktop and the brain's `agent37` actions share it.
 */

import {
  AGENT37_DEFAULT_MONTHLY_CAP_USD,
  AGENT37_DEFAULT_SLEEP_AFTER_MINUTES,
  AGENT37_SLEEP_METADATA,
  AGENT37_WAKE_PORT,
  AGENT37_WAKE_PORT_LABEL,
  agent37CapReachedMessage,
  agent37SpendingFor,
  isAgent37SleepAfterMinutes,
  type Agent37Budget,
  type Agent37SleepPolicy,
  type Agent37Spending,
  type Agent37WakeForUseResult,
} from "../../../shared/agent37";
import { getErrorMessage } from "../shared/utils";
import { agent37UsageDay, type Agent37Client, type Agent37Instance, type Agent37Logger, type Agent37Usage } from "./agent37Client";
import type { Agent37Vault } from "./agent37Credential";
import { AGENT37_MACHINE_KEY_METADATA } from "./agent37Machines";
import { patchAgent37Metadata, wakeThroughTransition } from "./agent37ReadyClaim";

/** How a box sleeps, read from Agent 37 (the setting lives there, so every computer agrees). */
export function agent37SleepPolicyOf(instance: Pick<Agent37Instance, "autoSleep" | "idleTimeoutSeconds" | "metadata">): Agent37SleepPolicy {
  if (instance.autoSleep) {
    const minutes = instance.idleTimeoutSeconds != null ? Math.max(5, Math.round(instance.idleTimeoutSeconds / 60)) : 15;
    return { state: "auto", afterMinutes: minutes };
  }
  if (instance.metadata[AGENT37_SLEEP_METADATA] === "never") return { state: "never" };
  return { state: "pending" };
}

/**
 * Hands the box its wake URL and reads whether its brain keeps it awake:
 * `keep-awake.json` is written by a brain that pings while it works.
 */
function handOverWakeUrlCommand(instanceId: string, url: string): string {
  // Bound to this machine's id: a copy of the disk (a fork) must not keep this machine awake.
  const json = JSON.stringify({ instanceId, url }).replace(/'/g, "");
  return [
    'd="$ADE_HOME/agent37"',
    'mkdir -p "$d"',
    `printf %s '${json}' > "$d/wake.json.tmp"`,
    'mv "$d/wake.json.tmp" "$d/wake.json"',
    'cat "$d/keep-awake.json" 2>/dev/null || true',
  ].join(" && ");
}

export type Agent37EnableSleepResult =
  /** Agent 37 now sleeps the box after `afterMinutes` with nothing running. */
  | { state: "on"; afterMinutes: number }
  /** The box's ADE predates keeping itself awake; sleep stays off until it updates. */
  | { state: "brain_too_old" }
  /** Not awake now; ADE tries when it is (an exec here would wake it). */
  | { state: "not_running" }
  | { state: "failed"; error: string };

/**
 * Turns Agent 37's idle sleep on for an ADE box: makes its wake URL if it has
 * none, hands the URL to the box, and switches sleep on only when the box's
 * brain says it keeps the box awake while it works. A box that is asleep is
 * left alone unless `wakeIfNeeded` (the person asked).
 */
export async function enableAgent37Sleep(
  client: Agent37Client,
  instanceId: string,
  options: { afterMinutes?: number; wakeIfNeeded?: boolean; logger?: Agent37Logger } = {},
): Promise<Agent37EnableSleepResult> {
  const afterMinutes = isAgent37SleepAfterMinutes(options.afterMinutes) ? options.afterMinutes : AGENT37_DEFAULT_SLEEP_AFTER_MINUTES;
  try {
    const instance = await client.getInstance(instanceId);
    if (instance.status !== "running" && !options.wakeIfNeeded) return { state: "not_running" };
    const wakeUrl = instance.publicPorts.find((port) => port.port === AGENT37_WAKE_PORT)?.url
      ?? (await client.addPublicPort(instanceId, { port: AGENT37_WAKE_PORT, label: AGENT37_WAKE_PORT_LABEL })).url;
    // Exec wakes a sleeping box, which is what `wakeIfNeeded` asks for.
    const handed = await client.exec(instanceId, handOverWakeUrlCommand(instanceId, wakeUrl), { timeoutMs: 60_000 });
    if (handed.exitCode !== 0) return { state: "failed", error: `the box answered with exit ${handed.exitCode}.` };
    let keepsAwake = false;
    try {
      keepsAwake = (JSON.parse(handed.stdout.trim() || "null") as { v?: unknown } | null)?.v === 1;
    } catch {
      keepsAwake = false;
    }
    if (!keepsAwake) {
      options.logger?.info?.("agent37.sleep_brain_too_old", { instanceId });
      return { state: "brain_too_old" };
    }
    await client.setAutoSleep(instanceId, { autoSleep: true, idleTimeoutSeconds: afterMinutes * 60 });
    if (instance.metadata[AGENT37_SLEEP_METADATA] !== "auto") {
      await patchAgent37Metadata(client, instanceId, { [AGENT37_SLEEP_METADATA]: "auto" });
    }
    options.logger?.info?.("agent37.sleep_enabled", { instanceId, afterMinutes });
    return { state: "on", afterMinutes };
  } catch (error) {
    options.logger?.warn?.("agent37.sleep_enable_failed", { instanceId, error: getErrorMessage(error) });
    return { state: "failed", error: getErrorMessage(error) };
  }
}

/** The person's choice for one box: sleep after N minutes, or never. */
export async function setAgent37SleepAfter(
  client: Agent37Client,
  instanceId: string,
  afterMinutes: number | null,
  logger?: Agent37Logger,
): Promise<Agent37EnableSleepResult | { state: "never" }> {
  if (afterMinutes == null) {
    await client.setAutoSleep(instanceId, { autoSleep: false });
    await patchAgent37Metadata(client, instanceId, { [AGENT37_SLEEP_METADATA]: "never" });
    logger?.info?.("agent37.sleep_disabled", { instanceId });
    return { state: "never" };
  }
  const instance = await client.getInstance(instanceId);
  // Already handed its wake URL and keeping itself awake: only the timer changes.
  if (agent37SleepPolicyOf(instance).state === "auto") {
    await client.setAutoSleep(instanceId, { autoSleep: true, idleTimeoutSeconds: afterMinutes * 60 });
    return { state: "on", afterMinutes };
  }
  return await enableAgent37Sleep(client, instanceId, { afterMinutes, wakeIfNeeded: true, logger });
}

/**
 * Turns sleep on for every awake ADE box whose sleep is still pending (made
 * before ADE managed sleep, or whose brain just updated). Asleep boxes wait
 * for their next wake; nothing here wakes a box.
 */
export async function enableAgent37SleepWherePending(
  client: Agent37Client,
  instances: readonly Agent37Instance[],
  options: { logger?: Agent37Logger; skip?: (instance: Agent37Instance) => boolean } = {},
): Promise<Array<{ instanceId: string; result: Agent37EnableSleepResult }>> {
  const results: Array<{ instanceId: string; result: Agent37EnableSleepResult }> = [];
  for (const instance of instances) {
    if (instance.status !== "running" || !instance.metadata[AGENT37_MACHINE_KEY_METADATA]) continue;
    if (agent37SleepPolicyOf(instance).state !== "pending" || options.skip?.(instance)) continue;
    results.push({ instanceId: instance.id, result: await enableAgent37Sleep(client, instance.id, { logger: options.logger }) });
  }
  return results;
}

/** The ADE box whose account row is this machine, or null (not an Agent 37 box, or gone). */
export function agent37InstanceForMachine(
  instances: readonly Agent37Instance[],
  machineKey: string,
  hostname?: string | null,
): Agent37Instance | null {
  const live = instances.filter((instance) => instance.status !== "deleted");
  return live.find((instance) => instance.metadata[AGENT37_MACHINE_KEY_METADATA] === machineKey)
    // Agent 37 sets the hostname to the instance id, for a box signed in by hand.
    ?? (hostname ? live.find((instance) => instance.id === hostname) ?? null : null);
}

/**
 * Wakes the Agent 37 box behind an ADE machine because the person (or an
 * agent) is about to use it: opening one of its lanes, sending to one of its
 * chats, a `--machine` call. At the monthly cap it refuses with the reason.
 */
export async function wakeAgent37MachineForUse(
  client: Agent37Client,
  machine: { machineKey: string; hostname?: string | null },
  options: { spending?: () => Promise<Agent37Spending | null>; logger?: Agent37Logger; now?: () => number } = {},
): Promise<Agent37WakeForUseResult> {
  const now = options.now ?? (() => Date.now());
  const instance = agent37InstanceForMachine(await client.listInstances(), machine.machineKey, machine.hostname);
  if (!instance) return { state: "not_agent37" };
  if (instance.status === "running" || instance.status === "starting" || instance.status === "waking") {
    return { state: "awake", instanceId: instance.id };
  }
  if (instance.pastDue) {
    return { state: "refused", message: "Your Agent 37 wallet is empty, so Agent 37 suspended its machines. Top it up to wake this one." };
  }
  const spending = await options.spending?.().catch(() => null) ?? null;
  if (spending?.capReached) return { state: "refused", message: agent37CapReachedMessage(spending) };
  const started = now();
  await wakeThroughTransition(client, instance.id, now);
  options.logger?.info?.("agent37.machine_woken_for_use", { instanceId: instance.id, wakeMs: now() - started });
  return { state: "woken", instanceId: instance.id, wakeMs: now() - started };
}

/* The monthly cap. */

/** The account vault item for the cap; this computer's copy sits in the shared credential file. */
export const AGENT37_BUDGET_VAULT_KEY = "agent37-budget";
export const AGENT37_BUDGET_MACHINE_CREDENTIAL_KEY = "agent37.budget.v1";

function parseBudget(raw: string | null | undefined): Agent37Budget | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; monthlyCapUsd?: unknown };
    if (parsed?.v !== 1) return null;
    const cap = parsed.monthlyCapUsd;
    if (cap === null) return { monthlyCapUsd: null };
    return typeof cap === "number" && Number.isFinite(cap) && cap > 0 ? { monthlyCapUsd: Math.round(cap * 100) / 100 } : null;
  } catch {
    return null;
  }
}

export type Agent37BudgetStore = {
  read(): Promise<Agent37Budget>;
  write(budget: Agent37Budget): Promise<Agent37Budget>;
};

/** The cap, from the account when it answers, else this computer's copy, else the default. */
export function createAgent37BudgetStore(deps: {
  vault: () => Agent37Vault | null;
  machineStore: () => { getSync(key: string): string | null; setSync(key: string, value: string): void } | null;
  logger?: Agent37Logger;
}): Agent37BudgetStore {
  const local = () => {
    try {
      return deps.machineStore();
    } catch (error) {
      deps.logger?.warn?.("agent37.budget_local_unavailable", { error: getErrorMessage(error) });
      return null;
    }
  };
  return {
    async read() {
      const vault = deps.vault();
      const got = vault ? await vault.get().catch(() => ({ ok: false as const })) : { ok: false as const };
      const fromAccount = got.ok ? parseBudget(got.value) : null;
      if (fromAccount) return fromAccount;
      return parseBudget(local()?.getSync(AGENT37_BUDGET_MACHINE_CREDENTIAL_KEY)) ?? { monthlyCapUsd: AGENT37_DEFAULT_MONTHLY_CAP_USD };
    },
    async write(budget) {
      const cap = budget.monthlyCapUsd;
      if (cap !== null && !(typeof cap === "number" && Number.isFinite(cap) && cap > 0 && cap <= 100_000)) {
        throw new Error("Set the cap to a dollar amount above zero, or turn it off.");
      }
      const next: Agent37Budget = { monthlyCapUsd: cap === null ? null : Math.round(cap * 100) / 100 };
      const raw = JSON.stringify({ v: 1, ...next });
      let savedHere = false;
      try {
        const store = local();
        store?.setSync(AGENT37_BUDGET_MACHINE_CREDENTIAL_KEY, raw);
        savedHere = store != null;
      } catch (error) {
        deps.logger?.warn?.("agent37.budget_local_write_failed", { error: getErrorMessage(error) });
      }
      const vault = deps.vault();
      const saved = vault ? await vault.set(raw).catch(() => false) : false;
      if (!saved && !savedHere) throw new Error("ADE couldn't save the cap to your account or this computer. Try again.");
      return next;
    },
  };
}

/** What the workspace spent this UTC month, from a usage read that covers it. */
export function agent37MonthSpentUsd(usage: Pick<Agent37Usage, "byDay"> | null, nowMs: number): number | null {
  if (!usage) return null;
  const monthStart = `${agent37UsageDay(nowMs).slice(0, 7)}-01`;
  let total = 0;
  for (const [day, usd] of Object.entries(usage.byDay)) {
    if (day >= monthStart) total += usd;
  }
  return total;
}

/** This month against the cap. */
export async function readAgent37Spending(
  budget: Agent37BudgetStore,
  usage: () => Promise<Agent37Usage | null>,
  nowMs: number = Date.now(),
): Promise<Agent37Spending> {
  const [cap, read] = await Promise.all([budget.read(), usage()]);
  return agent37SpendingFor(cap, agent37MonthSpentUsd(read, nowMs));
}
