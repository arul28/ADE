import {
  CLOUD_CHAT_MAX_ACCOUNT_BYTES,
  CLOUD_CHAT_MAX_PAGE_PARTS,
  CLOUD_CHAT_MAX_PART_BYTES,
  type CloudChatPartResponse,
  type CloudChatRow,
  type CloudChatRowInput,
  CLOUD_PATHS,
  type CloudChatTranscriptPage,
} from "./contract";
import { UNREADABLE_REQUEST_MESSAGE, fail, json } from "./http";
import { rewardAfterCloudChat } from "./referrals";
import { logCloud, ownedComputer, type CloudEnv } from "./store";

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

/** A chat, machine or lane id in a path. */
const ROW_ID = /^[A-Za-z0-9._:-]{1,160}$/;
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

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function masterKey(env: CloudEnv): Promise<CryptoKey | null> {
  const raw = env.CLOUD_CHAT_MASTER_KEY?.trim();
  if (!raw) return null;
  // Exactly 32 bytes, base64: a weak or misshapen secret must be loud, as in the vault.
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(raw);
  } catch {
    return null;
  }
  if (bytes.length !== 32) return null;
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** `v1.<iv>.<ciphertext+tag>`, both base64. */
async function sealText(key: CryptoKey, aad: string, value: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    value as Uint8Array<ArrayBuffer>,
  );
  return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(sealed))}`;
}

async function openText(key: CryptoKey, aad: string, stored: string): Promise<Uint8Array | null> {
  const parts = stored.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  try {
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(parts[1]!), additionalData: encoder.encode(aad) },
      key,
      fromBase64(parts[2]!),
    );
    return new Uint8Array(opened);
  } catch {
    return null;
  }
}

/** `iv || ciphertext+tag`. */
async function sealBytes(key: CryptoKey, aad: string, value: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    value as Uint8Array<ArrayBuffer>,
  ));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv, 0);
  out.set(sealed, iv.length);
  return out;
}

async function openBytes(key: CryptoKey, aad: string, stored: Uint8Array): Promise<Uint8Array | null> {
  if (stored.length <= 12) return null;
  try {
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: stored.slice(0, 12), additionalData: encoder.encode(aad) },
      key,
      stored.slice(12),
    );
    return new Uint8Array(opened);
  } catch {
    return null;
  }
}

type UserKeys = { aes: CryptoKey; mac: CryptoKey };

const userKeyAad = (userId: string): string => `ade.cloud.chat.user-key.v1\0${userId}`;

/** This user's key, made on first use. Null when `CLOUD_CHAT_MASTER_KEY` is missing or wrong. */
async function userKeys(env: CloudEnv, userId: string, now: number): Promise<UserKeys | null> {
  const master = await masterKey(env);
  if (!master) {
    logCloud("cloud.chat_key_unavailable", { userId });
    return null;
  }
  const read = () => env.DB.prepare("select sealed_key from cloud_user_keys where user_id = ?").bind(userId).first<{ sealed_key: string }>();
  let row = await read();
  if (!row) {
    // Insert first, then read back: two first writes race and both must use the winner.
    const fresh = crypto.getRandomValues(new Uint8Array(32));
    const sealed = await sealText(master, userKeyAad(userId), fresh);
    await env.DB.prepare("insert or ignore into cloud_user_keys (user_id, sealed_key, created_at) values (?, ?, ?)").bind(userId, sealed, now).run();
    row = await read();
    if (!row) return null;
  }
  const raw = await openText(master, userKeyAad(userId), row.sealed_key);
  if (!raw || raw.length !== 32) {
    // A rotated or wrong master key: report it rather than treat the chats as gone.
    logCloud("cloud.chat_key_unreadable", { userId });
    return null;
  }
  // Separate keys for sealing and for the part digest, from the one stored secret.
  const macMaterial = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([...encoder.encode("ade.cloud.chat.mac.v1\0"), ...raw])));
  const [aes, mac] = await Promise.all([
    crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
    crypto.subtle.importKey("raw", macMaterial, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
  ]);
  return { aes, mac };
}

const partAad = (userId: string, machineKey: string, chatId: string, seq: number): string =>
  `ade.cloud.chat.part.v1\0${userId}\0${machineKey}\0${chatId}\0${seq}`;
const summaryAad = (userId: string, machineKey: string, chatId: string): string =>
  `ade.cloud.chat.summary.v1\0${userId}\0${machineKey}\0${chatId}`;

/** Every object of one chat sits under this prefix (`cloud_chat_copies.r2_key`). */
const chatPrefix = (userId: string, machineKey: string, chatId: string): string => `chats/${userId}/${machineKey}/${chatId}/`;
const partKey = (prefix: string, seq: number): string => `${prefix}${String(seq).padStart(10, "0")}`;

type CopyRow = {
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
};

function bucketFor(env: Pick<CloudEnv, "CLOUD_CHATS">): R2Bucket | null {
  return env.CLOUD_CHATS ?? null;
}

async function copyRow(env: CloudEnv, userId: string, machineKey: string, chatId: string): Promise<CopyRow | null> {
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

async function digestFor(keys: UserKeys, value: Uint8Array): Promise<string> {
  return toBase64(new Uint8Array(await crypto.subtle.sign("HMAC", keys.mac, value as Uint8Array<ArrayBuffer>)));
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
async function handlePutPart(request: Request, env: CloudEnv, userId: string, machineKey: string, chatId: string, seq: number, now: number): Promise<Response> {
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
  const lastSeq = existing?.last_seq ?? 0;
  const prefix = chatPrefix(userId, machineKey, chatId);
  const key = partKey(prefix, seq);
  const digest = await digestFor(keys, plain);
  let replacedSize = 0;
  if (seq <= lastSeq) {
    const stored = await bucket.head(key);
    if (stored?.customMetadata?.digest === digest) {
      // The same part again: nothing to write. Its answer is what the computer missed.
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

  const sealed = await sealBytes(keys.aes, partAad(userId, machineKey, chatId, seq), plain);
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
  const summary = await sealText(keys.aes, summaryAad(userId, machineKey, chatId), encoder.encode(JSON.stringify({
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
    insert into cloud_chat_copies (user_id, machine_key, chat_id, instance_id, project_key, lane_id, summary_sealed, r2_key, last_activity_at, last_seq, bytes, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict (user_id, machine_key, chat_id) do update set
      instance_id = excluded.instance_id,
      project_key = coalesce(excluded.project_key, project_key),
      lane_id = coalesce(excluded.lane_id, lane_id),
      summary_sealed = excluded.summary_sealed,
      last_activity_at = coalesce(excluded.last_activity_at, last_activity_at),
      last_seq = max(last_seq, excluded.last_seq),
      bytes = max(0, bytes + ?),
      updated_at = excluded.updated_at
  `).bind(
    userId, machineKey, chatId, instanceId, row.projectKey, row.laneId, summary, prefix, lastActivityMs, row.lastSeq, sealed.byteLength, now,
    delta,
  ).run();
  // A chat's first saved part is the server's proof a chat ran on an ADE Cloud computer:
  // an invited friend's first one pays the referral (`referrals.ts`). Never fails the save.
  if (!existing) await rewardAfterCloudChat(env, userId, now);
  return json({ ok: true, lastSeq: row.lastSeq } satisfies CloudChatPartResponse);
}

