import { authenticate } from "../callerToken";
import { liveUsedWithPhones } from "./credits";
import { handleCloudWakeRequest, isCloudWakeRequest } from "../cloudWake";
import { readBoundedJson } from "../sinkUtils";
import { captureCloudAction, cloudActionTracker, type CloudActionOrigin, type CloudRefusal, type CloudRefusedAction, type CloudWaitUntil } from "./analytics";
import { CloudBillingError, accountReturnUrl, createCheckoutUrl, createFreeUnlockUrl, createPortalUrl, pickPlanCleanup, setExtraHours, webReturnUrl, type BillingReturnUrlFor } from "./billing";
import { parseSustainedCpuReport, recordSustainedCpu } from "./abuseSignals";
import { buildAccountState } from "./accountState";
import { deleteSavedChatsForLaneEverywhere, routeSavedChats } from "./chats";
import { readComputerSignal, settleFreePlanComputer } from "./freePlan";
import { settleFreePlanGithub } from "./freePlanGithub";
import { routeReferrals } from "./referrals";
import { routeSponsored } from "./gravity";
import { noteComputerNetwork, rateMilliFor, smallUsesNoHours } from "./sponsoredSmall";
import { requestNetwork } from "./sponsoredConsent";
import { trustedHttpsOrigin } from "../trustedOrigin";
import { handleLaunchJoin, isLaunchJoinRequest, launchAutoSizeCheck, rememberLaunchSetupDisk, routeLaunches, startServerLaunch, type LaunchRouteDeps } from "./launches";
import { createAnswerOf, createInProgress, type CreateComputerExtras, type CreateComputerOutcome, type ReplayOutcome } from "./createOutcome";
import { handleMoveStart, routeMoves, type MoveRouteDeps } from "./moves";
import { handleFreeStart, routeFrees } from "./frees";
import { handleCopyStart, routeCopies, type CopyRouteDeps } from "./copies";
import { serverGitCheck } from "./accountVault";
import { routeAccountSignIns } from "./accountSignIns";
import { routeAccountSecrets } from "./accountSecrets";
import { routeCtoCopy } from "./ctoCopy";
import { handleDeletedAccountsList, isDeletedAccountsListRequest } from "../accountErasure";
import { handleInternalEventWake, isInternalEventWakeRequest, routeEventWakeSubscription, type EventWakeOutcome } from "./eventWakes";
import { routeJiraIssue, routeJiraSearch, routeLinearQuery } from "./integrations";
import { routeCloudLimits } from "./limits";
import { carryLaunchMessagesForComputer, routeChatMessages, routeComputerMessages, type ChatWake } from "./chatMessages";
import { routeSessionCopies } from "./sessionCopies";
import { routeGitSummaries } from "./gitSummaries";
import { routeForkCapsules } from "./forkCapsules";
import { handleProjectOverview } from "./projectOverview";
import { handleCloudModels } from "./models";
import { handleAutomationDelivery, isAutomationDeliveryRequest, noteAutomationLaunchProgress, routeAutomations } from "./automations";
import { routeProjectComputersDelete } from "./projectComputers";
import { routeSignIns } from "./signIns";
import {
  endLaneStatement,
  laneFactsOf,
  laneFactsOfRow,
  laneFactsStatement,
  markKeepLaneStatement,
  mergeLaneFacts,
  namesLane,
  routeLanesWithoutComputer,
  unmarkKeepLaneStatement,
  type CloudLaneFacts,
} from "./lanesWithoutComputer";
import { parseDiskUsageReport, recordDiskUsage, withUseFacts } from "./diskUsage";
import { handleAgent37Webhook, isAgent37WebhookRequest, parseActivityReport, readComputerStatus, recordActivity } from "./computerStatus";
import { ignoredFilesStatement, keepIdleComputer, parseIgnoredFiles, recordIdleUse } from "./idleCleanup";
import {
  CLOUD_BLOCKED_READ_ROUTES,
  CLOUD_COMPUTER_FEATURES,
  CLOUD_COMPUTER_COMMANDS,
  CLOUD_EDGE_PATHS,
  CLOUD_PATHS,
  CLOUD_COMPUTER_LIMIT_CODE,
  CLOUD_OUTSIDE_AGENT_FREE_CODE,
  CLOUD_OUTSIDE_AGENT_FREE_MESSAGE,
  CLOUD_PLAN_PAST_DUE_SENTENCE,
  cloudAutoSizeRefusalSentence,
  computerLimitSentence,
  overPlanLimitsMoveSentence,
  overPlanLimitsSentence,
  type CloudAccess,
  type CloudComputerLimitDetail,
  type CloudComputerLimitLane,
  type CloudDiskRefusalReason,
  type CloudInstance,
  type CloudPlanId,
  CLOUD_INSTANCE_ID,
} from "./contract";
import { commandWith, overPlanInForce, readPlanCleanupChoiceIds, readPlanCleanupPick, readResult, restingBackupState, unfreezeComputer } from "./planCleanup";
import { deleteBackupsForLane, deleteBackupsWithComputer, markRestedWithBackups, routeLaneBackups } from "./laneBackups";
import { prepareStopBackupReportId } from "./cron";
import { freeCapRefuses } from "./costReport";
import { ACCOUNT_BLOCKED_MESSAGE, accountBlocked, isCloudBlocked, isCloudBlockedForRequest, newWorkRefusal } from "./blocks";
import { enforcePhoneAllowance, handleNomacWebhook, handlePhoneViewer, isNomacWebhookRequest, isPhoneViewerRequest, routePhone } from "./phones";
import { enforceBlockAfterCreate, handleCloudOwnerRequest, isCloudOwnerRequest } from "./safety";
import { INSTANCE_LIST_TTL_S, listInstancesCached } from "./instanceListCache";
import { boundedDisplayText } from "../displayText";
import { ROW_ID, UNREADABLE_REQUEST_MESSAGE, badRequest, fail, json, readJson, tooManyRequests } from "./http";
import {
  AWAKE_COMPUTER_CAP,
  CLOUD_PLANS,
  DISK_STEP_GB,
  SMALL_NO_CARDS_RATE_MILLI,
  WAKE_PORT,
  cloudSizeFor,
  isMeteredStatus,
  isPaidPlanId,
  nextPlanOffer,
  setupStartDiskGb,
  tierOf,
  type CloudSize,
} from "./plans";
import { CloudProviderError, cloudErrorMessage, createCloudProvider, type CloudProvider } from "./provider";
import {
  accountComputerCount,
  accountComputerCountSql,
  cloudOffers,
  computerLimitOf,
  computerLimitPlanOf,
  diskDayStatement,
  hasNoFreePlan,
  limitsPlanIdOf,
  planIdOf,
  logCloud,
  nameMachineAfterComputerStatement,
  reportCloudFailure,
  PENDING_TIMEOUT_MS,
  AWAKE_CAP_COUNT_SQL,
  adoptionStatements,
  ComputerCloseError,
  deleteComputer,
  goneFromProviderStatements,
  isOutOfHoursFor,
  isPendingId,
  listComputers,
  liveUsedMilli,
  loadAccount,
  newPendingId,
  ownedComputer,
  powerLogStatement,
  readSetting,
  restartStretchStatements,
  settleStatements,
  statusChangeStatements,
  statusGuard,
  SAVED_DELETE_CLAIM_STALE_MS,
  takeFromDeletes,
  takeRequest,
  type AccountRow,
  type CloudEnv,
  type CloudRequestBucket,
  type ComputerRow,
} from "./store";
import {
  CloudUpdateInProgressError,
  automaticTemplate,
  channelOfComputer,
  channelTemplate,
  isBehindAutomatic,
  readUpdateChannel,
  readUpdateTargets,
  recordBootReport,
  startCloudUpdate,
  updateCheckOf,
  withUpdateFacts,
} from "./updates";

/**
 * The ADE Cloud routes (README, "ADE Cloud account"; shapes in `contract.ts`).
 * Each mirrors one `CloudProvider` method: the owner check, the limits and the
 * pinned template are enforced here so a client can't talk around them.
 */

const PREFIX = "/cloud";
const MAX_METADATA_ENTRIES = 32;
const MAX_ENV_ENTRIES = 64;
/**
 * What a client may put in a new computer's env: only the ADE release it
 * installs on boot (`ADE_MIN_VERSION`, infra/ade-cloud/template/ade-entrypoint.sh),
 * as a version. Everything else is dropped: older desktops sent the person's
 * saved ADE Cloud keys and Claude token here (`OPENAI_API_KEY`,
 * `CLAUDE_CODE_OAUTH_TOKEN`, …), and the host keeps a computer's env in plain
 * text for its whole life. A new computer's brain takes every sign-in from the
 * account vault instead (Cloud 4 step 2b).
 */
const CLIENT_ENV = { ADE_MIN_VERSION: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/ } as const satisfies Record<string, RegExp>;
const MAX_STRING = 4096;
const MAX_COMMAND = 100_000;
const MAX_EXEC_TIMEOUT_MS = 15 * 60_000;

const NOT_FOUND_MESSAGE = "ADE Cloud has no such computer.";
const notFound = () => fail("not_found", NOT_FOUND_MESSAGE, 404);
/**
 * At 0 hours only the sizes that use hours are refused, so the sentence says
 * Small keeps working; an account with no free plan (`hasNoFreePlan`), or
 * whose Small uses hours (`smallUsesNoHours`), hears the plain sentence.
 */
const outOfHours = (account?: Pick<AccountRow, "plan" | "free_refused_at" | "free_github_hold">, smallFree = true) => fail(
  "out_of_hours",
  account && smallFree && !hasNoFreePlan(account)
    ? "You're out of ADE Cloud credits for this period. Small computers don't use credits, so they keep working."
    : "You're out of ADE Cloud credits for this period.",
  402,
);
const badDiskStep = () => badRequest(`Disk grows in steps of ${DISK_STEP_GB} GB.`);
const noProviderKey = () => fail("unavailable", cloudErrorMessage("no_provider_key", 503), 503);
/** Another change took the computer's disk while this one ran. */
const diskChanged = () => fail("disk_limit", "This computer's disk changed while this ran. Try again.", 409);

const CANT_MAKE_COMPUTER_MESSAGE = "ADE Cloud can't make a computer right now. Try again soon.";
/** A free account at the owner's free-use cap: nothing new, no disk growth. Never names why. */
const cantMakeComputer = () => fail("unavailable", CANT_MAKE_COMPUTER_MESSAGE, 503);
const cantGrowDisk = () => fail("disk_limit", "ADE Cloud can't grow this disk right now. Try again later.", 403, { reason: "unavailable" satisfies CloudDiskRefusalReason });

type Refused = { response: Response; refusal: CloudRefusal };

/** What every handler gets from the request: one clock, and a way to finish work after the response. */
type CloudRequestContext = { now: number; waitUntil: CloudWaitUntil };

function diskRefusal(code: string, message: string, reason: CloudDiskRefusalReason, refusal: CloudRefusal): Refused {
  return { response: fail(code, message, 403, { reason }), refusal };
}

/*
 * ---- The computer limit (Pricing v2) ----
 *
 * Each plan has a number of cloud computers, asleep or not
 * (`CLOUD_PLANS[].computerLimit`, `computerLimitOf`). A create, a copy and a
 * new lane's launch past it are refused with 403 `computer_limit`; the
 * error carries `CloudComputerLimitDetail` beside `code` and `message`, flat
 * on `error`, for the limit card. The count is part of the reservation's one
 * conditional insert (`reserveComputer`), so two creates at once can't both
 * take the last slot. A move replaces its computer, so its count leaves its
 * own source out: a move from an account at or under its limit passes. Other
 * moves still running count as two (their sources may outlive them), so two
 * moves at once from an account at its limit can't both pass, and an account
 * already over its limit is refused a move like a create.
 */

/** The account's made computers, least recently used first, for the limit card. Empty when they can't be read. */
async function computerLimitLanes(env: CloudEnv, userId: string): Promise<CloudComputerLimitLane[]> {
  try {
    const rows = await env.DB.prepare(`
      select instance_id, coalesce(lane_name, name, instance_id) as label, status, last_awake_at, (lane_id is not null and lane_name is not null) as has_lane from cloud_computers
      where user_id = ? and deleted_at is null and instance_id not like 'pending:%'
      order by coalesce(last_awake_at, created_at), instance_id limit 30
    `).bind(userId).all<{ instance_id: string; label: string; status: string; last_awake_at: number | null; has_lane: number }>();
    return (rows.results ?? []).map((row) => ({ instanceId: row.instance_id, laneName: row.label, awake: isMeteredStatus(row.status), lastAwakeAt: row.last_awake_at, hasLane: row.has_lane === 1 }));
  } catch (error) {
    logCloud("cloud.computer_limit_lanes_failed", { userId, error: error instanceof Error ? error.message : "unknown" });
    return [];
  }
}

/** The refusal at the computer limit, with what the card shows. */
async function computerLimitRefusal(env: CloudEnv, account: AccountRow, now: number): Promise<Refused> {
  const planId = computerLimitPlanOf(account);
  const detail: CloudComputerLimitDetail = {
    planId,
    limit: computerLimitOf(account),
    total: await accountComputerCount(env, account.user_id, now),
    lanes: await computerLimitLanes(env, account.user_id),
    nextPlan: nextPlanOffer(planId, cloudOffers(env)),
  };
  logCloud("cloud.computer_limit_reached", { userId: account.user_id, plan: planId, limit: detail.limit, total: detail.total });
  return { response: fail(CLOUD_COMPUTER_LIMIT_CODE, computerLimitSentence(detail), 403, detail), refusal: "computer_limit" };
}

/**
 * A copy's, a server copy's or a server move's early answer at the limit (the
 * reservation checks again in the same write as the insert). `moveFrom` is a
 * move's source, left out of its count.
 */
async function computerLimitCheck(env: CloudEnv, account: AccountRow, now: number, moveFrom: string | null = null): Promise<Refused | null> {
  return await accountComputerCount(env, account.user_id, now, moveFrom) >= computerLimitOf(account) ? computerLimitRefusal(env, account, now) : null;
}

/*
 * ---- Outside agents (Pricing v2) ----
 *
 * An outside agent (an app connected through ADE MCP) may start ADE Cloud
 * work only on a paid plan (`CloudPlanFacts.outsideAgents`). It marks itself
 * `ade_made_by_agent: "mcp"` on a create or copy, `madeBy.agent: "mcp"` on a
 * launch (which reaches `createComputer` with that metadata), and `origin:
 * "mcp"` on a start, a resize, a server copy and a sent message. Reads stay allowed.
 */
const isOutsideAgentMetadata = (metadata: Record<string, string>): boolean => metadata.ade_made_by_agent === "mcp";

/** 403 `outside_agent_free_plan` with the sentence the agent passes on, on free-plan rules (`past_due` included); else null. */
function outsideAgentRefusal(account: AccountRow, outsideAgent: boolean): Refused | null {
  if (!outsideAgent || CLOUD_PLANS[limitsPlanIdOf(account)].outsideAgents) return null;
  return { response: fail(CLOUD_OUTSIDE_AGENT_FREE_CODE, CLOUD_OUTSIDE_AGENT_FREE_MESSAGE, 403), refusal: "outside_agent_free" };
}

/*
 * ---- The awake cap ----
 *
 * No plan limits how many computers an account has. One safety cap holds how
 * many are awake (or being made) at once, `AWAKE_COMPUTER_CAP`: no real
 * person should reach it, and it is never shown as a plan limit. A wake at
 * the cap waits a few seconds for one to fall asleep, so a send while lanes
 * wake and sleep doesn't fail at random; a create is refused at once. Each
 * time the cap is hit it is logged and reported, so the owner sees it.
 */
