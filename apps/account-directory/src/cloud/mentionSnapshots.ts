import {
  CLOUD_MENTION_SNAPSHOT_MAX_BYTES,
  readCloudMentionSnapshot,
  type CloudMentionSnapshot,
} from "../../../desktop/src/shared/cloudMentionSnapshot";
import { CLOUD_PATHS } from "./contract";
import { ROW_ID, UNREADABLE_REQUEST_MESSAGE, fail, json } from "./http";
import { openText, sealText, userKeys } from "./seal";
import { callingComputer, readCappedJson, segmentsAfter } from "./sessionCopies";
import { logCloud, reportCloudFailure, type CloudEnv } from "./store";

/**
 * The `@` menu an ADE Cloud computer saves when it rests
 * (`cloudMentionSnapshot.ts`), so a chat's menu reads the same while the
 * computer sleeps (README, "The @ menu while a computer rests").
 *
 *   PUT /cloud/mentions/:machine   {instanceId, projectKey, snapshot, partial?}   the computer itself
 *   GET /cloud/mentions/:machine?project=&lane=&since=                  any of the person's clients
 *
 * One copy per (computer, project). Names and file paths are the person's:
 * the copy is gzipped, then sealed with the account's key. A save replaces
 * the copy only when its `savedAt` (the computer's clock) is strictly newer,
 * so a client holding one saved time never misses a change. A `partial`
 * copy (a roster the computer failed to read) is saved only where no copy
 * is yet. A saved time more than
 * `MAX_CLOCK_AHEAD_MS` past the server's clock is refused, so no save can
 * hold off the computer's later ones for long. Only the computer writes: a
 * browser (`Origin`) is refused. The computer's key matches in any case
 * (the column is `collate nocase`); the copy is sealed under the key as
 * stored. A read with
 * `since` equal to the saved time answers `{ unchanged: true }`, so a client
 * downloads the copy once per sleep; `lane` keeps only that lane's files.
 * A computer keeps its newest `MAX_PROJECTS_PER_COMPUTER` copies. A deleted
 * saved chat leaves the copies that list it, and a deleted computer (lane not
 * kept) takes its copies with it.
 */

const BODY_OVERHEAD_BYTES = 16 * 1024;
const MAX_PROJECT_KEY = 300;
/** Copies one computer keeps, newest first: a lane computer opens one project. */
const MAX_PROJECTS_PER_COMPUTER = 8;
/** How far past the server's clock a saved time may be: a save from later than that is refused. */
const MAX_CLOCK_AHEAD_MS = 10 * 60_000;

const notFound = () => fail("not_found", "ADE Cloud has no saved menu for that computer.", 404);
const unavailable = () => fail("unavailable", "Saved menus aren't available right now. Try again soon.", 503);

const snapshotAad = (userId: string, machineKey: string, projectKey: string): string =>
  `ade.cloud.mentions.v1\0${userId}\0${machineKey}\0${projectKey}`;

type SnapshotRow = { machine_key: string; sealed: string; saved_at: number };

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

async function sealSnapshot(aes: CryptoKey, userId: string, machineKey: string, projectKey: string, snapshot: CloudMentionSnapshot): Promise<string> {
  return await sealText(aes, snapshotAad(userId, machineKey, projectKey), await gzip(new TextEncoder().encode(JSON.stringify(snapshot))));
}

async function openSnapshot(aes: CryptoKey, userId: string, machineKey: string, projectKey: string, sealed: string): Promise<CloudMentionSnapshot | null> {
  const opened = await openText(aes, snapshotAad(userId, machineKey, projectKey), sealed);
  const unzipped = opened ? await gunzip(opened) : null;
  try {
    return unzipped ? readCloudMentionSnapshot(JSON.parse(new TextDecoder().decode(unzipped))) : null;
  } catch {
    return null;
  }
}

const projectKeyOf = (value: unknown): string | null =>
  typeof value === "string" && value.trim() && value.trim().length <= MAX_PROJECT_KEY ? value.trim() : null;

