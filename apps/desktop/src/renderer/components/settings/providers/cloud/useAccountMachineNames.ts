/**
 * The names the account's machine list gives each computer today (a
 * person's custom name, else the name the machine reports), by machine key,
 * so a sign-in card says "From Arul's Mac Studio" and never the user or host
 * name the sign-in was captured under. One read of the shared, cached
 * machine list (`fetchAccountMachines`) when a page opens; no timer. A cloud
 * lane computer's label follows the lane index (`useAdeCloudLaneComputers`),
 * so a lane list that lands later, or a renamed lane, shows without a reopen.
 */
import { useEffect, useMemo, useState } from "react";
import { accountMachineDisplayName } from "../../../../../shared/accountDirectory";
import type { AdeAccountMachine } from "../../../../../shared/types/account";
import type { ProviderLoginStatus } from "../../../../../shared/types/providerLogins";
import { fetchAccountMachines } from "../../../../lib/account";
import { machineLabelForMachine, useAdeCloudLaneComputers } from "../../../../state/adeCloudLaneIndex";

const NO_NAMES: ReadonlyMap<string, string> = new Map();

export function useAccountMachineNames(): ReadonlyMap<string, string> {
  const [machines, setMachines] = useState<readonly AdeAccountMachine[] | null>(null);
  const { computers } = useAdeCloudLaneComputers();
  useEffect(() => {
    let cancelled = false;
    void fetchAccountMachines().then(
      (result) => {
        if (!cancelled && result.state === "ok") setMachines(result.machines);
      },
      // The labels the sign-ins carry stay; nothing else depends on this read.
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return useMemo(() => {
    if (!machines) return NO_NAMES;
    const next = new Map<string, string>();
    for (const machine of machines) {
      const own = accountMachineDisplayName(machine);
      // A cloud lane computer reads "Cloud · <lane>", never its generated name.
      const name = own ? machineLabelForMachine({ machineKey: machine.machineKey, hostname: machine.name, name: own }, computers) : null;
      if (machine.machineKey && name) next.set(machine.machineKey, name);
    }
    return next;
  }, [computers, machines]);
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
