import type { RuntimeUpdateImpact, SyncRemoteCommandDescriptor } from "../../../../desktop/src/shared/types";
import {
  sanitizeMachineName,
  sanitizeUpdateRequestedBy,
  type UpdateRequestClientKind,
  type UpdateRequestedBy,
} from "../../../../desktop/src/shared/types/remoteRuntime";
import type { MachineUpdateAndRestartResult } from "../runtime/machineUpdateAndRestart";

/**
 * "Update & restart" for a phone (or the hosted web client), the sync-command
 * twin of the runtime RPC's `runtime.updateImpact` and
 * `machine.updateAndRestart` that a desktop calls.
 *
 * A phone never opens the runtime RPC channel; it reaches a machine over sync
 * `command` envelopes, on two paths: the focused machine's project host and a
 * roster socket on the brain's own ingress for every other machine. Both call
 * the commands installed here, so the update is the same transaction the
 * desktop's button runs, joined by every caller while one is in flight.
 *
 * Installed by `ade serve` for a machine-owning brain only. An embedded
 * runtime installs nothing, and then neither action is registered or
 * advertised: the phone feature-detects them and keeps "Update ADE there".
 */
export const MACHINE_UPDATE_IMPACT_ACTION = "machine.updateImpact";
export const MACHINE_UPDATE_AND_RESTART_ACTION = "machine.updateAndRestart";
export const MACHINE_UPDATE_REMOTE_COMMAND_ACTIONS = [
  MACHINE_UPDATE_IMPACT_ACTION,
  MACHINE_UPDATE_AND_RESTART_ACTION,
] as const;
export type MachineUpdateRemoteCommandAction = (typeof MACHINE_UPDATE_REMOTE_COMMAND_ACTIONS)[number];

export type MachineUpdateRemoteCommands = {
  /** What a restart would stop on this machine (`readMachineUpdateImpact`). */
  updateImpact(): Promise<RuntimeUpdateImpact>;
  /** The coalesced run (`joinOrStartMachineUpdate`). */
  updateAndRestart(
    targetVersion: string | null,
    requestedBy: UpdateRequestedBy | null,
  ): Promise<MachineUpdateAndRestartResult>;
};

/** The pairing record's fields that name who asked. */
export type MachineUpdatePairing = { peerName?: string | null; peerDeviceType?: string | null };

let configured: MachineUpdateRemoteCommands | null = null;

/** Installs this brain's update commands. Returns the uninstall. */
export function setMachineUpdateRemoteCommands(commands: MachineUpdateRemoteCommands): () => void {
  configured = commands;
  return () => {
    if (configured === commands) configured = null;
  };
}

export function isMachineUpdateRemoteCommandAction(action: string): action is MachineUpdateRemoteCommandAction {
  return action === MACHINE_UPDATE_IMPACT_ACTION || action === MACHINE_UPDATE_AND_RESTART_ACTION;
}

/**
 * Paired controllers (a phone, a browser) only, never a viewer or a lane-share
 * guest: an update stops every chat on the machine. Never queued: a replay
 * after a reconnect would update (and restart) the machine a second time.
 */
export const MACHINE_UPDATE_REMOTE_COMMAND_POLICY = {
  viewerAllowed: false,
  controllerAllowed: true,
  queueable: false,
} as const;

/** The descriptors to advertise, or none when this brain cannot update itself. */
export function machineUpdateRemoteCommandDescriptors(): SyncRemoteCommandDescriptor[] {
  if (!configured) return [];
  return MACHINE_UPDATE_REMOTE_COMMAND_ACTIONS.map((action) => ({
    action,
    scope: "runtime" as const,
    policy: { ...MACHINE_UPDATE_REMOTE_COMMAND_POLICY },
  }));
}

function clientKindOfPeerDeviceType(deviceType: string | null | undefined): UpdateRequestClientKind | null {
  if (deviceType === "phone") return "ios";
  if (deviceType === "browser") return "web";
  return null;
}

/**
 * Who asked, for the logs and the next start's continue message (never the
 * routing). The paired record's name and type win over the client's claim.
 */
export function machineUpdateRequester(claimed: unknown, pairing: MachineUpdatePairing | null): UpdateRequestedBy {
  const claim = sanitizeUpdateRequestedBy(claimed);
  const machineName = sanitizeMachineName(pairing?.peerName) ?? claim?.machineName ?? null;
  const clientKind = clientKindOfPeerDeviceType(pairing?.peerDeviceType) ?? claim?.clientKind ?? "unknown";
  return { ...(machineName ? { machineName } : {}), clientKind };
}

/** Runs one of the two actions with the installed commands. */
export async function runMachineUpdateRemoteCommand(
  action: MachineUpdateRemoteCommandAction,
  args: Record<string, unknown>,
  pairing: MachineUpdatePairing | null,
): Promise<unknown> {
  const commands = configured;
  if (!commands) throw new Error("This ADE runtime cannot update itself.");
  if (action === MACHINE_UPDATE_IMPACT_ACTION) return await commands.updateImpact();
  const targetVersion = typeof args.targetVersion === "string" && args.targetVersion.trim()
    ? args.targetVersion.trim()
    : null;
  return await commands.updateAndRestart(targetVersion, machineUpdateRequester(args.requestedBy, pairing));
}
