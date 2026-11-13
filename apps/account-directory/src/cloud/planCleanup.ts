import { captureCloudAction } from "./analytics";
import {
  CLOUD_PLAN_SENTENCE_NAMES,
  planCleanupDoneSentence,
  planCleanupSentence,
  type CloudPlanCleanup,
  type CloudPlanCleanupComputer,
  type CloudPlanCleanupDone,
  type CloudPlanCleanupPick,
  type CloudPlanId,
} from "./contract";
import { sendCloudEmail } from "./email";
import { cloudAccessAllows } from "./http";
import { laneFactsOf, laneFactsOfRow, markKeepLaneStatement, mergeLaneFacts, namesLane, unmarkKeepLaneStatement } from "./lanesWithoutComputer";
import { AWAKE_COMPUTER_CAP, CLOUD_PLANS, cloudSizeFor, extraDiskMonthFits, isMeteredStatus, tierOf } from "./plans";
import { CloudProviderError, type CloudProvider } from "./provider";
import {
  boughtPlanIdOf,
  cloudOffers,
  countedDiskGb,
  deleteComputer,
  groupByUser,
  isPendingId,
  isProduction,
  listComputers,
  logCloud,
  planDiskGbOf,
  powerLogStatement,
  reportCloudFailure,
  statusChangeStatements,
  type AccountRow,
  type CloudEnv,
  type ComputerRow,
} from "./store";

/**
 * A cheaper plan's limits, by the owner's rules of 2026-11-13 (they replace
 * Cloud 5's grace period): ADE never removes a computer on its own, and
 * there is no grace period. A move from Pro to Plus, a cancel, or a plan that
 * ends after failed payments is still never refused.
 *
 * - In ADE, a downgrade that would leave more disk than the new plan allows
 *   asks first. Only disk counts: there is no limit on how many computers. The person cleans up themselves (the downgrade is
 *   not made), or picks the computers ADE frees and whether their work is
 *   pushed to GitHub first (`CloudPlanCleanupPick`). The server checks the
 *   pick names only the account's computers and makes the account fit
 *   (`checkPlanCleanupPick`), changes the plan, and records the pick
 *   (`recordPlanCleanupPick`); the minute cron frees exactly those computers
 *   at once (`runPlanCleanupPicks`), a few a tick.
 * - Made outside ADE (the billing portal, a plan that ended), nobody can be
 *   asked. Nothing is deleted. Once the cheaper plan is in force and the
 *   account is still over it, new computers are refused (`over_plan_limits`)
 *   and the person is told once (`runPlanLimitChecks`), until they clean up
 *   or pick in ADE (`POST /cloud/billing/plan-cleanup`, the same check and
 *   the same freeing).
 *
 * Freeing a computer is "keep the lane, free its computer". With push on,
 * the computer's own ADE interrupts its agents, saves its chats and pushes
 * every lane's work to its branch on GitHub (`ade cloud prepare-stop`,
 * `ade cloud push-work`); a second read (`ade cloud work-state`) must find
 * nothing left; a computer whose work can't all be pushed stays, and the
 * person is told. With push off, ADE saves what it can without waking the
 * computer and deletes it. Either way the lane stays as a lane without a
 * computer (reason `plan_limit`), with its chats; the next message to it makes
 * a new computer from its branch, under the plan's limits like any other.
 * A `past_due` account is never cleaned: Stripe is still trying the card.
 */

const DAY_MS = 24 * 60 * 60_000;
/** Most computers one tick frees, across accounts; they run in parallel. */
const CLEANUPS_PER_TICK = 4;
/** A claim older than this was lost mid-run (the Worker died): another tick may take the computer. */
const CLAIM_STALE_MS = 20 * 60_000;
/** A start answered; ADE on the computer answers a few seconds after it runs. */
const WAKE_WAIT_MS = 3 * 60_000;
const WAKE_POLL_MS = 5_000;
/** Like the person's push-work wake: not charged, and the tick's stops and sleeps leave it alone. */
const FREE_WAKE_MS = 15 * 60_000;
/** Interrupt and save first (40 s, as the 0-hours stop), then push: bounded like the desktop's 3-minute push. */
const PREPARE_TIMEOUT_MS = 90_000;
const PUSH_TIMEOUT_MS = 4 * 60_000;
const CHECK_TIMEOUT_MS = 2 * 60_000;
const DONE_SHOWN_MS = 14 * DAY_MS;
/** Most computers one pick names. */
const MAX_PICKED = 50;

/** `$ADE_HOME/bin` holds the newer ADE; ADE on the computer answers a few seconds after a start. Shared by every server-run command on a computer. */
export const commandWith = (...lines: string[]) => [
  'export PATH="$ADE_HOME/bin:$PATH"',
  'i=0; until ade projects list --json >/dev/null 2>&1 || [ "$i" -ge 25 ]; do sleep 1; i=$((i+1)); done',
  ...lines,
].join("\n");
const PREPARE_COMMAND = commandWith("ade cloud prepare-stop --timeout 40 --json");
const PUSH_COMMAND = commandWith("ade cloud push-work --json");
const CHECK_COMMAND = commandWith("ade cloud work-state --json");

type CleanupComputerRow = ComputerRow & { plan_cleanup_claimed_at?: number | null; plan_cleanup_failed_at?: number | null };

/** The person's pick while ADE frees it (`plan_cleanup_choice_json`). `at` names it: a new pick is a new `at`. */
export type PlanCleanupChoice = CloudPlanCleanupPick & { planId: CloudPlanId; at: number };

/* ---- Which plan, and what goes over it ---- */

/**
 * The plan whose limits hold the account now: what it pays for. Null while
 * `past_due` (Stripe still tries the card, and its computers keep working).
 */
export function cleanupPlanOf(account: Pick<AccountRow, "plan" | "paid_plan" | "stripe_status">): CloudPlanId | null {
  if (account.plan === "paid" && account.stripe_status === "past_due") return null;
  return boughtPlanIdOf(account);
}

