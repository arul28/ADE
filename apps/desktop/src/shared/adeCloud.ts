import type { CloudAccountState, CloudCatalog, CloudHoursState } from "../../../account-directory/src/cloud/contract";
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

/** What the person picks: a sandboxed box, or a full VM. */
export type CloudMachineKind = "box" | "vm";

export type CloudShapeId = "2x4" | "4x8" | "4x16" | "4x32";

/** A box's size as the provider reports it: vCPUs, and memory and disk in GB. */
export type CloudResources = { cpu: number; memoryGb: number; diskGb: number };

export type CloudShape = {
  id: CloudShapeId;
  /** The size's name, shown everywhere a person picks one. */
  label: string;
  cpu: number;
  memoryGb: number;
};

const CLOUD_SHAPE_BY_ID: Record<CloudShapeId, CloudShape> = {
  "2x4": { id: "2x4", label: "Small", cpu: 2, memoryGb: 4 },
  "4x8": { id: "4x8", label: "Medium", cpu: 4, memoryGb: 8 },
  "4x16": { id: "4x16", label: "Large", cpu: 4, memoryGb: 16 },
  "4x32": { id: "4x32", label: "X-Large", cpu: 4, memoryGb: 32 },
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

export const CLOUD_FULL_COMPUTER_LABEL = "Full computer (Android, Docker)";

/** "full computer" or "standard computer": what a person calls each kind. */
export function cloudKindLabel(kind: CloudMachineKind): string {
  return kind === "vm" ? "full computer" : "standard computer";
}

/**
 * The server's sizes and plans (`GET /cloud/account`) for a surface that has
 * no account yet. The only copy on a client; everything else reads the answer.
 */
const CLOUD_CATALOG_FALLBACK: CloudCatalog = {
  sizes: [
    { type: "default", cpu: 2, memoryGb: 4, multiplierMilli: 1000 },
    { type: "default", cpu: 4, memoryGb: 8, multiplierMilli: 2000 },
    { type: "default", cpu: 4, memoryGb: 16, multiplierMilli: 3300 },
    { type: "default", cpu: 4, memoryGb: 32, multiplierMilli: 5800 },
    { type: "vm", cpu: 2, memoryGb: 4, multiplierMilli: 2500 },
    { type: "vm", cpu: 4, memoryGb: 8, multiplierMilli: 5000 },
    { type: "vm", cpu: 4, memoryGb: 16, multiplierMilli: 8200 },
    { type: "vm", cpu: 4, memoryGb: 32, multiplierMilli: 14500 },
  ],
  plans: {
    free: { includedMilli: 50_000, computerLimit: 3, diskGb: 4 },
    paid: { includedMilli: 500_000, computerLimit: 10, diskGb: 40 },
  },
  diskStepGb: 4,
  paidPriceUsd: 5,
  extraHourCents: 1,
};

/** The sizes and plans the server answers with, or the fallback until the account has loaded. */
export function cloudCatalogOf(account: Pick<CloudAccountState, "catalog"> | null | undefined): CloudCatalog {
  return account?.catalog ?? CLOUD_CATALOG_FALLBACK;
}

/** Hours of a Small computer this size uses per hour awake. */
export function cloudHoursRate(kind: CloudMachineKind, shape: CloudShapeId, catalog: CloudCatalog = CLOUD_CATALOG_FALLBACK): number {
  const { cpu, memoryGb } = cloudShapeById(shape);
  const type = cloudInstanceType(kind);
  const size = catalog.sizes.find((entry) => entry.type === type && entry.cpu === cpu && entry.memoryGb === memoryGb);
  return (size?.multiplierMilli ?? 1000) / 1000;
}

/** "2× hours". */
export function formatCloudHoursRate(rate: number): string {
  return `${rate}× hours`;
}

/** "about 3.3 hours" per hour awake, for approval cards. */
export function describeCloudHoursUse(kind: CloudMachineKind, shape: CloudShapeId, catalog?: CloudCatalog): string {
  return `about ${cloudHoursRate(kind, shape, catalog)} hours of your plan for each hour it's awake`;
}

/** Android needs a full computer of Medium or bigger. */
export function cloudShapeRunsAndroid(shape: CloudShapeId): boolean {
  return shape !== "2x4";
}

/** The shape with this CPU count and memory (what a box sees from inside), or null. */
export function cloudShapeForResources(cpu: number, memoryBytes: number): CloudShape | null {
  const memoryGb = Math.round(memoryBytes / 1024 ** 3);
  return CLOUD_SHAPES.find((shape) => shape.cpu === cpu && shape.memoryGb === memoryGb) ?? null;
}

/** The smallest full computer that runs the Android emulator. */
const CLOUD_ANDROID_VM_SHAPE = cloudShapeById("4x8");

/**
 * Why a computer can't run the Android emulator, in plain words for the
 * person: a full computer can, what that uses in hours, and what happens to
 * this one. The agent's next steps are in the `ade-android` and `ade-cloud` skills.
 */
export function cloudAndroidNeedsVmMessage(boxShape: CloudShape | null): string {
  // A computer bigger than Medium moves to a full computer of its own size.
  const vmShape = boxShape && CLOUD_SHAPES.indexOf(boxShape) > CLOUD_SHAPES.indexOf(CLOUD_ANDROID_VM_SHAPE)
    ? boxShape
    : CLOUD_ANDROID_VM_SHAPE;
  const rate = cloudHoursRate("vm", vmShape.id);
  const more = boxShape ? `, about ${(rate - cloudHoursRate("box", boxShape.id)).toFixed(1).replace(/\.0$/, "")} more than this computer` : "";
  return "This computer can't run the Android emulator. A full computer can, at Medium or bigger. "
    + `A ${vmShape.label} full computer uses about ${rate} hours for each hour it's awake${more}. `
    + "ADE can make it and continue this chat there, with its history and changes. "
    + "This computer stays, and you can delete it from the new chat.";
}

/** ADE Cloud's state, as Settings and the machine picker read it. */
export type CloudStatus = {
  connected: boolean;
  /** This computer isn't signed in to ADE, so nothing is known about the account. */
  signedOut: boolean;
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
  /** The name the machine gets in ADE and on ADE Cloud. */
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
 * A box as the machine list shows it. `asleep` and `stopped` use no hours;
 * `starting` covers provisioning, waking, restarting and a resize or update
 * in flight.
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
  /** ADE sets this to the machine's name at create. */
  name: string | null;
  /** the provider's own status word, for logs and the tooltip. */
  status: string;
  state: CloudMachineState;
  type: CloudMachineType;
  resources: CloudResources | null;
  /** The size ADE offers this shape as, when it is one of them. */
  shapeId: CloudShapeId | null;
  region: string | null;
  /** How fast it uses hours while awake, as multiples of a Small computer. Null at a size ADE doesn't offer. */
  hoursRate: number | null;
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
  createdAtMs: number | null;
  /**
   * Set when this is a project's ready machine (prepared and kept asleep for
   * the next chat): the project it is for, and where it is in that life.
   */
  ready: { projectName: string; state: CloudReadyMachineState } | null;
  /** How the box sleeps when nothing runs on it (see `CloudSleepPolicy`). */
  sleep: CloudSleepPolicy;
  /** A plain sentence when its disk is full and can't grow, or null. */
  diskFull: string | null;
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
/** A computer sleeps 3 minutes after its last activity (`cloudKeepAwake`); the provider's own timer, at its 5-minute floor, is the backstop. */
export const CLOUD_BACKSTOP_SLEEP_MINUTES = 5;
/** The chat whose agent made a machine (create, copy, move): only that chat's unattended agent may delete it. */
export const CLOUD_MADE_BY_CHAT_METADATA = "ade_made_by_chat";

/** Set by the computer's brain when its disk is full and can't grow: `free_limit` or `account_limit`. */
export const CLOUD_DISK_FULL_METADATA = "ade_disk_full";
export type CloudDiskFullReason = "free_limit" | "account_limit";

/** What a person reads on a computer whose disk is full and can't grow, or null. */
export function cloudDiskFullMessage(reason: string | null | undefined, catalog: CloudCatalog = CLOUD_CATALOG_FALLBACK): string | null {
  if (reason === "free_limit") return `This computer's disk is full. Free computers stay at ${catalog.plans.free.diskGb} GB; a paid plan lets it grow.`;
  if (reason === "account_limit") return `This computer's disk is full, and your computers have reached the ${catalog.plans.paid.diskGb} GB they share.`;
  return null;
}

/**
 * - `auto`: sleeps a few minutes after nothing runs on it.
 * - `pending`: ADE has not turned sleep on yet: the box's ADE predates it, or
 *   ADE has not reached the box since. It sleeps only when someone sleeps it.
 */
export type CloudSleepPolicy =
  | { state: "auto" }
  | { state: "pending" };

/** Waking the box behind an account machine for use (`wakeCloudMachineForUse`). */
export type CloudWakeForUseResult =
  | { state: "woken"; instanceId: string; wakeMs: number }
  | { state: "awake"; instanceId: string }
  | { state: "not_cloud" }
  | { state: "refused"; message: string };

/** "Sleeps when idle" / "Sleeps once ADE on it updates". */
export function describeCloudSleepPolicy(policy: CloudSleepPolicy): string {
  return policy.state === "auto" ? "Sleeps when idle" : "Sleeps once ADE on it updates";
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

export type { CloudAccountState, CloudCatalog, CloudHoursState };

/** The server's sentence for what needs hours at 0. The server enforces it; these two only stop a request that can't work. */
export const CLOUD_OUT_OF_HOURS_MESSAGE = "You're out of ADE Cloud hours for this period.";

export const CLOUD_HOURS_UNKNOWN_MESSAGE =
  "ADE couldn't read your ADE Cloud hours, so it didn't start or change a computer. Try again in a minute.";

export function cloudOutOfHours(account: Pick<CloudAccountState, "hours"> | null | undefined): boolean {
  return account?.hours.state === "zero";
}

/**
 * Why work that nobody approves (a full-auto chat, an automation, the
 * ready-machine keeper, a sign-in the brain approves itself) may not go ahead:
 * the account is out of hours, or ADE could not read it. Unknown counts as out.
 * Null when it may go ahead.
 */
export function cloudUnattendedHoursBlock(
  account: Pick<CloudAccountState, "hours"> | null | undefined,
): "hours_unknown" | "out_of_hours" | null {
  if (!account) return "hours_unknown";
  return cloudOutOfHours(account) ? "out_of_hours" : null;
}

/** Whether a `cloud` action domain says this account has ADE Cloud; false when it can't say. */
export async function cloudDomainEnabled(
  domain: Record<string, unknown> | null | undefined,
  onError?: (error: unknown) => void,
): Promise<boolean> {
  const access = domain?.access;
  if (typeof access !== "function") return false;
  try {
    return ((await access.call(domain)) as { enabled?: unknown } | null)?.enabled === true;
  } catch (error) {
    onError?.(error);
    return false;
  }
}

/** "412" or "49.5" hours from thousandths. */
export function formatCloudHours(milli: number): string {
  const hours = Math.max(0, milli) / 1000;
  return hours >= 100 ? String(Math.floor(hours)) : String(Math.floor(hours * 10) / 10);
}

/** The banner for an account, or null when there is nothing to warn about. */
export type CloudAccountBanner = {
  id: string;
  tone: "info" | "warning";
  title: string;
  detail: string;
};

export function formatCloudDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "You're out of hours", "You've used 95%", a failed payment: one banner, the most urgent. */
export function cloudAccountBanner(account: CloudAccountState): CloudAccountBanner | null {
  const resetDate = formatCloudDate(account.billing.periodEnd);
  const left = formatCloudHours(account.hours.leftMilli);
  const catalog = cloudCatalogOf(account);
  if (account.billing.notice === "past_due") {
    return {
      id: "cloud-hours-past-due",
      tone: "warning",
      title: "Your last ADE Cloud payment failed",
      detail: "Your account follows the free plan until it's paid. Update your card to bring your plan back.",
    };
  }
  if (account.hours.state === "zero") {
    return {
      id: "cloud-hours-zero",
      tone: "warning",
      title: "You're out of ADE Cloud hours",
      detail: account.extraHours.available
        ? `Your computers are stopped until ${resetDate}. Turn on extra hours to keep going sooner.`
        : `Your computers are stopped until ${resetDate}. The paid plan has ${formatCloudHours(catalog.plans.paid.includedMilli)} hours a month.`,
    };
  }
  if (account.hours.state === "warn95" || account.hours.state === "warn80") {
    const percent = account.hours.state === "warn95" ? 95 : 80;
    return {
      id: `cloud-hours-${percent}`,
      tone: percent === 95 ? "warning" : "info",
      title: `You've used ${percent}% of your ADE Cloud hours`,
      detail: `${left} ${left === "1" ? "hour" : "hours"} left until ${resetDate}.`,
    };
  }
  if (account.billing.notice === "restored") {
    return { id: "cloud-hours-restored", tone: "info", title: "Your ADE Cloud plan is back", detail: "Your payment went through. Thanks." };
  }
  return null;
}

export type CloudMachinesResult = {
  /**
   * `ok`: read. `not_connected`: no ADE Cloud from here (no access, signed out, or the vault couldn't be read), with `message` saying which. `access_refused`: the
   * provider refused this account. `unreachable`: the provider did not answer.
   */
  state: "ok" | "not_connected" | "access_refused" | "unreachable";
  machines: CloudMachine[];
  instanceCount: number | null;
  runningCount: number | null;
  /** Plan and hours, or null when they couldn't be read; the computers still show. */
  account: CloudAccountState | null;
  /**
   * Instances with use in the last 90 days that are gone from the account,
   * whose ADE rows stay on the account until someone removes them.
   */
  deletedInstanceIds?: string[];
  /** A plain sentence for `access_refused` and `unreachable`. */
  message: string | null;
};

export type CloudMachineActionKind = "sleep" | "wake" | "resize" | "backup" | "delete" | "update";

export type CloudMachineActionArgs = {
  instanceId: string;
  action: CloudMachineActionKind;
  /** The new size, for `resize`. */
  shape?: CloudShapeId;
  /** For `delete`: the box's ADE machine, removed from the account once the box is gone. */
  machineKey?: string | null;
  /** For `delete`: who asked, for the server's delete log (an agent's chat; a person's desktop leaves it unset). */
  who?: string | null;
};

export type CloudMachineActionResult = {
  ok: boolean;
  /** One plain line: what happened, or why it didn't. */
  message: string;
  /**
   * What stops the action, so the card can offer the way out:
   * plans and hours, or wait for a backup window.
   */
  blocker: "rate_limited" | "out_of_hours" | null;
  /** For `delete`: the box is gone but its account row could not be removed. */
  accountRowLeft?: boolean;
};

/** "Small · 2 CPU · 4 GB", with "Full computer" in front for a VM. */
export function describeCloudMachineSize(machine: Pick<CloudMachine, "type" | "resources" | "shapeId">): string {
  const shape = machine.shapeId ? cloudShapeById(machine.shapeId) : null;
  const size = machine.resources
    ? `${machine.resources.cpu} CPU · ${machine.resources.memoryGb} GB`
    : null;
  return [machine.type === "vm" ? "Full computer" : null, shape?.label ?? null, size].filter(Boolean).join(" · ");
}

/** The kind of machine this instance type is. */
export function cloudMachineKindOf(type: CloudMachineType): CloudMachineKind {
  return type === "vm" ? "vm" : "box";
}

/** The shape ADE offers for these resources (cpu and memory decide it), or null. */
export function cloudShapeFor(resources: Pick<CloudResources, "cpu" | "memoryGb"> | null): CloudShape | null {
  if (!resources) return null;
  return CLOUD_SHAPES.find((shape) => shape.cpu === resources.cpu && shape.memoryGb === resources.memoryGb) ?? null;
}

/** a provider instance id, as ADE accepts one from a caller. */
export function isCloudInstanceId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]{4,40}$/.test(value);
}
