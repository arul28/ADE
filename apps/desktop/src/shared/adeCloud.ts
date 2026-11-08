import type { CloudReadyMachineState } from "./cloudReady";

/**
 * ADE Cloud: Linux machines ADE runs for the person, each with ADE's brain as
 * its main process, signed in to their account, and listed with their other
 * computers.
 *
 * Everything here is account-level: it acts on the account's cloud machines,
 * not on any lane, chat or machine.
 *
 * Ready machines live in cloudReady.ts and the sign-ins new machines start
 * with in cloudSignIns.ts.
 */

/** The own-provider card in Settings: layout only until a provider is wired to it. */
export const BRING_YOUR_OWN_CLOUD_ENABLED = false;

/** The workspace template ADE creates boxes from (infra/ade-cloud). */
export const CLOUD_DEFAULT_TEMPLATE = "ade";

/** What the person picks: a sandboxed box, or a full VM. */
export type CloudMachineKind = "box" | "vm";

export type CloudShapeId = "2x4" | "4x8" | "4x16" | "4x32";

/** A box's size as the provider reports it: vCPUs, and memory and disk in GB. */
export type CloudResources = { cpu: number; memoryGb: number; diskGb: number };

export type CloudShape = {
  id: CloudShapeId;
  cpu: number;
  memoryGb: number;
  /** The disk ADE asks for: the most each shape allows, since repos and lanes grow. */
  diskGb: number;
};

const CLOUD_SHAPE_BY_ID: Record<CloudShapeId, CloudShape> = {
  "2x4": { id: "2x4", cpu: 2, memoryGb: 4, diskGb: 12 },
  "4x8": { id: "4x8", cpu: 4, memoryGb: 8, diskGb: 20 },
  "4x16": { id: "4x16", cpu: 4, memoryGb: 16, diskGb: 40 },
  "4x32": { id: "4x32", cpu: 4, memoryGb: 32, diskGb: 80 },
};

/** Smallest first. */
export const CLOUD_SHAPES: readonly CloudShape[] = Object.values(CLOUD_SHAPE_BY_ID);

/** The shape for an id from anywhere (a caller, a saved setting), or null when it is none. */
export function cloudShape(id: string | null | undefined): CloudShape | null {
  return CLOUD_SHAPES.find((shape) => shape.id === id) ?? null;
}

/** The shape for an id already known to be one. */
export function cloudShapeById(id: CloudShapeId): CloudShape {
  return CLOUD_SHAPE_BY_ID[id];
}

export function isCloudMachineKind(value: unknown): value is CloudMachineKind {
  return value === "box" || value === "vm";
}

/** the provider's `type` for each kind. */
export function cloudInstanceType(kind: CloudMachineKind): "default" | "vm" {
  return kind === "vm" ? "vm" : "default";
}

/**
 * the provider's published rates (2026-11): $0.80 per vCPU-month, $0.70 per
 * GB-month of memory, $0.09 per GB-month of disk, 730 hours a month. A VM's
 * compute costs 2.5x; disk is the same.
 */
const VCPU_MONTH_USD = 0.8;
const MEMORY_GB_MONTH_USD = 0.7;
const DISK_GB_MONTH_USD = 0.09;
const HOURS_PER_MONTH = 730;

/** What one running hour costs, in US dollars. Asleep or stopped, only the disk bills. */
export function cloudHourlyUsd(kind: CloudMachineKind, shape: CloudShape): number {
  return cloudRunningHourlyUsd(cloudInstanceType(kind), { cpu: shape.cpu, memoryGb: shape.memoryGb, diskGb: shape.diskGb });
}

/** How the provider's compute multiplier reads each instance type: a VM 2.5x, a performance box 4x. */
function computeMultiplier(type: string | null): number {
  if (type === "vm") return 2.5;
  if (type === "performance") return 4;
  return 1;
}

/** A running hour of any shape, in US dollars. */
export function cloudRunningHourlyUsd(type: string | null, resources: CloudResources): number {
  const compute = resources.cpu * VCPU_MONTH_USD + resources.memoryGb * MEMORY_GB_MONTH_USD;
  return (compute * computeMultiplier(type) + resources.diskGb * DISK_GB_MONTH_USD) / HOURS_PER_MONTH;
}

