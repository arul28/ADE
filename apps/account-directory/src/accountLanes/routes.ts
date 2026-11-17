import { authenticate, type CallerTokenEnv } from "../callerToken";
import {
  ACCOUNT_LANE_INDEX_MAX_PER_ACCOUNT,
  ACCOUNT_LANE_INDEX_MAX_PER_MACHINE,
  CLOUD_PATHS,
  type AccountLaneIndexEntry,
  type AccountLaneIndexPutResult,
  type AccountLaneIndexRow,
} from "../cloud/contract";
import { UNREADABLE_REQUEST_MESSAGE, fail, json } from "../cloud/http";
import { logCloud } from "../cloud/store";
import { readBoundedBody } from "../sinkUtils";
import { trustedHttpsOrigin } from "../trustedOrigin";

/**
 * The account lane index (README, "ADE without a computer"): every machine's
 * lanes by name, branch and PR number, so a place that mentions a lane (a
 * PR, a Linear issue, a phone notification) can name it and its machine
 * with no machine awake. Only what a lane is called, never what is in it.
 *
 * Each brain publishes its whole set when it changes (`PUT /account/lanes`);
 * the same hash again writes nothing, so a steady machine costs one read.
 * A machine's rows go when the machine leaves the account (`directory.ts`).
 *
 * Every route takes the account bearer and reads only the caller's rows.
 * CORS is the directory's rule: the web client's exact origin for the read,
 * and no browser origin for the publish (brains only).
 */

export type AccountLaneEnv = CallerTokenEnv & {
  DB: D1Database;
  WEB_CLIENT_ORIGIN?: string;
  ONLINE_WINDOW_MS?: string;
};

const PATH = CLOUD_PATHS.accountLanes;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_LIST = 500;
/** `directory.ts` DEFAULT_ONLINE_WINDOW_MS: a machine seen this recently is online. */
const DEFAULT_ONLINE_WINDOW_MS = 150_000;
/** Rows per insert: 10 columns each stays under D1's 100 bound values. */
const INSERT_CHUNK = 9;

const MACHINE_KEY = /^[\x21-\x7e]{1,128}$/;
const LANE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const HASH = /^[A-Za-z0-9+/=_:.-]{8,128}$/;
const ALLOWED_REQUEST_HEADERS = new Set(["authorization", "content-type", "x-ade-correlation-id"]);

export function isAccountLanesRequest(url: URL): boolean {
  const path = url.pathname.replace(/\/+$/, "");
  return path === PATH;
}

const notFound = () => fail("not_found", "That lane list was not found on your ADE account.", 404);

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || /[\p{Cc}\p{Cf}]/u.test(trimmed)) return null;
  return trimmed.slice(0, max);
}

function readEntry(value: unknown): AccountLaneIndexEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const laneId = typeof record.laneId === "string" && LANE_ID.test(record.laneId) ? record.laneId : null;
  const name = text(record.name, 200);
  if (!laneId || !name) return null;
  const projectId = typeof record.projectId === "string" && PROJECT_ID.test(record.projectId) ? record.projectId : null;
  const prNumber = typeof record.prNumber === "number" && Number.isInteger(record.prNumber) && record.prNumber > 0 && record.prNumber < 1e9 ? record.prNumber : null;
  return {
    laneId,
    projectId,
    projectKey: text(record.projectKey, 300)?.toLowerCase() ?? null,
    name,
    branch: text(record.branch, 250),
    prNumber,
    isPrimary: record.isPrimary === true,
  };
}

