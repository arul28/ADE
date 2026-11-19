import { KEEP_AWAKE_STATE_COMMAND, keepAwakeOf, keepAwakeWrittenAt, pushWorkCommand, readPushWorkTally, type PushWorkLane } from "./computerCommands";
import type { CloudFreeRecord, CloudFreeState } from "./contract";
import { UNREADABLE_REQUEST_MESSAGE, UUID_PATTERN, badRequest, fail, json, readJson } from "./http";
import { JOB_RECORD_TTL_MS, nudgeJob, readJob, registerJobKind, runJob, type CloudJobDeps, type JobContext, type JobRow, type StepResult } from "./jobs";
import { laneFactsOf, laneFactsOfRow, markKeepLaneStatement, mergeLaneFacts, namesLane, unmarkKeepLaneStatement } from "./lanesWithoutComputer";
import { CloudProviderError } from "./provider";
import { deleteComputer, logCloud, ownedComputer, statusChangeStatements, type CloudEnv, type ComputerRow } from "./store";

/**
 * "Free the computer, keep the lane", run by the server (a `cloud_jobs` kind,
 * `jobs.ts`), so no app has to stay open and every client (desktop, web,
 * phone, CLI) does the same thing. The steps, each short:
 *
 *   check   the computer holds a lane; awake (woken when it rests, which uses
 *           hours) and nothing is working on it: an agent, or the lane's own
 *           setup still running (a launch waiting for a provider sign-in);
 *   push    `ade cloud push-work` on the computer: every lane's work is
 *           committed and pushed to its branch;
 *   recheck `ade cloud work-state`: anything new or unknown keeps the computer;
 *   delete  marks the lane kept (`lanesWithoutComputer.ts`) on the branch the
 *           push named, then deletes the computer. The next message on that
 *           lane makes a new computer on the same branch.
 *
 * Nothing is deleted until the work is on GitHub. A failure before the delete
 * leaves the computer as it was (a lane mark is taken back).
 */

export const FREE_JOB_KIND = "free";

const WAKE_WAIT_MAX_MS = 10 * 60_000;
const WAKE_POLL_MS = 10_000;
const KEEP_AWAKE_EXEC_MS = 30_000;
/**
 * The computer writes its busy file at its once-a-minute check, so one read
 * right after a turn or a command ended can still say busy. A busy file
 * written before the free started is read again until the next check wrote
 * it, at most this long; then it is taken as it is.
 */
const KEEP_AWAKE_FRESH_MAX_MS = 75_000;
const KEEP_AWAKE_FRESH_POLL_MS = 5_000;
/**
 * The desktop's 3 minutes (`PUSH_ALL_WORK_TIMEOUT_MS`) plus the minute the git
 * warm-up may take: a frozen push can't hold the computer awake for long.
 */
const PUSH_EXEC_MS = 4 * 60_000;
const CHECK_EXEC_MS = 2 * 60_000;
const DELETE_CONFIRM_MAX_MS = 3 * 60_000;
const DELETE_CONFIRM_POLL_MS = 10_000;
/** Steps a cancel may still stop: nothing is pushed or deleted yet. */
const CANCELLABLE_STEPS: ReadonlySet<string> = new Set(["check"]);

type FreeFacts = {
  laneId?: string | null;
  laneName?: string | null;
  branchRef?: string | null;
  wakeAskedAt?: number;
  /** When the check first found a busy file older than the free, for `KEEP_AWAKE_FRESH_MAX_MS`. */
  freshWaitFrom?: number;
  /** Set once the lane is marked kept: an undo takes the mark back. */
  laneMarked?: boolean;
  laneKept?: boolean;
};

function factsOf(job: JobRow): FreeFacts {
  try {
    return (job.facts_json ? JSON.parse(job.facts_json) : {}) as FreeFacts;
  } catch {
    return {};
  }
}

const withFacts = (job: JobRow, patch: Partial<FreeFacts>): string => JSON.stringify({ ...factsOf(job), ...patch });
const nameOf = (job: JobRow): string => job.source_name || job.source_instance_id || "the computer";
const laneNamesOf = (lanes: readonly PushWorkLane[]): string => {
  const names = lanes.map((lane) => (lane.primary ? "main checkout" : lane.laneName || lane.branchRef)).filter(Boolean);
  return names.length ? ` (${names.join(", ")})` : "";
};
const withoutStop = (text: string): string => text.trim().replace(/[.!?…]+$/, "");

