import type { IntegrationCredentialStorage } from "./types/integrationCredentialStorage";

/**
 * Agent37: persistent Linux machines metered per minute, driven by one
 * workspace API key. ADE uses it as a place to make new machines from: a box
 * comes up from ADE's template with the brain as its main process, signs in to
 * the creator's ADE account without a code, and joins the machine list.
 *
 * Everything here is account-level. The key lives in the account vault, so
 * every computer on the account sees the same Agent37 workspace, and making a
 * box acts on that workspace, not on any lane, chat or machine.
 */

export const AGENT37_API_BASE_URL = "https://api.agent37.com/v1";
export const AGENT37_SANDBOX_BASE_URL = "https://sandbox.agent37.app/v1";
export const AGENT37_API_KEYS_URL = "https://www.agent37.com/dashboard/cloud/api-keys";
export const AGENT37_BILLING_URL = "https://www.agent37.com/dashboard/cloud/billing";

/** The workspace template ADE creates boxes from (infra/agent37). */
export const AGENT37_DEFAULT_TEMPLATE = "ade";

/** What the person picks: a sandboxed box, or a full VM. */
export type Agent37MachineKind = "box" | "vm";

export type Agent37ShapeId = "2x4" | "4x8" | "4x16" | "4x32";

/** A box's size as Agent37 reports it: vCPUs, and memory and disk in GB. */
export type Agent37Resources = { cpu: number; memoryGb: number; diskGb: number };

export type Agent37Shape = {
  id: Agent37ShapeId;
  cpu: number;
  memoryGb: number;
  /** The disk ADE asks for: the most each shape allows, since repos and lanes grow. */
  diskGb: number;
};

const AGENT37_SHAPE_BY_ID: Record<Agent37ShapeId, Agent37Shape> = {
  "2x4": { id: "2x4", cpu: 2, memoryGb: 4, diskGb: 12 },
  "4x8": { id: "4x8", cpu: 4, memoryGb: 8, diskGb: 20 },
  "4x16": { id: "4x16", cpu: 4, memoryGb: 16, diskGb: 40 },
  "4x32": { id: "4x32", cpu: 4, memoryGb: 32, diskGb: 80 },
};

/** Smallest first. */
export const AGENT37_SHAPES: readonly Agent37Shape[] = Object.values(AGENT37_SHAPE_BY_ID);

/** The shape for an id from anywhere (a caller, a saved setting), or null when it is none. */
export function agent37Shape(id: string | null | undefined): Agent37Shape | null {
  return AGENT37_SHAPES.find((shape) => shape.id === id) ?? null;
}

/** The shape for an id already known to be one. */
export function agent37ShapeById(id: Agent37ShapeId): Agent37Shape {
  return AGENT37_SHAPE_BY_ID[id];
}

export function isAgent37MachineKind(value: unknown): value is Agent37MachineKind {
  return value === "box" || value === "vm";
}

/** Agent37's `type` for each kind. */
export function agent37InstanceType(kind: Agent37MachineKind): "default" | "vm" {
  return kind === "vm" ? "vm" : "default";
}

/**
 * Agent37's published rates (2026-11): $0.80 per vCPU-month, $0.70 per
 * GB-month of memory, $0.09 per GB-month of disk, 730 hours a month. A VM's
 * compute costs 2.5x; disk is the same.
 */
const VCPU_MONTH_USD = 0.8;
const MEMORY_GB_MONTH_USD = 0.7;
const DISK_GB_MONTH_USD = 0.09;
const HOURS_PER_MONTH = 730;

/** What one running hour costs, in US dollars. Asleep or stopped, only the disk bills. */
export function agent37HourlyUsd(kind: Agent37MachineKind, shape: Agent37Shape): number {
  return agent37RunningHourlyUsd(agent37InstanceType(kind), { cpu: shape.cpu, memoryGb: shape.memoryGb, diskGb: shape.diskGb });
}

/** How Agent37's compute multiplier reads each instance type: a VM 2.5x, a performance box 4x. */
function computeMultiplier(type: string | null): number {
  if (type === "vm") return 2.5;
  if (type === "performance") return 4;
  return 1;
}

/** A running hour of any shape, in US dollars. */
export function agent37RunningHourlyUsd(type: string | null, resources: Agent37Resources): number {
  const compute = resources.cpu * VCPU_MONTH_USD + resources.memoryGb * MEMORY_GB_MONTH_USD;
  return (compute * computeMultiplier(type) + resources.diskGb * DISK_GB_MONTH_USD) / HOURS_PER_MONTH;
}

/** An hour asleep or stopped: the disk alone. */
export function agent37IdleHourlyUsd(resources: Agent37Resources): number {
  return (resources.diskGb * DISK_GB_MONTH_USD) / HOURS_PER_MONTH;
}

