import {
  CLOUD_CAPSULE_MAX_ACCOUNT_BYTES,
  CLOUD_CAPSULE_MAX_BYTES,
  CLOUD_CAPSULE_MAX_PART_BYTES,
  CLOUD_PATHS,
  type CloudCapsuleManifest,
} from "./contract";
import { ROW_ID, UNREADABLE_REQUEST_MESSAGE, fail, json, readJson } from "./http";
import { openBytes, sealBytes, userKeys } from "./seal";
import { callingComputer, segmentsAfter } from "./sessionCopies";
import { logCloud, type CloudEnv } from "./store";

/**
 * Fork capsules (README, "ADE without a computer"): what a provider needs to
 * resume a chat or CLI session on a new computer (its own transcript file or
 * export). The computer saves one at each rest save when the chat changed,
 * in parts of at most `CLOUD_CAPSULE_MAX_PART_BYTES`, then commits it. A new
 * computer reads it to continue the chat. Each part is sealed with the user's
 * key and names its place in the additional data, so a part moved to another
 * capsule or place does not open.
 *
 * One capsule per (machine, chat): part 1 again starts a new upload, which
 * replaces the older capsule only at its commit. Until then the new parts
 * go under their own prefix (`pending_r2_key`) and the committed capsule
 * reads as before, so an upload that fails or stops part way leaves it
 * readable. The commit switches the row to the new parts in one write, then
 * deletes the older ones. A capsule reads only once committed.
 */

/** The seal's own bytes on each part: the IV and the tag. */
const SEAL_OVERHEAD = 28;
const TRANSPORT_KINDS: ReadonlySet<string> = new Set(["claude-jsonl", "codex-rollout", "opencode-export", "droid-jsonl", "transcript"]);

const notFound = () => fail("not_found", "ADE Cloud has no saved copy of that session.", 404);
const unavailable = () => fail("unavailable", "Saved session copies aren't available right now. Try again soon.", 503);
const tooLarge = () => fail("capsule_too_large", `A saved session copy keeps at most ${CLOUD_CAPSULE_MAX_BYTES / (1024 * 1024)} MB.`, 413);
const partTooLarge = () => fail("capsule_too_large", `One part of a saved session copy is at most ${CLOUD_CAPSULE_MAX_PART_BYTES / (1024 * 1024)} MB.`, 413);
const accountFull = () => fail("account_full", "This account's saved session copies are full. Delete old cloud chats to save new ones.", 413);

type CapsuleRow = {
  user_id: string;
  machine_key: string;
  chat_id: string;
  instance_id: string | null;
  lane_id: string | null;
  provider: string | null;
  transport_kind: string | null;
  session_kind: string | null;
  parts: number;
  bytes: number;
  r2_key: string;
  committed_at: number | null;
  created_at: number;
  updated_at: number;
  /** The upload in progress: its parts' prefix, count and bytes; null when none runs. */
  pending_r2_key: string | null;
  pending_parts: number;
  pending_bytes: number;
  pending_instance_id: string | null;
};

const capsulePrefix = (userId: string, machineKey: string, chatId: string): string => `capsules/${userId}/${machineKey}/${chatId}/`;
/** One upload's own prefix, under the capsule's: a new upload never writes over the committed parts. */
const uploadPrefix = (userId: string, machineKey: string, chatId: string): string =>
  `${capsulePrefix(userId, machineKey, chatId)}u/${crypto.randomUUID().replace(/-/g, "")}/`;

/** Every object under `prefix`, page by page. */
async function deleteUnder(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length) await bucket.delete(keys);
    if (!listed.truncated) return;
    cursor = listed.cursor;
  }
}
const partKey = (prefix: string, part: number): string => `${prefix}part/${String(part).padStart(5, "0")}`;
const partAad = (userId: string, machineKey: string, chatId: string, part: number): string =>
  `ade.cloud.capsule.part.v1\0${userId}\0${machineKey}\0${chatId}\0${part}`;

async function readRow(env: CloudEnv, userId: string, machineKey: string, chatId: string): Promise<CapsuleRow | null> {
  return await env.DB.prepare("select * from cloud_fork_capsules where user_id = ? and machine_key = ? and chat_id = ?")
    .bind(userId, machineKey, chatId).first<CapsuleRow>();
}

