import {
  CLOUD_CHAT_MAX_ACCOUNT_BYTES,
  CLOUD_CHAT_MAX_PAGE_PARTS,
  CLOUD_CHAT_MAX_PART_BYTES,
  type CloudChatComputer,
  type CloudChatMoveResult,
  type CloudChatPartResponse,
  type CloudChatRow,
  type CloudChatRowInput,
  CLOUD_PATHS,
  type CloudChatTranscriptPage,
  type CloudComputerDeleteReason,
  CLOUD_INSTANCE_ID,
} from "./contract";
import { ROW_ID, UNREADABLE_REQUEST_MESSAGE, fail, json, readJson } from "./http";
import { rewardAfterCloudChat } from "./referrals";
import { captureCloudSafety, type CloudWaitUntil } from "./analytics";
import { logCloud, moveQueuedMessagesStatement, ownMachineMoveTarget, ownedComputer, type CloudEnv } from "./store";
import { digestFor, openBytes, openText, sealBytes, sealText, userKeys, type UserKeys } from "./seal";
import { deleteCapsule, deleteCapsulesForLane } from "./forkCapsules";
import { deleteGitSummaryForLaneStatement } from "./gitSummaries";
import { deleteSessionCopiesForLane } from "./sessionCopies";

/**
 * Saved chats (README, "Saved chats"). After each turn a computer sends the new
 * part of a chat here, so its chats stay readable while it is asleep, stopped,
 * out of hours, or deleted. The computer's own history stays the source of
 * truth; this is a copy.
 *
 * Parts live in R2, sealed per object with AES-GCM under one random key per
 * user. That key is sealed with `CLOUD_CHAT_MASTER_KEY` and kept in D1, apart
 * from the chats. **Platform encryption, not end-to-end**, like the vault
 * (`apps/push-relay/src/accountVault.ts`): whoever holds the Worker's secret can
 * read a chat; a dump of the bucket or the database alone reveals nothing.
 *
 * The same secret also keys the stored computer ids of the free plan
 * (`freePlan.ts`): rotating it orphans every free-plan claim, so every computer
 * could claim the free plan again. Rotate it only together with a plan for those.
 *
 * Every read looks up the row under the caller's own account, so another
 * account's chat answers 404 exactly like one that doesn't exist. No chat text
 * reaches a log line, an error message, or Sentry: a part is opaque bytes here.
 */

const SEQ = /^[1-9][0-9]{0,8}$/;
/** Room for the JSON around a part in the request body. */
const PUT_BODY_OVERHEAD_BYTES = 64 * 1024;
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 500;
const DEFAULT_PAGE_PARTS = 6;
/** A page stops at about this much text, so one response stays a sane size. */
const PAGE_TARGET_BYTES = 8 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const notFound = () => fail("not_found", "That saved chat doesn't exist.", 404);
const unavailable = () => fail("unavailable", "Saved chats aren't available right now. Try again soon.", 503);

const partAad = (userId: string, machineKey: string, chatId: string, seq: number): string =>
  `ade.cloud.chat.part.v1\0${userId}\0${machineKey}\0${chatId}\0${seq}`;
const summaryAad = (userId: string, machineKey: string, chatId: string): string =>
  `ade.cloud.chat.summary.v1\0${userId}\0${machineKey}\0${chatId}`;

/** Every object of one chat sits under this prefix (`cloud_chat_copies.r2_key`). */
const chatPrefix = (userId: string, machineKey: string, chatId: string): string => `chats/${userId}/${machineKey}/${chatId}/`;
const partKey = (prefix: string, seq: number): string => `${prefix}${String(seq).padStart(10, "0")}`;

export type CopyRow = {
  user_id: string;
  machine_key: string;
  chat_id: string;
  instance_id: string | null;
  project_key: string | null;
  lane_id: string | null;
  summary_sealed: string | null;
  r2_key: string;
  last_activity_at: number | null;
  last_seq: number;
  bytes: number;
  updated_at: number;
  /** Migration 0039: the parent chat ADE started this one from, and how. */
  parent_chat_id?: string | null;
  spawn_kind?: string | null;
  /** Migration 0039: the saved chat a fork restore moved to this row. */
  forked_from_machine_key?: string | null;
  forked_from_chat_id?: string | null;
  /** Migration 0039: the machine key its parts and summary are sealed under; null is `machine_key`. */
  aad_machine_key?: string | null;
};

/** The machine key a row's parts and summary are sealed under: it stays when a move re-keys the row. */
const sealKeyOf = (row: Pick<CopyRow, "machine_key" | "aad_machine_key">): string => row.aad_machine_key ?? row.machine_key;

function bucketFor(env: Pick<CloudEnv, "CLOUD_CHATS">): R2Bucket | null {
  return env.CLOUD_CHATS ?? null;
}

