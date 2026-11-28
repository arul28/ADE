/**
 * The DAEX Cloud Mac as every surface shows it: the catalog's offer (sent only
 * while the server's `mac_computers` switch reaches the account), a Mac
 * computer's state beside its status, and the actions the instance refuses.
 * The server decides each of these; this file only words them. With no
 * `catalog.mac`, nothing about a Mac shows anywhere.
 */

import {
  CLOUD_MAC_STATE_SENTENCES,
  type CloudAccountState,
  type CloudComputerAction,
  type CloudComputerOs,
  type CloudMacOffer,
  type CloudMacState,
} from "../../../account-directory/src/cloud/contract";
import { BRAND } from "./brand";
import type { CloudUnitWords } from "./cloudUnitWords";

export type { CloudComputerAction, CloudComputerOs, CloudMacOffer, CloudMacState };

/** The synced account setting: Linux or Mac for a new lane a person starts. */
export const CLOUD_DEFAULT_OS_SETTING_KEY = "cloudDefaultOs";
/** The synced account setting: the line that says what a Mac's stop keeps was read once. */
export const CLOUD_MAC_STOP_EXPLAINED_SETTING_KEY = "cloudMacStopExplained";
/** The synced account setting: that line was shown once more beside a Mac's first stop. */
export const CLOUD_MAC_STOP_SEEN_SETTING_KEY = "cloudMacStopSeen";

export const CLOUD_MAC_NAME = `${BRAND.CLOUD_NAME} Mac`;

/** The account's Mac offer, or null: no Mac shows while the catalog leaves it out. */
export function cloudMacOfferOf(account: Pick<CloudAccountState, "catalog"> | null | undefined): CloudMacOffer | null {
  const offer = (account?.catalog as { mac?: CloudMacOffer } | undefined)?.mac;
  return offer && Number.isFinite(offer.creditMilliPerMinute) && offer.creditMilliPerMinute > 0 ? offer : null;
}

/** What a launch should send: `mac` only while the catalog offers one (an older server would make Linux). */
export function cloudLaunchOs(os: CloudComputerOs | null | undefined, offer: CloudMacOffer | null): CloudComputerOs {
  return os === "mac" && offer ? "mac" : "linux";
}

export function isCloudMacMachine(machine: { os?: CloudComputerOs | null } | null | undefined): boolean {
  return machine?.os === "mac";
}

/**
 * Whether the server lets this computer take `action` (`CloudInstance.unsupported`).
 * The client never decides it: a computer that lists nothing allows everything.
 */
export function cloudMachineAllows(machine: { unsupported?: readonly CloudComputerAction[] | null } | null | undefined, action: CloudComputerAction): boolean {
  return !machine?.unsupported?.includes(action);
}

/** "6 CPU · 8 GB · 20 GB drive". */
export function cloudMacShapeText(offer: Pick<CloudMacOffer, "cpu" | "memoryGb" | "driveGb">): string {
  return `${offer.cpu} CPU · ${offer.memoryGb} GB · ${offer.driveGb} GB drive`;
}

/** "5 credits a minute", in the account's words, from the catalog's rate (no ad price here: another lane adds it). */
export function cloudMacRateText(offer: Pick<CloudMacOffer, "creditMilliPerMinute">, words: Pick<CloudUnitWords, "count">): string {
  return `${words.count(offer.creditMilliPerMinute / 1000)} a minute`;
}

/**
 * How long `leftMilli` lasts on a Mac, rounded down: "1 h 40 min", "45 min",
 * "20 h", "0 min". The same form a plan line gives the iPhone.
 */
export function cloudMacTimeAt(offer: Pick<CloudMacOffer, "creditMilliPerMinute">, leftMilli: number): string {
  const minutes = Math.floor(Math.max(0, leftMilli) / offer.creditMilliPerMinute);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${minutes} min`;
  return rest ? `${hours.toLocaleString("en-US")} h ${rest} min` : `${hours.toLocaleString("en-US")} h`;
}

/** "1 h 40 min of Mac": a plan's credits as time on a Mac. */
export function cloudMacPlanLine(offer: Pick<CloudMacOffer, "creditMilliPerMinute">, includedMilli: number): string | null {
  if (!(includedMilli > 0)) return null;
  return `${cloudMacTimeAt(offer, includedMilli)} of Mac`;
}

/**
 * Where a Mac is, from the server's `mac` state (its `status` says only
 * starting, running and stopped). A start that ended with no Mac and a lost
 * drive are their own phases: each offers a different way on.
 */
export type CloudMacPhase = "queued" | "starting" | "running" | "stopping" | "stopped" | "start_failed" | "drive_lost";

export function cloudMacPhaseOf(mac: CloudMacState | null | undefined, status?: string | null): CloudMacPhase {
  if (mac) {
    if (mac.failure === "drive_lost") return "drive_lost";
    if (mac.startFailed && mac.state !== "running" && mac.state !== "starting" && mac.state !== "queued") return "start_failed";
    return mac.state;
  }
  // An answer with no `mac` (between reads): the status alone.
  if (status === "running") return "running";
  if (status === "starting" || status === "provisioning" || status === "waking") return "starting";
  return "stopped";
}

/** The short word for each phase: the state column, the header's mark, the phone's row. */
export const CLOUD_MAC_PHASE_LABEL: Readonly<Record<CloudMacPhase, string>> = {
  queued: "Waiting for a Mac",
  starting: "Starting",
  running: "On",
  stopping: "Stopping",
  stopped: "Stopped · drive kept",
  start_failed: "Couldn't start",
  drive_lost: "Drive lost",
};

/** The phase's tone, for its dot. */
export function cloudMacPhaseTone(phase: CloudMacPhase): "on" | "busy" | "off" | "bad" {
  if (phase === "running") return "on";
  if (phase === "queued" || phase === "starting") return "busy";
  if (phase === "start_failed" || phase === "drive_lost") return "bad";
  return "off";
}

/** The server's sentence for the state (or why the start failed); the contract's words while it sent none. */
export function cloudMacSentence(mac: CloudMacState | null | undefined): string | null {
  if (!mac) return null;
  const message = mac.message?.trim();
  if (message) return message;
  return mac.startFailed ? null : CLOUD_MAC_STATE_SENTENCES[mac.state] ?? null;
}

/** "7.4 of 20 GB": the drive as the last stop saved it, or its size before the first save. */
export function cloudMacDriveText(mac: Pick<CloudMacState, "drive"> | null | undefined): string | null {
  const drive = mac?.drive;
  if (!drive) return null;
  if (drive.usedGb == null) return `${drive.sizeGb} GB drive`;
  const used = drive.usedGb >= 10 ? Math.round(drive.usedGb) : Math.round(drive.usedGb * 10) / 10;
  return `${used} of ${drive.sizeGb} GB`;
}

/**
 * Why `provider` can't start here on a Mac, or null: the catalog lists only
 * the exceptions, each with the server's sentence.
 */
export function cloudMacProviderRefusal(
  offer: CloudMacOffer | null,
  provider: string | null | undefined,
  surface: "chat" | "cli",
  label?: string | null,
): string | null {
  if (!offer || !provider) return null;
  const entry = offer.providers?.find((candidate) => candidate.provider === provider);
  if (!entry || entry[surface]) return null;
  const name = label?.trim() || provider;
  return entry.sentence?.trim()
    || `${name} ${surface === "cli" ? "CLI sessions don't" : "doesn't"} run on a ${CLOUD_MAC_NAME} yet. Pick Linux, or another ${surface === "cli" ? "CLI" : "model"}.`;
}

