import { captureCloudAction, type CloudWaitUntil } from "./analytics";
import {
  CLOUD_PLAN_CLEANUP_GRACE_DAYS,
  planCleanupSentence,
  type CloudPlanCleanup,
  type CloudPlanCleanupComputer,
  type CloudPlanCleanupDone,
  type CloudPlanId,
} from "./contract";
import { sendCloudEmail } from "./email";
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
  logCloud,
  powerLogStatement,
  reportCloudFailure,
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
/** Interrupt and save first (40 s), then push: bounded like the desktop's 3-minute push. */
const PUSH_TIMEOUT_MS = 4 * 60_000;
const CHECK_TIMEOUT_MS = 2 * 60_000;
const DONE_SHOWN_MS = 14 * DAY_MS;

/** `$ADE_HOME/bin` holds the newer ADE; ADE on the computer answers a few seconds after a start. */
const commandWith = (...lines: string[]) => [
  'export PATH="$ADE_HOME/bin:$PATH"',
  'i=0; until ade projects list --json >/dev/null 2>&1 || [ "$i" -ge 25 ]; do sleep 1; i=$((i+1)); done',
  ...lines,
].join("\n");
const PUSH_COMMAND = commandWith("ade cloud prepare-stop --timeout 40 >/dev/null 2>&1 || true", "ade cloud push-work --json");
const CHECK_COMMAND = commandWith("ade cloud work-state --json");

export type PlanCleanupAccountRow = AccountRow & {
  plan_cleanup_due_at?: number | null;
  plan_cleanup_result_json?: string | null;
  plan_cleanup_result_at?: number | null;
};

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

/**
 * For `GET /cloud/account`: what the plan in force (or the cheaper plan a
 * downgrade or cancel waits for) frees, and what moving to each cheaper plan
 * now would free, for the warning before the change.
 */