async function accountBytes(env: CloudEnv, userId: string, except: { machineKey: string; chatId: string }): Promise<number> {
  const row = await env.DB.prepare("select coalesce(sum(bytes), 0) as total from cloud_fork_capsules where user_id = ? and not (machine_key = ? and chat_id = ?)")
    .bind(userId, except.machineKey, except.chatId).first<{ total: number }>();
  return row?.total ?? 0;
}

function manifestOf(row: CapsuleRow): CloudCapsuleManifest {
  return {
    machineKey: row.machine_key,
    chatId: row.chat_id,
    parts: row.parts,
    bytes: row.bytes,
    provider: row.provider ?? "",
    transportKind: row.transport_kind ?? "transcript",
    laneId: row.lane_id,
    sessionKind: row.session_kind === "cli" ? "cli" : "chat",
    createdAt: row.committed_at ?? row.created_at,
  };
}

async function handlePutPart(request: Request, env: CloudEnv, bucket: R2Bucket, userId: string, machineKey: string, chatId: string, part: number, now: number): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > CLOUD_CAPSULE_MAX_PART_BYTES) return partTooLarge();
  const computer = await callingComputer(env, request, userId, null);
  if (!computer) return fail("not_found", "ADE Cloud has no such computer.", 404);
  const plain = new Uint8Array(await request.arrayBuffer());
  if (plain.byteLength > CLOUD_CAPSULE_MAX_PART_BYTES) return partTooLarge();
  if (plain.byteLength === 0) return fail("bad_request", "That part is empty.", 400);
  let row = await readRow(env, userId, machineKey, chatId);
  // Part 1 starts a new upload under its own prefix; a later part needs the one before it.
  // The committed capsule stays as it is until this upload commits.
  if (part === 1) {
    const prefix = uploadPrefix(userId, machineKey, chatId);
    const abandoned = row?.pending_r2_key ?? null;
    await env.DB.prepare(`
      insert into cloud_fork_capsules (user_id, machine_key, chat_id, instance_id, parts, bytes, r2_key, committed_at, created_at, updated_at,
        pending_r2_key, pending_parts, pending_bytes, pending_instance_id)
      values (?, ?, ?, ?, 0, 0, ?, null, ?, ?, ?, 0, 0, ?)
      on conflict (user_id, machine_key, chat_id) do update set pending_r2_key = excluded.pending_r2_key, pending_parts = 0, pending_bytes = 0,
        pending_instance_id = excluded.pending_instance_id, updated_at = excluded.updated_at
    `).bind(userId, machineKey, chatId, computer.instance_id, prefix, now, now, prefix, computer.instance_id).run();
    // An earlier upload that never committed: its parts belong to nothing now.
    if (abandoned && (row?.committed_at == null || abandoned !== row.r2_key)) await deleteUnder(bucket, abandoned);
    row = await readRow(env, userId, machineKey, chatId);
  } else if (!row || !row.pending_r2_key || part > row.pending_parts + 1) {
    return fail("capsule_out_of_order", "Upload the parts of a saved session copy in order, from part 1.", 409);
  }
  if (!row?.pending_r2_key) return unavailable();
  const pending = row.pending_r2_key;
  const isNew = part > row.pending_parts;
  const bytesAfter = row.pending_bytes + (isNew ? plain.byteLength : 0);
  if (bytesAfter > CLOUD_CAPSULE_MAX_BYTES) return tooLarge();
  if ((await accountBytes(env, userId, { machineKey, chatId })) + bytesAfter > CLOUD_CAPSULE_MAX_ACCOUNT_BYTES) {
    logCloud("cloud.capsule_account_full", { userId, limitBytes: CLOUD_CAPSULE_MAX_ACCOUNT_BYTES });
    return accountFull();
  }
  const keys = await userKeys(env, userId, now);
  if (!keys) return unavailable();
  await bucket.put(partKey(pending, part), await sealBytes(keys.aes, partAad(userId, machineKey, chatId, part), plain));
  // Only this upload's count: a newer part 1 since then started another upload.
  await env.DB.prepare(`
    update cloud_fork_capsules set pending_parts = max(pending_parts, ?), pending_bytes = ?, updated_at = ?
    where user_id = ? and machine_key = ? and chat_id = ? and pending_r2_key = ?
  `).bind(part, bytesAfter, now, userId, machineKey, chatId, pending).run();
  return json({ ok: true, bytes: plain.byteLength });
}

