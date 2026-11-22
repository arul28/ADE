/**
 * The `cloud` action domain's machine verbs, behind `ade cloud …`: status
 * (the whole account in one read), list, create, sleep, wake, resize, update,
 * copy, move, delete, hours, a lane on its own computer, and clearing caches.
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
 * the same way (it has no chat, so the line goes to the log), and a delete or
 * a cancel from it always needs the person. A size change always needs the
 * person: an agent nobody watches never makes one. A person is never counted
 * against the daily limit.
 *
 * An agent never makes a computer on its own: a make, a copy or a move asks
 * the person on a card in the agent's chat, a full-auto chat too, and with
 * nobody to ask (an automation run, an ADE MCP app, no chat) the answer is no
 * (`CLOUD_AGENT_NO_COMPUTER_MESSAGE`). An agent starts a lane instead
 * (`lane_launch`), which makes the lane's own computer within the agent limits.
 *
 * A disk grow (`grow_disk`) on the computer the agent runs on is the one
 * change an agent makes alone, unattended too: up to its size's disk maximum
 * (Pricing v2: no plan disk and no paid extra disk) it only restarts the
 * computer, and ADE continues the chat after it. Past the size's maximum the
 * answer names it, and the agent asks for a bigger size.
 */

import { AdeExpectedError } from "../../../shared/expectedError";
import { randomUUID } from "node:crypto";
import {
  ADE_CLOUD_APPROVAL_METADATA_KEY,
  CLOUD_HOURS_UNKNOWN_MESSAGE,
  CLOUD_MACHINE_DEFAULT_NAME,
  CLOUD_MADE_BY_CHAT_METADATA,
  CLOUD_OUT_OF_HOURS_MESSAGE,
  CLOUD_OUTSIDE_AGENT_FREE_CODE,
  CLOUD_OUTSIDE_AGENT_FREE_MESSAGE,
  CLOUD_SHAPES,
  cloudCatalogOf,
  cloudHoursRate,
  cloudInstanceType,
  cloudOutsideAgentsAllowed,
  cloudMachineKindOf,
  cloudShapeFor,
  cloudKindLabel,
  cloudOutOfHours,
  cloudShape,
  cloudShapeById,
  cloudShapeWithin,
  cloudUnattendedHoursBlock,
  cloudLimitsPresetOf,
  cloudAgentExtraDiskCentsOf,
  cloudAgentExtraDiskLooser,
  cloudAgentExtraDiskRefusal,
  formatCloudCents,
  CLOUD_DEFAULT_AGENT_LIMITS,
  CLOUD_LIMITS_PRESETS,
  type CloudAccountState,
  type CloudAgentLimits,
  type CloudAgentMaker,
  type CloudCatalog,
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
  type CloudInviteRedeemOutcome,
  type CloudReferralSummary,
} from "../../../shared/adeCloud";
import type { PermissionLevel } from "../../../shared/permissionLadder";
import { getErrorMessage } from "../shared/utils";
import type { CloudLogger, CloudProvider } from "./cloudProvider";
import type { CloudApiClient } from "../../../shared/cloudApiClient";
import type { CloudLaneAccount } from "./cloudLaneAccount";
import { buildCloudLaneVerbs } from "./cloudLaneVerbs";
import type { CloudMoveResult } from "./cloudMachineCopy";
import type { CloudBrainMaker, CloudMakeInput } from "./cloudBrainMaker";
import type { CloudLaneLaunchBrainHost } from "./cloudLaneLaunchBrainHost";
import type { CloudDiskGrowAnswer, CloudDiskGrowHost } from "./cloudDiskGrowHost";
import { CLOUD_TIER_IDS, cloudTier, cloudTierOfMachine, cloudTierOfShape, cloudTierRateLabel, cloudTiers, isCloudTierId, type CloudTierId } from "../../../shared/cloudTiers";
import { cloudLaneLaunchStartRefusal, cloudLaneStartBlock, type CloudLaneLaunchStatus, type CloudLaneMachine } from "../../../shared/cloudLaneLaunch";
import type { ChatLaunchArgs } from "../../../shared/types";
import { CLOUD_AUTO_SIZE } from "../../../../../account-directory/src/cloud/contract";
import type { AdeCardPayload } from "../../../shared/adeCard";
import { buildCloudTierRequestCard, cloudJoinApprovalWaitText } from "../../../shared/cloudLaneLife";
import { buildCloudAccountStatus, CLOUD_DAILY_LIMIT_SETTING, type CloudAccountStatus } from "./cloudAccountStatus";
import { captureCloudLaneAnalytics, type CloudLaneAnalyticsCapture } from "./cloudLaneAnalytics";
import { countAgentMadeToday, type createCloudMachines } from "./cloudMachines";
import { cloudAgentLimitsChanges, type CloudAgentLimitsStore } from "./cloudSleep";

/**
 * Who is asking, stamped by the RPC server from the caller's session; never
 * taken from the arguments. `viaAdeMcp`: an outside AI app on an ADE MCP
 * connection with write access. It has no chat and nobody watches it, so it
 * is an unattended agent: held to the agent limits, never a person.
 */
/**
 * Who asks. `automation` marks a rule's own run (an `ade-action` step, or the
 * run's lane on ADE Cloud): it has no chat to ask in, and is held to the
 * agent limits like a chat nobody watches. Only in-process callers set it;
 * the RPC server rebuilds `approval` for every outside call.
 */
export type CloudApproval =
  | { by: "person" }
  | { by: "agent"; chatSessionId: string | null; viaAdeMcp?: boolean; automation?: boolean };

export { CLOUD_DAILY_LIMIT_SETTING } from "./cloudAccountStatus";
export type { CloudAccountStatus, CloudCanStartLane, CloudCanStartLaneCode, CloudStatusComputer } from "./cloudAccountStatus";

/** Medium's shape (`CLOUD_AUTO_SIZE.to`): the agent limits must allow it before an unattended agent's default Small may move up. */
const MEDIUM_SHAPE: CloudShapeId = "4x8";

/** What a desktop does for the brain over the bridge (cloudDesktopActions.ts). */
type CloudMadeBy = { madeByChat?: string | null; madeByAgent?: CloudAgentMaker | null };

export type CloudDesktopBridge = {
  create(args: CloudCreateMachineArgs & CloudMadeBy): Promise<CloudCreateMachineResult>;
  copy(args: { instanceId: string; name?: string | null; shape?: CloudShapeId | null } & CloudMadeBy): Promise<CloudCreateMachineResult & { copiedFrom: string; forkMs: number }>;
  move(args: { instanceId: string; machineKey?: string | null; to: CloudMachineKind; shape?: CloudShapeId | null; selfApprove?: boolean } & CloudMadeBy): Promise<CloudMoveResult>;
};

