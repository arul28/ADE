/**
 * Where the project's one CTO lives.
 *
 * A project has a single CTO, and its memory, team and thread sit in the `.ade`
 * database of one machine. That machine is the CTO's home, chosen once and then
 * used by every CTO call from every machine the user signs in on.
 *
 * Persistence, in order of authority:
 *
 *  1. The account settings store, under the repository's account scope
 *     (`repo:<normalized origin>`, key `cto.homeMachine`). It is the per-key
 *     last-writer-wins store that already carries account-repo settings between
 *     machines through the Worker, so a choice made on the MacBook is the
 *     answer on the Mac Studio as well.
 *  2. This machine's localStorage, keyed by the same repository identity (or
 *     by the checkout path when the repo has no origin). Always written, so a
 *     signed-out machine, an unreachable brain, or a repo with no origin still
 *     remembers its own choice. It never overrides a readable account value.
 *
 * Machines are recorded by their account-wide identity — the sync device id —
 * because the ids ADE uses for routing (`this-mac`, remote target ids) are
 * local to each desktop and mean different machines on different computers.
 * SSH targets have no device id, so the host name and display name are kept as
 * a fallback join.
 */

import type { ProjectMachine } from "../../lib/projectMachines";
import { accountRepoScopeKey } from "../../../shared/accountSettingsScope";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import type { OpenProjectBinding } from "../../../shared/types";

export const CTO_HOME_SETTING_KEY = "cto.homeMachine";
const LOCAL_STORAGE_KEY = "ade.cto.homeMachine.v1";

export type CtoHomeMachineRecord = {
  version: 1;
  /** Sync device id of the home machine. Null for SSH targets. */
  deviceId: string | null;
  /** The machine's own name, for display on machines that cannot reach it. */
  name: string;
  hostname: string | null;
  chosenAt: string;
};

export function isCtoHomeMachineRecord(value: unknown): value is CtoHomeMachineRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.version === 1
    && (record.deviceId === null || (typeof record.deviceId === "string" && record.deviceId.length > 0))
    && typeof record.name === "string"
    && record.name.trim().length > 0
    && (record.hostname === null || typeof record.hostname === "string")
    && typeof record.chosenAt === "string";
}

/**
 * The key this repository's choice is filed under, in both stores.
 *
 * `accountScope` is null when the repo has no usable origin — such a checkout
 * has no identity another machine could share, so the choice stays local.
 */
export function ctoHomeStorageKeys(args: {
  gitOriginUrl: string | null | undefined;
  binding: OpenProjectBinding | null | undefined;
}): { accountScope: string | null; localKey: string | null } {
  const accountScope = accountRepoScopeKey(args.gitOriginUrl);
  const identity = normalizeGitRemoteIdentity(args.gitOriginUrl);
  if (identity) return { accountScope, localKey: `repo:${identity}` };
  if (args.binding) return { accountScope, localKey: `binding:${args.binding.key}` };
  return { accountScope, localKey: null };
}