/** The row a fork restore moved this chat to, if one did. */
export async function movedRow(env: CloudEnv, userId: string, fromMachineKey: string, chatId: string): Promise<CopyRow | null> {
  return await env.DB.prepare(`
    select * from cloud_chat_copies where user_id = ? and forked_from_machine_key = ? and forked_from_chat_id = ? and chat_id = ?
    order by updated_at desc limit 1
  `).bind(userId, fromMachineKey, chatId, chatId).first<CopyRow>();
}

export async function copyRow(env: CloudEnv, userId: string, machineKey: string, chatId: string): Promise<CopyRow | null> {
  return env.DB.prepare("select * from cloud_chat_copies where user_id = ? and machine_key = ? and chat_id = ?")
    .bind(userId, machineKey, chatId).first<CopyRow>();
}

async function accountBytes(env: CloudEnv, userId: string): Promise<number> {
  const row = await env.DB.prepare("select coalesce(sum(bytes), 0) as total from cloud_chat_copies where user_id = ?").bind(userId).first<{ total: number }>();
  return row?.total ?? 0;
}

const SUMMARY_LIMITS: Record<keyof CloudChatRowInput, number> = {
  title: 300,
  laneId: 160,
  laneName: 200,
  status: 40,
  toolType: 40,
  provider: 60,
  model: 200,
  projectKey: 300,
  projectId: 160,
  projectRoot: 1000,
  lastActivityAt: 40,
  parentChatId: 160,
  spawnKind: 40,
};

function readRowInput(value: unknown): CloudChatRowInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const pick = (key: keyof CloudChatRowInput): string | null => {
    const entry = record[key];
    if (entry == null) return null;
    if (typeof entry !== "string") return null;
    const trimmed = entry.trim();
    return trimmed ? trimmed.slice(0, SUMMARY_LIMITS[key]) : null;
  };
  const laneId = pick("laneId");
  if (laneId && !ROW_ID.test(laneId)) return null;
  const lastActivity = pick("lastActivityAt");
  if (lastActivity && Number.isNaN(Date.parse(lastActivity))) return null;
  // Ids only: a parent id that isn't one is left out, never a refused part (an older server ignored it).
  const parentChatId = pick("parentChatId");
  const spawnKind = pick("spawnKind");
  return {
    title: pick("title"),
    laneId,
    laneName: pick("laneName"),
    status: pick("status"),
    toolType: pick("toolType"),
    provider: pick("provider"),
    model: pick("model"),
    projectKey: pick("projectKey"),
    projectId: pick("projectId"),
    projectRoot: pick("projectRoot"),
    lastActivityAt: lastActivity,
    parentChatId: parentChatId && ROW_ID.test(parentChatId) ? parentChatId : null,
    spawnKind: spawnKind && /^[a-z][a-z0-9_-]{0,39}$/.test(spawnKind) ? spawnKind : null,
  };
}

async function readJsonBody(request: Request, maxBytes: number): Promise<{ ok: true; value: unknown } | { ok: false; tooLarge: boolean }> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, tooLarge: true };
  const raw = await request.arrayBuffer();
  if (raw.byteLength > maxBytes) return { ok: false, tooLarge: true };
  try {
    return { ok: true, value: JSON.parse(decoder.decode(raw)) };
  } catch {
    return { ok: false, tooLarge: false };
  }
}


/**
 * `PUT /cloud/chats/:machine/:chat/parts/:seq`, from the computer. Parts append
 * by sequence, and every path through here can be replayed:
 *
 * - the same part again answers 200 and writes nothing;
 * - the newest part may be sent again with more text (the computer retries an
 *   upload whose answer it never saw, and by then the chat has grown);
 * - an older part sent with different text, or a gap, answers 409 with the
 *   sequence the server expects, and the computer starts over.
 */
