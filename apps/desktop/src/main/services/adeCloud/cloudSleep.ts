/**
 * Sleep for cloud machines: turning the provider's own idle sleep on for a box
 * once its brain keeps it awake while it works, waking a box for use, and what
 * unattended agents may do.
 *
 * Why the provider's sleep and not ADE's: the provider sleeps a box once nothing has
 * reached its URLs for the idle timeout, and does it whether or not any ADE
 * window is open, so a laptop that closes never leaves a box awake. Its
 * timer alone would sleep a working brain (the relay is outbound traffic it
 * doesn't count), so the box's brain requests the box's own wake URL while a
 * chat, a command or a setup runs (cloudKeepAwake.ts). ADE turns the sleep
 * on only when that brain is on the box.
 *
 * No Electron here: the desktop and the brain's `cloud` actions share it.
 */

import { CLOUD_PLAN_PAST_DUE_SENTENCE, isCloudRefusalCode, type CloudAgentLimitsUpdate } from "../../../../../account-directory/src/cloud/contract";
import { CloudApiError, type CloudApiClient } from "../../../shared/cloudApiClient";
import { AdeExpectedError } from "../../../shared/expectedError";
import {
  CLOUD_BACKSTOP_SLEEP_MINUTES,
  CLOUD_DEFAULT_AGENT_LIMITS,
  CLOUD_WAKE_PORT,
  CLOUD_WAKE_PORT_LABEL,
  cloudAgentExtraDiskCentsOf,
  cloudShape,
  type CloudAgentLimits,
  type CloudWakeForUseResult,
} from "../../../shared/adeCloud";
import { getErrorMessage } from "../shared/utils";
import { CloudProviderError, type CloudProvider, type CloudInstance, type CloudLogger } from "./cloudProvider";
import type { CloudVault } from "./cloudAccess";
import { CLOUD_MACHINE_KEY_METADATA } from "./cloudMachines";
import { wakeThroughTransition } from "./cloudInstanceOps";
import { cloudSleepPolicyOf } from "../../../shared/cloudMachineOfInstance";

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

/** Shell: keeps the computer awake for `reason` (`holdCloudBusy` in cloudKeepAwake.ts); expires by itself. */
export function cloudHoldCommand(reason: string, ttlMs: number): string {
  return `d="$ADE_HOME/cloud/holds"; mkdir -p "$d"; printf '{"reason":"${reason}","until":%s}' "$(( $(date +%s%3N) + ${Math.round(ttlMs)} ))" > "$d/${reason}.json"`;
}

export function cloudReleaseHoldCommand(reason: string): string {
  return `rm -f "$ADE_HOME/cloud/holds/${reason}.json"`;
}