/** "$0.06", "$1.20", "$12". Under a cent reads "under 1¢". */
export function formatAgent37Usd(usd: number): string {
  if (usd > 0 && usd < 0.01) return "under 1¢";
  return usd >= 10 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`;
}

/** "0.7¢ an hour" / "3.4¢ an hour". */
export function formatAgent37HourlyPrice(usd: number): string {
  const cents = usd * 100;
  return `${cents < 10 ? cents.toFixed(1) : Math.round(cents)}¢ an hour`;
}

export type Agent37KindSpec = {
  kind: Agent37MachineKind;
  label: string;
  /** One line under the label. */
  summary: string;
  can: readonly string[];
  cannot: readonly string[];
};

export const AGENT37_KINDS: readonly Agent37KindSpec[] = [
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
export function agent37ShapeForResources(cpu: number, memoryBytes: number): Agent37Shape | null {
  const memoryGb = Math.round(memoryBytes / 1024 ** 3);
  return AGENT37_SHAPES.find((shape) => shape.cpu === cpu && shape.memoryGb === memoryGb) ?? null;
}

/** The smallest VM that runs the Android emulator well. */
const AGENT37_ANDROID_VM_SHAPE = agent37ShapeById("4x8");

/**
 * Why an Agent 37 box can't run the Android emulator, in plain words for the
 * person: a VM can, what that costs more, and what happens to the box. The
 * agent's next steps are in the `ade-android` and `ade-agent37` skills.
 */
export function agent37AndroidNeedsVmMessage(boxShape: Agent37Shape | null): string {
  // A box bigger than the Android VM moves to a VM of its own size.
  const vmShape = boxShape && AGENT37_SHAPES.indexOf(boxShape) > AGENT37_SHAPES.indexOf(AGENT37_ANDROID_VM_SHAPE)
    ? boxShape
    : AGENT37_ANDROID_VM_SHAPE;
  const vmHourly = agent37HourlyUsd("vm", vmShape);
  const more = boxShape ? `, ${formatAgent37HourlyPrice(Math.max(0, vmHourly - agent37HourlyUsd("box", boxShape)))} more than this box` : "";
  return "This machine is an Agent 37 box, and a box can't run the Android emulator. An Agent 37 VM can. "
    + `A ${vmShape.id} VM costs ${formatAgent37HourlyPrice(vmHourly)} while it's awake${more}. `
    + "ADE can make the VM and continue this chat there, with its history and changes. "
    + "This box stays, and you can delete it from the new chat.";
}

/** The integration's state, as Settings and the machine picker read it. Never the key. */
export type Agent37Status = {
  connected: boolean;
  /** Where the key is kept; null when there is no key. */
  credentialStorage: IntegrationCredentialStorage | null;
  /** The workspace wallet, when Agent37 answered. */
  balanceUsd: number | null;
  /** 0 before the first top-up: one box, the smallest shape, no VMs. */
  tier: number | null;
  instanceLimit: number | null;
  /** Every machine the workspace holds, asleep and stopped ones included. */
  instanceCount: number | null;
  /** The machines awake right now: after the first top-up, only these count toward the limit. */
  runningCount: number | null;
  pastDue: boolean;
  /** Set when a key is saved but Agent37 refused it or could not be reached. */
  error: string | null;
};

export type Agent37CreateMachineArgs = {
  kind: Agent37MachineKind;
  shape: Agent37ShapeId;
  /** The name the machine gets in ADE and on Agent37. */
  name: string;
};

export type Agent37CreateStage =
  | "creating"
  | "waiting_for_brain"
  | "signing_in"
  | "confirm_in_window"
  /** No window here: the person approves from `approvalUrl` (the phone, any signed-in browser). */
  | "approve_elsewhere"
  | "joining"
  | "done"
  | "failed";