function rowToJson(row: CopyRow, summary: Record<string, unknown> | null): CloudChatRow {
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
  };
}

async function openSummary(keys: UserKeys, row: CopyRow): Promise<Record<string, unknown> | null> {
  if (!row.summary_sealed) return null;
  const opened = await openText(keys.aes, summaryAad(row.user_id, row.machine_key, row.chat_id), row.summary_sealed);
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

/** `GET /cloud/chats?machine&project&limit&cursor`: newest activity first. */
async function handleList(url: URL, env: CloudEnv, userId: string, now: number): Promise<Response> {
  const machine = url.searchParams.get("machine")?.trim() || null;
  if (machine && !ROW_ID.test(machine)) return json({ chats: [], nextCursor: null });
  const project = url.searchParams.get("project")?.trim() || null;
  const limit = clampedInt(url.searchParams.get("limit"), DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  // `updatedAt:chatId` of the last row of the previous page.
  const cursor = url.searchParams.get("cursor")?.match(/^(\d+):(.+)$/) ?? null;
  const keys = await userKeys(env, userId, now);
  if (!keys) return unavailable();
  const where = ["user_id = ?"];
  const binds: Array<string | number> = [userId];
  if (machine) {
    where.push("machine_key = ?");
    binds.push(machine);
  }
  if (project) {
    where.push("project_key = ?");
    binds.push(project);
  }
  if (cursor) {
    where.push("(updated_at < ? or (updated_at = ? and chat_id < ?))");
    binds.push(Number(cursor[1]), Number(cursor[1]), cursor[2]!);
  }
  const rows = await env.DB.prepare(`select * from cloud_chat_copies where ${where.join(" and ")} order by updated_at desc, chat_id desc limit ?`)
    .bind(...binds, limit + 1).all<CopyRow>();
  const results = rows.results ?? [];
  const page = results.slice(0, limit);
  const chats: CloudChatRow[] = [];
  for (const row of page) chats.push(rowToJson(row, await openSummary(keys, row)));
  const last = page[page.length - 1];
  return json({ chats, nextCursor: results.length > limit && last ? `${last.updated_at}:${last.chat_id}` : null });
}

/**
 * `GET /cloud/chats/:machine/:chat?before&limit`. Newest parts first, each one
 * JSON lines of chat events. `before` is exclusive; `limit` is a page of parts.
 */
async function handleGetChat(url: URL, env: CloudEnv, userId: string, machineKey: string, chatId: string, now: number): Promise<Response> {
  const bucket = bucketFor(env);
  if (!bucket) return unavailable();
  // The owner check, on every read: the row is looked up under the caller's account.
  const row = await copyRow(env, userId, machineKey, chatId);
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
    const opened = await openBytes(keys.aes, partAad(userId, machineKey, chatId, seq), new Uint8Array(await object.arrayBuffer()));
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

/** Deletes one saved chat. A chat the account doesn't have is already deleted. */
export async function deleteSavedChat(env: CloudEnv, userId: string, machineKey: string, chatId: string): Promise<boolean> {
  const bucket = bucketFor(env);
  if (!bucket) throw new Error("cloud_chats_bucket_missing");
  const row = await copyRow(env, userId, machineKey, chatId);
  if (!row) return false;
  await deleteObjectsUnder(bucket, row.r2_key);
  await env.DB.prepare("delete from cloud_chat_copies where user_id = ? and machine_key = ? and chat_id = ?").bind(userId, machineKey, chatId).run();
  logCloud("cloud.chat_deleted", { userId, machineKey, chatId });
  return true;
}

/** Deletes a lane's saved chats on one computer. A computer's chats survive the computer; a lane's don't survive the lane. */
export async function deleteSavedChatsForLane(env: CloudEnv, userId: string, machineKey: string, laneId: string): Promise<number> {
  const rows = await env.DB.prepare("select chat_id from cloud_chat_copies where user_id = ? and machine_key = ? and lane_id = ?")
    .bind(userId, machineKey, laneId).all<{ chat_id: string }>();
  let removed = 0;
  for (const row of rows.results ?? []) {
    if (await deleteSavedChat(env, userId, machineKey, row.chat_id)) removed += 1;
  }
  return removed;
}

/**
 * Deletes every saved chat of an account and its key. Deleting the key is what
 * makes it final: anything a later retry missed can no longer be opened.
 */
export async function deleteAllAccountChats(env: Pick<CloudEnv, "DB" | "CLOUD_CHATS">, userId: string): Promise<number> {
  const bucket = bucketFor(env);
  const removed = bucket ? await deleteObjectsUnder(bucket, `chats/${userId}/`) : 0;
  await env.DB.batch([
    env.DB.prepare("delete from cloud_chat_copies where user_id = ?").bind(userId),
    env.DB.prepare("delete from cloud_user_keys where user_id = ?").bind(userId),
  ]);
  logCloud("cloud.chats_deleted_for_account", { userId, removed });
  return removed;
}

/** The saved-chat routes under `/cloud/chats`. The caller already passed the access gate. */
export async function routeSavedChats(request: Request, url: URL, path: string, env: CloudEnv, userId: string, now: number): Promise<Response> {
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
  if (segments.length === 3 && second === "lanes" && third && ROW_ID.test(third) && request.method === "DELETE") {
    if (!bucketFor(env)) return unavailable();
    return json({ deleted: await deleteSavedChatsForLane(env, userId, machineKey, third) });
  }
  if (segments.length === 4 && second && ROW_ID.test(second) && third === "parts" && fourth && SEQ.test(fourth) && request.method === "PUT") {
    return handlePutPart(request, env, userId, machineKey, second, Number(fourth), now);
  }
  return notFound();
}
