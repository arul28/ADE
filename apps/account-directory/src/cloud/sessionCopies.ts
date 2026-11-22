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
  CLOUD_INSTANCE_ID,
} from "./contract";
import { ROW_ID, UNREADABLE_REQUEST_MESSAGE, fail, json, pageCursorOf, pageCursorSql } from "./http";
import { openBytes, openJson, sealBytes, sealJson, userKeys, type UserKeys } from "./seal";
import { logCloud, moveQueuedMessagesStatement, ownMachineMoveTarget, ownedComputer, type CloudEnv, type ComputerRow } from "./store";
import { publishedStatement, storageGeneration, sweep, sweepStatement, unclaimedUpload, type SweepTarget } from "./storageSweeps";

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
  if (!CLOUD_INSTANCE_ID.test(named)) return null;
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

/**
 * Each save, and each move, writes the copy to an object of its own (`~` is in no row id) and
 * publishes it with its row in one write, so a move or a delete that read one save never takes
 * a later save's object for it. A row from before keeps `sessions/{user}/{machine}/{session}`.
 */
const newObjectKey = (userId: string, machineKey: string, sessionId: string): string =>
  `sessions/${userId}/${machineKey}/${sessionId}~${storageGeneration()}`;
const objectOf = (key: string): SweepTarget => ({ key, exact: true });
/** The row at `machineKey` is still the one with object `r2Key`. */
const rowWithObject = (userId: string, machineKey: string, sessionId: string, r2Key: string) => ({
  sql: "exists (select 1 from cloud_session_copies where user_id = ? and machine_key = ? and session_id = ? and r2_key = ?)",
  binds: [userId, machineKey, sessionId, r2Key],
});
/**
 * Deletes copy rows as read, with their queued messages, and records their objects to sweep, in
 * one write; a row that changed since (a later save) stays. Answers the objects to sweep now.
 */
