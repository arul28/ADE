import { captureCloudAction, type CloudWaitUntil } from "./analytics";
import {
  CLOUD_PLAN_CLEANUP_GRACE_DAYS,
  CLOUD_PLAN_SENTENCE_NAMES,
  planCleanupDoneSentence,
  planCleanupSentence,
  type CloudPlanCleanup,
  type CloudPlanCleanupComputer,
  type CloudPlanCleanupDone,
  type CloudPlanId,
} from "./contract";
import { sendCloudEmail, type CloudEmailResult } from "./email";
import { cloudAccessAllows } from "./http";
import { laneFactsOf, laneFactsOfRow, markKeepLaneStatement, mergeLaneFacts, namesLane, unmarkKeepLaneStatement } from "./lanesWithoutComputer";
import { CLOUD_PLANS, cloudSizeFor, extraDiskMonthFits, isMeteredStatus, tierOf } from "./plans";
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
  powerLogStatement,
  reportCloudFailure,
  statusChangeStatements,
  type AccountRow,
  type CloudEnv,
  type ComputerRow,
} from "./store";

/**
 * A cheaper plan's limits (decision 1 of `docs/plans/cloud-5/PLAN.md`: "you
 * should never stop a user from paying less; the user is warned"). A move
 * from Pro to Plus, a cancel, or a plan that ends after failed payments is
 * never refused. When the cheaper plan is on and the account holds more
 * computers or disk than it allows, ADE frees the OLDEST computers past the
 * limits, `CLOUD_PLAN_CLEANUP_GRACE_DAYS` after the plan started, so the
 * person can still choose by deleting computers themselves.
 *
 * Freeing a computer is "keep the lane, free its computer": the computer's own
 * ADE interrupts its agents, saves its chats and pushes every lane's work to
 * its branch on GitHub (`ade cloud prepare-stop`, `ade cloud push-work`); a
 * second read (`ade cloud work-state`) must find nothing left; then the
 * computer is deleted and its lane stays as a lane without a computer (reason
 * `plan_limit`), with its chats. The next message to the lane makes a new
 * computer from its branch, under the plan's limits like any other. A computer
 * made for no lane is deleted after the same push. A computer whose work can't
 * all be pushed stays; the person is told, and it is tried again a day later.
 * Nothing else goes in its place: only computers the person was warned about.
 *
 * Who decides: this server, from its own rows (no client has to be open).
 * When: the ten-minute owner check of the minute cron. What the person sees:
 * before, the sentence (`planCleanupSentence`) at the change in ADE, an email
 * when the change is made (`announceChange`) and another when the cheaper
 * plan starts, and the list in `GET /cloud/account` (`planCleanup`); after,
 * an email naming what was freed and the branches its work went to, the lanes
 * marked `plan_limit`, and `planCleanupDone`. A `past_due` account is never
 * cleaned: Stripe is still trying the card.
 */

const DAY_MS = 24 * 60 * 60_000;
export const PLAN_CLEANUP_GRACE_MS = CLOUD_PLAN_CLEANUP_GRACE_DAYS * DAY_MS;
/** Most computers one run frees, across accounts; they run in parallel. */
const CLEANUPS_PER_RUN = 4;
/** A claim older than this was lost mid-run (the Worker died): another run may take the computer. */
const CLAIM_STALE_MS = 20 * 60_000;
/** A computer whose push failed is tried again after this long. */
const RETRY_AFTER_MS = DAY_MS;
/** A start answered; ADE on the computer answers a few seconds after it runs. */
const WAKE_WAIT_MS = 3 * 60_000;
const WAKE_POLL_MS = 5_000;
/** Like the person's push-work wake: not charged, and the tick's stops and sleeps leave it alone. */
const FREE_WAKE_MS = 15 * 60_000;
/** Interrupt and save first (40 s, as the 0-hours stop), then push: bounded like the desktop's 3-minute push. */
export const PREPARE_TIMEOUT_MS = 90_000;
export const PUSH_TIMEOUT_MS = 4 * 60_000;
export const CHECK_TIMEOUT_MS = 2 * 60_000;
const DONE_SHOWN_MS = 14 * DAY_MS;