/** The cheaper plan a downgrade or a cancel waits for at the period end, or null. */
export function waitingPlanOf(account: Pick<AccountRow, "plan" | "stripe_status" | "cancel_at_period_end" | "paid_plan_next">): CloudPlanId | null {
  if (account.plan !== "paid" || account.stripe_status === "past_due") return null;
  if (account.cancel_at_period_end === 1) return "free";
  return account.paid_plan_next ?? null;
}

type PlanRoom = { planId: CloudPlanId; diskCapGb: number; limitGb: number };

/** What a cleanup reads of the account: its plan, its terms and its extra disk. */
type CleanupAccount = Pick<AccountRow, "plan" | "paid_plan" | "stripe_status" | "old_plan_terms" | "extra_disk_state" | "extra_disk_limit_cents">;

/**
 * What `planId` lets `computers` hold: disk only. The plan in force keeps the
 * account's terms (a period that began before Cloud 7 keeps the old disk); any
 * other plan starts with a new period, on the new terms. On a paid plan, disk
 * that extra disk covers (on, set up, and a full month of the overage inside
 * its limit) counts as fitting.
 */
function roomOf(env: CloudEnv, account: CleanupAccount, computers: ComputerRow[], planId: CloudPlanId): PlanRoom {
  const diskGb = planId === cleanupPlanOf(account) ? planDiskGbOf(account, planId) : CLOUD_PLANS[planId].diskGb;
  const overGb = countedDiskGb(computers) - diskGb;
  const extraDiskCovers = planId !== "free" && overGb > 0 && cloudOffers(env).extraDisk && account.extra_disk_state === "on"
    && account.extra_disk_limit_cents != null && extraDiskMonthFits(overGb, account.extra_disk_limit_cents);
  return { planId, diskCapGb: extraDiskCovers ? Number.POSITIVE_INFINITY : diskGb, limitGb: diskGb };
}

const fitsRoom = (room: PlanRoom, computers: ComputerRow[]): boolean => countedDiskGb(computers) <= room.diskCapGb;

/** What older builds read beside the disk: the count, and a limit never below it (only disk counts). */
const oldBuildCounts = (computers: ComputerRow[]) => ({ computerCount: computers.length, computerLimit: Math.max(AWAKE_COMPUTER_CAP, computers.length) });

/** The computers a pick may name: made (not a reservation), not in a move. Oldest first. */
function pickable(computers: ComputerRow[]): ComputerRow[] {
  // A move's source and its new computer are one lane mid-move; a reservation has no computer yet.
  const moving = new Set(computers.map((computer) => computer.moving_from).filter((id) => id != null));
  return computers
    .filter((computer) => !isPendingId(computer.instance_id) && computer.moving_from == null && !moving.has(computer.instance_id))
    .sort((a, b) => a.created_at - b.created_at || a.instance_id.localeCompare(b.instance_id));
}

const pickOf = (computer: ComputerRow): CloudPlanCleanupComputer => ({
  instanceId: computer.instance_id,
  name: computer.name,
  laneName: computer.lane_name ?? null,
  branch: computer.lane_branch ?? null,
  diskGb: computer.disk_gb,
  createdAt: computer.created_at,
});

/**
 * What goes over `planId` with `computers`, or null when they fit: the facts,
 * the sentence, every computer a pick may name, and the oldest that make it
 * fit (what a pick starts with). Extra disk that covers the overage makes the
 * plan's disk not what must be freed to.
 */
export function planCleanupFor(
  env: CloudEnv,
  account: CleanupAccount,
  computers: ComputerRow[],
  planId: CloudPlanId,
): Omit<CloudPlanCleanup, "startsAt" | "freeing"> | null {
  const room = roomOf(env, account, computers, planId);
  if (fitsRoom(room, computers)) return null;
  const choices = pickable(computers);
  const left = new Set(computers.map((computer) => computer.instance_id));
  const suggested: CloudPlanCleanupComputer[] = [];
  for (const computer of choices) {
    const rest = computers.filter((entry) => left.has(entry.instance_id));
    if (fitsRoom(room, rest)) break;
    suggested.push(pickOf(computer));
    left.delete(computer.instance_id);
  }
  const usedGb = countedDiskGb(computers);
  const facts = { planId, usedGb, limitGb: Number.isFinite(room.diskCapGb) ? room.limitGb : usedGb };
  return { ...facts, ...oldBuildCounts(computers), computers: suggested, choices: choices.map(pickOf), sentence: planCleanupSentence(facts) };
}

/** The account's pick while ADE frees it, or null (none, or unreadable). */
export function choiceOf(account: Pick<AccountRow, "plan_cleanup_choice_json">): PlanCleanupChoice | null {
  if (!account.plan_cleanup_choice_json) return null;
  try {
    const raw = JSON.parse(account.plan_cleanup_choice_json) as Record<string, unknown>;
    const planId = raw.planId;
    if (planId !== "free" && planId !== "plus" && planId !== "pro" && planId !== "max") return null;
    if (typeof raw.push !== "boolean" || typeof raw.at !== "number" || !Array.isArray(raw.instanceIds)) return null;
    return { planId, push: raw.push, at: raw.at, instanceIds: raw.instanceIds.filter((id): id is string => typeof id === "string") };
  } catch {
    return null;
  }
}

/** Whether a pick still stands: its plan is still the one in force, or the one a downgrade or cancel waits for. */
function choiceApplies(account: AccountRow, choice: PlanCleanupChoice): boolean {
  return cleanupPlanOf(account) === choice.planId || waitingPlanOf(account) === choice.planId;
}

/**
 * The plan a pick is for now: the plan in force when the account is over it,
 * else the cheaper plan a downgrade or a cancel waits for when the account is
 * over that one. Null when the account fits both.
 */
