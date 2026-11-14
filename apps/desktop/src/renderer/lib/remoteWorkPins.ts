import { useCallback, useEffect, useMemo, useState } from "react";
import type { OpenProjectBinding, RemoteRuntimeConnectionSnapshot } from "../../shared/types";
import type { AgentChatRemoteWorkUse } from "../../shared/types/chat";
import type { ChatTerminalSession } from "../../shared/types/sessions";
import type { MachineAddress, MachineConnectResult } from "../../shared/machineAddress";
import { sameMachineKey } from "../../shared/machineAddress";
import { remoteProjectBindingKey } from "../../shared/projectIdentity";
import { useRemoteConnectionSnapshot } from "../state/projectMachines";
import { isAdeAvailable } from "./adeAvailability";
import { normalizePathForComparison } from "./pathUtils";
import { useAppStore } from "../state/appStore";
import { useActiveRepositoryCopies } from "../state/repositoryScope";

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

/**
 * Checkouts on this computer that this window already addresses: the tab's
 * own binding when it is local, and the open repository's copies here. Main
 * runs a local call only for a project root the window knows (its tabs and
 * recents of the same origin), so a pin to one of these is one it accepts.
 */
export type LocalWorkPins = readonly OpenProjectBinding[];

function sameRoot(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normalizePathForComparison(a).replace(/\/+$/, "") === normalizePathForComparison(b).replace(/\/+$/, "");
}

/**
 * The pin for a use's project on this computer, or "unreachable" when the use
 * names no checkout.
 *
 * A chat on another machine that worked here names this computer's checkout
 * by the path its brain saw. A window bound to that other machine has not
 * necessarily opened that folder, and main refuses a local call for a root
 * the window does not know ("Local runtime project is not available for this
 * window"). So a pin this window already holds for that same folder wins;
 * the bare path is the last resort, and its refusal is said in plain words
 * by the panel (`remoteWorkReadErrorText`).
 */
function localRemoteWorkPin(use: AgentChatRemoteWorkUse, localPins: LocalWorkPins = []): RemoteWorkPin {
  if (!use.projectRootPath) return "unreachable";
  const known = localPins.find((pin) => pin.kind === "local" && sameRoot(pin.rootPath, use.projectRootPath));
  if (known) return known;
  return { kind: "local", key: use.projectRootPath, rootPath: use.projectRootPath, displayName: use.machineName };
}

