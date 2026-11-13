import { useCallback, useEffect, useState } from "react";
import type { OpenProjectBinding, RemoteRuntimeConnectionSnapshot } from "../../shared/types";
import type { AgentChatRemoteWorkUse } from "../../shared/types/chat";
import type { ChatTerminalSession } from "../../shared/types/sessions";
import type { MachineAddress, MachineConnectResult } from "../../shared/machineAddress";
import { sameMachineKey } from "../../shared/machineAddress";
import { remoteProjectBindingKey } from "../../shared/projectIdentity";
import { useRemoteConnectionSnapshot } from "../state/projectMachines";
import { isAdeAvailable } from "./adeAvailability";

/** A pin to the machine a chat works on, or "unreachable" when this window has no connection to it. */
export type RemoteWorkPin = OpenProjectBinding | "unreachable";

function remoteWorkPinOn(
  use: AgentChatRemoteWorkUse,
  target: { id: string; name: string; transport?: "ssh" | "paired"; hostname?: string },
): OpenProjectBinding | "unreachable" {
  if (!use.projectId || !use.projectRootPath) return "unreachable";
  return {
    kind: "remote",
    key: remoteProjectBindingKey(target.id, use.projectId),
    targetId: target.id,
    runtimeName: target.name,
    transport: target.transport ?? "paired",
    ...(target.hostname ? { hostname: target.hostname } : {}),
    projectId: use.projectId,
    rootPath: use.projectRootPath,
    displayName: use.machineName,
  };
}

function resolveRemoteWorkPin(
  use: AgentChatRemoteWorkUse,
  snapshot: RemoteRuntimeConnectionSnapshot | null,
  localMachineKey: string | null,
): RemoteWorkPin {
  if (!use.projectId || !use.projectRootPath) return "unreachable";
  if (localMachineKey && sameMachineKey(use.machineKey, localMachineKey)) {
    return { kind: "local", key: use.projectRootPath, rootPath: use.projectRootPath, displayName: use.machineName };
  }
  const connection = snapshot?.connections.find((entry) =>
    entry.state === "connected" && sameMachineKey(entry.target.pairedMachine?.machineKey, use.machineKey));
  if (!connection) return "unreachable";
  return remoteWorkPinOn(use, connection.target);
}

function useLocalMachineKey(active: boolean): string | null {
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
  return localMachineKey;
}

/**
 * Finds the pin that reaches a use's project on its machine: the desktop's
 * paired connection to it, or this computer's own checkout. "unreachable"
 * when this window has no connection to that machine; nothing is sent then.
 */
export function useRemoteWorkPinResolver(active: boolean): (use: AgentChatRemoteWorkUse) => RemoteWorkPin {
  const { snapshot } = useRemoteConnectionSnapshot(active);
  const localMachineKey = useLocalMachineKey(active);
  return useCallback(
    (use: AgentChatRemoteWorkUse): RemoteWorkPin => resolveRemoteWorkPin(use, snapshot, localMachineKey),
    [snapshot, localMachineKey],
  );
}

/*
 * One connect per machine at a time, whoever asks: the iOS and Android tools
 * of two panes on one chat must not race two pairings of the same machine.
 */
const connectsInFlight = new Map<string, Promise<MachineConnectResult>>();

function connectRemoteWorkMachine(machineKey: string): Promise<MachineConnectResult> {
  const key = machineKey.trim().toLowerCase();
  const existing = connectsInFlight.get(key);
  if (existing) return existing;
  const started = window.ade.machines.connect(machineKey)
    .finally(() => { connectsInFlight.delete(key); });
  connectsInFlight.set(key, started);
  return started;
}

/**
 * How a tool reaches the machine a chat's work copy is on.
 *
 * - `pin`: reach it with this pin.
 * - `connecting`: this window is opening its own connection to that machine.
 * - `failed`: it could not; `message` says why, `retry` tries again.
 * - `disconnected`: the person disconnected that machine here; only `retry`
 *   (their click) connects it again.
 * - `unknown`: the use names no project there (an older machine), so there is
 *   nothing to connect to.
 */