export function planCleanupTargetOf(env: CloudEnv, account: AccountRow, computers: ComputerRow[]): CloudPlanId | null {
  const inForce = cleanupPlanOf(account);
  if (inForce && planCleanupFor(env, account, computers, inForce)) return inForce;
  const waiting = waitingPlanOf(account);
  return waiting && planCleanupFor(env, account, computers, waiting) ? waiting : null;
}

/**
 * The plan in force when the account is over it (new computers are refused),
 * or null. The one check `POST /cloud/instances` and a copy make.
 */
export function overPlanInForce(env: CloudEnv, account: AccountRow, computers: ComputerRow[]): Omit<CloudPlanCleanup, "startsAt" | "freeing"> | null {
  const inForce = cleanupPlanOf(account);
  return inForce ? planCleanupFor(env, account, computers, inForce) : null;
}

/**
 * For `GET /cloud/account`: what goes over the plan in force (or the cheaper
 * plan a downgrade or cancel waits for), what goes over each cheaper plan if
 * the person moved to it now, and the last pick's outcome.
 */
export function planCleanupState(env: CloudEnv, account: AccountRow, computers: ComputerRow[], now: number): {
  planCleanup: CloudPlanCleanup | null;
  downgradePreviews: { pro?: CloudPlanCleanup; plus?: CloudPlanCleanup; free?: CloudPlanCleanup };
  planCleanupDone: CloudPlanCleanupDone | null;
} {
  const inForce = cleanupPlanOf(account);
  const waiting = waitingPlanOf(account);
  const choice = choiceOf(account);
  const freeingFor = (planId: CloudPlanId) => (choice && choice.planId === planId
    ? { push: choice.push, instanceIds: choice.instanceIds, at: choice.at }
    : null);
  let planCleanup: CloudPlanCleanup | null = null;
  if (inForce) {
    const current = planCleanupFor(env, account, computers, inForce);
    if (current) planCleanup = { ...current, startsAt: null, freeing: freeingFor(inForce) };
  }
  if (!planCleanup && waiting) {
    const next = planCleanupFor(env, account, computers, waiting);
    if (next) planCleanup = { ...next, startsAt: account.period_end, freeing: freeingFor(waiting) };
  }
  // A pick still running after the account already fits (it named more than it had to): say it runs.
  if (!planCleanup && choice && choiceApplies(account, choice)) {
    const room = roomOf(env, account, computers, choice.planId);
    planCleanup = {
      planId: choice.planId,
      computers: [],
      choices: [],
      usedGb: countedDiskGb(computers),
      limitGb: room.limitGb,
      ...oldBuildCounts(computers),
      startsAt: choice.planId === inForce ? null : account.period_end,
      freeing: freeingFor(choice.planId),
      sentence: "",
    };
  }
  // Each cheaper plan the person could move to now; each starts at the period end.
  const downgradePreviews: { pro?: CloudPlanCleanup; plus?: CloudPlanCleanup; free?: CloudPlanCleanup } = {};
  const cheaper: Array<"pro" | "plus" | "free"> = inForce === "max" ? ["pro", "plus", "free"] : inForce === "pro" ? ["plus", "free"] : inForce === "plus" ? ["free"] : [];
  for (const planId of cheaper) {
    const preview = planCleanupFor(env, account, computers, planId);
    if (preview) downgradePreviews[planId] = { ...preview, startsAt: account.period_end, freeing: null };
  }
  return { planCleanup, downgradePreviews, planCleanupDone: readDone(account, now) };
}

type StoredDone = CloudPlanCleanupDone & { choiceAt?: number };

function parseDone(json: string | null): StoredDone | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as StoredDone;
  } catch {
    return null;
  }
}

function readDone(account: AccountRow, now: number): CloudPlanCleanupDone | null {
  if (account.plan_cleanup_result_at == null || now - account.plan_cleanup_result_at > DONE_SHOWN_MS) return null;
  const done = parseDone(account.plan_cleanup_result_json);
  if (!done || (done.freed.length === 0 && done.kept.length === 0)) return null;
  const { choiceAt: _choiceAt, ...shown } = done;
  return shown;
}

/* ---- The person's pick ---- */

export type PickCheck =
  | { ok: true; instanceIds: string[] }
  | { ok: false; code: "cleanup_does_not_fit" | "cleanup_changed" | "cleanup_running" | "nothing_to_free" | "bad_request"; message: string };

/** The `cleanup` of a request (`CloudPlanCleanupPick`), or null when it isn't one. */
export function readPlanCleanupPick(value: unknown): CloudPlanCleanupPick | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.push !== "boolean" || !Array.isArray(raw.instanceIds)) return null;
  if (raw.instanceIds.length > MAX_PICKED || raw.instanceIds.some((id) => typeof id !== "string" || !id || id.length > 100)) return null;
  return { push: raw.push, instanceIds: [...new Set(raw.instanceIds as string[])] };
}

/**
 * Whether `pick` frees what `planId` needs: no other pick is still running,
 * the account is over the plan, the pick names only computers the account has
 * now (made, not mid-move), and without them the rest fits. Nothing changes
 * here; the caller records the pick once the rest of its work is done.
 */
export function checkPlanCleanupPick(env: CloudEnv, account: AccountRow, computers: ComputerRow[], planId: CloudPlanId, pick: CloudPlanCleanupPick): PickCheck {
  const planName = CLOUD_PLAN_SENTENCE_NAMES[planId];
  if (choiceOf(account)) {
    return { ok: false, code: "cleanup_running", message: "ADE is still freeing the computers you picked. Try again when it's done." };
  }
  if (!planCleanupFor(env, account, computers, planId)) {
    return pick.instanceIds.length
      ? { ok: false, code: "cleanup_changed", message: `Your computers already fit ${planName}, so nothing needs to go. Look again.` }
      : { ok: false, code: "nothing_to_free", message: `Your computers already fit ${planName}.` };
  }
  const allowed = new Set(pickable(computers).map((computer) => computer.instance_id));
  if (pick.instanceIds.some((id) => !allowed.has(id))) {
    return { ok: false, code: "cleanup_changed", message: "Your computers changed since ADE showed them. Look at the list again." };
  }
  const picked = new Set(pick.instanceIds);
  const rest = computers.filter((computer) => !picked.has(computer.instance_id));
  const room = roomOf(env, account, computers, planId);
  if (!fitsRoom(room, rest)) {
    const still = planCleanupSentence({ planId, usedGb: countedDiskGb(rest), limitGb: room.limitGb });
    return { ok: false, code: "cleanup_does_not_fit", message: `Without those, ${still.charAt(0).toLowerCase()}${still.slice(1)} Pick more computers.` };
  }
  return { ok: true, instanceIds: pick.instanceIds };
}

