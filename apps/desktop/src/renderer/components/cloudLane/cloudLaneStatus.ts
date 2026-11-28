import {
  capitalizeCloudPhrase,
  cloudCatalogOf,
  cloudHoursLeftMilli,
  formatCloudHoursRate,
  type CloudAccountState,
  type CloudComputerStatus,
  type CloudMachineState,
} from "../../../shared/adeCloud";
import type { CloudLaneMachine } from "../../../shared/cloudLaneLaunch";
import { cloudLaneJobIsLive, type CloudLaneJobSnapshot } from "../../../shared/cloudLaneLife";
import { cloudAdsViewOf, cloudComputerPriceOf, cloudFullPriceReasonLine, cloudPriceNowText, cloudPricingOf } from "../../../shared/cloudAdPriceWords";
import { cloudUnitWords } from "../../../shared/cloudUnitWords";
import {
  CLOUD_COMPUTER_UNAVAILABLE_LABEL,
  CLOUD_MAC_PHASE_LABEL,
  cloudMacDriveText,
  cloudMacOfferOf,
  cloudMacPhaseOf,
  cloudMacPricePerMinute,
  cloudMacRateText,
  cloudMacSentence,
  isCloudMacMachine,
  type CloudMacPhase,
} from "../../../shared/cloudMac";
import { cloudTierOfMachine, cloudTierRateLabel, cloudTiers } from "../../../shared/cloudTiers";
import { formatAgo } from "../../lib/format";
import { usageLeftLevel } from "../usage/usageDesign";
import { heroPeriodChip } from "../settings/cloudDashboard/cloudDashboardModel";
import { cloudLaneJobPresentation } from "./cloudLaneJobPresentation";

/**
 * What a cloud lane's chat header says about its computer: the state mark on
 * the cloud button, and the status lines at the top of its menu. Pure: the
 * reads are the lane index, the account, the chat's wake, the list read the
 * menu opens, the status read (`GET .../status`) and the lane's size change
 * or move. Nothing here wakes it.
 */

/** The cloud button's mark. */
export type CloudLanePower = "awake" | "asleep" | "waking" | "stopping" | "trouble";

export const CLOUD_LANE_POWER_TEXT: Record<CloudLanePower, string> = {
  awake: "Awake",
  asleep: "Asleep",
  waking: "Waking",
  stopping: "Going to sleep",
  trouble: "Needs a look",
};

/**
 * The computer's state as the header shows it. This chat's own wake wins (it
 * is the freshest), then the chat's connection (online is awake, whatever an
 * older list read says), then the account's last list read.
 */
export function cloudLanePower(input: {
  state: CloudMachineState;
  /** The chat's wake (`useChatMachineWake`): one from here, a list's, or the box reading "starting" while it rests. */
  waking: boolean;
  /** The chat's machine is an asleep cloud computer (offline by design). */
  resting: boolean;
  /** The chat's connection to the computer is up. */
  online: boolean;
  /** A DAEX Cloud Mac's phase (`LaneComputer.macPhase`): a start that failed or a lost drive needs a look. */
  macPhase?: CloudMacPhase | null;
  /** The server can't wake it now (`computer_unavailable`): no wake to offer. */
  unavailable?: boolean;
}): CloudLanePower {
  if (input.waking) return "waking";
  if (input.online) return "awake";
  if (input.unavailable) return "trouble";
  if (input.macPhase === "start_failed" || input.macPhase === "drive_lost") return "trouble";
  if (input.macPhase === "queued" || input.macPhase === "starting") return "waking";
  // A Mac saving its drive reads stopped on the server: it is still stopping, so no Start yet.
  if (input.macPhase === "stopping") return "stopping";
  if (input.resting) return input.state === "starting" ? "waking" : input.state === "stopping" ? "stopping" : "asleep";
  return cloudLanePowerOfState(input.state);
}

/** The mark for a computer's state as the account's list last read it, with nothing live to go on. */
export function cloudLanePowerOfState(state: CloudMachineState): CloudLanePower {
  switch (state) {
    case "running":
      return "awake";
    case "asleep":
    case "stopped":
      return "asleep";
    case "starting":
      return "waking";
    case "stopping":
      return "stopping";
    default:
      return "trouble";
  }
}

/**
 * The mark's words. A DAEX Cloud Mac never sleeps: it stops (only its drive is
 * kept) and starts again, or waits in the queue for a free Mac.
 */
export function cloudLanePowerText(power: CloudLanePower, macPhase?: CloudMacPhase | null): string {
  if (!macPhase) return CLOUD_LANE_POWER_TEXT[power];
  switch (power) {
    case "awake":
      return CLOUD_MAC_PHASE_LABEL.running;
    case "waking":
      return macPhase === "queued" ? CLOUD_MAC_PHASE_LABEL.queued : CLOUD_MAC_PHASE_LABEL.starting;
    case "stopping":
      return CLOUD_MAC_PHASE_LABEL.stopping;
    case "asleep":
      return CLOUD_MAC_PHASE_LABEL.stopped;
    default:
      return macPhase === "start_failed" || macPhase === "drive_lost" ? CLOUD_MAC_PHASE_LABEL[macPhase] : CLOUD_LANE_POWER_TEXT.trouble;
  }
}