export type CloudEnableSleepResult =
  /** The provider's timer is on at its floor (`CLOUD_BACKSTOP_SLEEP_MINUTES`); the box's brain sleeps it sooner. */
  | { state: "on" }
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
  options: { wakeIfNeeded?: boolean; logger?: CloudLogger } = {},
): Promise<CloudEnableSleepResult> {
  try {
    const instance = await client.getInstance(instanceId);
    if (instance.status !== "running" && !options.wakeIfNeeded) return { state: "not_running" };
    const wakeUrl = instance.publicPorts.find((port) => port.port === CLOUD_WAKE_PORT)?.url
      ?? (await client.addPublicPort(instanceId, { port: CLOUD_WAKE_PORT, label: CLOUD_WAKE_PORT_LABEL })).url;
    // Exec wakes a sleeping box, which is what `wakeIfNeeded` asks for.
    const handed = await client.exec(instanceId, handOverWakeUrlCommand(instanceId, wakeUrl), { timeoutMs: 60_000 });
    if (handed.exitCode !== 0) return { state: "failed", error: `the computer answered with exit ${handed.exitCode}.` };
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
    await client.setAutoSleep(instanceId, { autoSleep: true, idleTimeoutSeconds: CLOUD_BACKSTOP_SLEEP_MINUTES * 60 });
    options.logger?.info?.("cloud.sleep_enabled", { instanceId });
    return { state: "on" };
  } catch (error) {
    options.logger?.warn?.("cloud.sleep_enable_failed", { instanceId, error: getErrorMessage(error) });
    return { state: "failed", error: getErrorMessage(error) };
  }
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
 * chats, a `--machine` call. Out of hours, the server refuses it.
 */
export async function wakeCloudMachineForUse(
  client: CloudProvider,
  machine: { machineKey: string; hostname?: string | null },
  options: { logger?: CloudLogger; now?: () => number } = {},
): Promise<CloudWakeForUseResult> {
  const now = options.now ?? (() => Date.now());
  // Bounded: this sits in front of a connect, which must not wait on a slow provider.
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
  // The idle cleanup's own short wake makes a computer read running. A use
  // then still calls the start: the server records the use and calls the
  // delete off, or refuses with `computer_deleting`.
  const idleSaving = instance.idleSaving === true;
  if (instance.status === "running" && !idleSaving) return { state: "awake", instanceId: instance.id };
  // Already coming up (another wake, or the provider's own): its ADE answers in a
  // few seconds, so the caller waits for it the same as after our wake.
  if ((instance.status === "starting" || instance.status === "waking") && !idleSaving) {
    return { state: "woken", instanceId: instance.id, wakeMs: 0 };
  }
  if (instance.pastDue) {
    // The server's sentence for `plan_past_due`; the computer list already says it.
    return { state: "refused", code: "plan_past_due", message: CLOUD_PLAN_PAST_DUE_SENTENCE };
  }
  const started = now();
  try {
    await wakeThroughTransition(client, instance.id, now);
  } catch (error) {
    // Hours, disk, a block, too many awake, a delete under way: every refusal
    // carries the server's code and sentence, and the caller shows the sentence.
    if (error instanceof CloudProviderError && isCloudRefusalCode(error.code)) {
      return { state: "refused", code: error.code, message: error.message };
    }
    throw error;
  }
  if (instance.status === "running") return { state: "awake", instanceId: instance.id };
  options.logger?.info?.("cloud.machine_woken_for_use", { instanceId: instance.id, wakeMs: now() - started });
  return { state: "woken", instanceId: instance.id, wakeMs: now() - started };
}

/** How long a wake for use may spend finding the box before the connect goes ahead as usual. */
const WAKE_LOOKUP_TIMEOUT_MS = 5_000;

/* What unattended agents may do, kept in the account. */

/** The account vault item; the name dates from when it also held a dollar cap. This computer's copy sits in the shared credential file. */
export const CLOUD_AGENT_LIMITS_VAULT_KEY = "cloud-budget";
const CLOUD_AGENT_LIMITS_MACHINE_CREDENTIAL_KEY = "cloud.budget.v1";

function parseAgentLimits(raw: unknown): CloudAgentLimits {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const fallback = CLOUD_DEFAULT_AGENT_LIMITS;
  const perDay = value.machinesPerDay;
  return {
    unattendedSpend: typeof value.unattendedSpend === "boolean" ? value.unattendedSpend : fallback.unattendedSpend,
    machinesPerDay: typeof perDay === "number" && Number.isInteger(perDay) && perDay >= 0 && perDay <= 100 ? perDay : fallback.machinesPerDay,
    maxShape: cloudShape(typeof value.maxShape === "string" ? value.maxShape : null)?.id ?? fallback.maxShape,
    // Left out (limits saved before it) is the account's own extra-disk limit.
    extraDiskMonthCents: cloudAgentExtraDiskCentsOf(value.extraDiskMonthCents),
  };
}

/** v2 also held the dollar cap, now gone; only the agents part is read. */
function parseStoredLimits(raw: string | null | undefined): CloudAgentLimits | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; agents?: unknown };
    if (parsed?.v !== 2 && parsed?.v !== 3) return null;
    return parseAgentLimits(parsed.agents);
  } catch {
    return null;
  }
}

export type CloudAgentLimitsStore = {
  read(): Promise<CloudAgentLimits>;
  /** The whole value to the account vault item and this computer's copy: for a signed-out ADE or an older server. */
  write(limits: CloudAgentLimits): Promise<CloudAgentLimits>;
  /**
   * Saves only the changed fields on the account server (`PUT /cloud/limits`),
   * which merges them into the stored value (a newer ADE's fields stay) and
   * refuses a change made in between (`ifRevision`). This computer's copy
   * changes only after the server accepts. Null: signed out, or an older
   * server without the route, so the caller uses `write`. A refusal or a
   * failure throws the sentence (an expected error), and nothing is saved.
   */
  save?(changes: Partial<CloudAgentLimits>): Promise<CloudAgentLimits | null>;
};

/** The account server's limits routes; null when signed out or with no account service here. */
type CloudAgentLimitsApi = Pick<CloudApiClient, "agentLimits" | "saveAgentLimits">;

