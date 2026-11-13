import type {
  CloudAccountState,
  CloudCatalog,
  CloudDiskRefusalReason,
  CloudDiskUsage,
  CloudDiskUsageItem,
  CloudDiskUsageKind,
  CloudDiskUsageReport,
  CloudLaneWork,
  CloudHoursState,
  CloudPaidPlanId,
  CloudPlanChangeTiming,
  CloudPlanCleanup,
  CloudPlanCleanupComputer,
  CloudPlanCleanupDone,
  CloudPlanCleanupPick,
  CloudPlanFacts,
  CloudPlanId,
  CloudSustainedCpuReport,
  CloudTimedWakesCancelled,
} from "../../../account-directory/src/cloud/contract";
import { CLOUD_INVITE_REFUSAL_REASONS, formatCloudCents, overPlanDiskSentence } from "../../../account-directory/src/cloud/contract";
import type {
  CloudEarnedHours,
  CloudFreePlan,
  CloudFreePlanGithub,
  CloudFreePlanGithubState,
  CloudFreePlanState,
  CloudFreeUnlockResult,
  CloudInviteRedeemResult,
  CloudInviteRefusalReason,
  CloudReferralSummary,
} from "../../../account-directory/src/cloud/contract";
export {
  CLOUD_INVITE_REFUSAL_REASONS,
  CLOUD_REFERRAL_ENTER_DAYS,
  CLOUD_REFERRAL_REWARD_LIMIT,
  CLOUD_REFERRAL_REWARD_MILLI,
  CLOUD_FREE_GITHUB_MIN_AGE_DAYS,
  cloudFreeGithubSentence,
  cloudFreePlanRefusedSentence,
  formatCloudFreeGithubDay,
  cloudInviteLink,
  parseCloudInviteCode,
} from "../../../account-directory/src/cloud/contract";
export type { CloudEarnedHours, CloudFreePlan, CloudFreePlanGithub, CloudFreePlanGithubState, CloudFreePlanState, CloudFreeUnlockResult, CloudInviteRedeemResult, CloudInviteRefusalReason, CloudReferralSummary, CloudSustainedCpuReport };
/** The shared sentences for a cheaper plan's limits and cancelled timed wakes (the server's emails say the same). */
export { overPlanLimitsSentence, planCleanupDoneSentence, planCleanupSentence, timedWakesCancelledSentence } from "../../../account-directory/src/cloud/contract";

export { formatCloudCents };

/**
 * Stamped on every ADE Cloud approval card (`providerMetadata`). Only the
 * person answers one: the card is the consent to spend hours, delete a
 * computer or clear its caches, so an agent's answer is refused
 * (`isUserOnlyConsentCard`).
 */
export const ADE_CLOUD_APPROVAL_METADATA_KEY = "adeCloudApproval" as const;

/**
 * ADE Cloud: Linux machines ADE runs for the person, each with ADE's brain as
 * its main process, signed in to their account, and listed with their other
 * computers.
 *
 * Everything here is account-level: it acts on the account's cloud machines,
 * not on any lane, chat or machine.
 *
 * The sign-ins for cloud machines live in cloudSignIns.ts.
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
    { type: "default", cpu: 2, memoryGb: 4, multiplierMilli: 1000, tier: "small", label: "Small", diskMaxGb: 12 },
    { type: "default", cpu: 4, memoryGb: 8, multiplierMilli: 2000, tier: "medium", label: "Medium", diskMaxGb: 20 },
    { type: "default", cpu: 4, memoryGb: 16, multiplierMilli: 3300, tier: null, label: "Standard 4 CPU, 16 GB", diskMaxGb: 40 },
    { type: "default", cpu: 4, memoryGb: 32, multiplierMilli: 5800, tier: null, label: "Standard 4 CPU, 32 GB", diskMaxGb: 80 },
    { type: "vm", cpu: 2, memoryGb: 4, multiplierMilli: 2500, tier: null, label: "Full 2 CPU, 4 GB", diskMaxGb: 100 },
    { type: "vm", cpu: 4, memoryGb: 8, multiplierMilli: 5000, tier: "large", label: "Large", diskMaxGb: 50 },
    { type: "vm", cpu: 4, memoryGb: 16, multiplierMilli: 8000, tier: "xlarge", label: "X-Large", diskMaxGb: 100 },
    { type: "vm", cpu: 4, memoryGb: 32, multiplierMilli: 14500, tier: null, label: "Full 4 CPU, 32 GB", diskMaxGb: 100 },
  ],
  // Only what every server sells: Pro and extra disk are offered only when the server sends them.
  plans: {
    free: { includedMilli: 50_000, computerLimit: 3, diskGb: 12, priceUsd: 0 },
    paid: { includedMilli: 500_000, computerLimit: 10, diskGb: 40, priceUsd: 5 },
  },
  diskStepGb: 4,
  paidPriceUsd: 5,
  extraHourCents: 1,
};

/**
 * The sizes and plans the server answers with, or the fallback until the
 * account has loaded. Nothing is added that the server didn't send: a server
 * before Pro has no `plus`, `pro` or extra-disk price, and its `paid` plan
 * gets only its own price (`paidPriceUsd`) filled in.
 */