async function handleCommit(request: Request, env: CloudEnv, bucket: R2Bucket, userId: string, machineKey: string, chatId: string, now: number): Promise<Response> {
  const body = await readJson(request);
  if (!body) return fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);
  const computer = await callingComputer(env, request, userId, body.instanceId);
  if (!computer) return fail("not_found", "ADE Cloud has no such computer.", 404);
  const parts = typeof body.parts === "number" && Number.isInteger(body.parts) && body.parts > 0 ? body.parts : null;
  const provider = typeof body.provider === "string" && /^[a-z][a-z0-9_-]{0,39}$/.test(body.provider) ? body.provider : null;
  const transportKind = typeof body.transportKind === "string" && TRANSPORT_KINDS.has(body.transportKind) ? body.transportKind : null;
  const laneId = typeof body.laneId === "string" && ROW_ID.test(body.laneId) ? body.laneId : null;
  const sessionKind = body.sessionKind === "cli" ? "cli" : body.sessionKind === "chat" ? "chat" : null;
  if (!parts || !provider || !transportKind || !sessionKind) return fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);
  const row = await readRow(env, userId, machineKey, chatId);
  if (!row) return notFound();
  // The same commit again: nothing uploads, and the committed capsule is its answer.
  if (!row.pending_r2_key) return row.committed_at != null ? json(manifestOf(row)) : notFound();
  const pending = row.pending_r2_key;
  if (parts !== row.pending_parts) return fail("capsule_incomplete", "Some parts of this saved session copy are missing. Upload it again from part 1.", 409);
  // The sizes in R2 are the truth, not the count the computer sent.
  let total = 0;
  for (let part = 1; part <= parts; part += 1) {
    const head = await bucket.head(partKey(pending, part));
    if (!head) return fail("capsule_incomplete", "Some parts of this saved session copy are missing. Upload it again from part 1.", 409);
    total += Math.max(0, head.size - SEAL_OVERHEAD);
  }
  if (total > CLOUD_CAPSULE_MAX_BYTES) return tooLarge();
  if ((await accountBytes(env, userId, { machineKey, chatId })) + total > CLOUD_CAPSULE_MAX_ACCOUNT_BYTES) return accountFull();
  // One write switches the capsule to the new parts; the older capsule read until here.
  const committed = await env.DB.prepare(`
    update cloud_fork_capsules set provider = ?, transport_kind = ?, lane_id = ?, session_kind = ?, bytes = ?, committed_at = ?, updated_at = ?,
      r2_key = pending_r2_key, parts = pending_parts, instance_id = coalesce(pending_instance_id, instance_id),
      pending_r2_key = null, pending_parts = 0, pending_bytes = 0, pending_instance_id = null
    where user_id = ? and machine_key = ? and chat_id = ? and pending_r2_key = ? and pending_parts = ?
  `).bind(provider, transportKind, laneId, sessionKind, total, now, now, userId, machineKey, chatId, pending, parts).run();
  if ((committed.meta?.changes ?? 0) !== 1) return fail("capsule_incomplete", "This saved session copy changed while it was committed. Upload it again from part 1.", 409);
  // The capsule it replaced: its parts go only now. Parts past the count are from an older, longer upload.
  if (row.r2_key !== pending) await deleteUnder(bucket, `${row.r2_key}part/`);
  const listed = await bucket.list({ prefix: `${pending}part/`, limit: 1000 });
  const stale = listed.objects.map((object) => object.key).filter((key) => Number(key.slice(key.lastIndexOf("/") + 1)) > parts);
  if (stale.length) await bucket.delete(stale);
  logCloud("cloud.capsule_committed", { userId, instanceId: computer.instance_id, parts, bytes: total, transportKind });
  return json(manifestOf((await readRow(env, userId, machineKey, chatId))!));
}