/** "42m", "3h 5m", "2d 4h": how long it has been awake. */
export function formatUptime(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

const GB = 1024 ** 3;
const gbText = (gb: number) => (gb >= 10 ? Math.round(gb).toString() : (Math.round(gb * 10) / 10).toString());

export type CloudLaneStatusTone = "ok" | "warn" | "crit" | null;
export type CloudLaneStatusLine = {
  key: string;
  text: string;
  tone: CloudLaneStatusTone;
  hint?: string;
  /** A quieter part after the text (a change's step now). */
  detail?: string | null;
};

export type CloudLaneStatusModel = {
  /** "Awake · up 42m", "Asleep", "Waking…", or null while the menu doesn't know. */
  stateText: string;
  /** The lane's size change or move while it runs or after it failed, right under the title; null otherwise. */
  job: CloudLaneStatusLine | null;
  /** The lane's size change or move runs now (`cloudLaneJobIsLive`): no other change or sleep starts meanwhile. */
  changing: boolean;
  /** "Medium · 4 CPU · 8 GB · Uses 1 hour an hour" ("Now Medium …" while a change runs), or null before the list read names its size. */
  sizeText: string | null;
  /** "Disk 7.2 / 12 GB" with its headroom tone, or null when it was never measured. */
  disk: { text: string; tone: CloudLaneStatusTone } | null;
  /** "41h left · Resets Dec 1", or null before the account is read. */
  hours: { text: string; tone: CloudLaneStatusTone } | null;
  /** The lines that follow: its work, what runs, and trouble only when there is some. */
  lines: CloudLaneStatusLine[];
};

/** The status header of the cloud button's menu. Every fact is from a read in hand; a missing one is left out. */
export function cloudLaneStatusModel(input: {
  power: CloudLanePower;
  /** The account's list read for this computer, once the menu's read answered. */
  box: CloudLaneMachine | null;
  status: CloudComputerStatus | null;
  account: CloudAccountState | null;
  now: number;
  /** The lane's newest size change or move (`cloudLaneJobFor`), or null. */
  job?: CloudLaneJobSnapshot | null;
  /** A stopped Mac's first stop: say once more what a stop keeps (`useCloudMacFirstStopLine`). */
  macFirstStop?: boolean;
}): CloudLaneStatusModel {
  const { power, box, status, account, now } = input;
  const mac = isCloudMacMachine(box) ? box : null;
  const macPhase = mac ? cloudMacPhaseOf(mac.mac, mac.status) : null;
  const words = cloudUnitWords(account);
  const priced = cloudPricingOf(account) != null;
  // A change that runs: the computer won't sleep on its idle clock (the change
  // saves, restarts or replaces it), so the countdown is left out; its line says what happens.
  const changing = input.job != null && cloudLaneJobIsLive(input.job);
  const failed = input.job?.phase === "failed";
  const presented = input.job && (changing || failed) ? cloudLaneJobPresentation(input.job, account) : null;
  const jobLine: CloudLaneStatusLine | null = presented
    ? { key: "job", text: presented.title, detail: presented.stepLine, tone: failed ? "warn" : null, hint: presented.stepLine ?? undefined }
    : null;
  const awakeSince = power === "awake" ? status?.awakeSince ?? box?.awakeSinceMs ?? null : null;
  const powerWord = box?.unavailable ? CLOUD_COMPUTER_UNAVAILABLE_LABEL : cloudLanePowerText(power, macPhase);
  const stateText = power === "awake" && awakeSince != null && awakeSince <= now
    ? `${powerWord} · up ${formatUptime(now - awakeSince)}`
    : power === "waking" ? `${powerWord}…` : powerWord;

  let sizeText: string | null = null;
  const macOffer = mac ? cloudMacOfferOf(account) : null;
  if (mac) {
    // One shape, by the minute; the rate is the catalog's while it offers a Mac.
    const shape = mac.resources ? `${mac.resources.cpu} CPU · ${mac.resources.memoryGb} GB` : null;
    // Under Pricing v3 the "costs now" line says the price; the size line keeps to the shape.
    const rate = macOffer && !cloudPricingOf(account) ? capitalizeCloudPhrase(cloudMacRateText(macOffer, words)) : null;
    sizeText = ["Mac", shape, rate].filter(Boolean).join(" · ");
  } else if (box?.resources) {
    const tier = cloudTierOfMachine(box, cloudTiers(cloudCatalogOf(account)));
    // Under Pricing v3 the "costs now" line says the price (`price` below); the size line keeps to the size.
    const phrase = priced ? null : tier ? cloudTierRateLabel(tier, words) : box.hoursRate != null ? formatCloudHoursRate(box.hoursRate, words) : null;
    const rate = phrase ? capitalizeCloudPhrase(phrase) : null;
    const size = [tier?.label, `${box.resources.cpu} CPU`, `${box.resources.memoryGb} GB`, rate].filter(Boolean).join(" · ");
    sizeText = changing ? `Now ${size}` : size;
  }

  // The provider's own measure when it has one (minutes old), else the computer's last report.
  const limitGb = box?.resources?.diskGb ?? (status?.disk?.limitBytes != null ? status.disk.limitBytes / GB : null);
  const usedGb = status?.disk ? status.disk.usedBytes / GB : box?.diskUsage?.totalGb ?? null;
  const macDrive = mac ? cloudMacDriveText(mac.mac) : null;
  const disk = mac
    // A Mac's drive, as its last stop saved it: the only part a stop keeps.
    ? (macDrive ? { text: `Drive ${macDrive}`, tone: null } : null)
    : usedGb != null && limitGb != null && limitGb > 0
    ? {
        text: `Disk ${gbText(Math.min(usedGb, limitGb))} / ${gbText(limitGb)} GB`,
        tone: usageLeftLevel(Math.max(0, 100 - (usedGb / limitGb) * 100)) ?? null,
      }
    : null;

  const hours = account
    ? (() => {
        const left = cloudHoursLeftMilli(account);
        const included = Math.max(1, account.hours.includedMilli);
        return {
          text: `${words.milli(left)} left · ${heroPeriodChip(account).text}`,
          tone: usageLeftLevel((left / included) * 100) ?? null,
        };
      })()
    : null;

  const lines: CloudLaneStatusLine[] = [];
  // The server's sentence for a computer it can't wake now; nothing here can start it.
  if (box?.unavailable) lines.push({ key: "unavailable", text: box.unavailable, tone: "warn" });
  if (mac && macPhase) {
    // The server's sentence for where the Mac is; failures say what to do.
    const sentence = cloudMacSentence(mac.mac);
    const failed = macPhase === "start_failed" || macPhase === "drive_lost";
    if (sentence && macPhase !== "running") lines.push({ key: "mac", text: sentence, tone: failed ? "warn" : null });
    if (macPhase === "stopped" && input.macFirstStop && macOffer?.keeps) lines.push({ key: "mac-keeps", text: macOffer.keeps, tone: null });
  }
  const work = box?.laneWork ?? null;
  if (work) {
    const checked = `Checked ${formatAgo(work.checkedAt, now)}`;
    if (work.unpushed) lines.push({ key: "work", text: "Some work isn't on GitHub yet", tone: "warn", hint: checked });
    else if (work.prState === "merged") lines.push({ key: "work", text: "All work on GitHub · pull request merged", tone: "ok", hint: checked });
    else lines.push({ key: "work", text: "All work on GitHub", tone: "ok", hint: checked });
  }

  const activity = power === "awake" ? status?.activity ?? null : null;
  if (activity) {
    const agents = activity.runningAgents === 1 ? "1 agent running" : `${activity.runningAgents} agents running`;
    if (activity.busy) {
      lines.push({ key: "activity", text: activity.runningAgents > 0 ? agents : "Working", tone: null });
    } else if (activity.sleepsAt != null && !changing) {
      const minutes = Math.round((activity.sleepsAt - now) / 60_000);
      lines.push({
        key: "activity",
        text: mac
          ? (minutes >= 1 ? `Idle · stops in ~${minutes} min if nothing starts` : "Idle · stopping soon")
          : minutes >= 1 ? `Idle · sleeps in ~${minutes} min if nothing starts` : "Idle · going to sleep soon",
        tone: null,
      });
    }
  }

  // Trouble, only when it is true.
  if (power === "awake" && status) {
    if (status.restarts != null && status.restarts > 0) {
      lines.push({
        key: "restarts",
        text: status.restarts === 1 ? `Restarted once since it ${mac ? "started" : "woke"}` : `Restarted ${status.restarts} times since it ${mac ? "started" : "woke"}`,
        tone: "warn",
      });
    }
    if (status.outOfMemory || status.memory === "critical") {
      lines.push({ key: "memory", text: "It ran out of memory", tone: "crit", hint: mac ? undefined : "A bigger size has more memory." });
    } else if (status.memory === "pressure") {
      lines.push({ key: "memory", text: "Memory is running low", tone: "warn", hint: mac ? undefined : "A bigger size has more memory." });
    }
  }
  // Pricing v3: what this computer costs now, first among the lines, and why it has the full price while ads are on.
  const listed = box ? cloudComputerPriceOf(account, box.instanceId) : null;
  // A Mac's price comes an hour from the server; it reads a minute.
  const price = listed && mac ? cloudMacPricePerMinute(listed) : listed;
  if (price) {
    const view = cloudAdsViewOf(account);
    const reason = cloudFullPriceReasonLine(price, view);
    const priceText = cloudPriceNowText(price, view, words, mac ? "minute" : "hour");
    const priceLines: CloudLaneStatusLine[] = power === "asleep"
      ? [{ key: "price", text: mac ? "Uses nothing while stopped" : "Uses nothing while asleep", tone: null, hint: priceText }]
      : [
          { key: "price", text: priceText, tone: null },
          ...(reason ? [{ key: "price-reason", text: reason, tone: null }] : []),
        ];
    lines.unshift(...priceLines);
  }
  return { stateText, job: jobLine, changing, sizeText, disk, hours, lines };
}
