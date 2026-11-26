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

const notFound = () => fail("not_found", "ADE Cloud has no such launch.", 404);
const fileTooBig = () => fail("file_too_big", "Each file can be at most 25 MB.", 413);
const draftsFull = () => fail("uploads_full", "This account holds too many unsent files for today.", 429);

/**
 * `PUT /cloud/launches/:launch/files/:file`. An account holds at most
 * `CLOUD_LAUNCH_MAX_OPEN_DRAFTS` open drafts and
 * `CLOUD_LAUNCH_MAX_DRAFT_BYTES_PER_ACCOUNT` bytes in them: the draft row is
 * made only under the first cap, and the upload reserves its size under the
 * second before its body is read (an unknown length reserves a whole file),
 * so parallel uploads can't pass the cap between a check and a write.
 */
export async function handlePutFile(request: Request, env: CloudEnv, userId: string, launchId: string, fileId: string, now: number): Promise<Response> {
  if (!UUID_PATTERN.test(launchId) || !FILE_ID.test(fileId)) return notFound();
  const bucket = env.CLOUD_CHATS;
  if (!bucket) return fail("unavailable", "ADE Cloud can't keep files right now. Start without them.", 503);
  const declared = Number(request.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > CLOUD_LAUNCH_MAX_FILE_BYTES) return fileTooBig();
  // A draft row comes to exist with the first file, so the cron removes files a start never named.
  await env.DB.prepare(`
    insert into cloud_launches (launch_id, user_id, state, created_at, updated_at, expires_at)
    select ?, ?, 'draft', ?, ?, ?
    where (select count(*) from cloud_launches where user_id = ? and state = 'draft' and expires_at > ?) < ?
    on conflict (launch_id) do nothing
  `).bind(launchId, userId, now, now, now + CLOUD_LAUNCH_DRAFT_TTL_MS, userId, now, CLOUD_LAUNCH_MAX_OPEN_DRAFTS).run();
  const row = await env.DB.prepare("select user_id, state from cloud_launches where launch_id = ?").bind(launchId).first<Pick<LaunchRow, "user_id" | "state">>();
  if (!row) {
    logCloud("cloud.launch_drafts_full", { userId, limit: CLOUD_LAUNCH_MAX_OPEN_DRAFTS });
    return draftsFull();
  }
  if (row.user_id !== userId) return notFound();
  if (row.state !== "draft") return fail("launch_started", "This launch already started. Add files before you start it.", 409);
  const prefix = r2PrefixOf(userId, launchId);
  const listed = await bucket.list({ prefix, limit: CLOUD_LAUNCH_MAX_FILES + 1 });
  const key = r2KeyOf(userId, launchId, fileId);
  if (listed.objects.length >= CLOUD_LAUNCH_MAX_FILES && !listed.objects.some((object) => object.key === key)) {
    return fail("too_many_files", `A launch takes at most ${CLOUD_LAUNCH_MAX_FILES} files.`, 413);
  }
  // The same file id again replaces its file, so its old bytes make room for the new ones.
  const replaced = listed.objects.find((object) => object.key === key)?.size ?? 0;
  const reserve = Number.isFinite(declared) ? declared : CLOUD_LAUNCH_MAX_FILE_BYTES;
  const reserved = await env.DB.prepare(`
    update cloud_launches set draft_bytes = draft_bytes + ?
    where launch_id = ? and state = 'draft'
      and (select coalesce(sum(draft_bytes), 0) from cloud_launches where user_id = ? and state = 'draft' and expires_at > ?) - ? + ? <= ?
  `).bind(reserve, launchId, userId, now, replaced, reserve, CLOUD_LAUNCH_MAX_DRAFT_BYTES_PER_ACCOUNT).run();
  if ((reserved.meta?.changes ?? 0) !== 1) {
    logCloud("cloud.launch_draft_bytes_full", { userId, limitBytes: CLOUD_LAUNCH_MAX_DRAFT_BYTES_PER_ACCOUNT });
    return draftsFull();
  }
  // The reservation settles to what the draft holds now: the new file less the one it replaced, or nothing.
  let stored: number | null = null;
  try {
    const read = await readBoundedBytes(request, reserve);
    if (!read.ok) return fileTooBig();
    const contentType = shortString(request.headers.get("content-type"), 120) ?? "application/octet-stream";
    await bucket.put(key, read.bytes, { httpMetadata: { contentType } });
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