const AWAKE_CAP_WAIT_MS = 12_000;
const AWAKE_CAP_POLL_MS = 3_000;
const TOO_MANY_AWAKE_MESSAGE = "Too many of your computers are awake at once. Put one you aren't using to sleep, then try again.";
const tooManyAwake = (): Refused => ({ response: fail("too_many_awake", TOO_MANY_AWAKE_MESSAGE, 429), refusal: "awake_cap" });

/** How many of the account's computers count toward the cap now, `except` left out (the one about to wake). */
async function awakeCount(env: CloudEnv, userId: string, now: number, except = ""): Promise<number> {
  const row = await env.DB.prepare(`select count(*) as n from cloud_computers where user_id = ? and deleted_at is null and instance_id <> ? and ${AWAKE_CAP_COUNT_SQL}`)
    .bind(userId, except, now - PENDING_TIMEOUT_MS).first<{ n: number }>();
  return row?.n ?? 0;
}

function reportAwakeCap(userId: string, action: "wake" | "create", awake: number): void {
  reportCloudFailure("cloud.awake_cap_reached", { userId, action, awake, cap: AWAKE_COMPUTER_CAP });
}

/**
 * Null when `computer` may wake: it is awake already, or the account has room
 * under the cap, now or within `waitMs` (re-read every few seconds, as
 * computers fall asleep). Else the refusal.
 */
async function awakeRoom(env: CloudEnv, computer: ComputerRow, now: number, waitMs = 0): Promise<Refused | null> {
  if (isMeteredStatus(computer.status)) return null;
  const started = Date.now();
  for (;;) {
    const awake = await awakeCount(env, computer.user_id, now, computer.instance_id);
    if (awake < AWAKE_COMPUTER_CAP) {
      if (Date.now() > started) logCloud("cloud.awake_cap_waited", { userId: computer.user_id, waitedMs: Date.now() - started });
      return null;
    }
    if (Date.now() - started + AWAKE_CAP_POLL_MS > waitMs) {
      reportAwakeCap(computer.user_id, "wake", awake);
      return tooManyAwake();
    }
    await new Promise((resolve) => setTimeout(resolve, AWAKE_CAP_POLL_MS));
  }
}

const COMPUTER_DELETING_MESSAGE = "ADE Cloud is deleting this computer because it went unused. Its work was saved to its branch on GitHub, and its lane stays: your next message to the lane makes a new computer.";
/** The delete of a lane's move from its saved copy (`claimSavedDelete`): no idle cleanup holds the computer. */
const COMPUTER_MOVING_MESSAGE = "ADE Cloud is moving this lane to another machine from its saved copy, and deletes this computer. Open the lane on its new machine.";

/**
 * Marks real use for the idle cleanup before the person's request runs
 * (`recordIdleUse`). A response when the request must not run: the cleanup
 * already claimed the delete, or the use couldn't be recorded while its save
 * holds the computer (the save would delete it without seeing this use).
 */
async function idleUseRefusal(env: CloudEnv, computer: ComputerRow, now: number): Promise<Response | null> {
  const use = await recordIdleUse(env, computer, now);
  const deleting = () => fail("computer_deleting", computer.idle_claimed_at == null ? COMPUTER_MOVING_MESSAGE : COMPUTER_DELETING_MESSAGE, 409);
  if (use === "deleting") return deleting();
  if (use === "unrecorded") return fail("unavailable", "ADE Cloud couldn't record that you're using this computer, so it didn't run that. Try again in a moment.", 503);
  // A resting computer this request wakes: taken from any delete in the same write that checks for one.
  if (!isMeteredStatus(computer.status) && !await takeFromDeletes(env, computer.instance_id, now)) return deleting();
  return null;
}

/** A disk past what this size's disk can grow to. `moving` is a computer whose disk is already that big. */
function tierRefusal(size: CloudSize, diskGb: number, moving: boolean): Refused | null {
  if (diskGb <= size.diskMaxGb) return null;
  const message = moving
    ? `This computer's disk is ${diskGb} GB, more than a ${size.label} computer holds (${size.diskMaxGb} GB). Pick a bigger size.`
    : `A ${size.label} computer's disk grows to ${size.diskMaxGb} GB. A bigger size holds more.`;
  return diskRefusal("disk_limit", message, "tier_limit", "tier_limit");
}

/**
 * Over the plan in force (a cheaper plan started with more computers than it
 * allows, and nobody picked what goes): a new computer is refused until the
 * person cleans up or picks in ADE. Nothing is ever freed for it.
 */
function overPlanLimits(env: CloudEnv, account: AccountRow, computers: ComputerRow[], action: "create" | "move" = "create"): Refused | null {
  const over = overPlanInForce(env, account, computers);
  const sentence = action === "move" ? overPlanLimitsMoveSentence : overPlanLimitsSentence;
  return over ? { response: fail("over_plan_limits", sentence(over), 403), refusal: "over_plan_limits" } : null;
}

/** The plan to label an event with, for a route that didn't load the account. */
async function planIdFor(env: CloudEnv, userId: string): Promise<CloudPlanId> {
  const row = await env.DB.prepare("select plan, paid_plan, stripe_status from cloud_accounts where user_id = ?")
    .bind(userId).first<Pick<AccountRow, "plan" | "paid_plan" | "stripe_status">>();
  return row ? planIdOf(row) : "free";
}

/** An agent's create or copy carries the chat that asked, or the agent that made it; a person's doesn't. */
const originOf = (metadata: Record<string, string>): CloudActionOrigin => (metadata.ade_made_by_chat || metadata.ade_made_by_agent ? "agent" : "person");

export function isCloudRequest(url: URL): boolean {
  return url.pathname === PREFIX || url.pathname.startsWith(`${PREFIX}/`);
}

function stringMap(value: unknown, maxEntries: number): Record<string, string> | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > maxEntries) return null;
  const out: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (typeof entry !== "string" || key.length > 200 || entry.length > MAX_STRING) return null;
    out[key] = entry;
  }
  return out;
}

const shortText = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
};

/** A computer's name, as the dashboard, the machine list and the provider show it: control and format characters out (`boundedDisplayText`). */
const computerName = (value: unknown): string | null => boundedDisplayText(value, 60);

function providerFor(env: CloudEnv): CloudProvider | null {
  const key = env.AGENT37_API_KEY?.trim();
  return key ? createCloudProvider(key) : null;
}

/** Runs a provider call; its failure becomes the plain sentence the client shows. */
async function providerCall(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CloudProviderError) {
      // The provider refusing ADE's own key is ours to fix, not the person's sign-in.
      const providerAuth = error.status === 401 || error.status === 403;
      if (providerAuth || error.status >= 500 || error.status === 0) reportCloudFailure("cloud.provider_call_failed", { code: error.code, status: error.status });
      const status = !providerAuth && error.status >= 400 && error.status < 600 ? error.status : 502;
      return fail(error.code, error.message, status);
    }
    throw error;
  }
}

/**
 * The account, its computers, and whether a computer at a rate may not run
 * for lack of hours (`isOutOfHoursFor`: Small never uses hours, except on an
 * account with no free plan).
 */
async function getAccountContext(env: CloudEnv, userId: string, now: number): Promise<{
  account: AccountRow;
  computers: ComputerRow[];
  outOfHoursFor: (multiplierMilli: number) => Refused | null;
  /** Small runs without hours for this account now (`smallUsesNoHours`). */
  smallFree: boolean;
}> {
  const account = await loadAccount(env, userId, now);
  const computers = await listComputers(env, userId);
  // A running credits phone's unbilled minutes are spent already: a computer can't use them too.
  const liveUsed = await liveUsedWithPhones(env, account, now);
  // A Small that uses hours on Free (no sponsored cards, `smallUsesNoHours`) stops at 0 like any other size.
  const smallFree = await smallUsesNoHours(env, account);
  return {
    account,
    computers,
    smallFree,
    outOfHoursFor: (multiplierMilli) => {
      const rate = multiplierMilli === 0 && !smallFree ? SMALL_NO_CARDS_RATE_MILLI : multiplierMilli;
      return isOutOfHoursFor(account, liveUsed, rate) ? { response: outOfHours(account, smallFree), refusal: "out_of_hours" } : null;
    },
  };
}

/**
 * Why `computer` may not wake now (0 hours on a size that uses them), or null.
 * `multiplierMilli` is the rate it wakes at: a resize's new size.
 */
async function wakeBlocker(
  env: CloudEnv,
  computer: Pick<ComputerRow, "user_id" | "multiplier_milli">,
  now: number,
  multiplierMilli = computer.multiplier_milli,
): Promise<{ blocked: Refused | null; account: AccountRow }> {
  const { account, outOfHoursFor } = await getAccountContext(env, computer.user_id, now);
  return { account, blocked: outOfHoursFor(multiplierMilli) };
}

/**
 * A start or wake of an existing computer reads the block fresh: the request
 * check's answer can be 30 s old (`isCloudBlockedForRequest`).
 */
async function blockedNow(env: CloudEnv, userId: string): Promise<Response | null> {
  return await isCloudBlocked(env, userId) ? accountBlocked() : null;
}

/** The instance actions that start, restart or wake the computer. */
const WAKING_ACTIONS: ReadonlySet<string> = new Set(["POST start", "POST update", "POST resize", "POST move", "POST free"]);

/** Writes the status from a provider answer, on change only. */
async function recordStatus(env: CloudEnv, computer: ComputerRow, status: string, now: number, reason: string): Promise<void> {
  const statements = statusChangeStatements(env, computer, status, now, reason);
  if (statements.length) await env.DB.batch(statements);
}

/**
 * One event wake (`eventWakes.ts`): the checks a person's wake makes, without
 * waiting at the awake cap. It is use like any other wake: its time bills
 * hours and it restarts the idle cleanup's clock.
 */
async function eventWakeComputer(env: CloudEnv, computer: ComputerRow, now: number): Promise<EventWakeOutcome> {
  const provider = providerFor(env);
  if (!provider) return "failed";
  if (await isCloudBlocked(env, computer.user_id)) return "refused:account_blocked";
  const { blocked } = await wakeBlocker(env, computer, now);
  if (blocked) return `refused:${blocked.refusal}`;
  if (await awakeRoom(env, computer, now)) return "refused:too_many_awake";
  // A delete holds it (an idle cleanup's, or a move from its saved copy): a wake now would put work after the save.
  if (!await takeFromDeletes(env, computer.instance_id, now)) return "refused:computer_deleting";
  const status = await provider.startInstance(computer.instance_id);
  await recordStatus(env, computer, status, now, "event_wake");
  return "woken";
}


async function markGone(env: CloudEnv, computer: ComputerRow, now: number): Promise<void> {
  await env.DB.batch(goneFromProviderStatements(env, computer, now));
}

/**
 * A reservation that makes the awake cap and the computer limit hold under
 * concurrent creates: the counts are in the same write as the insert, and the
 * reservation itself counts until it is made or `PENDING_TIMEOUT_MS` passes
 * (`accountComputerCountSql`). A move replaces its computer, so its count
 * leaves its own source out, while every other running move's source counts
 * (`accountComputerCountSql`'s `moveFrom`): a source still there after `MOVE_GRACE_MS` counts again
 * (the tick's `endMoves`), so two moves at once must not both take the last
 * slot. It records its source in `moving_from`, and the pair counts once in
 * the account's own count while the move runs.
 */
async function reserveComputer(env: CloudEnv, account: AccountRow, args: {
  size: CloudSize;
  diskGb: number;
  moveFromInstanceId: string | null;
  name: string | null;
  requestId: string;
  templateVersion: string | null;
  channel: "stable" | "beta";
  /** The lane the computer is for, kept on its row from the start. */
  lane: CloudLaneFacts;
  now: number;
}): Promise<{ ok: true; pendingId: string } | ({ ok: false } & Refused) | { ok: false; response: Response; refusal: null } | { ok: false; replay: true }> {
  const pendingId = newPendingId();
  const cutoff = args.now - PENDING_TIMEOUT_MS;
  const count = accountComputerCountSql("?", { moveFrom: args.moveFromInstanceId, cutoff });
  // Free's Small uses hours while the account shows no sponsored cards (`gravity.ts` `smallUsesNoHours`).
  const rate = args.size.tier === "small" ? rateMilliFor(args.size, await smallUsesNoHours(env, account)) : args.size.multiplierMilli;
  const result = await env.DB.prepare(`
    insert into cloud_computers (instance_id, user_id, request_id, type, cpu, memory_gb, disk_gb, multiplier_milli, template_version, name, status, status_changed_at, last_awake_at, created_at, moving_from, channel,
      lane_id, lane_name, lane_project_origin, lane_branch)
    select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?, ?, ?, ?
    where (select count(*) from cloud_computers where user_id = ? and deleted_at is null and ${AWAKE_CAP_COUNT_SQL}) < ?
      and ${count.sql} < ?
      and not exists (select 1 from cloud_computers where request_id = ? and user_id <> ?)
      and not exists (select 1 from cloud_computers where request_id = ? and user_id = ? and deleted_at is null)
      and not exists (select 1 from cloud_computers where deleted_at is null and moving_from is not null and (moving_from = ? or instance_id = ?))
  `).bind(
    pendingId, account.user_id, args.requestId, args.size.type, args.size.cpu, args.size.memoryGb, args.diskGb, rate,
    args.templateVersion, args.name, args.now, args.now, args.now, args.moveFromInstanceId, args.channel,
    args.lane.laneId, args.lane.laneName, args.lane.projectOrigin, args.lane.branch,
    account.user_id, cutoff, AWAKE_COMPUTER_CAP,
    account.user_id, ...count.binds, computerLimitOf(account),
    args.requestId, account.user_id,
    args.requestId, account.user_id,
    args.moveFromInstanceId, args.moveFromInstanceId,
  ).run();
  if (result.meta.changes === 1) return { ok: true, pendingId };
  // A twin request with this id got its row in first (D1 runs one write at a
  // time, so only one insert can pass the check): answer as a repeat.
  const ownTwin = await env.DB.prepare("select 1 as taken from cloud_computers where request_id = ? and user_id = ? and deleted_at is null limit 1")
    .bind(args.requestId, account.user_id).first<{ taken: number }>();
  if (ownTwin) return { ok: false, replay: true };
  // The tag finds a lost create in the shared provider list, so it can only ever be one account's.
  const tagTaken = await env.DB.prepare("select 1 as taken from cloud_computers where request_id = ? and user_id <> ? limit 1")
    .bind(args.requestId, account.user_id).first<{ taken: number }>();
  if (tagTaken) return { ok: false, response: badRequest("That request can't be used."), refusal: null };
  const awake = await awakeCount(env, account.user_id, args.now);
  if (awake >= AWAKE_COMPUTER_CAP) {
    reportAwakeCap(account.user_id, "create", awake);
    return { ok: false, ...tooManyAwake() };
  }
  if (await accountComputerCount(env, account.user_id, args.now, args.moveFromInstanceId) >= computerLimitOf(account)) {
    return { ok: false, ...await computerLimitRefusal(env, account, args.now) };
  }
  // What's left: the computer to move started another move meanwhile.
  return { ok: false, response: fail("computer_busy", "This computer is in the middle of a move. Try again when the move is done.", 409), refusal: null };
}

async function releasePending(env: CloudEnv, pendingId: string): Promise<void> {
  await env.DB.prepare("delete from cloud_computers where instance_id = ?").bind(pendingId).run();
}

/**
 * A create or copy that names a request id this account already used gets the
 * computer that request made, so a retried request (a lost answer, a client
 * that restarted mid-create) never makes a second one or holds a second slot.
 * Null when there is none to give, and a fresh create may go ahead:
 * - no live row: never used, or its computer was deleted or never made;
 * - its computer is gone from the provider (the row is closed here);
 * - its reservation is older than `PENDING_TIMEOUT_MS` and the provider has
 *   no computer with its tag (the row is released; the tick would drop it).
 * A reservation still inside that time with no computer yet is a create in
 * flight: 409 `create_in_progress`, and the client asks again in a moment.
 */