function resolveRemoteWorkPin(
  use: AgentChatRemoteWorkUse,
  snapshot: RemoteRuntimeConnectionSnapshot | null,
  localMachineKey: string | null,
  localPins: LocalWorkPins = [],
): RemoteWorkPin {
  if (!use.projectId || !use.projectRootPath) return "unreachable";
  if (localMachineKey && sameMachineKey(use.machineKey, localMachineKey)) {
    return localRemoteWorkPin(use, localPins);
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

/** This window's own pins on this computer (see `LocalWorkPins`), held by their keys. */
function useLocalWorkPins(active: boolean): LocalWorkPins {
  const binding = useAppStore((state) => state.projectBinding);
  const copies = useActiveRepositoryCopies(active);
  const bindingKey = binding?.kind === "local" ? binding.key : null;
  const copiesKey = copies.map((copy) => (copy.isThisMachine && copy.address?.kind === "local" ? copy.address.key : "")).join("|");
  return useMemo(() => {
    const pins: OpenProjectBinding[] = binding?.kind === "local" ? [binding] : [];
    for (const copy of copies) {
      if (!copy.isThisMachine || copy.address?.kind !== "local") continue;
      if (!pins.some((pin) => pin.key === copy.address!.key)) pins.push(copy.address);
    }
    return pins;
    // Keyed on the pins' keys: a rebuilt list of the same pins is the same list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindingKey, copiesKey]);
}

/**
 * Finds the pin that reaches a use's project on its machine: the desktop's
 * paired connection to it, or this computer's own checkout. "unreachable"
 * when this window has no connection to that machine; nothing is sent then.
 */
export function useRemoteWorkPinResolver(active: boolean): (use: AgentChatRemoteWorkUse) => RemoteWorkPin {
  const { snapshot } = useRemoteConnectionSnapshot(active);
  const localMachineKey = useLocalMachineKey(active);
  const localPins = useLocalWorkPins(active);
  return useCallback(
    (use: AgentChatRemoteWorkUse): RemoteWorkPin => resolveRemoteWorkPin(use, snapshot, localMachineKey, localPins),
    [snapshot, localMachineKey, localPins],
  );
}

/*
 * One connect per machine at a time, whoever asks: the iOS and Android tools
 * of two panes on one chat must not race two pairings of the same machine.
 */
const connectsInFlight = new Map<string, Promise<MachineConnectResult>>();

function connectRemoteWorkMachine(machineKey: string, start: () => Promise<MachineConnectResult>): Promise<MachineConnectResult> {
  for (const [key, existing] of connectsInFlight) {
    if (sameMachineKey(key, machineKey)) return existing;
  }
  const started = start()
    .finally(() => { connectsInFlight.delete(machineKey); });
  connectsInFlight.set(machineKey, started);
  return started;
}

/**
 * "Use it here": the Connections panel's own call (`remoteRuntime.connect` on
 * the saved machine), which takes this app's link back from the other ADE app
 * on this computer that holds it. A window-wide connect, not a project call,
 * so it takes the machine, not a pin.
 */
async function takeBackRemoteWorkLink(machineKey: string, targetId: string): Promise<MachineConnectResult> {
  const result = await window.ade.remoteRuntime.connect(targetId);
  return { ok: true, address: { kind: "remote", machineKey, targetId: result.target.id, name: result.target.name } };
}

/**
 * How a tool reaches the machine a chat's work copy is on.
 *
 * - `pin`: reach it with this pin.
 * - `connecting`: this window is opening its own connection to that machine.
 * - `failed`: it could not; `message` says why, `retry` tries again.
 * - `disconnected`: the person disconnected that machine here; only `retry`
 *   (their click) connects it again.
 * - `held_elsewhere`: another ADE app on this computer (ADE Beta, a dev
 *   build) holds this computer's one link to that machine; `useHere` (their
 *   click) takes it back, as the Connections panel's "Use it here" does.
 * - `unknown`: the use names no project there (an older machine), so there is
 *   nothing to connect to.
 */
export type RemoteWorkReach =
  | { kind: "pin"; pin: OpenProjectBinding }
  | { kind: "connecting"; retry: () => void }
  | { kind: "failed"; message: string; retry: () => void }
  | { kind: "disconnected"; retry: () => void }
  | { kind: "held_elsewhere"; useHere: () => void }
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
  const localPins = useLocalWorkPins(active);
  const [attempt, setAttempt] = useState<ConnectAttempt | null>(null);
  // One per click. `takeBackTargetId` is the saved machine a "Use it here"
  // click takes the link back on; only the connect that click starts uses it.
  const [request, setRequest] = useState<{ nonce: number; takeBackTargetId: string | null }>({ nonce: 0, takeBackTargetId: null });
  // A click is the person's say-so, even over their own Disconnect. It holds
  // for that one connect: a later Disconnect of theirs must win again.
  const [clicked, setClicked] = useState(false);
  const retry = useCallback(() => {
    setClicked(true);
    setRequest((current) => ({ nonce: current.nonce + 1, takeBackTargetId: null }));
  }, []);

  const resolved = resolveRemoteWorkPin(use, snapshot, localMachineKey, localPins);
  const connection = snapshot?.connections.find((entry) =>
    sameMachineKey(entry.target.pairedMachine?.machineKey, use.machineKey)) ?? null;
  const heldTargetId = connection?.state === "error" && connection.recovery === "held_elsewhere"
    ? connection.target.id
    : null;
  const useHere = useCallback(() => {
    setClicked(true);
    setRequest((current) => ({ nonce: current.nonce + 1, takeBackTargetId: heldTargetId }));
  }, [heldTargetId]);
  const reconnectBlocked = connection?.reconnectBlocked ?? null;
  const [blockSeen, setBlockSeen] = useState(reconnectBlocked);
  if (blockSeen !== reconnectBlocked) {
    setBlockSeen(reconnectBlocked);
    setClicked(false);
  }
  // A block in a snapshot from before this window's own connect answered is
  // the one that connect lifted; the next push says whether it still holds.
  const connectedAt = attempt?.phase === "connected" && sameMachineKey(attempt.machineKey, use.machineKey) ? attempt.at : null;
  const blockIsStale = connectedAt !== null && (!snapshot || snapshot.updatedAt <= connectedAt);
  const blocked = reconnectBlocked === "disconnected" && !clicked && !blockIsStale;
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
    const { nonce, takeBackTargetId } = request;
    // Spent on this connect: a later one this click did not start connects plainly.
    if (takeBackTargetId) {
      setRequest((current) => (current.nonce === nonce ? { nonce, takeBackTargetId: null } : current));
    }
    void connectRemoteWorkMachine(machineKey, takeBackTargetId
      ? () => takeBackRemoteWorkLink(machineKey, takeBackTargetId)
      : () => window.ade.machines.connect(machineKey))
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setClicked(false);
        setAttempt(result.ok
          ? { machineKey, phase: "connected", address: result.address, at: Date.now() }
          : { machineKey, phase: "failed", message: result.message });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setAttempt({ machineKey, phase: "failed", message: error instanceof Error ? error.message : String(error) });
      });
    return () => { cancelled = true; };
    // Once per machine and per click: a snapshot push must not connect again,
    // nor spending the take-back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineKey, request.nonce, needsConnect]);

  if (resolved !== "unreachable") return { kind: "pin", pin: resolved };
  if (!hasProject) return { kind: "unknown", retry };
  if (blocked) return heldTargetId ? { kind: "held_elsewhere", useHere } : { kind: "disconnected", retry };
  const current = attempt && sameMachineKey(attempt.machineKey, machineKey) ? attempt : null;
  if (current?.phase === "failed") return { kind: "failed", message: current.message, retry };
  if (current?.phase === "connected") {
    // The connect answered before the snapshot push that lists it: trust its
    // address, keyed like the snapshot's pin so nothing remounts when it lands.
    // A later drop shows in the snapshot, whose own state then wins.
    if (current.address.kind === "this") {
      const local = localRemoteWorkPin(use, localPins);
      return local === "unreachable" ? { kind: "unknown", retry } : { kind: "pin", pin: local };
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

/**
 * A failed read of a chat's device on a machine, in words a person can act
 * on. Never Electron's "Error invoking remote method …" wrapper; the one
 * refusal a same-computer read can hit (a folder this window has not opened)
 * says what to do instead.
 */
export function remoteWorkReadErrorText(error: unknown, machineName: string): string {
  const raw = (error instanceof Error ? error.message : String(error ?? ""))
    .replace(/^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/, "")
    .trim();
  if (/Local runtime project is not available for this window|Local ADE runtime connection is not available/i.test(raw)) {
    return `This window hasn't opened this chat's project folder on ${machineName}. Open that project here once, then try again.`;
  }
  return raw || `${machineName} did not answer.`;
}