async function handlePutPart(request: Request, env: CloudEnv, userId: string, machineKey: string, chatId: string, seq: number, now: number, waitUntil: CloudWaitUntil): Promise<Response> {
  const bucket = bucketFor(env);
  if (!bucket) {
    logCloud("cloud.chat_bucket_missing", { userId });
    return unavailable();
  }
  const body = await readJsonBody(request, CLOUD_CHAT_MAX_PART_BYTES + PUT_BODY_OVERHEAD_BYTES);
  if (!body.ok) {
    if (body.tooLarge) {
      logCloud("cloud.chat_part_too_large", { userId, machineKey, chatId, seq });
      return fail("part_too_large", "That part of the chat is too large to save.", 413);
    }
    return fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);
  }
  const record = body.value && typeof body.value === "object" && !Array.isArray(body.value) ? body.value as Record<string, unknown> : null;
  const text = typeof record?.text === "string" ? record.text : null;
  const instanceId = typeof record?.instanceId === "string" ? record.instanceId.trim() : "";
  if (text == null || !instanceId) return fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);
  const rowInput = readRowInput(record?.row);
  if (!rowInput) return fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);
  const plain = encoder.encode(text);
  if (plain.byteLength > CLOUD_CHAT_MAX_PART_BYTES) {
    logCloud("cloud.chat_part_too_large", { userId, machineKey, chatId, seq, bytes: plain.byteLength });
    return fail("part_too_large", "That part of the chat is too large to save.", 413);
  }
  // Called from the computer: only its owner's computers save here.
  if (!await ownedComputer(env, userId, instanceId)) return fail("not_found", "ADE Cloud has no such computer.", 404);

  const keys = await userKeys(env, userId, now);
  if (!keys) return unavailable();

  const existing = await copyRow(env, userId, machineKey, chatId);
  if (!existing && await movedRow(env, userId, machineKey, chatId)) {
    // Its parts still live under this key's prefix: a new copy here would write over them.
    return fail("chat_moved", "This chat moved to another computer. Save it from there.", 409);
  }
  const lastSeq = existing?.last_seq ?? 0;
  // A chat a fork restore moved here keeps its parts where they are, sealed under its first machine key.
  const prefix = existing?.r2_key ?? chatPrefix(userId, machineKey, chatId);
  const sealKey = existing ? sealKeyOf(existing) : machineKey;
  const key = partKey(prefix, seq);
  const digest = await digestFor(keys, plain);
  let replacedSize = 0;
  if (seq <= lastSeq) {
    const stored = await bucket.head(key);
    if (stored?.customMetadata?.digest === digest) {
      // The same part again: nothing to write. Its answer is what the computer missed. A first-chat
      // note that failed on the first try is tried again here (it is a conditional write).
      await noteFirstCloudChat(env, userId, now, waitUntil);
      return json({ ok: true, lastSeq } satisfies CloudChatPartResponse);
    }
    if (seq !== lastSeq) {
      logCloud("cloud.chat_part_conflict", { userId, machineKey, chatId, seq, lastSeq });
      return fail("sequence_conflict", "That part doesn't follow what is saved.", 409);
    }
    replacedSize = stored?.size ?? 0;
  } else if (seq !== lastSeq + 1) {
    logCloud("cloud.chat_part_gap", { userId, machineKey, chatId, seq, lastSeq });
    return fail("sequence_conflict", "That part doesn't follow what is saved.", 409);
  }

  const sealed = await sealBytes(keys.aes, partAad(userId, sealKey, chatId, seq), plain);
  const delta = sealed.byteLength - replacedSize;
  if (delta > 0 && await accountBytes(env, userId) + delta > CLOUD_CHAT_MAX_ACCOUNT_BYTES) {
    logCloud("cloud.chat_account_full", { userId, machineKey, chatId, limitBytes: CLOUD_CHAT_MAX_ACCOUNT_BYTES });
    return fail("account_full", "This account's saved chats are full. Delete some chats to save new ones.", 413);
  }

  await bucket.put(key, sealed, { customMetadata: { digest } });

  const row: CloudChatRow = {
    machineKey,
    chatId,
    instanceId,
    projectKey: rowInput.projectKey,
    projectId: rowInput.projectId,
    projectRoot: rowInput.projectRoot,
    laneId: rowInput.laneId,
    title: rowInput.title,
    laneName: rowInput.laneName,
    status: rowInput.status,
    toolType: rowInput.toolType,
    provider: rowInput.provider,
    model: rowInput.model,
    lastActivityAt: rowInput.lastActivityAt,
    lastSeq: Math.max(seq, lastSeq),
    updatedAt: now,
  };
  const summary = await sealText(keys.aes, summaryAad(userId, sealKey, chatId), encoder.encode(JSON.stringify({
    title: row.title,
    laneName: row.laneName,
    status: row.status,
    toolType: row.toolType,
    provider: row.provider,
    model: row.model,
    projectId: row.projectId,
    projectRoot: row.projectRoot,
  })));
  const lastActivityMs = rowInput.lastActivityAt ? Date.parse(rowInput.lastActivityAt) : null;
  await env.DB.prepare(`
    insert into cloud_chat_copies (user_id, machine_key, chat_id, instance_id, project_key, lane_id, summary_sealed, r2_key, last_activity_at, last_seq, bytes, updated_at, parent_chat_id, spawn_kind)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict (user_id, machine_key, chat_id) do update set
      instance_id = excluded.instance_id,
      project_key = coalesce(excluded.project_key, project_key),
      lane_id = coalesce(excluded.lane_id, lane_id),
      summary_sealed = excluded.summary_sealed,
      last_activity_at = coalesce(excluded.last_activity_at, last_activity_at),
      last_seq = max(last_seq, excluded.last_seq),
      bytes = max(0, bytes + ?),
      updated_at = excluded.updated_at,
      parent_chat_id = coalesce(excluded.parent_chat_id, parent_chat_id),
      spawn_kind = coalesce(excluded.spawn_kind, spawn_kind)
  `).bind(
    userId, machineKey, chatId, instanceId, row.projectKey, row.laneId, summary, prefix, lastActivityMs, row.lastSeq, sealed.byteLength, now,
    rowInput.parentChatId ?? null, rowInput.spawnKind ?? null,
    delta,
  ).run();
  // A saved part is the server's proof a chat ran on an ADE Cloud computer: it pays an
  // invited friend's pending referral (`referrals.ts`). Every save asks, not only a chat's
  // first, so a reward that failed is retried by the next save; with nothing pending that is
  // one primary-key read. Never fails the save.
  await rewardAfterCloudChat(env, userId, now);
  await noteFirstCloudChat(env, userId, now, waitUntil);
  return json({ ok: true, lastSeq: row.lastSeq } satisfies CloudChatPartResponse);
}

