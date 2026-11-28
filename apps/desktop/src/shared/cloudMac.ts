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
import { cloudRateText, type CloudAdsView, type CloudRatePair } from "./cloudAdPriceWords";
import type { CloudUnitWords } from "./cloudUnitWords";

export type { CloudComputerAction, CloudComputerOs, CloudMacOffer, CloudMacState };

/** The synced account setting: Linux or Mac for a new lane a person starts. */
export const CLOUD_DEFAULT_OS_SETTING_KEY = "cloudDefaultOs";
/** The synced account setting: the line that says what a Mac's stop keeps was read once. */
export const CLOUD_MAC_STOP_EXPLAINED_SETTING_KEY = "cloudMacStopExplained";
/** The synced account setting: that line was shown once more beside a Mac's first stop. */
export const CLOUD_MAC_STOP_SEEN_SETTING_KEY = "cloudMacStopSeen";
/** The synced account setting: Settings' "How a DAEX Cloud Mac works" box was read. */
export const CLOUD_MAC_EXPLAINER_READ_SETTING_KEY = "cloudMacExplainerRead";

/** How long a Mac takes to start, in the server's words ("in under a minute"); never the catalog's seconds. */
export { CLOUD_MAC_START_WORDS } from "../../../account-directory/src/cloud/contract";

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

/** The Mac's two prices a minute: full, and with ads under Pricing v3 (`adCreditMilliPerMinute`; missing: one price). */
export function cloudMacRatePair(offer: Pick<CloudMacOffer, "creditMilliPerMinute" | "adCreditMilliPerMinute">): CloudRatePair {
  return { fullMilli: offer.creditMilliPerMinute, adMilli: offer.adCreditMilliPerMinute ?? null };
}

/**
 * The Mac's price in the account's words, as every price on the page reads:
 * "4 credits a minute with ads · 5 with no ads" with ads on, "5 credits a
 * minute · 4 with ads" with them off, "5 credits a minute" with one price.
 */
export function cloudMacRateText(
  offer: Pick<CloudMacOffer, "creditMilliPerMinute" | "adCreditMilliPerMinute">,
  words: CloudUnitWords,
  view: CloudAdsView | null = null,
): string {
  return cloudRateText(cloudMacRatePair(offer), view, words, "minute");
}

/**
 * A Mac's price now as the server lists it (`pricing.computers[]`), per minute:
 * the server carries every computer's rate an hour, a Mac's as its minute
 * rate times 60, so this divides it back for "4 credits a minute with ads".
 */
export function cloudMacPricePerMinute<T extends { rateMilli: number; otherRateMilli: number }>(price: T): T {
  return { ...price, rateMilli: price.rateMilli / 60, otherRateMilli: price.otherRateMilli / 60 };
}

/** Minutes as "1 h 40 min", "45 min", "20 h", "0 min", rounded down. */
function minutesText(minutes: number): string {
  const whole = Math.max(0, Math.floor(minutes));
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  if (hours === 0) return `${whole} min`;
  // From 10 hours on, whole hours read faster: "83 h", not "83 h 20 min".
  return rest && hours < 10 ? `${hours.toLocaleString("en-US")} h ${rest} min` : `${hours.toLocaleString("en-US")} h`;
}

/** The rate a Mac uses now: the ad price while ads are on and it is lower, else the full price. */
function macRateNowMilli(offer: Pick<CloudMacOffer, "creditMilliPerMinute" | "adCreditMilliPerMinute">, view: CloudAdsView | null): number {
  const ad = offer.adCreditMilliPerMinute;
  return view?.on && view.available && ad != null && ad > 0 && ad < offer.creditMilliPerMinute ? ad : offer.creditMilliPerMinute;
}

/**
 * How long `leftMilli` lasts on a Mac at the price paid now (the ad price
 * while ads are on), rounded down: "1 h 40 min", "45 min", "20 h", "0 min".
 * Pass every credit the person can spend (`cloudHoursLeftMilli`).
 */
export function cloudMacTimeAt(
  offer: Pick<CloudMacOffer, "creditMilliPerMinute" | "adCreditMilliPerMinute">,
  leftMilli: number,
  view: CloudAdsView | null = null,
): string {
  return minutesText(Math.max(0, leftMilli) / macRateNowMilli(offer, view));
}

/**
 * A plan's (or the balance's) credits as time on a Mac, both ways in the
 * website's form: "up to 2 h 5 min of Mac with ads · 1 h 40 min with no ads"
 * while ads are on, "1 h 40 min of Mac" otherwise. Null for no credits.
 */
export function cloudMacPlanLine(
  offer: Pick<CloudMacOffer, "creditMilliPerMinute" | "adCreditMilliPerMinute">,
  includedMilli: number,
  view: CloudAdsView | null = null,
): string | null {
  if (!(includedMilli > 0)) return null;
  const full = minutesText(includedMilli / offer.creditMilliPerMinute);
  const now = macRateNowMilli(offer, view);
  if (now === offer.creditMilliPerMinute) return `${full} of Mac`;
  return `up to ${minutesText(includedMilli / now)} of Mac with ads · ${full} with no ads`;
}

/**
 * The short Mac part of a plan card's one time line, after its Medium part:
 * "up to 2 h 5 min of Mac" while ads are on (the time with ads, as "up to"
 * says on the Medium part), "1 h 40 min of Mac" otherwise. The card's title
 * keeps the full line (`cloudMacPlanLine`). Null for no credits.
 */
export function cloudMacPlanShort(
  offer: Pick<CloudMacOffer, "creditMilliPerMinute" | "adCreditMilliPerMinute">,
  includedMilli: number,
  view: CloudAdsView | null = null,
): string | null {
  if (!(includedMilli > 0)) return null;
  const now = macRateNowMilli(offer, view);
  return `${now === offer.creditMilliPerMinute ? "" : "up to "}${minutesText(includedMilli / now)} of Mac`;
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

/** The state word for a computer the server can't wake or send to now (`CloudMachine.unavailable`). */
export const CLOUD_COMPUTER_UNAVAILABLE_LABEL = "Not available";

/** The short word for each phase: the state column, the header's mark, the phone's row. */
export const CLOUD_MAC_PHASE_LABEL: Readonly<Record<CloudMacPhase, string>> = {
  queued: "Waiting for a Mac",
  starting: "Starting",
  running: "On",
  stopping: "Stopping",
  stopped: "Stopped",
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

