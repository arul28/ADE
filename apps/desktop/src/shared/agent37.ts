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

export const AGENT37_SHAPES: readonly Agent37Shape[] = [
  { id: "2x4", cpu: 2, memoryGb: 4, diskGb: 12 },
  { id: "4x8", cpu: 4, memoryGb: 8, diskGb: 20 },
  { id: "4x16", cpu: 4, memoryGb: 16, diskGb: 40 },
  { id: "4x32", cpu: 4, memoryGb: 32, diskGb: 80 },
];

export function agent37Shape(id: string | null | undefined): Agent37Shape | null {
  return AGENT37_SHAPES.find((shape) => shape.id === id) ?? null;
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

export function agent37KindSpec(kind: Agent37MachineKind): Agent37KindSpec {
  return AGENT37_KINDS.find((spec) => spec.kind === kind) ?? AGENT37_KINDS[0]!;
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
  ready?: { projectName: string; state: Agent37ReadyMachineState } | null;
};

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
  /** A plain sentence for `key_refused` and `unreachable`. */
  message: string | null;
};

export type Agent37MachineActionKind = "sleep" | "wake" | "resize" | "backup" | "delete";

export type Agent37MachineActionArgs = {
  instanceId: string;
  action: Agent37MachineActionKind;
  /** The new size, for `resize`. */
  shape?: Agent37ShapeId;
  /** For `delete`: the box's ADE machine, removed from the account once the box is gone. */
  machineKey?: string | null;
};

export type Agent37MachineActionResult = {
  ok: boolean;
  /** One plain line: what happened, or why it didn't. */
  message: string;
  /**
   * What stops the action, so the card can offer the way out: top up the
   * wallet, raise the limit, fix the key, or wait for a backup window.
   */
  blocker: "wallet" | "limit" | "suspended" | "key" | "rate_limited" | null;
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
  /** A rough estimate while building. */
  minutesLeft: number | null;
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
      const left = status.minutesLeft != null ? `, about ${status.minutesLeft} min left` : "";
      return status.usable
        ? `Updating ADE's machine template${left}. New machines use the current one until then.`
        : `Setting up ADE's machine template in your Agent 37 workspace${left}.`;
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

/** `ade chat create --machine agent37:ready`: start the chat on this project's ready machine. */
export const AGENT37_READY_MACHINE_SELECTOR = "agent37:ready";

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
  /** The project's git identity; the key everything else matches on. */
  identity: string;
  /** What the machine clones. */
  originUrl: string;
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
  failure?: { error: string; at: number } | null;
};

/**
 * One project's ready machine, as Settings shows it.
 *
 * - `preparing`: being made and set up (`message` says which step).
 * - `ready`: prepared and asleep; the next chat takes it.
 * - `failed`: the last prepare failed; nothing is billing, Retry starts again.
 * - `waiting`: none yet and none being made (this computer will start one).
 */
export type Agent37ReadyProjectState = "preparing" | "ready" | "failed" | "waiting";

export type Agent37ReadyProjectStatus = {
  settings: Agent37ReadyProjectSettings;
  state: Agent37ReadyProjectState;
  /** One plain line. */
  message: string;
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
  /** Its ADE machine (account row), recorded on it when it joined. */
  machineKey: string | null;
  name: string;
  /** Where the project is on it. */
  projectPath: string | null;
  /** The project's primary lane on it, for a chat that names no lane. */
  laneId: string | null;
  /** How long Agent37 took to answer the wake. */
  wakeMs: number;
};

/** What a ready machine costs a month asleep: its disk. */
export function agent37ReadyIdleMonthlyUsd(shape: Agent37Shape): number {
  return shape.diskGb * DISK_GB_MONTH_USD;
}

/** "Asleep it costs about $1.80 a month (its disk). A chat on it costs 3.3¢ an hour while it's awake." */
export function describeAgent37ReadyCost(kind: Agent37MachineKind, shape: Agent37Shape): string {
  return `Asleep it costs about ${formatAgent37Usd(agent37ReadyIdleMonthlyUsd(shape))} a month (its disk). `
    + `A chat on it costs ${formatAgent37HourlyPrice(agent37HourlyUsd(kind, shape))} while it's awake.`;
}