export type Agent37CreateMachineResult = {
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
export const AGENT37_JOIN_WATCH_MS = 5 * 60_000;

/** The line for a box that signed in but whose row wasn't ready to connect yet. */
export function agent37StillStartingMessage(name: string): string {
  return `${name} is still starting. It will appear under Your computers; ADE will connect when it's ready.`;
}

/**
 * A create runs for minutes, longer than any IPC call may wait, so starting
 * one returns at once and the rest arrives as these events. The last one is
 * `done` (with `result`) or `failed` (with `error`).
 */
export type Agent37CreateProgress = {
  /** The id the renderer gave this create, so one dialog follows its own. */
  requestId: string;
  stage: Agent37CreateStage;
  /** One plain line for the dialog. */
  message: string;
  instanceId?: string;
  /** With `approve_elsewhere`: the sign-in link the person opens to let the machine join. */
  approvalUrl?: string;
  result?: Agent37CreateMachineResult;
  error?: string;
};

/**
 * Whether the workspace is at its machine limit. Before the first top-up
 * (tier 0) the limit is one machine in total, asleep or not; after it, only
 * awake machines count, so sleeping one makes room.
 */
export function agent37AtMachineLimit(
  status: Pick<Agent37Status, "tier" | "instanceLimit" | "instanceCount" | "runningCount">,
): boolean {
  if (status.instanceLimit == null) return false;
  const counted = status.tier === 0 ? status.instanceCount : status.runningCount ?? status.instanceCount;
  return counted != null && counted >= status.instanceLimit;
}

/** The sentence for a workspace at its limit, with the way out that applies to its tier. */
export function agent37MachineLimitMessage(
  status: Pick<Agent37Status, "tier" | "instanceLimit">,
  doing: "make" | "wake" = "make",
): string {
  if (status.tier === 0) {
    return "Your free Agent 37 workspace holds one machine. Delete it, or top up once to run up to 10 at a time.";
  }
  const limit = status.instanceLimit;
  const many = limit != null ? `${limit} machine${limit === 1 ? "" : "s"}` : "as many machines as it can";
  return doing === "wake"
    ? `Your Agent 37 workspace already has ${many} awake, its limit. Put one to sleep, then wake this one.`
    : `Your Agent 37 workspace already has ${many} awake, its limit. Put one to sleep, or top up more to raise the limit.`;
}

/** Why a shape or kind cannot be made on this workspace right now, or null. */
export function agent37ChoiceBlocker(
  status: Pick<Agent37Status, "tier" | "instanceLimit" | "instanceCount" | "runningCount" | "pastDue">,
  kind: Agent37MachineKind,
  shape: Agent37Shape,
): string | null {
  if (status.pastDue) return "Your Agent 37 wallet is past due. Top it up to make machines.";
  if (agent37AtMachineLimit(status)) return agent37MachineLimitMessage(status, "make");
  if (status.tier === 0 && (kind === "vm" || shape.id !== "2x4")) {
    return "Agent 37 unlocks VMs and bigger sizes after your first top-up.";
  }
  return null;
}

/**
 * A box as the machine list shows it. `asleep` and `stopped` bill the disk
 * only; `starting` covers provisioning, waking, restarting and a resize or
 * update in flight.
 */
export type Agent37MachineState = "running" | "asleep" | "starting" | "stopping" | "stopped" | "deleting" | "error";

export function agent37MachineState(status: string): Agent37MachineState {
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

const AGENT37_AWAKE_STATUSES = new Set(["provisioning", "running", "starting", "restarting", "updating", "waking"]);

/** What Agent37 counts toward the limit after the first top-up: everything not asleep or stopped. */
export function agent37StatusAwake(status: string): boolean {
  return AGENT37_AWAKE_STATUSES.has(status);
}

/** Whether Agent37 is moving the box between states (worth a quick re-read). */
export function agent37MachineSettling(state: Agent37MachineState): boolean {
  return state === "starting" || state === "stopping" || state === "deleting";
}

/** What the person calls the instance type. */
export type Agent37MachineType = "box" | "vm" | "performance";

export function agent37MachineType(type: string | null): Agent37MachineType {
  if (type === "vm") return "vm";
  if (type === "performance") return "performance";
  return "box";
}

/** One Agent37 box that ADE made (or that is signed in to the account), for the machine list. */
export type Agent37Machine = {
  instanceId: string;
  /** Agent37's label; ADE sets it to the machine's name at create. */
  name: string | null;
  /** Agent37's own status word, for logs and the tooltip. */
  status: string;
  state: Agent37MachineState;
  type: Agent37MachineType;
  resources: Agent37Resources | null;
  /** The size ADE offers this shape as, when it is one of them. */
  shapeId: Agent37ShapeId | null;
  region: string | null;
  /** What an hour costs awake, and asleep or stopped (disk only). Null without resources. */
  runningHourlyUsd: number | null;
  idleHourlyUsd: number | null;
  /** What it spent in `spentSinceMs`..now (Agent37 settles compute hourly), or null when unknown. */
  spentUsd: number | null;
  /** Where `spentUsd` starts: the box's creation, or 90 days back for an older box. */
  spentSinceMs: number | null;
  /** True when that window starts at the box's creation: the figure is everything it cost. */
  spentIsLifetime: boolean;
  /** Suspended for non-payment (Agent37's `past_due`). */
  pastDue: boolean;
  /** Agent37's reason for the last failed lifecycle action. */
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
  ready: { projectName: string; state: Agent37ReadyMachineState } | null;
  /** How the box sleeps when nothing runs on it (see `Agent37SleepPolicy`). */
  sleep: Agent37SleepPolicy;
  /**
   * What sleeping saved over the spend window: the hours in it at the running
   * rate, less what it actually spent. Null without a spend read.
   */
  savedUsd: number | null;
};

/*
 * Sleep. Agent 37 puts a box to sleep once nothing has reached its URLs for
 * the idle timeout; ADE's brain on the box requests the box's own wake URL
 * while a chat, a command or a setup runs, so a working box never sleeps
 * (apps/ade-cli/src/services/power/agent37KeepAwake.ts). ADE turns Agent 37's
 * sleep on only once that brain is there.
 */

/** The port ADE's wake URL routes to. Nothing listens on it: Agent 37 answers 502, which still counts as traffic and wakes the box. */
export const AGENT37_WAKE_PORT = 7337;
export const AGENT37_WAKE_PORT_LABEL = "ADE wake";
/** Minutes of nothing running before a box sleeps, as ADE offers them (Agent 37 allows 5 minutes to a day). */
export const AGENT37_SLEEP_AFTER_CHOICES = [5, 10, 30, 60] as const;
export const AGENT37_DEFAULT_SLEEP_AFTER_MINUTES = 10;
/** The chat whose agent made a machine (create, copy, move): only that chat's unattended agent may delete it. */
export const AGENT37_MADE_BY_CHAT_METADATA = "ade_made_by_chat";

/** Where ADE notes a person's "Never sleep" on the box, so turning sleep on for older boxes leaves it alone. */
export const AGENT37_SLEEP_METADATA = "ade_sleep";

/**
 * - `auto`: sleeps after `afterMinutes` with nothing running.
 * - `never`: the person turned sleep off for this box.
 * - `pending`: ADE has not turned sleep on yet: the box's ADE predates it, or
 *   ADE has not reached the box since. It sleeps only when someone sleeps it.
 */
export type Agent37SleepPolicy =
  | { state: "auto"; afterMinutes: number }
  | { state: "never" }
  | { state: "pending" };

/** Waking the box behind an account machine for use (`wakeAgent37MachineForUse`). */
export type Agent37WakeForUseResult =
  | { state: "woken"; instanceId: string; wakeMs: number }
  | { state: "awake"; instanceId: string }
  | { state: "not_agent37" }
  | { state: "refused"; message: string };

/** "Sleeps after 10 min idle" / "Never sleeps" / "Sleeps when ADE on it updates". */
export function describeAgent37SleepPolicy(policy: Agent37SleepPolicy): string {
  if (policy.state === "auto") return `Sleeps after ${policy.afterMinutes} min idle`;
  if (policy.state === "never") return "Never sleeps";
  return "Sleeps once ADE on it updates";
}

export function isAgent37SleepAfterMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 5 && value <= 24 * 60;
}

/**
 * What an unattended agent (a full-auto chat, an automation run) may spend
 * without asking. An agent the person is watching always asks.
 */
export type Agent37AgentLimits = {
  /** False: an unattended agent may not make, copy, move or resize anything. */
  unattendedSpend: boolean;
  /** New machines (made, copied or moved) unattended agents may start in a UTC day. */
  machinesPerDay: number;
  /** The largest size an unattended agent may pick. */
  maxShape: Agent37ShapeId;
};

export type Agent37LimitsPreset = "ask" | "balanced" | "hands_off";
export const AGENT37_LIMITS_PRESETS: Readonly<Record<Agent37LimitsPreset, Agent37AgentLimits>> = {
  ask: { unattendedSpend: false, machinesPerDay: 1, maxShape: "4x8" },
  balanced: { unattendedSpend: true, machinesPerDay: 3, maxShape: "4x16" },
  hands_off: { unattendedSpend: true, machinesPerDay: 10, maxShape: "4x32" },
};
export const AGENT37_DEFAULT_AGENT_LIMITS: Agent37AgentLimits = AGENT37_LIMITS_PRESETS.balanced;
export const AGENT37_MACHINES_PER_DAY_CHOICES = [1, 3, 5, 10] as const;

/** The preset these limits match, or null (Custom). */
export function agent37LimitsPresetOf(limits: Agent37AgentLimits): Agent37LimitsPreset | null {
  for (const [id, preset] of Object.entries(AGENT37_LIMITS_PRESETS) as Array<[Agent37LimitsPreset, Agent37AgentLimits]>) {
    if (preset.unattendedSpend === limits.unattendedSpend && preset.machinesPerDay === limits.machinesPerDay && preset.maxShape === limits.maxShape) {
      return id;
    }
  }
  return null;
}

/** Bigger sizes later: whether `shape` is within `max`. */
export function agent37ShapeWithin(shape: Agent37ShapeId, max: Agent37ShapeId): boolean {
  const order = AGENT37_SHAPES.map((entry) => entry.id);
  return order.indexOf(shape) <= order.indexOf(max);
}

/**
 * The account's Agent 37 spending choices: an optional monthly cap for every
 * machine (at the cap ADE makes, wakes, resizes and copies nothing; running
 * work carries on, and boxes still sleep when idle; 80% shows a warning) and
 * what unattended agents may do. No cap by default: the Agent 37 wallet is
 * prepaid, so it already bounds what can be spent.
 */
export type Agent37Budget = { monthlyCapUsd: number | null; agents: Agent37AgentLimits };
export const AGENT37_DEFAULT_MONTHLY_CAP_USD: number | null = null;
export const AGENT37_CAP_CHOICES_USD = [10, 25, 50, 100] as const;

/** What this month cost against the cap, for Settings, the group head and the refusals. */
export type Agent37Spending = {
  monthlyCapUsd: number | null;
  /** This UTC month so far, the whole workspace (Agent 37 settles compute hourly). */
  monthSpentUsd: number | null;
  /** True at or past the cap: costly actions are refused. */
  capReached: boolean;
  /** True from 80% of the cap. */
  capNear: boolean;
};

export function agent37SpendingFor(budget: Pick<Agent37Budget, "monthlyCapUsd">, monthSpentUsd: number | null): Agent37Spending {
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
export function agent37CapReachedMessage(spending: Pick<Agent37Spending, "monthlyCapUsd" | "monthSpentUsd">): string {
  const cap = spending.monthlyCapUsd != null ? formatAgent37Usd(spending.monthlyCapUsd) : "your cap";
  return `Your Agent 37 machines reached this month's ${cap} cap. Raise it in Settings › Integrations › Agent 37 to make, wake or resize machines.`;
}

/**
 * What sleeping saved a box over a window: the window at its running rate,
 * less what it spent. Agent 37 bills an awake hour at the running rate and an
 * asleep one at the disk alone, so this is the asleep hours' compute.
 */
export function agent37SavedUsd(args: {
  runningHourlyUsd: number | null;
  spentUsd: number | null;
  windowStartMs: number | null;
  nowMs: number;
}): number | null {
  if (args.runningHourlyUsd == null || args.spentUsd == null || args.windowStartMs == null) return null;
  const hours = Math.max(0, args.nowMs - args.windowStartMs) / 3_600_000;
  return Math.max(0, hours * args.runningHourlyUsd - args.spentUsd);
}

export type Agent37MachinesResult = {
  /**
   * `ok`: read. `not_connected`: no key saved. `key_refused`: Agent37 refused
   * the saved key (revoked or rotated). `unreachable`: Agent37 did not answer.
   */
  state: "ok" | "not_connected" | "key_refused" | "unreachable";
  machines: Agent37Machine[];
  balanceUsd: number | null;
  tier: number | null;
  instanceLimit: number | null;
  instanceCount: number | null;
  runningCount: number | null;
  pastDue: boolean;
  /** False when the spend could not be read; the boxes still show. */
  usageAvailable: boolean;
  /** This month against the cap. */
  spending: Agent37Spending;
  /** This UTC month per machine, and what deleted machines spent (see `Agent37MonthSpend`). */
  month?: Agent37MonthSpend | null;
  /**
   * Instances that spent in the last 90 days and are gone from the workspace:
   * boxes deleted on the Agent 37 site, whose ADE rows stay on the account.
   */
  deletedInstanceIds?: string[];
  /** A plain sentence for `key_refused` and `unreachable`. */
  message: string | null;
};

export type Agent37MachineActionKind = "sleep" | "wake" | "resize" | "backup" | "delete" | "set_sleep";

export type Agent37MachineActionArgs = {
  instanceId: string;
  action: Agent37MachineActionKind;
  /** The new size, for `resize`. */
  shape?: Agent37ShapeId;
  /** For `delete`: the box's ADE machine, removed from the account once the box is gone. */
  machineKey?: string | null;
  /** For `set_sleep`: minutes of nothing running before it sleeps, or null for never. */
  sleepAfterMinutes?: number | null;
};

export type Agent37MachineActionResult = {
  ok: boolean;
  /** One plain line: what happened, or why it didn't. */
  message: string;
  /**
   * What stops the action, so the card can offer the way out: top up the
   * wallet, raise the limit, fix the key, or wait for a backup window.
   */
  blocker: "wallet" | "limit" | "suspended" | "key" | "rate_limited" | "cap" | null;
  /** For `delete`: the box is gone but its account row could not be removed. */
  accountRowLeft?: boolean;
};

/** "Box · 2 vCPU · 4 GB". */
export function describeAgent37MachineSize(machine: Pick<Agent37Machine, "type" | "resources">): string {
  const kind = machine.type === "vm" ? "VM" : machine.type === "performance" ? "Performance box" : "Box";
  if (!machine.resources) return kind;
  return `${kind} · ${machine.resources.cpu} vCPU · ${machine.resources.memoryGb} GB`;
}

/** The shape ADE offers for these resources (cpu and memory decide it), or null. */
export function agent37ShapeFor(resources: Pick<Agent37Resources, "cpu" | "memoryGb"> | null): Agent37Shape | null {
  if (!resources) return null;
  return AGENT37_SHAPES.find((shape) => shape.cpu === resources.cpu && shape.memoryGb === resources.memoryGb) ?? null;
}

/**
 * The resize body for a target shape. Disk only grows on Agent37, so a
 * smaller shape keeps the disk it has, and a bigger one grows it to the
 * shape's disk when that is larger.
 */
export function agent37ResizeBody(
  current: Agent37Resources,
  target: Agent37Shape,
): { cpu: number; memory: number; disk?: number } {
  const body: { cpu: number; memory: number; disk?: number } = { cpu: target.cpu, memory: target.memoryGb };
  if (target.diskGb > current.diskGb) body.disk = target.diskGb;
  return body;
}

/**
 * ADE's template in the person's Agent37 workspace. Saving the key puts it
 * there (an Agent37 cloud build, about five minutes) and keeps it on the
 * running ADE release afterwards.
 *
 * - `idle`: no key, or nothing checked yet.
 * - `checking`: asking Agent37 whether the template is there and current.
 * - `building`: a build is running (here or on another of the person's computers).
 * - `ready`: the template is there and current.
 * - `failed`: the last build failed; `nextRetryAt` is set while ADE will try again on its own.
 */
export type Agent37TemplateState = "idle" | "checking" | "building" | "ready" | "failed";

export type Agent37TemplateProgress = {
  /** 1-based. */
  step: number;
  steps: number;
  /** "Installing ADE", "Saving the machine image". */
  label: string;
};

export type Agent37TemplateStatus = {
  template: string;
  state: Agent37TemplateState;
  /**
   * Whether a machine can be made from the template right now. True while an
   * older template exists and a newer one builds: boxes come from the old one.
   */
  usable: boolean;
  /** The ADE release the template installs ("latest" for a development build). */
  adeVersion: string | null;
  /** When the running build started, epoch ms. */
  startedAt: number | null;
  /**
   * Where the running build is, read from Agent 37's build log: step `step` of
   * `steps`, with a plain label. Null while nothing is building or before the
   * log says anything.
   */
  progress?: Agent37TemplateProgress | null;
  /** A plain reason when `failed`. */
  error: string | null;
  /** Epoch ms of the next automatic try, while `failed`. */
  nextRetryAt: number | null;
};

/** "Setting up ADE's machine template, about 4 min left." */
export function describeAgent37TemplateStatus(status: Agent37TemplateStatus): string {
  switch (status.state) {
    case "ready":
      return "ADE's machine template is ready.";
    case "building": {
      const step = status.progress ? ` Step ${status.progress.step} of ${status.progress.steps}: ${status.progress.label}.` : "";
      return status.usable
        ? `Updating ADE's machine template. New machines use the current one until then.${step}`
        : `Getting Agent 37 ready for ADE. This happens once.${step}`;
    }
    case "failed":
      return `ADE couldn't set up its machine template: ${status.error ?? "the build failed."}`;
    case "checking":
      return "Checking ADE's machine template…";
    default:
      return "ADE's machine template isn't set up yet.";
  }
}

/*
 * Ready machines: a machine prepared for one project (repository cloned, its
 * setup run, its services started, signed in) and kept asleep, so a new chat
 * on it starts in seconds. Asleep it bills only its disk. Starting a chat
 * claims it (wakes it and makes it an ordinary machine of the person's), and
 * ADE prepares the next one.
 *
 * The pool lives on Agent37 itself, in each machine's metadata, so every
 * computer on the account, the brain and the CLI read the same answer.
 */

/** The size a new ready machine gets until the person picks one: a 4 vCPU / 8 GB VM runs a Docker stack. */
export const AGENT37_READY_DEFAULT_SHAPE: Agent37ShapeId = "4x8";

/**
 * How long a chat start waits, from the claim, for the woken machine's ADE to
 * come online and take it. Agent 37 answers a wake in about a second; ADE's own
 * reconnect after a long sleep takes longer.
 */
export const AGENT37_READY_WAKE_WAIT_MS = 120_000;

/** An Agent 37 instance id, as ADE accepts one from a caller. */
export function isAgent37InstanceId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]{4,40}$/.test(value);
}

