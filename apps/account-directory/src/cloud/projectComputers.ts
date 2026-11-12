import {
  CLOUD_PATHS,
  type CloudProjectComputer,
  type CloudProjectComputerDeleteState,
  type CloudProjectComputersDeleteStarted,
  type CloudProjectComputersJob,
  type CloudProjectComputersPreview,
} from "./contract";
import { UNREADABLE_REQUEST_MESSAGE, UUID_PATTERN, fail, json, readJson } from "./http";
import { githubOriginOf } from "./launches";
import { laneWorkOfRow } from "./diskUsage";
import { laneFactsOfRow } from "./lanesWithoutComputer";
import { pushAllWork, putBackToRest, type WakeRecord } from "./planCleanup";
import { cloudSizeFor, isMeteredStatus, tierOf } from "./plans";
import { CloudProviderError, type CloudProvider } from "./provider";
import { deleteComputer, listComputers, logCloud, ownedComputer, reportCloudFailure, type CloudEnv, type ComputerRow } from "./store";

/**
 * Delete the cloud computers of one project (C10, plan-final decision 5):
 * Lane L's Delete project window calls it. Every computer of this account
 * whose lane facts name the origin. Each is woken for free when asleep (the
 * push-work wake), its own ADE stops its agents, saves its chats and pushes
 * every lane's work (the same commands the plan cleanup runs), and it is
 * deleted only when nothing is left: a computer whose push failed stays, with
 * why, and the caller offers "Delete anyway".
 *
 * The preview (`dryRun`) lists them; the delete names the ones it saw
 * (`instanceIds`) and acts only on those that still belong to the origin, so
 * a computer made after the preview (a server launch still joining) is left
 * alone. A computer already in another job's `pending` or `working` row is
 * skipped, so two jobs never push one computer at once. At most 50 a job;
 * `truncated` says when there were more.
 *
 * Bounded: the route only writes the job's rows and answers `{ jobId }`; the
 * minute cron moves each row on, a few computers a tick, so no request waits
 * on a push and a closed window doesn't stop the job.
 */

const JOB_ID = UUID_PATTERN;
/** Computers one tick works on, across accounts; they run in parallel. */
const DELETES_PER_TICK = 4;
/** A claim older than this was lost mid-run (the Worker died): the next tick takes the computer again. */
const CLAIM_STALE_MS = 20 * 60_000;
/** Job rows are dropped this long after the job started. */
const JOB_KEPT_MS = 7 * 24 * 60 * 60_000;
const MAX_COMPUTERS_PER_JOB = 50;

type JobRow = {
  job_id: string;
  instance_id: string;
  user_id: string;
  project_origin: string;
  name: string | null;
  state: CloudProjectComputerDeleteState;
  reason: string | null;
  claimed_at: number | null;
  created_at: number;
};

const notFound = () => fail("not_found", "ADE Cloud has no such job.", 404);

/** The computers of `origin` on this account, oldest first. */
async function computersOf(env: CloudEnv, userId: string, origin: string): Promise<ComputerRow[]> {
  return (await listComputers(env, userId)).filter((computer) => githubOriginOf(laneFactsOfRow(computer).projectOrigin) === origin);
}