/** From the account when it answers, else this computer's copy, else the default (marked `fallback` when the account didn't answer). */
export function createCloudAgentLimitsStore(deps: {
  vault: () => CloudVault | null;
  machineStore: () => { getSync(key: string): string | null; setSync(key: string, value: string): void } | null;
  /** The account server, for `save`; null signed out. Left out: `save` always answers null. */
  accountApi?: () => CloudAgentLimitsApi | null;
  logger?: CloudLogger;
}): Required<CloudAgentLimitsStore> {
  const local = () => {
    try {
      return deps.machineStore();
    } catch (error) {
      deps.logger?.warn?.("cloud.agent_limits_local_unavailable", { error: getErrorMessage(error) });
      return null;
    }
  };
  /** This computer's copy only, after the account server saved the value itself. */
  const keepHere = (limits: CloudAgentLimits): CloudAgentLimits => {
    const next = parseAgentLimits(limits);
    try {
      local()?.setSync(CLOUD_AGENT_LIMITS_MACHINE_CREDENTIAL_KEY, JSON.stringify({ v: 3, agents: next }));
    } catch (error) {
      // The account holds the value; this copy only answers while the account can't.
      deps.logger?.warn?.("cloud.agent_limits_local_write_failed", { error: getErrorMessage(error) });
    }
    return next;
  };
  return {
    async read() {
      const vault = deps.vault();
      const got = vault
        ? await vault.get().catch((error: unknown) => {
          // This computer's copy answers instead.
          deps.logger?.warn?.("cloud.agent_limits_account_read_failed", { error: getErrorMessage(error) });
          return { ok: false as const };
        })
        : { ok: false as const };
      const fromAccount = got.ok ? parseStoredLimits(got.value) : null;
      if (fromAccount) return fromAccount;
      const here = parseStoredLimits(local()?.getSync(CLOUD_AGENT_LIMITS_MACHINE_CREDENTIAL_KEY)) ?? CLOUD_DEFAULT_AGENT_LIMITS;
      // The account answered and has nothing saved: these are the limits. Else
      // another computer may have saved stricter ones (`fallback`).
      return got.ok && got.value == null ? here : { ...here, fallback: true };
    },
    async write(limits) {
      const next = parseAgentLimits(limits);
      const raw = JSON.stringify({ v: 3, agents: next });
      let savedHere = false;
      try {
        const store = local();
        store?.setSync(CLOUD_AGENT_LIMITS_MACHINE_CREDENTIAL_KEY, raw);
        savedHere = store != null;
      } catch (error) {
        deps.logger?.warn?.("cloud.agent_limits_local_write_failed", { error: getErrorMessage(error) });
      }
      const vault = deps.vault();
      const saved = vault
        ? await vault.set(raw).catch((error: unknown) => {
          deps.logger?.warn?.("cloud.agent_limits_account_write_failed", { error: getErrorMessage(error) });
          return false;
        })
        : false;
      if (!saved && !savedHere) throw new Error("ADE couldn't save that to your account or this computer. Try again.");
      return next;
    },
    async save(changes) {
      const api = deps.accountApi?.() ?? null;
      if (!api) return null;
      try {
        const current = await api.agentLimits();
        if (!current) return null;
        // Nothing changed: the stored value is the answer (the server refuses an empty change).
        if (Object.keys(changes).length === 0) return keepHere({ ...current.limits } as CloudAgentLimits);
        const saved = await api.saveAgentLimits({
          limits: changes as CloudAgentLimitsUpdate["limits"],
          ifRevision: current.revision,
        });
        return saved ? keepHere({ ...saved.limits } as CloudAgentLimits) : null;
      } catch (error) {
        if (error instanceof CloudApiError && error.status >= 400 && error.status < 500 && error.message) {
          // The server's own sentence (`limits_changed`, `limits_unreadable`, a blocked account): no Report.
          throw Object.assign(new AdeExpectedError(error.message, "user"), { code: error.code || null });
        }
        deps.logger?.warn?.("cloud.agent_limits_server_write_failed", { error: getErrorMessage(error) });
        throw new AdeExpectedError("ADE couldn't reach your ADE account to save your agent limits. Try again.", "network");
      }
    },
  };
}

/** The fields of `next` that differ from `current`: what a save sends, so the server keeps every other field. */
export function cloudAgentLimitsChanges(current: CloudAgentLimits, next: CloudAgentLimits): Partial<CloudAgentLimits> {
  const changes: Partial<CloudAgentLimits> = {};
  if (next.unattendedSpend !== current.unattendedSpend) changes.unattendedSpend = next.unattendedSpend;
  if (next.machinesPerDay !== current.machinesPerDay) changes.machinesPerDay = next.machinesPerDay;
  if (next.maxShape !== current.maxShape) changes.maxShape = next.maxShape;
  if ((next.extraDiskMonthCents ?? null) !== (current.extraDiskMonthCents ?? null)) changes.extraDiskMonthCents = next.extraDiskMonthCents ?? null;
  return changes;
}