/** An hour asleep or stopped: the disk alone. */
export function cloudIdleHourlyUsd(resources: CloudResources): number {
  return (resources.diskGb * DISK_GB_MONTH_USD) / HOURS_PER_MONTH;
}

/** "$0.06", "$1.20", "$12". Under a cent reads "under 1¢". */
export function formatCloudUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return "under 1¢";
  return usd >= 10 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`;
}

/** "0.7¢ an hour" / "3.4¢ an hour". */
export function formatCloudHourlyPrice(usd: number): string {
  const cents = usd * 100;
  return `${cents < 10 ? cents.toFixed(1) : Math.round(cents)}¢ an hour`;
}

export type CloudKindSpec = {
  kind: CloudMachineKind;
  label: string;
  /** One line under the label. */
  summary: string;
  can: readonly string[];
  cannot: readonly string[];
};

export const CLOUD_KINDS: readonly CloudKindSpec[] = [
  {
    kind: "box",
    label: "Box",
    summary: "A sandboxed Linux machine. The cheapest way to run lanes in the cloud.",
    can: ["Lanes and Git", "Chats, CLIs and terminals", "A Linux Desktop screen for browser and app testing"],
    cannot: ["No Android emulator", "No Docker"],
  },
  {
    kind: "vm",
    label: "VM",
    summary: "A full Linux virtual machine with its own kernel.",
    can: ["Everything a box does", "Android emulator", "Docker"],
    cannot: ["Costs about 2.5 times a box"],
  },
];

/** The shape with this CPU count and memory (what a box sees from inside), or null. */
export function cloudShapeForResources(cpu: number, memoryBytes: number): CloudShape | null {
  const memoryGb = Math.round(memoryBytes / 1024 ** 3);
  return CLOUD_SHAPES.find((shape) => shape.cpu === cpu && shape.memoryGb === memoryGb) ?? null;
}

/** The smallest VM that runs the Android emulator well. */
const CLOUD_ANDROID_VM_SHAPE = cloudShapeById("4x8");

/**
 * Why a cloud box can't run the Android emulator, in plain words for the
 * person: a VM can, what that costs more, and what happens to the box. The
 * agent's next steps are in the `ade-android` and `ade-cloud` skills.
 */
export function cloudAndroidNeedsVmMessage(boxShape: CloudShape | null): string {
  // A box bigger than the Android VM moves to a VM of its own size.
  const vmShape = boxShape && CLOUD_SHAPES.indexOf(boxShape) > CLOUD_SHAPES.indexOf(CLOUD_ANDROID_VM_SHAPE)
    ? boxShape
    : CLOUD_ANDROID_VM_SHAPE;
  const vmHourly = cloudHourlyUsd("vm", vmShape);
  const more = boxShape ? `, ${formatCloudHourlyPrice(Math.max(0, vmHourly - cloudHourlyUsd("box", boxShape)))} more than this box` : "";
  return "This machine is an ADE Cloud box, and a box can't run the Android emulator. An ADE Cloud VM can. "
    + `A ${vmShape.id} VM costs ${formatCloudHourlyPrice(vmHourly)} while it's awake${more}. `
    + "ADE can make the VM and continue this chat there, with its history and changes. "
    + "This box stays, and you can delete it from the new chat.";
}

/** The integration's state, as Settings and the machine picker read it. Never the key. */
export type CloudStatus = {
  connected: boolean;
  /** Every machine on the account, asleep and stopped ones included. */
  instanceCount: number | null;
  /** The machines awake right now. */
  runningCount: number | null;
  /** Set when ADE Cloud refused this account or could not be reached. */
  error: string | null;
};

export type CloudCreateMachineArgs = {
  kind: CloudMachineKind;
  shape: CloudShapeId;
  /** The name the machine gets in ADE and on the provider. */
  name: string;
};

export type CloudCreateStage =
  | "creating"
  | "waiting_for_brain"
  | "signing_in"
  | "confirm_in_window"
  /** No window here: the person approves from `approvalUrl` (the phone, any signed-in browser). */
  | "approve_elsewhere"
  | "joining"
  | "done"
  | "failed";

export type CloudCreateMachineResult = {
  instanceId: string;
  /** The box's ADE machine key, once it signed in; the picker connects to it. */
  machineKey: string | null;
  name: string;
  /**
   * Whether its account row was ready to connect before ADE stopped waiting.
   * False: the box is signed in but still starting; the picker keeps watching
   * the account list for it and connects when its row is ready.
   */
  joined: boolean;
  /** Whether the account row took the chosen name. */
  renamed: boolean;
};

