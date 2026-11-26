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
/** Past the account's open drafts or their bytes. */
function draftsFull(userId: string): Response {
  logCloud("cloud.launch_drafts_full", { userId, maxDrafts: CLOUD_LAUNCH_MAX_OPEN_DRAFTS, maxBytes: CLOUD_LAUNCH_MAX_DRAFT_BYTES_PER_ACCOUNT });
  return fail("uploads_full", "This account holds too many unsent files for today.", 429);
}

/** The account's open drafts' bytes, and room for `?` more under the cap: binds `userId, now, bytes`. */
const ROOM_FOR = `(select coalesce(sum(draft_bytes), 0) from cloud_launches where user_id = ? and state = 'draft' and expires_at > ?) + ? <= ${CLOUD_LAUNCH_MAX_DRAFT_BYTES_PER_ACCOUNT}`;

/**
 * `PUT /cloud/launches/:launch/files/:file`. An account holds at most
 * `CLOUD_LAUNCH_MAX_OPEN_DRAFTS` open drafts and
 * `CLOUD_LAUNCH_MAX_DRAFT_BYTES_PER_ACCOUNT` bytes in them. The upload
 * reserves its size before its body is read (an unknown length reserves a
 * whole file), in the same statement that checks the caps: a new draft's row
 * is made with its reservation, so a refused upload leaves no row, and
 * parallel uploads can't pass a cap between a check and a write. A file sent
 * again in its place reserves in full too; settling gives its old bytes back.
 */
export async function handlePutFile(request: Request, env: CloudEnv, userId: string, launchId: string, fileId: string, now: number): Promise<Response> {
  if (!UUID_PATTERN.test(launchId) || !FILE_ID.test(fileId)) return notFound();
  const bucket = env.CLOUD_CHATS;
  if (!bucket) return fail("unavailable", "ADE Cloud can't keep files right now. Start without them.", 503);
  const declared = Number(request.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > CLOUD_LAUNCH_MAX_FILE_BYTES) return fileTooBig();
  const reserve = Number.isFinite(declared) ? declared : CLOUD_LAUNCH_MAX_FILE_BYTES;
  // A draft row comes to exist with the first file, so the cron removes files a start never named.
  const created = await env.DB.prepare(`
    insert into cloud_launches (launch_id, user_id, state, created_at, updated_at, expires_at, draft_bytes)
    select ?, ?, 'draft', ?, ?, ?, ?
    where (select count(*) from cloud_launches where user_id = ? and state = 'draft' and expires_at > ?) < ? and ${ROOM_FOR}
    on conflict (launch_id) do nothing
  `).bind(launchId, userId, now, now, now + CLOUD_LAUNCH_DRAFT_TTL_MS, reserve, userId, now, CLOUD_LAUNCH_MAX_OPEN_DRAFTS, userId, now, reserve).run();
  if ((created.meta?.changes ?? 0) !== 1) {
    const row = await env.DB.prepare("select user_id, state from cloud_launches where launch_id = ?").bind(launchId).first<Pick<LaunchRow, "user_id" | "state">>();
    if (!row) return draftsFull(userId);
    if (row.user_id !== userId) return notFound();
    if (row.state !== "draft") return fail("launch_started", "This launch already started. Add files before you start it.", 409);
    const reserved = await env.DB.prepare(`
      update cloud_launches set draft_bytes = draft_bytes + ? where launch_id = ? and user_id = ? and state = 'draft' and ${ROOM_FOR}
    `).bind(reserve, launchId, userId, userId, now, reserve).run();
    if ((reserved.meta?.changes ?? 0) !== 1) return draftsFull(userId);
  }
  // The reservation settles to what the draft holds now: the new file less the one it replaced, or nothing.
  let replaced = 0;
  let stored: number | null = null;
  try {
    const listed = await bucket.list({ prefix: r2PrefixOf(userId, launchId), limit: CLOUD_LAUNCH_MAX_FILES + 1 });
    const key = r2KeyOf(userId, launchId, fileId);
    replaced = listed.objects.find((object) => object.key === key)?.size ?? 0;
    if (listed.objects.length >= CLOUD_LAUNCH_MAX_FILES && !listed.objects.some((object) => object.key === key)) {
      return fail("too_many_files", `A launch takes at most ${CLOUD_LAUNCH_MAX_FILES} files.`, 413);
    }
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
