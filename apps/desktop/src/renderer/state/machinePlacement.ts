import { useCallback, useEffect, useSyncExternalStore } from "react";
import { ACCOUNT_SCOPE_ALL } from "../../shared/accountSettingsScope";
import {
  MACHINE_PLACEMENT_SETTING_PREFIX,
  isMachinePlacementRecord,
  machinePlacementSettingKey,
  type MachinePlacementPreference,
  type MachinePlacementRecord,
} from "../../shared/types/machineStats";

/**
 * How often new work should go to each machine: Prefer, Normal, Less often,
 * Manual only. One setting per machine, keyed by its account machine key (the
 * key every device draws its tile with), so every machine and the phone read
 * the same answer without reaching that machine.
 *
 * Kept like the CTO's home machine (`ctoHomeMachine.ts`): this computer's
 * localStorage first, so a signed-out machine, an unreachable brain or an SSH
 * target (no account key) still remembers; then the account settings store
 * (scope `all`, key `machine.placement.<machineKey>`), which carries it to the
 * other machines. A readable account value wins over the local copy when it
 * is newer. A machine with no setting is Normal.
 */

const LOCAL_STORAGE_KEY = "ade.machinePlacement.v1";

let records: Record<string, MachinePlacementRecord> = readLocal();
const listeners = new Set<() => void>();
let accountRead: Promise<void> | null = null;
let stopWatch: (() => void) | null = null;

function readLocal(): Record<string, MachinePlacementRecord> {
  try {
    const raw = typeof window === "undefined" ? null : window.localStorage?.getItem(LOCAL_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => isMachinePlacementRecord(value))) as Record<string, MachinePlacementRecord>;
  } catch {
    return {};
  }
}

function writeLocal(): void {
  try {
    window.localStorage?.setItem(LOCAL_STORAGE_KEY, JSON.stringify(records));
  } catch {
    // A full or missing localStorage costs only the offline copy.
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function newer(a: MachinePlacementRecord | undefined, b: MachinePlacementRecord): boolean {
  return !a || Date.parse(b.updatedAt) > Date.parse(a.updatedAt);
}

/** Read every machine's setting from the account (one list call). */
function readAccount(): Promise<void> {
  const api = typeof window === "undefined" ? undefined : window.ade?.accountSettings;
  if (!api?.list) return Promise.resolve();
  accountRead ??= Promise.resolve()
    .then(() => api.list({ scope: ACCOUNT_SCOPE_ALL }))
    .then((result) => {
      if (!result.ok) return;
      let changed = false;
      const next = { ...records };
      for (const row of result.value) {
        if (!row.key.startsWith(MACHINE_PLACEMENT_SETTING_PREFIX) || !isMachinePlacementRecord(row.value)) continue;
        const machineKey = row.key.slice(MACHINE_PLACEMENT_SETTING_PREFIX.length);
        if (newer(next[machineKey], row.value)) {
          next[machineKey] = row.value;
          changed = true;
        }
      }
      if (changed) {
        records = next;
        writeLocal();
        emit();
      }
    })
    // The local copy stays in use; main reports the failed IPC call itself (ipcCapture.ts).
    .catch(() => undefined)
    .finally(() => {
      accountRead = null;
    });
  return accountRead;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!stopWatch) {
    const onChanged = typeof window === "undefined" ? undefined : window.ade?.accountSettings?.onChanged;
    // Another machine or the phone saved one: read the account again.
    if (typeof onChanged === "function") stopWatch = onChanged(() => void readAccount());
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stopWatch) {
      stopWatch();
      stopWatch = null;
    }
  };
}

function snapshot(): Record<string, MachinePlacementRecord> {
  return records;
}

/** A machine's preference; Normal when it has none or its key is unknown. */
export function machinePlacementPreference(
  all: Record<string, MachinePlacementRecord>,
  machineKey: string | null | undefined,
): MachinePlacementPreference {
  const key = machineKey?.trim();
  return (key && all[key]?.preference) || "normal";
}

/** Save one machine's preference: here first, then to the account. */
export async function setMachinePlacementPreference(
  machineKey: string,
  preference: MachinePlacementPreference,
): Promise<{ synced: boolean }> {
  const record: MachinePlacementRecord = { preference, updatedAt: new Date().toISOString() };
  records = { ...records, [machineKey]: record };
  writeLocal();
  emit();
  const key = machinePlacementSettingKey(machineKey);
  const api = typeof window === "undefined" ? undefined : window.ade?.accountSettings;
  if (!key || !api?.set) return { synced: false };
  try {
    const result = await api.set({ scope: ACCOUNT_SCOPE_ALL, key, value: record });
    return { synced: result.ok === true };
  } catch (error) {
    console.warn("machine_placement.account_save_failed", error instanceof Error ? error.message : String(error));
    return { synced: false };
  }
}

/**
 * Every machine's preference, live: re-read from the account when a surface
 * that shows or weighs them mounts, and whenever the account changes.
 */
export function useMachinePlacementPreferences(active = true): {
  preferenceOf: (machineKey: string | null | undefined) => MachinePlacementPreference;
  setPreference: typeof setMachinePlacementPreference;
} {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (active) void readAccount();
  }, [active]);
  const preferenceOf = useCallback((machineKey: string | null | undefined) => machinePlacementPreference(all, machineKey), [all]);
  return { preferenceOf, setPreference: setMachinePlacementPreference };
}