export type CloudChatApprovals = {
  requestChatInput(args: {
    chatSessionId: string;
    title: string;
    body: string;
    timeoutMs?: number;
    allowsFreeform?: boolean;
    providerMetadata?: Record<string, unknown>;
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
  /** Posts a card in the chat (a tier change request). Unset where the chat service can't. */
  postCard?: (chatSessionId: string, card: AdeCardPayload) => Promise<void>;
};

export type CloudAgentActionDeps = {
  machines: ReturnType<typeof createCloudMachines>;
  limits: CloudAgentLimitsStore;
  /** The desktop attached to this brain, or null. */
  desktop: () => CloudDesktopBridge | null;
  /** Makes machines here when no desktop is attached; the person approves from a link. */
  maker?: CloudBrainMaker | null;
  /** ADE Cloud lane launches this brain owns (`lane_launch*`); null where it can't own them. */
  laneLaunch?: (() => CloudLaneLaunchBrainHost | null) | null;
  /** The project's git origin, for a lane launch that doesn't name one. */
  projectOriginUrl?: (() => string | null) | null;
  /**
   * The person's saved size for new lanes (`cloudDefaultTier` in the account
   * settings), as stored: undefined when nothing is saved, null when this
   * ADE can't read the account settings. Leave the dep out for "can't read".
   */
  savedDefaultTier?: (() => unknown) | null;
  approvals: CloudChatApprovals | null;
  /** The disk grower of the ADE Cloud computer this brain runs on (`cloudDiskGrowHost.ts`); null anywhere else. */
  diskGrow?: (() => CloudDiskGrowHost | null) | null;
  /** This runtime's project root on this computer: where a grow's chat card goes after the restart. */
  projectRoot?: string | null;
  /** One coarse outcome per cache clear (cloudLaneAnalytics.ts); never the computer. */
  analytics?: CloudLaneAnalyticsCapture;
  /**
   * The account's lanes, saved chats, CLI copies, backups and server jobs
   * (`cloudLaneVerbs.ts`): the shared lane core, the provider and the account
   * server. Null where this ADE can't reach the account.
   */
  lanes?: {
    account: () => CloudLaneAccount;
    client: () => Promise<CloudProvider>;
    api: () => CloudApiClient | null;
  } | null;
  logger?: CloudLogger;
};

/** An agent's reason on a tier request card: one short paragraph. */
function clipReason(reason: string): string {
  const flat = reason.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 299)}…` : flat;
}

/** An approval card that gives up: nobody watching must never hold an agent. */
const APPROVAL_TIMEOUT_MS = 5 * 60_000;
/** The biggest disk an agent's `grow_disk` may name, in GB (`--free` or `--disk`). */
const GROW_DISK_MAX_GB = 1000;

/** The chat to credit a machine to: an agent's own chat, never a person's. */
function madeByChat(approval: CloudApproval): string | null {
  return approval.by === "agent" ? approval.chatSessionId : null;
}

/**
 * An agent's ask ADE turned down (no chat to ask in, plan mode, the person
 * said no). The agent reads why and acts on it: an answer, not a fault, so it
 * stays out of Sentry issues (`shared/expectedError.ts`).
 */
export class CloudDeclined extends AdeExpectedError {
  readonly code = "cloud_declined";
  constructor(message: string) {
    super(message, "user");
    this.name = "CloudDeclined";
  }
}

/**
 * Why an agent's make, copy or move goes nowhere without the person: agents
 * start lanes on ADE Cloud, each with its own computer, and never add a bare one.
 */
export const CLOUD_AGENT_NO_COMPUTER_MESSAGE =
  "Agents don't make ADE Cloud computers. Start a lane on ADE Cloud with the size the work needs "
  + "(ade chat create --machine cloud --size <size>, or ade lanes create --machine cloud --size <size>), "
  + "or ask the person to make the computer in ADE (Settings › ADE Cloud).";

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
    ...(raw.automation === true ? { automation: true } : {}),
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

/** Where a person starts a lane on ADE Cloud when the caller has no chat to ask in. */
const CLOUD_LANE_PERSON_PLACE =
  "Start it in the ADE app (pick ADE Cloud under Run on in a new chat), or ask for it in an ADE chat, where ADE can ask you.";

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

  /**
   * Refuses before a card goes up for something the server would only refuse.
   * `shape`: the size the work ends on; a Small one never uses hours, so it
   * goes on at 0 hours (Pricing v2).
   */
  const hoursCheck = async (target?: { kind: CloudMachineKind; shape: CloudShapeId | null }): Promise<CloudAccountState | null> => {
    const account = await readAccount();
    const free = target?.shape ? cloudHoursRate(target.kind, target.shape, cloudCatalogOf(account)) === 0 : false;
    if (cloudOutOfHours(account) && !free) throw new Error(CLOUD_OUT_OF_HOURS_MESSAGE);
    return account;
  };

  /**
   * Outside agents (ADE MCP) may start ADE Cloud work on paid plans only
   * (Pricing v2). An early answer from the account as last read, with the
   * server's own sentence; the server refuses anyway
   * (`outside_agent_free_plan`) and its sentence reaches the agent the same
   * way. Reads (`ade cloud status`, lists, follows) never come here.
   */
  const outsideAgentCheck = async (approval: CloudApproval, known?: CloudAccountState | null): Promise<void> => {
    if (approval.by !== "agent" || approval.viaAdeMcp !== true) return;
    const account = known !== undefined ? known : await readAccount();
    if (!cloudOutsideAgentsAllowed(account)) throw new CloudDeclined(CLOUD_OUTSIDE_AGENT_FREE_MESSAGE);
  };

  /**
   * For what adds a computer (a new lane, a make, a copy): refuses before any
   * card and any spend when the account is out of hours, uses all its
   * computers or has a full disk, with the sentence `cloud.status` and the
   * composer show. An account it couldn't read goes on: the server decides,
   * and an unattended agent is still refused for unknown hours in `approve()`.
   */
  const newComputerCheck = async (sizeId: string | null = null): Promise<CloudAccountState | null> => {
    const account = await readAccount();
    const block = cloudLaneStartBlock(account, { newLane: true, sizeId });
    if (block) throw new Error(block.message);
    return account;
  };

  /** A retry's account check: the hours only, as its replacement's disk is checked by the server once the failed computer is gone. */
  const retryCheck = async (sizeId: string | null = null): Promise<CloudAccountState | null> => {
    const account = await readAccount();
    const block = cloudLaneStartBlock(account, { newLane: false, sizeId });
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

  /**
   * Asks before spending or deleting. Resolves when it may go ahead, with what
   * to call once a new machine really exists (it counts toward an unattended
   * agent's daily limit then, so a make that failed costs no slot) and whether
   * the yes came from what the person lets unattended agents do (a full-auto
   * chat or an automation, within the agent limits); throws
   * `CloudDeclined` (with why) when not. `limitRefusal`: the sentence of
   * `card.unattendedRule` when it said no (nothing else is checked then).
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
      /**
       * The card's text. A function is read only when a card is really
       * posted: a lane delete's work check, which may wake an asleep
       * computer, never runs for a caller ADE refuses or answers alone.
       */
      body: string | (() => Promise<string>);
      confirm: string;
      madeByThisChat?: boolean;
      /** Starts a new machine (make, copy, move): counts against the day's limit. */
      newMachine?: boolean;
      /** The size it picks (make, copy, move, resize): within the largest allowed. */
      shape?: CloudShapeId | null;
      /** Changes a computer's size (resize): only the person decides it, never an agent nobody watches. */
      tierChange?: boolean;
      /**
       * Adds a computer that is not a new lane's (make, copy, move): an agent
       * gets it only with the person's yes on its card, never unattended.
       */
      makesComputer?: boolean;
      /** Where the person can do it instead, when the caller has no chat to ask in. */
      personPlace?: string;
      /**
       * A rule of the agent limits the caller answers itself (a disk grow's
       * paid extra disk, `cloudAgentExtraDiskRefusal`), checked first for an
       * agent nobody watches: its sentence comes back as `limitRefusal`, with
       * no notice and no other check.
       */
      unattendedRule?: (limits: CloudAgentLimits) => string | null;
      /** What the spend costs, said in the notice of an unattended yes. */
      cost?: string;
      /** False: it spends money, not hours (paid extra disk), so the hours check doesn't apply. */
      usesHours?: false;
      /**
       * A second yes on the card (a lane delete's "Keep for later"): the
       * person picks it instead of `confirm`, and the answer's `choice` says
       * so. Never picked for a caller nobody watches: that one gets `confirm`.
       */
      alternative?: { label: string };
    },
  ): Promise<{ counted: () => void; release: () => void; unattended: boolean; maker: CloudAgentMaker | null; limitRefusal: string | null; choice: "confirm" | "alternative" }> => {
    const nothing = { counted: () => undefined, release: () => undefined, unattended: false, maker: null, limitRefusal: null, choice: "confirm" as const };
    const noChatToAsk = () => new CloudDeclined(`${card.title} uses hours or deletes something, so it needs your yes, and ADE has no chat to ask you in. ${card.personPlace ?? "Run it from an ADE chat, or do it in ADE: Settings › ADE Cloud, the lane's row."}`);
    if (approval.by === "person") return nothing;
    const chatSessionId = approval.chatSessionId;
    // An app on ADE MCP has no chat to ask in: it is answered like a chat
    // nobody watches, within the agent limits, never as the person.
    const viaAdeMcp = approval.viaAdeMcp === true;
    // A rule's own run: nobody to ask, the agent limits answer.
    const automationRun = !viaAdeMcp && approval.automation === true;
    const declineComputer = (where: string): never => {
      if (chatSessionId && deps.approvals) deps.approvals.notice(chatSessionId, `ADE said no to "${card.title}" in ${where}: agents start lanes on ADE Cloud, they don't make computers.`);
      else logger.info?.("cloud.unattended_answer", { message: `"${card.title}" declined in ${where}: agents don't make computers` });
      throw new CloudDeclined(`${card.title}: declined. ${CLOUD_AGENT_NO_COMPUTER_MESSAGE}`);
    };
    if (!viaAdeMcp && !automationRun && (!chatSessionId || !deps.approvals)) {
      if (card.makesComputer) declineComputer("a call with no chat");
      throw noChatToAsk();
    }
    const approvals = deps.approvals;
    const notice = (message: string) => {
      if (chatSessionId && approvals) approvals.notice(chatSessionId, message);
      else logger.info?.("cloud.unattended_answer", { message });
    };
    const level = !viaAdeMcp && chatSessionId && approvals ? approvals.permissionLevel(chatSessionId) : null;
    const automation = automationRun || (!viaAdeMcp && chatSessionId && approvals
      ? await approvals.isAutomationRun(chatSessionId).catch((error: unknown) => {
          logger.warn?.("cloud.automation_run_read_failed", { chatSessionId, error: getErrorMessage(error) });
          return false;
        })
      : false);
    // Written on a new machine, so the agents' daily limit counts it after a restart too.
    const maker: CloudAgentMaker = viaAdeMcp ? "mcp" : automation ? "automation" : "chat";
    if (level === "plan") {
      notice(`ADE said no to "${card.title}" for this chat: plan mode changes nothing.`);
      throw new CloudDeclined(`${card.title}: declined, because this chat is in plan mode.`);
    }
    // What only the person decides (a size, a delete of a machine this chat
    // didn't make, a person-only setting): a full-auto chat still has the
    // person's chat, so it shows them the card, as a secret request does.
    // An ADE MCP app or an automation run has nobody to show it to.
    // A computer that is not a new lane's is the person's call too: a
    // full-auto chat shows them the card, and nobody else may make one.
    const personDecides = card.action === "person_only" || card.tierChange === true || card.makesComputer === true
      || (card.action === "delete" && !card.madeByThisChat);
    if (viaAdeMcp || automation || (level === "full-auto" && !personDecides)) {
      const where = viaAdeMcp ? "this app connected through ADE MCP" : automation ? "this automation run" : "this full-auto chat";
      if (card.makesComputer) declineComputer(where);
      if (card.action === "person_only") {
        notice(`ADE said no to "${card.title}" in ${where}: only you can decide it.`);
        throw new CloudDeclined(`${card.title}: declined. Only the person can decide it (Settings › Integrations › ADE Cloud).`);
      }
      if (card.tierChange) {
        notice(`ADE said no to "${card.title}" in ${where}: only you can change a computer's size.`);
        throw new CloudDeclined(`${card.title}: declined. Only the person can change a computer's size. From a chat, ask them with ade cloud resize --request --size <size> --reason "<why>".`);
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
      // An outside agent on the Free plan starts no ADE Cloud work: the server's sentence, passed on as it is.
      if (viaAdeMcp && costs) {
        try {
          await outsideAgentCheck(approval);
        } catch (error) {
          notice(`ADE said no to "${card.title}" in ${where}: ${CLOUD_OUTSIDE_AGENT_FREE_MESSAGE}`);
          throw error;
        }
      }
      const limits = costs ? await deps.limits.read().catch((error: unknown): CloudAgentLimits => {
        logger.warn?.("cloud.agent_limits_read_failed", { error: getErrorMessage(error) });
        return { ...CLOUD_DEFAULT_AGENT_LIMITS, fallback: true };
      }) : null;
      const refuse = (why: string, change = "The person can change what agents may do in Settings › Integrations › ADE Cloud."): never => {
        notice(`ADE said no to "${card.title}" in ${where}: ${why}`);
        throw new CloudDeclined(`${card.title}: declined. ${why} ${change}`.trim());
      };
      const ruled = limits && card.unattendedRule ? card.unattendedRule(limits) : null;
      if (ruled) {
        // No line here: the caller answers it (a disk grow's card names what holds the disk).
        logger.info?.("cloud.unattended_answer", { message: `"${card.title}" declined by the agent limits in ${where}` });
        return { ...nothing, unattended: true, maker, limitRefusal: ruled };
      }
      if (limits && !limits.unattendedSpend) refuse("your settings say unattended agents ask before anything that uses hours.");
      if (limits && card.shape && !cloudShapeWithin(card.shape, limits.maxShape)) {
        const max = cloudShapeById(limits.maxShape);
        refuse(`agents may pick up to ${max.label} on their own.`);
      }
      // hoursCheck lets hours it couldn't read through, for a person to decide; nobody decides here.
      const blocked = costs && card.usesHours !== false ? cloudUnattendedHoursBlock(await readAccount()) : null;
      if (blocked) {
        const why = blocked === "out_of_hours" ? CLOUD_OUT_OF_HOURS_MESSAGE : CLOUD_HOURS_UNKNOWN_MESSAGE;
        notice(`ADE said no to "${card.title}" in ${where}: ${why}`);
        throw new CloudDeclined(`${card.title}: declined. ${why}`);
      }
      if (limits && card.newMachine) {
        // A count it can't read says no: nobody is here to decide instead.
        const listed = await deps.machines.agentMadeToday().catch((error: unknown) => {
          logger.warn?.("cloud.agent_made_today_read_failed", { error: getErrorMessage(error) });
          return null;
        });
        if (listed == null) refuse("ADE couldn't count today's new computers, so it can't check the daily limit. Try again soon.", "");
        // Makes still running are in neither count: they go on top of the larger one.
        const made = agentNewComputersToday(listed ?? 0);
        if (made >= limits.machinesPerDay) {
          const perDay = limits.machinesPerDay;
          refuse(
            `your agents hit today's limit of ${perDay} new computer${perDay === 1 ? "" : "s"} a day.`,
            `Change it in ${CLOUD_DAILY_LIMIT_SETTING}.`,
          );
        }
      }
      notice(`ADE approved "${card.title}" for ${where}, within what you let agents do.${card.cost ? ` ${card.cost}` : ""}`);
      if (!card.newMachine) return { ...nothing, unattended: true, maker };
      reservedHere += 1;
      let held = true;
      const release = () => {
        if (!held) return;
        held = false;
        reservedHere -= 1;
      };
      return { counted: () => { release(); countMadeHere(); }, release, unattended: true, maker, limitRefusal: null, choice: "confirm" as const };
    }
    if (!chatSessionId || !approvals) {
      throw noChatToAsk();
    }
    const body = typeof card.body === "function" ? await card.body() : card.body;
    let response: Awaited<ReturnType<CloudChatApprovals["requestChatInput"]>>;
    try {
      response = await approvals.requestChatInput({
      chatSessionId,
      title: card.title,
      body,
      timeoutMs: APPROVAL_TIMEOUT_MS,
      allowsFreeform: false,
      // Only the person answers: an agent's `chat.respondToInput` is refused.
      providerMetadata: { [ADE_CLOUD_APPROVAL_METADATA_KEY]: true },
      questions: [{
        id: "decision",
        header: "ADE Cloud",
        question: `${card.title}? ${body}`,
        allowsFreeform: false,
        options: [
          { label: card.confirm, value: "yes" },
          ...(card.alternative ? [{ label: card.alternative.label, value: "alternative" }] : []),
          { label: card.alternative ? "Cancel" : "No", value: "no" },
        ],
      }],
      });
    } catch (error) {
      // The chat lives on another ADE on this computer, or is gone: there is no card to show.
      throw new CloudDeclined(`${card.title}: ADE couldn't ask in this chat (${getErrorMessage(error)}), so nothing was done.`);
    }
    const answer = response.answers.decision?.[0] ?? "";
    // The person said yes to an agent's ask: still an agent's new machine.
    if (response.decision === "accept" && answer === "yes") return { ...nothing, maker: "chat" };
    if (response.decision === "accept" && answer === "alternative" && card.alternative) return { ...nothing, maker: "chat", choice: "alternative" };
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
      if (input.kind === "create") return await desktop.create({ ...input.machine, madeByChat: input.madeByChat ?? null, madeByAgent: input.madeByAgent ?? null });
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
      approvals.notice(chatSessionId, `Approve "${name}" joining your ADE account: open ${url} on your phone or in a browser signed in to ADE. The command waits up to ${cloudJoinApprovalWaitText()}.`);
    });
  };

  const runAction = async (box: CloudMachine, action: Parameters<typeof deps.machines.run>[0]): Promise<CloudMachineActionResult> => {
    const result = await deps.machines.run(action);
    if (!result.ok) throw new Error(result.message);
    return result;
  };

  const summary = (box: CloudMachine, catalog: CloudCatalog) => ({
    instanceId: box.instanceId,
    name: box.name,
    machineKey: box.machineKey,
    state: box.state,
    type: box.type,
    size: describeCloudMachineSize(box, catalog),
    shape: box.shapeId,
    hoursRate: box.hoursRate,
    sleep: box.sleep,
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

  const noLanes = (): never => {
    throw new Error("This ADE can't reach your ADE account's lanes. Sign in to ADE, then try again.");
  };
  const laneVerbs = buildCloudLaneVerbs({
    account: () => deps.lanes?.account() ?? noLanes(),
    client: () => deps.lanes?.client() ?? noLanes(),
    api: () => deps.lanes?.api() ?? null,
    readMachines,
    recentInstances: () => deps.machines.recentInstances(60_000),
    approve,
    readApproval,
    laneLaunch: (args: Record<string, unknown>) => actions.lane_launch(args),
    projectOriginUrl: () => deps.projectOriginUrl?.() ?? null,
    analytics: deps.analytics,
    logger,
  });

  const actions = {
    ...laneVerbs.actions,
    async list(rawArgs?: unknown) {
      const all = await readMachines();
      // The web app's Settings › ADE Cloud reads the account's own list (no key in it), like this desktop's main.
      if (record(rawArgs).detail === "full") return all;
      const catalog = cloudCatalogOf(all.account);
      return {
        machines: all.machines.map((box) => summary(box, catalog)),
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
      const listing = deps.machines.list();
      // The lanes whose computer was deleted, read beside the list and from it (no second list).
      const lanesComputerDeleted = deps.lanes
        ? laneVerbs.lanesComputerDeleted(listing.then((listed) => {
            if (listed.state !== "ok") throw new Error(listed.message ?? "ADE Cloud isn't there.");
            return listed;
          }))
        : Promise.resolve(null);
      const result = await listing;
      const defaultSize = readDefaultTier();
      const limits = result.state === "ok" ? await deps.limits.read().catch((error: unknown) => {
        logger.warn?.("cloud.agent_limits_read_failed", { error: getErrorMessage(error) });
        return null;
      }) : null;
      // The list just read every computer: count agents' makes from it, with no second call.
      const listedToday = result.state === "ok"
        ? countAgentMadeToday(deps.machines.recentInstances(60_000) ?? [], Date.now())
        : 0;
      const status = buildCloudAccountStatus({ result, limits, defaultSize, newComputersToday: agentNewComputersToday(listedToday) });
      const gone = await lanesComputerDeleted;
      return { ...status, lanesComputerDeleted: gone?.lanes ?? null, ...(gone?.partial ? { lanesComputerDeletedPartial: true } : {}) };
    },

    async create(rawArgs?: unknown) {
      const args = record(rawArgs);
      const kind = (text(args, "kind") ?? "box") as CloudMachineKind;
      if (!isCloudMachineKind(kind)) throw new Error("Make a standard or a full computer (--kind box|vm).");
      const shapeId = shapeArg(args) ?? "2x4";
      const shape = cloudShapeById(shapeId);
      const name = text(args, "name") ?? CLOUD_MACHINE_DEFAULT_NAME;
      const approval = readApproval(args);
      // The lane size of this shape (the sizes are the server's; a Small one never uses hours).
      const account = await newComputerCheck(cloudTierOfShape({ type: cloudInstanceType(kind), cpu: shape.cpu, memoryGb: shape.memoryGb }, cloudTiers(cloudCatalogOf(null)))?.id ?? null);
      await outsideAgentCheck(approval, account);
      if (cannotMake()) throw new Error(NO_DESKTOP);
      const yes = await approve(approval, {
        action: "spend",
        title: `Make "${name}" on ADE Cloud`,
        body: `A ${shape.label}${kind === "vm" ? " full computer" : " computer"} (${shape.cpu} CPU, ${shape.memoryGb} GB). ${describeCloudHoursUse(kind, shape.id, cloudCatalogOf(account))}`,
        confirm: "Make it",
        newMachine: true,
        makesComputer: true,
        shape: shapeId,
      });
      try {
        const made = await make(approval, { kind: "create", machine: { kind, shape: shapeId, name }, madeByChat: madeByChat(approval), madeByAgent: yes.maker, selfApprove: yes.unattended }, args.background === true);
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
      const args = record(rawArgs);
      const { box, all } = await resolveMachine(text(args, "machine"));
      await outsideAgentCheck(readApproval(args), all.account);
      return await runAction(box, { instanceId: box.instanceId, action: "wake" });
    },

    async resize(rawArgs?: unknown) {
      const args = record(rawArgs);
      const { box } = await resolveMachine(text(args, "machine"));
      const shapeId = shapeArg(args);
      if (!shapeId) throw new Error("Pass the new size (--shape 4x8).");
      const shape = cloudShapeById(shapeId);
      const account = await hoursCheck({ kind: cloudMachineKindOf(box.type), shape: shapeId });
      await approve(readApproval(args), {
        action: "spend",
        title: `Resize "${box.name ?? box.instanceId}" to ${shape.label}`,
        body: `It restarts to change size: files stay, running chats, terminals and processes stop. ${describeCloudHoursUse(cloudMachineKindOf(box.type), shape.id, cloudCatalogOf(account))}`,
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
      const approval = readApproval(args);
      await outsideAgentCheck(approval, await newComputerCheck(cloudTierOfMachine(box, cloudTiers(cloudCatalogOf(null)))?.id ?? null));
      if (cannotMake()) throw new Error(NO_DESKTOP);
      const rate = box.hoursRate != null ? formatCloudHoursRate(box.hoursRate).toLowerCase() : null;
      const yes = await approve(approval, {
        action: "spend",
        title: `Copy "${box.name ?? box.instanceId}" into a new machine`,
        body: `"${name}" gets the same files (repos, lanes, installed dependencies) and signs in as a new computer${rate ? `, and uses ${rate}` : ""}. A big disk takes a few minutes to copy.`,
        confirm: "Copy it",
        newMachine: true,
        makesComputer: true,
        shape: shapeId ?? box.shapeId,
      });
      try {
        const made = await make(approval, { kind: "copy", instanceId: box.instanceId, name, shape: shapeId, madeByChat: madeByChat(approval), madeByAgent: yes.maker, selfApprove: yes.unattended }, args.background === true);
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
        throw new Error(`"${box.name ?? box.instanceId}" is the machine this runs on, so it can't move itself. Push the lane's branch, then start a lane on ADE Cloud on it with the size the work needs (ade lanes create --machine cloud --size ${to === "vm" ? "large" : "small"} --existing-branch <branch> --name "<name>"), and start a chat there (ade chat create --machine <its computer> --lane <its lane id> --provider <p> --model <id> --prompt "<the task>"). This machine stays and sleeps when idle; offer to delete it from the new chat.`);
      }
      const shapeId = shapeArg(args);
      const approval = readApproval(args);
      await outsideAgentCheck(approval, await hoursCheck({ kind: to, shape: shapeId ?? box.shapeId }));
      if (cannotMake()) throw new Error(NO_DESKTOP);
      const name = box.name ?? box.instanceId;
      const yes = await approve(approval, {
        action: "delete",
        title: `Move "${name}" to a ${cloudKindLabel(to)}`,
        body: `ADE makes a new ${cloudKindLabel(to)}, copies every repo, lane and chat on "${name}" into it, then deletes "${name}". Running processes stop${box.type === "vm" ? ", and Docker images and volumes stay behind" : ""}.`,
        confirm: "Move it",
        newMachine: true,
        makesComputer: true,
        shape: shapeId ?? box.shapeId,
        madeByThisChat: approval.by === "agent" && approval.chatSessionId != null
          && (await deps.machines.instanceMetadata(box.instanceId).catch((error: unknown) => {
            // Unknown is "not this chat's": an unattended move is then declined.
            logger.warn?.("cloud.instance_metadata_read_failed", { instanceId: box.instanceId, error: getErrorMessage(error) });
            return null;
          }))?.[CLOUD_MADE_BY_CHAT_METADATA] === approval.chatSessionId,
      });
      try {
        const made = await make(approval, { kind: "move", instanceId: box.instanceId, machineKey: box.machineKey, to, shape: shapeId, madeByChat: madeByChat(approval), madeByAgent: yes.maker, selfApprove: yes.unattended }, args.background === true);
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
     * launch id again answers that launch: never a second computer at once.
     * A failed one goes on from its failed step, after the same checks as a
     * first start, since the server may give it a new computer.
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
      // That is ADE's default for this launch, so a Small may move to Medium
      // when its setup needs more memory (`CLOUD_AUTO_SIZE`); a size asked for stays.
      const askedSize = record(asked.cloud).sizeId;
      const sizeDefaulted = askedSize == null || askedSize === "";
      const sizeId = sizeDefaulted ? readDefaultTier() ?? "small" : askedSize;
      if (!isCloudTierId(sizeId)) throw new Error(`Pick a size: ${CLOUD_TIER_IDS.join(", ")}.`);
      const launch: ChatLaunchArgs = { ...asked, cloud: { sizeId, sizeChoice: sizeDefaulted ? "default" : "picked" } };
      const laneOnly = launch.kind === "lane";
      const host = deps.laneLaunch?.() ?? null;
      if (!host) throw new Error("This ADE can't start a lane on ADE Cloud. Use the ADE app, or the ade command where ADE runs in the background.");
      const approval = readApproval(args);
      const chatSessionId = approval.by === "agent" ? approval.chatSessionId : null;
      const launchId = typeof launch.launchId === "string" ? launch.launchId.trim().toLowerCase() : "";
      const existing = launchId ? await host.status(launchId) : null;
      const startArgs = {
        args: launch,
        originUrl: text(args, "originUrl") ?? deps.projectOriginUrl?.() ?? null,
        madeByChat: madeByChat(approval),
        caller: { chatSessionId, permissionLevel: chatSessionId ? deps.approvals?.permissionLevel(chatSessionId) ?? null : null },
      };
      // The same id on a launch that failed before its computer's brain took
      // it is a retry, and the server may make it a new computer: it passes
      // the same gates as a first start, now (the person may have changed
      // what agents may do since). Any other repeat only reads it.
      const replaces = existing?.launch.phase === "failed" && existing.launch.cloud?.handedOff !== true;
      if (existing) {
        if (approval.by === "agent" && existing.madeByChat !== chatSessionId) {
          throw new CloudDeclined("This ADE Cloud lane was started from another chat, so only that chat or you can follow it here.");
        }
        // Already approved and counted when it started.
        if (!replaces) return (await host.start(startArgs)).status;
      }
      // A retry is checked as the launch it starts again: its saved size and
      // kind, its saved first message. Its failed computer is deleted before
      // the replacement is made, so the server checks the disk after that;
      // the hours are checked here.
      const saved = replaces ? existing!.launch : null;
      const savedSize = saved?.cloud?.sizeId;
      const startSize = isCloudTierId(savedSize) ? savedSize : sizeId;
      const startChoice = saved ? saved.cloud?.sizeChoice ?? "picked" : launch.cloud!.sizeChoice!;
      // The one step a default Small may take, said before the yes (it may also start there, for a repository that needed it).
      const mayMoveUp = startChoice === "default" && startSize === CLOUD_AUTO_SIZE.from;
      const startsLaneOnly = saved ? saved.kind === "lane" : laneOnly;
      // Refused before the question, never after a yes: the launch itself,
      // then the account (hours, computers, disk), with the sentences
      // `cloud.status` and the composer show.
      const problem = saved ? null : cloudLaneLaunchStartRefusal({ args: launch, originUrl: startArgs.originUrl })?.message ?? null;
      if (problem) throw new AdeExpectedError(problem, "user");
      const account = saved ? await retryCheck(startSize) : await newComputerCheck(startSize);
      await outsideAgentCheck(approval, account);
      const catalog = cloudCatalogOf(account);
      const tier = cloudTier(catalog, startSize);
      if (!tier) throw new Error("ADE Cloud doesn't offer that size right now. Pick another one.");
      const kind: CloudMachineKind = tier.type === "vm" ? "vm" : "box";
      const shape = cloudShapeFor({ cpu: tier.cpu, memoryGb: tier.memoryGb });
      // The size a default Small may move to, in the catalog's own words (Medium uses hours, Small none).
      const moveUpTier = mayMoveUp ? cloudTier(catalog, CLOUD_AUTO_SIZE.to) : null;
      const moveUpRate = moveUpTier ? cloudTierRateLabel(moveUpTier).toLowerCase() : null;
      const yes = await approve(approval, {
        action: "spend",
        title: "Start a lane on ADE Cloud",
        body: `ADE makes a new ${tier.label} computer (${tier.cpu} CPU, ${tier.memoryGb} GB) for this lane alone, gets the repository there and ${startsLaneOnly ? "sets up the lane" : "starts the chat on it"}.${shape ? ` ${describeCloudHoursUse(kind, shape.id, catalog)}` : ""}${mayMoveUp ? ` If this repository's setup needs more than ${CLOUD_AUTO_SIZE.fromMemoryGb} GB, ADE uses ${moveUpTier?.label ?? CLOUD_AUTO_SIZE.toLabel}${moveUpRate ? ` (it ${moveUpRate})` : ""} instead and remembers that.` : ""}`,
        confirm: "Start it",
        newMachine: true,
        shape: shape?.id ?? null,
        personPlace: CLOUD_LANE_PERSON_PLACE,
        // A Small lane never uses hours: an unattended agent may start one at 0 hours (Pricing v2).
        ...(tier.multiplierMilli === 0 && !mayMoveUp ? { usesHours: false as const } : {}),
      });
      // An agent nobody watches stays within the agent limits as they are now: a default Small
      // moves up only when they allow Medium. A retry too (they may have been lowered since the
      // first start): its saved launch and the request the server keeps say "capped" then.
      if (mayMoveUp && yes.unattended) {
        const limits = await deps.limits.read().catch(() => CLOUD_DEFAULT_AGENT_LIMITS);
        if (!cloudShapeWithin(MEDIUM_SHAPE, limits.maxShape)) startArgs.args = { ...launch, cloud: { sizeId: startSize, sizeChoice: "capped" } };
      }
      try {
        const started = await host.start({ ...startArgs, madeByAgent: yes.maker });
        // A retry counts once it is on its way again, as a first start counts once made.
        if (started.created || (replaces && started.status.launch.phase !== "failed")) yes.counted();
        // The server refused an outside agent (`outside_agent_free_plan`) already: its sentence is the tool's error, word for word.
        const refused = started.status.launch.cloud?.refusal;
        if (approval.by === "agent" && approval.viaAdeMcp && refused?.code === CLOUD_OUTSIDE_AGENT_FREE_CODE) {
          throw new CloudDeclined(started.status.launch.error ?? CLOUD_OUTSIDE_AGENT_FREE_MESSAGE);
        }
        return started.status;
      } finally {
        yes.release();
      }
    },

    /**
     * An agent asks the person for a tier change (Android on a Small computer
     * needs Large): a card in its chat with the size, the rate and its
     * reason. It changes nothing: the person confirms on the card, and the
     * app's main process runs the change. An agent never changes a tier
     * itself, attended or not.
     */
    async tier_request(rawArgs?: unknown) {
      const args = record(rawArgs);
      const approval = readApproval(args);
      if (approval.by === "person") throw new Error("Change the size directly: Settings › ADE Cloud, or ade cloud resize.");
      const chatSessionId = approval.chatSessionId;
      if (!chatSessionId || !deps.approvals?.postCard) {
        throw new Error("ADE has no chat to show this request in. Ask the person to change the size in Settings › ADE Cloud.");
      }
      const sizeId = text(args, "size")?.toLowerCase() ?? null;
      if (!isCloudTierId(sizeId)) throw new Error(`Pick a size: ${CLOUD_TIER_IDS.join(", ")}.`);
      const reason = text(args, "reason");
      if (!reason) throw new Error("Say why the lane needs it (--reason).");
      // On a cloud computer the agent asks for its own computer by default.
      const selector = text(args, "machine") ?? process.env.ADE_CLOUD_INSTANCE_ID?.trim() ?? null;
      const { box, all } = await resolveMachine(selector);
      const catalog = cloudCatalogOf(all.account);
      const tiers = cloudTiers(catalog);
      const to = cloudTier(catalog, sizeId);
      if (!to) throw new Error("ADE Cloud doesn't offer that size now.");
      const from = cloudTierOfMachine(box, tiers);
      if (from?.id === to.id) throw new Error(`It's already ${to.label}.`);
      const requestId = randomUUID();
      const computerName = (box as CloudLaneMachine).lane?.laneName ?? box.name ?? box.instanceId;
      const card = buildCloudTierRequestCard(
        { requestId, instanceId: box.instanceId, computerName, fromSizeId: from?.id ?? null, toSizeId: to.id, reason: clipReason(reason), chatSessionId },
        { from: from?.label ?? null, to: to.label, rate: cloudTierRateLabel(to) },
      );
      await deps.approvals.postCard(chatSessionId, card);
      logger.info?.("cloud.tier_requested", { instanceId: box.instanceId, toSizeId: to.id, fromSizeId: from?.id ?? null });
      return {
        requested: true,
        requestId,
        message: `Asked the person in this chat to change ${computerName} to ${to.label}. Nothing changes until they confirm; keep working or end your turn.`,
      };
    },

    /**
     * Clears a lane computer's caches. It runs on that computer's own brain
     * (the dashboard pins the lane's machine), so a call that names any other
     * machine is refused, never run here. The person's dashboard confirms
     * first; an agent in a chat asks the person with a card; nobody watching
     * (a full-auto chat, an automation, an ADE MCP app) means no.
     */
    async clear_caches(rawArgs?: unknown): Promise<{ freedGb: number }> {
      const args = record(rawArgs);
      const self = process.env.ADE_CLOUD_INSTANCE_ID?.trim() ?? "";
      // An agent on the computer may leave it out: this is the only computer it can mean.
      const machine = text(args, "machine") ?? self;
      if (!self) throw new Error("Clear caches runs only on an ADE Cloud computer. Open it from the lane's row in Settings › ADE Cloud.");
      if (machine !== self) throw new Error("That request reached another computer. Nothing was cleared.");
      try {
        await approve(readApproval(args), {
          action: "person_only",
          title: "Clear caches on this computer",
          body: "ADE deletes package and build caches here and measures the disk again. Repositories, dependencies, images and emulators stay. Builds may be slower until the caches fill again.",
          confirm: "Clear caches",
          personPlace: "Clear them from the lane's row in Settings › ADE Cloud.",
        });
      } catch (error) {
        captureCloudLaneAnalytics(deps.analytics, "api", "cloud_clear_caches", "denied");
        throw error;
      }
      const { clearCloudDiskCaches, cloudDiskReporter } = await import("./cloudDiskUsage");
      const result = await clearCloudDiskCaches().catch((error: unknown) => {
        captureCloudLaneAnalytics(deps.analytics, "api", "cloud_clear_caches", "failed");
        throw error;
      });
      captureCloudLaneAnalytics(deps.analytics, "api", "cloud_clear_caches", "completed");
      logger.info?.("cloud.caches_cleared", { instanceId: self, freedGb: result.freedGb });
      // The dashboard shows the new numbers at once: measure and send now.
      await cloudDiskReporter()?.reportNow().catch((error: unknown) => {
        logger.warn?.("cloud.disk_measure_failed", { error: getErrorMessage(error) });
      });
      return result;
    },

    /**
     * Grows the disk of the ADE Cloud computer this runs on, to fit
     * `needFreeGb` more free space or to `toGb` (`ade cloud resize --free`).
     * Up to the size's disk maximum it grows with no card, for unattended
     * chats too (Pricing v2: no plan disk; the extra-disk path below is kept
     * for a server that still answers with one). A grow restarts
     * the computer: the call waits for that, and ADE continues the chat after
     * it with a note that the disk grew.
     */
    async grow_disk(rawArgs?: unknown): Promise<CloudDiskGrowAnswer> {
      const args = record(rawArgs);
      const self = process.env.ADE_CLOUD_INSTANCE_ID?.trim() ?? "";
      const host = deps.diskGrow?.() ?? null;
      if (!self || !host) {
        throw new AdeExpectedError("ade cloud resize --free grows the disk of the ADE Cloud computer it runs on, and this isn't one. A lane computer's disk grows from its row in Settings › ADE Cloud.", "user");
      }
      const machine = text(args, "machine");
      if (machine && machine !== self) throw new AdeExpectedError("A disk grows only from the computer it belongs to. Run this on that computer, or grow it from its row in Settings › ADE Cloud.", "user");
      const reason = text(args, "reason");
      if (!reason) throw new AdeExpectedError("Say why it needs the room (--reason).", "user");
      const gbArg = (key: string): number | null => {
        const raw = args[key];
        if (raw == null || raw === "") return null;
        const value = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isFinite(value) || value <= 0 || value > GROW_DISK_MAX_GB) throw new AdeExpectedError(`${key} is a number of GB above 0, up to ${GROW_DISK_MAX_GB}.`, "user");
        return value;
      };
      const needFreeGb = gbArg("needFreeGb");
      const toGb = gbArg("toGb");
      if ((needFreeGb == null) === (toGb == null)) throw new AdeExpectedError("Pass how much must be free (--free <GB>) or the disk's new size (--disk <GB>), not both.", "user");
      const approval = readApproval(args);
      const chatSessionId = approval.by === "agent" ? approval.chatSessionId : null;
      if (chatSessionId && deps.approvals?.permissionLevel(chatSessionId) === "plan") {
        deps.approvals.notice(chatSessionId, "ADE said no to growing this computer's disk for this chat: plan mode changes nothing.");
        throw new CloudDeclined("Grow the disk: declined, because this chat is in plan mode.");
      }
      const answer = await host.growToFit({
        needFreeBytes: needFreeGb != null ? Math.ceil(needFreeGb * 1024 ** 3) : null,
        toGb: toGb != null ? Math.ceil(toGb) : null,
        reason: clipReason(reason),
        origin: "agent",
        chat: chatSessionId ? { chatSessionId, projectRoot: deps.projectRoot ?? null } : null,
        // Paid extra disk, like hours: a watched chat asks the person on a card; with nobody
        // watching (full-auto, an automation, ADE MCP) the agent limits answer, and past
        // them the grower answers `limit` with the computers that hold the disk.
        approveExtra: async (fit) => {
          try {
            const yes = await approve(approval, {
              action: "spend",
              title: `Grow this computer's disk to ${fit.toGb} GB with extra disk`,
              body: `${fit.sentence} Reason: ${clipReason(reason)}`,
              confirm: "Grow it",
              personPlace: "Grow it from the lane's row in Settings › ADE Cloud.",
              unattendedRule: (limits) => cloudAgentExtraDiskRefusal(limits, fit),
              usesHours: false,
              cost: `It uses paid extra disk: your computers are then ${fit.pastGb} GB past your plan, about ${formatCloudCents(fit.monthCents)} a month.`,
            });
            return yes.limitRefusal ? { reason: "agent_limit", sentence: yes.limitRefusal } : true;
          } catch (error) {
            if (error instanceof CloudDeclined) return false;
            throw error;
          }
        },
      });
      logger.info?.("cloud.disk_grow_asked", { state: answer.state, by: approval.by });
      const outcome = answer.state === "grown" || answer.state === "growing" ? "completed"
        : answer.state === "declined" ? "denied"
          : answer.state === "limit" ? (answer.reason === "agent_limit" ? "denied" : "rejected")
            : answer.state === "fits" ? null : "failed";
      if (outcome) captureCloudLaneAnalytics(deps.analytics, "api", "cloud_disk_grow", outcome);
      return answer;
    },

    /**
     * A launch's stages and state for anyone who may read ADE Cloud; its
     * approval link, starting chat and computer only for a person or the
     * caller that started it (the same chat, the automation run's own
     * chatless start, or an outside app for a launch an outside app started).
     */
    async lane_launch_status(rawArgs?: unknown): Promise<CloudLaneLaunchStatus | null> {
      const args = record(rawArgs);
      const launchId = text(args, "launchId");
      if (!launchId) throw new Error("Pass the launch id.");
      const status = (await deps.laneLaunch?.()?.status(launchId.toLowerCase())) ?? null;
      if (!status) return null;
      const approval = readApproval(args);
      const starter = approval.by === "person"
        || (approval.chatSessionId != null && approval.chatSessionId === status.madeByChat)
        || (approval.automation === true && approval.chatSessionId == null && status.madeByChat == null)
        // An outside app has no chat: the person reads the approval link there.
        || (approval.viaAdeMcp === true && status.madeByAgent === "mcp");
      if (starter) return status;
      return {
        launch: status.launch,
        machine: { name: status.machine.name, instanceId: null, machineKey: null },
        approvalUrl: null,
        madeByChat: null,
        madeByAgent: null,
      };
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
        ? await deps.machines.instanceMetadata(box.instanceId).catch((error: unknown) => {
            // Unknown is "not this chat's": an unattended delete is then declined.
            logger.warn?.("cloud.instance_metadata_read_failed", { instanceId: box.instanceId, error: getErrorMessage(error) });
            return null;
          })
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

    /**
     * The account's invite link and what it earned (`ade cloud invite`):
     * friends joined, rewards paid and left, hours earned, whether a code can
     * still be entered. No code or link is ever logged.
     */
    async referral(): Promise<CloudReferralSummary> {
      const summary = await deps.machines.referral();
      if (!summary) throw new Error("ADE Cloud isn't available on this account yet.");
      return summary;
    },

    /**
     * Enters someone's invite for this account (a pasted link or the bare
     * code). Once, ever: an account's referrer never changes. The person's
     * call only (`ADE_ACTION_USER_ONLY`): the phone's `cloud.write` reaches it;
     * an agent, an ADE MCP app and a terminal are refused before this runs.
     * Answers the outcome; a refusal is `{ ok: false, reason, message }`, not a throw.
     */
    async invite_redeem(rawArgs?: unknown): Promise<CloudInviteRedeemOutcome> {
      const code = text(record(rawArgs), "code");
      if (!code) throw new Error("Pass the invite link or its 8-character code.");
      return await deps.machines.redeemInvite(code);
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
      // Null is "up to the account's own extra-disk limit"; left out keeps it as it is.
      if ("extraDiskMonthCents" in args) {
        const raw = args.extraDiskMonthCents;
        const cents = cloudAgentExtraDiskCentsOf(raw);
        if (raw != null && cents == null) throw new Error("Extra disk for agents is a whole number of cents a month from 0 to 100000, or null for your extra-disk limit.");
        next.extraDiskMonthCents = cents;
      }
      const was = current;
      const looser = (next.unattendedSpend && !was.unattendedSpend)
        || next.machinesPerDay > was.machinesPerDay
        || !cloudShapeWithin(next.maxShape, was.maxShape)
        || cloudAgentExtraDiskLooser(next.extraDiskMonthCents, was.extraDiskMonthCents);
      if (looser) {
        const max = cloudShapeById(next.maxShape);
        await approve(readApproval(args), {
          action: "person_only",
          title: "Let agents use more on ADE Cloud",
          body: `Unattended agents could then ${next.unattendedSpend ? `start ${next.machinesPerDay} new computer${next.machinesPerDay === 1 ? "" : "s"} a day, up to ${max.label}` : "use nothing"}.`,
          confirm: "Allow it",
        });
      }
      // Only the changed fields go to the account server (it keeps the rest, and refuses a change made in between).
      // Signed out or an older server: the whole value, as before.
      return (await deps.limits.save?.(cloudAgentLimitsChanges(current, next))) ?? await deps.limits.write(next);
    },
  };
  return actions;
}