/** How long the picker keeps watching for a box that signed in but wasn't ready to connect yet. */
export const CLOUD_JOIN_WATCH_MS = 5 * 60_000;

/** The line for a box that signed in but whose row wasn't ready to connect yet. */
export function cloudStillStartingMessage(name: string): string {
  return `${name} is still starting. It will appear under Your computers; ADE will connect when it's ready.`;
}

/**
 * A create runs for minutes, longer than any IPC call may wait, so starting
 * one returns at once and the rest arrives as these events. The last one is
 * `done` (with `result`) or `failed` (with `error`).
 */
export type CloudCreateProgress = {
  /** The id the renderer gave this create, so one dialog follows its own. */
  requestId: string;
  stage: CloudCreateStage;
  /** One plain line for the dialog. */
  message: string;
  instanceId?: string;
  /** With `approve_elsewhere`: the sign-in link the person opens to let the machine join. */
  approvalUrl?: string;
  result?: CloudCreateMachineResult;
  error?: string;
};

/**
 * A box as the machine list shows it. `asleep` and `stopped` bill the disk
 * only; `starting` covers provisioning, waking, restarting and a resize or
 * update in flight.
 */
export type CloudMachineState = "running" | "asleep" | "starting" | "stopping" | "stopped" | "deleting" | "error";

export function cloudMachineState(status: string): CloudMachineState {
  switch (status) {
    case "running":
      return "running";
    case "sleeping":
      return "asleep";
    case "provisioning":
    case "starting":
    case "waking":
    case "restarting":
    case "updating":
      return "starting";
    case "stopping":
      return "stopping";
    case "stopped":
      return "stopped";
    case "deleting":
    case "deleted":
      return "deleting";
    default:
      return "error";
  }
}

const CLOUD_AWAKE_STATUSES = new Set(["provisioning", "running", "starting", "restarting", "updating", "waking"]);

/** Whether the machine is awake: everything not asleep or stopped. */
export function cloudStatusAwake(status: string): boolean {
  return CLOUD_AWAKE_STATUSES.has(status);
}

/**
 * Asleep or stopped, or on its way to or from that: the box can't answer by
 * design, and wakes when it is used.
 */
export function cloudMachineResting(state: CloudMachineState): boolean {
  return state === "asleep" || state === "stopped" || state === "starting" || state === "stopping";
}

/** Whether the provider is moving the box between states (worth a quick re-read). */
export function cloudMachineSettling(state: CloudMachineState): boolean {
  return state === "starting" || state === "stopping" || state === "deleting";
}

/** What the person calls the instance type. */
export type CloudMachineType = "box" | "vm" | "performance";

export function cloudMachineType(type: string | null): CloudMachineType {
  if (type === "vm") return "vm";
  if (type === "performance") return "performance";
  return "box";
}

/** One cloud box that ADE made (or that is signed in to the account), for the machine list. */
export type CloudMachine = {
  instanceId: string;
  /** the provider's label; ADE sets it to the machine's name at create. */
  name: string | null;
  /** the provider's own status word, for logs and the tooltip. */
  status: string;
  state: CloudMachineState;
  type: CloudMachineType;
  resources: CloudResources | null;
  /** The size ADE offers this shape as, when it is one of them. */
  shapeId: CloudShapeId | null;
  region: string | null;
  /** What an hour costs awake, and asleep or stopped (disk only). Null without resources. */
  runningHourlyUsd: number | null;
  idleHourlyUsd: number | null;
  /** What it spent in `spentSinceMs`..now (the provider settles compute hourly), or null when unknown. */
  spentUsd: number | null;
  /** Where `spentUsd` starts: the box's creation, or 90 days back for an older box. */
  spentSinceMs: number | null;
  /** True when that window starts at the box's creation: the figure is everything it cost. */
  spentIsLifetime: boolean;
  /** Suspended for non-payment (the provider's `past_due`). */
  pastDue: boolean;
  /** the provider's reason for the last failed lifecycle action. */
  failure: string | null;
  /** The box's ADE machine (account row), when ADE recorded it on the box. */
  machineKey: string | null;
  /**
   * ADE made it (its create tags, or a recorded machine key). The list shows
   * these, and any other box only when an account row matches it.
   */
  madeByAde: boolean;
  createdAtMs: number | null;
  /**
   * Set when this is a project's ready machine (prepared and kept asleep for
   * the next chat): the project it is for, and where it is in that life.
   */
  ready: { projectName: string; state: CloudReadyMachineState } | null;
  /** How the box sleeps when nothing runs on it (see `CloudSleepPolicy`). */
  sleep: CloudSleepPolicy;
  /**
   * What sleeping saved over the spend window: the hours in it at the running
   * rate, less what it actually spent. Null without a spend read.
   */
  savedUsd: number | null;
};

