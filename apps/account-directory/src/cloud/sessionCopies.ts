import {
  CLOUD_INSTANCE_HEADER,
  CLOUD_PATHS,
  CLOUD_SESSION_MAX_ACCOUNT_BYTES,
  CLOUD_SESSION_MAX_BYTES,
  CLOUD_SESSION_MAX_LINES,
  CLOUD_SESSION_MAX_PER_COMPUTER,
  type CloudSessionCopy,
  type CloudSessionCopyFormat,
  type CloudSessionRow,
  type CloudSessionRowInput,
  type CloudSessionMoveResult,
} from "./contract";
import { ROW_ID, UNREADABLE_REQUEST_MESSAGE, fail, json } from "./http";
import { openBytes, openJson, sealBytes, sealJson, userKeys, type UserKeys } from "./seal";
import { logCloud, ownedComputer, type CloudEnv, type ComputerRow } from "./store";

/**
 * CLI-session and shell copies (README, "ADE without a computer"). A cloud
 * computer saves the last `CLOUD_SESSION_MAX_LINES` lines of each shell, and
 * the screen of each CLI, at session end, at its idle step and before a
 * delete, never per line of output. So the Work list shows them while the
 * computer sleeps or after it is gone. One copy per session, replaced on
 * each upload; a computer keeps its newest `CLOUD_SESSION_MAX_PER_COMPUTER`.
 *
 * The copy is one sealed R2 object; its row's words (title, lane name) are
 * sealed too. Another account's session answers 404 like a missing one.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** Room for the JSON around the text. */
const BODY_OVERHEAD_BYTES = 64 * 1024;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 200;

const notFound = () => fail("not_found", "ADE Cloud has no copy of that session.", 404);
const unavailable = () => fail("unavailable", "Saved sessions aren't available right now. Try again soon.", 503);
const unreadable = () => fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);

/** A JSON body of at most `maxBytes`. */
export async function readCappedJson(request: Request, maxBytes: number): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; tooLarge: boolean }> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, tooLarge: true };
  const raw = await request.arrayBuffer();
  if (raw.byteLength > maxBytes) return { ok: false, tooLarge: true };
  try {
    const value = JSON.parse(decoder.decode(raw)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? { ok: true, value: value as Record<string, unknown> } : { ok: false, tooLarge: false };
  } catch {
    return { ok: false, tooLarge: false };
  }
}

/** The computer that names itself in the body or the instance header, if it is the caller's own. */
export async function callingComputer(env: CloudEnv, request: Request, userId: string, bodyInstanceId: unknown): Promise<ComputerRow | null> {
  const named = typeof bodyInstanceId === "string" && bodyInstanceId.trim() ? bodyInstanceId.trim() : request.headers.get(CLOUD_INSTANCE_HEADER)?.trim() ?? "";
  if (!/^[a-z0-9]{4,40}$/.test(named)) return null;
  return await ownedComputer(env, userId, named);
}

/** Path segments after a prefix, decoded; an undecodable one is empty. */
export function segmentsAfter(path: string, prefix: string): string[] {
  return path.slice(prefix.length).split("/").filter(Boolean).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return "";
    }
  });
}

type SessionRow = {
  user_id: string;
  machine_key: string;
  session_id: string;
  instance_id: string | null;
  project_key: string | null;
  lane_id: string | null;
  kind: string;
  parent_chat_id: string | null;
  summary_sealed: string | null;
  r2_key: string;
  bytes: number;
  line_count: number;
  last_activity_at: number | null;
  updated_at: number;
};

const objectKey = (userId: string, machineKey: string, sessionId: string): string => `sessions/${userId}/${machineKey}/${sessionId}`;
const copyAad = (userId: string, machineKey: string, sessionId: string): string => `ade.cloud.session.copy.v1\0${userId}\0${machineKey}\0${sessionId}`;
const summaryAad = (userId: string, machineKey: string, sessionId: string): string => `ade.cloud.session.summary.v1\0${userId}\0${machineKey}\0${sessionId}`;