function readLocalMap(): Record<string, unknown> {
  try {
    const raw = window.localStorage?.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function readLocalCtoHome(localKey: string | null): CtoHomeMachineRecord | null {
  if (!localKey) return null;
  const value = readLocalMap()[localKey];
  return isCtoHomeMachineRecord(value) ? value : null;
}

export function writeLocalCtoHome(localKey: string | null, record: CtoHomeMachineRecord): void {
  if (!localKey) return;
  try {
    const map = readLocalMap();
    map[localKey] = record;
    window.localStorage?.setItem(LOCAL_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // A full or missing localStorage costs only the offline fallback.
  }
}

/**
 * Read the account's choice. `null` value means "the account has none";
 * `available: false` means the store could not be asked (signed out, no brain,
 * no origin), and the caller should fall back to the local copy.
 */
export async function readAccountCtoHome(
  accountScope: string | null,
  options?: { syncFirst?: boolean },
): Promise<{ available: boolean; value: CtoHomeMachineRecord | null }> {
  const api = typeof window === "undefined" ? null : window.ade?.accountSettings;
  if (!accountScope || !api?.get) return { available: false, value: null };
  try {
    if (options?.syncFirst && api.sync) await api.sync().catch(() => null);
    const result = await api.get({ scope: accountScope, key: CTO_HOME_SETTING_KEY });
    if (!result.ok) return { available: false, value: null };
    return { available: true, value: isCtoHomeMachineRecord(result.value) ? result.value : null };
  } catch {
    return { available: false, value: null };
  }
}

/** Write the choice everywhere it is kept. Local first, so it sticks offline. */
export async function persistCtoHome(args: {
  accountScope: string | null;
  localKey: string | null;
  record: CtoHomeMachineRecord;
}): Promise<{ synced: boolean }> {
  writeLocalCtoHome(args.localKey, args.record);
  const api = typeof window === "undefined" ? null : window.ade?.accountSettings;
  if (!args.accountScope || !api?.set) return { synced: false };
  try {
    const result = await api.set({
      scope: args.accountScope,
      key: CTO_HOME_SETTING_KEY,
      value: args.record,
    });
    return { synced: result.ok === true };
  } catch {
    return { synced: false };
  }
}

/**
 * The record for choosing `machine` as home. This computer is recorded under
 * its real device name, so other machines can name it.
 */
export function ctoHomeRecordFor(
  machine: ProjectMachine,
  thisMachineDeviceName: string | null,
  now: () => number = Date.now,
): CtoHomeMachineRecord {
  const name = machine.isThisMachine
    ? (thisMachineDeviceName?.trim() || machine.name)
    : machine.name;
  return {
    version: 1,
    deviceId: machine.deviceId,
    name,
    hostname: machine.hostname,
    chosenAt: new Date(now()).toISOString(),
  };
}

/**
 * Find the home machine in this desktop's machine list.
 *
 * Device id is the only proof. The host-name and name joins exist for SSH
 * targets, which carry no device id; they are only tried when the record has
 * no device id either, so a paired machine can never be matched by a lookalike
 * name.
 */
export function resolveCtoHomeMachine(
  record: CtoHomeMachineRecord,
  machines: readonly ProjectMachine[],
): ProjectMachine | null {
  if (record.deviceId) {
    return machines.find((machine) => machine.deviceId === record.deviceId) ?? null;
  }
  const hostname = record.hostname?.trim().toLowerCase();
  if (hostname) {
    const byHost = machines.find(
      (machine) => !machine.isThisMachine && machine.hostname?.trim().toLowerCase() === hostname,
    );
    if (byHost) return byHost;
  }
  const name = record.name.trim().toLowerCase();
  return machines.find(
    (machine) => !machine.isThisMachine && machine.deviceId == null && machine.name.trim().toLowerCase() === name,
  ) ?? null;
}

/**
 * The machine to suggest on first run: This computer when it has the repo,
 * otherwise the bound machine, otherwise the first reachable one.
 */
export function suggestCtoHomeMachine(machines: readonly ProjectMachine[]): ProjectMachine | null {
  const candidates = machines.filter((machine) => machine.hasRepo);
  return candidates.find((machine) => machine.isThisMachine && machine.routable)
    ?? candidates.find((machine) => machine.isBound)
    ?? candidates.find((machine) => machine.routable && machine.online)
    ?? null;
}

// ── Last resolution, for surfaces outside the CTO page ─────────────────────

export type CtoHomeResolution =
  | { status: "resolved"; pin: OpenProjectBinding | null; machineName: string; online: boolean }
  | { status: "unreachable"; machineName: string };

const resolutionByScope = new Map<string, CtoHomeResolution>();
const resolutionListeners = new Set<(scopeKey: string) => void>();

/**
 * Remember what the CTO page resolved, keyed by the project tab's state key.
 * The capture gesture host reads it rather than resolving on its own, so it
 * cannot disagree with the page about where the CTO is.
 */
export function rememberCtoHomeResolution(scopeKey: string | null, resolution: CtoHomeResolution | null): void {
  if (!scopeKey) return;
  if (resolution) resolutionByScope.set(scopeKey, resolution);
  else resolutionByScope.delete(scopeKey);
  if (resolution) for (const listener of resolutionListeners) listener(scopeKey);
}

/**
 * The CTO page's resolution for a project tab, waiting for it when the page has
 * not resolved one yet (it is resolving because the caller just opened it).
 * Null when nothing arrives in time; the caller must not guess a machine then.
 */
export function waitForCtoHomeResolution(
  scopeKey: string | null,
  timeoutMs: number,
): Promise<CtoHomeResolution | null> {
  const existing = cachedCtoHomeResolution(scopeKey);
  if (existing || !scopeKey) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const listener = (changed: string) => {
      if (changed !== scopeKey) return;
      cleanup();
      resolve(cachedCtoHomeResolution(scopeKey));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      resolutionListeners.delete(listener);
    };
    resolutionListeners.add(listener);
  });
}

export function cachedCtoHomeResolution(scopeKey: string | null): CtoHomeResolution | null {
  if (!scopeKey) return null;
  return resolutionByScope.get(scopeKey) ?? null;
}
