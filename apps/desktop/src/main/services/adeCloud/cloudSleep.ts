/**
 * Sleep and money for cloud machines: turning the provider's own idle sleep on
 * for a box once its brain keeps it awake while it works, the person's sleep
 * setting per box, waking a box for use, and the account's monthly cap.
 *
 * Why the provider's sleep and not ADE's: the provider sleeps a box once nothing has
 * reached its URLs for the idle timeout, and does it whether or not any ADE
 * window is open, so a laptop that closes never leaves a box billing. Its
 * timer alone would sleep a working brain (the relay is outbound traffic it
 * doesn't count), so the box's brain requests the box's own wake URL while a
 * chat, a command or a setup runs (cloudKeepAwake.ts). ADE turns the sleep
 * on only when that brain is on the box.
 *
 * No Electron here: the desktop and the brain's `cloud` actions share it.
 */

import {
  CLOUD_DEFAULT_AGENT_LIMITS,
  CLOUD_DEFAULT_MONTHLY_CAP_USD,
  CLOUD_DEFAULT_SLEEP_AFTER_MINUTES,
  CLOUD_SLEEP_METADATA,
  CLOUD_WAKE_PORT,
  CLOUD_WAKE_PORT_LABEL,
  cloudCapReachedMessage,
  cloudShape,
  cloudSpendingFor,
  isCloudSleepAfterMinutes,
  type CloudAgentLimits,
  type CloudBudget,
  type CloudSleepPolicy,
  type CloudSpending,
  type CloudWakeForUseResult,
} from "../../../shared/adeCloud";
import { getErrorMessage } from "../shared/utils";
import { cloudUsageDay, type CloudProvider, type CloudInstance, type CloudLogger, type CloudUsage } from "./cloudProvider";
import type { CloudVault } from "./cloudAccess";
import { CLOUD_MACHINE_KEY_METADATA } from "./cloudMachines";
import { patchCloudMetadata, wakeThroughTransition } from "./cloudReadyClaim";

/** How a box sleeps, read from the provider (the setting lives there, so every computer agrees). */
export function cloudSleepPolicyOf(instance: Pick<CloudInstance, "autoSleep" | "idleTimeoutSeconds" | "metadata">): CloudSleepPolicy {
  if (instance.autoSleep) {
    const minutes = instance.idleTimeoutSeconds != null ? Math.max(5, Math.round(instance.idleTimeoutSeconds / 60)) : 15;
    return { state: "auto", afterMinutes: minutes };
  }
  if (instance.metadata[CLOUD_SLEEP_METADATA] === "never") return { state: "never" };
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
    'd="$ADE_HOME/cloud"',
    'mkdir -p "$d"',
    `printf %s '${json}' > "$d/wake.json.tmp"`,
    'mv "$d/wake.json.tmp" "$d/wake.json"',
    'cat "$d/keep-awake.json" 2>/dev/null || true',
  ].join(" && ");
}

export type CloudEnableSleepResult =
  /** the provider now sleeps the box after `afterMinutes` with nothing running. */
  | { state: "on"; afterMinutes: number }
  /** The box's ADE predates keeping itself awake; sleep stays off until it updates. */
  | { state: "brain_too_old" }
  /** Not awake now; ADE tries when it is (an exec here would wake it). */
  | { state: "not_running" }
  | { state: "failed"; error: string };

/**
 * Turns the provider's idle sleep on for an ADE box: makes its wake URL if it has
 * none, hands the URL to the box, and switches sleep on only when the box's
 * brain says it keeps the box awake while it works. A box that is asleep is
 * left alone unless `wakeIfNeeded` (the person asked).
 */
export async function enableCloudSleep(
  client: CloudProvider,
  instanceId: string,
  options: { afterMinutes?: number; wakeIfNeeded?: boolean; logger?: CloudLogger } = {},
): Promise<CloudEnableSleepResult> {
  const afterMinutes = isCloudSleepAfterMinutes(options.afterMinutes) ? options.afterMinutes : CLOUD_DEFAULT_SLEEP_AFTER_MINUTES;
  try {
    const instance = await client.getInstance(instanceId);
    if (instance.status !== "running" && !options.wakeIfNeeded) return { state: "not_running" };
    const wakeUrl = instance.publicPorts.find((port) => port.port === CLOUD_WAKE_PORT)?.url
      ?? (await client.addPublicPort(instanceId, { port: CLOUD_WAKE_PORT, label: CLOUD_WAKE_PORT_LABEL })).url;
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
      options.logger?.info?.("cloud.sleep_brain_too_old", { instanceId });
      return { state: "brain_too_old" };
    }
    await client.setAutoSleep(instanceId, { autoSleep: true, idleTimeoutSeconds: afterMinutes * 60 });
    if (instance.metadata[CLOUD_SLEEP_METADATA] !== "auto") {
      await patchCloudMetadata(client, instanceId, { [CLOUD_SLEEP_METADATA]: "auto" });
    }
    options.logger?.info?.("cloud.sleep_enabled", { instanceId, afterMinutes });
    return { state: "on", afterMinutes };
  } catch (error) {
    options.logger?.warn?.("cloud.sleep_enable_failed", { instanceId, error: getErrorMessage(error) });
    return { state: "failed", error: getErrorMessage(error) };
  }
}