function pickText(record: Record<string, unknown>, key: string, max: number): string | null {
  const value = record[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function readSessionRowInput(value: unknown): CloudSessionRowInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind === "cli" || record.kind === "shell" ? record.kind : null;
  if (!kind) return null;
  const laneId = pickText(record, "laneId", 160);
  const parentChatId = pickText(record, "parentChatId", 160);
  const lastActivityAt = pickText(record, "lastActivityAt", 40);
  if ((laneId && !ROW_ID.test(laneId)) || (parentChatId && !ROW_ID.test(parentChatId))) return null;
  if (lastActivityAt && Number.isNaN(Date.parse(lastActivityAt))) return null;
  return {
    kind,
    title: pickText(record, "title", 300),
    laneId,
    laneName: pickText(record, "laneName", 200),
    toolType: pickText(record, "toolType", 60),
    projectKey: pickText(record, "projectKey", 300),
    projectId: pickText(record, "projectId", 160),
    parentChatId,
    status: pickText(record, "status", 40),
    lastActivityAt,
  };
}

/** One saved CLI session (never a shell) as the queue reads it: its row and its opened summary. */
export async function cliSessionCopy(env: CloudEnv, keys: UserKeys, userId: string, machineKey: string, sessionId: string): Promise<CloudSessionRow | null> {
  const row = await env.DB.prepare("select * from cloud_session_copies where user_id = ? and machine_key = ? and session_id = ? and kind = 'cli'")
    .bind(userId, machineKey, sessionId).first<SessionRow>();
  return row ? await rowOf(keys, row) : null;
}

async function rowOf(keys: UserKeys, row: SessionRow): Promise<CloudSessionRow> {
  const summary = await openJson(keys, summaryAad(row.user_id, row.machine_key, row.session_id), row.summary_sealed);
  const record = summary && typeof summary === "object" && !Array.isArray(summary) ? summary as Record<string, unknown> : {};
  const text = (key: string): string | null => (typeof record[key] === "string" && record[key] ? record[key] as string : null);
  return {
    machineKey: row.machine_key,
    sessionId: row.session_id,
    instanceId: row.instance_id,
    kind: row.kind === "cli" ? "cli" : "shell",
    title: text("title"),
    laneId: row.lane_id,
    laneName: text("laneName"),
    toolType: text("toolType"),
    projectKey: row.project_key,
    projectId: text("projectId"),
    parentChatId: row.parent_chat_id,
    status: text("status"),
    lastActivityAt: row.last_activity_at != null ? new Date(row.last_activity_at).toISOString() : null,
    lineCount: row.line_count,
    bytes: row.bytes,
    updatedAt: row.updated_at,
  };
}

/** The last `CLOUD_SESSION_MAX_LINES` lines of a text copy (an xterm screen is kept as sent). */
function lastLines(text: string): { text: string; lines: number } {
  const lines = text.split("\n");
  if (lines.length <= CLOUD_SESSION_MAX_LINES) return { text, lines: lines.length };
  return { text: lines.slice(-CLOUD_SESSION_MAX_LINES).join("\n"), lines: CLOUD_SESSION_MAX_LINES };
}

async function handlePut(request: Request, env: CloudEnv, bucket: R2Bucket, userId: string, machineKey: string, sessionId: string, now: number): Promise<Response> {
  const body = await readCappedJson(request, CLOUD_SESSION_MAX_BYTES + BODY_OVERHEAD_BYTES);
  if (!body.ok) return body.tooLarge ? fail("copy_too_large", "That session copy is too large to save.", 413) : unreadable();
  const computer = await callingComputer(env, request, userId, body.value.instanceId);
  // Only the owner's own computers save copies.
  if (!computer) return fail("not_found", "ADE Cloud has no such computer.", 404);
  const input = readSessionRowInput(body.value.row);
  const format: CloudSessionCopyFormat | null = body.value.format === "text" || body.value.format === "xterm" ? body.value.format : null;
  if (!input || !format || typeof body.value.text !== "string") return unreadable();
  const copy = format === "text" ? lastLines(body.value.text) : { text: body.value.text, lines: Math.min(CLOUD_SESSION_MAX_LINES, Number(body.value.lineCount) || 0) };
  const plain = encoder.encode(copy.text);
  if (plain.byteLength > CLOUD_SESSION_MAX_BYTES) return fail("copy_too_large", "That session copy is too large to save.", 413);
  const keys = await userKeys(env, userId, now);
  if (!keys) return unavailable();
  const sealed = await sealBytes(keys.aes, copyAad(userId, machineKey, sessionId), encoder.encode(JSON.stringify({ format, text: copy.text })));
  const existing = await env.DB.prepare("select bytes from cloud_session_copies where user_id = ? and machine_key = ? and session_id = ?")
    .bind(userId, machineKey, sessionId).first<{ bytes: number }>();
  const total = await env.DB.prepare("select coalesce(sum(bytes), 0) as total from cloud_session_copies where user_id = ?").bind(userId).first<{ total: number }>();
  if ((total?.total ?? 0) - (existing?.bytes ?? 0) + sealed.byteLength > CLOUD_SESSION_MAX_ACCOUNT_BYTES) {
    logCloud("cloud.session_account_full", { userId, limitBytes: CLOUD_SESSION_MAX_ACCOUNT_BYTES });
    return fail("account_full", "This account's saved sessions are full. Delete some to save new ones.", 413);
  }
  const key = objectKey(userId, machineKey, sessionId);
  await bucket.put(key, sealed);
  const summary = await sealJson(keys, summaryAad(userId, machineKey, sessionId), {
    title: input.title,
    laneName: input.laneName,
    toolType: input.toolType,
    projectId: input.projectId,
    status: input.status,
    format,
  });
  const lastActivity = input.lastActivityAt ? Date.parse(input.lastActivityAt) : null;
  await env.DB.prepare(`
    insert into cloud_session_copies (user_id, machine_key, session_id, instance_id, project_key, lane_id, kind, parent_chat_id, summary_sealed, r2_key, bytes, line_count, last_activity_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict (user_id, machine_key, session_id) do update set
      instance_id = excluded.instance_id, project_key = coalesce(excluded.project_key, project_key), lane_id = coalesce(excluded.lane_id, lane_id),
      kind = excluded.kind, parent_chat_id = coalesce(excluded.parent_chat_id, parent_chat_id), summary_sealed = excluded.summary_sealed,
      bytes = excluded.bytes, line_count = excluded.line_count, last_activity_at = coalesce(excluded.last_activity_at, last_activity_at), updated_at = excluded.updated_at
  `).bind(
    userId, machineKey, sessionId, computer.instance_id, input.projectKey, input.laneId, input.kind, input.parentChatId, summary, key,
    sealed.byteLength, copy.lines, lastActivity, now,
  ).run();
  await pruneComputer(env, bucket, userId, computer.instance_id);
  return json({ ok: true, updatedAt: now });
}

/** A computer keeps its newest copies only: the rest go, rows and objects. */
async function pruneComputer(env: CloudEnv, bucket: R2Bucket, userId: string, instanceId: string): Promise<void> {
  const old = (await env.DB.prepare(`
    select machine_key, session_id, r2_key from cloud_session_copies where instance_id = ? and user_id = ?
    order by updated_at desc limit 50 offset ?
  `).bind(instanceId, userId, CLOUD_SESSION_MAX_PER_COMPUTER).all<{ machine_key: string; session_id: string; r2_key: string }>()).results ?? [];
  if (!old.length) return;
  await bucket.delete(old.map((row) => row.r2_key));
  await env.DB.batch(old.map((row) => env.DB.prepare("delete from cloud_session_copies where user_id = ? and machine_key = ? and session_id = ?")
    .bind(userId, row.machine_key, row.session_id)));
}

function clampedInt(raw: string | null, fallback: number, max: number): number {
  const value = raw ? Number(raw) : Number.NaN;
  return Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

/** The copies of one project (or machine), newest first, paged by `updatedAt:sessionId`. */
export async function listSessionRows(env: CloudEnv, keys: UserKeys, userId: string, filter: { machine?: string | null; project?: string | null; cursor?: string | null; limit?: number }): Promise<{ sessions: CloudSessionRow[]; nextCursor: string | null }> {
  const where = ["user_id = ?"];
  const binds: Array<string | number> = [userId];
  if (filter.machine) {
    where.push("machine_key = ?");
    binds.push(filter.machine);
  }
  if (filter.project) {
    where.push("project_key = ?");
    binds.push(filter.project);
  }
  const cursor = filter.cursor?.match(/^(\d+):(.+)$/) ?? null;
  if (cursor) {
    where.push("(updated_at < ? or (updated_at = ? and session_id < ?))");
    binds.push(Number(cursor[1]), Number(cursor[1]), cursor[2]!);
  }
  const limit = filter.limit ?? DEFAULT_LIST_LIMIT;
  const rows = (await env.DB.prepare(`select * from cloud_session_copies where ${where.join(" and ")} order by updated_at desc, session_id desc limit ?`)
    .bind(...binds, limit + 1).all<SessionRow>()).results ?? [];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    sessions: await Promise.all(page.map((row) => rowOf(keys, row))),
    nextCursor: rows.length > limit && last ? `${last.updated_at}:${last.session_id}` : null,
  };
}

async function handleGet(env: CloudEnv, bucket: R2Bucket, userId: string, machineKey: string, sessionId: string, now: number): Promise<Response> {
  const row = await env.DB.prepare("select * from cloud_session_copies where user_id = ? and machine_key = ? and session_id = ?")
    .bind(userId, machineKey, sessionId).first<SessionRow>();
  if (!row) return notFound();
  const keys = await userKeys(env, userId, now);
  if (!keys) return unavailable();
  const object = await bucket.get(row.r2_key);
  const opened = object ? await openBytes(keys.aes, copyAad(userId, machineKey, sessionId), new Uint8Array(await object.arrayBuffer())) : null;
  if (!opened) {
    logCloud("cloud.session_copy_unreadable", { userId, machineKey, sessionId });
    return fail("copy_unreadable", "This session copy can't be read right now.", 503);
  }
  const value = JSON.parse(decoder.decode(opened)) as { format?: string; text?: string };
  return json({
    session: await rowOf(keys, row),
    format: value.format === "xterm" ? "xterm" : "text",
    text: typeof value.text === "string" ? value.text : "",
  } satisfies CloudSessionCopy);
}

export async function deleteSessionCopy(env: CloudEnv, userId: string, machineKey: string, sessionId: string): Promise<boolean> {
  const row = await env.DB.prepare("select r2_key from cloud_session_copies where user_id = ? and machine_key = ? and session_id = ?")
    .bind(userId, machineKey, sessionId).first<{ r2_key: string }>();
  if (!row) return false;
  await env.CLOUD_CHATS?.delete(row.r2_key);
  // Messages queued to a CLI go with its copy.
  await env.DB.batch([
    env.DB.prepare("delete from cloud_session_copies where user_id = ? and machine_key = ? and session_id = ?").bind(userId, machineKey, sessionId),
    env.DB.prepare("delete from cloud_chat_messages where user_id = ? and machine_key = ? and chat_id = ?").bind(userId, machineKey, sessionId),
  ]);
  return true;
}

/** A lane's copies on one machine go with the lane. */
export async function deleteSessionCopiesForLane(env: CloudEnv, userId: string, machineKey: string, laneId: string): Promise<number> {
  const rows = (await env.DB.prepare("select session_id, r2_key from cloud_session_copies where user_id = ? and machine_key = ? and lane_id = ?")
    .bind(userId, machineKey, laneId).all<{ session_id: string; r2_key: string }>()).results ?? [];
  if (!rows.length) return 0;
  if (env.CLOUD_CHATS) await env.CLOUD_CHATS.delete(rows.map((row) => row.r2_key));
  // Messages queued to its CLIs go first: the copies name which ones.
  await env.DB.batch([
    env.DB.prepare(`
      delete from cloud_chat_messages where user_id = ? and machine_key = ?
        and chat_id in (select session_id from cloud_session_copies where user_id = ? and machine_key = ? and lane_id = ?)
    `).bind(userId, machineKey, userId, machineKey, laneId),
    env.DB.prepare("delete from cloud_session_copies where user_id = ? and machine_key = ? and lane_id = ?").bind(userId, machineKey, laneId),
  ]);
  return rows.length;
}

/** Rows of an account deletion; the objects go with the account's whole R2 prefix (`deleteAllAccountChats`). */
export function deleteAccountSessionCopiesStatement(env: Pick<CloudEnv, "DB">, userId: string): D1PreparedStatement {
  return env.DB.prepare("delete from cloud_session_copies where user_id = ?").bind(userId);
}

/** `/cloud/sessions[/:machine/:session]`. The caller passed the access gate. */
/**
 * `POST /cloud/sessions/:m/:s/move`, from the new computer that continued a
 * deleted computer's CLI: the copy goes to the new computer's machine key,
 * sealed again under it, and the CLI's queued messages follow it. Later sends
 * then reach the new computer, and a send to the old address finds it by its
 * session id (`resolveTarget`). The same move again answers `moved: false`.
 */
async function handleMove(request: Request, env: CloudEnv, bucket: R2Bucket, userId: string, machineKey: string, sessionId: string, now: number): Promise<Response> {
  const body = await readCappedJson(request, BODY_OVERHEAD_BYTES);
  if (!body.ok) return unreadable();
  const toMachineKey = typeof body.value.toMachineKey === "string" ? body.value.toMachineKey.trim() : "";
  const instanceId = typeof body.value.instanceId === "string" ? body.value.instanceId.trim() : "";
  if (!ROW_ID.test(toMachineKey) || !/^[a-z0-9]{4,40}$/.test(instanceId)) return unreadable();
  const computer = await ownedComputer(env, userId, instanceId);
  // Only the caller's own computer, and only to its own machine key.
  if (!computer || computer.deleted_at != null) return fail("not_found", "ADE Cloud has no such computer.", 404);
  if (computer.machine_key && computer.machine_key.toLowerCase() !== toMachineKey.toLowerCase()) {
    return fail("wrong_machine", "A session moves only to the machine key of the computer that asks.", 409);
  }
  const rowAt = (key: string) => env.DB.prepare("select * from cloud_session_copies where user_id = ? and machine_key = ? and session_id = ? and kind = 'cli'")
    .bind(userId, key, sessionId).first<SessionRow>();
  const moveMessages = env.DB.prepare(`
    update cloud_chat_messages set machine_key = ?, instance_id = case when via_launch = 0 and state = 'queued' then ? else instance_id end
    where user_id = ? and machine_key = ? and chat_id = ?
  `).bind(toMachineKey, computer.instance_id, userId, machineKey, sessionId);
  if (machineKey === toMachineKey) return json({ moved: false } satisfies CloudSessionMoveResult);
  const source = await rowAt(machineKey);
  const target = await rowAt(toMachineKey);
  if (!source) return target ? json({ moved: false } satisfies CloudSessionMoveResult) : notFound();
  if (target) {
    // The new computer saved its own copy already: the old one only goes.
    await env.DB.batch([moveMessages, env.DB.prepare("delete from cloud_session_copies where user_id = ? and machine_key = ? and session_id = ?").bind(userId, machineKey, sessionId)]);
    await bucket.delete(source.r2_key);
    logCloud("cloud.session_moved", { userId, instanceId: computer.instance_id });
    return json({ moved: true } satisfies CloudSessionMoveResult);
  }
  const keys = await userKeys(env, userId, now);
  if (!keys) return unavailable();
  const object = await bucket.get(source.r2_key);
  const opened = object ? await openBytes(keys.aes, copyAad(userId, machineKey, sessionId), new Uint8Array(await object.arrayBuffer())) : null;
  const summary = await openJson(keys, summaryAad(userId, machineKey, sessionId), source.summary_sealed);
  if (!opened) {
    logCloud("cloud.session_copy_unreadable", { userId, machineKey, sessionId });
    return fail("copy_unreadable", "This session copy can't be read right now.", 503);
  }
  const key = objectKey(userId, toMachineKey, sessionId);
  await bucket.put(key, await sealBytes(keys.aes, copyAad(userId, toMachineKey, sessionId), opened));
  const resealed = summary == null ? null : await sealJson(keys, summaryAad(userId, toMachineKey, sessionId), summary);
  await env.DB.batch([
    env.DB.prepare(`
      insert into cloud_session_copies (user_id, machine_key, session_id, instance_id, project_key, lane_id, kind, parent_chat_id, summary_sealed, r2_key, bytes, line_count, last_activity_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(userId, toMachineKey, sessionId, computer.instance_id, source.project_key, source.lane_id, source.kind, source.parent_chat_id, resealed, key,
      source.bytes, source.line_count, source.last_activity_at, now),
    moveMessages,
    env.DB.prepare("delete from cloud_session_copies where user_id = ? and machine_key = ? and session_id = ?").bind(userId, machineKey, sessionId),
  ]);
  await bucket.delete(source.r2_key);
  logCloud("cloud.session_moved", { userId, instanceId: computer.instance_id });
  return json({ moved: true } satisfies CloudSessionMoveResult);
}

export async function routeSessionCopies(request: Request, url: URL, path: string, env: CloudEnv, userId: string, now: number): Promise<Response> {
  const bucket = env.CLOUD_CHATS;
  if (!bucket) {
    logCloud("cloud.session_bucket_missing", { userId });
    return unavailable();
  }
  const segments = segmentsAfter(path, CLOUD_PATHS.sessions);
  if (segments.length === 0) {
    if (request.method !== "GET") return notFound();
    const machine = url.searchParams.get("machine")?.trim() || null;
    if (machine && !ROW_ID.test(machine)) return json({ sessions: [], nextCursor: null });
    const keys = await userKeys(env, userId, now);
    if (!keys) return unavailable();
    return json(await listSessionRows(env, keys, userId, {
      machine,
      project: url.searchParams.get("project")?.trim() || null,
      cursor: url.searchParams.get("cursor"),
      limit: clampedInt(url.searchParams.get("limit"), DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT),
    }));
  }
  const [machineKey, sessionId, action] = segments;
  if (!machineKey || !sessionId || !ROW_ID.test(machineKey) || !ROW_ID.test(sessionId)) return notFound();
  if (segments.length === 3 && action === "move") return request.method === "POST" ? handleMove(request, env, bucket, userId, machineKey, sessionId, now) : notFound();
  if (segments.length !== 2) return notFound();
  if (request.method === "GET") return handleGet(env, bucket, userId, machineKey, sessionId, now);
  if (request.method === "PUT") return handlePut(request, env, bucket, userId, machineKey, sessionId, now);
  if (request.method === "DELETE") return json({ deleted: await deleteSessionCopy(env, userId, machineKey, sessionId) });
  return notFound();
}
