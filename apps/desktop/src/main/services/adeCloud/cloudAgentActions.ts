/**
 * The `cloud` action domain's machine verbs, behind `ade cloud …`: status
 * (the whole account in one read), list, create, sleep, wake, resize, update,
 * copy, move, delete, hours, and "keep a cloud machine ready" on, off or retry.
 * `list`, `hours` and `limits` are narrow views of the reads `status` makes.
 *
 * What adds a computer (a new lane, a make, a copy) refuses before any card
 * when the account is out of hours, uses all its computers, or has a full
 * disk, with the same sentence `status` gives in `canStartLane`.
 *
 * Account-level like the rest of the integration: each acts on the account's
 * cloud machines, from whichever brain is asked, and takes
 * no pin. Making a machine (create, copy, move) signs the new machine in
 * through a desktop's approval window, so those go to the desktop attached to
 * this brain over the desktop bridge; a brain with none says so.
 *
 * Spending hours and deletes ask first. A person's own client (the desktop, the CTO)
 * already decided. An agent's call raises an approval card in its own chat,
 * which gives up after five minutes. A full-auto chat or an automation run has
 * nobody watching, so ADE answers for it, never stalling the agent: yes to
 * spending hours within the agent limits, no to deleting a machine that chat didn't
 * make. Plan mode says no to all of it. Every answer ADE gives itself leaves
 * a line in the chat. An outside app on ADE MCP with write access is answered
 * the same way (it has no chat, so the line goes to the log), and a resize, a
 * delete or a cancel from it always needs the person. A person is never
 * counted against the daily limit.
 */

import {
  CLOUD_HOURS_UNKNOWN_MESSAGE,
  CLOUD_MADE_BY_CHAT_METADATA,
  CLOUD_OUT_OF_HOURS_MESSAGE,
  CLOUD_SHAPES,
  cloudCatalogOf,
  cloudPlanFactsOf,
  cloudPlanLabelOf,
  cloudMachineKindOf,
  cloudShapeFor,
  cloudKindLabel,
  cloudOutOfHours,
  cloudShape,
  cloudShapeById,
  cloudShapeWithin,
  cloudUnattendedHoursBlock,
  cloudLimitsPresetOf,
  CLOUD_DEFAULT_AGENT_LIMITS,
  CLOUD_LIMITS_PRESETS,
  type CloudAccountState,
  type CloudAgentLimits,
  type CloudLimitsPreset,
  describeCloudHoursUse,
  describeCloudMachineSize,
  formatCloudHoursRate,
  isCloudMachineKind,
  type CloudCreateMachineArgs,
  type CloudCreateMachineResult,
  type CloudMachine,
  type CloudMachineActionResult,
  type CloudMachineKind,
  type CloudMachinesResult,
  type CloudShapeId,
} from "../../../shared/adeCloud";
import { type CloudReadyProjectSettings } from "../../../shared/cloudReady";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import type { PermissionLevel } from "../../../shared/permissionLadder";
import { getErrorMessage } from "../shared/utils";
import type { CloudLogger } from "./cloudProvider";
import type { CloudMoveResult } from "./cloudMachineCopy";
import type { CloudBrainMaker, CloudMakeInput } from "./cloudBrainMaker";
import type { CloudLaneLaunchBrainHost, CloudLaneLaunchStatus } from "./cloudLaneLaunchBrainHost";
import { cloudLaneLaunchStartProblem } from "./cloudLaneLaunchService";
import { CLOUD_TIER_IDS, cloudTier, cloudTiers, isCloudTierId, type CloudTier, type CloudTierId } from "../../../shared/cloudTiers";
import { cloudLaneStartBlock, type CloudLaneMachine } from "../../../shared/cloudLaneLaunch";
import type { ChatLaunchArgs } from "../../../shared/types";
import { NO_PROVIDER_SENTENCE } from "./cloudAccess";
import { countAgentMadeToday, type createCloudMachines } from "./cloudMachines";
import { normalizeCloudReadySettings, type CloudReadySettingsStore } from "./cloudReadySettings";
import type { CloudAgentLimitsStore } from "./cloudSleep";

/**
 * Who is asking, stamped by the RPC server from the caller's session; never
 * taken from the arguments. `viaAdeMcp`: an outside AI app on an ADE MCP
 * connection with write access. It has no chat and nobody watches it, so it
 * is an unattended agent: held to the agent limits, never a person.
 */
export type CloudApproval =
  | { by: "person" }
  | { by: "agent"; chatSessionId: string | null; viaAdeMcp?: boolean };

/** Where a person changes how many new computers agents may start a day (Settings, the ADE Cloud card). */
export const CLOUD_DAILY_LIMIT_SETTING = "Settings › Integrations › ADE Cloud › What agents may do › New computers a day";

/** What a desktop does for the brain over the bridge (cloudDesktopActions.ts). */
export type CloudDesktopBridge = {
  create(args: CloudCreateMachineArgs & { madeByChat?: string | null }): Promise<CloudCreateMachineResult>;
  copy(args: { instanceId: string; name?: string | null; shape?: CloudShapeId | null; madeByChat?: string | null }): Promise<CloudCreateMachineResult & { copiedFrom: string; forkMs: number }>;
  move(args: { instanceId: string; machineKey?: string | null; to: CloudMachineKind; shape?: CloudShapeId | null; madeByChat?: string | null }): Promise<CloudMoveResult>;
  readyRefresh(): Promise<unknown>;
};

export type CloudChatApprovals = {
  requestChatInput(args: {
    chatSessionId: string;
    title: string;
    body: string;
    timeoutMs?: number;
    allowsFreeform?: boolean;
    questions?: Array<{
      id?: string;
      header?: string;
      question: string;
      options?: Array<{ label: string; value?: string; description?: string; recommended?: boolean }>;
      allowsFreeform?: boolean;
    }>;
  }): Promise<{ decision: string; answers: Record<string, string[]>; timedOut?: boolean }>;
  /** The chat's permission level, or null when this brain doesn't know the chat. */
  permissionLevel(chatSessionId: string): PermissionLevel | null;
  isAutomationRun(chatSessionId: string): Promise<boolean>;
  notice(chatSessionId: string, message: string): void;
};