export async function handleAccountLanesRequest(request: Request, env: AccountLaneEnv): Promise<Response> {
  const url = new URL(request.url);
  const requestOrigin = request.headers.get("origin");
  const allowedOrigin = trustedHttpsOrigin(env.WEB_CLIENT_ORIGIN, { requireExactOrigin: true });
  // The read only: a browser never publishes a machine's lanes.
  const corsOrigin = requestOrigin && allowedOrigin && requestOrigin === allowedOrigin ? allowedOrigin : null;
  if (request.method === "OPTIONS") {
    if (!corsOrigin) return fail("origin_not_allowed", "This origin can't call the ADE lane list.", 403);
    if ((request.headers.get("access-control-request-method") ?? "").toUpperCase() !== "GET") return fail("bad_request", "That method isn't allowed here.", 405);
    const requested = (request.headers.get("access-control-request-headers") ?? "").split(",").map((header) => header.trim().toLowerCase()).filter(Boolean);
    if (requested.some((header) => !ALLOWED_REQUEST_HEADERS.has(header))) return fail("origin_not_allowed", "Those headers aren't allowed.", 403);
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": corsOrigin,
        "access-control-allow-headers": "authorization, content-type, x-ade-correlation-id",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-max-age": "600",
        vary: "Origin",
      },
    });
  }
  if (requestOrigin && (!corsOrigin || request.method !== "GET")) return fail("origin_not_allowed", "This origin can't call the ADE lane list.", 403);
  if (request.method !== "GET" && request.method !== "PUT") return notFound();
  const caller = await authenticate(request, env);
  if (!caller.ok) {
    return caller.reason === "authentication unavailable"
      ? fail("unavailable", "ADE can't check your sign-in right now. Try again soon.", 503)
      : fail("unauthorized", "Sign in to ADE to see your lanes.", 401);
  }
  const response = request.method === "GET"
    ? await handleList(url, env, caller.userId, Date.now())
    : await handlePut(request, env, caller.userId, Date.now());
  if (!corsOrigin) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", corsOrigin);
  headers.set("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handlePut(request: Request, env: AccountLaneEnv, userId: string, now: number): Promise<Response> {
  let read: Awaited<ReturnType<typeof readBoundedBody>>;
  try {
    read = await readBoundedBody(request, MAX_BODY_BYTES);
  } catch {
    return fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);
  }
  if (!read.ok) return fail("too_large", "That lane list is too large.", 413);
  let body: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(read.text) as unknown;
    body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    body = null;
  }
  const machineKey = typeof body?.machineKey === "string" && MACHINE_KEY.test(body.machineKey) ? body.machineKey : null;
  const hash = typeof body?.hash === "string" && HASH.test(body.hash) ? body.hash : null;
  if (!body || !machineKey || !hash || !Array.isArray(body.lanes)) return fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);
  if (body.lanes.length > ACCOUNT_LANE_INDEX_MAX_PER_MACHINE) {
    return fail("too_many_lanes", `A machine publishes at most ${ACCOUNT_LANE_INDEX_MAX_PER_MACHINE} lanes.`, 413);
  }
  const lanes: AccountLaneIndexEntry[] = [];
  const seen = new Set<string>();
  for (const raw of body.lanes) {
    const entry = readEntry(raw);
    if (!entry) return fail("bad_request", "A lane in that list can't be read.", 400);
    if (seen.has(entry.laneId)) continue;
    seen.add(entry.laneId);
    lanes.push(entry);
  }
  // Only a machine on the caller's own roster publishes.
  const [machine, state, others] = await Promise.all([
    env.DB.prepare("select 1 as present from machines where user_id = ? and machine_key = ?").bind(userId, machineKey).first<{ present: number }>(),
    env.DB.prepare("select hash, lane_count from account_lane_index_state where user_id = ? and machine_key = ?").bind(userId, machineKey).first<{ hash: string; lane_count: number }>(),
    env.DB.prepare("select coalesce(sum(lane_count), 0) as total from account_lane_index_state where user_id = ? and machine_key != ?").bind(userId, machineKey).first<{ total: number }>(),
  ]);
  if (!machine) return fail("not_found", "That machine isn't on your ADE account.", 404);
  if (state?.hash === hash) return json({ changed: false, count: state.lane_count } satisfies AccountLaneIndexPutResult);
  if ((others?.total ?? 0) + lanes.length > ACCOUNT_LANE_INDEX_MAX_PER_ACCOUNT) {
    logCloud("account_lanes.refused", { userId, code: "account_full" });
    return fail("too_many_lanes", `Your ADE account lists at most ${ACCOUNT_LANE_INDEX_MAX_PER_ACCOUNT} lanes.`, 409);
  }
  // One batch: the old set goes and the new set comes in the same transaction.
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("delete from account_lane_index where user_id = ? and machine_key = ?").bind(userId, machineKey),
  ];
  for (let start = 0; start < lanes.length; start += INSERT_CHUNK) {
    const chunk = lanes.slice(start, start + INSERT_CHUNK);
    statements.push(env.DB.prepare(`
      insert into account_lane_index (user_id, machine_key, lane_id, project_id, project_key, name, branch, pr_number, is_primary, updated_at)
      values ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}
    `).bind(...chunk.flatMap((lane) => [
      userId, machineKey, lane.laneId, lane.projectId, lane.projectKey, lane.name, lane.branch, lane.prNumber, lane.isPrimary ? 1 : 0, now,
    ])));
  }
  statements.push(env.DB.prepare(`
    insert into account_lane_index_state (user_id, machine_key, hash, lane_count, updated_at) values (?, ?, ?, ?, ?)
    on conflict (user_id, machine_key) do update set hash = excluded.hash, lane_count = excluded.lane_count, updated_at = excluded.updated_at
  `).bind(userId, machineKey, hash, lanes.length, now));
  await env.DB.batch(statements);
  return json({ changed: true, count: lanes.length } satisfies AccountLaneIndexPutResult);
}