/**
 * Records a checked pick, so the minute cron frees exactly those computers.
 * Guarded on no pick running, so two requests can't both start one. The last
 * pick's notice is cleared: this pick writes its own.
 */
export async function recordPlanCleanupPick(env: CloudEnv, userId: string, planId: CloudPlanId, pick: CloudPlanCleanupPick, now: number): Promise<boolean> {
  const choice: PlanCleanupChoice = { planId, push: pick.push, instanceIds: pick.instanceIds, at: now };
  const written = await env.DB.prepare(`
    update cloud_accounts set plan_cleanup_choice_json = ?, plan_cleanup_result_json = null, plan_cleanup_result_at = null
    where user_id = ? and plan_cleanup_choice_json is null
  `).bind(JSON.stringify(choice), userId).run();
  const recorded = (written.meta?.changes ?? 0) === 1;
  logCloud(recorded ? "cloud.plan_cleanup_picked" : "cloud.plan_cleanup_pick_not_recorded", { userId, plan: planId, computers: pick.instanceIds.length, push: pick.push });
  return recorded;
}

/* ---- What the person is told ---- */

/** "Dec 4": the day in UTC, the zone the server's periods end in. */
const utcDate = (ms: number): string => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Where in ADE the person picks, and what ADE does with a pick: every email says it the same. */
const WAYS_OUT = "ADE deletes nothing on its own. In ADE, open Settings › ADE Cloud › Plans: delete or shrink computers yourself, or pick the computers ADE frees. It pushes their work to GitHub first, and their lanes and chats stay.";

/**
 * The email when a downgrade or cancel is made outside ADE's question (the
 * billing portal) and the cheaper plan's limits would be passed (from the
 * Stripe webhook's `announceChange`). A pick made in ADE for it says nothing.
 */
export async function warnPlanCleanupAhead(env: CloudEnv, account: AccountRow, computers: ComputerRow[], toPlan: CloudPlanId): Promise<void> {
  if (choiceOf(account)?.planId === toPlan) return;
  const cleanup = planCleanupFor(env, account, computers, toPlan);
  if (!cleanup) return;
  const starts = utcDate(account.period_end);
  const planName = CLOUD_PLAN_SENTENCE_NAMES[toPlan];
  logCloud("cloud.plan_cleanup_warned_ahead", { userId: account.user_id, to: toPlan, usedGb: cleanup.usedGb, limitGb: cleanup.limitGb });
  await sendCloudEmail(env, {
    userId: account.user_id,
    subject: `Your ADE Cloud computers hold more disk than ${planName} has from ${starts}`,
    text: [
      `You move to ${planName} on ${starts}.`,
      cleanup.sentence,
      `From then, ADE can't make a new computer until your computers fit in ${planName}'s disk.`,
      WAYS_OUT,
    ].join("\n"),
  });
}

/**
 * The email after a pick is done: `planCleanupDoneSentence` (what ADE shows
 * too, which already names each freed computer and its branch), then why each
 * kept computer was kept, which the sentence doesn't say.
 */
async function tellPlanCleanupDone(env: CloudEnv, userId: string, done: CloudPlanCleanupDone): Promise<void> {
  const lines = [planCleanupDoneSentence(done)];
  for (const entry of done.kept) lines.push(`${entry.name}: ${entry.reason}`);
  await sendCloudEmail(env, {
    userId,
    subject: done.freed.length
      ? `ADE Cloud freed ${done.freed.length === 1 ? "a computer" : `${done.freed.length} computers`} to fit ${CLOUD_PLAN_SENTENCE_NAMES[done.planId]}`
      : "ADE Cloud couldn't push a computer's work",
    text: lines.join("\n"),
  });
}

/* ---- Over the plan in force: told once, nothing freed ---- */

/**
 * From the ten-minute owner check: each account ADE Cloud lets in that is over
 * the plan in force (new computers refused) is told once, with no pick
 * running; one that fits again is cleared. Nothing is freed here.
 */
export async function runPlanLimitChecks(env: CloudEnv, computers: ComputerRow[], now: number): Promise<void> {
  const byUser = groupByUser(computers);
  // An account told before that has no computer now fits.
  await env.DB.prepare("update cloud_accounts set plan_over_told_at = null where plan_over_told_at is not null and user_id not in (select value from json_each(?))")
    .bind(JSON.stringify([...byUser.keys()])).run();
  if (byUser.size === 0) return;
  const accounts = await env.DB.prepare("select * from cloud_accounts where deleted_at is null and user_id in (select value from json_each(?))")
    .bind(JSON.stringify([...byUser.keys()])).all<AccountRow>();
  for (const account of accounts.results ?? []) {
    // An account ADE Cloud no longer lets in is left as it is.
    if (!cloudAccessAllows(env, account.user_id)) continue;
    try {
      const over = overPlanInForce(env, account, byUser.get(account.user_id) ?? []);
      if (!over) {
        if (account.plan_over_told_at != null) {
          await env.DB.prepare("update cloud_accounts set plan_over_told_at = null where user_id = ?").bind(account.user_id).run();
          logCloud("cloud.plan_over_cleared", { userId: account.user_id });
        }
        continue;
      }
      if (account.plan_over_told_at != null || choiceOf(account)) continue;
      await tellOver(env, account, over, now);
    } catch (error) {
      reportCloudFailure("cloud.plan_limit_check_failed", { userId: account.user_id, message: error instanceof Error ? error.message : "unknown" });
    }
  }
}