/** `ade chat create --machine agent37:ready`: start the chat on this project's ready machine. */
const AGENT37_READY_MACHINE_SELECTOR = "agent37:ready";

export function isAgent37ReadyMachineSelector(value: string | null | undefined): boolean {
  return value?.trim().toLowerCase() === AGENT37_READY_MACHINE_SELECTOR;
}

/** Metadata keys on a ready machine. Agent37 replaces metadata on write, so every write keeps the rest. */
export const AGENT37_READY_METADATA = {
  /** The project's git identity (`github.com/owner/repo`). */
  project: "ade_ready_for",
  /** `preparing` → `ready` → `claimed`; or `failed`. */
  state: "ade_ready",
  /** The project's display name, for the machine list. */
  projectName: "ade_ready_name",
  /** Where the project is on the machine. */
  path: "ade_ready_path",
  /** The project's primary lane there: a chat with no lane named starts in it. */
  lane: "ade_ready_lane",
  /** Epoch ms of the claim. */
  claimedAt: "ade_ready_claimed_at",
  /** The claim's own token: only the caller holding it can give the machine back. */
  claimToken: "ade_ready_claim",
  /** Which copy of ADE is preparing it, so that copy knows its own leftovers after a restart. */
  preparedBy: "ade_ready_by",
  /** The ADE release its template installed; a ready machine is replaced when the template moves on. */
  adeVersion: "ade_ready_ade",
} as const;