/** Accounts this isolate already saw past their first chat: their saves skip the write below. */
const firstChatSeen = new Set<string>();
const FIRST_CHAT_SEEN_MAX = 10_000;

/**
 * The account's first saved cloud chat part, once (`cloud_accounts.first_chat_at`):
 * a log line and one `ade_cloud_safety` `first_chat`. Never fails the save.
 */
async function noteFirstCloudChat(env: CloudEnv, userId: string, now: number, waitUntil: CloudWaitUntil): Promise<void> {
  if (firstChatSeen.has(userId)) return;
  try {
    const result = await env.DB.prepare("update cloud_accounts set first_chat_at = ? where user_id = ? and first_chat_at is null").bind(now, userId).run();
    if (firstChatSeen.size >= FIRST_CHAT_SEEN_MAX) firstChatSeen.clear();
    firstChatSeen.add(userId);
    if ((result.meta.changes ?? 0) !== 1) return;
    logCloud("cloud.first_chat", { userId });
    // The request's waitUntil: the event must outlive the answer, since `first_chat_at` is already saved.
    captureCloudSafety(env, waitUntil, userId, "first_chat", "first_chat", now);
  } catch (error) {
    logCloud("cloud.first_chat_note_failed", { userId, message: error instanceof Error ? error.message : "unknown" });
  }
}

export function rowToJson(row: CopyRow, summary: Record<string, unknown> | null): CloudChatRow {
  const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
  return {
    machineKey: row.machine_key,
    chatId: row.chat_id,
    instanceId: row.instance_id,
    projectKey: row.project_key,
    projectId: text(summary?.projectId),
    projectRoot: text(summary?.projectRoot),
    laneId: row.lane_id,
    title: text(summary?.title),
    laneName: text(summary?.laneName),
    status: text(summary?.status),
    toolType: text(summary?.toolType),
    provider: text(summary?.provider),
    model: text(summary?.model),
    lastActivityAt: row.last_activity_at != null ? new Date(row.last_activity_at).toISOString() : null,
    lastSeq: row.last_seq,
    updatedAt: row.updated_at,
    parentChatId: row.parent_chat_id ?? null,
    spawnKind: row.spawn_kind ?? null,
    forkedFrom: row.forked_from_machine_key && row.forked_from_chat_id ? { machineKey: row.forked_from_machine_key, chatId: row.forked_from_chat_id } : null,
  };
}