export function cloudCatalogOf(account: Pick<CloudAccountState, "catalog"> | null | undefined): CloudCatalog {
  const catalog = account?.catalog;
  if (!catalog) return CLOUD_CATALOG_FALLBACK;
  return {
    ...catalog,
    plans: {
      ...catalog.plans,
      free: { ...catalog.plans.free, priceUsd: catalog.plans.free.priceUsd ?? 0 },
      paid: { ...catalog.plans.paid, priceUsd: catalog.plans.paid.priceUsd ?? catalog.paidPriceUsd },
    },
  };
}

/** True when the server sells Plus and Pro (and so takes `{ plan }` at checkout). */
export function cloudCatalogHasPro(catalog: CloudCatalog): catalog is CloudCatalog & { plans: { plus: CloudPlanFacts; pro: CloudPlanFacts } } {
  return catalog.plans.plus != null && catalog.plans.pro != null;
}

/** Which plan the account has: `plus` for a paid account from a server that predates Pro. */
export function cloudPlanIdOf(account: Pick<CloudAccountState, "plan" | "planId">): CloudPlanId {
  if (account.planId === "free" || account.planId === "plus" || account.planId === "pro") return account.planId;
  return account.plan === "paid" ? "plus" : "free";
}

/** The facts of the account's plan, from what the server sent: a server before Pro has only `free` and `paid`. */
export function cloudPlanFactsOf(account: Pick<CloudAccountState, "plan" | "planId">, catalog: CloudCatalog): CloudPlanFacts {
  const byId = account.planId === "plus" || account.planId === "pro" ? catalog.plans[account.planId] : undefined;
  return byId ?? catalog.plans[account.plan];
}

/** "Free", "Plus" or "Pro"; a paid account on a server before Pro keeps its old name, "$5 plan". */
export function cloudPlanLabelOf(account: Pick<CloudAccountState, "plan" | "planId">, catalog: CloudCatalog): string {
  if (account.planId === "plus" || account.planId === "pro") return CLOUD_PLAN_LABELS[account.planId];
  return account.plan === "paid" ? `$${catalog.paidPriceUsd} plan` : CLOUD_PLAN_LABELS.free;
}

export const CLOUD_PLAN_LABELS: Readonly<Record<CloudPlanId, string>> = { free: "Free", plus: "Plus", pro: "Pro" };
/** Plan order, cheapest first: whether a move between two plans is up or down. */
export const CLOUD_PLAN_RANK: Readonly<Record<CloudPlanId, number>> = { free: 0, plus: 1, pro: 2 };

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

/** The full computer a computer of this size moves to for Android: Medium, or its own size when bigger. */
export function cloudAndroidVmShape(boxShape: CloudShape | null): CloudShape {
  return boxShape && CLOUD_SHAPES.indexOf(boxShape) > CLOUD_SHAPES.indexOf(CLOUD_ANDROID_VM_SHAPE)
    ? boxShape
    : CLOUD_ANDROID_VM_SHAPE;
}

/**
 * Whether this cloud computer runs the Android emulator: a full computer of
 * Medium or bigger. A full computer whose size ADE can't tell counts as one
 * that does, so nothing claims what ADE doesn't know.
 */
export function cloudMachineRunsAndroid(machine: Pick<CloudMachine, "type" | "shapeId">): boolean {
  if (machine.type !== "vm") return false;
  return machine.shapeId ? cloudShapeRunsAndroid(machine.shapeId) : true;
}

/**
 * The first half of {@link cloudAndroidNeedsVmMessage}: that this computer
 * can't run the emulator, that a full computer of Medium or bigger can, and
 * what that uses in hours. `kind` is what this computer is now.
 */