export async function routeProjectComputersDelete(request: Request, path: string, env: CloudEnv, userId: string, now: number): Promise<Response> {
  if (path === CLOUD_PATHS.projectComputersDelete) {
    if (request.method !== "POST") return notFound();
    const body = await readJson(request);
    if (!body) return fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);
    const origin = githubOriginOf(body.origin);
    if (!origin) return fail("bad_request", "Name the project by its GitHub origin.", 400);
    const all = await computersOf(env, userId, origin);
    if (body.dryRun === true) {
      const list: CloudProjectComputer[] = all.slice(0, MAX_COMPUTERS_PER_JOB).map((computer) => ({
        instanceId: computer.instance_id,
        name: computer.name,
        laneName: computer.lane_name ?? null,
        sizeId: tierOf(cloudSizeFor(computer.type, computer.cpu, computer.memory_gb)),
        awake: isMeteredStatus(computer.status),
        unpushed: laneWorkOfRow(computer)?.unpushed ?? null,
      }));
      const preview: CloudProjectComputersPreview = { computers: list, truncated: all.length > MAX_COMPUTERS_PER_JOB };
      return json(preview);
    }
    const named = Array.isArray(body.instanceIds) ? body.instanceIds.filter((id): id is string => typeof id === "string") : null;
    if (!named) return fail("bad_request", "Name the computers from the preview to delete.", 400);
    const wanted = new Set(named.slice(0, MAX_COMPUTERS_PER_JOB));
    // Already in another job's hands: that job pushes and deletes it.
    const busy = new Set(((await env.DB.prepare("select instance_id from cloud_project_deletes where user_id = ? and state in ('pending', 'working')")
      .bind(userId).all<{ instance_id: string }>()).results ?? []).map((row) => row.instance_id));
    const stillMatching = all.filter((computer) => wanted.has(computer.instance_id));
    const computers = stillMatching.filter((computer) => !busy.has(computer.instance_id));
    const jobId = crypto.randomUUID();
    if (computers.length) {
      await env.DB.batch(computers.map((computer) => env.DB.prepare(`
        insert into cloud_project_deletes (job_id, instance_id, user_id, project_origin, name, state, created_at, updated_at)
        values (?, ?, ?, ?, ?, 'pending', ?, ?)
      `).bind(jobId, computer.instance_id, userId, origin, computer.lane_name ?? computer.name, now, now)));
    }
    logCloud("cloud.project_delete_started", { userId, computers: computers.length, named: named.length, skippedBusy: stillMatching.length - computers.length });
    const started: CloudProjectComputersDeleteStarted = { jobId, truncated: named.length > MAX_COMPUTERS_PER_JOB };
    return json(started, 201);
  }
  const jobId = path.slice(CLOUD_PATHS.projectComputersDelete.length + 1);
  if (request.method !== "GET" || !JOB_ID.test(jobId)) return notFound();
  const rows = (await env.DB.prepare("select * from cloud_project_deletes where job_id = ? and user_id = ? order by created_at, instance_id")
    .bind(jobId, userId).all<JobRow>()).results ?? [];
  // A job that named no computer has no rows: it is done, and so is one this account never started.
  const job: CloudProjectComputersJob = {
    jobId,
    origin: rows[0]?.project_origin ?? "",
    computers: rows.map((row) => ({ instanceId: row.instance_id, name: row.name, state: row.state, reason: row.reason })),
    done: rows.every((row) => row.state !== "pending" && row.state !== "working"),
  };
  return json(job);
}

async function settle(env: CloudEnv, row: JobRow, state: CloudProjectComputerDeleteState, reason: string | null): Promise<void> {
  await env.DB.prepare("update cloud_project_deletes set state = ?, reason = ?, claimed_at = null, updated_at = ? where job_id = ? and instance_id = ?")
    .bind(state, reason, Date.now(), row.job_id, row.instance_id).run();
}

/** One computer: wake, push, check, delete. Anything short of "everything is on GitHub" keeps it. */
async function runOne(env: CloudEnv, provider: CloudProvider, row: JobRow, now: number): Promise<void> {
  const computer = await ownedComputer(env, row.user_id, row.instance_id);
  if (!computer) return settle(env, row, "gone", null);
  const wake: WakeRecord = { woke: false, from: computer.status };
  const keep = async (reason: string): Promise<void> => {
    if (wake.woke) await putBackToRest(env, provider, computer.instance_id, wake.from);
    await settle(env, row, "kept", reason);
  };
  try {
    const work = await pushAllWork(env, provider, computer, now, wake, "project_delete");
    if (!work.ok) {
      logCloud("cloud.project_delete_computer_kept", { instanceId: computer.instance_id, code: work.code });
      return keep(work.reason);
    }
    await deleteComputer(env, provider, computer, { who: "project_delete", reason: "project_delete" }, Date.now());
    logCloud("cloud.project_delete_computer_deleted", { instanceId: computer.instance_id });
    return settle(env, row, "deleted", null);
  } catch (error) {
    reportCloudFailure("cloud.project_delete_computer_failed", { instanceId: computer.instance_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
    return keep("ADE Cloud couldn't reach the computer to push its work.");
  }
}

/**
 * From the minute cron: takes up to `DELETES_PER_TICK` pending rows (or rows
 * a lost run left claimed), each claimed in one write so overlapping ticks
 * work on a computer once, and drops rows of old jobs. With no job, one
 * indexed read.
 */
export async function runProjectComputerDeletes(env: CloudEnv, provider: CloudProvider, now = Date.now()): Promise<void> {
  const rows = (await env.DB.prepare(`
    select * from cloud_project_deletes
    where state = 'pending' or (state = 'working' and claimed_at < ?)
    order by created_at limit ?
  `).bind(now - CLAIM_STALE_MS, DELETES_PER_TICK).all<JobRow>()).results ?? [];
  const runs: Promise<void>[] = [];
  for (const row of rows) {
    const claimed = await env.DB.prepare(`
      update cloud_project_deletes set state = 'working', claimed_at = ?, updated_at = ?
      where job_id = ? and instance_id = ? and (state = 'pending' or (state = 'working' and claimed_at < ?))
    `).bind(now, now, row.job_id, row.instance_id, now - CLAIM_STALE_MS).run();
    if ((claimed.meta?.changes ?? 0) === 1) runs.push(runOne(env, provider, row, now));
  }
  await Promise.all(runs);
  await env.DB.prepare("delete from cloud_project_deletes where created_at < ?").bind(now - JOB_KEPT_MS).run();
}