export function freeRecordOf(job: JobRow): CloudFreeRecord {
  const facts = factsOf(job);
  const finished = job.state === "done" || job.state === "failed" || job.state === "cancelled";
  return {
    freeId: job.job_id,
    instanceId: job.source_instance_id ?? "",
    name: nameOf(job),
    laneId: facts.laneId ?? null,
    laneName: facts.laneName ?? null,
    branchRef: facts.branchRef ?? null,
    state: job.state as CloudFreeState,
    message: job.message ?? "",
    error: job.state === "failed" ? job.error : null,
    laneKept: job.state === "done" ? facts.laneKept === true : null,
    cancellable: !finished && job.cancel_requested_at == null && CANCELLABLE_STEPS.has(job.step),
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };
}

async function computerOf(env: CloudEnv, job: JobRow): Promise<ComputerRow | null> {
  return job.source_instance_id ? await ownedComputer(env, job.user_id, job.source_instance_id) : null;
}

const GONE: StepResult = { kind: "fail", error: "ADE Cloud has no such computer." };

async function tryExec(ctx: JobContext, instanceId: string, command: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr?: string } | null> {
  try {
    return await ctx.provider.exec(instanceId, command, timeoutMs);
  } catch (error) {
    logCloud("cloud.free_exec_failed", { instanceId, code: error instanceof CloudProviderError ? error.code : "unknown" });
    return null;
  }
}

/** Awake, or a wait while it wakes (null: go on). */
async function awake(env: CloudEnv, job: JobRow, ctx: JobContext, computer: ComputerRow): Promise<StepResult | null> {
  const instance = await ctx.provider.getInstance(computer.instance_id);
  if (instance.status !== computer.status) {
    const statements = statusChangeStatements(env, computer, instance.status, ctx.now, "free");
    if (statements.length) await env.DB.batch(statements);
  }
  if (instance.status === "running") return null;
  if (instance.status === "failed") return { kind: "fail", error: "The computer didn't wake up, so ADE couldn't push its work. Nothing was deleted." };
  const facts = factsOf(job);
  const asked = facts.wakeAskedAt ?? null;
  if (asked != null && ctx.now - asked > WAKE_WAIT_MAX_MS) return { kind: "fail", error: "The computer didn't wake up in time, so ADE couldn't push its work. Nothing was deleted." };
  const waking = instance.status === "starting" || instance.status === "waking" || instance.status === "creating";
  if (!waking && asked == null) {
    // Noted first: a tick that dies after the ask doesn't ask twice.
    await ctx.save({ facts_json: withFacts(job, { wakeAskedAt: ctx.now }) });
    const status = await ctx.provider.startInstance(computer.instance_id);
    const statements = statusChangeStatements(env, computer, status, ctx.now, "free");
    if (statements.length) await env.DB.batch(statements);
    return { kind: "wait", delayMs: WAKE_POLL_MS, patch: { facts_json: withFacts(job, { wakeAskedAt: ctx.now }), message: `Waking ${nameOf(job)} to push its work…` } };
  }
  return { kind: "wait", delayMs: WAKE_POLL_MS, patch: { message: `Waking ${nameOf(job)} to push its work…` } };
}

async function check(env: CloudEnv, job: JobRow, ctx: JobContext): Promise<StepResult> {
  const computer = await computerOf(env, job);
  if (!computer) return GONE;
  const waiting = await awake(env, job, ctx, computer);
  if (waiting) return waiting;
  // A running agent could write again after its lane was pushed; a setup still running hasn't made the lane yet.
  const read = await tryExec(ctx, computer.instance_id, KEEP_AWAKE_STATE_COMMAND, KEEP_AWAKE_EXEC_MS);
  const work = read ? keepAwakeOf(read.stdout) : "unknown";
  if ((work === "busy" || work === "setup") && read && keepAwakeWrittenAt(read.stdout) < job.created_at) {
    const from = factsOf(job).freshWaitFrom ?? ctx.now;
    if (ctx.now - from < KEEP_AWAKE_FRESH_MAX_MS) {
      return {
        kind: "wait",
        delayMs: KEEP_AWAKE_FRESH_POLL_MS,
        patch: { message: "Checking whether the agent is still working…", facts_json: withFacts(job, { freshWaitFrom: from }) },
      };
    }
  }
  if (work === "setup") return { kind: "fail", error: "This lane is still being set up. Finish signing in, or cancel the setup, then free the computer." };
  if (work === "busy") return { kind: "fail", error: "The agent is still working. Stop it or wait, then free the computer." };
  if (work === "unknown") return { kind: "fail", error: "ADE couldn't tell whether the agent is still working, so the computer stays. Try again in a moment." };
  return { kind: "next", step: "push", patch: { state: "pushing", message: `Pushing ${nameOf(job)}'s work to GitHub…` } };
}