export type Agent37ReadyMachineState = "preparing" | "ready" | "claimed" | "failed";

export function readAgent37ReadyMachineState(value: string | null | undefined): Agent37ReadyMachineState | null {
  return value === "preparing" || value === "ready" || value === "claimed" || value === "failed" ? value : null;
}

/** What the person chose for one project, kept in the account vault so every computer agrees. */
export type Agent37ReadyProjectSettings = {
  /** The project's git identity (`github.com/owner/repo`); the machine clones it over HTTPS. */
  identity: string;
  projectName: string;
  kind: Agent37MachineKind;
  shape: Agent37ShapeId;
  /**
   * Shell commands run once in the clone before the machine sleeps: install,
   * then start what the project needs (a `docker compose up -d`, a dev
   * server in the background). Empty means clone only.
   */
  setup: string;
  /**
   * The last prepare failed, and nothing is billing for it. Kept with the
   * choice so no computer, and no app restart, pays to try again on its own;
   * Retry or a new choice clears it.
   */
  failure: Agent37ReadyFailure | null;
};

/**
 * A failed prepare. ADE tries again on its own a bounded number of times
 * (`AGENT37_READY_AUTO_RETRY_DELAYS_MS`), then waits for Retry.
 */
export type Agent37ReadyFailure = {
  error: string;
  at: number;
  /** Prepares that failed in a row; 1 for the first. */
  attempts?: number;
  /** When ADE tries again on its own, epoch ms; absent once it stopped trying. */
  retryAt?: number | null;
};