export function cloudAndroidNeedsVmCost(boxShape: CloudShape | null, kind: CloudMachineKind = "box"): string {
  const vmShape = cloudAndroidVmShape(boxShape);
  const rate = cloudHoursRate("vm", vmShape.id);
  const more = boxShape ? `, about ${(rate - cloudHoursRate(kind, boxShape.id)).toFixed(1).replace(/\.0$/, "")} more than this computer` : "";
  return "This computer can't run the Android emulator. A full computer can, at Medium or bigger. "
    + `A ${vmShape.label} full computer uses about ${rate} hours for each hour it's awake${more}.`;
}

/**
 * Why a computer can't run the Android emulator, in plain words for the
 * person: a full computer can, what that uses in hours, and what happens to
 * this one. The agent's next steps are in the `ade-android` and `ade-cloud` skills.
 */
export function cloudAndroidNeedsVmMessage(boxShape: CloudShape | null): string {
  return `${cloudAndroidNeedsVmCost(boxShape)} `
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

/**
 * How long a start waits for a woken cloud computer's ADE to come online and
 * take work. the provider answers a wake in about a second; ADE's own
 * reconnect after a long sleep takes longer.
 */
export const CLOUD_WAKE_WAIT_MS = 120_000;

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
  /** How the box sleeps when nothing runs on it (see `CloudSleepPolicy`). */
  sleep: CloudSleepPolicy;
  /** A plain sentence when its disk is full and can't grow, or null. */
  diskFull: string | null;
  /** How it keeps its image and ADE current. Absent from servers before updates. */
  update?: CloudMachineUpdate | null;
  /** When it last did work (its own report), else when it was last awake; null when unknown. */
  lastActiveAtMs?: number | null;
  /** What uses its disk, as it last measured itself while awake; null before its first measure. */
  diskUsage?: CloudDiskUsage | null;
  /** Its lane's work as it last read it while awake (unpushed, the pull request); null before its first report. */
  laneWork?: CloudLaneWork | null;
};

/**
 * A cloud computer updates itself (the server's `updates.ts`): when it is idle
 * or asleep, never while work runs, onto its channel's image.
 */
export type CloudMachineUpdate = {
  channel: "stable" | "beta";
  /** The image it runs and the one its channel is on (`ade@N`). */
  image: string | null;
  target: string | null;
  /**
   * Its channel's automatic updates are on, so it updates itself. False when
   * the channel is `off`: it then keeps the ordinary Update button.
   */
  auto: boolean;
  /** `auto`: settled, it updates itself when idle. */
  state: "auto" | "updating" | "failed";
  /** Why the last update failed, one plain sentence; null unless `failed`. */
  error: string | null;
  updatedAtMs: number | null;
};

/**
 * A cloud computer that updates itself: its server reports updates and its
 * channel's automatic updates are on. Such a computer shows `cloudUpdateLine`
 * instead of an Update button and never counts as behind.
 */
export function cloudMachineSelfUpdating(box: Pick<CloudMachine, "update"> | null | undefined): boolean {
  return box?.update?.auto === true;
}

/**
 * The machine keys of the cloud computers that update themselves, from a
 * cloud list. A machine's connection names it by this key (its color key).
 */
export function selfUpdatingCloudMachineKeys(result: CloudMachinesResult | null | undefined): Set<string> {
  if (result?.state !== "ok") return new Set();
  return new Set(result.machines.flatMap((box) => (box.machineKey && cloudMachineSelfUpdating(box) ? [box.machineKey] : [])));
}

/**
 * The one line a cloud computer shows where another machine has an Update
 * button. `retry`: the line offers the person's own update again.
 */
export function cloudUpdateLine(update: CloudMachineUpdate | null | undefined): { text: string; tone: "muted" | "busy" | "error"; retry: boolean } {
  if (update?.state === "updating") return { text: "Updating…", tone: "busy", retry: false };
  if (update?.state === "failed") {
    const reason = update.error?.trim().replace(/\.$/, "") ?? "";
    return {
      text: reason ? `Update failed: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}.` : "Update failed.",
      tone: "error",
      retry: true,
    };
  }
  return { text: "Updates itself when idle", tone: "muted", retry: false };
}

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
/**
 * Which kind of agent made a machine (`chat`, `automation`, `mcp`), also with
 * no chat: the agents' daily limit counts it from the account's list, so it
 * holds across restarts and brains. A person's own make carries neither key.
 */
export const CLOUD_MADE_BY_AGENT_METADATA = "ade_made_by_agent";
export type CloudAgentMaker = "chat" | "automation" | "mcp";

