import { useEffect, useMemo, useState } from "react";

import { accountMachineDisplayName, accountMachineEndpointHost } from "../../../shared/accountDirectory";
import { findMachineByMentionId } from "../../../shared/accountMachineSnapshot";
import { ROUTE_LABELS } from "../remoteTargets/ConnectionRouteDetails";
import { accountMachinePresence, connectedMachineIds, isMachineConnected } from "../../../shared/machinePresence";
import { formatMachineVersions } from "../../../shared/machineVersions";
import type { AdeAccountMachine } from "../../../shared/types/account";
import { fetchAccountMachines } from "../../lib/account";
import { relativeWhen } from "../../lib/format";
import { useRemoteConnectionSnapshot } from "../../state/projectMachines";

export type MachineFacts = {
  /** The directory machine key, which the Connections rows are keyed by. */
  machineKey: string;
  name: string;
  presence: string;
  presenceState: string;
  thisComputer: boolean;
  version: string | null;
  route: string;
  latency: string | null;
  address: string | null;
};

let localMachineKey: string | null = null;
let localIdentityRead: Promise<string | null> | null = null;

function readLocalMachineKey(): Promise<string | null> {
  if (localMachineKey) return Promise.resolve(localMachineKey);
  localIdentityRead ??= window.ade?.account?.getLocalMachineIdentity?.()
    .then((identity) => {
      localMachineKey = identity?.machineKey?.trim() || null;
      return localMachineKey;
    })
    .catch(() => null)
    .finally(() => { localIdentityRead = null; });
  return localIdentityRead ?? Promise.resolve(null);
}

/**
 * Account-level machine facts shared by transcript and composer machine chips.
 * `undefined` while the directory read is in flight, `null` when the machine is
 * not in it (signed out, removed).
 */
export function useMachineFacts(machineKey: string | null): MachineFacts | null | undefined {
  const { snapshot } = useRemoteConnectionSnapshot(Boolean(machineKey));
  const [directoryMachine, setDirectoryMachine] = useState<AdeAccountMachine | null | undefined>(undefined);
  const [thisMachineKey, setThisMachineKey] = useState<string | null>(localMachineKey);

  useEffect(() => {
    if (!machineKey) return;
    let cancelled = false;
    void Promise.all([fetchAccountMachines(), readLocalMachineKey()]).then(([result, localKey]) => {
      if (cancelled) return;
      // A mention id is the machine key in practice, but can fall back to the
      // device id; resolve it the way the send-time expansion does.
      const machine = result.state === "ok" ? findMachineByMentionId(result.machines, machineKey) : null;
      setDirectoryMachine(machine);
      if (localKey) setThisMachineKey(localKey);
    }).catch(() => {
      if (!cancelled) setDirectoryMachine(null);
    });
    return () => { cancelled = true; };
  }, [machineKey]);

  return useMemo(() => {
    if (!machineKey) return null;
    if (!directoryMachine) return directoryMachine;
    const connected = connectedMachineIds(snapshot?.connections);
    const isConnected = isMachineConnected(directoryMachine, connected);
    const presence = accountMachinePresence(directoryMachine, { connected: isConnected });
    const key = directoryMachine.machineKey;
    const connection = snapshot?.connections.find((item) => (
      item.state === "connected"
      && (item.target.pairedMachine?.machineKey === key || item.target.id === key)
    ));
    const route = connection?.route;
    // The live route's endpoint when connected; otherwise the address another
    // machine would dial first, local network before Tailscale. A relay has no
    // dialable address.
    const advertised = ["lan", "tailnet"]
      .map((kind) => directoryMachine.reachableEndpoints.find((endpoint) => endpoint.kind === kind))
      .find((endpoint) => endpoint && accountMachineEndpointHost(endpoint));
    const advertisedHost = advertised ? accountMachineEndpointHost(advertised) : null;
    const liveAddress = route && route.kind !== "relay" ? route.endpoint.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "") : null;
    const address = liveAddress
      || (advertisedHost ? `${advertisedHost}${advertised?.port ? `:${advertised.port}` : ""}` : null);
    const presenceLabel = presence === "offline"
      ? `Offline${directoryMachine.lastSeenAt ? ` · last seen ${relativeWhen(new Date(directoryMachine.lastSeenAt).toISOString())}` : ""}`
      : presence === "asleep" ? "Asleep" : isConnected ? "Connected" : "Online";
    return {
      machineKey: key,
      name: accountMachineDisplayName(directoryMachine) ?? key.slice(0, 8),
      presence: presenceLabel,
      presenceState: presence,
      thisComputer: Boolean(thisMachineKey && thisMachineKey === key),
      // One version, or both when its app and brain drift.
      version: connection?.version
        ? formatMachineVersions({ brainVersion: connection.version, appVersion: connection.appVersion })
        : connection?.target.runtimeBinaryVersion ?? null,
      route: isConnected ? (route ? ROUTE_LABELS[route.kind] : "Connected") : presenceLabel,
      latency: typeof route?.latencyMs === "number" ? `${Math.round(route.latencyMs)} ms` : null,
      address,
    };
  }, [directoryMachine, machineKey, snapshot, thisMachineKey]);
}
