import type { CloudProvider } from "./provider";
import type { CreateComputerExtras, CreateComputerOutcome } from "./createOutcome";
import { logCloud, reportCloudFailure, type CloudEnv, type ComputerRow } from "./store";

/**
 * ADE Cloud jobs the server runs on its own (migration 0049, `cloud_jobs`):
 * long work on the account's computers that no client has to stay open for,
 * run a step at a time. A request starts a job and may run its first step
 * after its answer (`waitUntil`); the minute cron runs every due job one or
 * two steps a tick (`runCloudJobs`), so no request and no tick holds a long
 * step. Each kind (`moves.ts`, `frees.ts`, `copies.ts`) says what its steps do.
 *
 * - A runner takes a job with a lease (`claimJob`): only that runner writes it
 *   until the lease ends (every write names the lease), so a tick that died
 *   mid-step leaves the job to a later one, which runs the same step again.
 *   So every step must be safe to run twice.
 * - A step answers what comes next: the next step now (`next`), the same step
 *   later (`wait`, a poll), the end (`end`), or a failure (`fail`) with the
 *   sentence the person reads. A step that throws is tried again with a
 *   backoff, then fails.
 * - A failure runs the kind's undo in the same lease; an undo that can't
 *   finish (a provider that refuses a delete) is tried again on later ticks.
 * - A cancel is asked for on the row (`cancel_requested_at`) and done by the
 *   runner between two steps, only while the kind says the step allows it.
 */

/** The record states a job ends in. */
export const FINAL_JOB_STATES: ReadonlySet<string> = new Set(["done", "failed", "cancelled"]);
/** The step of a failed or cancelled job whose undo still has work left. */
export const UNDO_STEP = "undo";
/** The step of a job with nothing left to do. */
export const END_STEP = "end";
/** Longer than the longest step (a create waits up to five minutes for the provider). */
const LEASE_MS = 7 * 60_000;
/**
 * A run a request started after its answer lives at most 30 s more
 * (`waitUntil`): its lease ends soon after, so a step it couldn't finish is
 * picked up by the next minute's cron, not seven minutes later.
 */
const REQUEST_LEASE_MS = 60_000;
/** Most jobs one tick runs, and most steps each, so a tick stays short. */
const JOBS_PER_TICK = 5;
const STEPS_PER_RUN = 2;
/** A step that throws this many times in a row fails its job. */
const MAX_STEP_ATTEMPTS = 5;
const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;
/** An undo that can't finish is tried this often, then given up (and reported). */
const UNDO_RETRY_MS = 2 * 60_000;
const MAX_UNDO_ATTEMPTS = 30;
/** A finished job's record stays this long, then the cron deletes it. */
export const JOB_RECORD_TTL_MS = 7 * 24 * 60 * 60_000;
const EXPIRE_PER_TICK = 50;

export type JobRow = {
  job_id: string;
  kind: string;
  user_id: string;
  source_instance_id: string | null;
  source_name: string | null;
  source_machine_key: string | null;
  target_instance_id: string | null;
  target_launch_id: string | null;
  target_machine_key: string | null;
  params_json: string | null;
  state: string;
  step: string;
  message: string | null;
  error: string | null;
  approval_url: string | null;
  source_deleted: number | null;
  facts_json: string | null;
  attempts: number;
  step_started_at: number | null;
  next_at: number;
  lease_id: string | null;
  lease_until: number | null;
  cancel_requested_at: number | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
};

/** What a step may change on its job's row. */
export type JobPatch = Partial<Pick<JobRow,
  "state" | "message" | "error" | "approval_url" | "source_deleted" | "source_instance_id" | "target_instance_id" | "target_launch_id" | "target_machine_key" | "facts_json"
>>;

export type StepResult =
  /** Go on to `step`, now (or after `delayMs`). */
  | { kind: "next"; step: string; patch?: JobPatch; delayMs?: number }
  /** Run the same step again after `delayMs` (a poll). */
  | { kind: "wait"; delayMs: number; patch?: JobPatch }
  /** The job failed: the kind's undo runs, and `error` is what the person reads. */
  | { kind: "fail"; error: string }
  /** Nothing is left to do: `patch` names the end (`done`). */
  | { kind: "end"; patch: JobPatch };