/** Claimed first (so overlapping checks tell once), then the email, given back when it didn't go out. */
async function tellOver(env: CloudEnv, account: AccountRow, over: Omit<CloudPlanCleanup, "startsAt" | "freeing">, now: number): Promise<void> {
  const claim = await env.DB.prepare("update cloud_accounts set plan_over_told_at = ? where user_id = ? and plan_over_told_at is null")
    .bind(now, account.user_id).run();
  if ((claim.meta?.changes ?? 0) !== 1) return;
  const sent = await sendCloudEmail(env, {
    userId: account.user_id,
    subject: `Your ADE Cloud computers hold more disk than ${CLOUD_PLAN_SENTENCE_NAMES[over.planId]} has`,
    text: [
      `Your account is on ${CLOUD_PLAN_SENTENCE_NAMES[over.planId]} now and your computers hold more disk than it has.`,
      over.sentence,
      "ADE can't make a new computer until your computers fit. Your computers and their work stay as they are.",
      WAYS_OUT,
    ].join("\n"),
  });
  if (sent === "sent" || (sent === "skipped" && !isProduction(env))) {
    logCloud("cloud.plan_over_told", { userId: account.user_id, plan: over.planId, email: sent });
    return;
  }
  await env.DB.prepare("update cloud_accounts set plan_over_told_at = null where user_id = ? and plan_over_told_at = ?").bind(account.user_id, now).run();
  reportCloudFailure("cloud.plan_over_not_told", { userId: account.user_id, email: sent });
}

/* ---- Freeing a pick ---- */

/**
 * From the minute cron: for each account with a pick, frees its picked
 * computers that are still waiting, at most `CLEANUPS_PER_TICK` a tick across
 * accounts, each claimed in one write so overlapping ticks free it once. A
 * pick whose plan no longer applies (the person stayed on Pro, undid a
 * cancel) is dropped without freeing anything more. A pick with nothing left
 * waiting is finished: cleared, and the person gets the email. With no pick,
 * one indexed read.
 */
export async function runPlanCleanupPicks(env: CloudEnv, provider: CloudProvider, now = Date.now()): Promise<void> {
  const accounts = (await env.DB.prepare("select * from cloud_accounts where plan_cleanup_choice_json is not null and deleted_at is null")
    .all<AccountRow>()).results ?? [];
  let budget = CLEANUPS_PER_TICK;
  const runs: Promise<void>[] = [];
  for (const account of accounts) {
    try {
      const choice = choiceOf(account);
      if (!choice) {
        await clearChoice(env, account);
        continue;
      }
      // An account ADE Cloud no longer lets in is left as it is.
      if (!cloudAccessAllows(env, account.user_id)) continue;
      if (!choiceApplies(account, choice)) {
        if (await clearChoice(env, account)) logCloud("cloud.plan_cleanup_pick_dropped", { userId: account.user_id, plan: choice.planId });
        continue;
      }
      const waiting = await waitingPicks(env, account.user_id, choice, now);
      if (waiting.length === 0) {
        if (!(await pickClaimed(env, account.user_id, choice, now))) await finishChoice(env, account, choice);
        continue;
      }
      if (budget <= 0) continue;
      // A move or an update in flight is waited out: it changes which computers exist.
      const owned = await listComputers(env, account.user_id);
      if (owned.some((computer) => computer.moving_from != null || isPendingId(computer.instance_id) || computer.update_state === "updating")) continue;
      const take = waiting.slice(0, budget);
      budget -= take.length;
      for (const computer of take) runs.push(freePicked(env, provider, account.user_id, choice, computer, now));
    } catch (error) {
      reportCloudFailure("cloud.plan_cleanup_account_failed", { userId: account.user_id, message: error instanceof Error ? error.message : "unknown" });
    }
  }
  await Promise.all(runs);
}

/** The picked computers still to free: on the account, not kept by this pick, and not claimed by a run still going. */
async function waitingPicks(env: CloudEnv, userId: string, choice: PlanCleanupChoice, now: number): Promise<CleanupComputerRow[]> {
  const rows = (await env.DB.prepare(`
    select * from cloud_computers
    where user_id = ? and deleted_at is null and instance_id in (select value from json_each(?))
      and (plan_cleanup_failed_at is null or plan_cleanup_failed_at < ?)
      and (plan_cleanup_claimed_at is null or plan_cleanup_claimed_at < ?)
  `).bind(userId, JSON.stringify(choice.instanceIds), choice.at, now - CLAIM_STALE_MS).all<CleanupComputerRow>()).results ?? [];
  const order = new Map(choice.instanceIds.map((id, index) => [id, index]));
  return rows.sort((a, b) => (order.get(a.instance_id) ?? 0) - (order.get(b.instance_id) ?? 0));
}

/**
 * Whether a run still holds one of the pick's computers: its claim stays,
 * deleted or kept, until its outcome is on the notice (`freePicked`), so the
 * pick never finishes with an outcome still missing. A claim a lost run left
 * stops counting once stale.
 */
async function pickClaimed(env: CloudEnv, userId: string, choice: PlanCleanupChoice, now: number): Promise<boolean> {
  const row = await env.DB.prepare(`
    select 1 as busy from cloud_computers
    where user_id = ? and instance_id in (select value from json_each(?)) and plan_cleanup_claimed_at >= ?
    limit 1
  `).bind(userId, JSON.stringify(choice.instanceIds), now - CLAIM_STALE_MS).first<{ busy: number }>();
  return row != null;
}

/** Clears the pick as it was read: true when this run cleared it. */
async function clearChoice(env: CloudEnv, account: AccountRow): Promise<boolean> {
  const cleared = await env.DB.prepare("update cloud_accounts set plan_cleanup_choice_json = null where user_id = ? and plan_cleanup_choice_json = ?")
    .bind(account.user_id, account.plan_cleanup_choice_json).run();
  return (cleared.meta?.changes ?? 0) === 1;
}

