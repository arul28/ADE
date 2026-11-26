import type { RemoteRuntimeConnectionStatus, RemoteRuntimeUpdateBlock } from "../../../shared/types";
import { isMachineVersionCurrent, machineUpdateTrack, type ConnectedMachine } from "./remoteMachineModel";
import { updateTrackOfVersion } from "../../../shared/updateTrack";

// ---------------------------------------------------------------------------
// Where an "Update & restart" sent to another machine stands: in flight,
// landed, or failed (and why). Every update surface reads it from here.
// ---------------------------------------------------------------------------

/**
 * What "Update & restart" left behind for one machine. The host's reply is not
 * the outcome: an update that is still in flight (`pendingVersion`) is only
 * done when the machine comes back reporting that version.
 */
export type MachineUpdateAttempt = {
  ok: boolean;
  message: string;
  /** The version the machine should come back on; null when nothing is in flight. */
  pendingVersion: string | null;
  /** True while the far app is still downloading, which takes longer to land. */
  downloading: boolean;
  startedAtMs: number;
  updateInstallMode?: RemoteRuntimeConnectionStatus["updateInstallMode"];
  downloadUrl?: string | null;
};

/** Long enough for an app swap plus the brain restart behind it. */
export const MACHINE_UPDATE_INSTALL_GRACE_MS = 5 * 60_000;
/** A download first, then the same install. */
export const MACHINE_UPDATE_DOWNLOAD_GRACE_MS = 35 * 60_000;
/**
 * How long a brain that restarted after the update was sent must stay up on
 * the old version before the update counts as failed. An install restarts the
 * brain more than once (the old one stops, the new one starts after the files
 * are swapped); a minute on the old version is past every step of a working
 * install.
 */
export const MACHINE_UPDATE_OLD_BRAIN_SETTLE_MS = 60_000;
/** How often an in-flight update's card looks again, so the rule above lands on time. */
export const MACHINE_UPDATE_RECHECK_MS = 15_000;

/**
 * `hostUpdateBlock.at` is this computer's clock rebuilt from an age, so it can
 * land a little before the attempt that it belongs to.
 */
const UPDATE_BLOCK_CLOCK_SLACK_MS = 30_000;

export function machineUpdateGraceMs(attempt: MachineUpdateAttempt): number {
  return attempt.downloading ? MACHINE_UPDATE_DOWNLOAD_GRACE_MS : MACHINE_UPDATE_INSTALL_GRACE_MS;
}

/** Turn the host's reply into an attempt the card can check against the machine. */
export function machineUpdateAttemptFromResult(
  result: {
    ok: boolean;
    message?: string | null;
    updateApplied?: boolean;
    targetVersion?: string | null;
    route?: string;
    pendingVersion?: string | null;
    updateInstallMode?: RemoteRuntimeConnectionStatus["updateInstallMode"];
    downloadUrl?: string | null;
  },
  fallbackMessage: string,
  nowMs: number,
): MachineUpdateAttempt {
  // Hosts from before `pendingVersion` only had the standalone route, where an
  // applied update means the target is what should come back.
  const pendingVersion = !result.ok
    ? null
    : result.pendingVersion !== undefined
      ? result.pendingVersion?.trim() || null
      : result.updateApplied
        ? result.targetVersion?.trim() || null
        : null;
  return {
    ok: result.ok,
    message: result.message?.trim() || fallbackMessage,
    pendingVersion,
    // The terminal route has staged the runtime but still downloads the app
    // installer, so it gets the download grace too.
    downloading: result.ok
      && (result.route === "desktop_app" || result.route === "terminal")
      && result.updateApplied === false
      && pendingVersion != null,
    startedAtMs: nowMs,
    updateInstallMode: result.updateInstallMode,
    downloadUrl: result.downloadUrl,
  };
}

export type MachineUpdateStatus = {
  ok: boolean;
  message: string;
  /** Still waiting on the machine; the card keeps "Update & restart" busy. */
  inFlight: boolean;
};

/**
 * Check an attempt against the machine as it is now. Landed: the machine
 * reports the version (or newer). Not landed in time: say so plainly, with
 * the version it is actually on, instead of leaving "reconnecting…" up.
 */