export async function openSummary(keys: UserKeys, row: CopyRow): Promise<Record<string, unknown> | null> {
  if (!row.summary_sealed) return null;
  const opened = await openText(keys.aes, summaryAad(row.user_id, sealKeyOf(row), row.chat_id), row.summary_sealed);
  const value = opened ? parseJson(decoder.decode(opened)) : undefined;
  if (value === undefined) {
    logCloud("cloud.chat_summary_unreadable", { userId: row.user_id, machineKey: row.machine_key, chatId: row.chat_id });
    return null;
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The parsed value, or undefined when it isn't JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function clampedInt(raw: string | null, fallback: number, max: number): number {
  const value = raw ? Number(raw) : Number.NaN;
  return Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

/** A delete log reason (`deleteComputer`'s `reason`) as a person reads it. */
function computerDeleteReason(reason: string | null | undefined): CloudComputerDeleteReason {
  switch (reason) {
    case "user":
      return "you";
    case "freed":
      return "freed";
    case "idle_cleanup":
      return "idle";
    case "plan_limit":
      return "plan";
    case "automation_run_done":
      return "automation";
    case "project_delete":
      return "project";
    case "lane_launch_cancelled":
    case "create_failed":
      return "launch";
    default:
      return reason?.startsWith("launch_") ? "launch" : "other";
  }
}

/** D1 refuses a statement with too many bound values; `in (…)` reads go in chunks. */
const D1_IN_CHUNK = 90;

type ComputerRow = { instance_id: string; machine_key: string | null; deleted_at: number | null };

/** The rows of `select … where user_id = ? and <column> in (values)`, read in chunks. */
async function rowsIn<T>(env: CloudEnv, select: string, column: string, userId: string, values: readonly string[]): Promise<T[]> {
  const rows: T[] = [];
  for (let start = 0; start < values.length; start += D1_IN_CHUNK) {
    const chunk = values.slice(start, start + D1_IN_CHUNK);
    const read = await env.DB.prepare(`${select} where user_id = ? and ${column} in (${chunk.map(() => "?").join(", ")})`).bind(userId, ...chunk).all<T>();
    rows.push(...(read.results ?? []));
  }
  return rows;
}

/**
 * Whether each listed chat's computer still exists, from the account's own
 * computer rows (deleted rows stay, marked `deleted_at`) and the delete log.
 * One live computer with the chat's machine key means it exists: the key is
 * the ADE on that computer, whichever computer row saved the chat. Else the
 * chat is matched by the computer that saved it, else by the newest deleted
 * computer with its key.
 */
async function savedChatComputers(
  env: CloudEnv,
  userId: string,
  page: readonly CopyRow[],
): Promise<(row: CopyRow) => CloudChatComputer | null> {
  if (page.length === 0) return () => null;
  // Only the computers this page names, by id or by key: an account keeps every deleted computer's row.
  const select = "select instance_id, machine_key, deleted_at from cloud_computers";
  const [byId, byKey] = await Promise.all([
    rowsIn<ComputerRow>(env, select, "instance_id", userId, [...new Set(page.flatMap((row) => (row.instance_id ? [row.instance_id] : [])))]),
    rowsIn<ComputerRow>(env, select, "lower(machine_key)", userId, [...new Set(page.map((row) => row.machine_key.toLowerCase()))]),
  ]);
  const byInstance = new Map([...byId, ...byKey].map((computer) => [computer.instance_id, computer]));
  const computers = [...byInstance.values()];
  const byMachineKey = new Map<string, ComputerRow[]>();
  for (const computer of computers) {
    const key = computer.machine_key?.toLowerCase();
    if (!key) continue;
    const list = byMachineKey.get(key);
    if (list) list.push(computer);
    else byMachineKey.set(key, [computer]);
  }
  const matchOf = (row: CopyRow) => {
    const sameKey = byMachineKey.get(row.machine_key.toLowerCase()) ?? [];
    const live = sameKey.find((computer) => computer.deleted_at == null);
    if (live) return live;
    const own = row.instance_id ? byInstance.get(row.instance_id) : undefined;
    return own
      ?? sameKey.reduce<ComputerRow | undefined>((newest, computer) => (!newest || (computer.deleted_at ?? 0) > (newest.deleted_at ?? 0) ? computer : newest), undefined);
  };
  const gone = [...new Set(page.map(matchOf).filter((computer) => computer && computer.deleted_at != null).map((computer) => computer!.instance_id))];
  const logged = await rowsIn<{ instance_id: string; reason: string; created_at: number }>(
    env, "select instance_id, reason, created_at from cloud_delete_log", "instance_id", userId, gone,
  );
  // The oldest entry wins: the delete is logged first, so a later close (the tick finding it gone) never hides its reason.
  logged.sort((a, b) => a.created_at - b.created_at);
  const reasons = new Map<string, string>();
  for (const entry of logged) if (!reasons.has(entry.instance_id)) reasons.set(entry.instance_id, entry.reason);
  return (row) => {
    const computer = matchOf(row);
    if (!computer) return null;
    if (computer.deleted_at == null) return { state: "exists" };
    return { state: "deleted", deletedAt: computer.deleted_at, reason: computerDeleteReason(reasons.get(computer.instance_id)) };
  };
}

/** One page of saved chats, newest activity first; `cursor` is `updatedAt:chatId` of the last row of the previous page. */
export async function listSavedChats(
  env: CloudEnv,
  keys: UserKeys,
  userId: string,
  filter: { machine?: string | null; project?: string | null; cursor?: string | null; limit: number },
): Promise<{ chats: CloudChatRow[]; nextCursor: string | null }> {
  const cursor = filter.cursor?.match(/^(\d+):(.+)$/) ?? null;
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
  if (cursor) {
    where.push("(updated_at < ? or (updated_at = ? and chat_id < ?))");
    binds.push(Number(cursor[1]), Number(cursor[1]), cursor[2]!);
  }
  const rows = await env.DB.prepare(`select * from cloud_chat_copies where ${where.join(" and ")} order by updated_at desc, chat_id desc limit ?`)
    .bind(...binds, filter.limit + 1).all<CopyRow>();
  const results = rows.results ?? [];
  const page = results.slice(0, filter.limit);
  const [summaries, computerOf] = await Promise.all([
    Promise.all(page.map((row) => openSummary(keys, row))),
    savedChatComputers(env, userId, page),
  ]);
  const chats: CloudChatRow[] = page.map((row, index) => ({ ...rowToJson(row, summaries[index] ?? null), computer: computerOf(row) }));
  const last = page[page.length - 1];
  return { chats, nextCursor: results.length > filter.limit && last ? `${last.updated_at}:${last.chat_id}` : null };
}

/** `GET /cloud/chats?machine&project&limit&cursor`: newest activity first. */
async function handleList(url: URL, env: CloudEnv, userId: string, now: number): Promise<Response> {
  const machine = url.searchParams.get("machine")?.trim() || null;
  if (machine && !ROW_ID.test(machine)) return json({ chats: [], nextCursor: null });
  const keys = await userKeys(env, userId, now);
  if (!keys) return unavailable();
  return json(await listSavedChats(env, keys, userId, {
    machine,
    project: url.searchParams.get("project")?.trim() || null,
    cursor: url.searchParams.get("cursor"),
    limit: clampedInt(url.searchParams.get("limit"), DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT),
  }));
}

/**
 * `GET /cloud/chats/:machine/:chat?before&limit`. Newest parts first, each one
 * JSON lines of chat events. `before` is exclusive; `limit` is a page of parts.
 */
async function handleGetChat(url: URL, env: CloudEnv, userId: string, machineKey: string, chatId: string, now: number): Promise<Response> {
  const bucket = bucketFor(env);
  if (!bucket) return unavailable();
  // The owner check, on every read: the row is looked up under the caller's account.
  // A client that still names the old machine key of a moved chat reads it where it is now.
  const row = await copyRow(env, userId, machineKey, chatId) ?? await movedRow(env, userId, machineKey, chatId);
  if (!row) return notFound();
  const keys = await userKeys(env, userId, now);
  if (!keys) return unavailable();

  const beforeRaw = url.searchParams.get("before");
  const beforeParsed = beforeRaw ? Number(beforeRaw) : Number.NaN;
  const before = Number.isInteger(beforeParsed) && beforeParsed > 0 ? Math.min(beforeParsed, row.last_seq + 1) : row.last_seq + 1;
  const limit = clampedInt(url.searchParams.get("limit"), DEFAULT_PAGE_PARTS, CLOUD_CHAT_MAX_PAGE_PARTS);

  const parts: CloudChatTranscriptPage["parts"] = [];
  let bytes = 0;
  let seq = before - 1;
  for (; seq >= 1 && parts.length < limit && bytes < PAGE_TARGET_BYTES; seq -= 1) {
    const object = await bucket.get(partKey(row.r2_key, seq));
    if (!object) {
      // A part R2 no longer has: the copy is damaged. Say so instead of hiding the gap.
      logCloud("cloud.chat_part_missing", { userId, machineKey, chatId, seq });
      return fail("chat_unreadable", "This saved chat can't be read right now.", 503);
    }
    const opened = await openBytes(keys.aes, partAad(userId, sealKeyOf(row), row.chat_id, seq), new Uint8Array(await object.arrayBuffer()));
    if (!opened) {
      logCloud("cloud.chat_part_unreadable", { userId, machineKey, chatId, seq });
      return fail("chat_unreadable", "This saved chat can't be read right now.", 503);
    }
    bytes += opened.byteLength;
    parts.push({ seq, text: decoder.decode(opened) });
  }
  const summary = await openSummary(keys, row);
  return json({
    chat: rowToJson(row, summary),
    parts,
    hasMore: seq >= 1,
    nextBefore: seq >= 1 ? seq + 1 : null,
  } satisfies CloudChatTranscriptPage);
}

async function deleteObjectsUnder(bucket: R2Bucket, prefix: string): Promise<number> {
  let cursor: string | undefined;
  let removed = 0;
  for (;;) {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length) {
      await bucket.delete(keys);
      removed += keys.length;
    }
    if (!listed.truncated) return removed;
    cursor = listed.cursor;
  }
}

/**
 * Deletes one saved chat. A chat the account doesn't have is already deleted.
 * A client that still names the old machine key of a moved chat deletes it
 * where it is now, as its read does (`handleGetChat`).
 */
export async function deleteSavedChat(env: CloudEnv, userId: string, namedMachineKey: string, chatId: string): Promise<boolean> {
  const bucket = bucketFor(env);
  if (!bucket) throw new Error("cloud_chats_bucket_missing");
  const row = await copyRow(env, userId, namedMachineKey, chatId) ?? await movedRow(env, userId, namedMachineKey, chatId);
  if (!row) return false;
  const machineKey = row.machine_key;
  await deleteObjectsUnder(bucket, row.r2_key);
  await env.DB.batch([
    env.DB.prepare("delete from cloud_chat_copies where user_id = ? and machine_key = ? and chat_id = ?").bind(userId, machineKey, chatId),
    deleteChatMessagesStatement(env, userId, machineKey, chatId),
  ]);
  // Its fork capsule goes too: under this key, and under the key it moved from.
  await deleteCapsule(env, userId, machineKey, chatId);
  if (row.forked_from_machine_key && row.forked_from_machine_key !== machineKey) await deleteCapsule(env, userId, row.forked_from_machine_key, chatId);
  logCloud("cloud.chat_deleted", { userId, machineKey, chatId });
  return true;
}

/** A chat's queued messages go with the chat. */
export function deleteChatMessagesStatement(env: Pick<CloudEnv, "DB">, userId: string, machineKey: string, chatId: string): D1PreparedStatement {
  return env.DB.prepare("delete from cloud_chat_messages where user_id = ? and machine_key = ? and chat_id = ?").bind(userId, machineKey, chatId);
}

/**
 * `POST /cloud/chats/:m/:c/move`, from the new computer of a fork restore:
 * re-keys the saved chat to the new computer's machine key with its full
 * history. The parts stay where they are, sealed under the first key
 * (`aad_machine_key`), so nothing is uploaded again and the chat lists once.
 * Its queued messages follow it (`moveQueuedMessagesStatement`); its
 * capsule, now used, goes, unless the caller keeps it (`keepCapsule`) and
 * deletes it after its restore. The same move again answers the moved row.
 *
 * With no `instanceId`, the person's own signed-in machine takes the chat
 * (a kept lane moved to it): only from a deleted computer's key, only to one
 * of the account's own machines (`ownMachineMoveTarget`). The row then has
 * no computer, so it lists as that machine's chat, not a deleted computer's.
 * The row takes the destination key as the account stores it.
 */
async function handleMove(request: Request, env: CloudEnv, userId: string, machineKey: string, chatId: string, now: number): Promise<Response> {
  const body = await readJson(request);
  const requestedKey = typeof body?.toMachineKey === "string" ? body.toMachineKey.trim() : "";
  const named = body?.instanceId;
  const instanceId = typeof named === "string" ? named.trim() : "";
  // No `instanceId`: the person's own machine takes a chat whose computer is deleted (a kept lane moved to it).
  const ownMachine = named == null;
  // `keepCapsule`: the caller deletes the capsule itself once its restore succeeded, so a failed restore can read it again.
  const keepCapsule = body?.keepCapsule === true;
  if (!ROW_ID.test(requestedKey) || (!ownMachine && !CLOUD_INSTANCE_ID.test(instanceId))) return fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);
  // The row's computer after the move: the cloud computer that asks, or none for the person's own machine.
  let targetInstanceId: string | null = null;
  // The destination key as the account stores it: reads match it exactly.
  let toMachineKey = requestedKey;
  if (ownMachine) {
    const target = await ownMachineMoveTarget(env, userId, machineKey, requestedKey);
    if (!target.ok) return fail(target.code, target.message, target.status);
    toMachineKey = target.machineKey;
  } else {
    const computer = await ownedComputer(env, userId, instanceId);
    // Only the caller's own computer, and only to its own machine key.
    if (!computer || computer.deleted_at != null) return fail("not_found", "ADE Cloud has no such computer.", 404);
    if (computer.machine_key && computer.machine_key.toLowerCase() !== requestedKey.toLowerCase()) {
      return fail("wrong_machine", "A chat moves only to the machine key of the computer that asks.", 409);
    }
    targetInstanceId = computer.instance_id;
    toMachineKey = computer.machine_key ?? requestedKey;
  }
  const keys = await userKeys(env, userId, now);
  if (!keys) return unavailable();
  const answer = async (row: CopyRow, moved: boolean) => json({ chat: rowToJson(row, await openSummary(keys, row)), moved } satisfies CloudChatMoveResult);
  const source = await copyRow(env, userId, machineKey, chatId);
  if (machineKey === toMachineKey) return source ? answer(source, false) : notFound();
  const target = await copyRow(env, userId, toMachineKey, chatId);
  if (!source) {
    // Moved already: the same move again answers the moved row.
    return target && target.forked_from_machine_key === machineKey && target.forked_from_chat_id === chatId ? answer(target, false) : notFound();
  }
  if (target) return fail("chat_exists", "The new computer already has a saved copy of this chat.", 409);
  const moved = await env.DB.batch([
    env.DB.prepare(`
      update cloud_chat_copies set machine_key = ?, instance_id = ?, forked_from_machine_key = ?, forked_from_chat_id = ?,
        aad_machine_key = coalesce(aad_machine_key, machine_key), updated_at = ?
      where user_id = ? and machine_key = ? and chat_id = ?
    `).bind(toMachineKey, targetInstanceId, machineKey, chatId, now, userId, machineKey, chatId),
    moveQueuedMessagesStatement(env, { userId, fromMachineKey: machineKey, toMachineKey, chatId, instanceId: targetInstanceId, now }),
  ]);
  if ((moved[0]?.meta?.changes ?? 0) !== 1) return notFound();
  // Used now. A caller that keeps it reads it from the key the row moved from (`forkedFrom`) until its restore succeeds.
  if (!keepCapsule) await deleteCapsule(env, userId, machineKey, chatId);
  logCloud("cloud.chat_moved", { userId, instanceId: targetInstanceId, ownMachine, keptCapsule: keepCapsule });
  const row = await copyRow(env, userId, toMachineKey, chatId);
  return row ? answer(row, true) : notFound();
}