/** Ends a pick with nothing left to free: the run that clears it sends the one email. */
async function finishChoice(env: CloudEnv, account: AccountRow, choice: PlanCleanupChoice): Promise<void> {
  if (!(await clearChoice(env, account))) return;
  const row = await env.DB.prepare("select plan_cleanup_result_json from cloud_accounts where user_id = ?").bind(account.user_id)
    .first<{ plan_cleanup_result_json: string | null }>();
  const done = parseDone(row?.plan_cleanup_result_json ?? null);
  logCloud("cloud.plan_cleanup_pick_done", { userId: account.user_id, plan: choice.planId, freed: done?.freed.length ?? 0, kept: done?.kept.length ?? 0 });
  if (done && done.choiceAt === choice.at && (done.freed.length || done.kept.length)) {
    const { choiceAt: _choiceAt, ...shown } = done;
    await tellPlanCleanupDone(env, account.user_id, shown);
  }
}

type Outcome = { kind: "freed"; name: string; branch: string | null; laneKept: boolean } | { kind: "kept"; name: string; reason: string } | { kind: "skipped" };

/**
 * Adds one computer's outcome to the pick's notice. Read, then written only
 * if unchanged, so computers freed side by side each land.
 */
async function recordOutcome(env: CloudEnv, userId: string, choice: PlanCleanupChoice, outcome: Exclude<Outcome, { kind: "skipped" }>, now: number): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const row = await env.DB.prepare("select plan_cleanup_result_json from cloud_accounts where user_id = ?").bind(userId)
      .first<{ plan_cleanup_result_json: string | null }>();
    const before = row?.plan_cleanup_result_json ?? null;
    const current = parseDone(before);
    const done: StoredDone = current && current.choiceAt === choice.at
      ? current
      : { at: now, planId: choice.planId, freed: [], kept: [], choiceAt: choice.at };
    if (outcome.kind === "freed") done.freed.push({ name: outcome.name, branch: outcome.branch, laneKept: outcome.laneKept, pushed: choice.push });
    else done.kept.push({ name: outcome.name, reason: outcome.reason });
    done.at = now;
    const written = await env.DB.prepare("update cloud_accounts set plan_cleanup_result_json = ?, plan_cleanup_result_at = ? where user_id = ? and plan_cleanup_result_json is ?")
      .bind(JSON.stringify(done), now, userId, before).run();
    if ((written.meta?.changes ?? 0) === 1) return;
  }
  reportCloudFailure("cloud.plan_cleanup_outcome_unsaved", { userId });
}

const nameOf = (computer: ComputerRow): string => computer.lane_name ?? computer.name ?? computer.instance_id;

/**
 * Whether `instanceId` is still to be freed, read fresh: the account is still
 * let in, the same pick still stands and names it, and its plan still
 * applies. The run's snapshot can be minutes old by the delete: the person
 * may have stayed on Pro meanwhile.
 */
async function stillPicked(env: CloudEnv, userId: string, instanceId: string, choice: PlanCleanupChoice): Promise<boolean> {
  if (!cloudAccessAllows(env, userId)) return false;
  const account = await env.DB.prepare("select * from cloud_accounts where user_id = ? and deleted_at is null").bind(userId).first<AccountRow>();
  const current = account ? choiceOf(account) : null;
  return account != null && current != null && current.at === choice.at && current.instanceIds.includes(instanceId) && choiceApplies(account, current);
}

/** Codes for a person's own unpushed work: normal, and not ADE's to fix. */
const USER_STATE_CODES = new Set(["push_left_work", "check_left_work"]);

/** One picked computer, freed, kept or skipped, and its outcome on the pick's notice. */
async function freePicked(env: CloudEnv, provider: CloudProvider, userId: string, choice: PlanCleanupChoice, computer: CleanupComputerRow, now: number): Promise<void> {
  try {
    const outcome = await freeComputer(env, provider, choice, computer, now);
    if (outcome.kind === "skipped") return;
    if (outcome.kind === "freed") {
      const size = cloudSizeFor(computer.type, computer.cpu, computer.memory_gb);
      captureCloudAction(env, undefined, userId, { action: "delete", plan: choice.planId, origin: "system", tier: tierOf(size) }, computer.instance_id, now);
    }
    await recordOutcome(env, userId, choice, outcome, now);
  } catch (error) {
    reportCloudFailure("cloud.plan_cleanup_run_failed", { userId, message: error instanceof Error ? error.message : "unknown" });
  }
  // The outcome is in (or lost): the claim goes, and the pick may finish.
  await env.DB.prepare("update cloud_computers set plan_cleanup_claimed_at = null where instance_id = ? and plan_cleanup_claimed_at = ?")
    .bind(computer.instance_id, now).run();
}

/**
 * Frees one picked computer, keeping its lane. With push on, its work is
 * pushed from the computer itself first, and anything short of "everything
 * is on GitHub" keeps it. With push off, it is deleted after a best-effort
 * save on a computer that is awake (one that rests is not woken).
 */