export function describeMachineUpdateAttempt(
  attempt: MachineUpdateAttempt,
  machine: Pick<ConnectedMachine, "version" | "track" | "appTrack" | "hostStartedAt" | "hostUpdateBlock"> & { connected: boolean },
  nowMs: number,
): MachineUpdateStatus {
  const pending = attempt.pendingVersion;
  if (!pending) return { ok: attempt.ok, message: attempt.message, inFlight: false };
  const pendingTrack = updateTrackOfVersion(pending);
  // Landed: on the pending build's track at that version or newer. A switch
  // from Beta to an older Stable is not landed while the newer Beta still runs.
  if (
    machine.connected
    && machine.version
    && machineUpdateTrack(machine) === pendingTrack
    && (machine.appTrack == null || machine.appTrack === pendingTrack)
    && isMachineVersionCurrent(machine.version, pending)
  ) {
    return { ok: true, message: `Updated to ${machine.version}.`, inFlight: false };
  }
  // Its brain restarted after the update was sent and has stayed up on the
  // old version: the install ran and failed (a Windows install that could not
  // replace the old files reopens the old ADE). Say so now, not after the grace.
  const restartedAfterAttempt = machine.connected
    && machine.hostStartedAt != null
    && machine.hostStartedAt > attempt.startedAtMs;
  const restartedOnOldVersion = restartedAfterAttempt
    && nowMs - (machine.hostStartedAt ?? nowMs) >= MACHINE_UPDATE_OLD_BRAIN_SETTLE_MS;
  // The installer said why this attempt failed (Windows: what held its files).
  // Only once the brain is back after the attempt: the installer writes the
  // report before it reopens the old ADE, so a brain that never restarted is
  // still reading the report of an earlier try.
  const block = restartedAfterAttempt
    && machine.hostUpdateBlock
    && machine.hostUpdateBlock.at >= attempt.startedAtMs - UPDATE_BLOCK_CLOCK_SLACK_MS
    ? machine.hostUpdateBlock
    : null;
  if (!block && !restartedOnOldVersion && nowMs - attempt.startedAtMs < machineUpdateGraceMs(attempt)) {
    return { ok: true, message: attempt.message, inFlight: true };
  }
  if (machine.connected) {
    const stillOn = `Still on ${machine.version ?? "an older version"} — the update to ${pending} didn't install`;
    if (block) {
      const close = block.holders.length === 0 ? "Then press Update" : `Close ${block.holders.length === 1 ? "it" : "them"}, then press Update`;
      return { ok: false, message: `${stillOn}: ${describeUpdateBlock(block)} ${close} to try again.`, inFlight: false };
    }
    return {
      ok: false,
      message: `${stillOn} on that machine. Press Update to try again.`,
      inFlight: false,
    };
  }
  return {
    ok: false,
    message: `Not back yet after the update to ${pending}. Check that ADE is running on that machine.`,
    inFlight: false,
  };
}

/**
 * "node.exe (PID 7292) had ADE's files open." Follows "didn't install: ".
 * The phone says the same (`describeHostUpdateBlock` in the iOS
 * `MachineUpdateStore.swift`); change both together.
 */
export function describeUpdateBlock(block: RemoteRuntimeUpdateBlock): string {
  const names = block.holders.slice(0, 3).map((holder) => `${holder.name} (PID ${holder.pid})`);
  if (!names.length) return "something on it kept ADE's old files in use.";
  const more = block.holders.length - names.length;
  if (more > 0) names.push(`${more} more`);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${list} had ADE's files open.`;
}

/**
 * Where an update to one machine is, for the row: being asked about, being
 * sent, or waiting on the machine to come back on the new version.
 */
export function machineUpdatePhase(args: {
  checking: boolean;
  sending: boolean;
  status: MachineUpdateStatus | null;
}): "checking" | "sending" | "restarting" | null {
  if (args.sending) return "sending";
  if (args.status?.inFlight) return "restarting";
  if (args.checking) return "checking";
  return null;
}