/*
 * Sleep. the provider puts a box to sleep once nothing has reached its URLs for
 * the idle timeout; ADE's brain on the box requests the box's own wake URL
 * while a chat, a command or a setup runs, so a working box never sleeps
 * (apps/ade-cli/src/services/power/cloudKeepAwake.ts). ADE turns the provider's
 * sleep on only once that brain is there.
 */

/** The port ADE's wake URL routes to. Nothing listens on it: the provider answers 502, which still counts as traffic and wakes the box. */
export const CLOUD_WAKE_PORT = 7337;
export const CLOUD_WAKE_PORT_LABEL = "ADE wake";
/** Minutes of nothing running before a box sleeps, as ADE offers them (the provider allows 5 minutes to a day). */
export const CLOUD_SLEEP_AFTER_CHOICES = [5, 10, 30, 60] as const;
export const CLOUD_DEFAULT_SLEEP_AFTER_MINUTES = 10;
/** The chat whose agent made a machine (create, copy, move): only that chat's unattended agent may delete it. */
export const CLOUD_MADE_BY_CHAT_METADATA = "ade_made_by_chat";

/** Where ADE notes a person's "Never sleep" on the box, so turning sleep on for older boxes leaves it alone. */
export const CLOUD_SLEEP_METADATA = "ade_sleep";

/**
 * - `auto`: sleeps after `afterMinutes` with nothing running.
 * - `never`: the person turned sleep off for this box.
 * - `pending`: ADE has not turned sleep on yet: the box's ADE predates it, or
 *   ADE has not reached the box since. It sleeps only when someone sleeps it.
 */
export type CloudSleepPolicy =
  | { state: "auto"; afterMinutes: number }
  | { state: "never" }
  | { state: "pending" };

/** Waking the box behind an account machine for use (`wakeCloudMachineForUse`). */
export type CloudWakeForUseResult =
  | { state: "woken"; instanceId: string; wakeMs: number }
  | { state: "awake"; instanceId: string }
  | { state: "not_cloud" }
  | { state: "refused"; message: string };

/** "Sleeps after 10 min idle" / "Never sleeps" / "Sleeps when ADE on it updates". */
export function describeCloudSleepPolicy(policy: CloudSleepPolicy): string {
  if (policy.state === "auto") return `Sleeps after ${policy.afterMinutes} min idle`;
  if (policy.state === "never") return "Never sleeps";
  return "Sleeps once ADE on it updates";
}

export function isCloudSleepAfterMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 5 && value <= 24 * 60;
}

/**
 * What an unattended agent (a full-auto chat, an automation run) may spend
 * without asking. An agent the person is watching always asks.
 */
export type CloudAgentLimits = {
  /** False: an unattended agent may not make, copy, move or resize anything. */
  unattendedSpend: boolean;
  /** New machines (made, copied or moved) unattended agents may start in a UTC day. */
  machinesPerDay: number;
  /** The largest size an unattended agent may pick. */
  maxShape: CloudShapeId;
};

export type CloudLimitsPreset = "ask" | "balanced" | "hands_off";
export const CLOUD_LIMITS_PRESETS: Readonly<Record<CloudLimitsPreset, CloudAgentLimits>> = {
  ask: { unattendedSpend: false, machinesPerDay: 1, maxShape: "4x8" },
  balanced: { unattendedSpend: true, machinesPerDay: 3, maxShape: "4x16" },
  hands_off: { unattendedSpend: true, machinesPerDay: 10, maxShape: "4x32" },
};
export const CLOUD_DEFAULT_AGENT_LIMITS: CloudAgentLimits = CLOUD_LIMITS_PRESETS.balanced;
export const CLOUD_MACHINES_PER_DAY_CHOICES = [1, 3, 5, 10] as const;