async function deleteCopyRows(env: CloudEnv, userId: string, rows: Array<{ machine_key: string; session_id: string; r2_key: string }>, now: number): Promise<SweepTarget[]> {
  if (!rows.length) return [];
  const statements = rows.flatMap((row) => {
    const still = rowWithObject(userId, row.machine_key, row.session_id, row.r2_key);
    return [
      sweepStatement(env, userId, objectOf(row.r2_key), now, still),
      // Messages queued to a CLI go with its copy.
      env.DB.prepare(`delete from cloud_chat_messages where user_id = ? and machine_key = ? and chat_id = ? and ${still.sql}`)
        .bind(userId, row.machine_key, row.session_id, ...still.binds),
      env.DB.prepare("delete from cloud_session_copies where user_id = ? and machine_key = ? and session_id = ? and r2_key = ?")
        .bind(userId, row.machine_key, row.session_id, row.r2_key),
    ];
  });
  const results = await env.DB.batch(statements);
  return rows.filter((_row, index) => (results[index * 3 + 2]?.meta?.changes ?? 0) === 1).map((row) => objectOf(row.r2_key));
}
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
  const summary = await sealJson(keys, summaryAad(userId, machineKey, sessionId), {
    title: input.title,
    laneName: input.laneName,
    toolType: input.toolType,
    projectId: input.projectId,
    status: input.status,
    format,
  });
  const lastActivity = input.lastActivityAt ? Date.parse(input.lastActivityAt) : null;
  const key = newObjectKey(userId, machineKey, sessionId);
  /** Only while the tick has not claimed this save's object: a claimed one is gone. */
  const unclaimed = unclaimedUpload(key);
  let written = false;
  let hadRow = false;
  // Twice at most: a save, move or delete between the read and the write reads again.
  for (let attempt = 0; attempt < 2 && !written; attempt += 1) {
    const existing = await env.DB.prepare("select bytes, r2_key from cloud_session_copies where user_id = ? and machine_key = ? and session_id = ?")
      .bind(userId, machineKey, sessionId).first<{ bytes: number; r2_key: string }>();
    // The row this save read went since (a move or a delete): a new one here would bring the copy back.
    if (!existing && hadRow) break;
    hadRow ||= existing != null;
    const total = await env.DB.prepare("select coalesce(sum(bytes), 0) as total from cloud_session_copies where user_id = ?").bind(userId).first<{ total: number }>();
    if ((total?.total ?? 0) - (existing?.bytes ?? 0) + sealed.byteLength > CLOUD_SESSION_MAX_ACCOUNT_BYTES) {
      if (attempt > 0) await sweep(env, [objectOf(key)]);
      logCloud("cloud.session_account_full", { userId, limitBytes: CLOUD_SESSION_MAX_ACCOUNT_BYTES });
      return fail("account_full", "This account's saved sessions are full. Delete some to save new ones.", 413);
    }
    if (attempt === 0) {
      // Recorded before the upload: a save that dies before it publishes leaves no object no sweep finds.
      await sweepStatement(env, userId, objectOf(key), now).run();
      await bucket.put(key, sealed);
    }
    const published = publishedStatement(env, key, rowWithObject(userId, machineKey, sessionId, key));
    if (existing) {
      // This save's object replaces the one read, and that one is recorded to sweep, in one write:
      // both hold to the same conditions, so a refused update records nothing.
      const row = rowWithObject(userId, machineKey, sessionId, existing.r2_key);
      const replaces = { sql: `${row.sql} and ${unclaimed.sql}`, binds: [...row.binds, ...unclaimed.binds] };
      const results = await env.DB.batch([
        sweepStatement(env, userId, objectOf(existing.r2_key), now, replaces),
        env.DB.prepare(`
          update cloud_session_copies set
            instance_id = ?, project_key = coalesce(?, project_key), lane_id = coalesce(?, lane_id), kind = ?, parent_chat_id = coalesce(?, parent_chat_id),
            summary_sealed = ?, r2_key = ?, bytes = ?, line_count = ?, last_activity_at = coalesce(?, last_activity_at), updated_at = ?
          where user_id = ? and machine_key = ? and session_id = ? and r2_key = ? and ${unclaimed.sql}
        `).bind(
          computer.instance_id, input.projectKey, input.laneId, input.kind, input.parentChatId, summary, key, sealed.byteLength, copy.lines, lastActivity, now,
          userId, machineKey, sessionId, existing.r2_key, ...unclaimed.binds,
        ),
        published,
      ]);
      written = (results[1]?.meta?.changes ?? 0) === 1;
      if (written) await sweep(env, [objectOf(existing.r2_key)]);
    } else {
      const [inserted] = await env.DB.batch([
        env.DB.prepare(`
          insert into cloud_session_copies (user_id, machine_key, session_id, instance_id, project_key, lane_id, kind, parent_chat_id, summary_sealed, r2_key, bytes, line_count, last_activity_at, updated_at)
          select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? where ${unclaimed.sql}
          on conflict (user_id, machine_key, session_id) do nothing
        `).bind(
          userId, machineKey, sessionId, computer.instance_id, input.projectKey, input.laneId, input.kind, input.parentChatId, summary, key,
          sealed.byteLength, copy.lines, lastActivity, now, ...unclaimed.binds,
        ),
        published,
      ]);
      written = (inserted?.meta?.changes ?? 0) === 1;
    }
  }
  if (!written) {
    // Never published: no row reads it.
    await sweep(env, [objectOf(key)]);
    return fail("session_changed", "This session's saved copy changed while it was saved. Try again.", 409);
  }
  await pruneComputer(env, userId, computer.instance_id);
  return json({ ok: true, updatedAt: now });
}

/** A computer keeps its newest copies only: the rest go, rows and objects. */
async function pruneComputer(env: CloudEnv, userId: string, instanceId: string): Promise<void> {
  const old = (await env.DB.prepare(`
    select machine_key, session_id, r2_key from cloud_session_copies where instance_id = ? and user_id = ?
    order by updated_at desc limit 50 offset ?
  `).bind(instanceId, userId, CLOUD_SESSION_MAX_PER_COMPUTER).all<{ machine_key: string; session_id: string; r2_key: string }>()).results ?? [];
  if (!old.length) return;
  await sweep(env, await deleteCopyRows(env, userId, old, Date.now()));
}