async function replayRequest(env: CloudEnv, provider: CloudProvider, userId: string, requestId: string, now: number): Promise<ReplayOutcome | null> {
  const row = await env.DB.prepare("select * from cloud_computers where user_id = ? and request_id = ? and deleted_at is null order by created_at desc limit 1")
    .bind(userId, requestId).first<ComputerRow>();
  if (!row) return null;
  if (!isPendingId(row.instance_id)) {
    try {
      const instance = await provider.getInstance(row.instance_id);
      // The first create may have died before its batch ended the lane's row: the lane has this computer.
      const ended = endLaneStatement(env, userId, row.lane_id ?? laneFactsOf(instance.metadata).laneId);
      const statements = [...statusChangeStatements(env, row, instance.status, now, "seen"), ...(ended ? [ended] : [])];
      if (statements.length) await env.DB.batch(statements);
      logCloud("cloud.create_replayed", { userId, instanceId: row.instance_id });
      return { kind: "replayed", instance };
    } catch (error) {
      if (!(error instanceof CloudProviderError && error.status === 404)) throw error;
      await markGone(env, row, now);
      return null;
    }
  }
  // The first answer was lost, or the provider is still making it: its tag finds it.
  const instance = (await provider.listInstances())
    .find((entry) => entry.metadata.ade_request_id === requestId && entry.status !== "deleted");
  if (instance) {
    const [adopted] = await env.DB.batch(adoptionStatements(env, { pendingId: row.instance_id, instance, machineKey: instance.metadata.ade_machine_key ?? null, now, reason: "create_replayed" }));
    if (adopted?.meta.changes === 1) {
      logCloud("cloud.create_replayed", { userId, instanceId: instance.id, adopted: true });
      return { kind: "replayed", instance };
    }
  }
  if (now - row.created_at > PENDING_TIMEOUT_MS) {
    await releasePending(env, row.instance_id);
    return null;
  }
  return { kind: "in_progress" };
}

/** Only a provider's clear no means nothing was made. Timeouts and 5xx can leave a running computer, so its reservation stays for adoption. */
const providerMadeNothing = (error: unknown): boolean =>
  error instanceof CloudProviderError && error.status >= 400 && error.status < 500;

const withRequestId = (metadata: Record<string, string>): { metadata: Record<string, string>; requestId: string } => {
  const requestId = metadata.ade_request_id || crypto.randomUUID();
  return { metadata: { ...metadata, ade_request_id: requestId }, requestId };
};

const onlyWakePorts = (ports: unknown): Array<{ port: number; label: string }> | null => {
  if (ports === undefined) return [];
  if (!Array.isArray(ports)) return null;
  const out: Array<{ port: number; label: string }> = [];
  for (const entry of ports) {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    if (record?.port !== WAKE_PORT) return null;
    out.push({ port: WAKE_PORT, label: shortText(record.label, 60) ?? "ADE wake" });
  }
  return out;
};

async function handleCreate(request: Request, env: CloudEnv, userId: string, provider: CloudProvider, ctx: CloudRequestContext): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  return createAnswerOf(await createComputer(env, userId, provider, { body }, ctx));
}

/**
 * `createComputer` for a run nobody's request started (an automation's
 * webhook delivery, a scheduled run): the GitHub rules of the free plan are
 * settled first, as a launch's request settles them, so the hours check reads
 * a settled hold.
 */
export async function createComputerSettled(env: CloudEnv, userId: string, provider: CloudProvider, extras: CreateComputerExtras, ctx: CloudRequestContext): Promise<CreateComputerOutcome> {
  await settleFreePlanGithub(env, await loadAccount(env, userId, ctx.now), ctx);
  return createComputer(env, userId, provider, extras, ctx);
}

/**
 * The one way a computer is made (`POST /cloud/instances` and the server
 * launcher): the same replay, limits, reservation, billing and metadata.
 * `createAnswerOf` turns the outcome into the route's answer.
 */
export async function createComputer(env: CloudEnv, userId: string, provider: CloudProvider, extras: CreateComputerExtras, { now, waitUntil }: CloudRequestContext): Promise<CreateComputerOutcome> {
  const refused = (response: Response): CreateComputerOutcome => ({ kind: "refused", response });
  const { body } = extras;
  const resources = body.resources && typeof body.resources === "object" ? body.resources as Record<string, unknown> : null;
  const size = cloudSizeFor(body.type, resources?.cpu, resources?.memory);
  if (!size) return refused(badRequest("That size isn't one ADE Cloud offers."));
  const name = computerName(body.name) ?? "ADE computer";
  const clientMetadata = stringMap(body.metadata, MAX_METADATA_ENTRIES);
  const requestedEnv = stringMap(body.env, MAX_ENV_ENTRIES);
  const publicPorts = onlyWakePorts(body.publicPorts);
  if (!clientMetadata || !requestedEnv || !publicPorts) return refused(badRequest(UNREADABLE_REQUEST_MESSAGE));
  // The client's env is cut to `CLIENT_ENV`: no sign-in an older desktop
  // sends reaches the host, and a client can't name a launch or its join code
  // (the server's own entries). Only the dropped names are logged, never a value.
  const keptEnv: Record<string, string> = {};
  const droppedEnv: string[] = [];
  for (const [envName, value] of Object.entries(requestedEnv)) {
    const shape = Object.hasOwn(CLIENT_ENV, envName) ? CLIENT_ENV[envName as keyof typeof CLIENT_ENV] : null;
    if (shape?.test(value)) keptEnv[envName] = value;
    else droppedEnv.push(envName.slice(0, 64));
  }
  if (droppedEnv.length) logCloud("cloud.create_env_dropped", { userId, names: droppedEnv.sort() });
  const clientEnv = { ...keptEnv, ...extras.serverEnv };
  // The app's own update track: the computer starts from that channel's image and follows it.
  const channel = body.channel === undefined ? "stable" : readUpdateChannel(body.channel);
  if (!channel) return refused(badRequest("That update channel isn't one ADE knows."));

  // A repeat of a request this account made gets that computer, before any
  // limit: it is not a new computer, so hours or the computer limit can't refuse it.
  const repeatedId = clientMetadata.ade_request_id;
  if (repeatedId) {
    const replay = await replayRequest(env, provider, userId, repeatedId, now);
    if (replay) return replay;
  }

  const targets = await readUpdateTargets(env);
  const templateVersion = channelTemplate(targets, channel);
  if (!templateVersion) {
    reportCloudFailure("cloud.create_refused_no_template_version", { userId, channel });
    return refused(fail("template_unset", CANT_MAKE_COMPUTER_MESSAGE, 503));
  }
  const { account, computers, outOfHoursFor } = await getAccountContext(env, userId, now);
  const isMove = body.moveFromInstanceId !== undefined;
  const action = isMove ? "move" : "create";
  const { metadata, requestId } = withRequestId(clientMetadata);
  const { track, refuse } = cloudActionTracker({ env, waitUntil, userId, plan: planIdOf(account), origin: originOf(clientMetadata), key: requestId, refusedAction: action, now });
  // The owner's kill switch (a move replaces a computer, so it still runs) and the hourly limit.
  const newWork = await newWorkRefusal(env, userId, isMove ? "move" : "create", now, waitUntil);
  if (newWork) return refused(newWork);
  // An outside agent (ADE MCP) on the free plan: a create, a move and a new lane's launch alike.
  const outside = outsideAgentRefusal(account, isOutsideAgentMetadata(clientMetadata));
  if (outside) return refused(refuse(outside));
  // Only the size being made: a Small computer never uses hours.
  const empty = outOfHoursFor(size.multiplierMilli);
  if (empty) return refused(refuse(empty));
  // The owner's cap limits free use only: a paid account is never refused here.
  if (await freeCapRefuses(env, account, now, waitUntil)) return refused(refuse({ response: cantMakeComputer(), refusal: "owner_limit" }));
  // An account over its plan gets no new computer, a move's included: a move whose source outlives it would add one.
  const over = overPlanLimits(env, account, computers, action);
  if (over) return refused(refuse(over));

  // A move carries the old computer's disk; a plain create starts at the smallest, or at its repository's setup disk.
  let diskGb = setupStartDiskGb(size, extras.setupDiskGb);
  let moveFromInstanceId: string | null = null;
  let lane = laneFactsOf(metadata);
  if (isMove) {
    const source = typeof body.moveFromInstanceId === "string" ? await ownedComputer(env, userId, body.moveFromInstanceId) : null;
    if (!source) return refused(notFound());
    // One move at a time per computer: a chain (A to B, then B to C) would leave both A and B out of the count.
    if (source.moving_from != null || await env.DB.prepare("select 1 as busy from cloud_computers where moving_from = ? and deleted_at is null limit 1").bind(source.instance_id).first()) {
      return refused(fail("computer_busy", "This computer is in the middle of a move. Try again when the move is done.", 409));
    }
    // A computer the person picked to free for a cheaper plan goes; moving it would race the delete.
    if (readPlanCleanupChoiceIds(account).includes(source.instance_id)) {
      return refused(fail("computer_busy", "ADE is freeing this computer for your plan, so it can't move now.", 409));
    }
    diskGb = source.disk_gb;
    moveFromInstanceId = source.instance_id;
    // The lane moves with its computer, even when the client's metadata left it out.
    lane = mergeLaneFacts(lane, laneFactsOfRow(source));
    const tooBig = tierRefusal(size, diskGb, true);
    if (tooBig) return refused(refuse(tooBig));
  }
  // The computer limit is checked in the reservation's own write (a move's count leaves its source out).
  const reservation = await reserveComputer(env, account, { size, diskGb, moveFromInstanceId, name, requestId, templateVersion, channel, lane, now });
  if (!reservation.ok) {
    if ("replay" in reservation) return await replayRequest(env, provider, userId, requestId, now) ?? { kind: "in_progress" };
    return refused(reservation.refusal ? refuse({ response: reservation.response, refusal: reservation.refusal }) : reservation.response);
  }

  try {
    const instance = await provider.createInstance({
      template: templateVersion,
      name,
      type: size.type,
      resources: { cpu: size.cpu, memory: size.memoryGb, disk: diskGb },
      ...(Object.keys(clientEnv).length ? { env: clientEnv } : {}),
      metadata,
      ...(publicPorts.length ? { publicPorts } : {}),
    });
    // Billed disk only once the provider made it (a move's source stays out while the move runs).
    // The adoption also ends the lane's row in "Lanes without a computer", in this one batch.
    await env.DB.batch([
      ...adoptionStatements(env, { pendingId: reservation.pendingId, instance, machineKey: metadata.ade_machine_key ?? null, now: Date.now(), reason: "create" }),
      diskDayStatement(env, account, now),
      ...(extras.onMade?.(instance) ?? []),
    ]);
    // A block that landed while the provider made it (a launch mid-create): stopped now, cut off the internet.
    await enforceBlockAfterCreate(env, provider, userId, instance.id, Date.now());
    track({ action, tier: tierOf(size) });
    return { kind: "made", instance, answer: withUpdateFacts(instance, { channel, template_version: templateVersion, update_state: null, updated_at: null, update_error: null }, targets) };
  } catch (error) {
    if (providerMadeNothing(error)) await releasePending(env, reservation.pendingId);
    if (error instanceof CloudProviderError && (error.code === "not_found" || error.code === "invalid_request")) {
      reportCloudFailure("cloud.create_refused_template", { userId, templateVersion, code: error.code });
      return refused(fail("template_unavailable", CANT_MAKE_COMPUTER_MESSAGE, 503));
    }
    throw error;
  }
}

/** A copy's size, disk and room on the account, worked out once its rules said yes (`planFork`). */
type ForkPlan = {
  account: AccountRow;
  size: CloudSize;
  diskGb: number;
  track: ReturnType<typeof cloudActionTracker>["track"];
  refuse: ReturnType<typeof cloudActionTracker>["refuse"];
};

/**
 * A copy's rules (the owner's switch, outside agents, hours, the computer
 * limit, size, disk), for the copy
 * route and the server copy (`copies.ts`) alike, so a server copy is refused
 * at its start for exactly what would refuse its fork.
 */
async function planFork(
  env: CloudEnv,
  computer: ComputerRow,
  body: Record<string, unknown>,
  metadataIn: Record<string, string>,
  { now, waitUntil }: CloudRequestContext,
): Promise<{ ok: true; plan: ForkPlan } | { ok: false; response: Response }> {
  const no = (response: Response) => ({ ok: false as const, response });
  const { account, computers, outOfHoursFor } = await getAccountContext(env, computer.user_id, now);
  const { track, refuse } = cloudActionTracker({
    env, waitUntil, userId: computer.user_id, plan: planIdOf(account), origin: originOf(metadataIn), key: computer.instance_id, refusedAction: "copy", now,
  });
  const newWork = await newWorkRefusal(env, computer.user_id, "copy", now, waitUntil);
  if (newWork) return no(newWork);
  const outside = outsideAgentRefusal(account, isOutsideAgentMetadata(metadataIn));
  if (outside) return no(refuse(outside));
  const resources = body.resources && typeof body.resources === "object" ? body.resources as Record<string, unknown> : null;
  const size = resources
    ? cloudSizeFor(computer.type, resources.cpu, resources.memory)
    : cloudSizeFor(computer.type, computer.cpu, computer.memory_gb);
  if (!size) return no(badRequest("That size isn't one ADE Cloud offers."));
  // Only the copy's own size: a Small copy never uses hours.
  const empty = outOfHoursFor(size.multiplierMilli);
  if (empty) return no(refuse(empty));
  if (await freeCapRefuses(env, account, now, waitUntil)) return no(refuse({ response: cantMakeComputer(), refusal: "owner_limit" }));
  const over = overPlanLimits(env, account, computers);
  if (over) return no(refuse(over));
  // A copy adds a computer: refused at the limit now (the reservation checks again in its own write).
  const atLimit = await computerLimitCheck(env, account, now);
  if (atLimit) return no(refuse(atLimit));

  const requestedDisk = typeof resources?.disk === "number" ? resources.disk : computer.disk_gb;
  if (!Number.isInteger(requestedDisk)) return no(badRequest("That disk size isn't valid."));
  if (requestedDisk < computer.disk_gb) return no(badRequest("A copy's disk can't be smaller than the original's."));
  if (requestedDisk !== computer.disk_gb && requestedDisk % DISK_STEP_GB !== 0) return no(badDiskStep());
  const tooBig = tierRefusal(size, requestedDisk, requestedDisk === computer.disk_gb);
  if (tooBig) return no(refuse(tooBig));
  return { ok: true, plan: { account, size, diskGb: requestedDisk, track, refuse } };
}

/** Why a copy of `computer` with this fork body would be refused now, or null when it may go ahead (the server copy's start). */
export async function forkRefusal(env: CloudEnv, computer: ComputerRow, body: Record<string, unknown>, ctx: CloudRequestContext): Promise<Response | null> {
  const metadataIn = stringMap(body.metadata, MAX_METADATA_ENTRIES);
  if (!metadataIn) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const planned = await planFork(env, computer, body, metadataIn, ctx);
  return planned.ok ? null : planned.response;
}

/**
 * The one way a computer is copied (`POST /cloud/instances/:id/fork` and the
 * server copy): the same replay, rules, reservation, billing and metadata as
 * a create. `extras.onMade`'s statements land in the fork's adoption batch.
 */