/** The made-by keys for a new machine's metadata; empty for a person's own make. */
export function cloudMadeByMetadata(made: { madeByChat?: string | null; madeByAgent?: CloudAgentMaker | null }): Record<string, string> {
  return {
    ...(made.madeByChat ? { [CLOUD_MADE_BY_CHAT_METADATA]: made.madeByChat } : {}),
    ...(made.madeByAgent ? { [CLOUD_MADE_BY_AGENT_METADATA]: made.madeByAgent } : {}),
  };
}

/**
 * Set by the computer's brain when its disk is full and can't grow:
 * `free_limit` or `account_limit`. Builds before plans read only this one.
 */
export const CLOUD_DISK_FULL_METADATA = "ade_disk_full";
export type CloudDiskFullReason = "free_limit" | "account_limit";
/** The server's exact reason (`CloudDiskRefusalReason`), written next to `ade_disk_full` by newer computers. */
export const CLOUD_DISK_FULL_REASON_METADATA = "ade_disk_full_reason";

/** The older key's value for an exact reason, so builds before plans still say something. */
export function cloudDiskFullLegacyReason(reason: string): CloudDiskFullReason {
  return reason === "plan_disk" ? "free_limit" : "account_limit";
}

/**
 * What a person reads on a computer whose disk is full and can't grow, or
 * null. The exact reason wins over the older one; a reason this build
 * doesn't know still gets a plain sentence.
 */
export function cloudDiskFullMessage(
  reason: string | null | undefined,
  catalog: CloudCatalog = CLOUD_CATALOG_FALLBACK,
  exactReason?: string | null,
): string | null {
  const wayOut = cloudDiskGrowRefusedWayOut(reason, catalog, exactReason);
  return wayOut ? `This computer's disk is full. ${wayOut}` : null;
}

/**
 * Why a cloud computer's disk can't grow and the way out, without the "disk
 * is full" head (the chat's refusal and the card each say that their own
 * way), or null with no reason. The exact reason wins over the older one.
 */
export function cloudDiskGrowRefusedWayOut(
  reason: string | null | undefined,
  catalog: CloudCatalog = CLOUD_CATALOG_FALLBACK,
  exactReason?: string | null,
): string | null {
  // A server before Pro keeps each free computer at its own few GB; a newer one shares the free disk.
  const freeRule = cloudCatalogHasPro(catalog)
    ? `Free computers share ${catalog.plans.free.diskGb} GB of disk at one time. A paid plan gives more.`
    : `Free computers stay at ${catalog.plans.free.diskGb} GB each; a paid plan lets it grow.`;
  const known: Partial<Record<CloudDiskRefusalReason | CloudDiskFullReason, string>> = {
    plan_disk: freeRule,
    needs_approval: "Turn on extra disk in Settings to let it grow.",
    extra_off: "Delete a computer you no longer use, or turn on extra disk in Settings.",
    monthly_limit: "Extra disk reached the monthly limit you set. Raise it in Settings.",
    tier_limit: "This size can't have a bigger disk. Move it to a bigger size.",
    unavailable: "ADE Cloud can't grow it right now.",
    free_limit: freeRule,
    account_limit: "Your computers use all your plan's disk at one time. Delete a computer you no longer use, turn on extra disk, or pick a bigger plan in Settings.",
  };
  for (const value of [exactReason, reason]) {
    if (!value) continue;
    return known[value as keyof typeof known] ?? "It can't grow right now.";
  }
  return null;
}


/** Room beyond what is asked for, for the filesystem's share of a grown disk. */
const CLOUD_DISK_GROW_MARGIN_MB = 256;

/** What a disk grow would do under the plan rules; `settings` sends the person to turn on extra disk. */
export type CloudDiskGrowPlan =
  | { grow: false; sentence: string; settings?: boolean }
  | { grow: true; sentence: string; toGb: number };

/**
 * Whether a computer's disk can grow by `shortMb` (to the smallest whole
 * number of steps that frees it), and the sentence that says so, by the plan
 * rules: the disk all the account's computers have at one time, the size's
 * own disk cap, and extra disk on a paid plan. The server checks all of it
 * again on the grow.
 */