/** Deletes a lane's saved chats on one computer. A computer's chats survive the computer; a lane's don't survive the lane. */
export async function deleteSavedChatsForLane(env: CloudEnv, userId: string, machineKey: string, laneId: string): Promise<number> {
  const rows = await env.DB.prepare("select chat_id from cloud_chat_copies where user_id = ? and machine_key = ? and lane_id = ?")
    .bind(userId, machineKey, laneId).all<{ chat_id: string }>();
  let removed = 0;
  for (const row of rows.results ?? []) {
    if (await deleteSavedChat(env, userId, machineKey, row.chat_id)) removed += 1;
  }
  // The lane's CLI and shell copies, Git summary and left capsules go with it.
  await deleteSessionCopiesForLane(env, userId, machineKey, laneId);
  await deleteCapsulesForLane(env, userId, machineKey, laneId);
  await deleteGitSummaryForLaneStatement(env, userId, machineKey, laneId).run();
  return removed;
}

/**
 * Deletes a lane's saved chats under every computer they were filed under: a
 * lane kept without a computer can have had several (a move, a new computer),
 * and a client sees only the keys of the chats it listed.
 */
export async function deleteSavedChatsForLaneEverywhere(env: CloudEnv, userId: string, laneId: string, keepMachineKey: string | null = null): Promise<number> {
  const keys = await env.DB.prepare(`
    select machine_key from cloud_chat_copies where user_id = ? and lane_id = ?
    union select machine_key from cloud_session_copies where user_id = ? and lane_id = ?
    union select machine_key from cloud_fork_capsules where user_id = ? and lane_id = ?
    union select machine_key from cloud_git_summaries where user_id = ? and lane_id = ?
  `).bind(userId, laneId, userId, laneId, userId, laneId, userId, laneId).all<{ machine_key: string }>();
  let removed = 0;
  for (const row of keys.results ?? []) {
    // A lane moved to the person's own machine keeps what moved there.
    if (keepMachineKey && row.machine_key.toLowerCase() === keepMachineKey.toLowerCase()) continue;
    removed += await deleteSavedChatsForLane(env, userId, row.machine_key, laneId);
  }
  return removed;
}