async function push(env: CloudEnv, job: JobRow, ctx: JobContext): Promise<StepResult> {
  const computer = await computerOf(env, job);
  if (!computer) return GONE;
  const waiting = await awake(env, job, ctx, computer);
  if (waiting) return waiting;
  // Archived lanes too: their work goes with the computer.
  const ran = await tryExec(ctx, computer.instance_id, pushWorkCommand(false), PUSH_EXEC_MS);
  const tally = ran && ran.exitCode === 0 ? readPushWorkTally(ran.stdout) : null;
  if (!tally) return { kind: "fail", error: "ADE couldn't push this lane's work, so the computer stays. Try again." };
  logCloud("cloud.free_pushed", { jobId: job.job_id, pushed: tally.pushed, failed: tally.failed, skipped: tally.skipped });
  const left = (tally.lanes ?? []).filter((lane) => lane.state === "unpushed" || lane.state === "failed");
  if (tally.failed > 0 || left.length > 0 || (!tally.lanes && tally.skipped > 0)) {
    // A lane it couldn't read (nothing seen to push, the read itself failed)
    // is not a lane to open and fix: say that, apart from work that didn't push.
    // Unknown (an older ADE) counts as work.
    const unpushed = left.filter((lane) => lane.state === "unpushed" || lane.dirty !== false || lane.ahead !== 0);
    // The read can fail for a while (a cold disk right after a wake) or for
    // good (a lane folder that's no longer a Git worktree): name the lanes and
    // say what to do in both cases.
    // An older ADE names no lanes: say so plainly, as work that didn't push.
    if (left.length === 0) return { kind: "fail", error: "ADE couldn't push all work on this computer, so it stays. Open the lane to see why, then try again." };
    if (unpushed.length === 0) {
      return { kind: "fail", error: `ADE couldn't read the work in${laneNamesOf(left)}, so nothing was deleted. Try again in a minute; if it fails again, open that lane to see why.` };
    }
    return { kind: "fail", error: `ADE couldn't push the work in${laneNamesOf(unpushed)} to GitHub, so the computer stays. Open it, push or discard that work, then try again.` };
  }
  const facts = factsOf(job);
  const own = tally.lanes?.find((lane) => lane.laneId === facts.laneId) ?? tally.lanes?.find((lane) => !lane.primary) ?? null;
  const branchRef = own?.branchRef?.trim() || facts.branchRef || null;
  if (!branchRef) return { kind: "fail", error: "ADE couldn't tell which branch this lane is on, so the computer stays." };
  return { kind: "next", step: "recheck", patch: { facts_json: withFacts(job, { branchRef }), message: "Checking that everything is on GitHub…" } };
}

async function recheck(env: CloudEnv, job: JobRow, ctx: JobContext): Promise<StepResult> {
  const computer = await computerOf(env, job);
  if (!computer) return GONE;
  const waiting = await awake(env, job, ctx, computer);
  if (waiting) return waiting;
  // Read once more after the push: anything new or unknown keeps the computer.
  const ran = await tryExec(ctx, computer.instance_id, pushWorkCommand(true, { afterPush: true }), CHECK_EXEC_MS);
  const tally = ran && ran.exitCode === 0 ? readPushWorkTally(ran.stdout) : null;
  if (!tally || !tally.lanes) return { kind: "fail", error: "ADE couldn't confirm all work is on GitHub, so the computer stays. Try again." };
  if (tally.failed > 0) return { kind: "fail", error: "ADE couldn't read every project on this computer, so it stays. Try again." };
  const left = tally.lanes.filter((lane) => lane.state === "unpushed" || lane.state === "failed");
  if (left.length > 0) return { kind: "fail", error: `Work changed on this computer while ADE pushed it${laneNamesOf(left)}, so it stays. Try again.` };
  return { kind: "next", step: "delete", patch: { state: "deleting", message: `Removing ${nameOf(job)}…` } };
}