export function cloudDiskGrowPlan(box: CloudMachine, account: CloudAccountState | null, shortMb: number): CloudDiskGrowPlan {
  const catalog = cloudCatalogOf(account);
  const resources = box.resources;
  const currentGb = resources?.diskGb ?? null;
  if (!resources || currentGb == null || currentGb <= 0) {
    return { grow: false, sentence: "ADE Cloud didn't say how big this computer's disk is, so ADE can't offer a bigger one." };
  }
  const stepGb = catalog.diskStepGb;
  const toGb = currentGb + stepGb * Math.max(1, Math.ceil((shortMb + CLOUD_DISK_GROW_MARGIN_MB) / (stepGb * 1024)));
  const type = cloudInstanceType(cloudMachineKindOf(box.type));
  const maxGb = catalog.sizes.find((size) => size.type === type && size.cpu === resources.cpu && size.memoryGb === resources.memoryGb)?.diskMaxGb;
  if (maxGb != null && toGb > maxGb) {
    return { grow: false, sentence: "This size can't have a disk that big. Move it to a bigger size." };
  }
  const growTo = `Grow this computer's disk from ${currentGb} GB to ${toGb} GB.`;
  if (!account) return { grow: true, toGb, sentence: `${growTo} The computer restarts.` };
  const free = account.rules === "free" || cloudPlanIdOf(account) === "free";
  const limitGb = account.disk.limitGb;
  if (limitGb == null) {
    // An older server gives no account limit only on a free account, whose computers stay at their first disk.
    return { grow: false, sentence: `Free computers stay at ${catalog.plans.free.diskGb} GB each; a paid plan lets it grow.` };
  }
  const afterGb = account.disk.usedGb - currentGb + toGb;
  const pastGb = afterGb - limitGb;
  if (pastGb <= 0) {
    return { grow: true, toGb, sentence: `${growTo} Your computers then have ${afterGb} GB of your plan's ${limitGb} GB at one time. The computer restarts.` };
  }
  if (free) {
    const upgrade = cloudCatalogHasPro(catalog) ? "get Plus" : "get a paid plan";
    return { grow: false, sentence: `Free computers have ${catalog.plans.free.diskGb} GB of disk at one time. Delete a computer, or ${upgrade}.` };
  }
  const extra = account.extraDisk;
  const extraPrice = catalog.extraDiskCentsPer10GbMonth;
  if (!extra || extraPrice == null) {
    // An older paid server: no extra disk to offer or price.
    return {
      grow: false,
      sentence: `A ${toGb} GB disk would pass the ${limitGb} GB your computers have at one time. Delete a computer you no longer use, then try again.`,
    };
  }
  if (extra.state === "on") {
    const limitCents = extra.monthlyLimitCents;
    if (limitCents == null) {
      // The server asks before any extra disk while no monthly limit is set.
      return {
        grow: false,
        settings: true,
        sentence: `A ${toGb} GB disk goes ${pastGb} GB past your plan's ${limitGb} GB at one time. Set a monthly limit for extra disk in Settings, or delete a computer.`,
      };
    }
    // The server's rule: the extra disk, kept for a full month, must cost no more than the limit.
    if ((pastGb * extraPrice) / 10 > limitCents) {
      return {
        grow: false,
        settings: true,
        sentence: `A ${toGb} GB disk would pass the ${formatCloudCents(limitCents)} a month you set for extra disk. Raise the limit in Settings, or delete a computer you no longer use.`,
      };
    }
    const monthCents = Math.ceil((pastGb / 10) * extraPrice);
    return {
      grow: true,
      toGb,
      sentence: `${growTo} That is ${pastGb} GB past your plan, about ${formatCloudCents(monthCents)} a month, inside your ${formatCloudCents(limitCents)} monthly limit. The computer restarts.`,
    };
  }
  if (extra.state === "asked") {
    return {
      grow: false,
      settings: true,
      sentence: `A ${toGb} GB disk goes ${pastGb} GB past your plan's ${limitGb} GB at one time. Turn on extra disk in Settings or delete a computer.`,
    };
  }
  // `off`: never decided; the server asks once, on the grow.
  return {
    grow: true,
    toGb,
    sentence: `${growTo} It goes ${pastGb} GB past your plan's ${limitGb} GB at one time. Extra disk costs ${formatCloudCents(extraPrice)} for each 10 GB a month. The computer restarts.`,
  };
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
  /** False: an unattended agent may not make, copy or move anything. A size change always needs the person. */
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

export type { CloudAccountState, CloudCatalog, CloudHoursState, CloudPaidPlanId, CloudPlanChangeTiming, CloudPlanFacts, CloudPlanId };
export type { CloudPlanCleanup, CloudPlanCleanupComputer, CloudPlanCleanupDone, CloudPlanCleanupPick, CloudTimedWakesCancelled };
export type { CloudDiskUsage, CloudDiskUsageItem, CloudDiskUsageKind, CloudDiskUsageReport, CloudLaneWork };

/**
 * What opening checkout did: a browser page opened, or the plan changed
 * without one. A downgrade made with a pick carries `freeing`, the computers
 * ADE frees now; one made without a pick over the cheaper plan's limits
 * carries `cleanup`, what goes over (show its `sentence`).
 */
export type CloudOpenCheckoutResult = { opened: boolean; change?: CloudPlanChangeTiming; cleanup?: CloudPlanCleanup; freeing?: string[] };

/** The server's sentence for what needs hours at 0. The server enforces it; these two only stop a request that can't work. */
export const CLOUD_OUT_OF_HOURS_MESSAGE = "You're out of ADE Cloud hours for this period.";

export const CLOUD_HOURS_UNKNOWN_MESSAGE =
  "ADE couldn't read your ADE Cloud hours, so it didn't start or change a computer. Try again in a minute.";

export function cloudOutOfHours(account: Pick<CloudAccountState, "hours"> | null | undefined): boolean {
  return account?.hours.state === "zero";
}

/*
 * Referrals, earned hours and the free plan per computer. A server from
 * before them leaves these out; each reader answers what that server meant.
 */

const finite = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Earned hours (used after the plan's hours, before extra hours; they never expire). Zeros from an older server. */
export function cloudEarnedHoursOf(account: Pick<CloudAccountState, "earnedHours"> | null | undefined): CloudEarnedHours {
  const earned = account?.earnedHours;
  return { leftMilli: finite(earned?.leftMilli), usedThisPeriodMilli: finite(earned?.usedThisPeriodMilli), grantedMilli: finite(earned?.grantedMilli) };
}

/**
 * The hours work can still use now: the plan's own left plus earned ones
 * (used after the plan's). The one rule the header ring, the dashboard's
 * forecast, the sizes and the composer read.
 */
export function cloudHoursLeftMilli(account: Pick<CloudAccountState, "hours" | "earnedHours">): number {
  return account.hours.leftMilli + Math.max(0, cloudEarnedHoursOf(account).leftMilli);
}

/** The name ADE gives a computer it made with no lane name (`cloudMachineCreator`). */
export const CLOUD_MACHINE_DEFAULT_NAME = "ADE Cloud computer";

/** At this share of the plan's disk, ADE warns and offers "Free up space". */
export const CLOUD_DISK_WARN_SHARE = 0.8;

/** Percent of a limit used, 0 to 100; 0 for no limit. */
export function percentOf(used: number, limit: number): number {
  if (!(limit > 0)) return 0;
  return Math.max(0, Math.min(100, (used / limit) * 100));
}

/** "3.4 GB", "820 MB". */
export function formatCloudGb(gb: number): string {
  if (gb > 0 && gb < 1) return `${Math.max(1, Math.round(gb * 1000))} MB`;
  return `${gb >= 100 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`;
}

/** Whether the account gets the free plan's hours. An older server gives every account the free plan: `unclaimed`. */
export function cloudFreePlanOf(account: Pick<CloudAccountState, "freePlan"> | null | undefined): CloudFreePlan {
  const state = account?.freePlan?.state;
  const github = cloudFreePlanGithubOf(account?.freePlan?.github);
  if (state !== "claimed" && state !== "refused" && state !== "unclaimed") return { state: "unclaimed", sentence: null, github };
  const sentence = account?.freePlan?.sentence;
  return { state, sentence: typeof sentence === "string" && sentence ? sentence : null, github };
}

const FREE_GITHUB_STATES = new Set<string>(["ok", "no_github", "too_new", "used", "checking"]);

/** The free plan's GitHub rules from any answer; an older server (or an unknown state) reads as `ok`. */
export function cloudFreePlanGithubOf(value: unknown): CloudFreePlanGithub {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const state = typeof raw?.state === "string" && FREE_GITHUB_STATES.has(raw.state) ? raw.state as CloudFreePlanGithubState : "ok";
  if (state === "ok") return { state, oldEnoughAt: null, canUnlockWithCard: false, githubLogin: null, sentence: null };
  return {
    state,
    oldEnoughAt: typeof raw?.oldEnoughAt === "number" && Number.isFinite(raw.oldEnoughAt) ? raw.oldEnoughAt : null,
    canUnlockWithCard: raw?.canUnlockWithCard === true,
    githubLogin: typeof raw?.githubLogin === "string" && raw.githubLogin ? raw.githubLogin : null,
    sentence: typeof raw?.sentence === "string" && raw.sentence ? raw.sentence : null,
  };
}

/** The account's referral summary, or null when the server sent none (an older server, or it couldn't build one). */
export function cloudReferralOf(account: Pick<CloudAccountState, "referral"> | null | undefined): CloudReferralSummary | null {
  return readCloudReferralSummary(account?.referral);
}

/** A referral summary from any answer (`/cloud/referrals`, the account, a redeem), or null when it isn't one. */
export function readCloudReferralSummary(value: unknown): CloudReferralSummary | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.code !== "string" || !raw.code || typeof raw.link !== "string") return null;
  const referredState = raw.referredState === "pending" || raw.referredState === "rewarded" || raw.referredState === "refused" ? raw.referredState : null;
  return {
    code: raw.code,
    link: raw.link,
    friendsJoined: finite(raw.friendsJoined),
    rewardsPaid: finite(raw.rewardsPaid),
    rewardsLeft: finite(raw.rewardsLeft),
    rewardLimit: finite(raw.rewardLimit),
    rewardMilli: finite(raw.rewardMilli),
    hoursEarnedMilli: finite(raw.hoursEarnedMilli),
    canEnterCode: raw.canEnterCode === true,
    enterCodeUntil: typeof raw.enterCodeUntil === "number" ? raw.enterCodeUntil : null,
    hasReferrer: raw.hasReferrer === true,
    referredState,
  };
}