/**
 * Deletes every saved chat of an account and its key. Deleting the key is what
 * makes it final: anything a later retry missed can no longer be opened.
 */
export async function deleteAllAccountChats(env: Pick<CloudEnv, "DB" | "CLOUD_CHATS">, userId: string): Promise<number> {
  const bucket = bucketFor(env);
  // Saved chats, CLI and shell copies, fork capsules and lane backups: every object this account has in the bucket.
  let removed = 0;
  if (bucket) {
    for (const prefix of [`chats/${userId}/`, `sessions/${userId}/`, `capsules/${userId}/`, `backups/${userId}/`]) removed += await deleteObjectsUnder(bucket, prefix);
  }
  await env.DB.batch([
    env.DB.prepare("delete from cloud_chat_copies where user_id = ?").bind(userId),
    env.DB.prepare("delete from cloud_chat_messages where user_id = ?").bind(userId),
    env.DB.prepare("delete from cloud_session_copies where user_id = ?").bind(userId),
    env.DB.prepare("delete from cloud_git_summaries where user_id = ?").bind(userId),
    env.DB.prepare("delete from cloud_fork_capsules where user_id = ?").bind(userId),
    env.DB.prepare("delete from cloud_lane_backups where user_id = ?").bind(userId),
    env.DB.prepare("delete from cloud_user_keys where user_id = ?").bind(userId),
  ]);
  logCloud("cloud.chats_deleted_for_account", { userId, removed });
  return removed;
}