export async function forkComputer(env: CloudEnv, computer: ComputerRow, provider: CloudProvider, extras: Pick<CreateComputerExtras, "body" | "onMade">, ctx: CloudRequestContext): Promise<CreateComputerOutcome> {
  const refused = (response: Response): CreateComputerOutcome => ({ kind: "refused", response });
  const { body } = extras;
  const { now } = ctx;
  const metadataIn = stringMap(body.metadata, MAX_METADATA_ENTRIES);
  if (!metadataIn) return refused(badRequest(UNREADABLE_REQUEST_MESSAGE));
  // A repeat of a copy this account asked for gets that computer, before any
  // limit, as a repeated create does.
  if (metadataIn.ade_request_id) {
    const replay = await replayRequest(env, provider, computer.user_id, metadataIn.ade_request_id, now);
    if (replay) return replay;
  }
  const planned = await planFork(env, computer, body, metadataIn, ctx);
  if (!planned.ok) return refused(planned.response);
  const { account, size, diskGb, track, refuse } = planned.plan;

  const { metadata, requestId } = withRequestId(metadataIn);
  const name = computerName(body.name);
  const reservation = await reserveComputer(env, account, {
    size,
    diskGb,
    moveFromInstanceId: null,
    name: name ?? computer.name,
    requestId,
    templateVersion: computer.template_version,
    // A copy follows its original's channel.
    channel: channelOfComputer(computer),
    lane: laneFactsOf(metadata),
    now,
  });
  if (!reservation.ok) {
    if ("replay" in reservation) return await replayRequest(env, provider, computer.user_id, requestId, now) ?? { kind: "in_progress" };
    return refused(reservation.refusal ? refuse({ response: reservation.response, refusal: reservation.refusal }) : reservation.response);
  }
  try {
    const instance = await provider.forkInstance(computer.instance_id, {
      ...(name ? { name } : {}),
      resources: { cpu: size.cpu, memory: size.memoryGb, disk: diskGb },
      metadata,
    });
    await env.DB.batch([
      ...adoptionStatements(env, { pendingId: reservation.pendingId, instance, machineKey: metadata.ade_machine_key ?? null, now: Date.now(), reason: "copy" }),
      diskDayStatement(env, account, now),
      ...(extras.onMade?.(instance) ?? []),
    ]);
    await enforceBlockAfterCreate(env, provider, computer.user_id, instance.id, Date.now());
    track({ action: "copy", tier: tierOf(size) });
    return { kind: "made", instance, answer: instance };
  } catch (error) {
    if (providerMadeNothing(error)) await releasePending(env, reservation.pendingId);
    throw error;
  }
}

/** `forkComputer` for a step nobody's request runs (the minute cron's server copy): the free plan's GitHub rules are settled first, as `createComputerSettled` does. */
export async function forkComputerSettled(env: CloudEnv, computer: ComputerRow, provider: CloudProvider, extras: Pick<CreateComputerExtras, "body" | "onMade">, ctx: CloudRequestContext): Promise<CreateComputerOutcome> {
  await settleFreePlanGithub(env, await loadAccount(env, computer.user_id, ctx.now), ctx);
  return forkComputer(env, computer, provider, extras, ctx);
}

async function handleFork(request: Request, env: CloudEnv, computer: ComputerRow, provider: CloudProvider, ctx: CloudRequestContext): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  return createAnswerOf(await forkComputer(env, computer, provider, { body }, ctx));
}

/**
 * A resize on an awake computer. The provider refuses a resize (like a
 * restart or a restore) of a sleeping one with `invalid_request`, so a
 * sleeping computer is woken first, under the same rules as any wake (hours,
 * at the new size's rate), and the wake is recorded so its time is metered. The row
 * can be a minute behind the provider: a refusal on a computer the row calls
 * awake reads the provider once, and wakes and asks again if it sleeps.
 *
 * Here and not on each client: every resize (a person's size change, `ade
 * cloud resize`, the dashboard, a computer's own disk grow) comes through this
 * route, and only the server knows the wake rules and the meter.
 */
async function resizeAwake(
  env: CloudEnv,
  computer: ComputerRow,
  provider: CloudProvider,
  resize: { cpu: number; memory: number; disk?: number },
  now: number,
  /** The rate it runs at after the resize: the wake is held to the new size's hours rule. */
  multiplierMilli: number,
): Promise<{ status: string } | { blocked: Refused } | { refused: Response }> {
  const wake = async (): Promise<{ blocked: Refused } | { refused: Response } | null> => {
    const { blocked } = await wakeBlocker(env, computer, now, multiplierMilli);
    if (blocked) return { blocked };
    const capped = await awakeRoom(env, { ...computer, status: "sleeping" }, now);
    if (capped) return { blocked: capped };
    // As every wake: it is use, and a delete that holds the computer refuses it in the same write.
    const deleting = await idleUseRefusal(env, { ...computer, status: "sleeping" }, now);
    if (deleting) return { refused: deleting };
    const status = await provider.startInstance(computer.instance_id);
    await recordStatus(env, computer, status, now, "resize");
    return null;
  };
  let woken = false;
  if (computer.status === "sleeping") {
    const stopped = await wake();
    if (stopped) return stopped;
    woken = true;
  }
  try {
    return { status: await provider.resizeInstance(computer.instance_id, resize) };
  } catch (error) {
    if (woken || !(error instanceof CloudProviderError && error.code === "invalid_request")) throw error;
    const live = await provider.getInstance(computer.instance_id).catch(() => null);
    if (live?.status !== "sleeping") throw error;
    // The row said awake; the provider says asleep. Take its word for the meter too.
    // The provider gives no time it fell asleep, so the stretch up to now is
    // metered: at most the row's lag (about a minute), accepted.
    if (computer.status !== "sleeping") await recordStatus(env, computer, "sleeping", now, "resize");
    const stopped = await wake();
    if (stopped) return stopped;
    return { status: await provider.resizeInstance(computer.instance_id, resize) };
  }
}

async function handleResize(request: Request, env: CloudEnv, computer: ComputerRow, provider: CloudProvider, { now, waitUntil }: CloudRequestContext): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const { account, outOfHoursFor, smallFree } = await getAccountContext(env, computer.user_id, now);
  // The computer's own disk grower says so (`auto`), and an outside agent (`mcp`); anything else is a person or their agent.
  const origin: CloudActionOrigin = body.origin === "auto" ? "system" : body.origin === "mcp" ? "agent" : "person";
  const refusedAction: CloudRefusedAction = body.disk !== undefined ? "grow" : "tier_change";
  const { track, refuse } = cloudActionTracker({ env, waitUntil, userId: computer.user_id, plan: planIdOf(account), origin, key: computer.instance_id, refusedAction, now });
  // An outside agent on the free plan: a resize may wake an asleep computer, as a start would.
  const outside = outsideAgentRefusal(account, body.origin === "mcp");
  if (outside) return refuse(outside);

  const size = cloudSizeFor(computer.type, body.cpu ?? computer.cpu, body.memory ?? computer.memory_gb);
  if (!size) return badRequest("That size isn't one ADE Cloud offers.");
  // The size it runs at after: at 0 hours a resize to Small (or a Small's disk grow) goes ahead, one to a bigger size doesn't.
  const empty = outOfHoursFor(size.multiplierMilli);
  if (empty) return refuse(empty);

  if (body.disk !== undefined && (typeof body.disk !== "number" || !Number.isInteger(body.disk))) return badRequest("That disk size isn't valid.");
  // The provider's size, not the row's: a grow whose answer was lost leaves the row ahead, and a retry must still ask for it.
  const currentDisk = body.disk === undefined ? computer.disk_gb : (await provider.getInstance(computer.instance_id)).resources?.disk ?? computer.disk_gb;
  let nextDisk = currentDisk;
  if (typeof body.disk === "number") {
    if (body.disk < currentDisk) return badRequest("A computer's disk can only grow.");
    nextDisk = body.disk;
  }
  const shapeChanges = size.cpu !== computer.cpu || size.memoryGb !== computer.memory_gb;
  // A server launch's setup moving its own computer up a size (`CLOUD_AUTO_SIZE`): only the
  // computer's own brain sends it, only for a launch whose size was ADE's default, and once.
  // The launch and the repository are recorded with the resize itself, never for a refused one.
  let launchStatements: D1PreparedStatement[] = [];
  if (body.launchId !== undefined) {
    if (typeof body.launchId !== "string" || origin !== "system" || body.disk !== undefined) {
      return badRequest("That size change isn't valid.");
    }
    const check = await launchAutoSizeCheck(env, computer, body.launchId.trim().toLowerCase(), size, now);
    if (!check.ok) return fail("size_kept", cloudAutoSizeRefusalSentence(check.reason), 409, { reason: check.reason });
    launchStatements = check.statements;
  }
  if (nextDisk !== currentDisk) {
    if (nextDisk % DISK_STEP_GB !== 0) return badDiskStep();
    const tooBig = tierRefusal(size, nextDisk, false);
    if (tooBig) return refuse(tooBig);
    // A disk grow restarts the computer, so only the computer can say it's safe.
    if (isMeteredStatus(computer.status) && body.computerIdle !== true) {
      return fail("computer_busy", "A disk can only grow while the computer is idle.", 409);
    }
    // Reserved in one write held to the size it read, so two grows at once can't both pass.
    // There is no account-wide disk (Pricing v2): only this size's own maximum, checked above.
    // Already this size on the row: a retry, and its reservation is already held.
    if (nextDisk !== computer.disk_gb) {
      if (await freeCapRefuses(env, account, now, waitUntil)) return refuse({ response: cantGrowDisk(), refusal: "owner_limit" });
      const reserved = await env.DB.prepare(`
        update cloud_computers set disk_gb = ?, disk_reserved_at = ?, disk_confirmed_gb = coalesce(disk_confirmed_gb, disk_gb)
        where instance_id = ? and disk_gb = ?
      `).bind(nextDisk, now, computer.instance_id, computer.disk_gb).run();
      if (reserved.meta.changes !== 1) return diskChanged();
    } else if (nextDisk !== currentDisk) {
      // A retry: its room is held, so only the clock needs renewing.
      await env.DB.prepare("update cloud_computers set disk_reserved_at = ? where instance_id = ?").bind(now, computer.instance_id).run();
    }
  } else if (shapeChanges) {
    // A disk never shrinks, so a smaller size must still hold it.
    const tooBig = tierRefusal(size, currentDisk, true);
    if (tooBig) return refuse(tooBig);
  }

  const resize: { cpu: number; memory: number; disk?: number } = { cpu: size.cpu, memory: size.memoryGb };
  if (nextDisk !== currentDisk) resize.disk = nextDisk;
  /** Gives back the disk this resize reserved, unless something else has changed it since. */
  const releaseDiskReservation = async (): Promise<void> => {
    await env.DB.prepare("update cloud_computers set disk_gb = ?, disk_reserved_at = null, disk_confirmed_gb = null where instance_id = ? and disk_gb = ?")
      .bind(currentDisk, computer.instance_id, nextDisk).run();
  };
  // The provider call and every write after it run to the end even when the
  // caller goes away. A resize the computer asks for itself (a disk grow, a
  // setup's move to Medium) restarts that computer within seconds, which drops
  // its request, and Cloudflare cancels a request's unfinished work when its
  // client disconnects: the size, the hours stretch and the launch record were
  // then never written, and the computer ran Medium billed as a Small.
  const finish = (async (): Promise<Response> => {
    let status: string;
    try {
      const awake = await resizeAwake(env, computer, provider, resize, now, size.multiplierMilli);
      if ("blocked" in awake) {
        if (nextDisk !== currentDisk) await releaseDiskReservation();
        return refuse(awake.blocked);
      }
      if ("refused" in awake) {
        if (nextDisk !== currentDisk) await releaseDiskReservation();
        return awake.refused;
      }
      status = awake.status;
    } catch (error) {
      if (nextDisk !== currentDisk && providerMadeNothing(error)) {
        await releaseDiskReservation();
      }
      throw error;
    }
    const statements: D1PreparedStatement[] = [];
    // The time so far is charged at the old size; the new size starts its own stretch here.
    const rate = rateMilliFor(size, smallFree);
    if (rate !== computer.multiplier_milli && computer.awake_since != null && computer.awake_since <= now) {
      statements.push(...restartStretchStatements(env, computer, now));
    }
    computer.multiplier_milli = rate;
    statements.push(
      // A confirmed grow is no longer a reservation, so it counts as billed disk from here.
      env.DB.prepare(`update cloud_computers set cpu = ?, memory_gb = ?, disk_gb = ?, multiplier_milli = ?${nextDisk !== currentDisk ? ", disk_reserved_at = null, disk_confirmed_gb = null" : ""} where instance_id = ?`)
        .bind(size.cpu, size.memoryGb, nextDisk, rate, computer.instance_id),
      ...statusChangeStatements(env, computer, status, now, "resize"),
      ...launchStatements,
    );
    // The bigger disk is billed only now that the provider made it; a refused grow gave its room back above.
    if (nextDisk !== currentDisk) statements.push(diskDayStatement(env, account, now));
    await env.DB.batch(statements);
    // The computer's own grow during a launch's setup: the next launch of that repository starts at this disk.
    // Best effort, after the grow is recorded, so it can never undo or block one.
    if (nextDisk !== currentDisk && origin === "system") await rememberLaunchSetupDisk(env, computer, nextDisk, now);
    if (shapeChanges) track({ action: "tier_change", tier: tierOf(size) });
    if (nextDisk !== currentDisk) track({ action: "grow", tier: tierOf(size) });
    return json({ status });
  })();
  // A caller that is still here gets the error below and the router reports it;
  // one that went away (the restarting computer) leaves only this log line.
  waitUntil?.(finish.then(() => undefined, (error: unknown) => {
    logCloud("cloud.resize_finish_failed", { instanceId: computer.instance_id, error: error instanceof Error ? error.message : String(error) });
  }));
  return await finish;
}

const PREPARE_FOR_SLEEP_COMMAND = commandWith(CLOUD_COMPUTER_COMMANDS.prepareForSleep);
/** The 20 s prepare, the wait for ADE to answer, and room for the exec itself. */
const PREPARE_FOR_SLEEP_TIMEOUT_MS = 60_000;

/**
 * The computer's freeze holds 30 s after its prepare answered
 * (`CLOUD_SLEEP_FREEZE_AFTER_PREPARE_MS`). A sleep that lands later than this
 * may come after the freeze ended, so the save does not count.
 */
const SLEEP_MARK_WITHIN_MS = 20_000;

/** What the person's Sleep prepare did: the backup report the computer may rest with, whether new work is frozen on it, and when it answered. */
type SleepPrepare = { reportId: string | null; frozen: boolean; answeredAt: number };

/**
 * The person's Sleep of an awake computer: its ADE first stops the running
 * turns and saves the chats, then saves the lanes' backups in the time left
 * (`prepare-stop --for-sleep`). A sleep freezes the computer, so a turn it
 * cuts would else read Done in its saved copy while it sleeps; now it reads
 * Stopped. Best effort: the sleep goes ahead whatever the prepare says. A
 * computer that is not awake is not woken.
 *
 * The report counts only when the computer also froze new work from the
 * start of the prepare until the sleep (`frozen`). Without the freeze, a
 * turn that starts after the lanes' backups could write files the backup
 * does not have, and a move from the saved copy would then delete them. An
 * older ADE ignores `--for-sleep` and does not freeze: its computer sleeps,
 * but not saved.
 */