/** `$ADE_HOME/bin` holds the newer ADE; ADE on the computer answers a few seconds after a start. Shared by every server-run command on a computer. */
export const commandWith = (...lines: string[]) => [
  'export PATH="$ADE_HOME/bin:$PATH"',
  'i=0; until ade projects list --json >/dev/null 2>&1 || [ "$i" -ge 25 ]; do sleep 1; i=$((i+1)); done',
  ...lines,
].join("\n");
export const PREPARE_COMMAND = commandWith("ade cloud prepare-stop --timeout 40 --json");
export const PUSH_COMMAND = commandWith("ade cloud push-work --json");
export const CHECK_COMMAND = commandWith("ade cloud work-state --json");

type CleanupComputerRow = ComputerRow & { plan_cleanup_claimed_at?: number | null; plan_cleanup_failed_at?: number | null };

/* ---- Which computers go ---- */

/**
 * The plan whose limits hold the account now: what it pays for. Null while
 * `past_due` (Stripe still tries the card, and its computers keep working).
 */
export function cleanupPlanOf(account: Pick<AccountRow, "plan" | "paid_plan" | "stripe_status">): CloudPlanId | null {
  if (account.plan === "paid" && account.stripe_status === "past_due") return null;
  return boughtPlanIdOf(account);
}

/**
 * The oldest computers to free so `computers` fit `planId`'s computers and
 * disk, or null when they fit. On a paid plan, disk that extra disk covers (on,
 * set up, and a full month of it inside the limit) counts as fitting.
 */
export function planCleanupFor(
  env: CloudEnv,
  account: Pick<AccountRow, "extra_disk_state" | "extra_disk_limit_cents">,
  computers: ComputerRow[],
  planId: CloudPlanId,
): Omit<CloudPlanCleanup, "dueAt"> | null {
  const plan = CLOUD_PLANS[planId];
  const usedGb = countedDiskGb(computers);
  const overGb = usedGb - plan.diskGb;
  const extraDiskCovers = planId !== "free" && overGb > 0 && cloudOffers(env).extraDisk && account.extra_disk_state === "on"
    && account.extra_disk_limit_cents != null && extraDiskMonthFits(overGb, account.extra_disk_limit_cents);
  const diskCap = extraDiskCovers ? Number.POSITIVE_INFINITY : plan.diskGb;
  let count = computers.length;
  let disk = usedGb;
  if (count <= plan.computerLimit && disk <= diskCap) return null;
  // A move's source and its new computer are one lane mid-move; a reservation has no computer yet.
  const moving = new Set(computers.map((computer) => computer.moving_from).filter((id) => id != null));
  const candidates = computers
    .filter((computer) => !isPendingId(computer.instance_id) && computer.moving_from == null && !moving.has(computer.instance_id))
    .sort((a, b) => a.created_at - b.created_at || a.instance_id.localeCompare(b.instance_id));
  const picked: CloudPlanCleanupComputer[] = [];
  for (const computer of candidates) {
    if (count <= plan.computerLimit && disk <= diskCap) break;
    picked.push({
      instanceId: computer.instance_id,
      name: computer.name,
      laneName: computer.lane_name ?? null,
      branch: computer.lane_branch ?? null,
      diskGb: computer.disk_gb,
    });
    count -= 1;
    disk -= computer.disk_gb;
  }
  const facts = {
    planId,
    computers: picked,
    usedGb,
    // Extra disk covers the rest: the plan's disk isn't what must be freed to.
    limitGb: extraDiskCovers ? usedGb : plan.diskGb,
    computerCount: computers.length,
    computerLimit: plan.computerLimit,
  };
  return { ...facts, sentence: planCleanupSentence(facts) };
}

