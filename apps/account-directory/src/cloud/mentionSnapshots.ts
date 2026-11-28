import {
  CLOUD_MENTION_SNAPSHOT_MAX_BYTES,
  readCloudMentionSnapshot,
  type CloudMentionSnapshot,
} from "../../../desktop/src/shared/cloudMentionSnapshot";
import { CLOUD_PATHS } from "./contract";
import { ROW_ID, UNREADABLE_REQUEST_MESSAGE, fail, json } from "./http";
import { openText, sealText, userKeys } from "./seal";
import { callingComputer, readCappedJson, segmentsAfter } from "./sessionCopies";
import { logCloud, type CloudEnv } from "./store";

/**
 * The `@` menu an ADE Cloud computer saves when it rests
 * (`cloudMentionSnapshot.ts`), so a chat's menu reads the same while the
 * computer sleeps (README, "The @ menu while a computer rests").
 *
 *   PUT /cloud/mentions/:machine   {instanceId, projectKey, snapshot}   the computer itself
 *   GET /cloud/mentions/:machine?project=&lane=&since=                  any of the person's clients
 *
 * One copy per (computer, project). Names and file paths are the person's:
 * the copy is gzipped, then sealed with the account's key. An older save
 * (by the computer's `savedAt`) never replaces a newer one. A read with
 * `since` equal to the saved time answers `{ unchanged: true }`, so a client
 * downloads the copy once per sleep; `lane` keeps only that lane's files.
 */

const BODY_OVERHEAD_BYTES = 16 * 1024;
const MAX_PROJECT_KEY = 300;

const notFound = () => fail("not_found", "ADE Cloud has no saved menu for that computer.", 404);
const unavailable = () => fail("unavailable", "Saved menus aren't available right now. Try again soon.", 503);

const snapshotAad = (userId: string, machineKey: string, projectKey: string): string =>
  `ade.cloud.mentions.v1\0${userId}\0${machineKey}\0${projectKey}`;

type SnapshotRow = { sealed: string; saved_at: number };

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

const projectKeyOf = (value: unknown): string | null =>
  typeof value === "string" && value.trim() && value.trim().length <= MAX_PROJECT_KEY ? value.trim() : null;

async function handlePut(request: Request, env: CloudEnv, userId: string, machineKey: string, now: number): Promise<Response> {
  const body = await readCappedJson(request, CLOUD_MENTION_SNAPSHOT_MAX_BYTES + BODY_OVERHEAD_BYTES);
  if (!body.ok) {
    return body.tooLarge ? fail("snapshot_too_large", "That menu is too large to save.", 413) : fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);
  }
  const computer = await callingComputer(env, request, userId, body.value.instanceId);
  // Only the computer itself saves its menu, under its own key.
  if (!computer || computer.machine_key?.toLowerCase() !== machineKey.toLowerCase()) return fail("not_found", "ADE Cloud has no such computer.", 404);
  const projectKey = projectKeyOf(body.value.projectKey);
  const snapshot = readCloudMentionSnapshot(body.value.snapshot);
  if (!projectKey || !snapshot) return fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);
  const keys = await userKeys(env, userId, now);
  if (!keys) return unavailable();
  const sealed = await sealText(keys.aes, snapshotAad(userId, machineKey, projectKey), await gzip(new TextEncoder().encode(JSON.stringify(snapshot))));
  const written = await env.DB.prepare(`
    insert into cloud_mention_snapshots (user_id, machine_key, project_key, instance_id, sealed, saved_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?)
    on conflict (user_id, machine_key, project_key) do update set
      instance_id = excluded.instance_id, sealed = excluded.sealed, saved_at = excluded.saved_at, updated_at = excluded.updated_at
    where excluded.saved_at >= cloud_mention_snapshots.saved_at
  `).bind(userId, machineKey, projectKey, computer.instance_id, sealed, snapshot.savedAt, now).run();
  return json({ ok: true, kept: (written.meta?.changes ?? 0) === 0 });
}

async function handleGet(url: URL, env: CloudEnv, userId: string, machineKey: string, now: number): Promise<Response> {
  const projectKey = projectKeyOf(url.searchParams.get("project"));
  if (!projectKey) return notFound();
  const row = await env.DB.prepare("select sealed, saved_at from cloud_mention_snapshots where user_id = ? and machine_key = ? and project_key = ?")
    .bind(userId, machineKey, projectKey).first<SnapshotRow>();
  if (!row) return notFound();
  const since = Number(url.searchParams.get("since"));
  if (Number.isFinite(since) && since === row.saved_at) return json({ unchanged: true, savedAt: row.saved_at });
  const keys = await userKeys(env, userId, now);
  if (!keys) return unavailable();
  const opened = await openText(keys.aes, snapshotAad(userId, machineKey, projectKey), row.sealed);
  const unzipped = opened ? await gunzip(opened) : null;
  let snapshot: CloudMentionSnapshot | null = null;
  try {
    snapshot = unzipped ? readCloudMentionSnapshot(JSON.parse(new TextDecoder().decode(unzipped))) : null;
  } catch {
    snapshot = null;
  }
  if (!snapshot) {
    logCloud("cloud.mention_snapshot_unreadable", { userId, machineKey });
    return fail("snapshot_unreadable", "This saved menu can't be read right now.", 503);
  }
  const laneId = url.searchParams.get("lane")?.trim();
  if (laneId) snapshot = { ...snapshot, files: snapshot.files[laneId] ? { [laneId]: snapshot.files[laneId]! } : {} };
  return json({ snapshot });
}

/** The saved menus of one computer go with its lane (a cloud computer holds one lane). */
export function deleteMentionSnapshotsForMachineStatement(env: Pick<CloudEnv, "DB">, userId: string, machineKey: string): D1PreparedStatement {
  return env.DB.prepare("delete from cloud_mention_snapshots where user_id = ? and machine_key = ?").bind(userId, machineKey);
}

/** `/cloud/mentions/:machine`. The caller passed the access gate. */
export async function routeMentionSnapshots(request: Request, url: URL, path: string, env: CloudEnv, userId: string, now: number): Promise<Response> {
  const segments = segmentsAfter(path, CLOUD_PATHS.mentions);
  const [machineKey] = segments;
  if (segments.length !== 1 || !machineKey || !ROW_ID.test(machineKey)) return notFound();
  if (request.method === "PUT") return handlePut(request, env, userId, machineKey, now);
  if (request.method === "GET") return handleGet(url, env, userId, machineKey, now);
  return notFound();
}