type IndexRow = {
  machine_key: string;
  lane_id: string;
  project_id: string | null;
  project_key: string | null;
  name: string;
  branch: string | null;
  pr_number: number | null;
  is_primary: number;
  updated_at: number;
  machine_name: string | null;
  last_seen_at: number | null;
  cloud_status: string | null;
};

async function handleList(url: URL, env: AccountLaneEnv, userId: string, now: number): Promise<Response> {
  const project = url.searchParams.get("project")?.trim() || null;
  const prText = url.searchParams.get("pr")?.trim() || null;
  const pr = prText && /^[1-9][0-9]{0,8}$/.test(prText) ? Number(prText) : null;
  if (prText && pr == null) return json({ lanes: [] });
  const where = ["l.user_id = ?"];
  const binds: Array<string | number> = [userId];
  if (project) {
    where.push("(l.project_id = ? or l.project_key = ?)");
    binds.push(project, project.toLowerCase());
  }
  if (pr != null) {
    where.push("l.pr_number = ?");
    binds.push(pr);
  }
  // The machine's name and when it was last seen from the roster; a resting cloud computer is offline.
  const rows = (await env.DB.prepare(`
    select l.machine_key, l.lane_id, l.project_id, l.project_key, l.name, l.branch, l.pr_number, l.is_primary, l.updated_at,
      m.name as machine_name, m.last_seen_at,
      (select c.status from cloud_computers c where c.user_id = l.user_id and lower(c.machine_key) = lower(l.machine_key) and c.deleted_at is null
        order by c.created_at desc limit 1) as cloud_status
    from account_lane_index l left join machines m on m.user_id = l.user_id and m.machine_key = l.machine_key
    where ${where.join(" and ")} order by l.updated_at desc limit ?
  `).bind(...binds, MAX_LIST).all<IndexRow>()).results ?? [];
  const configured = Number(env.ONLINE_WINDOW_MS);
  const windowMs = Number.isFinite(configured) && configured >= 0 ? Math.trunc(configured) : DEFAULT_ONLINE_WINDOW_MS;
  return json({
    lanes: rows.map((row): AccountLaneIndexRow => ({
      laneId: row.lane_id,
      projectId: row.project_id,
      projectKey: row.project_key,
      name: row.name,
      branch: row.branch,
      prNumber: row.pr_number,
      isPrimary: row.is_primary === 1,
      machineKey: row.machine_key,
      machineName: row.machine_name,
      online: typeof row.last_seen_at === "number" && now - row.last_seen_at <= windowMs
        && (row.cloud_status == null || row.cloud_status === "running" || row.cloud_status === "restarting" || row.cloud_status === "updating"),
      updatedAt: row.updated_at,
    })),
  });
}

/** A machine's lanes leave the index when the machine leaves the account. Two indexed deletes, any number of machines. */
export async function dropAccountLanes(db: D1Database, userId: string, machineKeys: readonly string[]): Promise<void> {
  if (!machineKeys.length) return;
  const keys = JSON.stringify(machineKeys);
  await db.prepare("delete from account_lane_index where user_id = ? and machine_key in (select value from json_each(?))").bind(userId, keys).run();
  await db.prepare("delete from account_lane_index_state where user_id = ? and machine_key in (select value from json_each(?))").bind(userId, keys).run();
}