/** The saved-chat routes under `/cloud/chats`. The caller already passed the access gate. */
export async function routeSavedChats(request: Request, url: URL, path: string, env: CloudEnv, userId: string, now: number, waitUntil?: CloudWaitUntil): Promise<Response> {
  const segments = path.slice(CLOUD_PATHS.chats.length).split("/").filter(Boolean).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return "";
    }
  });
  if (segments.length === 0) {
    return request.method === "GET" ? handleList(url, env, userId, now) : notFound();
  }
  const [machineKey, second, third, fourth] = segments;
  if (!machineKey || !ROW_ID.test(machineKey) || segments.length > 4) return notFound();
  if (segments.length === 2 && second && ROW_ID.test(second)) {
    if (request.method === "GET") return handleGetChat(url, env, userId, machineKey, second, now);
    if (request.method === "DELETE") {
      if (!bucketFor(env)) return unavailable();
      return json({ deleted: await deleteSavedChat(env, userId, machineKey, second) });
    }
    return notFound();
  }
  if (segments.length === 3 && second && ROW_ID.test(second) && third === "move" && request.method === "POST") {
    return handleMove(request, env, userId, machineKey, second, now);
  }
  if (segments.length === 3 && second === "lanes" && third && ROW_ID.test(third) && request.method === "DELETE") {
    if (!bucketFor(env)) return unavailable();
    return json({ deleted: await deleteSavedChatsForLane(env, userId, machineKey, third) });
  }
  if (segments.length === 4 && second && ROW_ID.test(second) && third === "parts" && fourth && SEQ.test(fourth) && request.method === "PUT") {
    return handlePutPart(request, env, userId, machineKey, second, Number(fourth), now, waitUntil);
  }
  return notFound();
}