/** The server's reason for refusing an invite, or null when it isn't one it gives. */
export function readCloudInviteRefusalReason(value: unknown): CloudInviteRefusalReason | null {
  return (CLOUD_INVITE_REFUSAL_REASONS as readonly unknown[]).includes(value) ? value as CloudInviteRefusalReason : null;
}

/** What a cheaper plan would free (the checkout's warning), or null when the answer isn't one. */
export function readCloudPlanCleanup(value: unknown): CloudPlanCleanup | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.sentence !== "string") return null;
  if (raw.planId !== "free" && raw.planId !== "plus" && raw.planId !== "pro") return null;
  const text = (entry: unknown): string | null => (typeof entry === "string" && entry ? entry : null);
  const computersOf = (list: unknown): CloudPlanCleanupComputer[] => (Array.isArray(list)
    ? list.flatMap((entry): CloudPlanCleanupComputer[] => {
      if (!entry || typeof entry !== "object") return [];
      const computer = entry as Record<string, unknown>;
      if (typeof computer.instanceId !== "string" || !computer.instanceId) return [];
      return [{
        instanceId: computer.instanceId,
        name: text(computer.name),
        laneName: text(computer.laneName),
        branch: text(computer.branch),
        diskGb: finite(computer.diskGb),
        ...(typeof computer.createdAt === "number" && Number.isFinite(computer.createdAt) ? { createdAt: computer.createdAt } : {}),
      }];
    })
    : []);
  const freeing = raw.freeing && typeof raw.freeing === "object" ? raw.freeing as Record<string, unknown> : null;
  return {
    planId: raw.planId,
    computers: computersOf(raw.computers),
    ...(Array.isArray(raw.choices) ? { choices: computersOf(raw.choices) } : {}),
    usedGb: finite(raw.usedGb),
    limitGb: finite(raw.limitGb),
    computerCount: finite(raw.computerCount),
    computerLimit: finite(raw.computerLimit),
    startsAt: typeof raw.startsAt === "number" && Number.isFinite(raw.startsAt) ? raw.startsAt : null,
    freeing: freeing && typeof freeing.push === "boolean" && Array.isArray(freeing.instanceIds) && typeof freeing.at === "number"
      ? { push: freeing.push, at: freeing.at, instanceIds: freeing.instanceIds.filter((id): id is string => typeof id === "string") }
      : null,
    sentence: raw.sentence,
  };
}