async function prepareForPersonSleep(provider: CloudProvider, computer: ComputerRow): Promise<SleepPrepare> {
  try {
    const instance = await provider.getInstance(computer.instance_id);
    if (!isMeteredStatus(instance.status)) return { reportId: null, frozen: false, answeredAt: Date.now() };
    const result = await provider.exec(computer.instance_id, PREPARE_FOR_SLEEP_COMMAND, PREPARE_FOR_SLEEP_TIMEOUT_MS);
    const read = result.exitCode === 0 ? readResult(result.stdout) : null;
    const frozen = read?.frozen === true;
    const reportId = frozen ? prepareStopBackupReportId(result.stdout) : null;
    logCloud("cloud.sleep_prepared", { instanceId: computer.instance_id, exitCode: result.exitCode, backups: reportId != null, frozen });
    return { reportId, frozen, answeredAt: Date.now() };
  } catch (error) {
    logCloud("cloud.sleep_prepare_failed", { instanceId: computer.instance_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
    return { reportId: null, frozen: false, answeredAt: Date.now() };
  }
}

async function handleSleepLike(env: CloudEnv, computer: ComputerRow, provider: CloudProvider, now: number, reason: string, backupReportId: string | null = null): Promise<Response> {
  const { blocked } = await wakeBlocker(env, computer, now);
  // Only the person's Sleep: the computer's own idle sleep comes when nothing runs, with its own save.
  const person = reason === "user";
  const prepare: SleepPrepare = person ? await prepareForPersonSleep(provider, computer) : { reportId: backupReportId, frozen: false, answeredAt: Date.now() };
  try {
    // While wakes are refused a sleeping computer would still wake on any request, so it stops instead.
    const status = blocked ? await provider.stopInstance(computer.instance_id) : await provider.sleepInstance(computer.instance_id);
    // The person's Sleep: only while the computer's freeze still held when it slept.
    const inFreeze = !person || Date.now() - prepare.answeredAt <= SLEEP_MARK_WITHIN_MS;
    await recordStatus(env, computer, status, now, reason);
    // After the status write: a cleanup may delete it with no wake only once it rests with current backups.
    if (prepare.reportId && inFreeze) await markRestedWithBackups(env, computer.instance_id, prepare.reportId, now);
    return json({ status });
  } catch (error) {
    // The computer stays awake: it takes new work again now, not when its freeze runs out.
    if (prepare.frozen) await unfreezeComputer(provider, computer.instance_id);
    if (error instanceof CloudProviderError && error.status === 400) return json({ status: computer.status });
    throw error;
  }
}

async function handleStart(request: Request, env: CloudEnv, computer: ComputerRow, provider: CloudProvider, { now, waitUntil }: CloudRequestContext): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const { account, blocked } = await wakeBlocker(env, computer, now);
  // `origin: "mcp"`: an outside agent waking the computer for work, refused on the free plan.
  const outside = outsideAgentRefusal(account, body.origin === "mcp");
  if (outside || blocked) {
    // Every wake is use, so none goes through at 0 hours (a Small computer's does). The lanes' work reads from their backups with no wake.
    const { refuse } = cloudActionTracker({ env, waitUntil, userId: computer.user_id, plan: planIdOf(account), origin: outside ? "agent" : "person", key: computer.instance_id, refusedAction: "wake", now });
    return refuse((outside ?? blocked)!);
  }
  // At the awake cap, a wake waits a few seconds for another computer to sleep before it says so.
  const capped = await awakeRoom(env, computer, now, AWAKE_CAP_WAIT_MS);
  if (capped) {
    const { refuse } = cloudActionTracker({ env, waitUntil, userId: computer.user_id, plan: planIdOf(account), origin: "person", key: computer.instance_id, refusedAction: "wake", now });
    return refuse(capped);
  }
  // Before the provider is asked: an idle cleanup in flight sees this start before its delete.
  const refused = await idleUseRefusal(env, computer, now);
  if (refused) return refused;
  let status: string;
  try {
    status = await provider.startInstance(computer.instance_id);
  } catch (error) {
    // The provider holds a computer whose plan payment failed: the server's sentence (CONTRACTS 5), not the provider's.
    if (error instanceof CloudProviderError && error.code === "instance_suspended") return fail("plan_past_due", CLOUD_PLAN_PAST_DUE_SENTENCE, 402);
    throw error;
  }
  await recordStatus(env, computer, status, now, "user");
  return json({ status });
}

async function handleStop(env: CloudEnv, computer: ComputerRow, provider: CloudProvider, now: number): Promise<Response> {
  const status = await provider.stopInstance(computer.instance_id);
  await recordStatus(env, computer, status, now, "user");
  return json({ status });
}

/** How long the computer's own update waits for the provider before it answers `started` anyway. */
const IDLE_UPDATE_ANSWER_WAIT_MS = 8_000;

/**
 * Moves the computer to its channel's image (`updates.ts`). A person's update
 * (no reason, or `manual`) always runs; the computer's own (`idle`) runs only
 * while it is running and says it is idle, and only when it is behind the
 * image a passed check allowed.
 */
async function handleUpdate(request: Request, env: CloudEnv, computer: ComputerRow, provider: CloudProvider, { now, waitUntil }: CloudRequestContext): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const reason = body.reason === undefined || body.reason === "manual" ? "manual" : body.reason === "idle" ? "idle" : null;
  if (!reason) return badRequest("That update reason isn't one ADE Cloud knows.");
  const targets = await readUpdateTargets(env);
  const channel = channelOfComputer(computer);
  if (reason === "idle") {
    // It restarts the computer, so only the computer can say it's safe.
    if (body.computerIdle !== true || computer.status !== "running") {
      return fail("computer_busy", "A computer updates itself only while it's idle.", 409);
    }
    if (!isBehindAutomatic(computer, targets, now)) return json({ status: computer.status, templateVersion: computer.template_version, started: false });
  }
  const templateVersion = reason === "idle" ? automaticTemplate(targets, channel) : channelTemplate(targets, channel);
  if (!templateVersion) {
    reportCloudFailure("cloud.update_refused_no_template_version", { userId: computer.user_id, instanceId: computer.instance_id, channel });
    return fail("template_unset", CANT_MAKE_COMPUTER_MESSAGE, 503);
  }
  if (computer.update_state === "updating") return fail("update_in_progress", new CloudUpdateInProgressError().message, 409);
  const { blocked } = await wakeBlocker(env, computer, now);
  if (blocked) return blocked.response;
  // An update wakes a sleeping computer, so it counts toward the awake cap like any wake.
  const capped = await awakeRoom(env, computer, now);
  if (capped) return capped.response;
  try {
    // Saved with the update: whether this image sends a boot report decides its rollback, whatever the channel says later.
    const expectsReport = automaticTemplate(targets, channel) === templateVersion;
    if (reason === "idle" && waitUntil) {
      // The computer asking is the one the update restarts: its link drops
      // mid-request, which can cancel this request. The update runs on its
      // own (its power log and free window are written before the provider
      // is asked, `startCloudUpdate`). The answer waits a few seconds for the
      // provider: a quick refusal reaches the computer, which then sleeps as
      // usual; still waiting, the computer only needs to know it started.
      const update = startCloudUpdate(env, provider, computer, { reason, target: templateVersion, expectsReport, now });
      waitUntil(update.then(
        () => undefined,
        (error: unknown) => {
          if (error instanceof CloudUpdateInProgressError) return;
          reportCloudFailure("cloud.idle_update_failed", { instanceId: computer.instance_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
        },
      ));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        update.then(
          (started) => ({ kind: "started" as const, started }),
          (error: unknown) => ({ kind: "failed" as const, error }),
        ),
        new Promise<{ kind: "pending" }>((resolve) => { timer = setTimeout(() => resolve({ kind: "pending" }), IDLE_UPDATE_ANSWER_WAIT_MS); }),
      ]);
      clearTimeout(timer);
      if (settled.kind === "failed") throw settled.error;
      if (settled.kind === "started") return json({ ...settled.started, started: true });
      return json({ status: "updating", templateVersion, started: true });
    }
    const started = await startCloudUpdate(env, provider, computer, { reason, target: templateVersion, expectsReport, now });
    return json({ ...started, started: true });
  } catch (error) {
    if (error instanceof CloudUpdateInProgressError) return fail("update_in_progress", error.message, 409);
    throw error;
  }
}

const LANE_READ_FAILED_MESSAGE = "ADE Cloud couldn't read which lane this computer holds, so it didn't delete it. Try again in a moment.";
const NO_LANE_MESSAGE = "ADE Cloud doesn't know a lane on this computer, so there is no lane to keep. Nothing was deleted.";

/**
 * Before a delete that keeps the lane: the lane's facts, the row's first and a
 * live read of the instance's metadata second, saved on the row with the mark
 * that makes its close write the lane's row (in the close's own batch). The
 * live read runs only when the row lacks something; its failure refuses the
 * delete only when the row can't name the lane. A response when the delete
 * must not run.
 */
async function markKeepLane(env: CloudEnv, provider: CloudProvider, computer: ComputerRow, branchRef: string | null): Promise<Response | null> {
  const row = laneFactsOfRow(computer);
  let live: CloudLaneFacts = laneFactsOf(null);
  if (!namesLane(row) || (!branchRef && !row.branch)) {
    try {
      live = laneFactsOf((await provider.getInstance(computer.instance_id)).metadata);
    } catch (error) {
      const gone = error instanceof CloudProviderError && error.status === 404;
      if (!gone) {
        reportCloudFailure("cloud.keep_lane_read_failed", { instanceId: computer.instance_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
        if (!namesLane(row)) return fail("lane_read_failed", LANE_READ_FAILED_MESSAGE, 502);
      }
    }
  }
  const facts = mergeLaneFacts(row, live);
  // The desktop read the branch from the lane just now: it wins over both.
  if (branchRef) facts.branch = branchRef;
  if (!namesLane(facts)) return fail("no_lane", NO_LANE_MESSAGE, 409);
  await markKeepLaneStatement(env, computer, facts, "freed").run();
  return null;
}

const COMPUTER_AWAKE_MESSAGE = "The ADE Cloud computer is awake, so its saved copy may be older than its work.";

/**
 * Null while the computer rests with every lane's work saved; else the
 * refusal. A live read, with no wake. `gone`: the provider has no such
 * computer any more (an earlier delete whose close failed) and the row still
 * reads saved, so nothing can wake it and only the close is left.
 */
async function refuseUnlessRestsSaved(env: CloudEnv, provider: CloudProvider, computer: ComputerRow): Promise<Response | "gone" | null> {
  const instance = await provider.getInstance(computer.instance_id).catch((error: unknown) => {
    if (error instanceof CloudProviderError && error.status === 404) return null;
    throw error;
  });
  if (instance && isMeteredStatus(instance.status)) return fail("computer_awake", COMPUTER_AWAKE_MESSAGE, 409);
  const saved = await restingBackupState(env, computer.instance_id);
  if (!saved.ok) return fail(saved.code, saved.reason, 409);
  return instance ? null : "gone";
}

const COMPUTER_ALREADY_DELETING_MESSAGE = "ADE Cloud is deleting this computer already. Nothing else was deleted.";

/**
 * The delete claim of a move from the saved copy (`idle_deleting_at`, the
 * claim the idle cleanup holds for its own delete). One conditional write:
 * it holds only while the row still rests with current backups and no
 * other delete holds the computer. While it holds, every wake path (a
 * start, a command, a sign-in, a sent message, the computer's own use
 * report) is refused (`recordIdleUse` answers `deleting`, and
 * `takeFromDeletes` refuses a wake of a resting computer in the same write
 * that would let it go). A wake that passed before the claim cleared the
 * backups in that write, so the claim fails.
 * Null when it holds; else the refusal, with nothing deleted.
 */
async function claimSavedDelete(env: CloudEnv, computer: ComputerRow, now: number): Promise<Response | null> {
  const claimed = await env.DB.prepare(`
    update cloud_computers set idle_deleting_at = ?
    where instance_id = ? and deleted_at is null and (idle_deleting_at is null or idle_deleting_at < ?)
      and backup_rest_at is not null and backup_report_state = 'current' and status in ('sleeping', 'stopped')
  `).bind(now, computer.instance_id, now - SAVED_DELETE_CLAIM_STALE_MS).run();
  if ((claimed.meta?.changes ?? 0) === 1) return null;
  const saved = await restingBackupState(env, computer.instance_id);
  return saved.ok ? fail("computer_deleting", COMPUTER_ALREADY_DELETING_MESSAGE, 409) : fail(saved.code, saved.reason, 409);
}

/** A delete that didn't happen gives its claim back, so the computer takes work again. */
const unclaimSavedDelete = (env: CloudEnv, instanceId: string, now: number): Promise<unknown> =>
  env.DB.prepare("update cloud_computers set idle_deleting_at = null where instance_id = ? and idle_deleting_at = ?").bind(instanceId, now).run()
    .catch((error: unknown) => reportCloudFailure("cloud.saved_delete_unclaim_failed", { instanceId, message: error instanceof Error ? error.message : "unknown" }));

async function handleDelete(request: Request, env: CloudEnv, computer: ComputerRow, provider: CloudProvider, { now, waitUntil }: CloudRequestContext): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const who = shortText(body.who, 200);
  // "Keep the lane on a fresh computer": the lane outlives its computer.
  const keepLane = body.keepLane && typeof body.keepLane === "object" && !Array.isArray(body.keepLane)
    ? body.keepLane as Record<string, unknown>
    : null;
  // A move from the saved copy: the computer goes only while it rests with every lane saved.
  const onlyIfSaved = keepLane?.onlyIfSaved === true;
  if (onlyIfSaved) {
    const rests = await refuseUnlessRestsSaved(env, provider, computer);
    if (rests instanceof Response) return rests;
    // From here no wake goes through until the delete ends or the claim is given back.
    // Gone already: nothing can wake it, so no claim; the close below finishes the delete.
    const refused = rests === "gone" ? null : await claimSavedDelete(env, computer, now);
    if (refused) return refused;
  }
  /** Nothing was deleted: the claim goes, so the computer takes work again. */
  const giveBack = async () => {
    if (onlyIfSaved) await unclaimSavedDelete(env, computer.instance_id, now);
  };
  if (keepLane) {
    const refused = await markKeepLane(env, provider, computer, shortText(keepLane.branchRef, 300)).catch(async (error: unknown) => {
      await giveBack();
      throw error;
    });
    if (refused) {
      await giveBack();
      return refused;
    }
  } else if (computer.lane_keep_reason) {
    // A plain delete keeps no lane, even after an earlier freeing that didn't finish.
    await unmarkKeepLaneStatement(env, computer.instance_id).run();
  }
  const reason = shortText(body.reason, 200) ?? (keepLane ? "freed" : "user");
  // Whether the provider's delete ran: until it did, every way out gives the mark and the claim back.
  let providerDeleted = false;
  try {
    // A wake that passed before the claim would put work after the save: read again right before the delete.
    if (onlyIfSaved) {
      const refused = await refuseUnlessRestsSaved(env, provider, computer);
      if (refused instanceof Response) return refused;
    }
    await deleteComputer(env, provider, computer, { who, reason }, now);
    providerDeleted = true;
  } catch (error) {
    // The provider deleted it but the row stayed open: the mark and the claim stay, so a
    // retry (with no live computer) or the tick finding it gone closes it with the lane kept.
    if (error instanceof ComputerCloseError) providerDeleted = true;
    throw error;
  } finally {
    if (!providerDeleted) {
      // Nothing was deleted: the mark goes, so a later close can't keep a lane nobody freed,
      // and the claim goes whatever that write does, so the computer takes work again.
      if (keepLane) {
        await unmarkKeepLaneStatement(env, computer.instance_id).run().catch((error: unknown) =>
          reportCloudFailure("cloud.keep_lane_unmark_failed", { instanceId: computer.instance_id, message: error instanceof Error ? error.message : "unknown" }));
      }
      await giveBack();
    }
  }
  // Only the person's delete takes the lane's backups. A failed create, a cancelled
  // launch, a move or a cleanup also keeps no lane here, but the backup may be the lane's only copy.
  if (!keepLane) await deleteBackupsWithComputer(env, computer, reason === "user");
  const size = cloudSizeFor(computer.type, computer.cpu, computer.memory_gb);
  // An agent's delete names its chat; a person's desktop leaves `who` unset.
  captureCloudAction(env, waitUntil, computer.user_id, { action: "delete", plan: await planIdFor(env, computer.user_id), origin: who ? "agent" : "person", tier: tierOf(size) }, computer.instance_id, now);
  return json({ deleted: true });
}

async function handleExec(request: Request, env: CloudEnv, computer: ComputerRow, provider: CloudProvider, { now }: CloudRequestContext): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const command = typeof body.command === "string" ? body.command : "";
  if (!command || command.length > MAX_COMMAND) return badRequest("That command can't be run.");
  const timeoutMs = typeof body.timeoutMs === "number" && Number.isFinite(body.timeoutMs)
    ? Math.min(MAX_EXEC_TIMEOUT_MS, Math.max(1_000, Math.round(body.timeoutMs)))
    : undefined;
  const asleep = !isMeteredStatus(computer.status);
  if (asleep) {
    const accountBlock = await blockedNow(env, computer.user_id);
    if (accountBlock) return accountBlock;
    const { blocked } = await wakeBlocker(env, computer, now);
    if (blocked) return blocked.response;
    const capped = await awakeRoom(env, computer, now, AWAKE_CAP_WAIT_MS);
    if (capped) return capped.response;
  }
  // A person's command during an idle cleanup's save calls its delete off.
  const refused = await idleUseRefusal(env, computer, now);
  if (refused) return refused;
  if (computer.status === "sleeping" || computer.status === "stopped") {
    // A command wakes a sleeping computer: woken here and its status saved, so the awake cap counts it.
    await recordStatus(env, computer, await provider.startInstance(computer.instance_id), now, "exec");
  }
  return json(await provider.exec(computer.instance_id, command, timeoutMs));
}