async function handlePut(request: Request, env: CloudEnv, userId: string, namedMachineKey: string, now: number): Promise<Response> {
  // Only the computer writes its menu: a browser page (it sends `Origin`) can read it, never write it.
  if (request.headers.get("origin") != null) return fail("not_found", "ADE Cloud has no such computer.", 404);
  const body = await readCappedJson(request, CLOUD_MENTION_SNAPSHOT_MAX_BYTES + BODY_OVERHEAD_BYTES);
  if (!body.ok) {
    return body.tooLarge ? fail("snapshot_too_large", "That menu is too large to save.", 413) : fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);
  }
  const computer = await callingComputer(env, request, userId, body.value.instanceId);
  // Only the computer itself saves its menu, under its own key.
  if (!computer?.machine_key || computer.machine_key.toLowerCase() !== namedMachineKey.toLowerCase()) return fail("not_found", "ADE Cloud has no such computer.", 404);
  // Stored, sealed and deleted under the computer's own key, whatever case the path used.
  const machineKey = computer.machine_key;
  const projectKey = projectKeyOf(body.value.projectKey);
  const snapshot = readCloudMentionSnapshot(body.value.snapshot);
  if (!projectKey || !snapshot || snapshot.savedAt > now + MAX_CLOCK_AHEAD_MS) return fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);
  const keys = await userKeys(env, userId, now);
  if (!keys) return unavailable();
  const sealed = await sealSnapshot(keys.aes, userId, machineKey, projectKey, snapshot);
  const [written] = await env.DB.batch([env.DB.prepare(`
    insert into cloud_mention_snapshots (user_id, machine_key, project_key, instance_id, sealed, saved_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?)
    on conflict (user_id, machine_key, project_key) do update set
      instance_id = excluded.instance_id, sealed = excluded.sealed, saved_at = excluded.saved_at, updated_at = excluded.updated_at
    where excluded.saved_at > cloud_mention_snapshots.saved_at and ? = 0
  `).bind(userId, machineKey, projectKey, computer.instance_id, sealed, snapshot.savedAt, now, body.value.partial === true ? 1 : 0),
  // Its newest few: a computer can't grow the account's rows without end by naming new projects.
  env.DB.prepare(`
    delete from cloud_mention_snapshots where user_id = ? and machine_key = ? and project_key not in (
      select project_key from cloud_mention_snapshots where user_id = ? and machine_key = ? order by updated_at desc, project_key limit ?
    )
  `).bind(userId, machineKey, userId, machineKey, MAX_PROJECTS_PER_COMPUTER)]);
  return json({ ok: true, kept: (written?.meta?.changes ?? 0) === 0 });
}

async function handleGet(url: URL, env: CloudEnv, userId: string, namedMachineKey: string, now: number): Promise<Response> {
  const projectKey = projectKeyOf(url.searchParams.get("project"));
  if (!projectKey) return notFound();
  const row = await env.DB.prepare("select machine_key, sealed, saved_at from cloud_mention_snapshots where user_id = ? and machine_key = ? and project_key = ?")
    .bind(userId, namedMachineKey, projectKey).first<SnapshotRow>();
  if (!row) return notFound();
  const since = Number(url.searchParams.get("since"));
  if (Number.isFinite(since) && since === row.saved_at) return json({ unchanged: true, savedAt: row.saved_at });
  const keys = await userKeys(env, userId, now);
  if (!keys) return unavailable();
  let snapshot = await openSnapshot(keys.aes, userId, row.machine_key, projectKey, row.sealed);
  if (!snapshot) {
    logCloud("cloud.mention_snapshot_unreadable", { userId, machineKey: row.machine_key });
    return fail("snapshot_unreadable", "This saved menu can't be read right now.", 503);
  }
  const laneId = url.searchParams.get("lane")?.trim();
  if (laneId) snapshot = { ...snapshot, files: snapshot.files[laneId] ? { [laneId]: snapshot.files[laneId]! } : {} };
  return json({ snapshot });
}

/**
 * A deleted saved chat leaves every menu its computer saved (the computer may
 * never save again). The saved time moves on by 1 ms, so a client holding the
 * old copy downloads it again, and the computer's next save is still newer.
 * Never throws: the chat's delete is done.
 */
export async function dropChatFromMentionSnapshots(env: CloudEnv, userId: string, machineKey: string, chatId: string, now: number): Promise<void> {
  try {
    const projects = (await env.DB.prepare("select project_key from cloud_mention_snapshots where user_id = ? and machine_key = ?")
      .bind(userId, machineKey).all<{ project_key: string }>()).results ?? [];
    if (!projects.length) return;
    const keys = await userKeys(env, userId, now);
    if (!keys) return;
    for (const { project_key: projectKey } of projects) {
      // Another delete or a save can change the copy between the read and the write:
      // then it is read again, so each deleted chat leaves it.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const row = await env.DB.prepare("select machine_key, sealed, saved_at from cloud_mention_snapshots where user_id = ? and machine_key = ? and project_key = ?")
          .bind(userId, machineKey, projectKey).first<SnapshotRow>();
        const snapshot = row ? await openSnapshot(keys.aes, userId, row.machine_key, projectKey, row.sealed) : null;
        const kept = snapshot?.rows.filter((entry) => !(entry.kind === "chat" && entry.id === chatId));
        if (!row || !snapshot || !kept || kept.length === snapshot.rows.length) break;
        const next: CloudMentionSnapshot = { ...snapshot, savedAt: row.saved_at + 1, rows: kept };
        const written = await env.DB.prepare(`
          update cloud_mention_snapshots set sealed = ?, saved_at = ?, updated_at = ?
          where user_id = ? and machine_key = ? and project_key = ? and saved_at = ?
        `).bind(await sealSnapshot(keys.aes, userId, row.machine_key, projectKey, next), next.savedAt, now, userId, row.machine_key, projectKey, row.saved_at).run();
        if ((written.meta?.changes ?? 0) > 0) break;
      }
    }
  } catch (error) {
    reportCloudFailure("cloud.mention_snapshot_chat_drop_failed", { userId, machineKey, message: error instanceof Error ? error.message : "unknown" });
  }
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