async function freeComputer(env: CloudEnv, provider: CloudProvider, choice: PlanCleanupChoice, computer: CleanupComputerRow, now: number): Promise<Outcome> {
  const claimed = await env.DB.prepare(`
    update cloud_computers set plan_cleanup_claimed_at = ?
    where instance_id = ? and deleted_at is null and (plan_cleanup_claimed_at is null or plan_cleanup_claimed_at < ?)
  `).bind(now, computer.instance_id, now - CLAIM_STALE_MS).run();
  if ((claimed.meta?.changes ?? 0) !== 1) return { kind: "skipped" };
  // Set once this run woke the computer: a computer it keeps goes back to how it was, not left running.
  const wake: WakeRecord = { woke: false, from: computer.status };
  const release = async (): Promise<Outcome> => {
    if (wake.woke) await putBackToRest(env, provider, computer.instance_id, wake.from);
    await env.DB.prepare("update cloud_computers set plan_cleanup_claimed_at = null where instance_id = ?").bind(computer.instance_id).run();
    logCloud("cloud.plan_cleanup_no_longer_picked", { instanceId: computer.instance_id });
    return { kind: "skipped" };
  };
  const keep = async (reason: string, code: string): Promise<Outcome> => {
    if (USER_STATE_CODES.has(code)) logCloud("cloud.plan_cleanup_kept", { instanceId: computer.instance_id, code });
    else reportCloudFailure("cloud.plan_cleanup_kept", { instanceId: computer.instance_id, code });
    if (wake.woke) await putBackToRest(env, provider, computer.instance_id, wake.from);
    // The claim stays until the outcome is recorded (`freePicked`).
    await env.DB.prepare("update cloud_computers set plan_cleanup_failed_at = ? where instance_id = ?")
      .bind(now, computer.instance_id).run();
    return { kind: "kept", name: nameOf(computer), reason };
  };
  try {
    // Never woken for nothing.
    if (!(await stillPicked(env, computer.user_id, computer.instance_id, choice))) return await release();
    let metadata: Record<string, string> = {};
    let pushedLanes: Tally["lanes"] = null;
    if (choice.push) {
      const work = await pushAllWork(env, provider, computer, now, wake, "plan_cleanup");
      if (!work.ok) return await keep(work.reason, work.code);
      metadata = work.metadata;
      pushedLanes = work.pushed.lanes;
    } else {
      metadata = await saveWithoutPush(provider, computer);
    }
    // The pushes took minutes: the person may have stayed on Pro since.
    if (!(await stillPicked(env, computer.user_id, computer.instance_id, choice))) return await release();

    const lane = mergeLaneFacts(laneFactsOfRow(computer), laneFactsOf(metadata));
    const own = pushedLanes?.find((entry) => entry.laneId === lane.laneId) ?? null;
    if (own?.branchRef) lane.branch = own.branchRef;
    const laneKept = namesLane(lane);
    if (laneKept) await markKeepLaneStatement(env, computer, lane, "plan_limit").run();
    try {
      await deleteComputer(env, provider, computer, { who: "system", reason: "plan_limit" }, Date.now());
    } catch (error) {
      if (laneKept) await unmarkKeepLaneStatement(env, computer.instance_id).run();
      throw error;
    }
    logCloud("cloud.plan_cleanup_freed", { instanceId: computer.instance_id, keptLane: laneKept, pushed: choice.push });
    return { kind: "freed", name: nameOf(computer), branch: lane.branch, laneKept };
  } catch (error) {
    const code = error instanceof CloudProviderError ? error.code : "unknown";
    return keep(choice.push ? "ADE Cloud couldn't reach the computer to push its work." : "ADE Cloud couldn't reach the computer to delete it.", code);
  }
}

/**
 * Push off: the computer's metadata (for its lane), and on a computer that is
 * awake, its own ADE stops its agents and saves its chats. Best effort, and a
 * resting computer is not woken: the person said to just delete it.
 */
async function saveWithoutPush(provider: CloudProvider, computer: ComputerRow): Promise<Record<string, string>> {
  try {
    const instance = await provider.getInstance(computer.instance_id);
    if (isMeteredStatus(instance.status)) {
      await provider.exec(computer.instance_id, PREPARE_COMMAND, PREPARE_TIMEOUT_MS).catch(() => null);
    }
    return instance.metadata;
  } catch {
    return {};
  }
}

/** Whether this run started the computer, and the resting status it had before (`stopped` or `sleeping`). */
export type WakeRecord = { woke: boolean; from: string };

/** All of a computer's work pushed and checked (its metadata and the push's tally), or why some stays, with a code for the log. */
export type PushAllOutcome =
  | { ok: true; metadata: Record<string, string>; pushed: Tally }
  | { ok: false; reason: string; code: string };

/**
 * The one push-before-delete run, on the computer itself: a free wake when it
 * rests, its own ADE stops its agents and saves its chats, pushes every
 * lane's work, then reads it all again; anything new or unknown keeps it.
 * The plan cleanup and the project delete both delete only on `ok`. `wake`
 * notes a wake, so a caller that keeps the computer puts it back to rest
 * (`putBackToRest`). Provider errors are thrown.
 */
export async function pushAllWork(env: CloudEnv, provider: CloudProvider, computer: ComputerRow, now: number, wake: WakeRecord, reason: string): Promise<PushAllOutcome> {
  const metadata = await wakeForPush(env, provider, computer, now, wake, reason);
  // Agents stopped and chats saved first: anything still writing could land after the check.
  const prepared = await provider.exec(computer.instance_id, PREPARE_COMMAND, PREPARE_TIMEOUT_MS);
  if (!prepareConfirmed(prepared.exitCode, prepared.stdout)) return { ok: false, reason: "ADE on the computer couldn't stop its agents and save its chats.", code: "prepare_stop_failed" };
  const pushed = readTally((await provider.exec(computer.instance_id, PUSH_COMMAND, PUSH_TIMEOUT_MS)).stdout);
  if (!pushed) return { ok: false, reason: "ADE on the computer didn't answer the push.", code: "push_unreadable" };
  const left = leftLanes(pushed);
  if (left) return { ok: false, reason: left, code: "push_left_work" };
  // Read once more: anything new or unknown keeps it.
  const checked = readTally((await provider.exec(computer.instance_id, CHECK_COMMAND, CHECK_TIMEOUT_MS)).stdout);
  if (!checked) return { ok: false, reason: "ADE couldn't confirm all work is on GitHub.", code: "check_unreadable" };
  const stillLeft = leftLanes(checked);
  if (stillLeft) return { ok: false, reason: stillLeft, code: "check_left_work" };
  return { ok: true, metadata, pushed };
}

/**
 * Wakes a resting computer for the push, as the person's push-work wake does:
 * the time isn't charged, isn't counted as use, and the tick's stops and
 * sleeps leave it alone. Answers the computer's metadata, and notes in `wake`
 * that it started it (before the wait, so a wake that times out is put back too).
 */