async function handleTemplate(env: CloudEnv, provider: CloudProvider): Promise<Response> {
  const templateVersion = await readSetting(env, "template_version");
  if (!templateVersion) return json({ exists: false });
  return json({ exists: await provider.hasTemplate(templateVersion) });
}

async function handleList(env: CloudEnv, userId: string, provider: CloudProvider): Promise<Response> {
  const [rows, targets] = await Promise.all([listComputers(env, userId), readUpdateTargets(env)]);
  // The provider list is kept a few seconds (`instanceListCache.ts`), except right after this account's rows changed.
  const changedSince = Date.now() - INSTANCE_LIST_TTL_S * 1000;
  const fresh = rows.some((row) => isPendingId(row.instance_id) || row.created_at > changedSince || row.status_changed_at > changedSince);
  const all = await listInstancesCached(provider, fresh);
  const owned = new Set<string>();
  const pendingRequestIds = new Map<string, string>();
  const rowById = new Map<string, ComputerRow>();
  for (const row of rows) {
    if (isPendingId(row.instance_id)) {
      if (row.request_id) pendingRequestIds.set(row.request_id, row.instance_id);
    } else {
      owned.add(row.instance_id);
      rowById.set(row.instance_id, row);
    }
  }
  // A create cancelled or lost in flight: the client finds it by its request tag.
  const now = Date.now();
  // The lane each computer holds, kept on its row (a computer made before the row kept it, or a branch named since).
  const laneUpdates = all.flatMap((instance) => {
    const row = rowById.get(instance.id);
    const statement = row ? laneFactsStatement(env, instance.id, row, instance.metadata) : null;
    return statement ? [statement] : [];
  });
  if (laneUpdates.length) await env.DB.batch(laneUpdates);
  for (const instance of all) {
    const pendingId = pendingRequestIds.get(instance.metadata.ade_request_id ?? "");
    if (pendingId && !owned.has(instance.id)) {
      const [adopted] = await env.DB.batch(adoptionStatements(env, { pendingId, instance, machineKey: instance.metadata.ade_machine_key ?? null, now, reason: "create_adopted" }));
      if (adopted?.meta.changes === 1) {
        owned.add(instance.id);
        const pending = rows.find((row) => row.instance_id === pendingId);
        if (pending) rowById.set(instance.id, pending);
      }
    }
  }
  return json({
    data: all
      .filter((instance) => owned.has(instance.id))
      .map((instance) => withUseFacts(withUpdateFacts(instance, rowById.get(instance.id), targets), rowById.get(instance.id))),
  });
}

/**
 * A server move's rules, asked before it starts (`handleMoveStart`): the same
 * ones its create checks again when it makes the new computer
 * (`createComputer` with `moveFromInstanceId`), so a move that can't run is
 * refused at once and never makes anything. Null when it may start.
 */
async function moveRefusal(env: CloudEnv, source: ComputerRow, size: CloudSize, { now, waitUntil }: CloudRequestContext): Promise<Response | null> {
  const userId = source.user_id;
  const { account, computers, outOfHoursFor } = await getAccountContext(env, userId, now);
  const { refuse } = cloudActionTracker({ env, waitUntil, userId, plan: planIdOf(account), origin: "person", key: source.instance_id, refusedAction: "move", now });
  const newWork = await newWorkRefusal(env, userId, "move", now, waitUntil);
  if (newWork) return newWork;
  // The size it moves to: a move to a Small never uses hours.
  const empty = outOfHoursFor(size.multiplierMilli);
  if (empty) return refuse(empty);
  if (await freeCapRefuses(env, account, now, waitUntil)) return refuse({ response: cantMakeComputer(), refusal: "owner_limit" });
  if (source.moving_from != null || await env.DB.prepare("select 1 as busy from cloud_computers where moving_from = ? and deleted_at is null limit 1").bind(source.instance_id).first()) {
    return fail("computer_busy", "This computer is in the middle of a move. Try again when the move is done.", 409);
  }
  if (readPlanCleanupChoiceIds(account).includes(source.instance_id)) {
    return fail("computer_busy", "ADE is freeing this computer for your plan, so it can't move now.", 409);
  }
  // As its create checks: an account over its plan gets no move, and the count leaves only this source out.
  const over = overPlanLimits(env, account, computers, "move") ?? await computerLimitCheck(env, account, now, source.instance_id);
  if (over) return refuse(over);
  const tooBig = tierRefusal(size, source.disk_gb, true);
  if (tooBig) return refuse(tooBig);
  return null;
}

function moveDepsFor(env: CloudEnv, provider: CloudProvider | null, ctx: CloudRequestContext): MoveRouteDeps {
  return {
    provider,
    now: ctx.now,
    waitUntil: ctx.waitUntil,
    // The step runs after this request: its own clock, and the free plan's GitHub rules settled as a launch's are.
    createComputer: (userId, launchProvider, extras) => createComputerSettled(env, userId, launchProvider, extras, { now: Date.now(), waitUntil: ctx.waitUntil }),
    forkComputer: (source, jobProvider, extras) => forkComputerSettled(env, source, jobProvider, extras, { now: Date.now(), waitUntil: ctx.waitUntil }),
    refusal: (source, size) => moveRefusal(env, source, size, ctx),
  };
}

/** A server copy's deps: a move's, with the copy's own rules (a fork's). */
function copyDepsFor(env: CloudEnv, provider: CloudProvider | null, ctx: CloudRequestContext): CopyRouteDeps {
  return { ...moveDepsFor(env, provider, ctx), refusal: (source, forkBody) => forkRefusal(env, source, forkBody, ctx) };
}

const instanceRoutes: Record<string, (request: Request, env: CloudEnv, computer: ComputerRow, provider: CloudProvider, ctx: CloudRequestContext) => Promise<Response>> = {
  "POST sleep": (_request, env, computer, provider, { now }) => handleSleepLike(env, computer, provider, now, "user"),
  // The computer's own sleep. `backupReportId` names the backup report it made just before: it rests with those backups.
  "POST idle": async (request, env, computer, provider, { now }) => {
    const body = await readJson(request).catch(() => null);
    const reportId = typeof body?.backupReportId === "string" ? body.backupReportId : null;
    return handleSleepLike(env, computer, provider, now, "idle_request", reportId);
  },
  "POST start": handleStart,
  "POST stop": (_request, env, computer, provider, { now }) => handleStop(env, computer, provider, now),
  "POST update": handleUpdate,
  // The computer asks whether it should update itself (its idle step), and reports in after each brain start.
  "GET update-check": async (_request, env, computer, _provider, { now }) => json(updateCheckOf(computer, await readUpdateTargets(env), now)),
  "POST booted": async (request, env, computer, _provider, { now }) => {
    const body = await readJson(request);
    if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
    const adeVersion = shortText(body.adeVersion, 64);
    const { sleepWhenIdle } = await recordBootReport(env, computer, adeVersion, now);
    // The message queue reads the features (`chatWakeFor`). Every report replaces them: an older image sends none.
    await env.DB.prepare("update cloud_computers set ade_version = coalesce(?, ade_version), ade_version_at = ?, ade_features = ? where instance_id = ?")
      .bind(adeVersion, now, featuresOf(body.features), computer.instance_id).run();
    return json({ ok: true, sleepWhenIdle });
  },
  // The computer's own measure of its disk and its last work, sent at its idle step.
  "POST disk-usage": async (request, env, computer, _provider, { now }) => {
    const body = await readJson(request);
    const report = parseDiskUsageReport(body, now);
    if (!report) return badRequest(UNREADABLE_REQUEST_MESSAGE);
    await recordDiskUsage(env, computer, report);
    // The ignored files a delete would lose (idle cleanup). Unreadable is left out, never a failed report.
    const ignored = body?.ignored == null ? null : parseIgnoredFiles(body.ignored, now);
    if (body?.ignored != null && !ignored) logCloud("cloud.ignored_files_unreadable", { instanceId: computer.instance_id });
    if (ignored) await ignoredFilesStatement(env, computer.instance_id, ignored).run();
    return json({ ok: true });
  },
  // "Keep it" on an idle cleanup warning: the idle clock restarts with no wake and no hours.
  "POST keep": async (_request, env, computer, _provider, { now, waitUntil }) => {
    if (!(await keepIdleComputer(env, waitUntil, await loadAccount(env, computer.user_id, now), computer, now))) {
      return fail("computer_deleting", `Too late to keep it. ${COMPUTER_DELETING_MESSAGE}`, 409);
    }
    return json({ ok: true });
  },
  // The computer's brain: its work started or stopped, or its count of agents changed (never on a timer).
  "POST activity": async (request, env, computer, _provider, { now, waitUntil }) => {
    const report = parseActivityReport(await readJson(request), now);
    if (!report) return badRequest(UNREADABLE_REQUEST_MESSAGE);
    await recordActivity(env, computer.instance_id, report, waitUntil);
    // The network its brain calls from, for Free Small's tripwire (`sponsoredSmall.ts`). Never fails the report.
    await noteComputerNetwork(env, computer, requestNetwork(request)).catch((error: unknown) => {
      reportCloudFailure("cloud.computer_network_failed", { message: error instanceof Error ? error.message : "unknown" });
    });
    return json({ ok: true });
  },
  // A lane's status menu, read when it opens: never wakes the computer (`computerStatus.ts`).
  "GET status": async (_request, env, computer, provider, { now }) => json(await readComputerStatus(env, provider, computer, now)),
  // The computer's own report of hours near full CPU with no chat turn or agent working: a line in the owner's daily report.
  "POST cpu-report": async (request, env, computer, _provider, { now }) => {
    const report = parseSustainedCpuReport(await readJson(request), now);
    if (!report) return badRequest(UNREADABLE_REQUEST_MESSAGE);
    await recordSustainedCpu(env, computer, report, now);
    return json({ ok: true });
  },
  "POST resize": handleResize,
  "POST fork": handleFork,
  // A copy run here a step at a time, signed in with no app open (`copies.ts`).
  "POST copy": (request, env, computer, provider, ctx) => handleCopyStart(request, env, computer, copyDepsFor(env, provider, ctx)),
  // To the other kind (Standard ↔ Full), run here a step at a time (`moves.ts`).
  "POST move": (request, env, computer, provider, ctx) => handleMoveStart(request, env, computer, moveDepsFor(env, provider, ctx)),
  "POST free": (request, env, computer, provider, ctx) => handleFreeStart(request, env, computer, {
    ...moveDepsFor(env, provider, ctx),
    // A resting computer wakes to push its work: the same rules as a command's wake (hours, the awake cap).
    wakeRefusal: async () => {
      if (isMeteredStatus(computer.status)) return null;
      const { blocked } = await wakeBlocker(env, computer, ctx.now);
      if (blocked) return blocked.response;
      return (await awakeRoom(env, computer, ctx.now, AWAKE_CAP_WAIT_MS))?.response ?? null;
    },
  }),
  "POST exec": handleExec,
  "POST backups": async (_request, _env, computer, provider) => json(await provider.createBackup(computer.instance_id)),
  "POST signed-url": async (request, _env, computer, provider) => {
    const body = await readJson(request);
    const port = typeof body?.port === "number" && Number.isInteger(body.port) && body.port > 0 && body.port < 65536 ? body.port : null;
    const ttlSeconds = typeof body?.ttlSeconds === "number" && Number.isFinite(body.ttlSeconds) ? Math.round(body.ttlSeconds) : null;
    if (port == null || ttlSeconds == null || ttlSeconds <= 0 || ttlSeconds > 86_400) return badRequest("That link request isn't valid.");
    return json(await provider.signedUrl(computer.instance_id, { port, ttlSeconds }));
  },
  "POST public-ports": async (request, _env, computer, provider) => {
    const body = await readJson(request);
    if (body?.port !== WAKE_PORT) return badRequest("Only ADE's own wake port can be opened.");
    return json(await provider.addPublicPort(computer.instance_id, { port: WAKE_PORT, label: shortText(body.label, 60) ?? "ADE wake" }));
  },
  "PUT auto-sleep": async (request, _env, computer, provider) => {
    const body = await readJson(request);
    if (typeof body?.autoSleep !== "boolean") return badRequest(UNREADABLE_REQUEST_MESSAGE);
    const seconds = typeof body.idleTimeoutSeconds === "number" ? Math.round(body.idleTimeoutSeconds) : undefined;
    if (seconds !== undefined && (seconds < 300 || seconds > 86_400)) return badRequest("That sleep time isn't valid.");
    await provider.setAutoSleep(computer.instance_id, { autoSleep: body.autoSleep, ...(seconds !== undefined ? { idleTimeoutSeconds: seconds } : {}) });
    return json({ ok: true });
  },
  "PUT name": async (request, env, computer, provider) => {
    const body = await readJson(request);
    const name = computerName(body?.name);
    if (!name) return badRequest("That name isn't valid.");
    await provider.setInstanceName(computer.instance_id, name);
    await env.DB.prepare("update cloud_computers set name = ? where instance_id = ?").bind(name, computer.instance_id).run();
    return json({ ok: true });
  },
  "PUT metadata": async (request, env, computer, provider) => {
    const body = await readJson(request);
    const metadata = body ? stringMap(body.metadata, MAX_METADATA_ENTRIES) : null;
    if (!metadata) return badRequest(UNREADABLE_REQUEST_MESSAGE);
    await provider.setInstanceMetadata(computer.instance_id, metadata);
    const machineKey = metadata.ade_machine_key ?? null;
    const statements: D1PreparedStatement[] = [];
    if (machineKey !== computer.machine_key) {
      statements.push(env.DB.prepare("update cloud_computers set machine_key = ? where instance_id = ?").bind(machineKey, computer.instance_id));
      const named = machineKey ? nameMachineAfterComputerStatement(env, computer, machineKey) : null;
      if (named) statements.push(named);
    }
    const lane = laneFactsStatement(env, computer.instance_id, computer, metadata);
    if (lane) statements.push(lane);
    if (statements.length) await env.DB.batch(statements);
    // Its chat launch's follow-ups waited for this key to join the chat.
    if (machineKey && machineKey !== computer.machine_key) await carryLaunchMessagesForComputer(env, computer.instance_id, Date.now());
    return json({ ok: true });
  },
};

