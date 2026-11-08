import { useEffect, useMemo, useState } from "react";
import { THIS_MACHINE_ID } from "../../../../shared/machineIdentity";
import type { AdeAccountMachine, RemoteRuntimeConnectionStatus } from "../../../../shared/types";
import { updateTrackOfVersion, type UpdateTrack } from "../../../../shared/updateTrack";
import { fetchAccountMachines } from "../../../lib/account";
import { rendererRuntimeTarget } from "../../../lib/platform";
import { useRemoteConnectionSnapshot, type ProjectMachine } from "../../../state/projectMachines";
import { connectedMachinesFromSnapshot, machineColorKey, type ConnectedMachine } from "../../remoteTargets/remoteMachineModel";
import { machinePlatform, type MachinePlatform } from "../../remoteTargets/MachineIdentity";

/**
 * What Settings shows about each machine beside its name: the tile it is
 * drawn with (colour key and platform), its ADE version and its update track.
 * Read from the connection snapshot the machine list already subscribes to,
 * so nothing here polls or asks a machine anything.
 */
export type MachineFacts = {
  colorKey: string;
  platform: MachinePlatform;
  /** The older of its brain and app; null when unknown. */
  version: string | null;
  versionLabel: string | null;
  track: UpdateTrack;
  /** The connection as the snapshot has it, for another machine. */
  connected: ConnectedMachine | null;
  /** The raw connection: its route and the projects it has. Null for This computer. */
  connection: RemoteRuntimeConnectionStatus | null;
};

/** "macOS", "Windows", "Linux" for a Node platform (`process.platform`). */
export function osLabel(platform: string | null | undefined): string | null {
  if (!platform) return null;
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  return platform;
}

/** The same words for a machine's tile platform. */
export function platformWord(platform: MachinePlatform | undefined): string | null {
  if (platform === "mac") return "macOS";
  if (platform === "windows") return "Windows";
  if (platform === "linux") return "Linux";
  return null;
}

let thisColorKey: string | null = null;
let thisColorKeyRead: Promise<string> | null = null;

/**
 * This computer's tile colour: its account machine key, as every device draws
 * it. Read once. `account` is absent in the hosted web client.
 */
export function readThisComputerColorKey(): Promise<string> {
  thisColorKeyRead ??= Promise.resolve()
    .then(() => window.ade.account?.getLocalMachineIdentity?.())
    .then((identity) => identity?.machineKey?.trim() || THIS_MACHINE_ID)
    .catch(() => THIS_MACHINE_ID)
    .then((key) => {
      thisColorKey = key;
      return key;
    });
  return thisColorKeyRead;
}

export function useThisComputerColorKey(): string {
  const [key, setKey] = useState(thisColorKey ?? THIS_MACHINE_ID);
  useEffect(() => {
    let cancelled = false;
    void readThisComputerColorKey().then((next) => {
      if (!cancelled) setKey(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return key;
}

/**
 * Facts for each machine, by machine id. `thisVersion` is This computer's
 * running version (from the update snapshot), which the snapshot of other
 * machines cannot give.
 */
export function useMachineFacts(
  machines: readonly ProjectMachine[],
  thisVersion: string | null,
  active = true,
): ReadonlyMap<string, MachineFacts> {
  const { snapshot } = useRemoteConnectionSnapshot(active);
  const thisKey = useThisComputerColorKey();
  const hasRemoteMachine = machines.some((machine) => !machine.isThisMachine);
  const [directory, setDirectory] = useState<readonly AdeAccountMachine[]>([]);
  useEffect(() => {
    if (!active || !hasRemoteMachine) return;
    let cancelled = false;
    void fetchAccountMachines().then((result) => {
      if (!cancelled && result.state === "ok") setDirectory(result.machines);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [active, hasRemoteMachine]);
  return useMemo(() => {
    const connected = new Map(connectedMachinesFromSnapshot(snapshot).map((machine) => [machine.id, machine]));
    const connections = new Map((snapshot?.connections ?? []).map((connection) => [connection.target.id, connection]));
    const facts = new Map<string, MachineFacts>();
    for (const machine of machines) {
      if (machine.isThisMachine) {
        facts.set(machine.machineId, {
          colorKey: thisKey,
          platform: machinePlatform(rendererRuntimeTarget().platform),
          version: thisVersion,
          versionLabel: thisVersion,
          track: updateTrackOfVersion(thisVersion),
          connected: null,
          connection: null,
        });
        continue;
      }
      const connection = connected.get(machine.machineId) ?? null;
      const version = connection?.version ?? machine.version;
      const rawConnection = connections.get(machine.machineId);
      const machineKey = rawConnection?.target.pairedMachine?.machineKey ?? machine.machineId;
      const accountMachine = directory.find((entry) => entry.machineKey === machineKey
        || (machine.deviceId != null && entry.deviceId === machine.deviceId));
      facts.set(machine.machineId, {
        // The paired key even while the machine is offline: the pickers read
        // its preference under that key, not under the local target id.
        colorKey: connection?.colorKey ?? (() => {
          const target = connections.get(machine.machineId)?.target;
          return target ? machineColorKey(target) : machine.machineId;
        })(),
        platform: machinePlatform(accountMachine?.platform, connection?.arch, machine.hostname),
        version,
        versionLabel: connection?.versionLabel ?? version,
        track: connection?.track ?? updateTrackOfVersion(version),
        connected: connection,
        connection: connections.get(machine.machineId) ?? null,
      });
    }
    return facts;
  }, [directory, machines, snapshot, thisKey, thisVersion]);
}