async function remove(env: CloudEnv, job: JobRow, ctx: JobContext): Promise<StepResult> {
  const computer = await computerOf(env, job);
  const facts = factsOf(job);
  // Gone already: a tick that died after the delete.
  if (!computer) return { kind: "next", step: "confirm_delete" };
  const lane = mergeLaneFacts(laneFactsOfRow(computer), laneFactsOf((await ctx.provider.getInstance(computer.instance_id).catch(() => null))?.metadata));
  if (facts.branchRef) lane.branch = facts.branchRef;
  if (!namesLane(lane)) return { kind: "fail", error: "ADE Cloud doesn't know a lane on this computer, so there is no lane to keep. Nothing was deleted." };
  await ctx.save({ facts_json: withFacts(job, { laneMarked: true }) });
  await markKeepLaneStatement(env, computer, lane, "freed").run();
  await deleteComputer(env, ctx.provider, computer, { who: "free", reason: "freed" }, ctx.now);
  return { kind: "next", step: "confirm_delete", patch: { source_deleted: 1, facts_json: withFacts(job, { laneMarked: true }) } };
}

async function confirmDelete(env: CloudEnv, job: JobRow, ctx: JobContext): Promise<StepResult> {
  let gone = false;
  try {
    const instance = await ctx.provider.getInstance(job.source_instance_id!);
    gone = instance.status === "deleted" || instance.status === "deleting";
  } catch (error) {
    if (!(error instanceof CloudProviderError && error.status === 404)) throw error;
    gone = true;
  }
  const started = job.step_started_at ?? ctx.now;
  if (!gone && ctx.now - started <= DELETE_CONFIRM_MAX_MS) {
    await ctx.provider.deleteInstance(job.source_instance_id!).catch(() => undefined);
    return { kind: "wait", delayMs: DELETE_CONFIRM_POLL_MS };
  }
  const facts = factsOf(job);
  const kept = facts.laneId
    ? await env.DB.prepare("select 1 as kept from cloud_lanes_without_computer where user_id = ? and lane_id = ? limit 1")
      .bind(job.user_id, facts.laneId).first<{ kept: number }>()
    : null;
  const laneKept = kept != null;
  logCloud("cloud.lane_freed", { jobId: job.job_id, instanceId: job.source_instance_id, laneKept, confirmed: gone });
  return {
    kind: "end",
    patch: {
      state: "done",
      source_deleted: 1,
      facts_json: withFacts(job, { laneKept }),
      message: laneKept
        ? "The work is on GitHub and the computer is removed. The next message makes a new computer on the same branch."
        : "The work is on GitHub and the computer is removed. Start a new lane on its branch to go on.",
    },
  };
}

async function runFreeStep(env: CloudEnv, job: JobRow, ctx: JobContext): Promise<StepResult> {
  switch (job.step) {
    case "check": return await check(env, job, ctx);
    case "push": return await push(env, job, ctx);
    case "recheck": return await recheck(env, job, ctx);
    case "delete": return await remove(env, job, ctx);
    case "confirm_delete": return await confirmDelete(env, job, ctx);
    default: return { kind: "fail", error: "ADE Cloud lost track of this job." };
  }
}

registerJobKind(FREE_JOB_KIND, {
  run: runFreeStep,
  failed: (_job, error) => ({ state: "failed", message: error, error }),
  // Only a lane mark whose delete didn't happen is left to take back.
  undo: async (env, job) => {
    if (job.source_deleted === 1 || !factsOf(job).laneMarked || !job.source_instance_id) return true;
    await unmarkKeepLaneStatement(env, job.source_instance_id).run();
    return true;
  },
  cancellable: (step) => CANCELLABLE_STEPS.has(step),
  cancelled: (job) => ({ state: "cancelled", message: `Cancelled. ${nameOf(job)} is as it was.` }),
});

/* ---- The routes ---- */

export type FreeRouteDeps = CloudJobDeps & {
  now: number;
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Why a resting computer may not wake to push its work now (hours, the awake cap); null when it may. */
  wakeRefusal?: () => Promise<Response | null>;
};

