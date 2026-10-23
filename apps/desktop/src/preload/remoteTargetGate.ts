/**
 * Machines this window must not call: the person disconnected them, or another
 * ADE on this computer took the connection. Main refuses such a call anyway.
 * Asking it anyway cost one IPC round trip and one Sentry report for every poll
 * of every pane, for as long as the tab stayed open. Fed by the connection
 * snapshot main pushes to every window.
 */
import type { IpcRenderer } from "electron";
import { IPC } from "../shared/ipc";
import {
  REMOTE_RUNTIME_MANUALLY_DISCONNECTED_MESSAGE,
  type RemoteRuntimeConnectionSnapshot,
} from "../shared/types/remoteRuntime";

export type RemoteTargetGate = {
  /**
   * Invoke a remote-runtime channel for `targetId` unless that machine is
   * disconnected. The refusal has the shape main's own refusal had, so callers
   * read it as before.
   */
  invoke<T>(channel: string, targetId: string, payload: Record<string, unknown>): Promise<T>;
  isDisconnected(targetId: string): Promise<boolean>;
};

const SNAPSHOT_READ_RETRY_MS = 15_000;

export function createRemoteTargetGate(deps: {
  ipcRenderer: Pick<IpcRenderer, "invoke" | "on">;
  /** Called with a machine that was disconnected and now is not. */
  onReconnected: (targetId: string) => void;
}): RemoteTargetGate {
  const disconnected = new Set<string>();
  let updatedAt = 0;
  let firstRead: Promise<void> | null = null;
  let nextReadAfterFailureAt = 0;

  const apply = (snapshot: RemoteRuntimeConnectionSnapshot | null | undefined): void => {
    if (!snapshot || !Array.isArray(snapshot.connections)) return;
    // A push and the first read can cross; the newer snapshot wins.
    if (snapshot.updatedAt < updatedAt) return;
    updatedAt = snapshot.updatedAt;
    const wasDisconnected = new Set(disconnected);
    disconnected.clear();
    for (const connection of snapshot.connections) {
      if (connection?.reconnectBlocked === "disconnected" && connection.target?.id) {
        disconnected.add(connection.target.id);
      }
    }
    for (const targetId of wasDisconnected) {
      if (!disconnected.has(targetId)) deps.onReconnected(targetId);
    }
  };

  deps.ipcRenderer.on(IPC.remoteRuntimeConnectionSnapshotChanged, (_event, payload) => {
    apply(payload as RemoteRuntimeConnectionSnapshot);
  });

  const isDisconnected = async (targetId: string): Promise<boolean> => {
    // One read per window covers a tab restored at launch for a machine that
    // was already disconnected, before any push arrives.
    if (!firstRead && Date.now() >= nextReadAfterFailureAt) {
      firstRead = (
        deps.ipcRenderer.invoke(IPC.remoteRuntimeGetConnectionSnapshot) as Promise<RemoteRuntimeConnectionSnapshot>
      ).then(apply, (error: unknown) => {
        // Read again after a pause; until then, calls go to main, which
        // refuses a disconnected machine itself.
        console.warn("remote target gate: connection snapshot read failed", error);
        nextReadAfterFailureAt = Date.now() + SNAPSHOT_READ_RETRY_MS;
        firstRead = null;
      });
    }
    await firstRead;
    return disconnected.has(targetId);
  };

  return {
    isDisconnected,
    async invoke<T>(channel: string, targetId: string, payload: Record<string, unknown>): Promise<T> {
      if (await isDisconnected(targetId)) {
        throw new Error(
          `Error invoking remote method '${channel}': Error: ${REMOTE_RUNTIME_MANUALLY_DISCONNECTED_MESSAGE}`,
        );
      }
      return (await deps.ipcRenderer.invoke(channel, payload)) as T;
    },
  };
}