async function routeInstance(request: Request, env: CloudEnv, provider: CloudProvider, userId: string, instanceId: string, action: string | undefined, ctx: CloudRequestContext): Promise<Response> {
  const { now } = ctx;
  if (!CLOUD_INSTANCE_ID.test(instanceId)) return notFound();
  const computer = await ownedComputer(env, userId, instanceId);
  if (!computer) return notFound();
  if (action === undefined) {
    if (request.method === "GET") {
      try {
        const instance = await provider.getInstance(instanceId);
        await recordStatus(env, computer, instance.status, now, "seen");
        await laneFactsStatement(env, instanceId, computer, instance.metadata)?.run();
        return json(withUseFacts(withUpdateFacts(instance, computer, await readUpdateTargets(env)), computer));
      } catch (error) {
        if (error instanceof CloudProviderError && error.status === 404) await markGone(env, computer, now);
        throw error;
      }
    }
    if (request.method === "DELETE") return handleDelete(request, env, computer, provider, ctx);
    return notFound();
  }
  const key = `${request.method} ${action}`;
  const handler = instanceRoutes[key];
  if (!handler) return notFound();
  if (WAKING_ACTIONS.has(key)) {
    const blocked = await blockedNow(env, userId);
    if (blocked) return blocked;
  }
  return handler(request, env, computer, provider, ctx);
}

/** A timed wake must name the caller's own computer and that computer's own wake address. */
async function refuseForeignWake(body: Record<string, unknown> | null, env: CloudEnv, userId: string): Promise<Response | null> {
  // A malformed body is the wake route's to answer.
  if (typeof body?.instanceId !== "string" || typeof body.url !== "string") return null;
  const instanceId = body.instanceId.trim();
  if (!await ownedComputer(env, userId, instanceId)) return notFound();
  const provider = providerFor(env);
  if (!provider) return noProviderKey();
  const normalized = (url: string) => url.trim().replace(/\/+$/, "").toLowerCase();
  let wakeUrl: string | null = null;
  try {
    wakeUrl = (await provider.getInstance(instanceId)).publicPorts.find((port) => port.port === WAKE_PORT)?.url ?? null;
  } catch (error) {
    if (error instanceof CloudProviderError) return fail(error.code, error.message, 502);
    throw error;
  }
  return wakeUrl && normalized(wakeUrl) === normalized(body.url) ? null : badRequest("That isn't this computer's wake address.");
}

const BILLING_PATHS = new Set<string>([CLOUD_PATHS.billingCheckout, CLOUD_PATHS.billingPortal, CLOUD_PATHS.billingExtraHours, CLOUD_PATHS.billingPlanCleanup, CLOUD_PATHS.billingFreeUnlock]);

/**
 * Where Stripe sends the person back: this server's own page, or the hosted
 * web client when the request asks for it (`returnTo: "web"`). The web
 * address is this server's own `WEB_CLIENT_ORIGIN`, never one the request
 * names, so no request can make Stripe send anyone anywhere else. Null for a
 * `returnTo` this server can't honour (an unknown value, or no web client).
 */
function billingReturnOf(env: CloudEnv, url: URL, returnTo: unknown): BillingReturnUrlFor | null {
  if (returnTo === undefined) return accountReturnUrl(env, url.origin);
  if (returnTo !== "web") return null;
  const webOrigin = trustedHttpsOrigin(env.WEB_CLIENT_ORIGIN, { requireExactOrigin: true });
  return webOrigin ? webReturnUrl(webOrigin) : null;
}

/** `POST /cloud/billing/checkout`: buy a plan, or change to another one. */
async function routeCheckout(
  env: CloudEnv,
  userId: string,
  body: Record<string, unknown>,
  back: BillingReturnUrlFor,
  offers: ReturnType<typeof cloudOffers>,
  { now, waitUntil }: CloudRequestContext,
): Promise<Response> {
  // Builds that know one paid plan send no body: that's Plus.
  if (body.plan !== undefined && !(body.plan === "plus" || (body.plan === "pro" && offers.pro) || (body.plan === "max" && offers.max))) {
    return badRequest("That plan isn't one ADE Cloud offers.");
  }
  // A downgrade's pick: the computers ADE frees, and whether their work is pushed first.
  const cleanup = body.cleanup === undefined ? undefined : readPlanCleanupPick(body.cleanup);
  if (cleanup === null) return badRequest("Name the computers to free and whether to push their work first.");
  // A build from before Max reads a Max plan as Plus, so its "Move to Pro" would be a silent downgrade.
  // Builds that know Max say so (`knowsMax`); an older one changes a Max plan only in the billing portal.
  if (body.knowsMax !== true) {
    const bought = await env.DB.prepare("select plan, paid_plan from cloud_accounts where user_id = ?").bind(userId).first<{ plan: string; paid_plan: string | null }>();
    if (bought?.plan === "paid" && bought.paid_plan === "max") {
      logCloud("cloud.plan_change_old_build_refused", { userId });
      return fail("update_needed", "Update ADE to change your Max plan, or change it in Manage billing.", 409);
    }
  }
  return json(await createCheckoutUrl(env, userId, back, now, isPaidPlanId(body.plan) ? body.plan : undefined, waitUntil, cleanup));
}

/** The billing routes, or null when `path` isn't one of them. */
async function routeBilling(request: Request, url: URL, path: string, env: CloudEnv, userId: string, { now, waitUntil }: CloudRequestContext): Promise<Response | null> {
  if (!BILLING_PATHS.has(path)) return null;
  if (request.method !== "POST") return notFound();
  const offers = cloudOffers(env);
  try {
    // The desktop sends the portal no body, which reads as `{}`.
    const body = await readJson(request);
    if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
    if (path === CLOUD_PATHS.billingPortal || path === CLOUD_PATHS.billingFreeUnlock || path === CLOUD_PATHS.billingCheckout) {
      const back = billingReturnOf(env, url, body.returnTo);
      if (!back) return badRequest("ADE Cloud can't send you back there after billing.");
      if (path === CLOUD_PATHS.billingPortal) return json(await createPortalUrl(env, userId, back, now));
      // A card saved with no charge starts the free hours of a GitHub account younger than 30 days.
      if (path === CLOUD_PATHS.billingFreeUnlock) return json(await createFreeUnlockUrl(env, userId, back, { now, waitUntil }));
      return await routeCheckout(env, userId, body, back, offers, { now, waitUntil });
    }
    if (path === CLOUD_PATHS.billingPlanCleanup) {
      const pick = readPlanCleanupPick(body);
      if (!pick) return badRequest("Name the computers to free and whether to push their work first.");
      await pickPlanCleanup(env, userId, body.planId, pick, now);
      return json(await buildAccountState(env, userId, now, request));
    }
    if (typeof body.enabled !== "boolean") return badRequest(UNREADABLE_REQUEST_MESSAGE);
    await setExtraHours(env, userId, body.enabled, now);
    // A running phone may use extra credits: off, it is held to the balance at once.
    if (!body.enabled) await enforcePhoneAllowance(env, userId, now);
    return json(await buildAccountState(env, userId, now, request));
  } catch (error) {
    if (error instanceof CloudBillingError) return fail(error.code, error.message, error.status);
    throw error;
  }
}

/**
 * When a request settles the free plan for its computer: `use` for what
 * spends hours (a create or move, a copy, a wake), `read` for the account and
 * referral reads, null for the rest (they need no answer about it).
 */
function freePlanMomentOf(method: string, path: string): "read" | "use" | null {
  if (method === "GET" && (path === CLOUD_PATHS.account || path === CLOUD_PATHS.referrals)) return "read";
  if (method !== "POST") return null;
  // A phone start settles them in `phones.ts`, once its access is known.
  if (path === CLOUD_PATHS.instances) return "use";
  const action = instanceRouteOf(path)?.action;
  return action === "start" || action === "fork" || action === "copy" ? "use" : null;
}

/**
 * A launch's start and an automation's Run now also make a computer. The
 * computer's free-plan claim never moved on them (a server launch may carry no
 * computer id), but the GitHub rules are the server's own, so they settle there too.
 */
function startsComputerElsewhere(method: string, path: string): boolean {
  if (method !== "POST") return false;
  return path === CLOUD_PATHS.launches || (path.startsWith(`${CLOUD_PATHS.automations}/`) && path.endsWith("/run"));
}

/** `/cloud/instances/<id>/<action>/<rest...>`, or null for any other path. */
function instanceRouteOf(path: string): { instanceId: string; action: string | undefined; rest: string[] } | null {
  if (!path.startsWith(`${CLOUD_PATHS.instances}/`)) return null;
  const [instanceId = "", action, ...rest] = path.slice(CLOUD_PATHS.instances.length + 1).split("/");
  return { instanceId, action, rest };
}

const CORS_METHODS = "GET, POST, PUT, DELETE";
const CORS_HEADERS = new Set(["authorization", "content-type", "x-ade-correlation-id"]);

function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** A blocked account's GET of a route it may still read (CONTRACTS 4). */
function blockedMayRead(method: string, path: string): boolean {
  if (method !== "GET") return false;
  return CLOUD_BLOCKED_READ_ROUTES.some((route) => path === route || path.startsWith(`${route}/`));
}

const EVENT_WAKES_ROUTE = /^\/cloud\/instances\/([^/]+)\/event-wakes$/;
/** `PUT /cloud/launches/:launch/files/:file`: a file for a launch or a queued message. */
const LAUNCH_FILE_ROUTE = /^\/cloud\/launches\/[^/]+\/files\/[^/]+$/;

/** The minute budget a write to these rows counts against (`takeRequest`); null for a read or another route. */
function writeBucketOf(path: string, method: string): CloudRequestBucket | null {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
  if ([CLOUD_PATHS.sessions, CLOUD_PATHS.git, CLOUD_PATHS.capsules, CLOUD_PATHS.backups].some((route) => path.startsWith(`${route}/`))) return "uploads";
  if (LAUNCH_FILE_ROUTE.test(path)) return "uploads";
  if (path === CLOUD_EDGE_PATHS.limits || EVENT_WAKES_ROUTE.test(path)) return "settings";
  return null;
}

/** `/cloud/chats/:m/:c/messages[/:msg]`. */
function chatMessagesRouteOf(path: string): { machineKey: string; chatId: string; rest: string[] } | null {
  if (!path.startsWith(`${CLOUD_PATHS.chats}/`)) return null;
  const segments = path.slice(CLOUD_PATHS.chats.length + 1).split("/").map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return "";
    }
  });
  const [machineKey, chatId, action, ...rest] = segments;
  if (action !== "messages" || !machineKey || !chatId || !ROW_ID.test(machineKey) || !ROW_ID.test(chatId)) return null;
  return { machineKey, chatId, rest };
}

/** What a start of a server launch needs, for `POST /cloud/launches` and the queue's continue launch alike. */
function launchDepsFor(request: Request, env: CloudEnv, userId: string, provider: CloudProvider | null, ctx: CloudRequestContext): LaunchRouteDeps {
  const authorization = request.headers.get("authorization");
  return {
    provider,
    now: ctx.now,
    createComputer: (launchUserId, launchProvider, extras) => createComputer(env, launchUserId, launchProvider, extras, ctx),
    gitCheck: (origin) => serverGitCheck(env, authorization, origin, userId),
    // A new launch makes a computer: the owner's kill switch and the hourly limit (never a replay of one).
    refuseNewLaunch: () => newWorkRefusal(env, userId, "launch", ctx.now, ctx.waitUntil),
    onProgress: (record) => noteAutomationLaunchProgress(env, record, { now: ctx.now }),
  };
}

/**
 * `POST /cloud/instances/:id/use`, from the computer: real work on it (a
 * message drained, a person at its terminal). Moves `last_active_at`, which
 * calls an idle cleanup's delete off (`cameBack`, `claimDelete`), and marks
 * the use during a save like a person's start (`recordIdleUse`).
 */
async function handleComputerUse(env: CloudEnv, computer: ComputerRow, now: number): Promise<Response> {
  await env.DB.prepare("update cloud_computers set last_active_at = max(coalesce(last_active_at, 0), ?) where instance_id = ? and deleted_at is null")
    .bind(now, computer.instance_id).run();
  const refused = await idleUseRefusal(env, computer, now);
  return refused ?? json({ ok: true });
}

/** The known features of a boot report, as the stored comma list; null when it sent none. */
function featuresOf(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const known = CLOUD_COMPUTER_FEATURES.filter((feature) => value.includes(feature));
  return known.length ? known.join(",") : null;
}

const UPDATE_NEEDED_MESSAGE = "This computer runs an older ADE that can't take messages while it sleeps. Open the lane and update the computer, then send again.";
/** Long enough for a woken computer's ADE to start and send what waits; a drain that runs longer goes on by itself. */
const DRAIN_EXEC_TIMEOUT_MS = 120_000;

/**
 * The queue's wake (CONTRACTS 3.1): every check `/start` makes, before the
 * message is stored, then the wake and the drain after the answer.
 */
function chatWakeFor(env: CloudEnv, userId: string, provider: CloudProvider | null, ctx: CloudRequestContext, launchDeps: LaunchRouteDeps): ChatWake {
  const { now } = ctx;
  // The plan's refusals, for every send: the account's block, an outside agent
  // on the free plan, credits at `multiplierMilli` (the computer's size, or the
  // one a move that holds the send lands on, as `moveRefusal` checked it).
  const planRefusal = async (computer: ComputerRow, outsideAgent: boolean, multiplierMilli = computer.multiplier_milli): Promise<Response | null> => {
    const accountBlock = await blockedNow(env, computer.user_id);
    if (accountBlock) return accountBlock;
    const { account, blocked } = await wakeBlocker(env, computer, now, multiplierMilli);
    const outside = outsideAgentRefusal(account, outsideAgent);
    if (outside) {
      cloudActionTracker({ env, waitUntil: ctx.waitUntil, userId: computer.user_id, plan: planIdOf(account), origin: "agent", key: computer.instance_id, refusedAction: "wake", now }).refuse(outside);
      return outside.response;
    }
    return blocked?.response ?? null;
  };
  return {
    heldCheck: async (computer, { outsideAgent }, landsOn) => await planRefusal(computer, outsideAgent, landsOn?.multiplierMilli),
    check: async (computer, { outsideAgent }) => {
      const planRefused = await planRefusal(computer, outsideAgent);
      if (planRefused) return planRefused;
      if (computer.update_state === "updating") return fail("update_in_progress", new CloudUpdateInProgressError().message, 409);
      // A computer that never reported `chat_queue` can't drain, and the image a
      // wake would update it to may have no drain either: the client wakes it and sends.
      if (!computer.ade_features?.split(",").includes("chat_queue")) {
        return fail("update_needed", UPDATE_NEEDED_MESSAGE, 409);
      }
      const awake = isMeteredStatus(computer.status);
      if (!awake && provider) {
        // The provider suspends a computer whose plan payment failed: the server's own sentence, before anything is stored.
        const listed = (await listInstancesCached(provider, false)).find((instance) => instance.id === computer.instance_id);
        if (listed?.pastDue) return fail("plan_past_due", CLOUD_PLAN_PAST_DUE_SENTENCE, 402);
      }
      const capped = await awakeRoom(env, computer, now, AWAKE_CAP_WAIT_MS);
      if (capped) return capped.response;
      const refused = await idleUseRefusal(env, computer, now);
      if (refused) return refused;
      return { state: awake && computer.idle_claimed_at == null ? "awake" : "waking" };
    },
    wakeAndDrain: async (computer) => {
      if (!provider) {
        reportCloudFailure("cloud.no_provider_key");
        return;
      }
      if (!isMeteredStatus(computer.status) || computer.idle_claimed_at != null) {
        await recordStatus(env, computer, await provider.startInstance(computer.instance_id), now, "chat_message");
      }
      // The exec wakes it too; a failure is harmless: its ADE drains the queue when it starts.
      await provider.exec(computer.instance_id, CLOUD_COMPUTER_COMMANDS.drainMessages, DRAIN_EXEC_TIMEOUT_MS);
    },
    startLaunch: (parsed) => startServerLaunch(env, userId, parsed, launchDeps),
  };
}