/** What entering an invite code did: taken (and whether it paid at once), or the server's one sentence and reason. */
export type CloudInviteRedeemOutcome =
  | { ok: true; rewarded: boolean; referral: CloudReferralSummary | null }
  | { ok: false; reason: CloudInviteRefusalReason | "unavailable"; message: string };

/**
 * Why no computer can wake on an account on the free plan (a cancelled plan
 * rolls to it) whose computers hold more disk than the plan has, or null. A
 * failed payment (`past_due`) is not this: its computers keep working. The
 * server refuses the wake (`over_plan_disk`) with the same sentence.
 */
export function cloudOverPlanDiskMessage(account: Pick<CloudAccountState, "plan" | "disk"> | null | undefined): string | null {
  if (!account || account.plan !== "free" || account.disk.limitGb == null || account.disk.usedGb <= account.disk.limitGb) return null;
  return overPlanDiskSentence(account.disk.usedGb, account.disk.limitGb);
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
  const overPlanDisk = cloudOverPlanDiskMessage(account);
  if (overPlanDisk) {
    return { id: "cloud-over-plan-disk", tone: "warning", title: "Your computers can't wake", detail: overPlanDisk };
  }
  if (account.hours.state === "zero") {
    return {
      id: "cloud-hours-zero",
      tone: "warning",
      title: "You're out of ADE Cloud hours",
      detail: account.extraHours.available
        ? `Your computers are stopped until ${resetDate}. Turn on extra hours to keep going sooner.`
        : cloudCatalogHasPro(catalog)
          ? `Your computers are stopped until ${resetDate}. Plus has ${formatCloudHours(catalog.plans.plus.includedMilli)} hours a month, and Pro ${formatCloudHours(catalog.plans.pro.includedMilli)}.`
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
  /** For `resize`: the new disk in GB (a multiple of the catalog's step, never smaller). Keeps the size when `shape` is unset. */
  disk?: number;
  /**
   * For a `resize` that grows the disk: the person confirmed the restart it
   * takes. The server refuses a grow on a running computer without it.
   */
  computerIdle?: boolean;
  /** For `delete`: the box's ADE machine, removed from the account once the box is gone. */
  machineKey?: string | null;
  /** For `delete`: who asked, for the server's delete log (an agent's chat; a person's desktop leaves it unset). */
  who?: string | null;
  /**
   * For `delete`: keep the lane the computer was made for, as a lane without
   * a computer on `branchRef` ("Keep the lane on a fresh computer"). The
   * caller pushed its work first.
   */
  keepLane?: { branchRef: string | null } | null;
};

export type CloudMachineActionResult = {
  ok: boolean;
  /** One plain line: what happened, or why it didn't. */
  message: string;
  /**
   * What stops the action, so the card can offer the way out:
   * plans and hours (0 hours, more disk than the free plan has, or more
   * computers or disk than the plan in force allows), or wait for a backup
   * window.
   */
  blocker: "rate_limited" | "out_of_hours" | "over_plan_disk" | "over_plan_limits" | null;
  /** For `delete`: the box is gone but its account row could not be removed. */
  accountRowLeft?: boolean;
  /**
   * For a refused disk grow or resize: the server's reason
   * (`CloudDiskRefusalReason`, or another string from a newer server).
   * `message` always says it plainly.
   */
  diskRefusal?: { reason: string };
};

/**
 * "Full computer · Large · 4 CPU · 8 GB · 4 GB disk". A lane size's name is
 * the catalog's for that kind and shape, the same name the size list and the
 * pickers use (a full 4 CPU / 8 GB computer is Large, not Medium), never the
 * bare shape's. A catalog size with no lane size has no name of its own (its
 * label only repeats the CPU and memory), so the line names none. Pass the
 * account's catalog (`cloudCatalogOf`); the fallback is for no account yet.
 */
export function describeCloudMachineSize(
  machine: Pick<CloudMachine, "type" | "resources" | "shapeId">,
  catalog: Pick<CloudCatalog, "sizes"> = CLOUD_CATALOG_FALLBACK,
): string {
  const kind = machine.type === "vm" ? "vm" : "default";
  const resources = machine.resources;
  const sized = resources
    ? catalog.sizes.find((entry) => entry.type === kind && entry.cpu === resources.cpu && entry.memoryGb === resources.memoryGb)
    : undefined;
  const name = sized
    ? (sized.tier ? sized.label : null)
    : machine.shapeId ? cloudShapeById(machine.shapeId).label : null;
  const size = resources ? `${resources.cpu} CPU · ${resources.memoryGb} GB` : null;
  // Only when the provider says it: a grown disk is the one size a resize can't undo.
  const diskGb = resources?.diskGb;
  const disk = typeof diskGb === "number" && Number.isFinite(diskGb) && diskGb > 0 ? `${diskGb} GB disk` : null;
  return [machine.type === "vm" ? "Full computer" : null, name, size, disk].filter(Boolean).join(" · ");
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
