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
  const compute = shape.cpu * VCPU_MONTH_USD + shape.memoryGb * MEMORY_GB_MONTH_USD;
  const monthly = compute * (kind === "vm" ? 2.5 : 1) + shape.diskGb * DISK_GB_MONTH_USD;
  return monthly / HOURS_PER_MONTH;
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
  instanceCount: number | null;
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

/** Why a shape or kind cannot be made on this workspace right now, or null. */
export function agent37ChoiceBlocker(
  status: Pick<Agent37Status, "tier" | "instanceLimit" | "instanceCount" | "pastDue">,
  kind: Agent37MachineKind,
  shape: Agent37Shape,
): string | null {
  if (status.pastDue) return "Your Agent 37 wallet is past due. Top it up to make machines.";
  if (status.instanceLimit != null && status.instanceCount != null && status.instanceCount >= status.instanceLimit) {
    return `Your Agent 37 workspace holds ${status.instanceLimit} machine${status.instanceLimit === 1 ? "" : "s"} at most, sleeping ones included. Delete one or top up to raise the limit.`;
  }
  if (status.tier === 0 && (kind === "vm" || shape.id !== "2x4")) {
    return "Agent 37 unlocks VMs and bigger sizes after your first top-up.";
  }
  return null;
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