async function wakeForPush(env: CloudEnv, provider: CloudProvider, computer: ComputerRow, now: number, wake: WakeRecord, reason = "plan_cleanup"): Promise<Record<string, string>> {
  let instance = await provider.getInstance(computer.instance_id);
  if (isMeteredStatus(instance.status)) return instance.metadata;
  wake.from = instance.status;
  const status = await provider.startInstance(computer.instance_id);
  wake.woke = true;
  await env.DB.batch([
    env.DB.prepare(`
      update cloud_computers set status = ?, status_changed_at = ?, awake_since = ?, free_wake_started_at = ?, free_wake_until = ?, zero_stop_started_at = null, cold_storage = 0
      where instance_id = ? and deleted_at is null and awake_since is null
    `).bind(status, now, now + FREE_WAKE_MS, now, now + FREE_WAKE_MS, computer.instance_id),
    powerLogStatement(env, computer, "start", reason, now),
  ]);
  let awake = isMeteredStatus(status);
  for (let polls = 0; !awake && polls < WAKE_WAIT_MS / WAKE_POLL_MS; polls += 1) {
    await new Promise((resolve) => setTimeout(resolve, WAKE_POLL_MS));
    instance = await provider.getInstance(computer.instance_id);
    awake = isMeteredStatus(instance.status);
  }
  if (!awake) throw new CloudProviderError("The computer didn't wake.", "wake_timeout", 0);
  return instance.metadata;
}

/**
 * A computer this run woke and then kept goes back to rest the way the rest of
 * the server rests one: a stopped computer is stopped again, any other is put
 * to sleep, and the row's status change closes the free push wake (its time
 * isn't charged). Best effort: a failure is reported, and the tick's
 * no-check-in sleep is the backstop.
 */
export async function putBackToRest(env: CloudEnv, provider: CloudProvider, instanceId: string, from: string): Promise<void> {
  try {
    const row = await env.DB.prepare("select * from cloud_computers where instance_id = ? and deleted_at is null").bind(instanceId).first<ComputerRow>();
    if (!row) return;
    const status = from === "stopped" ? await provider.stopInstance(instanceId) : await provider.sleepInstance(instanceId);
    const statements = statusChangeStatements(env, row, status, Date.now(), "plan_cleanup");
    if (statements.length) await env.DB.batch(statements);
    logCloud("cloud.plan_cleanup_put_back", { instanceId, status });
  } catch (error) {
    reportCloudFailure("cloud.plan_cleanup_put_back_failed", { instanceId, code: error instanceof CloudProviderError ? error.code : "unknown" });
  }
}

/** The JSON a `--json` command printed: its `result`, or the object itself. Null when unreadable. */
export function readResult(stdout: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    return (record.result && typeof record.result === "object" && !Array.isArray(record.result) ? record.result : record) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * `ade cloud prepare-stop --json` confirmed the computer is quiet: it ran,
 * no chat turn is still running, every saved chat was written, and it didn't
 * run out of time. Anything else (an older ADE, a timeout) keeps the computer.
 */
function prepareConfirmed(exitCode: number, stdout: string): boolean {
  if (exitCode !== 0) return false;
  const result = readResult(stdout);
  return result != null && result.stillRunning === 0 && result.chatsNotUploaded === 0 && result.timedOut === false;
}

type TallyLane = { laneId: string; laneName: string; branchRef: string; state: string; primary: boolean };
/** `readsRemotes`: an ADE whose `ahead` counts commits no remote has and that reports an unreadable lane as `failed`. */
type Tally = { failed: number; readsRemotes: boolean; lanes: TallyLane[] | null };

/** `ade cloud push-work --json` / `work-state --json`: the tally, or null when unreadable. */
function readTally(stdout: string): Tally | null {
  const tally = readResult(stdout);
  if (!tally) return null;
  const lanes = Array.isArray(tally.lanes)
    ? tally.lanes.flatMap((entry): TallyLane[] => {
      if (!entry || typeof entry !== "object") return [];
      const lane = entry as Record<string, unknown>;
      return typeof lane.laneId === "string" ? [{
        laneId: lane.laneId,
        laneName: typeof lane.laneName === "string" ? lane.laneName : "",
        branchRef: typeof lane.branchRef === "string" ? lane.branchRef : "",
        state: typeof lane.state === "string" ? lane.state : "unknown",
        // A lane that doesn't say is treated as the primary lane: the stricter rule.
        primary: lane.primary !== false,
      }] : [];
    })
    : null;
  return { failed: Number(tally.failed) || 0, readsRemotes: tally.readsRemotes === true, lanes };
}

/**
 * Whether a lane's work is all on GitHub. Only `clean` and `pushed` say so;
 * any other state, known or not, keeps the computer. The primary lane is never
 * pushed, and an older ADE counts its commits against its own branch (0 for
 * the primary lane) and reports a lane it couldn't read as `clean`, so a
 * primary lane is safe only when it says `pushed`, or `clean` from an ADE that
 * reads against the remotes.
 */
function laneIsSafe(lane: TallyLane, readsRemotes: boolean): boolean {
  if (lane.state === "pushed") return true;
  return lane.state === "clean" && (readsRemotes || !lane.primary);
}

/** Why work stays on the computer, or null when everything is on GitHub. An older ADE without the lane list can't say: it stays. */
function leftLanes(tally: Tally): string | null {
  if (!tally.lanes) return "This computer's ADE is too old to say what isn't pushed.";
  if (tally.failed > 0) return "ADE couldn't read or push every project on it.";
  const left = tally.lanes.filter((lane) => !laneIsSafe(lane, tally.readsRemotes));
  if (left.length === 0) return null;
  const names = left.map((lane) => lane.laneName || lane.branchRef).filter(Boolean);
  return `Work that isn't on GitHub yet${names.length ? `: ${names.join(", ")}` : ""}.`;
}
