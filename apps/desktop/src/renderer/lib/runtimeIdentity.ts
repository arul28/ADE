import type { LocalRuntimeStatus, RemoteRuntimeConnectionSnapshot } from "../../shared/types";

/**
 * Calls `onChange` when the local brain behind this window may be a different
 * one: its connection state changed, or a new process answered.
 *
 * `onRuntimeStatusChanged` also fires as a periodic health heartbeat with the
 * same state and pid. A listener that re-publishes or re-reads on a reconnect
 * must not treat every heartbeat as one.
 */
export function subscribeRuntimeIdentityChanges(onChange: () => void): (() => void) | undefined {
  const subscribe = typeof window === "undefined" ? undefined : window.ade?.app?.onRuntimeStatusChanged;
  if (typeof subscribe !== "function") return undefined;
  let lastIdentity: string | null = null;
  return subscribe((status: LocalRuntimeStatus) => {
    const identity = `${status.connectionState}:${status.pid ?? ""}`;
    if (identity === lastIdentity) return;
    lastIdentity = identity;
    onChange();
  });
}

/**
 * The same for paired remote brains: calls `onChange` when a remote connects,
 * drops, or reconnects (a new `connectedAt`), not on every snapshot.
 */
export function subscribeRemoteRuntimeIdentityChanges(onChange: () => void): (() => void) | undefined {
  const subscribe = typeof window === "undefined" ? undefined : window.ade?.remoteRuntime?.onConnectionSnapshotChanged;
  if (typeof subscribe !== "function") return undefined;
  let lastIdentity: string | null = null;
  return subscribe((snapshot: RemoteRuntimeConnectionSnapshot) => {
    const identity = snapshot.connections
      .map((connection) => `${connection.target.id}:${connection.state}:${connection.connectedAt ?? ""}`)
      .sort()
      .join("|");
    if (identity === lastIdentity) return;
    lastIdentity = identity;
    onChange();
  });
}
