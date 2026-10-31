import { useCallback, useEffect, useState } from "react";
import type { OpenProjectBinding } from "../../shared/types";
import type { AgentChatRemoteWorkUse } from "../../shared/types/chat";
import type { ChatTerminalSession } from "../../shared/types/sessions";
import { remoteProjectBindingKey } from "../../shared/projectIdentity";
import { useRemoteConnectionSnapshot } from "../state/projectMachines";

/** A pin to the machine a chat works on, or "unreachable" when this window has no connection to it. */
export type RemoteWorkPin = OpenProjectBinding | "unreachable";

/**
 * Finds the pin that reaches a use's project on its machine: the desktop's
 * paired connection to it, or this computer's own checkout. "unreachable"
 * when this window has no connection to that machine; nothing is sent then.
 */
export function useRemoteWorkPinResolver(active: boolean): (use: AgentChatRemoteWorkUse) => RemoteWorkPin {
  const { snapshot } = useRemoteConnectionSnapshot(active);
  const [localMachineKey, setLocalMachineKey] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void window.ade?.account?.getLocalMachineIdentity?.()
      .then((identity) => { if (!cancelled) setLocalMachineKey(identity?.machineKey?.trim() || null); })
      // Without it this computer's own work copies read as "not connected"; say why.
      .catch((error: unknown) => console.warn("[remote-work] could not read this machine's identity", error));
    return () => { cancelled = true; };
  }, [active]);
  return useCallback((use: AgentChatRemoteWorkUse): RemoteWorkPin => {
    if (!use.projectId || !use.projectRootPath) return "unreachable";
    if (localMachineKey && use.machineKey === localMachineKey) {
      return { kind: "local", key: use.projectRootPath, rootPath: use.projectRootPath, displayName: use.machineName };
    }
    const connection = snapshot?.connections.find((entry) =>
      entry.state === "connected" && entry.target.pairedMachine?.machineKey?.trim() === use.machineKey);
    if (!connection) return "unreachable";
    return {
      kind: "remote",
      key: remoteProjectBindingKey(connection.target.id, use.projectId),
      targetId: connection.target.id,
      runtimeName: connection.target.name,
      transport: connection.target.transport ?? "paired",
      hostname: connection.target.hostname,
      projectId: use.projectId,
      rootPath: use.projectRootPath,
      displayName: use.machineName,
    };
  }, [snapshot, localMachineKey]);
}

/** The shells a chat started on `use`'s machine, read there, running ones first. */
export async function listRemoteWorkShells(
  use: AgentChatRemoteWorkUse,
  pin: OpenProjectBinding,
): Promise<ChatTerminalSession[]> {
  const rows = await window.ade.terminal.list({ limit: 200 }, pin);
  const wanted = new Set(use.terminalIds);
  return rows
    .filter((row) => wanted.has(row.terminalId))
    .sort((a, b) => Number(a.status !== "running") - Number(b.status !== "running"));
}