/** The person's choice for one box: sleep after N minutes, or never. */
export async function setCloudSleepAfter(
  client: CloudProvider,
  instanceId: string,
  afterMinutes: number | null,
  logger?: CloudLogger,
): Promise<CloudEnableSleepResult | { state: "never" }> {
  if (afterMinutes == null) {
    await client.setAutoSleep(instanceId, { autoSleep: false });
    await patchCloudMetadata(client, instanceId, { [CLOUD_SLEEP_METADATA]: "never" });
    logger?.info?.("cloud.sleep_disabled", { instanceId });
    return { state: "never" };
  }
  const instance = await client.getInstance(instanceId);
  // Already handed its wake URL and keeping itself awake: only the timer changes.
  if (cloudSleepPolicyOf(instance).state === "auto") {
    await client.setAutoSleep(instanceId, { autoSleep: true, idleTimeoutSeconds: afterMinutes * 60 });
    return { state: "on", afterMinutes };
  }
  return await enableCloudSleep(client, instanceId, { afterMinutes, wakeIfNeeded: true, logger });
}

/**
 * Turns sleep on for every awake ADE box whose sleep is still pending (made
 * before ADE managed sleep, or whose brain just updated). Asleep boxes wait
 * for their next wake; nothing here wakes a box.
 */
export async function enableCloudSleepWherePending(
  client: CloudProvider,
  instances: readonly CloudInstance[],
  options: { logger?: CloudLogger; skip?: (instance: CloudInstance) => boolean } = {},
): Promise<Array<{ instanceId: string; result: CloudEnableSleepResult }>> {
  const results: Array<{ instanceId: string; result: CloudEnableSleepResult }> = [];
  for (const instance of instances) {
    if (instance.status !== "running" || !instance.metadata[CLOUD_MACHINE_KEY_METADATA]) continue;
    if (cloudSleepPolicyOf(instance).state !== "pending" || options.skip?.(instance)) continue;
    results.push({ instanceId: instance.id, result: await enableCloudSleep(client, instance.id, { logger: options.logger }) });
  }
  return results;
}

/** The ADE box whose account row is this machine, or null (not a cloud box, or gone). */
export function cloudInstanceForMachine(
  instances: readonly CloudInstance[],
  machineKey: string,
  hostname?: string | null,
): CloudInstance | null {
  const live = instances.filter((instance) => instance.status !== "deleted");
  return live.find((instance) => instance.metadata[CLOUD_MACHINE_KEY_METADATA] === machineKey)
    // the provider sets the hostname to the instance id, for a box signed in by hand.
    ?? (hostname ? live.find((instance) => instance.id === hostname) ?? null : null);
}

/**
 * Wakes the cloud box behind an ADE machine because the person (or an
 * agent) is about to use it: opening one of its lanes, sending to one of its
 * chats, a `--machine` call. At the monthly cap it refuses with the reason.
 */
export async function wakeCloudMachineForUse(
  client: CloudProvider,
  machine: { machineKey: string; hostname?: string | null },
  options: { spending?: () => Promise<CloudSpending | null>; logger?: CloudLogger; now?: () => number } = {},
): Promise<CloudWakeForUseResult> {
  const now = options.now ?? (() => Date.now());
  // Bounded: this sits in front of a connect, which must not wait on a slow the provider.
  const instances = await Promise.race([
    client.listInstances(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), WAKE_LOOKUP_TIMEOUT_MS).unref?.()),
  ]);
  if (!instances) {
    options.logger?.warn?.("cloud.wake_lookup_timed_out", { timeoutMs: WAKE_LOOKUP_TIMEOUT_MS });
    return { state: "not_cloud" };
  }
  const instance = cloudInstanceForMachine(instances, machine.machineKey, machine.hostname);
  if (!instance) return { state: "not_cloud" };
  if (instance.status === "running") return { state: "awake", instanceId: instance.id };
  // Already coming up (another wake, or the provider's own): its ADE answers in a
  // few seconds, so the caller waits for it the same as after our wake.
  if (instance.status === "starting" || instance.status === "waking") {
    return { state: "woken", instanceId: instance.id, wakeMs: 0 };
  }
  if (instance.pastDue) {
    return { state: "refused", message: "ADE Cloud suspended this machine, so ADE can't wake it right now." };
  }
  const spending = await options.spending?.().catch(() => null) ?? null;
  if (spending?.capReached) return { state: "refused", message: cloudCapReachedMessage(spending) };
  const started = now();
  await wakeThroughTransition(client, instance.id, now);
  options.logger?.info?.("cloud.machine_woken_for_use", { instanceId: instance.id, wakeMs: now() - started });
  return { state: "woken", instanceId: instance.id, wakeMs: now() - started };
}

/** How long a wake for use may spend finding the box before the connect goes ahead as usual. */
const WAKE_LOOKUP_TIMEOUT_MS = 5_000;

/* The monthly cap. */

