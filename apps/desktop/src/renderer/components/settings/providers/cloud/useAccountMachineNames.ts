/**
 * The names the account's machine list gives each computer today (a
 * person's custom name, else the name the machine reports), by machine key,
 * so a sign-in card says "From Arul's Mac Studio" and never the user or host
 * name the sign-in was captured under. One read of the shared, cached
 * machine list (`fetchAccountMachines`) when a page opens; no timer.
 */
import { useEffect, useState } from "react";
import { accountMachineDisplayName } from "../../../../../shared/accountDirectory";
import type { ProviderLoginStatus } from "../../../../../shared/types/providerLogins";
import { fetchAccountMachines } from "../../../../lib/account";

const NO_NAMES: ReadonlyMap<string, string> = new Map();

export function useAccountMachineNames(): ReadonlyMap<string, string> {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(NO_NAMES);
  useEffect(() => {
    let cancelled = false;
    void fetchAccountMachines().then(
      (result) => {
        if (cancelled || result.state !== "ok") return;
        const next = new Map<string, string>();
        for (const machine of result.machines) {
          const name = accountMachineDisplayName(machine);
          if (machine.machineKey && name) next.set(machine.machineKey, name);
        }
        setNames(next);
      },
      // The labels the sign-ins carry stay; nothing else depends on this read.
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return names;
}

/** The status with each sign-in's origin named as the account names that machine now. */
export function withMachineNames(status: ProviderLoginStatus, names: ReadonlyMap<string, string>): ProviderLoginStatus {
  if (names.size === 0) return status;
  let changed = false;
  const signIns = status.signIns.map((signIn) => {
    const name = signIn.origin.machineKey ? names.get(signIn.origin.machineKey) : undefined;
    if (!name || name === signIn.origin.label) return signIn;
    changed = true;
    return { ...signIn, origin: { ...signIn.origin, label: name } };
  });
  return changed ? { ...status, signIns } : status;
}