const isUuid = (value: unknown): value is string => typeof value === "string" && UUID_PATTERN.test(value.trim().toLowerCase());

/** `POST /cloud/instances/:id/free` `{ freeId }`. */
export async function handleFreeStart(request: Request, env: CloudEnv, computer: ComputerRow, deps: FreeRouteDeps): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  if (!isUuid(body.freeId)) return badRequest("Freeing a computer needs an id (a UUID).");
  const freeId = body.freeId.trim().toLowerCase();
  const existing = await readJob(env, freeId);
  if (existing) {
    if (existing.user_id !== computer.user_id || existing.kind !== FREE_JOB_KIND || existing.source_instance_id !== computer.instance_id) {
      return badRequest("That id can't be used.");
    }
    return json(freeRecordOf(existing), 200);
  }
  const live = await env.DB.prepare("select * from cloud_jobs where source_instance_id = ? and state not in ('done', 'failed', 'cancelled') limit 1")
    .bind(computer.instance_id).first<JobRow>();
  if (live?.kind === FREE_JOB_KIND) return json(freeRecordOf(live), 200);
  if (live) return fail("computer_busy", "This computer is moving to another kind. Wait for it to finish, then try again.", 409);
  const lane = laneFactsOfRow(computer);
  const facts: FreeFacts = { laneId: lane.laneId, laneName: lane.laneName, branchRef: lane.branch };
  if (!lane.laneId) {
    const live = laneFactsOf((await deps.provider?.getInstance(computer.instance_id).catch(() => null))?.metadata);
    if (!namesLane(live)) return fail("no_lane", "This computer wasn't made for one lane, so there is no lane to keep. Delete it, or keep it.", 409);
    Object.assign(facts, { laneId: live.laneId, laneName: live.laneName, branchRef: live.branch });
  }
  if (!deps.provider) return fail("unavailable", "ADE Cloud can't free a computer right now. Try again soon.", 503);
  const wake = await deps.wakeRefusal?.();
  if (wake) return wake;
  const { now } = deps;
  try {
    await env.DB.prepare(`
      insert into cloud_jobs (job_id, kind, user_id, source_instance_id, source_name, source_machine_key, params_json, state, step, message,
        facts_json, next_at, created_at, updated_at, expires_at)
      values (?, ?, ?, ?, ?, ?, '{}', 'checking', 'check', ?, ?, ?, ?, ?, ?)
    `).bind(
      freeId, FREE_JOB_KIND, computer.user_id, computer.instance_id, computer.name ?? computer.instance_id, computer.machine_key,
      `Checking ${computer.name ?? "the computer"}…`, JSON.stringify(facts), now, now, now, now + JOB_RECORD_TTL_MS,
    ).run();
  } catch (error) {
    // Another job for this computer got in first (one live job per computer), or the same id did.
    const winner = await readJob(env, freeId);
    if (winner && winner.user_id === computer.user_id) return json(freeRecordOf(winner), 200);
    if (/UNIQUE/i.test(error instanceof Error ? error.message : "")) {
      return fail("computer_busy", "Something else is changing this computer. Wait for it to finish, then try again.", 409);
    }
    throw error;
  }
  logCloud("cloud.free_started", { userId: computer.user_id, jobId: freeId, instanceId: computer.instance_id });
  if (deps.waitUntil) deps.waitUntil(runJob(env, freeId, deps, { fromRequest: true }).catch(() => undefined));
  return json(freeRecordOf((await readJob(env, freeId))!), 201);
}

/** `GET /cloud/frees/:id`. A watched free runs its due step right after the answer (`nudgeJob`). */
export async function routeFrees(request: Request, path: string, env: CloudEnv, userId: string, deps: FreeRouteDeps): Promise<Response> {
  const notFound = () => fail("not_found", "ADE Cloud has no such job.", 404);
  const freeId = path.slice("/cloud/frees/".length);
  if (request.method !== "GET" || !isUuid(freeId)) return notFound();
  const job = await readJob(env, freeId.toLowerCase());
  if (!job || job.user_id !== userId || job.kind !== FREE_JOB_KIND) return notFound();
  nudgeJob(env, job, deps, deps.waitUntil, deps.now);
  return json(freeRecordOf(job));
}
