import {
  CLOUD_GIT_MAX_CHANGED,
  CLOUD_GIT_SUMMARY_MAX_BYTES,
  CLOUD_PATHS,
  type CloudGitChangedFile,
  type CloudGitSummary,
  type CloudGitSummaryCounts,
  type CloudGitSummaryInput,
} from "./contract";
import { ROW_ID, UNREADABLE_REQUEST_MESSAGE, fail, json } from "./http";
import { openJson, sealJson, userKeys, type UserKeys } from "./seal";
import { callingComputer, readCappedJson, segmentsAfter } from "./sessionCopies";
import { logCloud, type CloudEnv } from "./store";

/**
 * Git summaries saved at rest (README, "ADE without a computer"). A cloud
 * computer saves each lane's branch, ahead/behind and changed files at its
 * idle step and before a delete, so the Git panel reads while it sleeps or
 * after it is gone. One summary per (machine, lane); an older read never
 * replaces a newer one. File paths are the person's: the whole summary is
 * sealed, only the changed-file count is plain.
 */

const BODY_OVERHEAD_BYTES = 8 * 1024;
const MAX_LIST = 200;

const notFound = () => fail("not_found", "ADE Cloud has no Git summary for that lane.", 404);
const unavailable = () => fail("unavailable", "Saved Git summaries aren't available right now. Try again soon.", 503);
const unreadable = () => fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);

type GitRow = {
  user_id: string;
  machine_key: string;
  lane_id: string;
  instance_id: string | null;
  project_key: string | null;
  sealed: string;
  changed_count: number;
  checked_at: number;
  updated_at: number;
};

const summaryAad = (userId: string, machineKey: string, laneId: string): string => `ade.cloud.git.summary.v1\0${userId}\0${machineKey}\0${laneId}`;

const count = (value: unknown, max = 1_000_000_000): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : null;
const text = (value: unknown, max: number): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

function readSummaryInput(value: unknown): CloudGitSummaryInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const ahead = count(record.ahead);
  const behind = count(record.behind);
  const checkedAt = count(record.checkedAt, Number.MAX_SAFE_INTEGER);
  if (ahead == null || behind == null || checkedAt == null || !Array.isArray(record.changed)) return null;
  const changed: CloudGitChangedFile[] = [];
  for (const entry of record.changed.slice(0, CLOUD_GIT_MAX_CHANGED)) {
    const file = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    const path = text(file?.path, 1_000);
    if (!path) return null;
    changed.push({ path, status: text(file?.status, 20) ?? "M", added: count(file?.added) ?? 0, removed: count(file?.removed) ?? 0 });
  }
  return {
    branch: text(record.branch, 250),
    upstream: text(record.upstream, 300),
    ahead,
    behind,
    headSha: typeof record.headSha === "string" && /^[0-9a-f]{7,64}$/i.test(record.headSha) ? record.headSha : null,
    dirty: record.dirty === true || changed.length > 0,
    changed,
    truncated: record.truncated === true || record.changed.length > CLOUD_GIT_MAX_CHANGED,
    checkedAt,
  };
}

async function summaryOf(keys: UserKeys, row: GitRow): Promise<CloudGitSummary | null> {
  const opened = await openJson(keys, summaryAad(row.user_id, row.machine_key, row.lane_id), row.sealed);
  const input = readSummaryInput(opened);
  if (!input) {
    logCloud("cloud.git_summary_unreadable", { userId: row.user_id, machineKey: row.machine_key });
    return null;
  }
  return { ...input, machineKey: row.machine_key, laneId: row.lane_id, instanceId: row.instance_id, projectKey: row.project_key, updatedAt: row.updated_at };
}

/** The overview's form: counts only, no file list. */
export function countsOf(summary: CloudGitSummary): CloudGitSummaryCounts {
  const { changed, ...rest } = summary;
  return {
    ...rest,
    changedCount: changed.length,
    added: changed.reduce((sum, file) => sum + file.added, 0),
    removed: changed.reduce((sum, file) => sum + file.removed, 0),
  };
}