/** The computers the person was warned about, each with the time it may be freed from (`plan_cleanup_warned_json`). */
function warnedOf(account: Pick<AccountRow, "plan_cleanup_warned_json">): Map<string, number> {
  if (!account.plan_cleanup_warned_json) return new Map();
  try {
    const parsed = JSON.parse(account.plan_cleanup_warned_json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    return new Map(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  } catch {
    return new Map();
  }
}

/** When the first of `picked` goes: the earliest warned due time, or a grace from now when none was warned yet. */
function earliestDue(picked: CloudPlanCleanupComputer[], warned: Map<string, number>, now: number): number {
  return Math.min(now + PLAN_CLEANUP_GRACE_MS, ...picked.map((computer) => warned.get(computer.instanceId) ?? Number.POSITIVE_INFINITY));
}

/**
 * For `GET /cloud/account`: what the plan in force (or the cheaper plan a
 * downgrade or cancel waits for) frees, and what moving to each cheaper plan
 * now would free, for the warning before the change.
 */
export function planCleanupState(env: CloudEnv, account: AccountRow, computers: ComputerRow[], now: number): {
  planCleanup: CloudPlanCleanup | null;
  downgradePreviews: { plus?: CloudPlanCleanup; free?: CloudPlanCleanup };
  planCleanupDone: CloudPlanCleanupDone | null;
} {
  const inForce = cleanupPlanOf(account);
  const waiting = waitingPlanOf(account);
  let planCleanup: CloudPlanCleanup | null = null;
  if (inForce) {
    const current = planCleanupFor(env, account, computers, inForce);
    if (current) planCleanup = { ...current, dueAt: earliestDue(current.computers, warnedOf(account), now) };
  }
  if (!planCleanup && waiting) {
    const next = planCleanupFor(env, account, computers, waiting);
    if (next) planCleanup = { ...next, dueAt: account.period_end + PLAN_CLEANUP_GRACE_MS };
  }
  const downgradePreviews: { plus?: CloudPlanCleanup; free?: CloudPlanCleanup } = {};
  if (inForce === "pro") {
    const plus = planCleanupFor(env, account, computers, "plus");
    if (plus) downgradePreviews.plus = { ...plus, dueAt: null };
  }
  if (inForce === "plus" || inForce === "pro") {
    const free = planCleanupFor(env, account, computers, "free");
    if (free) downgradePreviews.free = { ...free, dueAt: null };
  }
  return { planCleanup, downgradePreviews, planCleanupDone: readDone(account, now) };
}

/** The cheaper plan a downgrade or a cancel waits for at the period end, or null. */
export function waitingPlanOf(account: Pick<AccountRow, "plan" | "stripe_status" | "cancel_at_period_end" | "paid_plan_next">): CloudPlanId | null {
  if (account.plan !== "paid" || account.stripe_status === "past_due") return null;
  if (account.cancel_at_period_end === 1) return "free";
  return account.paid_plan_next ?? null;
}

function readDone(account: AccountRow, now: number): CloudPlanCleanupDone | null {
  if (!account.plan_cleanup_result_json || account.plan_cleanup_result_at == null || now - account.plan_cleanup_result_at > DONE_SHOWN_MS) return null;
  try {
    return JSON.parse(account.plan_cleanup_result_json) as CloudPlanCleanupDone;
  } catch {
    return null;
  }
}

/* ---- What the person is told ---- */

/** "Dec 4": the day in UTC, the zone the server's periods end in. */
const utcDate = (ms: number): string => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const nameOfPick = (computer: CloudPlanCleanupComputer): string => computer.laneName ?? computer.name ?? computer.instanceId;

/**
 * The email when a downgrade or cancel is made and the cheaper plan's limits
 * would free computers (from the Stripe webhook's `announceChange`).
 */
export async function warnPlanCleanupAhead(env: CloudEnv, account: AccountRow, computers: ComputerRow[], toPlan: CloudPlanId): Promise<void> {
  const cleanup = planCleanupFor(env, account, computers, toPlan);
  if (!cleanup) return;
  const starts = utcDate(account.period_end);
  const planName = CLOUD_PLAN_SENTENCE_NAMES[toPlan];
  logCloud("cloud.plan_cleanup_warned_ahead", { userId: account.user_id, to: toPlan, computers: cleanup.computers.length });
  await sendCloudEmail(env, {
    userId: account.user_id,
    subject: `Your ADE Cloud computers go past ${planName} on ${starts}`,
    text: `You move to ${planName} on ${starts}.\n${cleanup.sentence}\nThis happens on ${utcDate(account.period_end + PLAN_CLEANUP_GRACE_MS)}, ${CLOUD_PLAN_CLEANUP_GRACE_DAYS} days after the change.`,
  });
}

/** The warning that names `fresh` (computers the limits now pick that the person wasn't told about), due at `dueAt`. */
async function warnPlanCleanupDue(
  env: CloudEnv,
  account: AccountRow,
  cleanup: Omit<CloudPlanCleanup, "dueAt">,
  fresh: CloudPlanCleanupComputer[],
  dueAt: number,
): Promise<CloudEmailResult> {
  const told = fresh.length < cleanup.computers.length;
  return sendCloudEmail(env, {
    userId: account.user_id,
    subject: `ADE Cloud frees ${fresh.length === 1 ? "a computer" : `${fresh.length} computers`} on ${utcDate(dueAt)}`,
    text: [
      `Your account is on ${CLOUD_PLAN_SENTENCE_NAMES[cleanup.planId]} now and holds more than it allows.`,
      cleanup.sentence,
      `This happens on ${utcDate(dueAt)}${told ? ` for ${fresh.map(nameOfPick).join(", ")}; the others keep the date you were told before` : ""}. Delete computers you no longer use before then to choose yourself.`,
    ].join("\n"),
  });
}

/**
 * The email after a run: `planCleanupDoneSentence` (what ADE shows too, which
 * already names each freed computer and its branch), then why each kept
 * computer was kept, which the sentence doesn't say.
 */
async function tellPlanCleanupDone(env: CloudEnv, account: AccountRow, done: CloudPlanCleanupDone): Promise<void> {
  const lines = [planCleanupDoneSentence(done)];
  for (const entry of done.kept) lines.push(`${entry.name}: ${entry.reason}`);
  await sendCloudEmail(env, {
    userId: account.user_id,
    subject: done.freed.length
      ? `ADE Cloud freed ${done.freed.length === 1 ? "a computer" : `${done.freed.length} computers`} to fit ${CLOUD_PLAN_SENTENCE_NAMES[done.planId]}`
      : "ADE Cloud couldn't push a computer's work",
    text: lines.join("\n"),
  });
}

/* ---- The run ---- */

/**
 * From the ten-minute owner check: for each account ADE Cloud lets in that
 * has computers, sets or clears its cleanup, warns about each computer once
 * (each gets its own due time, `CLOUD_PLAN_CLEANUP_GRACE_DAYS` after its
 * warning went out), and frees what is due, at most `CLEANUPS_PER_RUN`
 * computers a run. Only computers the person was warned about are freed.
 */
export async function runPlanCleanups(env: CloudEnv, provider: CloudProvider, computers: ComputerRow[], now: number, waitUntil?: CloudWaitUntil): Promise<void> {
  const byUser = groupByUser(computers);
  if (byUser.size === 0) return;
  const accounts = await env.DB.prepare("select * from cloud_accounts where deleted_at is null and user_id in (select value from json_each(?))")
    .bind(JSON.stringify([...byUser.keys()])).all<AccountRow>();
  let budget = CLEANUPS_PER_RUN;
  const runs: Promise<void>[] = [];
  for (const account of accounts.results ?? []) {
    // An account ADE Cloud no longer lets in is left as it is.
    if (!cloudAccessAllows(env, account.user_id)) continue;
    try {
      const owned = (byUser.get(account.user_id) ?? []) as CleanupComputerRow[];
      const planId = cleanupPlanOf(account);
      const cleanup = planId ? planCleanupFor(env, account, owned, planId) : null;
      if (!cleanup || cleanup.computers.length === 0) {
        if (account.plan_cleanup_due_at != null || account.plan_cleanup_warned_json != null) {
          await env.DB.prepare("update cloud_accounts set plan_cleanup_due_at = null, plan_cleanup_warned_json = null where user_id = ?").bind(account.user_id).run();
          logCloud("cloud.plan_cleanup_cleared", { userId: account.user_id });
        }
        continue;
      }
      const warned = warnedOf(account);
      const fresh = cleanup.computers.filter((computer) => !warned.has(computer.instanceId));
      if (fresh.length) {
        await warnFresh(env, account, cleanup, warned, fresh, now);
        continue;
      }
      if (budget <= 0) continue;
      // A move or an update in flight is waited out: it changes which computers exist.
      if (owned.some((computer) => computer.moving_from != null || isPendingId(computer.instance_id) || computer.update_state === "updating")) continue;
      const due = cleanup.computers
        .filter((entry) => (warned.get(entry.instanceId) ?? Number.POSITIVE_INFINITY) <= now)
        .map((entry) => owned.find((computer) => computer.instance_id === entry.instanceId))
        .filter((computer): computer is CleanupComputerRow => computer != null)
        .filter((computer) => computer.plan_cleanup_failed_at == null || now - computer.plan_cleanup_failed_at >= RETRY_AFTER_MS)
        .slice(0, budget);
      if (due.length === 0) continue;
      budget -= due.length;
      runs.push(runAccountCleanup(env, provider, account, cleanup.planId, due, now, waitUntil));
    } catch (error) {
      reportCloudFailure("cloud.plan_cleanup_account_failed", { userId: account.user_id, message: error instanceof Error ? error.message : "unknown" });
    }
  }
  await Promise.all(runs);
}

/**
 * Warns about `fresh` and gives each its due time: claimed first (guarded on
 * the warned list as read, so overlapping runs warn once), then the email,
 * and given back when the email didn't go out, so the next run tries again.
 * Nothing is freed on a warning that never reached the person. An email that
 * isn't set up (`skipped`) counts as told outside production only.
 */
async function warnFresh(
  env: CloudEnv,
  account: AccountRow,
  cleanup: Omit<CloudPlanCleanup, "dueAt">,
  warned: Map<string, number>,
  fresh: CloudPlanCleanupComputer[],
  now: number,
): Promise<void> {
  const dueAt = now + PLAN_CLEANUP_GRACE_MS;
  const next = new Map(warned);
  for (const computer of fresh) next.set(computer.instanceId, dueAt);
  const nextJson = JSON.stringify(Object.fromEntries(next));
  const claim = await env.DB.prepare(`
    update cloud_accounts set plan_cleanup_warned_json = ?, plan_cleanup_due_at = ?
    where user_id = ? and plan_cleanup_warned_json is ?
  `).bind(nextJson, earliestDue(cleanup.computers, next, now), account.user_id, account.plan_cleanup_warned_json).run();
  if ((claim.meta?.changes ?? 0) !== 1) return;
  const sent = await warnPlanCleanupDue(env, account, cleanup, fresh, dueAt);
  if (sent === "sent" || (sent === "skipped" && !isProduction(env))) {
    logCloud("cloud.plan_cleanup_set", { userId: account.user_id, plan: cleanup.planId, computers: fresh.length, email: sent });
    return;
  }
  // Only the claim this run made is given back.
  await env.DB.prepare(`
    update cloud_accounts set plan_cleanup_warned_json = ?, plan_cleanup_due_at = ?
    where user_id = ? and plan_cleanup_warned_json = ?
  `).bind(account.plan_cleanup_warned_json, account.plan_cleanup_due_at, account.user_id, nextJson).run();
  reportCloudFailure("cloud.plan_cleanup_warning_not_sent", { userId: account.user_id, email: sent });
}

type Outcome = { kind: "freed"; name: string; branch: string | null; laneKept: boolean } | { kind: "kept"; name: string; reason: string } | { kind: "skipped" };

async function runAccountCleanup(
  env: CloudEnv,
  provider: CloudProvider,
  account: AccountRow,
  planId: CloudPlanId,
  computers: CleanupComputerRow[],
  now: number,
  waitUntil?: CloudWaitUntil,
): Promise<void> {
  try {
    const outcomes = await Promise.all(computers.map((computer) => freeComputer(env, provider, computer, now)));
    const done: CloudPlanCleanupDone = { at: now, planId, freed: [], kept: [] };
    // A computer kept again on a retry was already told about: only a first failure is news.
    const newlyKept: CloudPlanCleanupDone["kept"] = [];
    outcomes.forEach((outcome, index) => {
      const computer = computers[index]!;
      if (outcome.kind === "freed") {
        done.freed.push({ name: outcome.name, branch: outcome.branch, laneKept: outcome.laneKept });
        const size = cloudSizeFor(computer.type, computer.cpu, computer.memory_gb);
        captureCloudAction(env, waitUntil, account.user_id, { action: "delete", plan: planId, origin: "system", tier: tierOf(size) }, computer.instance_id, now);
      } else if (outcome.kind === "kept") {
        done.kept.push({ name: outcome.name, reason: outcome.reason });
        if (computer.plan_cleanup_failed_at == null) newlyKept.push({ name: outcome.name, reason: outcome.reason });
      }
    });
    if (done.freed.length === 0 && done.kept.length === 0) return;
    await env.DB.prepare("update cloud_accounts set plan_cleanup_result_json = ?, plan_cleanup_result_at = ? where user_id = ?")
      .bind(JSON.stringify(done), now, account.user_id).run();
    logCloud("cloud.plan_cleanup_ran", { userId: account.user_id, plan: planId, freed: done.freed.length, kept: done.kept.length });
    if (done.freed.length || newlyKept.length) await tellPlanCleanupDone(env, account, done);
  } catch (error) {
    reportCloudFailure("cloud.plan_cleanup_run_failed", { userId: account.user_id, message: error instanceof Error ? error.message : "unknown" });
  }
}

const nameOf = (computer: ComputerRow): string => computer.lane_name ?? computer.name ?? computer.instance_id;

/**
 * Whether `instanceId` must still go, read fresh: the account is still let in,
 * still over the plan in force, the limits still pick this computer, and its
 * warning is due. The run's snapshot can be minutes old by the delete: the
 * person may have deleted other computers or upgraded meanwhile.
 */
async function stillDue(env: CloudEnv, userId: string, instanceId: string, now: number): Promise<boolean> {
  if (!cloudAccessAllows(env, userId)) return false;
  const account = await env.DB.prepare("select * from cloud_accounts where user_id = ? and deleted_at is null").bind(userId).first<AccountRow>();
  const planId = account ? cleanupPlanOf(account) : null;
  if (!account || !planId) return false;
  const cleanup = planCleanupFor(env, account, await listComputers(env, userId), planId);
  const due = warnedOf(account).get(instanceId);
  return due != null && due <= now && cleanup?.computers.some((computer) => computer.instanceId === instanceId) === true;
}

/** Codes for a person's own unpushed work: normal, repeated daily, and not ADE's to fix. */
const USER_STATE_CODES = new Set(["push_left_work", "check_left_work"]);

/**
 * Pushes one computer's work from the computer itself, then deletes it,
 * keeping its lane. Anything short of "everything is on GitHub" keeps it.
 */
async function freeComputer(env: CloudEnv, provider: CloudProvider, computer: CleanupComputerRow, now: number): Promise<Outcome> {
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
    logCloud("cloud.plan_cleanup_no_longer_due", { instanceId: computer.instance_id });
    return { kind: "skipped" };
  };
  const keep = async (reason: string, code: string): Promise<Outcome> => {
    if (USER_STATE_CODES.has(code)) logCloud("cloud.plan_cleanup_kept", { instanceId: computer.instance_id, code });
    else reportCloudFailure("cloud.plan_cleanup_kept", { instanceId: computer.instance_id, code });
    if (wake.woke) await putBackToRest(env, provider, computer.instance_id, wake.from);
    await env.DB.prepare("update cloud_computers set plan_cleanup_claimed_at = null, plan_cleanup_failed_at = ? where instance_id = ?")
      .bind(now, computer.instance_id).run();
    return { kind: "kept", name: nameOf(computer), reason };
  };
  try {
    // Never woken for nothing.
    if (!(await stillDue(env, computer.user_id, computer.instance_id, now))) return await release();
    const metadata = await wakeForPush(env, provider, computer, now, wake);
    // Agents stopped and chats saved first: anything still writing could land after the check.
    const prepared = await provider.exec(computer.instance_id, PREPARE_COMMAND, PREPARE_TIMEOUT_MS);
    if (!prepareConfirmed(prepared.exitCode, prepared.stdout)) return await keep("ADE on the computer couldn't stop its agents and save its chats.", "prepare_stop_failed");
    const pushed = readTally((await provider.exec(computer.instance_id, PUSH_COMMAND, PUSH_TIMEOUT_MS)).stdout);
    if (!pushed) return await keep("ADE on the computer didn't answer the push.", "push_unreadable");
    const left = leftLanes(pushed);
    if (left) return await keep(left, "push_left_work");
    // Read once more: anything new or unknown keeps it.
    const checked = readTally((await provider.exec(computer.instance_id, CHECK_COMMAND, CHECK_TIMEOUT_MS)).stdout);
    if (!checked) return await keep("ADE couldn't confirm all work is on GitHub.", "check_unreadable");
    const stillLeft = leftLanes(checked);
    if (stillLeft) return await keep(stillLeft, "check_left_work");
    // The pushes took minutes: the person may have deleted computers or upgraded since.
    if (!(await stillDue(env, computer.user_id, computer.instance_id, now))) return await release();

    const lane = mergeLaneFacts(laneFactsOfRow(computer), laneFactsOf(metadata));
    const own = pushed.lanes?.find((entry) => entry.laneId === lane.laneId) ?? null;
    if (own?.branchRef) lane.branch = own.branchRef;
    const laneKept = namesLane(lane);
    if (laneKept) await markKeepLaneStatement(env, computer, lane, "plan_limit").run();
    try {
      await deleteComputer(env, provider, computer, { who: "system", reason: "plan_limit" }, Date.now());
    } catch (error) {
      if (laneKept) await unmarkKeepLaneStatement(env, computer.instance_id).run();
      throw error;
    }
    logCloud("cloud.plan_cleanup_freed", { instanceId: computer.instance_id, keptLane: laneKept });
    return { kind: "freed", name: nameOf(computer), branch: lane.branch, laneKept };
  } catch (error) {
    const code = error instanceof CloudProviderError ? error.code : "unknown";
    return keep("ADE Cloud couldn't reach the computer to push its work.", code);
  }
}

/** Whether this run started the computer, and the resting status it had before (`stopped` or `sleeping`). */
export type WakeRecord = { woke: boolean; from: string };

/**
 * Wakes a resting computer for the push, as the person's push-work wake does:
 * the time isn't charged, isn't counted as use, and the tick's stops and
 * sleeps leave it alone. Answers the computer's metadata, and notes in `wake`
 * that it started it (before the wait, so a wake that times out is put back too).
 */
export async function wakeForPush(env: CloudEnv, provider: CloudProvider, computer: ComputerRow, now: number, wake: WakeRecord, reason = "plan_cleanup"): Promise<Record<string, string>> {
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
export function prepareConfirmed(exitCode: number, stdout: string): boolean {
  if (exitCode !== 0) return false;
  const result = readResult(stdout);
  return result != null && result.stillRunning === 0 && result.chatsNotUploaded === 0 && result.timedOut === false;
}

type TallyLane = { laneId: string; laneName: string; branchRef: string; state: string; primary: boolean };
/** `readsRemotes`: an ADE whose `ahead` counts commits no remote has and that reports an unreadable lane as `failed`. */
type Tally = { failed: number; readsRemotes: boolean; lanes: TallyLane[] | null };

/** `ade cloud push-work --json` / `work-state --json`: the tally, or null when unreadable. */
export function readTally(stdout: string): Tally | null {
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
export function leftLanes(tally: Tally): string | null {
  if (!tally.lanes) return "This computer's ADE is too old to say what isn't pushed.";
  if (tally.failed > 0) return "ADE couldn't read or push every project on it.";
  const left = tally.lanes.filter((lane) => !laneIsSafe(lane, tally.readsRemotes));
  if (left.length === 0) return null;
  const names = left.map((lane) => lane.laneName || lane.branchRef).filter(Boolean);
  return `Work that isn't on GitHub yet${names.length ? `: ${names.join(", ")}` : ""}.`;
}