/** The preset these limits match, or null (Custom). */
export function cloudLimitsPresetOf(limits: CloudAgentLimits): CloudLimitsPreset | null {
  for (const [id, preset] of Object.entries(CLOUD_LIMITS_PRESETS) as Array<[CloudLimitsPreset, CloudAgentLimits]>) {
    if (preset.unattendedSpend === limits.unattendedSpend && preset.machinesPerDay === limits.machinesPerDay && preset.maxShape === limits.maxShape) {
      return id;
    }
  }
  return null;
}

/** Bigger sizes later: whether `shape` is within `max`. */
export function cloudShapeWithin(shape: CloudShapeId, max: CloudShapeId): boolean {
  const order = CLOUD_SHAPES.map((entry) => entry.id);
  return order.indexOf(shape) <= order.indexOf(max);
}

/**
 * The account's ADE Cloud spending choices: an optional monthly cap for every
 * machine (at the cap ADE makes, wakes, resizes and copies nothing; running
 * work carries on, and boxes still sleep when idle; 80% shows a warning) and
 * what unattended agents may do. No cap by default: the account's spend is
 * prepaid, so it already bounds what can be spent.
 */
export type CloudBudget = { monthlyCapUsd: number | null; agents: CloudAgentLimits };
export const CLOUD_DEFAULT_MONTHLY_CAP_USD: number | null = null;
export const CLOUD_CAP_CHOICES_USD = [10, 25, 50, 100] as const;

/** What this month cost against the cap, for Settings, the group head and the refusals. */
export type CloudSpending = {
  monthlyCapUsd: number | null;
  /** This UTC month so far, the whole workspace (the provider settles compute hourly). */
  monthSpentUsd: number | null;
  /** True at or past the cap: costly actions are refused. */
  capReached: boolean;
  /** True from 80% of the cap. */
  capNear: boolean;
};

export function cloudSpendingFor(budget: Pick<CloudBudget, "monthlyCapUsd">, monthSpentUsd: number | null): CloudSpending {
  const cap = budget.monthlyCapUsd;
  const reached = cap != null && monthSpentUsd != null && monthSpentUsd >= cap;
  return {
    monthlyCapUsd: cap,
    monthSpentUsd,
    capReached: reached,
    capNear: !reached && cap != null && monthSpentUsd != null && monthSpentUsd >= cap * 0.8,
  };
}

/** The refusal for a costly action at the cap. */
export function cloudCapReachedMessage(spending: Pick<CloudSpending, "monthlyCapUsd" | "monthSpentUsd">): string {
  const cap = spending.monthlyCapUsd != null ? formatCloudUsd(spending.monthlyCapUsd) : "your cap";
  return `Your ADE Cloud machines reached this month's ${cap} cap. Raise it in Settings › Integrations › ADE Cloud to make, wake or resize machines.`;
}

export const CLOUD_SPEND_UNKNOWN_MESSAGE =
  "ADE could not read your ADE Cloud spend this month, so it did not start or change a machine. Try again in a minute.";

/**
 * Why spending that nobody approves (a full-auto chat, an automation, the
 * ready-machine keeper, a sign-in the brain approves itself) may not go ahead:
 * the month is at the cap, or ADE could not read it. A month it can't read
 * counts as over the cap. Null when it may go ahead.
 */
export function cloudUnattendedSpendBlock(
  month: Pick<CloudSpending, "monthSpentUsd" | "capReached"> | null | undefined,
): "spend_unknown" | "cap_reached" | null {
  if (!month || month.monthSpentUsd == null) return "spend_unknown";
  return month.capReached ? "cap_reached" : null;
}

/**
 * What sleeping saved a box over a window: the window at its running rate,
 * less what it spent. the provider bills an awake hour at the running rate and an
 * asleep one at the disk alone, so this is the asleep hours' compute.
 */
export function cloudSavedUsd(args: {
  runningHourlyUsd: number | null;
  spentUsd: number | null;
  windowStartMs: number | null;
  nowMs: number;
}): number | null {
  if (args.runningHourlyUsd == null || args.spentUsd == null || args.windowStartMs == null) return null;
  const hours = Math.max(0, args.nowMs - args.windowStartMs) / 3_600_000;
  return Math.max(0, hours * args.runningHourlyUsd - args.spentUsd);
}