/** What every kind's steps get. */
export type CloudJobDeps = {
  provider: CloudProvider | null;
  /** The one way a computer is made (`createComputer` in routes.ts). */
  createComputer: (userId: string, provider: CloudProvider, extras: CreateComputerExtras) => Promise<CreateComputerOutcome>;
  /** The one way a computer is copied (`forkComputer` in routes.ts); a copy's fork step waits without it. */
  forkComputer?: (source: ComputerRow, provider: CloudProvider, extras: Pick<CreateComputerExtras, "body" | "onMade">) => Promise<CreateComputerOutcome>;
  /** The clock (a test sets its own). */
  clock?: () => number;
};

export type JobContext = {
  provider: CloudProvider;
  deps: CloudJobDeps;
  now: number;
  /** Writes facts mid-step, under the runner's lease (a step that must note something before a provider call). */
  save: (patch: JobPatch) => Promise<void>;
};

export type CloudJobKind = {
  /** Runs `job.step` once. */
  run: (env: CloudEnv, job: JobRow, ctx: JobContext) => Promise<StepResult>;
  /** The row's fields for a failure with `error` (its state, the person's sentence). */
  failed: (job: JobRow, error: string) => JobPatch;
  /** Undoes what the job did, for a failure or a cancel. True once nothing is left to undo. */
  undo: (env: CloudEnv, job: JobRow, ctx: JobContext, why: "failed" | "cancelled") => Promise<boolean>;
  /** Whether a cancel may still stop the job at this step. */
  cancellable: (step: string) => boolean;
  /** The row's fields once a cancel stopped it. */
  cancelled: (job: JobRow) => JobPatch;
};

const KINDS = new Map<string, CloudJobKind>();

/** Each kind's module registers itself once (`moves.ts`). */
export function registerJobKind(kind: string, handler: CloudJobKind): void {
  KINDS.set(kind, handler);
}

export async function readJob(env: CloudEnv, jobId: string): Promise<JobRow | null> {
  return await env.DB.prepare("select * from cloud_jobs where job_id = ?").bind(jobId).first<JobRow>();
}

/** Whether the runner has something to do with this row: a live job, or an undo left over. */
export const jobIsDue = (job: Pick<JobRow, "state" | "step">): boolean =>
  !FINAL_JOB_STATES.has(job.state) || job.step === UNDO_STEP;

/** Takes the job for one run, or null when another runner holds it (or it has nothing to do). */
async function claimJob(env: CloudEnv, jobId: string, now: number, leaseMs: number): Promise<string | null> {
  const leaseId = crypto.randomUUID();
  const claimed = await env.DB.prepare(`
    update cloud_jobs set lease_id = ?, lease_until = ?
    where job_id = ? and (lease_until is null or lease_until <= ?)
      and (state not in ('done', 'failed', 'cancelled') or step = ?)
  `).bind(leaseId, now + leaseMs, jobId, now, UNDO_STEP).run();
  return (claimed.meta?.changes ?? 0) === 1 ? leaseId : null;
}

const PATCH_COLUMNS = ["state", "message", "error", "approval_url", "source_deleted", "source_instance_id", "target_instance_id", "target_launch_id", "target_machine_key", "facts_json"] as const;