/** The waits before each automatic retry of a failed prepare; after the last, Retry is the person's. */
const AGENT37_READY_AUTO_RETRY_DELAYS_MS = [60_000, 5 * 60_000] as const;

/** When a prepare that failed for the `attempts`-th time in a row is tried again, or null for "wait for Retry". */
export function agent37ReadyRetryAt(attempts: number, at: number, retriable: boolean): number | null {
  if (!retriable) return null;
  const delay = AGENT37_READY_AUTO_RETRY_DELAYS_MS[attempts - 1];
  return delay == null ? null : at + delay;
}

/**
 * One project's ready machine, as Settings shows it.
 *
 * - `preparing`: being made and set up (`message` says which step).
 * - `ready`: prepared and asleep; the next chat takes it.
 * - `failed`: the last prepare failed; nothing is billing, Retry starts again.
 * - `waiting`: none yet and none being made (this computer will start one).
 */
export type Agent37ReadyProjectState = "preparing" | "ready" | "failed" | "waiting";

/** What ADE does to make a ready machine, in order. */
export const AGENT37_READY_STEPS = ["make", "sign_in", "clone", "setup", "sleep"] as const;
export type Agent37ReadyStep = (typeof AGENT37_READY_STEPS)[number];

/** The ready-machine step a create's stage belongs to. */
export function agent37ReadyStepOf(stage: Agent37CreateStage): Agent37ReadyStep | null {
  switch (stage) {
    case "creating":
    case "waiting_for_brain":
      return "make";
    case "signing_in":
    case "confirm_in_window":
    case "approve_elsewhere":
    case "joining":
      return "sign_in";
    default:
      return null;
  }
}