export type CloudAgentActionDeps = {
  machines: ReturnType<typeof createCloudMachines>;
  limits: CloudAgentLimitsStore;
  readySettings: CloudReadySettingsStore;
  /** The desktop attached to this brain, or null. */
  desktop: () => CloudDesktopBridge | null;
  /** Makes machines here when no desktop is attached; the person approves from a link. */
  maker?: CloudBrainMaker | null;
  /** ADE Cloud lane launches this brain owns (`lane_launch*`); null where it can't own them. */
  laneLaunch?: (() => CloudLaneLaunchBrainHost | null) | null;
  /**
   * The person's saved size for new lanes (`cloudDefaultTier` in the account
   * settings), as stored: undefined when nothing is saved, null when this
   * ADE can't read the account settings. Leave the dep out for "can't read".
   */
  savedDefaultTier?: (() => unknown) | null;
  approvals: CloudChatApprovals | null;
  logger?: CloudLogger;
};

/** Why `cloud.status` says a new lane can't start: an account fact, or something ADE couldn't read. */
export type CloudCanStartLaneCode =
  | "out_of_hours"
  | "computers_full"
  | "disk_full"
  | "signed_out"
  | "not_available"
  | "unreadable"
  | "unreachable"
  | "account_unknown";

/** `cloud.status`'s answer to "can a new ADE Cloud lane start right now?". */
export type CloudCanStartLane = { ok: boolean; reason: string | null; code: CloudCanStartLaneCode | null };

/** One computer of the account in `cloud.status`: the lane it holds, or `lane: null` for a computer made for no lane. */
export type CloudStatusComputer = {
  instanceId: string;
  name: string | null;
  machineKey: string | null;
  lane: { id: string; name: string; projectOrigin: string | null } | null;
  /** The ADE Cloud lane size it runs at, or null at a size the lane sizes don't cover (an older computer). */
  size: { id: CloudTierId; label: string } | null;
  /** "Large · full computer · 4 CPU · 8 GB" (the lane size), else what the computer is. */
  sizeLabel: string;
  /** Hours of the plan per hour awake, from the account's catalog. */
  hoursRate: number | null;
  state: CloudMachine["state"];
  /** ADE Cloud doesn't report when a computer was last used: always null for now. */
  lastUsedAt: string | null;
  /** Set for a computer unused for long: when ADE Cloud deletes it unless it is used. */
  deletesAt: string | null;
  disk: { sizeGb: number | null; full: string | null };
  /** Set when it is a project's ready machine (kept asleep for the next chat). */
  readyFor: string | null;
  /**
   * How it keeps current: the image it runs, its channel, the image the
   * channel is on, and `auto` (updates itself when idle), `updating` or
   * `failed` with why. Null from a server before updates.
   */
  update: { image: string | null; channel: "stable" | "beta"; target: string | null; state: "auto" | "updating" | "failed"; error: string | null } | null;
};

/** `cloud.status`: the whole account in one read, with no wake and no spend. */
export type CloudAccountStatus = {
  canStartLane: CloudCanStartLane;
  plan: {
    id: "free" | "paid";
    label: string;
    /** The plan whose rules are in force: a paid plan with a failed payment follows the free one. */
    rulesId: "free" | "paid";
    pastDue: boolean;
    includes: { hours: number; computers: number; diskGb: number; diskShared: boolean };
  } | null;
  hours: {
    left: number;
    included: number;
    used: number;
    percentUsed: number;
    state: CloudAccountState["hours"]["state"];
    resetsAt: string;
    extraHours: { available: boolean; enabled: boolean };
  } | null;
  disk: { usedGb: number; limitGb: number | null } | null;
  computers: { inUse: number; awake: number; max: number } | null;
  /** Every computer of the account, lanes first. */
  lanes: CloudStatusComputer[];
  /** The lane sizes ADE Cloud offers now, Small first; rates are the catalog's. */
  sizes: Array<{ id: CloudTierId; label: string; kind: "standard" | "full"; cpu: number; memoryGb: number; hoursRate: number; isDefault: boolean }>;
  /** The size a new lane starts with when none is named; null when this ADE can't read the person's saved choice. */
  defaultSize: CloudTierId | null;
  agents: {
    /** False: agents nobody watches (full-auto chats, automations, ADE MCP apps) may not start anything that uses hours. */
    unattendedSpend: boolean;
    newComputersPerDay: number;
    newComputersToday: number;
    newComputersLeftToday: number;
    /** The lane sizes agents nobody watches may pick on their own. */
    sizesAllowed: CloudTierId[];
    preset: CloudLimitsPreset | "custom";
    /** Where the person changes these. */
    setting: string;
  } | null;
  /** A plain sentence when part of the picture couldn't be read, else null. */
  message: string | null;
};

/** An approval card that gives up: nobody watching must never hold an agent. */
const APPROVAL_TIMEOUT_MS = 5 * 60_000;

/** The chat to credit a machine to: an agent's own chat, never a person's. */
function madeByChat(approval: CloudApproval): string | null {
  return approval.by === "agent" ? approval.chatSessionId : null;
}

export class CloudDeclined extends Error {
  readonly code = "cloud_declined";
  constructor(message: string) {
    super(message);
    this.name = "CloudDeclined";
  }
}