/** One project's summaries (indexed by `cloud_git_summaries_project`), newest first. */
export async function listGitSummaries(env: CloudEnv, keys: UserKeys, userId: string, projectKey: string | null): Promise<CloudGitSummary[]> {
  const rows = (projectKey
    ? await env.DB.prepare("select * from cloud_git_summaries where user_id = ? and project_key = ? order by updated_at desc limit ?").bind(userId, projectKey, MAX_LIST).all<GitRow>()
    : await env.DB.prepare("select * from cloud_git_summaries where user_id = ? order by updated_at desc limit ?").bind(userId, MAX_LIST).all<GitRow>()).results ?? [];
  const opened = await Promise.all(rows.map((row) => summaryOf(keys, row)));
  return opened.filter((summary): summary is CloudGitSummary => summary != null);
}

async function handlePut(request: Request, env: CloudEnv, userId: string, machineKey: string, laneId: string, now: number): Promise<Response> {
  const body = await readCappedJson(request, CLOUD_GIT_SUMMARY_MAX_BYTES + BODY_OVERHEAD_BYTES);
  if (!body.ok) return body.tooLarge ? fail("summary_too_large", "That Git summary is too large to save.", 413) : unreadable();
  const computer = await callingComputer(env, request, userId, body.value.instanceId);
  if (!computer) return fail("not_found", "ADE Cloud has no such computer.", 404);
  const summary = readSummaryInput(body.value.summary);
  if (!summary) return unreadable();
  const projectKey = text(body.value.projectKey, 300);
  const keys = await userKeys(env, userId, now);
  if (!keys) return unavailable();
  const sealed = await sealJson(keys, summaryAad(userId, machineKey, laneId), summary);
  // An older read never replaces a newer one.
  const written = await env.DB.prepare(`
    insert into cloud_git_summaries (user_id, machine_key, lane_id, instance_id, project_key, sealed, changed_count, checked_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict (user_id, machine_key, lane_id) do update set
      instance_id = excluded.instance_id, project_key = coalesce(excluded.project_key, project_key), sealed = excluded.sealed,
      changed_count = excluded.changed_count, checked_at = excluded.checked_at, updated_at = excluded.updated_at
    where excluded.checked_at >= cloud_git_summaries.checked_at
  `).bind(userId, machineKey, laneId, computer.instance_id, projectKey, sealed, summary.changed.length, summary.checkedAt, now).run();
  return json({ ok: true, kept: (written.meta?.changes ?? 0) > 0 });
}

/** A lane's summary on one machine goes with the lane. */
export function deleteGitSummaryForLaneStatement(env: Pick<CloudEnv, "DB">, userId: string, machineKey: string, laneId: string): D1PreparedStatement {
  return env.DB.prepare("delete from cloud_git_summaries where user_id = ? and machine_key = ? and lane_id = ?").bind(userId, machineKey, laneId);
}

export function deleteAccountGitSummariesStatement(env: Pick<CloudEnv, "DB">, userId: string): D1PreparedStatement {
  return env.DB.prepare("delete from cloud_git_summaries where user_id = ?").bind(userId);
}

/** `/cloud/git[/:machine/:lane]`. The caller passed the access gate. */
export async function routeGitSummaries(request: Request, url: URL, path: string, env: CloudEnv, userId: string, now: number): Promise<Response> {
  const segments = segmentsAfter(path, CLOUD_PATHS.git);
  if (segments.length === 0) {
    if (request.method !== "GET") return notFound();
    const keys = await userKeys(env, userId, now);
    if (!keys) return unavailable();
    return json({ summaries: await listGitSummaries(env, keys, userId, url.searchParams.get("project")?.trim() || null) });
  }
  const [machineKey, laneId] = segments;
  if (segments.length !== 2 || !machineKey || !laneId || !ROW_ID.test(machineKey) || !ROW_ID.test(laneId)) return notFound();
  if (request.method === "PUT") return handlePut(request, env, userId, machineKey, laneId, now);
  if (request.method !== "GET") return notFound();
  const row = await env.DB.prepare("select * from cloud_git_summaries where user_id = ? and machine_key = ? and lane_id = ?")
    .bind(userId, machineKey, laneId).first<GitRow>();
  if (!row) return notFound();
  const keys = await userKeys(env, userId, now);
  if (!keys) return unavailable();
  const summary = await summaryOf(keys, row);
  return summary ? json(summary) : fail("summary_unreadable", "This Git summary can't be read right now.", 503);
}
