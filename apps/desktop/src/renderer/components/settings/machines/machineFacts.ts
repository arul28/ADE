import { useEffect, useMemo, useState } from "react";
import { THIS_MACHINE_ID } from "../../../../shared/machineIdentity";
import { updateTrackOfVersion, type UpdateTrack } from "../../../../shared/updateTrack";
import { rendererRuntimeTarget } from "../../../lib/platform";
import { useRemoteConnectionSnapshot, type ProjectMachine } from "../../../state/projectMachines";
import { connectedMachinesFromSnapshot, type ConnectedMachine } from "../../remoteTargets/remoteMachineModel";
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
};

let thisColorKey: string | null = null;
let thisColorKeyRead: Promise<string> | null = null;

/** This computer's tile colour: its account machine key, as every device draws it. Read once. */
function readThisColorKey(): Promise<string> {
  thisColorKeyRead ??= Promise.resolve()
    .then(() => (window.ade as { account?: { getLocalMachineIdentity?: () => Promise<{ machineKey?: string }> } })
      .account?.getLocalMachineIdentity?.())
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
    void readThisColorKey().then((next) => {
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
  return useMemo(() => {
    const connected = new Map(connectedMachinesFromSnapshot(snapshot).map((machine) => [machine.id, machine]));
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
        });
        continue;
      }
      const connection = connected.get(machine.machineId) ?? null;
      const version = connection?.version ?? machine.version;
      facts.set(machine.machineId, {
        colorKey: connection?.colorKey ?? machine.machineId,
        platform: machinePlatform(connection?.arch ?? null, machine.hostname),
        version,
        versionLabel: connection?.versionLabel ?? version,
        track: connection?.track ?? updateTrackOfVersion(version),
        connected: connection,
      });
    }
    return facts;
  }, [machines, snapshot, thisKey, thisVersion]);
}