/** One write under the lease; false when the lease was lost (another runner took the job). */
async function writeJob(
  env: CloudEnv,
  jobId: string,
  leaseId: string,
  now: number,
  write: { patch?: JobPatch; step?: string; nextAt?: number; attempts?: number; stepStarted?: boolean; release?: boolean; clearCancel?: boolean },
): Promise<boolean> {
  const sets: string[] = [];
  const binds: Array<string | number | null> = [];
  for (const column of PATCH_COLUMNS) {
    if (write.patch && Object.hasOwn(write.patch, column)) {
      sets.push(`${column} = ?`);
      binds.push(write.patch[column] ?? null);
    }
  }
  if (write.step !== undefined) {
    sets.push("step = ?");
    binds.push(write.step);
  }
  if (write.stepStarted) {
    sets.push("step_started_at = ?");
    binds.push(now);
  }
  if (write.nextAt !== undefined) {
    sets.push("next_at = ?");
    binds.push(write.nextAt);
  }
  if (write.attempts !== undefined) {
    sets.push("attempts = ?");
    binds.push(write.attempts);
  }
  if (write.release) sets.push("lease_id = null", "lease_until = null");
  if (write.clearCancel) sets.push("cancel_requested_at = null");
  sets.push("updated_at = ?");
  binds.push(now);
  const written = await env.DB.prepare(`update cloud_jobs set ${sets.join(", ")} where job_id = ? and lease_id = ?`)
    .bind(...binds, jobId, leaseId).run();
  return (written.meta?.changes ?? 0) === 1;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A sentence's end: what a step threw, as the person reads it. */
const asSentence = (text: string): string => {
  const trimmed = text.trim() || "Something went wrong.";
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

/**
 * Runs one job for up to `STEPS_PER_RUN` steps, if no other runner holds it.
 * Safe to call from a request (after its answer) and from the cron at once:
 * only one of them gets the lease.
 */
export async function runJob(env: CloudEnv, jobId: string, deps: CloudJobDeps, options: { fromRequest?: boolean } = {}): Promise<void> {
  const clock = deps.clock ?? (() => Date.now());
  const claimedAt = clock();
  const leaseId = await claimJob(env, jobId, claimedAt, options.fromRequest ? REQUEST_LEASE_MS : LEASE_MS);
  if (!leaseId) return;
  let released = false;
  try {
    for (let run = 0; run < STEPS_PER_RUN; run += 1) {
      if (run > 0) {
        // Each step gets the whole lease: a long one before it doesn't shorten it.
        const leaseMs = options.fromRequest ? REQUEST_LEASE_MS : LEASE_MS;
        const extended = await env.DB.prepare("update cloud_jobs set lease_until = ? where job_id = ? and lease_id = ?").bind(clock() + leaseMs, jobId, leaseId).run();
        if ((extended.meta?.changes ?? 0) !== 1) {
          released = true;
          return;
        }
      }
      const job = await readJob(env, jobId);
      if (!job || job.lease_id !== leaseId) {
        released = true;
        return;
      }
      const kind = KINDS.get(job.kind);
      if (!kind || !jobIsDue(job)) break;
      if (!deps.provider) break;
      const now = clock();
      const ctx: JobContext = {
        provider: deps.provider,
        deps,
        now,
        save: async (patch) => {
          if (!(await writeJob(env, jobId, leaseId, clock(), { patch }))) throw new Error("ADE Cloud lost track of this job for a moment.");
        },
      };
      // An undo left over from a failure or a cancel: tried until nothing is left.
      if (job.step === UNDO_STEP) {
        const why = job.state === "cancelled" ? "cancelled" : "failed";
        const done = await kind.undo(env, job, ctx, why).catch((error: unknown) => {
          reportCloudFailure("cloud.job_undo_failed", { jobId, kind: job.kind, message: errorText(error) });
          return false;
        });
        const attempts = job.attempts + 1;
        const giveUp = !done && attempts >= MAX_UNDO_ATTEMPTS;
        if (giveUp) reportCloudFailure("cloud.job_undo_gave_up", { jobId, kind: job.kind });
        await writeJob(env, jobId, leaseId, now, done || giveUp
          ? { step: END_STEP, attempts: 0, release: true }
          : { attempts, nextAt: now + UNDO_RETRY_MS, release: true });
        released = true;
        return;
      }
      // A cancel asked for since the last step: done now, if the step still allows it.
      if (job.cancel_requested_at != null) {
        if (kind.cancellable(job.step)) {
          await writeJob(env, jobId, leaseId, now, { patch: kind.cancelled(job), step: UNDO_STEP, attempts: 0, nextAt: now, clearCancel: true });
          logCloud("cloud.job_cancelled", { jobId, kind: job.kind, step: job.step });
          continue;
        }
        await writeJob(env, jobId, leaseId, now, { clearCancel: true });
      }
      let result: StepResult;
      try {
        result = await kind.run(env, job, ctx);
      } catch (error) {
        const attempts = job.attempts + 1;
        logCloud("cloud.job_step_threw", { jobId, kind: job.kind, step: job.step, attempts, message: errorText(error) });
        if (attempts < MAX_STEP_ATTEMPTS) {
          const delay = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (attempts - 1));
          await writeJob(env, jobId, leaseId, clock(), { attempts, nextAt: clock() + delay, release: true });
          released = true;
          return;
        }
        result = { kind: "fail", error: asSentence(errorText(error)) };
      }
      const after = clock();
      if (result.kind === "fail") {
        reportCloudFailure("cloud.job_failed", { jobId, kind: job.kind, step: job.step, message: result.error });
        await writeJob(env, jobId, leaseId, after, { patch: kind.failed(job, result.error), step: UNDO_STEP, attempts: 0, nextAt: after });
        continue;
      }
      if (result.kind === "end") {
        await writeJob(env, jobId, leaseId, after, { patch: result.patch, step: END_STEP, attempts: 0, release: true });
        logCloud("cloud.job_ended", { jobId, kind: job.kind, state: result.patch.state ?? job.state });
        released = true;
        return;
      }
      if (result.kind === "wait") {
        await writeJob(env, jobId, leaseId, after, { patch: result.patch, nextAt: after + result.delayMs, attempts: 0, release: true });
        released = true;
        return;
      }
      const delay = result.delayMs ?? 0;
      await writeJob(env, jobId, leaseId, after, { patch: result.patch, step: result.step, stepStarted: true, attempts: 0, nextAt: after + delay });
      if (delay > 0) break;
    }
  } finally {
    if (!released) {
      await env.DB.prepare("update cloud_jobs set lease_id = null, lease_until = null where job_id = ? and lease_id = ?").bind(jobId, leaseId).run()
        .catch((error: unknown) => reportCloudFailure("cloud.job_release_failed", { jobId, message: errorText(error) }));
    }
  }
}

/**
 * The minute cron's share: the due jobs, a few a tick, one after another (each
 * step is a few provider calls); then the records past their week. One
 * indexed read when there are none.
 */
export async function runCloudJobs(env: CloudEnv, deps: CloudJobDeps): Promise<number> {
  const now = (deps.clock ?? (() => Date.now()))();
  const due = (await env.DB.prepare(`
    select job_id from cloud_jobs
    where next_at <= ? and (state not in ('done', 'failed', 'cancelled') or step = ?) and (lease_until is null or lease_until <= ?)
    order by next_at limit ?
  `).bind(now, UNDO_STEP, now, JOBS_PER_TICK).all<{ job_id: string }>()).results ?? [];
  for (const row of due) {
    try {
      await runJob(env, row.job_id, deps);
    } catch (error) {
      reportCloudFailure("cloud.job_run_failed", { jobId: row.job_id, message: errorText(error) });
    }
  }
  await env.DB.prepare(`
    delete from cloud_jobs where job_id in (
      select job_id from cloud_jobs where expires_at < ? and state in ('done', 'failed', 'cancelled') and step = ? limit ?
    )
  `).bind(now, END_STEP, EXPIRE_PER_TICK).run();
  return due.length;
}

/**
 * The computers a live job works on (its source and its new computer): the
 * minute cron's no-check-in sleep and 0-hours stop leave them alone, since a
 * move pauses its source's ADE (no check-ins) while it copies.
 */
export async function computersInJobs(env: CloudEnv): Promise<Set<string>> {
  const rows = (await env.DB.prepare(`
    select source_instance_id as a, target_instance_id as b from cloud_jobs where state not in ('done', 'failed', 'cancelled')
  `).all<{ a: string | null; b: string | null }>()).results ?? [];
  const out = new Set<string>();
  for (const row of rows) {
    if (row.a) out.add(row.a);
    if (row.b) out.add(row.b);
  }
  return out;
}

/**
 * A read of a job by a caller that watches it (`GET /cloud/moves/:id`,
 * `GET /cloud/frees/:id`) runs its due step after the answer, so a watched
 * job goes on in seconds, not at the next minute's cron. Nothing when no step
 * is due or another runner holds it (the lease decides).
 */
export function nudgeJob(env: CloudEnv, job: JobRow, deps: CloudJobDeps, waitUntil: ((promise: Promise<unknown>) => void) | undefined, now: number): void {
  if (!waitUntil || !deps.provider || !jobIsDue(job) || job.next_at > now) return;
  if (job.lease_until != null && job.lease_until > now) return;
  waitUntil(runJob(env, job.job_id, deps, { fromRequest: true }).catch(() => undefined));
}

/** Asks a live job to stop at its next step boundary (`runJob` does the cancel). */
export async function requestJobCancel(env: CloudEnv, jobId: string, now: number): Promise<void> {
  await env.DB.prepare("update cloud_jobs set cancel_requested_at = ?, next_at = min(next_at, ?) where job_id = ? and state not in ('done', 'failed', 'cancelled')")
    .bind(now, now, jobId).run();
}