function record(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

function text(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readApproval(args: Record<string, unknown>): CloudApproval {
  const raw = record(args.approval);
  if (raw.by === "person") return { by: "person" };
  return {
    by: "agent",
    chatSessionId: typeof raw.chatSessionId === "string" && raw.chatSessionId.trim() ? raw.chatSessionId.trim() : null,
    ...(raw.viaAdeMcp === true ? { viaAdeMcp: true } : {}),
  };
}

const NO_DESKTOP = "This ADE can't make ADE Cloud machines: it isn't signed in to your ADE account.";

/**
 * New machines unattended agents started from this brain today, kept for the
 * process (the actions are rebuilt per call). The account list counts the ones
 * still there; this also counts ones since deleted, so a make-and-delete loop
 * can't step around the day's limit.
 */
let madeHere = { day: "", count: 0 };
const today = () => new Date().toISOString().slice(0, 10);
const madeHereToday = () => (madeHere.day === today() ? madeHere.count : 0);
const countMadeHere = () => {
  madeHere = { day: today(), count: madeHereToday() + 1 };
};
/**
 * Unattended makes approved and still running: they hold a slot until they
 * count or fail, so parallel makes can't all pass the day's limit before the
 * first one counts.
 */
let reservedHere = 0;

/** New computers unattended agents started today, as the daily limit counts them: the account list or this brain's own count, plus makes still running. */
const agentNewComputersToday = (listed: number): number => Math.max(listed, madeHereToday()) + reservedHere;

/** `cloud.status` when the computers listed but the plan and hours didn't. */
const CLOUD_ACCOUNT_UNKNOWN_MESSAGE =
  "ADE couldn't read your ADE Cloud plan and hours, so it can't say if a new lane can start. Try again in a minute.";

/** Where a person starts a lane on ADE Cloud when the caller has no chat to ask in. */
const CLOUD_LANE_PERSON_PLACE =
  "Start it in the ADE app (pick ADE Cloud under Run on in a new chat), or ask for it in an ADE chat, where ADE can ask you.";

/** The lane size a computer runs at, from its kind and shape, or null when no lane size matches. */
function cloudTierOfMachine(box: CloudMachine, tiers: readonly CloudTier[]): CloudTier | null {
  if (!box.resources || box.type === "performance") return null;
  const type = box.type === "vm" ? "vm" : "default";
  return tiers.find((tier) => tier.type === type && tier.cpu === box.resources!.cpu && tier.memoryGb === box.resources!.memoryGb) ?? null;
}

const milliToHours = (milli: number): number => Math.round(Math.max(0, milli)) / 1000;

export function buildCloudAgentActions(deps: CloudAgentActionDeps) {
  const logger = deps.logger ?? {};

  const readMachines = async (): Promise<CloudMachinesResult> => {
    const result = await deps.machines.list();
    if (result.state === "not_connected") throw new Error(result.message ?? "ADE Cloud isn't available on this account yet.");
    if (result.state !== "ok") throw new Error(result.message ?? "ADE couldn't read your ADE Cloud machines.");
    return result;
  };

  /** A box by its the provider id, ADE machine key, or name. */
  const resolveMachine = async (selector: string | null): Promise<{ box: CloudMachine; all: CloudMachinesResult }> => {
    if (!selector) throw new Error("Name the machine: its name or ADE Cloud id (ade cloud list).");
    const all = await readMachines();
    const wanted = selector.toLowerCase();
    const matches = all.machines.filter((box) =>
      box.instanceId === selector || box.machineKey === selector || (box.name ?? "").toLowerCase() === wanted);
    if (!matches.length) throw new Error(`No ADE Cloud machine is called "${selector}". ade cloud list shows them.`);
    if (matches.length > 1) {
      throw new Error(`"${selector}" names ${matches.length} machines: ${matches.map((box) => box.instanceId).join(", ")}. Pass the id.`);
    }
    return { box: matches[0]!, all };
  };

  /** Plan and hours; null when they can't be read. */
  const readAccount = (): Promise<CloudAccountState | null> => deps.machines.account().catch((error: unknown) => {
    logger.warn?.("cloud.account_read_failed", { error: getErrorMessage(error) });
    return null;
  });

  /** Refuses before a card goes up for something the server would only refuse. */
  const hoursCheck = async (): Promise<CloudAccountState | null> => {
    const account = await readAccount();
    if (cloudOutOfHours(account)) throw new Error(CLOUD_OUT_OF_HOURS_MESSAGE);
    return account;
  };

  /**
   * For what adds a computer (a new lane, a make, a copy): refuses before any
   * card and any spend when the account is out of hours, uses all its
   * computers or has a full disk, with the sentence `cloud.status` and the
   * composer show. An account it couldn't read goes on: the server decides,
   * and an unattended agent is still refused for unknown hours in `approve()`.
   */
  const newComputerCheck = async (): Promise<CloudAccountState | null> => {
    const account = await readAccount();
    const block = cloudLaneStartBlock(account, { newLane: true });
    if (block) throw new Error(block.message);
    return account;
  };

  /**
   * The person's saved default lane size. Small when nothing is saved (the
   * app's default); null when it can't be read, or names a size this ADE
   * doesn't know (a newer ADE's).
   */
  const readDefaultTier = (): CloudTierId | null => {
    if (!deps.savedDefaultTier) return null;
    try {
      const saved = deps.savedDefaultTier();
      if (saved === undefined) return "small";
      return isCloudTierId(saved) ? saved : null;
    } catch (error) {
      logger.warn?.("cloud.default_tier_read_failed", { error: getErrorMessage(error) });
      return null;
    }
  };

  /** `canStartLane` from one list read: the access answer first, then the account's facts. */
  const canStartLaneOf = (result: CloudMachinesResult): CloudCanStartLane => {
    const no = (code: CloudCanStartLaneCode, reason: string): CloudCanStartLane => ({ ok: false, reason, code });
    if (result.state === "not_connected") {
      const reason = result.message ?? NO_PROVIDER_SENTENCE.no_access;
      if (reason === NO_PROVIDER_SENTENCE.signed_out) return no("signed_out", reason);
      if (reason === NO_PROVIDER_SENTENCE.unreadable) return no("unreadable", reason);
      return no("not_available", reason);
    }
    if (result.state === "access_refused") return no("not_available", result.message ?? NO_PROVIDER_SENTENCE.no_access);
    if (result.state === "unreachable") return no("unreachable", result.message ?? "ADE couldn't reach ADE Cloud. Try again in a minute.");
    if (!result.account) return no("account_unknown", CLOUD_ACCOUNT_UNKNOWN_MESSAGE);
    const block = cloudLaneStartBlock(result.account, { newLane: true });
    return block ? no(block.code, block.message) : { ok: true, reason: null, code: null };
  };

  /**
   * Asks before spending or deleting. Resolves when it may go ahead, with what
   * to call once a new machine really exists (it counts toward an unattended
   * agent's daily limit then, so a make that failed costs no slot) and whether
   * the yes came from what the person lets unattended agents do (a full-auto
   * chat or an automation, within the agent limits); throws
   * `CloudDeclined` (with why) when not.
   */
  const approve = async (
    approval: CloudApproval,
    card: {
      /**
       * `person_only`: what unattended agents may not decide alone (keeping a
       * machine awake for good, loosening what they may do); only a person
       * answers it.
       */
      action: "spend" | "delete" | "person_only";
      title: string;
      body: string;
      confirm: string;
      madeByThisChat?: boolean;
      /** Starts a new machine (make, copy, move): counts against the day's limit. */
      newMachine?: boolean;
      /** The size it picks (make, copy, move, resize): within the largest allowed. */
      shape?: CloudShapeId | null;
      /** Changes a computer's size (resize): an app on ADE MCP never decides it alone. */
      tierChange?: boolean;
      /** Where the person can do it instead, when the caller has no chat to ask in. */
      personPlace?: string;
    },
  ): Promise<{ counted: () => void; release: () => void; unattended: boolean }> => {
    const nothing = { counted: () => undefined, release: () => undefined, unattended: false };
    const noChatToAsk = () => new CloudDeclined(`${card.title} uses hours or deletes something, so it needs your yes, and ADE has no chat to ask you in. ${card.personPlace ?? "Run it from an ADE chat, or use the machine's card in ADE (Your computers)."}`);
    if (approval.by === "person") return nothing;
    const chatSessionId = approval.chatSessionId;
    // An app on ADE MCP has no chat to ask in: it is answered like a chat
    // nobody watches, within the agent limits, never as the person.
    const viaAdeMcp = approval.viaAdeMcp === true;
    if (!viaAdeMcp && (!chatSessionId || !deps.approvals)) {
      throw noChatToAsk();
    }
    const approvals = deps.approvals;
    const notice = (message: string) => {
      if (chatSessionId && approvals) approvals.notice(chatSessionId, message);
      else logger.info?.("cloud.unattended_answer", { message });
    };
    const level = !viaAdeMcp && chatSessionId && approvals ? approvals.permissionLevel(chatSessionId) : null;
    const automation = !viaAdeMcp && chatSessionId && approvals
      ? await approvals.isAutomationRun(chatSessionId).catch(() => false)
      : false;
    if (level === "plan") {
      notice(`ADE said no to "${card.title}" for this chat: plan mode changes nothing.`);
      throw new CloudDeclined(`${card.title}: declined, because this chat is in plan mode.`);
    }
    if (viaAdeMcp || automation || level === "full-auto") {
      const where = viaAdeMcp ? "this app connected through ADE MCP" : automation ? "this automation run" : "this full-auto chat";
      if (card.action === "person_only" || (viaAdeMcp && card.tierChange)) {
        notice(`ADE said no to "${card.title}" in ${where}: only you can decide it.`);
        throw new CloudDeclined(`${card.title}: declined. Only the person can decide it (Settings › Integrations › ADE Cloud).`);
      }
      if (card.action === "delete" && viaAdeMcp) {
        notice(`ADE said no to "${card.title}" in ${where}: only you can delete a computer.`);
        throw new CloudDeclined(`${card.title}: declined. A delete through ADE MCP always needs the person; ask them to delete it from its card in ADE.`);
      }
      if (card.action === "delete" && !card.madeByThisChat) {
        notice(`ADE said no to "${card.title}" in ${where}: nobody is here to approve deleting a machine this chat didn't make.`);
        throw new CloudDeclined(`${card.title}: declined. Nobody is watching ${where} to approve deleting a machine it didn't make; ask the person to delete it from its card.`);
      }
      // What the person chose agents may do alone (Settings › Integrations › ADE Cloud).
      const costs = card.action === "spend" || card.newMachine === true;
      const limits = costs ? await deps.limits.read().catch(() => CLOUD_DEFAULT_AGENT_LIMITS) : null;
      const refuse = (why: string, change = "The person can change what agents may do in Settings › Integrations › ADE Cloud."): never => {
        notice(`ADE said no to "${card.title}" in ${where}: ${why}`);
        throw new CloudDeclined(`${card.title}: declined. ${why} ${change}`);
      };
      if (limits && !limits.unattendedSpend) refuse("your settings say unattended agents ask before anything that uses hours.");
      if (limits && card.shape && !cloudShapeWithin(card.shape, limits.maxShape)) {
        const max = cloudShapeById(limits.maxShape);
        refuse(`agents may pick up to ${max.label} on their own.`);
      }
      // hoursCheck lets hours it couldn't read through, for a person to decide; nobody decides here.
      const blocked = costs ? cloudUnattendedHoursBlock(await readAccount()) : null;
      if (blocked) {
        const why = blocked === "out_of_hours" ? CLOUD_OUT_OF_HOURS_MESSAGE : CLOUD_HOURS_UNKNOWN_MESSAGE;
        notice(`ADE said no to "${card.title}" in ${where}: ${why}`);
        throw new CloudDeclined(`${card.title}: declined. ${why}`);
      }
      if (limits && card.newMachine) {
        const listed = await deps.machines.agentMadeToday().catch(() => 0);
        // Makes still running are in neither count: they go on top of the larger one.
        const made = agentNewComputersToday(listed);
        if (made >= limits.machinesPerDay) {
          const perDay = limits.machinesPerDay;
          refuse(
            `your agents hit today's limit of ${perDay} new computer${perDay === 1 ? "" : "s"} a day.`,
            `Change it in ${CLOUD_DAILY_LIMIT_SETTING}.`,
          );
        }
      }
      notice(`ADE approved "${card.title}" for ${where}, within what you let agents do.`);
      if (!card.newMachine) return { counted: () => undefined, release: () => undefined, unattended: true };
      reservedHere += 1;
      let held = true;
      const release = () => {
        if (!held) return;
        held = false;
        reservedHere -= 1;
      };
      return { counted: () => { release(); countMadeHere(); }, release, unattended: true };
    }
    if (!chatSessionId || !approvals) {
      throw noChatToAsk();
    }
    let response: Awaited<ReturnType<CloudChatApprovals["requestChatInput"]>>;
    try {
      response = await approvals.requestChatInput({
      chatSessionId,
      title: card.title,
      body: card.body,
      timeoutMs: APPROVAL_TIMEOUT_MS,
      allowsFreeform: false,
      questions: [{
        id: "decision",
        header: "ADE Cloud",
        question: `${card.title}? ${card.body}`,
        allowsFreeform: false,
        options: [
          { label: card.confirm, value: "yes" },
          { label: "No", value: "no" },
        ],
      }],
      });
    } catch (error) {
      // The chat lives on another ADE on this computer, or is gone: there is no card to show.
      throw new CloudDeclined(`${card.title}: ADE couldn't ask in this chat (${getErrorMessage(error)}), so nothing was done.`);
    }
    const answer = response.answers.decision?.[0] ?? "";
    if (response.decision === "accept" && answer === "yes") return nothing;
    throw new CloudDeclined(response.timedOut
      ? `${card.title}: nobody answered in 5 minutes, so nothing was done.`
      : `${card.title}: the person said no, so nothing was done.`);
  };

  /** True when nothing here can make a machine. */
  const cannotMake = () => !deps.desktop() && !deps.maker;

  /**
   * Makes, copies or moves: through the attached desktop (its window approves
   * the sign-in, no tap needed), else here, with the approval link sent to the
   * agent's chat. `background` (the phone) returns a job to read with
   * `make_status`, which carries the link.
   */
  const make = async (approval: CloudApproval, input: CloudMakeInput, background: boolean): Promise<unknown> => {
    const desktop = deps.desktop();
    if (desktop && !background) {
      if (input.kind === "create") return await desktop.create({ ...input.machine, madeByChat: input.madeByChat ?? null });
      if (input.kind === "copy") return await desktop.copy(input);
      return await desktop.move(input);
    }
    const maker = deps.maker;
    if (!maker) throw new Error(NO_DESKTOP);
    if (background) return { requestId: maker.start(input), background: true };
    const chatSessionId = approval.by === "agent" ? approval.chatSessionId : null;
    if (!chatSessionId || !deps.approvals) {
      throw new Error("The new machine joins your account once you approve it, and ADE has no chat here to show you the link. Run this from an ADE chat, or from the phone's ADE Cloud page.");
    }
    const approvals = deps.approvals;
    return await maker.make(input, (url, name) => {
      approvals.notice(chatSessionId, `Approve "${name}" joining your ADE account: open ${url} on your phone or in a browser signed in to ADE. The command waits up to 10 minutes.`);
    });
  };

  const runAction = async (box: CloudMachine, action: Parameters<typeof deps.machines.run>[0]): Promise<CloudMachineActionResult> => {
    const result = await deps.machines.run(action);
    if (!result.ok) throw new Error(result.message);
    return result;
  };

  const summary = (box: CloudMachine) => ({
    instanceId: box.instanceId,
    name: box.name,
    machineKey: box.machineKey,
    state: box.state,
    type: box.type,
    size: describeCloudMachineSize(box),
    shape: box.shapeId,
    hoursRate: box.hoursRate,
    sleep: box.sleep,
    ready: box.ready,
    pastDue: box.pastDue,
  });

  const shapeArg = (args: Record<string, unknown>): CloudShapeId | null => {
    const raw = text(args, "shape");
    if (!raw) return null;
    const named = CLOUD_SHAPES.find((candidate) => candidate.label.toLowerCase() === raw.toLowerCase().replace(/\s+/g, "-"));
    const shape = named ?? cloudShape(raw.replace(/\s+/g, "").replace("/", "x"));
    if (!shape) throw new Error(`Pick a size: ${CLOUD_SHAPES.map((candidate) => `${candidate.label.toLowerCase()} (${candidate.id})`).join(", ")}.`);
    return shape.id;
  };

  return {
    async list() {
      const all = await readMachines();
      return {
        machines: all.machines.map(summary),
        runningCount: all.runningCount,
        account: all.account,
      };
    },

    /**
     * The whole account in one read, for a person or an agent: plan, hours,
     * disk, computers, each lane on ADE Cloud, the sizes, the default size,
     * what agents may do, and whether a new lane can start now (and why not).
     * One list of the computers and one account read; it wakes nothing and
     * spends nothing. Never throws for "no ADE Cloud": `canStartLane` says why.
     */
    async status(): Promise<CloudAccountStatus> {
      const result = await deps.machines.list();
      const canStartLane = canStartLaneOf(result);
      const account = result.state === "ok" ? result.account : null;
      const catalog = cloudCatalogOf(account);
      const tiers = cloudTiers(catalog);
      const defaultSize = readDefaultTier();
      const limits = result.state === "ok" ? await deps.limits.read().catch(() => null) : null;
      // The list just read every computer: count agents' makes from it, with no second call.
      const listedToday = result.state === "ok"
        ? countAgentMadeToday(deps.machines.recentInstances(60_000) ?? [], Date.now())
        : 0;
      const newComputersToday = agentNewComputersToday(listedToday);
      const deletesAt = new Map((account?.dueForDeletion ?? []).map((entry) => [entry.instanceId, new Date(entry.deletesAt).toISOString()]));
      const lanes: CloudStatusComputer[] = (result.machines as CloudLaneMachine[]).map((box) => {
        const tier = cloudTierOfMachine(box, tiers);
        return {
          instanceId: box.instanceId,
          name: box.name,
          machineKey: box.machineKey,
          lane: box.lane ? { id: box.lane.laneId, name: box.lane.laneName, projectOrigin: box.lane.projectOrigin } : null,
          size: tier ? { id: tier.id, label: tier.label } : null,
          // The lane size's own name: the older shape names call a full 4 CPU / 8 GB "Medium".
          sizeLabel: tier
            ? `${tier.label} · ${tier.type === "vm" ? "full computer" : "standard"} · ${tier.cpu} CPU · ${tier.memoryGb} GB`
            : describeCloudMachineSize(box),
          hoursRate: tier ? tier.multiplierMilli / 1000 : box.hoursRate,
          state: box.state,
          lastUsedAt: null,
          deletesAt: deletesAt.get(box.instanceId) ?? null,
          disk: { sizeGb: box.resources?.diskGb ?? null, full: box.diskFull },
          readyFor: box.ready?.projectName ?? null,
          update: box.update
            ? { image: box.update.image, channel: box.update.channel, target: box.update.target, state: box.update.state, error: box.update.error }
            : null,
        };
      }).sort((left, right) => Number(right.lane != null) - Number(left.lane != null));
      // A paid plan with a failed payment follows the free plan's rules until paid.
      const plan = account ? (account.rules === "free" ? catalog.plans.free : cloudPlanFactsOf(account, catalog)) : null;
      // A partial answer (an older server) leaves that part null, never a throw.
      const part = (account ?? {}) as Partial<CloudAccountState>;
      return {
        canStartLane,
        plan: account && plan
          ? {
              id: account.plan,
              label: cloudPlanLabelOf(account, catalog),
              rulesId: account.rules,
              pastDue: part.billing?.notice === "past_due",
              includes: { hours: milliToHours(plan.includedMilli), computers: plan.computerLimit, diskGb: plan.diskGb, diskShared: account.rules === "paid" },
            }
          : null,
        hours: account && part.hours && part.billing
          ? {
              left: milliToHours(account.hours.leftMilli),
              included: milliToHours(account.hours.includedMilli),
              used: milliToHours(account.hours.usedMilli),
              percentUsed: account.hours.percentUsed,
              state: account.hours.state,
              resetsAt: new Date(account.billing.periodEnd).toISOString(),
              extraHours: { available: part.extraHours?.available === true, enabled: part.extraHours?.enabled === true },
            }
          : null,
        disk: part.disk ? { usedGb: part.disk.usedGb, limitGb: part.disk.limitGb } : null,
        computers: part.computers ? { inUse: part.computers.total, awake: part.computers.awake, max: part.computers.limit } : null,
        lanes,
        sizes: tiers.map((tier) => ({
          id: tier.id,
          label: tier.label,
          kind: tier.type === "vm" ? "full" as const : "standard" as const,
          cpu: tier.cpu,
          memoryGb: tier.memoryGb,
          hoursRate: tier.multiplierMilli / 1000,
          isDefault: tier.id === defaultSize,
        })),
        defaultSize,
        agents: limits
          ? {
              unattendedSpend: limits.unattendedSpend,
              newComputersPerDay: limits.machinesPerDay,
              newComputersToday,
              newComputersLeftToday: limits.unattendedSpend ? Math.max(0, limits.machinesPerDay - newComputersToday) : 0,
              // The same test `approve()` makes: the tier's shape within the largest allowed.
              sizesAllowed: tiers.filter((tier) => {
                const shape = cloudShapeFor({ cpu: tier.cpu, memoryGb: tier.memoryGb });
                return shape != null && cloudShapeWithin(shape.id, limits.maxShape);
              }).map((tier) => tier.id),
              preset: cloudLimitsPresetOf(limits) ?? "custom",
              setting: CLOUD_DAILY_LIMIT_SETTING,
            }
          : null,
        message: result.state !== "ok" ? canStartLane.reason : !account ? CLOUD_ACCOUNT_UNKNOWN_MESSAGE : null,
      };
    },

    async create(rawArgs?: unknown) {
      const args = record(rawArgs);
      const kind = (text(args, "kind") ?? "box") as CloudMachineKind;
      if (!isCloudMachineKind(kind)) throw new Error("Make a standard or a full computer (--kind box|vm).");
      const shapeId = shapeArg(args) ?? "2x4";
      const shape = cloudShapeById(shapeId);
      const name = text(args, "name") ?? "ADE Cloud computer";
      const account = await newComputerCheck();
      if (cannotMake()) throw new Error(NO_DESKTOP);
      const approval = readApproval(args);
      const yes = await approve(approval, {
        action: "spend",
        title: `Make "${name}" on ADE Cloud`,
        body: `A ${shape.label}${kind === "vm" ? " full computer" : " computer"} (${shape.cpu} CPU, ${shape.memoryGb} GB). It uses ${describeCloudHoursUse(kind, shape.id, cloudCatalogOf(account))}, and none while it sleeps.`,
        confirm: "Make it",
        newMachine: true,
        shape: shapeId,
      });
      try {
        const made = await make(approval, { kind: "create", machine: { kind, shape: shapeId, name }, madeByChat: madeByChat(approval), selfApprove: yes.unattended }, args.background === true);
        yes.counted();
        return made;
      } finally {
        yes.release();
      }
    },

    async sleep(rawArgs?: unknown) {
      const { box } = await resolveMachine(text(record(rawArgs), "machine"));
      return await runAction(box, { instanceId: box.instanceId, action: "sleep" });
    },

    /** A wake uses hours like opening one of its lanes; the server refuses it at 0 hours. */
    async wake(rawArgs?: unknown) {
      const { box } = await resolveMachine(text(record(rawArgs), "machine"));
      return await runAction(box, { instanceId: box.instanceId, action: "wake" });
    },

    async resize(rawArgs?: unknown) {
      const args = record(rawArgs);
      const { box } = await resolveMachine(text(args, "machine"));
      const shapeId = shapeArg(args);
      if (!shapeId) throw new Error("Pass the new size (--shape 4x8).");
      const shape = cloudShapeById(shapeId);
      const account = await hoursCheck();
      await approve(readApproval(args), {
        action: "spend",
        title: `Resize "${box.name ?? box.instanceId}" to ${shape.label}`,
        body: `It restarts to change size: files stay, running chats, terminals and processes stop. It then uses ${describeCloudHoursUse(cloudMachineKindOf(box.type), shape.id, cloudCatalogOf(account))}.`,
        confirm: "Resize",
        shape: shapeId,
        tierChange: true,
      });
      return await runAction(box, { instanceId: box.instanceId, action: "resize", shape: shapeId });
    },

    async copy(rawArgs?: unknown) {
      const args = record(rawArgs);
      const { box } = await resolveMachine(text(args, "machine"));
      const name = text(args, "name") ?? `${box.name ?? box.instanceId} copy`;
      const shapeId = shapeArg(args);
      await newComputerCheck();
      if (cannotMake()) throw new Error(NO_DESKTOP);
      const rate = box.hoursRate != null ? formatCloudHoursRate(box.hoursRate) : null;
      const approval = readApproval(args);
      const yes = await approve(approval, {
        action: "spend",
        title: `Copy "${box.name ?? box.instanceId}" into a new machine`,
        body: `"${name}" gets the same files (repos, lanes, installed dependencies) and signs in as a new computer${rate ? `, and uses ${rate}` : ""}. A big disk takes a few minutes to copy.`,
        confirm: "Copy it",
        newMachine: true,
        shape: shapeId ?? box.shapeId,
      });
      try {
        const made = await make(approval, { kind: "copy", instanceId: box.instanceId, name, shape: shapeId, madeByChat: madeByChat(approval), selfApprove: yes.unattended }, args.background === true);
        yes.counted();
        return made;
      } finally {
        yes.release();
      }
    },

    async move(rawArgs?: unknown) {
      const args = record(rawArgs);
      const { box } = await resolveMachine(text(args, "machine"));
      const to = text(args, "to") as CloudMachineKind | null;
      if (!to || !isCloudMachineKind(to)) throw new Error("Move it to a standard or a full computer (--to box|vm).");
      // A move deletes the machine it runs from: the chat asking for it, and
      // this brain, would stop halfway, with the new machine awake and using hours.
      if (box.instanceId === process.env.ADE_CLOUD_INSTANCE_ID?.trim()) {
        throw new Error(`"${box.name ?? box.instanceId}" is the machine this runs on, so it can't move itself. Make the new machine (ade cloud create --kind ${to}), then hand this chat to it: ade chat handoff "$ADE_CHAT_SESSION_ID" --machine <new machine> --fork --include-changes --clone --when-turn-ends --note "<the task>". This machine stays and sleeps when idle; offer to delete it from the new chat.`);
      }
      const shapeId = shapeArg(args);
      await hoursCheck();
      if (cannotMake()) throw new Error(NO_DESKTOP);
      const name = box.name ?? box.instanceId;
      const approval = readApproval(args);
      const yes = await approve(approval, {
        action: "delete",
        title: `Move "${name}" to a ${cloudKindLabel(to)}`,
        body: `ADE makes a new ${cloudKindLabel(to)}, copies every repo, lane and chat on "${name}" into it, then deletes "${name}". Running processes stop${box.type === "vm" ? ", and Docker images and volumes stay behind" : ""}.`,
        confirm: "Move it",
        newMachine: true,
        shape: shapeId ?? box.shapeId,
        madeByThisChat: approval.by === "agent" && approval.chatSessionId != null
          && (await deps.machines.instanceMetadata(box.instanceId).catch(() => null))?.[CLOUD_MADE_BY_CHAT_METADATA] === approval.chatSessionId,
      });
      try {
        const made = await make(approval, { kind: "move", instanceId: box.instanceId, machineKey: box.machineKey, to, shape: shapeId, madeByChat: madeByChat(approval), selfApprove: yes.unattended }, args.background === true);
        yes.counted();
        return made;
      } finally {
        yes.release();
      }
    },

    /** A make started with `background`: its stage, the approval link while it waits, then its result. */
    async make_status(rawArgs?: unknown) {
      const requestId = text(record(rawArgs), "requestId");
      if (!requestId) throw new Error("Pass the requestId the make returned.");
      const job = deps.maker?.status(requestId) ?? null;
      if (!job) throw new Error("ADE has no make with that id here (it finished over 30 minutes ago, or ran on another machine).");
      return job;
    },

    /**
     * `ade chat create --machine cloud` (kind `chat`) and `ade lanes create
     * --machine cloud` (kind `lane`, no chat): one new computer for one new
     * lane, the repository there, and the chat started there, if any. With no
     * `cloud.sizeId`, the person's saved size for new lanes. Returns at once with
     * the launch's status; read it again with `lane_launch_status`. The same
     * launch id again answers that launch (a failed one goes on from its
     * failed step): never a second computer.
     */
    async lane_launch(rawArgs?: unknown) {
      const args = record(rawArgs);
      const asked = record(args.launch) as unknown as ChatLaunchArgs;
      // A CLI session needs a window to start its terminal in, which a brain
      // doesn't have: it starts from the ADE app.
      if (asked.kind === "cli") {
        throw new Error("A CLI session on ADE Cloud starts from the ADE app. Here, start a chat (ade chat create --machine cloud) or the lane alone (ade lanes create --machine cloud).");
      }
      // No size asked for: the size the person saved for new lanes, then Small.
      const askedSize = record(asked.cloud).sizeId;
      const sizeId = askedSize == null || askedSize === "" ? readDefaultTier() ?? "small" : askedSize;
      if (!isCloudTierId(sizeId)) throw new Error(`Pick a size: ${CLOUD_TIER_IDS.join(", ")}.`);
      const launch: ChatLaunchArgs = { ...asked, cloud: { sizeId } };
      const laneOnly = launch.kind === "lane";
      const host = deps.laneLaunch?.() ?? null;
      if (!host) throw new Error("This ADE can't start a lane on ADE Cloud. Use the ADE app, or the ade command where ADE runs in the background.");
      const approval = readApproval(args);
      const chatSessionId = approval.by === "agent" ? approval.chatSessionId : null;
      const launchId = typeof launch.launchId === "string" ? launch.launchId.trim().toLowerCase() : "";
      const existing = launchId ? await host.status(launchId) : null;
      const startArgs = {
        args: launch,
        originUrl: text(args, "originUrl"),
        madeByChat: madeByChat(approval),
        caller: { chatSessionId, permissionLevel: chatSessionId ? deps.approvals?.permissionLevel(chatSessionId) ?? null : null },
        notice: chatSessionId && deps.approvals ? ((message: string) => deps.approvals!.notice(chatSessionId, message)) : null,
      };
      if (existing) {
        // Already approved and counted when it started.
        if (approval.by === "agent" && existing.madeByChat !== chatSessionId) {
          throw new CloudDeclined("This ADE Cloud lane was started from another chat, so only that chat or you can follow it here.");
        }
        return (await host.start({ ...startArgs, selfApprove: false })).status;
      }
      // Refused before the question, never after a yes: the launch itself,
      // then the account (hours, computers, disk), with the sentences
      // `cloud.status` and the composer show.
      const problem = cloudLaneLaunchStartProblem({ args: launch, originUrl: startArgs.originUrl });
      if (problem) throw new Error(problem);
      const account = await newComputerCheck();
      const tier = cloudTier(cloudCatalogOf(account), sizeId);
      if (!tier) throw new Error("ADE Cloud doesn't offer that size right now. Pick another one.");
      const kind: CloudMachineKind = tier.type === "vm" ? "vm" : "box";
      const shape = cloudShapeFor({ cpu: tier.cpu, memoryGb: tier.memoryGb });
      const yes = await approve(approval, {
        action: "spend",
        title: "Start a lane on ADE Cloud",
        body: `ADE makes a new ${tier.label} computer (${tier.cpu} CPU, ${tier.memoryGb} GB) for this lane alone, gets the repository there and ${laneOnly ? "sets up the lane" : "starts the chat on it"}.${shape ? ` It uses ${describeCloudHoursUse(kind, shape.id, cloudCatalogOf(account))}, and none while it sleeps.` : ""}`,
        confirm: "Start it",
        newMachine: true,
        shape: shape?.id ?? null,
        personPlace: CLOUD_LANE_PERSON_PLACE,
      });
      try {
        const started = await host.start({ ...startArgs, selfApprove: yes.unattended });
        if (started.created) yes.counted();
        return started.status;
      } finally {
        yes.release();
      }
    },

    async lane_launch_status(rawArgs?: unknown): Promise<CloudLaneLaunchStatus | null> {
      const launchId = text(record(rawArgs), "launchId");
      if (!launchId) throw new Error("Pass the launch id.");
      return (await deps.laneLaunch?.()?.status(launchId.toLowerCase())) ?? null;
    },

    /** Stops a launch before its chat starts and deletes the computer made for it. */
    async lane_launch_cancel(rawArgs?: unknown): Promise<CloudLaneLaunchStatus | null> {
      const args = record(rawArgs);
      const launchId = text(args, "launchId")?.toLowerCase();
      if (!launchId) throw new Error("Pass the launch id.");
      const host = deps.laneLaunch?.() ?? null;
      const existing = host ? await host.status(launchId) : null;
      if (!host || !existing) return null;
      const approval = readApproval(args);
      if (approval.by === "agent" && approval.viaAdeMcp) {
        throw new CloudDeclined("Cancelling deletes the computer made for this lane, so only the person can do it, in ADE.");
      }
      if (approval.by === "agent" && (!approval.chatSessionId || existing.madeByChat !== approval.chatSessionId)) {
        throw new CloudDeclined("This ADE Cloud lane was started from another chat, so only that chat or you can cancel it.");
      }
      return await host.cancel(launchId);
    },

    async delete(rawArgs?: unknown) {
      const args = record(rawArgs);
      const { box } = await resolveMachine(text(args, "machine"));
      const approval = readApproval(args);
      const instance = approval.by === "agent" && approval.chatSessionId
        ? await deps.machines.instanceMetadata(box.instanceId).catch(() => null)
        : null;
      await approve(approval, {
        action: "delete",
        title: `Delete "${box.name ?? box.instanceId}"`,
        body: `ADE deletes it on ADE Cloud and removes it from your computers. Everything on its disk is gone for good: repos, lanes, and any work not pushed.`,
        confirm: "Delete it",
        madeByThisChat: approval.by === "agent" && approval.chatSessionId != null
          && instance?.[CLOUD_MADE_BY_CHAT_METADATA] === approval.chatSessionId,
      });
      return await runAction(box, {
        instanceId: box.instanceId,
        action: "delete",
        machineKey: box.machineKey,
        who: approval.by === "agent" && approval.chatSessionId ? `chat ${approval.chatSessionId}` : null,
      });
    },

    /** Moves the computer to ADE's current image: it restarts, running work stops. */
    async update(rawArgs?: unknown) {
      const args = record(rawArgs);
      const { box } = await resolveMachine(text(args, "machine"));
      await hoursCheck();
      await approve(readApproval(args), {
        action: "spend",
        title: `Update "${box.name ?? box.instanceId}"`,
        body: "It restarts on the current ADE. Files and repos stay; running chats, terminals and processes stop.",
        confirm: "Update it",
      });
      return await runAction(box, { instanceId: box.instanceId, action: "update" });
    },

    /** Plan, hours left, and what happens at 0. */
    async hours() {
      const account = await deps.machines.account();
      if (!account) throw new Error("ADE Cloud isn't available on this account yet.");
      return account;
    },

    /** What agents may do alone: a preset (ask, balanced, hands_off) or single limits. Loosening asks the person. */
    async limits() {
      const current = await deps.limits.read();
      return { ...current, preset: cloudLimitsPresetOf(current) ?? "custom" };
    },

    async set_limits(rawArgs?: unknown) {
      const args = record(rawArgs);
      const current = await deps.limits.read();
      const presetName = text(args, "preset")?.replace("-", "_") ?? null;
      const preset = presetName ? CLOUD_LIMITS_PRESETS[presetName as CloudLimitsPreset] ?? null : null;
      if (presetName && !preset) throw new Error("Pick a preset: ask, balanced or hands-off.");
      const next: CloudAgentLimits = { ...current, ...(preset ?? {}) };
      if (typeof args.unattendedSpend === "boolean") next.unattendedSpend = args.unattendedSpend;
      if (args.machinesPerDay != null) {
        const perDay = Number(args.machinesPerDay);
        if (!Number.isInteger(perDay) || perDay < 0 || perDay > 100) throw new Error("Machines a day is a whole number from 0 to 100.");
        next.machinesPerDay = perDay;
      }
      const maxShape = typeof args.maxShape === "string" ? shapeArg({ shape: args.maxShape }) : null;
      if (maxShape) next.maxShape = maxShape;
      const was = current;
      const looser = (next.unattendedSpend && !was.unattendedSpend)
        || next.machinesPerDay > was.machinesPerDay
        || !cloudShapeWithin(next.maxShape, was.maxShape);
      if (looser) {
        const max = cloudShapeById(next.maxShape);
        await approve(readApproval(args), {
          action: "person_only",
          title: "Let agents use more on ADE Cloud",
          body: `Unattended agents could then ${next.unattendedSpend ? `start ${next.machinesPerDay} new computer${next.machinesPerDay === 1 ? "" : "s"} a day, up to ${max.label}` : "use nothing"}.`,
          confirm: "Allow it",
        });
      }
      return await deps.limits.write(next);
    },

    async ready_set(rawArgs?: unknown) {
      const args = record(rawArgs);
      const identity = normalizeGitRemoteIdentity(text(args, "originUrl") ?? text(args, "identity"));
      if (!identity) throw new Error("Run it in a project with a git origin, or pass --origin <url>.");
      const { projects } = await deps.readySettings.read();
      const existing = projects.find((entry) => entry.identity === identity) ?? null;
      const kind = text(args, "kind") as CloudMachineKind | null;
      const shape = shapeArg(args);
      const next = normalizeCloudReadySettings({
        ...(existing ?? {}),
        identity,
        projectName: text(args, "projectName") ?? existing?.projectName ?? undefined,
        ...(kind ? { kind } : {}),
        ...(shape ? { shape } : {}),
        ...(typeof args.setup === "string" ? { setup: args.setup } : {}),
        failure: null,
      } as Partial<CloudReadyProjectSettings>);
      if (!next) throw new Error("That isn't a project ADE can keep a machine ready for.");
      // Turning it on, or a bigger or other kind of machine, asks (and is held to the agent limits).
      if (!existing || existing.shape !== next.shape || existing.kind !== next.kind) {
        const account = await hoursCheck();
        const shape = cloudShapeById(next.shape);
        // The keeper makes the machine later; this only asks, so it holds no slot.
        (await approve(readApproval(args), {
          action: "spend",
          newMachine: true,
          shape: next.shape,
          title: `Keep a cloud machine ready for ${next.projectName}`,
          body: `ADE prepares a ${shape.label}${next.kind === "vm" ? " full computer" : " computer"} with the repository cloned and setup run, then keeps it asleep. A chat on it uses ${describeCloudHoursUse(next.kind, shape.id, cloudCatalogOf(account))}.`,
          confirm: "Keep one ready",
        })).release();
      }
      await deps.readySettings.write([...projects.filter((entry) => entry.identity !== identity), next]);
      await deps.desktop()?.readyRefresh().catch((error: unknown) => logger.warn?.("cloud.ready_refresh_failed", { error: getErrorMessage(error) }));
      return { identity, settings: next, preparedBy: deps.desktop() ? "this computer" : "the next ADE desktop that opens" };
    },

    async ready_off(rawArgs?: unknown) {
      const args = record(rawArgs);
      const identity = normalizeGitRemoteIdentity(text(args, "originUrl") ?? text(args, "identity"));
      if (!identity) throw new Error("Run it in a project with a git origin, or pass --origin <url>.");
      const { projects } = await deps.readySettings.read();
      if (!projects.some((entry) => entry.identity === identity)) return { identity, wasOn: false };
      await deps.readySettings.write(projects.filter((entry) => entry.identity !== identity));
      await deps.desktop()?.readyRefresh().catch(() => null);
      return { identity, wasOn: true };
    },

    async ready_retry(rawArgs?: unknown) {
      const args = record(rawArgs);
      const identity = normalizeGitRemoteIdentity(text(args, "originUrl") ?? text(args, "identity"));
      if (!identity) throw new Error("Run it in a project with a git origin, or pass --origin <url>.");
      const { projects } = await deps.readySettings.read();
      const entry = projects.find((candidate) => candidate.identity === identity);
      if (!entry) throw new Error("This project doesn't keep a machine ready. ade cloud ready on turns it on.");
      await hoursCheck();
      await deps.readySettings.write(projects.map((candidate) => (candidate.identity === identity ? { ...candidate, failure: null } : candidate)));
      await deps.desktop()?.readyRefresh().catch(() => null);
      return { identity, retrying: true };
    },
  };
}

