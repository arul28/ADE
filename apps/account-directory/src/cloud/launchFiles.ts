import {
  CLOUD_LAUNCH_DRAFT_TTL_MS,
  CLOUD_LAUNCH_MAX_DRAFT_BYTES_PER_ACCOUNT,
  CLOUD_LAUNCH_MAX_FILE_BYTES,
  CLOUD_LAUNCH_MAX_FILES,
  CLOUD_LAUNCH_MAX_OPEN_DRAFTS,
  type CloudServerLaunchRequest,
} from "./contract";
import { UUID_PATTERN, fail, json, shortString } from "./http";
import type { LaunchRow } from "./launches";
import { logCloud, parseJsonColumn, type CloudEnv } from "./store";
import { readBoundedBytes } from "../sinkUtils";

/**
 * A launch's files in R2 (`launches/<user>/<launch>/<file>`): uploaded to a
 * draft before the start or a queued message names them, read by the
 * computer that runs it. The minute cron removes them with their launch row.
 */

export const FILE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const r2KeyOf = (userId: string, launchId: string, fileId: string) => `launches/${userId}/${launchId}/${fileId}`;
export const r2PrefixOf = (userId: string, launchId: string) => `launches/${userId}/${launchId}/`;

const notFound = () => fail("not_found", "Daex Cloud has no such launch.", 404);
const fileTooBig = () => fail("file_too_big", "Each file can be at most 25 MB.", 413);

/** Room under the account's draft bytes for `?` more: binds `userId, now, bytes`. */
const ROOM_FOR = `(select coalesce(sum(draft_bytes), 0) from cloud_launches where user_id = ? and state = 'draft' and expires_at > ?) + ? <= ${CLOUD_LAUNCH_MAX_DRAFT_BYTES_PER_ACCOUNT}`;

/** Past the account's open drafts or their bytes. */
export function draftsFull(userId: string): Response {
  logCloud("cloud.launch_drafts_full", { userId, maxDrafts: CLOUD_LAUNCH_MAX_OPEN_DRAFTS, maxBytes: CLOUD_LAUNCH_MAX_DRAFT_BYTES_PER_ACCOUNT });
  return fail("uploads_full", "This account holds too many unsent files for today.", 429);
}

/**
 * Makes `launchId` a new draft of the account that holds `bytes`, in one
 * write that checks both caps (`CLOUD_LAUNCH_MAX_OPEN_DRAFTS`,
 * `CLOUD_LAUNCH_MAX_DRAFT_BYTES_PER_ACCOUNT`), so parallel writes can't pass
 * one. False when the id is taken or a cap refuses; a refusal leaves no row.
 * The row exists from the first file on, so the cron removes files a start
 * never named.
 */
export async function insertDraft(env: CloudEnv, userId: string, launchId: string, bytes: number, now: number): Promise<boolean> {
  const created = await env.DB.prepare(`
    insert into cloud_launches (launch_id, user_id, state, created_at, updated_at, expires_at, draft_bytes)
    select ?, ?, 'draft', ?, ?, ?, ?
    where (select count(*) from cloud_launches where user_id = ? and state = 'draft' and expires_at > ?) < ? and ${ROOM_FOR}
    on conflict (launch_id) do nothing
  `).bind(launchId, userId, now, now, now + CLOUD_LAUNCH_DRAFT_TTL_MS, bytes, userId, now, CLOUD_LAUNCH_MAX_OPEN_DRAFTS, userId, now, bytes).run();
  return (created.meta?.changes ?? 0) === 1;
}

/**
 * `PUT /cloud/launches/:launch/files/:file`. The upload reserves its size
 * before its body is read (an unknown length reserves a whole file): a new
 * draft with its row (`insertDraft`), an open one under the same byte cap. A
 * file sent again in its place reserves in full too; settling gives its old
 * bytes back, and only the one write that replaced that file does.
 */