async function handleReadPart(env: CloudEnv, bucket: R2Bucket, userId: string, machineKey: string, chatId: string, part: number, now: number): Promise<Response> {
  const row = await readRow(env, userId, machineKey, chatId);
  if (!row || row.committed_at == null || part > row.parts) return notFound();
  const object = await bucket.get(partKey(row.r2_key, part));
  const keys = await userKeys(env, userId, now);
  if (!keys) return unavailable();
  const opened = object ? await openBytes(keys.aes, partAad(userId, machineKey, chatId, part), new Uint8Array(await object.arrayBuffer())) : null;
  if (!opened) {
    logCloud("cloud.capsule_part_unreadable", { userId, machineKey, part });
    return fail("capsule_unreadable", "This saved session copy can't be read right now.", 503);
  }
  return new Response(opened as Uint8Array<ArrayBuffer>, { status: 200, headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
}

/** Removes one capsule: its parts, any upload in progress, and its row. */
export async function deleteCapsule(env: CloudEnv, userId: string, machineKey: string, chatId: string): Promise<void> {
  const row = await readRow(env, userId, machineKey, chatId);
  if (!row) return;
  const bucket = env.CLOUD_CHATS;
  if (bucket) {
    // Every upload's prefix is under the capsule's own prefix.
    await deleteUnder(bucket, capsulePrefix(userId, machineKey, chatId));
  }
  await env.DB.prepare("delete from cloud_fork_capsules where user_id = ? and machine_key = ? and chat_id = ?").bind(userId, machineKey, chatId).run();
}

/** A lane's capsules on one machine go with the lane. Bounded: a lane has few chats. */
export async function deleteCapsulesForLane(env: CloudEnv, userId: string, machineKey: string, laneId: string): Promise<number> {
  // 200 at a time, until none are left.
  let removed = 0;
  for (;;) {
    const rows = (await env.DB.prepare("select chat_id from cloud_fork_capsules where user_id = ? and machine_key = ? and lane_id = ? limit 200")
      .bind(userId, machineKey, laneId).all<{ chat_id: string }>()).results ?? [];
    for (const row of rows) await deleteCapsule(env, userId, machineKey, row.chat_id);
    removed += rows.length;
    if (rows.length < 200) return removed;
  }
}

export function deleteAccountCapsulesStatement(env: Pick<CloudEnv, "DB">, userId: string): D1PreparedStatement {
  return env.DB.prepare("delete from cloud_fork_capsules where user_id = ?").bind(userId);
}

/** `/cloud/capsules/:machine/:chat[/commit | /parts/:n]`, and `DELETE /cloud/capsules/:machine/:chat`. The caller passed the access gate. */
export async function routeForkCapsules(request: Request, path: string, env: CloudEnv, userId: string, now: number): Promise<Response> {
  const bucket = env.CLOUD_CHATS;
  if (!bucket) {
    logCloud("cloud.capsule_bucket_missing", { userId });
    return unavailable();
  }
  const segments = segmentsAfter(path, CLOUD_PATHS.capsules);
  const [machineKey, chatId, action, partText] = segments;
  if (!machineKey || !chatId || !ROW_ID.test(machineKey) || !ROW_ID.test(chatId)) return notFound();
  if (segments.length === 2) {
    if (request.method === "DELETE") {
      // The caller's restore used it (a move that kept it, `keepCapsule`): it goes now.
      await deleteCapsule(env, userId, machineKey, chatId);
      return json({ deleted: true });
    }
    if (request.method !== "GET") return notFound();
    const row = await readRow(env, userId, machineKey, chatId);
    return row && row.committed_at != null ? json(manifestOf(row)) : notFound();
  }
  if (segments.length === 3 && action === "commit" && request.method === "POST") return handleCommit(request, env, bucket, userId, machineKey, chatId, now);
  if (segments.length === 4 && action === "parts" && partText && /^[1-9][0-9]{0,3}$/.test(partText)) {
    const part = Number(partText);
    if (request.method === "PUT") return handlePutPart(request, env, bucket, userId, machineKey, chatId, part, now);
    if (request.method === "GET") return handleReadPart(env, bucket, userId, machineKey, chatId, part, now);
  }
  return notFound();
}