export type Agent37ReadyProjectStatus = {
  settings: Agent37ReadyProjectSettings;
  state: Agent37ReadyProjectState;
  /** One plain line. */
  message: string;
  /**
   * The step a machine this computer prepares is on; null while preparing
   * elsewhere (another computer says nothing of its step) or not preparing.
   */
  step: Agent37ReadyStep | null;
  instanceId: string | null;
  machineName: string | null;
  /** When the prepare began, epoch ms, while preparing. */
  startedAt: number | null;
  error: string | null;
};

export type Agent37ReadyStatus = {
  projects: Agent37ReadyProjectStatus[];
  /** Why the list could not be read, or null. */
  error: string | null;
};

/** What claiming a project's ready machine hands back: the machine to start the chat on. */
export type Agent37ReadyClaim = {
  instanceId: string;
  /** Its ADE machine (account row), recorded on it when it joined; a machine without one is never handed out. */
  machineKey: string;
  name: string;
  /** Where the project is on it. */
  projectPath: string | null;
  /** The project's primary lane on it, for a chat that names no lane. */
  laneId: string | null;
  /** How long Agent37 took to answer the wake. */
  wakeMs: number;
  /** Gives this claim back (`release`) while nothing has used the machine. */
  claimToken: string;
};

/** One project's pool, as `ade agent37 ready` reports it (the `agent37.ready_status` action). */
export type Agent37ReadyPoolEntry = {
  identity: string;
  projectName: string;
  /** Whether a computer keeps this project's machine ready (its setting), or only machines are left. */
  keptReady: boolean;
  /** Machines per state: `ready` (asleep, the next chat takes one), `preparing`, `inUse` (claimed), `failed`. */
  ready: number;
  preparing: number;
  inUse: number;
  failed: number;
  /** The last prepare's failure, kept until Retry. */
  failure: string | null;
  machines: Array<{ instanceId: string; name: string | null; state: Agent37ReadyMachineState; status: string }>;
};

export type Agent37ReadyPool = { projects: Agent37ReadyPoolEntry[] };

/** What a ready machine costs a month asleep: its disk. */
export function agent37ReadyIdleMonthlyUsd(shape: Agent37Shape): number {
  return shape.diskGb * DISK_GB_MONTH_USD;
}

/*
 * Settings › Integrations › Agent 37: the page's own links and the month's
 * spend per machine. Kept apart from the template, ready and create contracts
 * above.
 */

/** Agent 37's own list of the workspace's machines. */
export const AGENT37_DASHBOARD_URL = "https://www.agent37.com/dashboard/cloud/instances";

/**
 * This UTC month on Agent 37 (settled hourly), for the machines card: what each
 * listed machine spent and what sleeping saved it, and what machines that are
 * gone (listed in the usage, absent from the workspace) spent before they went.
 */
export type Agent37MonthSpend = {
  /** Epoch ms of the month's first instant (UTC). */
  sinceMs: number;
  byInstance: Record<string, { spentUsd: number; savedUsd: number | null }>;
  deletedSpentUsd: number;
  deletedCount: number;
};

/*
 * Sign-ins for cloud machines. A new cloud machine has no provider sign-in,
 * and signing in on each one is a step per machine. Instead the person signs
 * in once here: Claude with Claude Code's own `claude setup-token` (a
 * long-lived subscription token made for headless machines), the others with
 * the API key each provider's CLI reads from its environment. ADE keeps them
 * in the person's account vault and gives them to every new Agent 37 machine
 * as instance env. Each variable is the one ADE's own status reads for that
 * provider (authDetector.ts); Codex also needs its auth file, written on the
 * box at boot (agent37CloudSignInBoot.ts).
 */

/** One sign-in kept for new machines. Pi shares OpenCode's OpenRouter key. */
export type Agent37CloudSignInId =
  | "claude"
  | "codex"
  | "cursor"
  | "droid"
  | "grok"
  | "copilot"
  | "devin"
  | "muse"
  | "openrouter";