export type RemoteWorkReach =
  | { kind: "pin"; pin: OpenProjectBinding }
  | { kind: "connecting"; retry: () => void }
  | { kind: "failed"; message: string; retry: () => void }
  | { kind: "disconnected"; retry: () => void }
  | { kind: "unknown"; retry: () => void };

type ConnectAttempt =
  | { machineKey: string; phase: "connecting" }
  | { machineKey: string; phase: "failed"; message: string }
  | { machineKey: string; phase: "connected"; address: MachineAddress; at: number };

/**
 * The pin for a chat's work copy on another machine, connecting this window
 * to that machine when it has no connection of its own.
 *
 * The agent's commands go brain to brain, so the chat can drive a machine
 * this window never connected to; the tool that shows its device then has
 * nothing to read through. Mount this only where the tool is on screen: it
 * connects once when mounted (and on `retry`), never in the background, and
 * never when the person disconnected that machine themselves.
 */
export function useRemoteWorkReach(use: AgentChatRemoteWorkUse, active: boolean): RemoteWorkReach {
  const { snapshot, loaded } = useRemoteConnectionSnapshot(active);
  const localMachineKey = useLocalMachineKey(active);
  const [attempt, setAttempt] = useState<ConnectAttempt | null>(null);
  const [nonce, setNonce] = useState(0);
  // A click is the person's say-so, even over their own Disconnect.
  const [clicked, setClicked] = useState(false);
  const retry = useCallback(() => {
    setClicked(true);
    setNonce((value) => value + 1);
  }, []);

  const resolved = resolveRemoteWorkPin(use, snapshot, localMachineKey);
  const connection = snapshot?.connections.find((entry) =>
    sameMachineKey(entry.target.pairedMachine?.machineKey, use.machineKey)) ?? null;
  const blocked = connection?.reconnectBlocked === "disconnected" && !clicked;
  const hasProject = Boolean(use.projectId && use.projectRootPath);
  const needsConnect = active && loaded && hasProject && resolved === "unreachable" && !blocked;
  const machineKey = use.machineKey;

  useEffect(() => {
    if (!needsConnect) return undefined;
    if (!isAdeAvailable(window.ade?.machines) || !isAdeAvailable(window.ade.machines.connect)) {
      setAttempt({ machineKey, phase: "failed", message: "This window can't open connections to other machines." });
      return undefined;
    }
    let cancelled = false;
    setAttempt({ machineKey, phase: "connecting" });
    void connectRemoteWorkMachine(machineKey)
      .then((result) => {
        if (cancelled) return;
        setAttempt(result.ok
          ? { machineKey, phase: "connected", address: result.address, at: Date.now() }
          : { machineKey, phase: "failed", message: result.message });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setAttempt({ machineKey, phase: "failed", message: error instanceof Error ? error.message : String(error) });
      });
    return () => { cancelled = true; };
    // Once per machine and per click: a snapshot push must not connect again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineKey, nonce, needsConnect]);

  if (resolved !== "unreachable") return { kind: "pin", pin: resolved };
  if (!hasProject) return { kind: "unknown", retry };
  if (blocked) return { kind: "disconnected", retry };
  const current = attempt && sameMachineKey(attempt.machineKey, machineKey) ? attempt : null;
  if (current?.phase === "failed") return { kind: "failed", message: current.message, retry };
  if (current?.phase === "connected") {
    // The connect answered before the snapshot push that lists it: trust its
    // address, keyed like the snapshot's pin so nothing remounts when it lands.
    // A later drop shows in the snapshot, whose own state then wins.
    if (current.address.kind === "this") {
      return { kind: "pin", pin: { kind: "local", key: use.projectRootPath!, rootPath: use.projectRootPath!, displayName: use.machineName } };
    }
    const sameTarget = connection?.target.id === current.address.targetId ? connection : null;
    // An error the snapshot reported after this connect answered is newer than it.
    if (sameTarget?.state === "error" && snapshot && snapshot.updatedAt > current.at) {
      return { kind: "failed", message: sameTarget.lastErrorInfo?.message || sameTarget.lastError || `${use.machineName} did not answer.`, retry };
    }
    const pin = remoteWorkPinOn(use, { id: current.address.targetId, name: current.address.name });
    if (pin !== "unreachable") return { kind: "pin", pin };
  }
  return { kind: "connecting", retry };
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