/**
 * `/cloud/*` straight from a browser and a phone (C7). CORS is the
 * directory's rule (`handleRequest`): only the hosted web client's exact
 * origin, never `*`; a native caller sends no Origin and passes. Any other
 * Origin is refused before the token, D1 or the provider is touched.
 */
export async function handleCloudRequest(request: Request, env: CloudEnv, waitUntil?: CloudWaitUntil): Promise<Response> {
  const requestOrigin = request.headers.get("origin");
  const allowedOrigin = trustedHttpsOrigin(env.WEB_CLIENT_ORIGIN, { requireExactOrigin: true });
  const corsOrigin = requestOrigin && allowedOrigin && requestOrigin === allowedOrigin ? allowedOrigin : null;
  if (request.method === "OPTIONS") {
    if (!corsOrigin) return fail("origin_not_allowed", "This origin can't call ADE Cloud.", 403);
    const wanted = request.headers.get("access-control-request-method")?.toUpperCase() ?? "";
    if (!CORS_METHODS.split(", ").includes(wanted)) return fail("bad_request", "That method isn't allowed here.", 405);
    const requested = (request.headers.get("access-control-request-headers") ?? "")
      .split(",").map((header) => header.trim().toLowerCase()).filter(Boolean);
    if (requested.some((header) => !CORS_HEADERS.has(header))) return fail("origin_not_allowed", "Those headers aren't allowed.", 403);
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": corsOrigin,
        "access-control-allow-headers": [...CORS_HEADERS].join(", "),
        "access-control-allow-methods": `${CORS_METHODS}, OPTIONS`,
        "access-control-max-age": "600",
        vary: "Origin",
      },
    });
  }
  if (requestOrigin && !corsOrigin) return fail("origin_not_allowed", "This origin can't call ADE Cloud.", 403);
  const response = await routeCloudRequest(request, env, waitUntil);
  return corsOrigin ? withCors(response, corsOrigin) : response;
}

async function routeCloudRequest(request: Request, env: CloudEnv, waitUntil?: CloudWaitUntil): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  // The owner's block routes: CLOUD_OWNER_TOKEN is the proof, never an account token.
  if (isCloudOwnerRequest(path)) {
    return providerCall(() => handleCloudOwnerRequest(request, env, path, { provider: providerFor(env), now: Date.now(), waitUntil }));
  }
  // NoMac's webhook: its own signature is the proof, never an account token.
  if (isNomacWebhookRequest(path, request.method)) return handleNomacWebhook(request, env, Date.now(), waitUntil);
  // The phone viewer page is static: the view link's `#` part (never sent here) names the phone.
  if (isPhoneViewerRequest(path, request.method)) return handlePhoneViewer();
  // The provider's status webhook: its Standard Webhooks signature is the proof, never an account token.
  if (isAgent37WebhookRequest(path, request.method)) return handleAgent37Webhook(request, env, Date.now(), { provider: providerFor(env), waitUntil });
  // The new computer's join has no account token yet: its one-time code is the proof.
  if (isLaunchJoinRequest(path, request.method)) {
    return providerCall(() => handleLaunchJoin(request, env, path, { provider: providerFor(env), now: Date.now() }));
  }
  // The webhook relay's forward of a cloud automation's delivery: the hook's own signature is the proof.
  if (isAutomationDeliveryRequest(path, request.method)) {
    const now = Date.now();
    const provider = providerFor(env);
    return providerCall(() => handleAutomationDelivery(request, env, path, {
      provider,
      now,
      createComputer: (userId, launchProvider, extras) => createComputerSettled(env, userId, launchProvider, extras, { now, waitUntil }),
    }));
  }
  // The webhook relay's read of the accounts deleted in the last day: the same shared secret.
  if (isDeletedAccountsListRequest(path)) return handleDeletedAccountsList(request, env);
  // The webhook relay's event wake: its shared secret is the proof, no account token.
  if (isInternalEventWakeRequest(path)) {
    return providerCall(() => handleInternalEventWake(request, env, (computer, now) => eventWakeComputer(env, computer, now), Date.now()));
  }
  const caller = await authenticate(request, env);
  if (!caller.ok) {
    return caller.reason === "authentication unavailable"
      ? fail("unavailable", "ADE Cloud can't check your sign-in right now. Try again soon.", 503)
      : fail("unauthorized", "Sign in to ADE to use ADE Cloud.", 401);
  }
  // Every account may use ADE Cloud, except one the owner blocked (`safety.ts`).
  const blocked = await isCloudBlockedForRequest(env, caller.userId);
  if (path === CLOUD_PATHS.access) {
    // Older apps still ask before they show ADE Cloud. A blocked account still reads what it has.
    if (request.method !== "GET") return fail("not_found", NOT_FOUND_MESSAGE, 404);
    return json((blocked ? { enabled: false, readOnly: true, reason: ACCOUNT_BLOCKED_MESSAGE } : { enabled: true }) satisfies CloudAccess);
  }
  // A blocked account reads what ADE Cloud keeps for it (GET only, `CLOUD_BLOCKED_READ_ROUTES`) and does nothing.
  if (blocked && !blockedMayRead(request.method, path)) return accountBlocked();
  if (blocked && path === CLOUD_PATHS.account) {
    return json({ ...(await buildAccountState(env, caller.userId, Date.now(), request)), blocked: true });
  }
  if (isCloudWakeRequest(url)) {
    // Scheduled work is refused at 0 hours; a timed wake would break the stop.
    if (request.method === "PUT") {
      const accountBlock = await blockedNow(env, caller.userId);
      if (accountBlock) return accountBlock;
      // Read once: the ownership check and the wake handler share this body.
      // Reading a clone with the bounded reader can wait on the other branch.
      const body = await readBoundedJson(request, 4096);
      const refused = await refuseForeignWake(body, env, caller.userId);
      if (refused) return refused;
      // At 0 hours only a computer whose size uses hours can't take a timed wake: a Small one can.
      const computer = typeof body?.instanceId === "string" ? await ownedComputer(env, caller.userId, body.instanceId.trim()) : null;
      if (computer) {
        const { blocked } = await wakeBlocker(env, computer, Date.now());
        if (blocked) return blocked.response;
      }
      return handleCloudWakeRequest(request, env, Date.now(), body);
    }
    return handleCloudWakeRequest(request, env);
  }

  const provider = providerFor(env);
  const now = Date.now();
  const ctx: CloudRequestContext = { now, waitUntil };
  // One free plan per computer (`freePlan.ts`) and per GitHub account (`freePlanGithub.ts`): settled before the request's own hours check.
  const freePlanMoment = freePlanMomentOf(request.method, path);
  if (freePlanMoment || startsComputerElsewhere(request.method, path)) {
    const account = await loadAccount(env, caller.userId, now);
    if (freePlanMoment) await settleFreePlanComputer(env, account, readComputerSignal(request), freePlanMoment, ctx);
    await settleFreePlanGithub(env, account, ctx);
  }
  if (path === CLOUD_PATHS.account) {
    return request.method === "GET" ? json(await buildAccountState(env, caller.userId, now, request)) : notFound();
  }
  // The ADE Cloud iPhone: no computer, so no provider (`phones.ts`).
  const phone = await routePhone(request, path, env, caller.userId, now, waitUntil);
  if (phone) return phone;
  const referrals = await routeReferrals(request, path, env, caller.userId, ctx);
  if (referrals) return referrals;
  const billing = await routeBilling(request, url, path, env, caller.userId, ctx);
  if (billing) return billing;
  // Sponsored cards and the Index (`gravity.ts`): rows and Gravity only, no provider.
  if (path.startsWith("/cloud/sponsored/")) {
    if (!await takeRequest(env, caller.userId, "sponsored", now)) return tooManyRequests();
    const sponsored = await routeSponsored(request, path, env, caller.userId, now, waitUntil);
    if (sponsored) return sponsored;
  }
  // ADE without a computer: rows and R2 only; a send wakes or launches through the provider.
  const writeBucket = writeBucketOf(path, request.method);
  if (writeBucket && !await takeRequest(env, caller.userId, writeBucket, now)) return tooManyRequests();
  if (path === CLOUD_PATHS.projectsOverview) {
    return request.method === "GET" ? handleProjectOverview(url, env, caller.userId, now) : notFound();
  }
  if (path === CLOUD_PATHS.sessions || path.startsWith(`${CLOUD_PATHS.sessions}/`)) return routeSessionCopies(request, url, path, env, caller.userId, now);
  if (path === CLOUD_PATHS.git || path.startsWith(`${CLOUD_PATHS.git}/`)) return routeGitSummaries(request, url, path, env, caller.userId, now);
  if (path.startsWith(`${CLOUD_PATHS.capsules}/`)) return routeForkCapsules(request, path, env, caller.userId, now);
  // Lane backups: rows and R2 only, so a person gets their work back with no wake and no hours.
  if (path === CLOUD_PATHS.backups || path.startsWith(`${CLOUD_PATHS.backups}/`)) return routeLaneBackups(request, url, path, env, caller.userId, now);
  const chatMessages = chatMessagesRouteOf(path);
  if (chatMessages) {
    return providerCall(() => routeChatMessages(request, env, caller.userId, chatMessages.machineKey, chatMessages.chatId, chatMessages.rest, {
      now,
      waitUntil,
      wake: chatWakeFor(env, caller.userId, provider, ctx, launchDepsFor(request, env, caller.userId, provider, ctx)),
    }));
  }
  const computerRoute = instanceRouteOf(path);
  if (computerRoute && (computerRoute.action === "messages" || computerRoute.action === "use")) {
    if (!CLOUD_INSTANCE_ID.test(computerRoute.instanceId)) return notFound();
    const computer = await ownedComputer(env, caller.userId, computerRoute.instanceId);
    if (!computer) return notFound();
    if (computerRoute.action === "messages") return routeComputerMessages(request, env, computer, computerRoute.rest, now);
    if (computerRoute.rest.length || request.method !== "POST") return notFound();
    return handleComputerUse(env, computer, now);
  }
  // Saved chats need no provider: they stay readable when the computer can't be.
  if (path === CLOUD_PATHS.chats || path.startsWith(`${CLOUD_PATHS.chats}/`)) {
    return routeSavedChats(request, url, path, env, caller.userId, now, waitUntil);
  }
  // Lanes without a computer are rows only: readable with no provider, like saved chats.
  if (path === CLOUD_PATHS.lanesWithoutComputer || path.startsWith(`${CLOUD_PATHS.lanesWithoutComputer}/`)) {
    // A forgotten lane's saved work and its chats under every computer go with it.
    // A lane moved to the person's own machine keeps what moved there (and its backups when that lane has other work).
    return routeLanesWithoutComputer(request, path, env, caller.userId, async (laneId, keep) => {
      if (!keep?.backups) await deleteBackupsForLane(env, caller.userId, laneId);
      await deleteSavedChatsForLaneEverywhere(env, caller.userId, laneId, keep?.machineKey ?? null);
    });
  }
  // The account vault's ADE Cloud sign-ins, for the web (status only), and the model list: no provider needed.
  if (path === CLOUD_PATHS.signIns || path.startsWith(`${CLOUD_PATHS.signIns}/`)) return routeAccountSignIns(request, path, env, now);
  // Account data and integrations with no computer; no provider needed.
  if (path === CLOUD_EDGE_PATHS.limits) return routeCloudLimits(request, env);
  if (path === CLOUD_EDGE_PATHS.accountSecrets) return routeAccountSecrets(request, url, env);
  if (path === CLOUD_EDGE_PATHS.cto) return routeCtoCopy(request, url, env);
  if (path === CLOUD_EDGE_PATHS.linearQuery) return routeLinearQuery(request, env, caller.userId, now, waitUntil);
  if (path === CLOUD_EDGE_PATHS.jiraSearch) return routeJiraSearch(request, env, caller.userId, now);
  if (path === CLOUD_EDGE_PATHS.jiraIssue) return routeJiraIssue(request, env, caller.userId, now);
  const eventWakes = EVENT_WAKES_ROUTE.exec(path);
  if (eventWakes) return CLOUD_INSTANCE_ID.test(eventWakes[1]!) ? routeEventWakeSubscription(request, env, caller.userId, eventWakes[1]!, now) : notFound();
  if (path === CLOUD_PATHS.models) return handleCloudModels(request);
  // The server launcher: a launch's record reads with no provider; only the start and a cancel need it.
  if (path === CLOUD_PATHS.launches || path.startsWith(`${CLOUD_PATHS.launches}/`)) {
    return providerCall(() => routeLaunches(request, path, env, caller.userId, launchDepsFor(request, env, caller.userId, provider, ctx)));
  }
  // Automations on ADE Cloud: rows only, except a run's start (Run now), which makes a computer.
  if (path === CLOUD_PATHS.automations || path.startsWith(`${CLOUD_PATHS.automations}/`)) {
    return providerCall(() => routeAutomations(request, url, path, env, caller.userId, {
      provider,
      now,
      createComputer: (userId, launchProvider, extras) => createComputer(env, userId, launchProvider, extras, ctx),
    }));
  }
  // A server move's record reads with no provider; a cancel undoes what the move made when one is there.
  if (path === CLOUD_PATHS.moves || path.startsWith(`${CLOUD_PATHS.moves}/`)) {
    return providerCall(() => routeMoves(request, path, env, caller.userId, moveDepsFor(env, provider, ctx)));
  }
  // A server free's record; a watched one runs its due step after the answer.
  if (path.startsWith(`${CLOUD_PATHS.frees}/`)) return providerCall(() => routeFrees(request, path, env, caller.userId, moveDepsFor(env, provider, ctx)));
  // A server copy's record reads with no provider; a watched one runs its due step after the answer, and a cancel deletes the copy.
  if (path === CLOUD_PATHS.copies || path.startsWith(`${CLOUD_PATHS.copies}/`)) {
    return providerCall(() => routeCopies(request, path, env, caller.userId, moveDepsFor(env, provider, ctx)));
  }
  // The job's rows only; the minute cron does the work.
  if (path === CLOUD_PATHS.projectComputersDelete || path.startsWith(`${CLOUD_PATHS.projectComputersDelete}/`)) {
    return routeProjectComputersDelete(request, path, env, caller.userId, now);
  }
  if (!provider) {
    reportCloudFailure("cloud.no_provider_key");
    return noProviderKey();
  }
  return providerCall(async () => {
    if (path === CLOUD_PATHS.instances) {
      if (request.method === "GET") return handleList(env, caller.userId, provider);
      if (request.method === "POST") return handleCreate(request, env, caller.userId, provider, ctx);
      return notFound();
    }
    if (path.startsWith(`${CLOUD_PATHS.templates}/`) && request.method === "GET") return handleTemplate(env, provider);
    const instanceRoute = instanceRouteOf(path);
    if (instanceRoute) {
      if (instanceRoute.action === "sign-ins") {
        if (!CLOUD_INSTANCE_ID.test(instanceRoute.instanceId)) return notFound();
        const computer = await ownedComputer(env, caller.userId, instanceRoute.instanceId);
        if (!computer) return notFound();
        // Signing in on the computer is use, even during an idle cleanup's save.
        const refused = await idleUseRefusal(env, computer, now);
        if (refused) return refused;
        return routeSignIns(request, computer, instanceRoute.rest, {
          provider,
          isAwake: isMeteredStatus(computer.status),
          isStopped: computer.status === "stopped",
          startStopped: async () => recordStatus(env, computer, await provider.startInstance(computer.instance_id), now, "sign_in"),
          wakeBlocked: async () => (await blockedNow(env, caller.userId))
            ?? (await wakeBlocker(env, computer, now)).blocked?.response
            ?? (await awakeRoom(env, computer, now))?.response ?? null,
        });
      }
      if (instanceRoute.rest.length) return notFound();
      return routeInstance(request, env, provider, caller.userId, instanceRoute.instanceId, instanceRoute.action, ctx);
    }
    return notFound();
  });
}
