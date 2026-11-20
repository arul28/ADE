import {
  cloudCatalogOf,
  cloudHoursLeftMilli,
  formatCloudHours,
  formatCloudHoursRate,
  type CloudAccountState,
  type CloudComputerStatus,
  type CloudMachineState,
} from "../../../shared/adeCloud";
import type { CloudLaneMachine } from "../../../shared/cloudLaneLaunch";
import { cloudTierOfMachine, cloudTierRateLabel, cloudTiers } from "../../../shared/cloudTiers";
import { formatAgo } from "../../lib/format";
import { usageLeftLevel } from "../usage/usageDesign";
import { heroPeriodChip } from "../settings/cloudDashboard/cloudDashboardModel";

/**
 * What a cloud lane's chat header says about its computer: the state mark on
 * the cloud button, and the status lines at the top of its menu. Pure: the
 * reads are the lane index, the account, the chat's wake, the list read the
 * menu opens, and the status read (`GET .../status`). Nothing here wakes it.
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
}): CloudLanePower {
  if (input.waking) return "waking";
  if (input.online) return "awake";
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
export type CloudLaneStatusLine = { key: string; text: string; tone: CloudLaneStatusTone; hint?: string };

export type CloudLaneStatusModel = {
  /** "Awake · up 42m", "Asleep", "Waking…", or null while the menu doesn't know. */
  stateText: string;
  /** "Medium · 4 CPU · 8 GB · 2× hours", or null before the list read names its size. */
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
}): CloudLaneStatusModel {
  const { power, box, status, account, now } = input;
  const awakeSince = power === "awake" ? status?.awakeSince ?? box?.awakeSinceMs ?? null : null;
  const stateText = power === "awake" && awakeSince != null && awakeSince <= now
    ? `Awake · up ${formatUptime(now - awakeSince)}`
    : power === "waking" ? "Waking…" : CLOUD_LANE_POWER_TEXT[power];

  let sizeText: string | null = null;
  if (box?.resources) {
    const tier = cloudTierOfMachine(box, cloudTiers(cloudCatalogOf(account)));
    const rate = tier ? cloudTierRateLabel(tier) : box.hoursRate != null ? formatCloudHoursRate(box.hoursRate) : null;
    sizeText = [tier?.label, `${box.resources.cpu} CPU`, `${box.resources.memoryGb} GB`, rate].filter(Boolean).join(" · ");
  }

  // The provider's own measure when it has one (minutes old), else the computer's last report.
  const limitGb = box?.resources?.diskGb ?? (status?.disk?.limitBytes != null ? status.disk.limitBytes / GB : null);
  const usedGb = status?.disk ? status.disk.usedBytes / GB : box?.diskUsage?.totalGb ?? null;
  const disk = usedGb != null && limitGb != null && limitGb > 0
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
          text: `${formatCloudHours(left)}h left · ${heroPeriodChip(account).text}`,
          tone: usageLeftLevel((left / included) * 100) ?? null,
        };
      })()
    : null;

  const lines: CloudLaneStatusLine[] = [];
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
    } else if (activity.sleepsAt != null) {
      const minutes = Math.round((activity.sleepsAt - now) / 60_000);
      lines.push({
        key: "activity",
        text: minutes >= 1 ? `Idle · sleeps in ~${minutes} min if nothing starts` : "Idle · going to sleep soon",
        tone: null,
      });
    }
  }

  // Trouble, only when it is true.
  if (power === "awake" && status) {
    if (status.restarts != null && status.restarts > 0) {
      lines.push({
        key: "restarts",
        text: status.restarts === 1 ? "Restarted once since it woke" : `Restarted ${status.restarts} times since it woke`,
        tone: "warn",
      });
    }
    if (status.outOfMemory || status.memory === "critical") {
      lines.push({ key: "memory", text: "It ran out of memory", tone: "crit", hint: "A bigger size has more memory." });
    } else if (status.memory === "pressure") {
      lines.push({ key: "memory", text: "Memory is running low", tone: "warn", hint: "A bigger size has more memory." });
    }
  }
  return { stateText, sizeText, disk, hours, lines };
}