function clampedInt(raw: string | null, fallback: number, max: number): number {
  const value = raw ? Number(raw) : Number.NaN;
  return Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

/** The copies of one project (or machine), newest first, paged by `updatedAt:sessionId`. */
/** One page of copies, newest first. `lane` keeps one lane's; `notMachine` leaves out one machine's (as `listSavedChats`). */
export async function listSessionRows(
  env: CloudEnv,
  keys: UserKeys,
  userId: string,
  filter: { machine?: string | null; notMachine?: string | null; project?: string | null; lane?: string | null; cursor?: string | null; limit?: number },
): Promise<{ sessions: CloudSessionRow[]; nextCursor: string | null }> {
  const where = ["user_id = ?"];
  const binds: Array<string | number> = [userId];
  if (filter.machine) {
    where.push("machine_key = ?");
    binds.push(filter.machine);
  }
  if (filter.notMachine) {
    where.push("lower(machine_key) <> lower(?)");
    binds.push(filter.notMachine);
  }
  if (filter.lane) {
    where.push("lane_id = ?");
    binds.push(filter.lane);
  }
  if (filter.project) {
    where.push("project_key = ?");
    binds.push(filter.project);
  }
  const cursor = pageCursorSql(filter.cursor, "session_id");
  if (cursor) {
    where.push(cursor.sql);
    binds.push(...cursor.binds);
  }
  const limit = filter.limit ?? DEFAULT_LIST_LIMIT;
  const rows = (await env.DB.prepare(`select * from cloud_session_copies where ${where.join(" and ")} order by updated_at desc, session_id desc, machine_key desc limit ?`)
    .bind(...binds, limit + 1).all<SessionRow>()).results ?? [];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    sessions: await Promise.all(page.map((row) => rowOf(keys, row))),
    nextCursor: rows.length > limit && last ? pageCursorOf(last.updated_at, last.session_id, last.machine_key) : null,
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
  // Twice at most: a save between the read and the delete reads again.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const row = await env.DB.prepare("select machine_key, session_id, r2_key from cloud_session_copies where user_id = ? and machine_key = ? and session_id = ?")
      .bind(userId, machineKey, sessionId).first<{ machine_key: string; session_id: string; r2_key: string }>();
    if (!row) return false;
    const swept = await deleteCopyRows(env, userId, [row], Date.now());
    if (!swept.length) continue;
    await sweep(env, swept);
    return true;
  }
  return false;
}

/** A lane's copies on one machine go with the lane: the rows read here, each as read. */
export async function deleteSessionCopiesForLane(env: CloudEnv, userId: string, machineKey: string, laneId: string): Promise<number> {
  const rows = (await env.DB.prepare("select machine_key, session_id, r2_key from cloud_session_copies where user_id = ? and machine_key = ? and lane_id = ?")
    .bind(userId, machineKey, laneId).all<{ machine_key: string; session_id: string; r2_key: string }>()).results ?? [];
  const swept = await deleteCopyRows(env, userId, rows, Date.now());
  await sweep(env, swept);
  return swept.length;
}

/** Rows of an account deletion; the objects go with the account's whole R2 prefix (`deleteAllAccountChats`). */
export function deleteAccountSessionCopiesStatement(env: Pick<CloudEnv, "DB">, userId: string): D1PreparedStatement {
  return env.DB.prepare("delete from cloud_session_copies where user_id = ?").bind(userId);
}

/** `/cloud/sessions[/:machine/:session]`. The caller passed the access gate. */
/**
 * `POST /cloud/sessions/:m/:s/move`, from the new computer that continued a
 * deleted computer's CLI: the copy goes to the new computer's machine key,
 * sealed again under it, and the CLI's queued messages follow it
 * (`moveQueuedMessagesStatement`). Later sends then reach the new computer,
 * and a send to the old address finds it by its session id
 * (`resolveTarget`). The same move again answers `moved: false`.
 *
 * Two moves of one copy at once: the batch that still finds the source,
 * in the same transaction that deletes it, is the one that moves it. The
 * other inserts nothing and answers `moved: false` when the copy is at its
 * destination already, else `session_moved` (409): the copy went to
 * another machine.
 */