/** The account vault item for the cap; this computer's copy sits in the shared credential file. */
export const CLOUD_BUDGET_VAULT_KEY = "cloud-budget";
const CLOUD_BUDGET_MACHINE_CREDENTIAL_KEY = "cloud.budget.v1";

function parseAgentLimits(raw: unknown): CloudAgentLimits {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const fallback = CLOUD_DEFAULT_AGENT_LIMITS;
  const perDay = value.machinesPerDay;
  return {
    unattendedSpend: typeof value.unattendedSpend === "boolean" ? value.unattendedSpend : fallback.unattendedSpend,
    machinesPerDay: typeof perDay === "number" && Number.isInteger(perDay) && perDay >= 0 && perDay <= 100 ? perDay : fallback.machinesPerDay,
    maxShape: cloudShape(typeof value.maxShape === "string" ? value.maxShape : null)?.id ?? fallback.maxShape,
  };
}

/** v1 held the cap alone (set by the person); v2 adds what unattended agents may do. */
function parseBudget(raw: string | null | undefined): CloudBudget | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; monthlyCapUsd?: unknown; agents?: unknown };
    if (parsed?.v !== 1 && parsed?.v !== 2) return null;
    const cap = parsed.monthlyCapUsd;
    const agents = parseAgentLimits(parsed.agents);
    if (cap === null) return { monthlyCapUsd: null, agents };
    return typeof cap === "number" && Number.isFinite(cap) && cap > 0 ? { monthlyCapUsd: Math.round(cap * 100) / 100, agents } : null;
  } catch {
    return null;
  }
}

export type CloudBudgetStore = {
  read(): Promise<CloudBudget>;
  write(budget: CloudBudget): Promise<CloudBudget>;
};

/** The cap, from the account when it answers, else this computer's copy, else the default. */
export function createCloudBudgetStore(deps: {
  vault: () => CloudVault | null;
  machineStore: () => { getSync(key: string): string | null; setSync(key: string, value: string): void } | null;
  logger?: CloudLogger;
}): CloudBudgetStore {
  const local = () => {
    try {
      return deps.machineStore();
    } catch (error) {
      deps.logger?.warn?.("cloud.budget_local_unavailable", { error: getErrorMessage(error) });
      return null;
    }
  };
  return {
    async read() {
      const vault = deps.vault();
      const got = vault
        ? await vault.get().catch((error: unknown) => {
          // This computer's copy answers instead.
          deps.logger?.warn?.("cloud.budget_account_read_failed", { error: getErrorMessage(error) });
          return { ok: false as const };
        })
        : { ok: false as const };
      const fromAccount = got.ok ? parseBudget(got.value) : null;
      if (fromAccount) return fromAccount;
      return parseBudget(local()?.getSync(CLOUD_BUDGET_MACHINE_CREDENTIAL_KEY))
        ?? { monthlyCapUsd: CLOUD_DEFAULT_MONTHLY_CAP_USD, agents: CLOUD_DEFAULT_AGENT_LIMITS };
    },
    async write(budget) {
      const cap = budget.monthlyCapUsd;
      if (cap !== null && !(typeof cap === "number" && Number.isFinite(cap) && cap > 0 && cap <= 100_000)) {
        throw new Error("Set the cap to a dollar amount above zero, or turn it off.");
      }
      const next: CloudBudget = { monthlyCapUsd: cap === null ? null : Math.round(cap * 100) / 100, agents: parseAgentLimits(budget.agents) };
      const raw = JSON.stringify({ v: 2, ...next });
      let savedHere = false;
      try {
        const store = local();
        store?.setSync(CLOUD_BUDGET_MACHINE_CREDENTIAL_KEY, raw);
        savedHere = store != null;
      } catch (error) {
        deps.logger?.warn?.("cloud.budget_local_write_failed", { error: getErrorMessage(error) });
      }
      const vault = deps.vault();
      const saved = vault
        ? await vault.set(raw).catch((error: unknown) => {
          deps.logger?.warn?.("cloud.budget_account_write_failed", { error: getErrorMessage(error) });
          return false;
        })
        : false;
      if (!saved && !savedHere) throw new Error("ADE couldn't save the cap to your account or this computer. Try again.");
      return next;
    },
  };
}

/** What the account spent this UTC month, from a usage read that covers it. */
export function cloudMonthSpentUsd(usage: Pick<CloudUsage, "byDay"> | null, nowMs: number): number | null {
  if (!usage) return null;
  const monthStart = `${cloudUsageDay(nowMs).slice(0, 7)}-01`;
  let total = 0;
  for (const [day, usd] of Object.entries(usage.byDay)) {
    if (day >= monthStart) total += usd;
  }
  return total;
}

/** This month against the cap. */
export async function readCloudSpending(
  budget: CloudBudgetStore,
  usage: () => Promise<CloudUsage | null>,
  nowMs: number = Date.now(),
): Promise<CloudSpending> {
  const [cap, read] = await Promise.all([budget.read(), usage()]);
  return cloudSpendingFor(cap, cloudMonthSpentUsd(read, nowMs));
}
