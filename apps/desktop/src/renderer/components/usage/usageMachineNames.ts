import { useCallback, useSyncExternalStore } from "react";
import type { RemoteRuntimeConnectionSnapshot } from "../../../shared/types";
import { machineLabelForMachine, useAdeCloudLaneComputers } from "../../state/adeCloudLaneIndex";

/**
 * The names usage shows for the computers that reported a reading.
 *
 * A reading names its computer with the label that computer published, and a
 * computer on an older ADE published its network hostname
 * ("MacBook-Pro-567.local"). Settings › Machines names a paired computer by its
 * connection target, which a paired computer matches to the reporter by the
 * same account machine key. So usage takes that name when ADE knows it, and
 * otherwise shows the published label without its `.local` or `.lan` suffix.
 * Only the shown name changes; the reporter keeps its key.
 *
 * Every row and list shares one snapshot read and one subscription.
 */

let names: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;
let newestUpdatedAt = 0;

const HOST_SUFFIX = /\.(?:local|lan)\.?$/i;

/** "MacBook-Pro-567.local" → "MacBook-Pro-567"; any other label as it is. */
export function withoutHostSuffix(label: string): string {
  const trimmed = label.trim();
  const stripped = trimmed.replace(HOST_SUFFIX, "");
  return stripped || trimmed;
}

function apply(snapshot: RemoteRuntimeConnectionSnapshot | null | undefined): void {
  if (!snapshot) return;
  // The bridge can answer the first read after a newer change event.
  if (snapshot.updatedAt < newestUpdatedAt) return;
  newestUpdatedAt = snapshot.updatedAt;
  const next = new Map<string, string>();
  for (const connection of snapshot.connections ?? []) {
    const machineKey = connection.target.pairedMachine?.machineKey?.trim();
    const name = connection.target.name?.trim();
    if (machineKey && name) next.set(machineKey, withoutHostSuffix(name));
  }
  names = next;
  for (const listener of listeners) listener();
}

function start(): void {
  const bridge = typeof window === "undefined" ? undefined : window.ade?.remoteRuntime;
  if (typeof bridge?.getConnectionSnapshot !== "function") return;
  let stopped = false;
  void bridge.getConnectionSnapshot().then((snapshot) => {
    if (!stopped) apply(snapshot);
  }, () => undefined);
  const unsubscribe = typeof bridge.onConnectionSnapshotChanged === "function"
    ? bridge.onConnectionSnapshotChanged((snapshot) => {
        if (!stopped) apply(snapshot);
      })
    : undefined;
  stop = () => {
    stopped = true;
    unsubscribe?.();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stop?.();
      stop = null;
      newestUpdatedAt = 0;
    }
  };
}

const getNames = () => names;

/**
 * The name to show for a reporting computer: the name ADE knows for its key,
 * else its published label without a host suffix.
 */
export function useUsageMachineName(): (machineKey: string | null | undefined, label: string) => string {
  const known = useSyncExternalStore(subscribe, getNames, getNames);
  // Subscribed, so a lane rename or a freed lane computer renames the row at once.
  const { computers } = useAdeCloudLaneComputers();
  return useCallback(
    (machineKey, label) => machineLabelForMachine({
      machineKey: machineKey?.trim() ?? null,
      name: (machineKey ? known.get(machineKey.trim()) : undefined) ?? withoutHostSuffix(label),
    }, computers),
    [computers, known],
  );
}