export type Agent37CloudSignInSpec = {
  id: Agent37CloudSignInId;
  /** The providers it signs in, as the card names them. */
  label: string;
  /** `claude-token`: Claude Code's own sign-in makes the token. `key`: the person pastes a key. */
  method: "claude-token" | "key";
  /** The variable a new machine gets it in. */
  env: string;
  /** What the key is called where the person makes it. */
  keyName: string;
  /** Where the person makes the key. */
  keyUrl: string | null;
  /** One sentence the card shows under the row. */
  note: string;
};

export const AGENT37_CLOUD_SIGN_INS: readonly Agent37CloudSignInSpec[] = [
  {
    id: "claude",
    label: "Claude",
    method: "claude-token",
    env: "CLAUDE_CODE_OAUTH_TOKEN",
    keyName: "Claude sign-in",
    keyUrl: null,
    note: "Uses your Claude plan. You sign in once in the browser; ADE keeps the long-lived token Claude Code makes for this.",
  },
  {
    id: "codex",
    label: "Codex",
    method: "key",
    env: "OPENAI_API_KEY",
    keyName: "OpenAI API key",
    keyUrl: "https://platform.openai.com/api-keys",
    // A ChatGPT sign-in can't be copied: each machine refreshes it, and
    // OpenAI then refuses the copies ("refresh token was already used").
    note: "Billed to your OpenAI API account. A ChatGPT sign-in can't be shared between machines, so sign in on the machine to use your plan.",
  },
  {
    id: "cursor",
    label: "Cursor",
    method: "key",
    env: "CURSOR_API_KEY",
    keyName: "Cursor API key",
    keyUrl: "https://cursor.com/dashboard/api",
    note: "Make a User API key in your Cursor dashboard.",
  },
  {
    id: "droid",
    label: "Droid",
    method: "key",
    env: "FACTORY_API_KEY",
    keyName: "Factory API key",
    keyUrl: "https://app.factory.ai/settings/api-keys",
    note: "Make an API key in your Factory settings.",
  },
  {
    id: "grok",
    label: "Grok",
    method: "key",
    env: "XAI_API_KEY",
    keyName: "xAI API key",
    keyUrl: "https://console.x.ai",
    note: "Billed to your xAI API account.",
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    method: "key",
    env: "COPILOT_GITHUB_TOKEN",
    keyName: "GitHub token",
    keyUrl: "https://github.com/settings/personal-access-tokens/new",
    note: "A fine-grained personal token with the Copilot Requests permission. Classic tokens don't work.",
  },
  {
    id: "devin",
    label: "Devin",
    method: "key",
    env: "WINDSURF_API_KEY",
    keyName: "Windsurf API key",
    keyUrl: "https://windsurf.com/",
    note: "Devin signs in with your Windsurf API key.",
  },
  {
    id: "muse",
    label: "Muse",
    method: "key",
    env: "META_API_KEY",
    keyName: "Meta API key",
    keyUrl: "https://dev.meta.ai",
    note: "Make an API key on Meta's developer site.",
  },
  {
    id: "openrouter",
    label: "OpenCode and Pi",
    method: "key",
    env: "OPENROUTER_API_KEY",
    keyName: "OpenRouter API key",
    keyUrl: "https://openrouter.ai/keys",
    note: "Both read an OpenRouter key. They also use the OpenAI and xAI keys above.",
  },
];

/** Providers with no sign-in a new machine can start with, and why, in the card's words. */
export const AGENT37_CLOUD_SIGN_IN_GAPS: readonly { provider: string; label: string; reason: string }[] = [
  {
    provider: "qwen",
    label: "Qwen Code",
    reason: "Reads its models and key from its own settings file, and its key would clash with the OpenAI key. Sign in on the machine.",
  },
  {
    provider: "kimi",
    label: "Kimi Code",
    reason: "Reads its key only from its own config file. Sign in on the machine; Kimi shows a link to approve.",
  },
  {
    provider: "antigravity",
    label: "Antigravity",
    reason: "Signs in with Google in a browser on the machine and has no key to hand over. Sign in on the machine.",
  },
];

export function agent37CloudSignInSpec(id: string): Agent37CloudSignInSpec | null {
  return AGENT37_CLOUD_SIGN_INS.find((spec) => spec.id === id) ?? null;
}

export type Agent37ClaudeSignInState = "running" | "saving" | "succeeded" | "failed" | "cancelled";

export type Agent37CloudSignInStatus = {
  /** One entry per sign-in, in `AGENT37_CLOUD_SIGN_INS` order. */
  saved: Array<{ id: Agent37CloudSignInId; saved: boolean; savedAt: number | null }>;
  /** The account could not be read, so `saved` is unknown. */
  unknown: boolean;
  /** Claude's sign-in, running in this computer's ADE background service, if any. */
  claude: {
    state: Agent37ClaudeSignInState;
    /** The link Claude Code printed. The card opens it once. */
    url: string | null;
    /** Claude Code is asking for the code shown in the browser. */
    awaitingCode: boolean;
    /** Why it failed, in one sentence. */
    message: string | null;
  } | null;
};