export type CloudMachinesResult = {
  /**
   * `ok`: read. `not_connected`: this account has no ADE Cloud. `key_refused`: the
   * provider refused this account. `unreachable`: the provider did not answer.
   */
  state: "ok" | "not_connected" | "key_refused" | "unreachable";
  machines: CloudMachine[];
  instanceCount: number | null;
  runningCount: number | null;
  /** False when the spend could not be read; the boxes still show. */
  usageAvailable: boolean;
  /** This month against the cap. */
  spending: CloudSpending;
  /** This UTC month per machine, and what deleted machines spent (see `CloudMonthSpend`). */
  month?: CloudMonthSpend | null;
  /**
   * Instances that spent in the last 90 days and are gone from the workspace:
   * boxes deleted on the provider site, whose ADE rows stay on the account.
   */
  deletedInstanceIds?: string[];
  /** A plain sentence for `key_refused` and `unreachable`. */
  message: string | null;
};

export type CloudMachineActionKind = "sleep" | "wake" | "resize" | "backup" | "delete" | "set_sleep";

export type CloudMachineActionArgs = {
  instanceId: string;
  action: CloudMachineActionKind;
  /** The new size, for `resize`. */
  shape?: CloudShapeId;
  /** For `delete`: the box's ADE machine, removed from the account once the box is gone. */
  machineKey?: string | null;
  /** For `set_sleep`: minutes of nothing running before it sleeps, or null for never. */
  sleepAfterMinutes?: number | null;
};

export type CloudMachineActionResult = {
  ok: boolean;
  /** One plain line: what happened, or why it didn't. */
  message: string;
  /**
   * What stops the action, so the card can offer the way out:
   * raise the cap, or wait for a backup window.
   */
  blocker: "rate_limited" | "cap" | null;
  /** For `delete`: the box is gone but its account row could not be removed. */
  accountRowLeft?: boolean;
};

/** "Box · 2 vCPU · 4 GB". */
export function describeCloudMachineSize(machine: Pick<CloudMachine, "type" | "resources">): string {
  const kind = machine.type === "vm" ? "VM" : machine.type === "performance" ? "Performance box" : "Box";
  if (!machine.resources) return kind;
  return `${kind} · ${machine.resources.cpu} vCPU · ${machine.resources.memoryGb} GB`;
}

/** The shape ADE offers for these resources (cpu and memory decide it), or null. */
export function cloudShapeFor(resources: Pick<CloudResources, "cpu" | "memoryGb"> | null): CloudShape | null {
  if (!resources) return null;
  return CLOUD_SHAPES.find((shape) => shape.cpu === resources.cpu && shape.memoryGb === resources.memoryGb) ?? null;
}

/**
 * The resize body for a target shape. Disk only grows on the provider, so a
 * smaller shape keeps the disk it has, and a bigger one grows it to the
 * shape's disk when that is larger.
 */
export function cloudResizeBody(
  current: CloudResources,
  target: CloudShape,
): { cpu: number; memory: number; disk?: number } {
  const body: { cpu: number; memory: number; disk?: number } = { cpu: target.cpu, memory: target.memoryGb };
  if (target.diskGb > current.diskGb) body.disk = target.diskGb;
  return body;
}

/** a provider instance id, as ADE accepts one from a caller. */
export function isCloudInstanceId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]{4,40}$/.test(value);
}

/** What a ready machine costs a month asleep: its disk. */
export function cloudReadyIdleMonthlyUsd(shape: CloudShape): number {
  return shape.diskGb * DISK_GB_MONTH_USD;
}

/*
 * Settings › Integrations › ADE Cloud: the page's own links and the month's
 * spend per machine. Kept apart from the template and create contracts above.
 */

/**
 * This UTC month on the provider (settled hourly), for the machines card: what each
 * listed machine spent and what sleeping saved it, and what machines that are
 * gone (listed in the usage, absent from the workspace) spent before they went.
 */
export type CloudMonthSpend = {
  /** Epoch ms of the month's first instant (UTC). */
  sinceMs: number;
  byInstance: Record<string, { spentUsd: number; savedUsd: number | null }>;
  deletedSpentUsd: number;
  deletedCount: number;
};