async function handleMove(request: Request, env: CloudEnv, bucket: R2Bucket, userId: string, machineKey: string, sessionId: string, now: number): Promise<Response> {
  const body = await readCappedJson(request, BODY_OVERHEAD_BYTES);
  if (!body.ok) return unreadable();
  const requestedKey = typeof body.value.toMachineKey === "string" ? body.value.toMachineKey.trim() : "";
  const named = body.value.instanceId;
  const instanceId = typeof named === "string" ? named.trim() : "";
  // No `instanceId`: the person's own machine takes a CLI whose computer is deleted (a kept lane moved to it).
  const ownMachine = named == null;
  if (!ROW_ID.test(requestedKey) || (!ownMachine && !CLOUD_INSTANCE_ID.test(instanceId))) return unreadable();
  let computer: { instance_id: string | null };
  // The destination key as the account stores it: reads match it exactly.
  let toMachineKey = requestedKey;
  if (ownMachine) {
    const target = await ownMachineMoveTarget(env, userId, machineKey, requestedKey);
    if (!target.ok) return fail(target.code, target.message, target.status);
    toMachineKey = target.machineKey;
    computer = { instance_id: null };
  } else {
    const owned = await ownedComputer(env, userId, instanceId);
    // Only the caller's own computer, and only to its own machine key.
    if (!owned || owned.deleted_at != null) return fail("not_found", "ADE Cloud has no such computer.", 404);
    if (owned.machine_key && owned.machine_key.toLowerCase() !== requestedKey.toLowerCase()) {
      return fail("wrong_machine", "A session moves only to the machine key of the computer that asks.", 409);
    }
    toMachineKey = owned.machine_key ?? requestedKey;
    computer = owned;
  }
  const sessionMoved = () => fail("session_moved", "This CLI's saved copy moved to another machine.", 409);
  const rowAt = (key: string) => env.DB.prepare("select * from cloud_session_copies where user_id = ? and machine_key = ? and session_id = ? and kind = 'cli'")
    .bind(userId, key, sessionId).first<SessionRow>();
  if (machineKey === toMachineKey) return json({ moved: false } satisfies CloudSessionMoveResult);
  const done = (moved: boolean) => {
    if (moved) logCloud("cloud.session_moved", { userId, instanceId: computer.instance_id });
    return json({ moved } satisfies CloudSessionMoveResult);
  };
  /** The row at `key` is still the one with object `r2Key`. */
  const stillAt = (key: string, r2Key: string) => ({
    sql: "exists (select 1 from cloud_session_copies where user_id = ? and machine_key = ? and session_id = ? and r2_key = ?)",
    binds: [userId, key, sessionId, r2Key],
  });
  // Twice at most: a batch that finds the rows changed since they were read reads them again.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const source = await rowAt(machineKey);
    const target = await rowAt(toMachineKey);
    if (!source) return target ? done(false) : attempt === 0 ? notFound() : sessionMoved();
    /** The source is still the row this move read: the condition that makes this move the one that moves it. */
    const sourceStillHere = stillAt(machineKey, source.r2_key);
    if (target) {
      // The new computer saved its own copy already: the old one only goes, and only while that copy is
      // still there, in the same write. The delete is the claim; only the move that makes it re-keys messages.
      const targetStillHere = stillAt(toMachineKey, target.r2_key);
      const both = { sql: `${sourceStillHere.sql} and ${targetStillHere.sql}`, binds: [...sourceStillHere.binds, ...targetStillHere.binds] };
      const results = await env.DB.batch([
        moveQueuedMessagesStatement(env, { userId, fromMachineKey: machineKey, toMachineKey, chatId: sessionId, instanceId: computer.instance_id, now, onlyIf: both }),
        sweepStatement(env, userId, objectOf(source.r2_key), now, both),
        env.DB.prepare(`delete from cloud_session_copies where user_id = ? and machine_key = ? and session_id = ? and r2_key = ? and ${targetStillHere.sql}`)
          .bind(userId, machineKey, sessionId, source.r2_key, ...targetStillHere.binds),
      ]);
      if ((results[2]?.meta?.changes ?? 0) !== 1) continue;
      await sweep(env, [objectOf(source.r2_key)]);
      return done(true);
    }
    const keys = await userKeys(env, userId, now);
    if (!keys) return unavailable();
    const object = await bucket.get(source.r2_key);
    const opened = object ? await openBytes(keys.aes, copyAad(userId, machineKey, sessionId), new Uint8Array(await object.arrayBuffer())) : null;
    const summary = await openJson(keys, summaryAad(userId, machineKey, sessionId), source.summary_sealed);
    if (!opened) {
      // A newer save replaced the copy (and its object) since the read: read it again.
      if ((await rowAt(machineKey))?.r2_key !== source.r2_key) continue;
      logCloud("cloud.session_copy_unreadable", { userId, machineKey, sessionId });
      return fail("copy_unreadable", "This session copy can't be read right now.", 503);
    }
    // This move's own object: no other move, and no save of the new computer's own copy, writes it.
    const staged = newObjectKey(userId, toMachineKey, sessionId);
    await sweepStatement(env, userId, objectOf(staged), now).run();
    await bucket.put(staged, await sealBytes(keys.aes, copyAad(userId, toMachineKey, sessionId), opened));
    const resealed = summary == null ? null : await sealJson(keys, summaryAad(userId, toMachineKey, sessionId), summary);
    const insertedHere = stillAt(toMachineKey, staged);
    // Only while the tick has not claimed the staged object: a claimed one is gone.
    const stagedUnclaimed = unclaimedUpload(staged);
    // One transaction: the insert holds only while the source is still the row read above and no copy
    // is at the destination; the messages and the source's delete hold only when this insert did.
    const results = await env.DB.batch([
      env.DB.prepare(`
        insert into cloud_session_copies (user_id, machine_key, session_id, instance_id, project_key, lane_id, kind, parent_chat_id, summary_sealed, r2_key, bytes, line_count, last_activity_at, updated_at)
        select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        where ${sourceStillHere.sql} and not exists (select 1 from cloud_session_copies where user_id = ? and machine_key = ? and session_id = ?)
          and ${stagedUnclaimed.sql}
      `).bind(userId, toMachineKey, sessionId, computer.instance_id, source.project_key, source.lane_id, source.kind, source.parent_chat_id, resealed, staged,
        source.bytes, source.line_count, source.last_activity_at, now, ...sourceStillHere.binds, userId, toMachineKey, sessionId, ...stagedUnclaimed.binds),
      moveQueuedMessagesStatement(env, { userId, fromMachineKey: machineKey, toMachineKey, chatId: sessionId, instanceId: computer.instance_id, now, onlyIf: insertedHere }),
      sweepStatement(env, userId, objectOf(source.r2_key), now, insertedHere),
      env.DB.prepare(`delete from cloud_session_copies where user_id = ? and machine_key = ? and session_id = ? and r2_key = ? and ${insertedHere.sql}`)
        .bind(userId, machineKey, sessionId, source.r2_key, ...insertedHere.binds),
      publishedStatement(env, staged, insertedHere),
    ]);
    if ((results[0]?.meta?.changes ?? 0) === 1) {
      await sweep(env, [objectOf(source.r2_key)]);
      return done(true);
    }
    // Another move, or the new computer's own upload, got there first: only this move's object goes.
    await sweep(env, [objectOf(staged)]);
  }
  return fail("session_changed", "This CLI's saved copy changed while it moved. Try again.", 409);
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
    const notMachine = url.searchParams.get("notMachine")?.trim() || null;
    const lane = url.searchParams.get("lane")?.trim() || null;
    if ([machine, notMachine, lane].some((value) => value && !ROW_ID.test(value))) return json({ sessions: [], nextCursor: null });
    const keys = await userKeys(env, userId, now);
    if (!keys) return unavailable();
    return json(await listSessionRows(env, keys, userId, {
      machine,
      notMachine,
      lane,
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