export function planCleanupState(env: CloudEnv, account: PlanCleanupAccountRow, computers: ComputerRow[], now: number): {
  planCleanup: CloudPlanCleanup | null;
  downgradePreviews: { plus?: CloudPlanCleanup; free?: CloudPlanCleanup };
  planCleanupDone: CloudPlanCleanupDone | null;
} {
  const inForce = cleanupPlanOf(account);
  const waiting = waitingPlanOf(account);
  let planCleanup: CloudPlanCleanup | null = null;
  if (inForce) {
    const current = planCleanupFor(env, account, computers, inForce);
    if (current) planCleanup = { ...current, dueAt: account.plan_cleanup_due_at ?? now + PLAN_CLEANUP_GRACE_MS };
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

function readDone(account: PlanCleanupAccountRow, now: number): CloudPlanCleanupDone | null {
  if (!account.plan_cleanup_result_json || account.plan_cleanup_result_at == null || now - account.plan_cleanup_result_at > DONE_SHOWN_MS) return null;
  try {
    return JSON.parse(account.plan_cleanup_result_json) as CloudPlanCleanupDone;
  } catch {
    return null;
  }
}

/* ---- What the person is told ---- */

const PLAN_NAMES: Record<CloudPlanId, string> = { free: "the free plan", plus: "Plus", pro: "Pro" };

/** "Dec 4": the day in UTC, the zone the server's periods end in. */
const utcDate = (ms: number): string => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * The email when a downgrade or cancel is made and the cheaper plan's limits
 * would free computers (from the Stripe webhook's `announceChange`).
 */
export async function warnPlanCleanupAhead(env: CloudEnv, account: AccountRow, computers: ComputerRow[], toPlan: CloudPlanId): Promise<void> {
  const cleanup = planCleanupFor(env, account, computers, toPlan);
  if (!cleanup) return;
  const starts = utcDate(account.period_end);
  logCloud("cloud.plan_cleanup_warned_ahead", { userId: account.user_id, to: toPlan, computers: cleanup.computers.length });
  await sendCloudEmail(env, {
    userId: account.user_id,
    subject: `Your ADE Cloud computers go past ${PLAN_NAMES[toPlan]} on ${starts}`,
    text: `You move to ${PLAN_NAMES[toPlan]} on ${starts}.\n${cleanup.sentence}\nThis happens on ${utcDate(account.period_end + PLAN_CLEANUP_GRACE_MS)}, ${CLOUD_PLAN_CLEANUP_GRACE_DAYS} days after the change.`,
  });
}

async function warnPlanCleanupDue(env: CloudEnv, account: AccountRow, cleanup: Omit<CloudPlanCleanup, "dueAt">, dueAt: number): Promise<void> {
  await sendCloudEmail(env, {
    userId: account.user_id,
    subject: `ADE Cloud frees ${cleanup.computers.length === 1 ? "a computer" : `${cleanup.computers.length} computers`} on ${utcDate(dueAt)}`,
    text: `Your account is on ${PLAN_NAMES[cleanup.planId]} now and holds more than it allows.\n${cleanup.sentence}\nThis happens on ${utcDate(dueAt)}. Delete computers you no longer use before then to choose yourself.`,
  });
}

async function tellPlanCleanupDone(env: CloudEnv, account: AccountRow, done: CloudPlanCleanupDone): Promise<void> {
  const lines: string[] = [];
  if (done.freed.length) {
    lines.push(`To fit ${PLAN_NAMES[done.planId]}, ADE pushed each lane's work to GitHub and removed these computers:`);
    for (const entry of done.freed) {
      lines.push(`${entry.name}: work on ${entry.branch ? `the branch ${entry.branch}` : "its branches"}.${entry.laneKept ? " The lane and its chats stay; its next message makes a new computer." : ""}`);
    }
  }
  if (done.kept.length) {
    lines.push(`ADE kept ${done.kept.length === 1 ? "this computer" : "these computers"}, because its work couldn't all be pushed to GitHub. Open the lane and push its work, or delete the computer yourself. ADE tries again tomorrow.`);
    for (const entry of done.kept) lines.push(`${entry.name}: ${entry.reason}`);
  }
  await sendCloudEmail(env, {
    userId: account.user_id,
    subject: done.freed.length ? `ADE Cloud freed ${done.freed.length === 1 ? "a computer" : `${done.freed.length} computers`} to fit ${PLAN_NAMES[done.planId]}` : "ADE Cloud couldn't push a computer's work",
    text: lines.join("\n"),
  });
}

/* ---- The run ---- */

/**
 * From the ten-minute owner check: for each account with computers, sets or
 * clears its cleanup, warns once when it is set, and frees what is due, at
 * most `CLEANUPS_PER_RUN` computers a run.
 */
export async function runPlanCleanups(env: CloudEnv, provider: CloudProvider, computers: ComputerRow[], now: number, waitUntil?: CloudWaitUntil): Promise<void> {
  const byUser = groupByUser(computers);
  if (byUser.size === 0) return;
  const accounts = await env.DB.prepare("select * from cloud_accounts where deleted_at is null and user_id in (select value from json_each(?))")
    .bind(JSON.stringify([...byUser.keys()])).all<PlanCleanupAccountRow>();
  let budget = CLEANUPS_PER_RUN;
  const runs: Promise<void>[] = [];
  for (const account of accounts.results ?? []) {
    try {
      const owned = (byUser.get(account.user_id) ?? []) as CleanupComputerRow[];
      const planId = cleanupPlanOf(account);
      const cleanup = planId ? planCleanupFor(env, account, owned, planId) : null;
      if (!cleanup || cleanup.computers.length === 0) {
        if (account.plan_cleanup_due_at != null) {
          await env.DB.prepare("update cloud_accounts set plan_cleanup_due_at = null where user_id = ?").bind(account.user_id).run();
          logCloud("cloud.plan_cleanup_cleared", { userId: account.user_id });
        }
        continue;
      }
      if (account.plan_cleanup_due_at == null) {
        const dueAt = now + PLAN_CLEANUP_GRACE_MS;
        // Guarded: an overlapping run sets it (and warns) once.
        const set = await env.DB.prepare("update cloud_accounts set plan_cleanup_due_at = ? where user_id = ? and plan_cleanup_due_at is null")
          .bind(dueAt, account.user_id).run();
        if ((set.meta?.changes ?? 0) === 1) {
          logCloud("cloud.plan_cleanup_set", { userId: account.user_id, plan: cleanup.planId, computers: cleanup.computers.length });
          await warnPlanCleanupDue(env, account, cleanup, dueAt);
        }
        continue;
      }
      if (now < account.plan_cleanup_due_at || budget <= 0) continue;
      // A move or an update in flight is waited out: it changes which computers exist.
      if (owned.some((computer) => computer.moving_from != null || isPendingId(computer.instance_id) || computer.update_state === "updating")) continue;
      const due = cleanup.computers
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

type Outcome = { kind: "freed"; name: string; branch: string | null; laneKept: boolean } | { kind: "kept"; name: string; reason: string } | { kind: "skipped" };

async function runAccountCleanup(
  env: CloudEnv,
  provider: CloudProvider,
  account: PlanCleanupAccountRow,
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
 * Pushes one computer's work from the computer itself, then deletes it,
 * keeping its lane. Anything short of "everything is on GitHub" keeps it.
 */
async function freeComputer(env: CloudEnv, provider: CloudProvider, computer: CleanupComputerRow, now: number): Promise<Outcome> {
  const claimed = await env.DB.prepare(`
    update cloud_computers set plan_cleanup_claimed_at = ?
    where instance_id = ? and deleted_at is null and (plan_cleanup_claimed_at is null or plan_cleanup_claimed_at < ?)
  `).bind(now, computer.instance_id, now - CLAIM_STALE_MS).run();
  if ((claimed.meta?.changes ?? 0) !== 1) return { kind: "skipped" };
  const keep = async (reason: string, code: string): Promise<Outcome> => {
    reportCloudFailure("cloud.plan_cleanup_kept", { instanceId: computer.instance_id, code });
    await env.DB.prepare("update cloud_computers set plan_cleanup_claimed_at = null, plan_cleanup_failed_at = ? where instance_id = ?")
      .bind(now, computer.instance_id).run();
    return { kind: "kept", name: nameOf(computer), reason };
  };
  try {
    const metadata = await wakeForPush(env, provider, computer, now);
    const pushed = readTally((await provider.exec(computer.instance_id, PUSH_COMMAND, PUSH_TIMEOUT_MS)).stdout);
    if (!pushed) return keep("ADE on the computer didn't answer the push.", "push_unreadable");
    const left = leftLanes(pushed);
    if (left) return keep(left, "push_left_work");
    // Read once more: anything new or unknown keeps it.
    const checked = readTally((await provider.exec(computer.instance_id, CHECK_COMMAND, CHECK_TIMEOUT_MS)).stdout);
    if (!checked) return keep("ADE couldn't confirm all work is on GitHub.", "check_unreadable");
    const stillLeft = leftLanes(checked);
    if (stillLeft) return keep(stillLeft, "check_left_work");

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

/**
 * Wakes a resting computer for the push, as the person's push-work wake does:
 * the time isn't charged, isn't counted as use, and the tick's stops and
 * sleeps leave it alone. Answers the computer's metadata.
 */
async function wakeForPush(env: CloudEnv, provider: CloudProvider, computer: ComputerRow, now: number): Promise<Record<string, string>> {
  let instance = await provider.getInstance(computer.instance_id);
  if (isMeteredStatus(instance.status)) return instance.metadata;
  const status = await provider.startInstance(computer.instance_id);
  await env.DB.batch([
    env.DB.prepare(`
      update cloud_computers set status = ?, status_changed_at = ?, awake_since = ?, free_wake_started_at = ?, free_wake_until = ?, zero_stop_started_at = null, cold_storage = 0
      where instance_id = ? and deleted_at is null and awake_since is null
    `).bind(status, now, now + FREE_WAKE_MS, now, now + FREE_WAKE_MS, computer.instance_id),
    powerLogStatement(env, computer, "start", "plan_cleanup", now),
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

type Tally = { failed: number; lanes: Array<{ laneId: string; laneName: string; branchRef: string; state: string }> | null };

/** `ade cloud push-work --json` / `work-state --json`: the tally, or null when unreadable. */
function readTally(stdout: string): Tally | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    const tally = (parsed.result && typeof parsed.result === "object" ? parsed.result : parsed) as Record<string, unknown>;
    const lanes = Array.isArray(tally.lanes)
      ? tally.lanes.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const lane = entry as Record<string, unknown>;
        return typeof lane.laneId === "string" ? [{
          laneId: lane.laneId,
          laneName: typeof lane.laneName === "string" ? lane.laneName : "",
          branchRef: typeof lane.branchRef === "string" ? lane.branchRef : "",
          state: typeof lane.state === "string" ? lane.state : "unpushed",
        }] : [];
      })
      : null;
    return { failed: Number(tally.failed) || 0, lanes };
  } catch {
    return null;
  }
}

/** Why work stays on the computer, or null when everything is on GitHub. An older ADE without the lane list can't say: it stays. */
function leftLanes(tally: Tally): string | null {
  if (!tally.lanes) return "This computer's ADE is too old to say what isn't pushed.";
  if (tally.failed > 0) return "ADE couldn't read or push every project on it.";
  const left = tally.lanes.filter((lane) => lane.state === "unpushed" || lane.state === "failed");
  if (left.length === 0) return null;
  const names = left.map((lane) => lane.laneName || lane.branchRef).filter(Boolean);
  return `Work that isn't on GitHub yet${names.length ? `: ${names.join(", ")}` : ""}.`;
}