export async function handlePutFile(request: Request, env: CloudEnv, userId: string, launchId: string, fileId: string, now: number): Promise<Response> {
  if (!UUID_PATTERN.test(launchId) || !FILE_ID.test(fileId)) return notFound();
  const bucket = env.CLOUD_CHATS;
  if (!bucket) return fail("unavailable", "Daex Cloud can't keep files right now. Start without them.", 503);
  const declared = Number(request.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > CLOUD_LAUNCH_MAX_FILE_BYTES) return fileTooBig();
  const reserve = Number.isFinite(declared) ? declared : CLOUD_LAUNCH_MAX_FILE_BYTES;
  if (!await insertDraft(env, userId, launchId, reserve, now)) {
    const row = await env.DB.prepare("select user_id, state, expires_at from cloud_launches where launch_id = ?").bind(launchId)
      .first<Pick<LaunchRow, "user_id" | "state" | "expires_at">>();
    if (!row) return draftsFull(userId);
    if (row.user_id !== userId) return notFound();
    if (row.state !== "draft") return fail("launch_started", "This launch already started. Add files before you start it.", 409);
    // Its sum leaves an expired draft out, so it takes nothing more until the cron removes it.
    if (row.expires_at <= now) return fail("files_expired", "These files expired. Send them again.", 410);
    const reserved = await env.DB.prepare(`
      update cloud_launches set draft_bytes = draft_bytes + ? where launch_id = ? and user_id = ? and state = 'draft' and expires_at > ? and ${ROOM_FOR}
    `).bind(reserve, launchId, userId, now, userId, now, reserve).run();
    if ((reserved.meta?.changes ?? 0) !== 1) return draftsFull(userId);
  }
  // The reservation settles to what the draft holds now: the new file less the one it replaced, or nothing.
  let replaced = 0;
  let stored: number | null = null;
  try {
    const listed = await bucket.list({ prefix: r2PrefixOf(userId, launchId), limit: CLOUD_LAUNCH_MAX_FILES + 1 });
    const key = r2KeyOf(userId, launchId, fileId);
    const previous = listed.objects.find((object) => object.key === key);
    if (listed.objects.length >= CLOUD_LAUNCH_MAX_FILES && !previous) {
      return fail("too_many_files", `A launch takes at most ${CLOUD_LAUNCH_MAX_FILES} files.`, 413);
    }
    const read = await readBoundedBytes(request, reserve);
    if (!read.ok) return fileTooBig();
    const contentType = shortString(request.headers.get("content-type"), 120) ?? "application/octet-stream";
    // A replacement writes only over the file it read, so two at once can't both give its bytes back.
    const put = await bucket.put(key, read.bytes, { httpMetadata: { contentType }, ...(previous ? { onlyIf: { etagMatches: previous.etag } } : {}) });
    if (!put) return fail("file_changed", "This file was sent again at the same time. Send it once more.", 409);
    replaced = previous?.size ?? 0;
    stored = read.bytes.byteLength;
    return json({ fileId, sizeBytes: stored }, 201);
  } finally {
    const delta = stored == null ? -reserve : stored - replaced - reserve;
    await env.DB.prepare("update cloud_launches set draft_bytes = max(0, draft_bytes + ?) where launch_id = ?").bind(delta, launchId).run();
  }
}

export async function handleGetFile(env: CloudEnv, row: LaunchRow, fileId: string): Promise<Response> {
  if (!FILE_ID.test(fileId)) return notFound();
  const request = parseJsonColumn<CloudServerLaunchRequest | null>(row.request_json, null, { launchId: row.launch_id, column: "request_json" });
  // A started launch serves the files its first message names. A draft serves
  // any of its files to its owner: a queued chat message names its files there.
  const named = row.state === "draft" || request?.chat?.attachments?.some((file) => file.fileId === fileId);
  const object = named && env.CLOUD_CHATS ? await env.CLOUD_CHATS.get(r2KeyOf(row.user_id, row.launch_id, fileId)) : null;
  if (!object) return notFound();
  return new Response(object.body, {
    status: 200,
    headers: { "content-type": object.httpMetadata?.contentType ?? "application/octet-stream", "cache-control": "no-store" },
  });
}
