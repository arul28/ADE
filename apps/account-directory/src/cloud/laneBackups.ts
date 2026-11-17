import {
  CLOUD_BACKUP_ACCOUNT_FULL_SENTENCE,
  CLOUD_BACKUP_MAX_ACCOUNT_BYTES,
  CLOUD_BACKUP_MAX_BYTES,
  CLOUD_BACKUP_MAX_PART_BYTES,
  CLOUD_BACKUP_NOT_SAVED_SENTENCE,
  CLOUD_BACKUP_TOO_LARGE_SENTENCE,
  CLOUD_PATHS,
  type CloudBackupKind,
  type CloudBackupLaneReport,
  type CloudBackupLaneState,
  type CloudBackupProblem,
  type CloudLaneBackup,
  type CloudLaneBackupFacts,
} from "./contract";
import { ROW_ID, UNREADABLE_REQUEST_MESSAGE, fail, json, readJson } from "./http";
import { openBytes, openJson, sealBytes, sealJson, userKeys, type UserKeys } from "./seal";
import { callingComputer, segmentsAfter } from "./sessionCopies";
import { logCloud, type CloudDb, type CloudEnv, type ComputerRow } from "./store";

/**
 * Lane backups at rest (contract: "Lane backups at rest"). Before a cloud
 * computer rests, it saves each lane's work that is not on GitHub yet here:
 * a git bundle (commits no `origin` branch has, plus a snapshot commit of the
 * uncommitted work) and a patch of the same work. Nothing is pushed and the
 * snapshot is on no branch.
 *
 * - **Who writes:** only a computer of the account, under its own machine key
 *   (the row in `cloud_computers` names it). A person's app never writes.
 * - **Who reads:** only the account. The bundle goes only to a native caller
 *   (a cloud computer or the desktop); a browser gets the manifest and the
 *   patch. Another account gets 404.
 * - **Sealed** with the account's key (`seal.ts`), each part with additional
 *   data that names the user, machine key, lane, upload, kind and part. The
 *   server can open it (encryption at rest, not end-to-end).
 * - **One per lane and machine key.** An upload goes to its own prefix and
 *   replaces the row only at its commit, so the old backup stays whole until
 *   the new one is.
 * - **Caps:** `CLOUD_BACKUP_MAX_BYTES` per lane and
 *   `CLOUD_BACKUP_MAX_ACCOUNT_BYTES` per account, checked at the start (the
 *   declared sizes), at each part and at the commit (the sizes in R2).
 *
 * The report (`POST /cloud/backups/report`) says, after each save, whether
 * every lane of the computer is clean or saved. A cleanup deletes a resting
 * computer with no wake only when it rested right after such a report
 * (`backup_rest_at`, set by its own idle sleep or the 0-hours stop; any wake
 * clears it). Otherwise the computer is kept with
 * `CLOUD_BACKUP_NOT_SAVED_SENTENCE`.
 */

/** The seal's own bytes on each part: the IV and the tag. */
const SEAL_OVERHEAD = 28;
/** An upload not committed by then is dropped by the next upload. */
const UPLOAD_STALE_MS = 30 * 60_000;
const UPLOAD_ID = /^[0-9a-f]{32}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40,64}$/;
const KINDS: ReadonlySet<string> = new Set(["bundle", "patch"]);
/** Most lanes one report names, and most problems kept on the row. */
const MAX_REPORT_LANES = 200;
const MAX_PROBLEMS = 20;
/** The account's backups in one list. */
const LIST_LIMIT = 200;

type BackupRow = {
  user_id: string;
  machine_key: string;
  lane_id: string;
  instance_id: string | null;
  upload_id: string | null;
  r2_prefix: string | null;
  fingerprint: string | null;
  facts_sealed: string | null;
  bundle_bytes: number;
  patch_bytes: number;
  bundle_parts: number;
  patch_parts: number;
  saved_at: number | null;
  pending_upload_id: string | null;
  pending_bytes: number | null;
  pending_fingerprint: string | null;
  pending_facts_sealed: string | null;
  pending_at: number | null;
  restored_at: number | null;
  restored_by_machine_key: string | null;
  updated_at: number;
};

const notFound = () => fail("not_found", "ADE Cloud has no saved work for that lane.", 404);
const unavailable = () => fail("unavailable", "Saved lane work isn't available right now. Try again soon.", 503);
const tooLarge = () => fail("backup_too_large", CLOUD_BACKUP_TOO_LARGE_SENTENCE, 413);
const accountFull = () => fail("backup_account_full", CLOUD_BACKUP_ACCOUNT_FULL_SENTENCE, 413);
const noComputer = () => fail("not_found", "ADE Cloud has no such computer.", 404);

const uploadPrefix = (userId: string, machineKey: string, laneId: string, uploadId: string): string => `backups/${userId}/${machineKey}/${laneId}/${uploadId}/`;
const partKey = (prefix: string, kind: CloudBackupKind, part: number): string => `${prefix}${kind}/${String(part).padStart(5, "0")}`;
/** Binds a part to its owner, place and upload: a part moved anywhere else does not open. */
export const backupPartAad = (userId: string, machineKey: string, laneId: string, uploadId: string, kind: CloudBackupKind, part: number): string =>
  `ade.cloud.backup.part.v1\0${userId}\0${machineKey}\0${laneId}\0${uploadId}\0${kind}\0${part}`;
const factsAad = (userId: string, machineKey: string, laneId: string): string => `ade.cloud.backup.facts.v1\0${userId}\0${machineKey}\0${laneId}`;

function bucketOf(env: Pick<CloudEnv, "CLOUD_CHATS">): R2Bucket | null {
  return env.CLOUD_CHATS ?? null;
}

async function readRow(env: CloudDb, userId: string, machineKey: string, laneId: string): Promise<BackupRow | null> {
  return await env.DB.prepare("select * from cloud_lane_backups where user_id = ? and machine_key = ? and lane_id = ?")
    .bind(userId, machineKey, laneId).first<BackupRow>();
}

/** The account's committed backup bytes, and the bytes uploads in progress hold, except this lane's own. */
async function accountBytes(env: CloudDb, userId: string, except: { machineKey: string; laneId: string }): Promise<number> {
  const row = await env.DB.prepare(`
    select coalesce(sum(bundle_bytes + patch_bytes), 0) + coalesce(sum(case when pending_upload_id is not null then pending_bytes else 0 end), 0) as total
    from cloud_lane_backups where user_id = ? and not (machine_key = ? and lane_id = ?)
  `).bind(userId, except.machineKey, except.laneId).first<{ total: number }>();
  return row?.total ?? 0;
}

function clip(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function count(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
}

/** The facts the computer sent, checked; null when any required one is unreadable. */
export function readBackupFacts(value: unknown): CloudLaneBackupFacts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const headSha = typeof record.headSha === "string" && SHA.test(record.headSha) ? record.headSha : null;
  const baseSha = typeof record.baseSha === "string" && SHA.test(record.baseSha) ? record.baseSha : null;
  const snapshotSha = record.snapshotSha == null ? null : typeof record.snapshotSha === "string" && SHA.test(record.snapshotSha) ? record.snapshotSha : undefined;
  const commits = count(record.commits, 10_000_000);
  const files = count(record.files, 10_000_000);
  if (!headSha || !baseSha || snapshotSha === undefined || commits == null || files == null) return null;
  return {
    branchRef: clip(record.branchRef, 300),
    laneName: clip(record.laneName, 200),
    projectKey: clip(record.projectKey, 300),
    headSha,
    snapshotSha,
    baseSha,
    commits,
    files,
  };
}

async function manifestOf(keys: UserKeys | null, row: BackupRow): Promise<CloudLaneBackup | null> {
  if (!row.upload_id || !row.fingerprint || row.saved_at == null) return null;
  const opened = keys ? await openJson(keys, factsAad(row.user_id, row.machine_key, row.lane_id), row.facts_sealed) : undefined;
  const facts = readBackupFacts(opened);
  if (!facts) return null;
  return {
    ...facts,
    machineKey: row.machine_key,
    laneId: row.lane_id,
    instanceId: row.instance_id,
    fingerprint: row.fingerprint,
    bundleBytes: row.bundle_bytes,
    patchBytes: row.patch_bytes,
    bundleParts: row.bundle_parts,
    patchParts: row.patch_parts,
    savedAt: row.saved_at,
    restoredAt: row.restored_at,
    restoredByMachineKey: row.restored_by_machine_key,
  };
}

/** Every object under `prefix`, deleted. */
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

/** The caller is a computer of this account with this machine key: only it writes under the key. */
async function writingComputer(env: CloudEnv, request: Request, userId: string, machineKey: string, bodyInstanceId: unknown): Promise<ComputerRow | null> {
  const computer = await callingComputer(env, request, userId, bodyInstanceId);
  if (!computer || computer.deleted_at != null) return null;
  return computer.machine_key === machineKey ? computer : null;
}

/** A browser page sends `Origin`; a computer and the desktop's main process do not. */
const fromBrowser = (request: Request): boolean => request.headers.get("origin") != null;

async function handleStart(request: Request, env: CloudEnv, userId: string, machineKey: string, laneId: string, now: number): Promise<Response> {
  const body = await readJson(request);
  if (!body) return fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);
  const computer = await writingComputer(env, request, userId, machineKey, body.instanceId);
  if (!computer) return noComputer();
  const fingerprint = typeof body.fingerprint === "string" && FINGERPRINT.test(body.fingerprint) ? body.fingerprint : null;
  const bundleBytes = count(body.bundleBytes, Number.MAX_SAFE_INTEGER);
  const patchBytes = count(body.patchBytes, Number.MAX_SAFE_INTEGER);
  const facts = readBackupFacts(body.facts);
  if (!fingerprint || bundleBytes == null || patchBytes == null || bundleBytes === 0 || !facts) return fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);
  const total = bundleBytes + patchBytes;
  if (total > CLOUD_BACKUP_MAX_BYTES) {
    logCloud("cloud.backup_too_large", { userId, instanceId: computer.instance_id, bytes: total });
    return tooLarge();
  }
  if ((await accountBytes(env, userId, { machineKey, laneId })) + total > CLOUD_BACKUP_MAX_ACCOUNT_BYTES) {
    logCloud("cloud.backup_account_full", { userId, limitBytes: CLOUD_BACKUP_MAX_ACCOUNT_BYTES });
    return accountFull();
  }
  const keys = await userKeys(env, userId, now);
  if (!keys) return unavailable();
  const bucket = bucketOf(env);
  if (!bucket) return unavailable();
  // An upload this lane left unfinished goes first: it holds bytes nobody reads.
  const before = await readRow(env, userId, machineKey, laneId);
  if (before?.pending_upload_id && before.pending_upload_id !== before.upload_id) {
    await deleteUnder(bucket, uploadPrefix(userId, machineKey, laneId, before.pending_upload_id));
  }
  const uploadId = [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const sealedFacts = await sealJson(keys, factsAad(userId, machineKey, laneId), facts);
  await env.DB.prepare(`
    insert into cloud_lane_backups (user_id, machine_key, lane_id, instance_id, pending_upload_id, pending_bytes, pending_fingerprint, pending_facts_sealed, pending_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict (user_id, machine_key, lane_id) do update set
      pending_upload_id = excluded.pending_upload_id, pending_bytes = excluded.pending_bytes,
      pending_fingerprint = excluded.pending_fingerprint, pending_facts_sealed = excluded.pending_facts_sealed,
      pending_at = excluded.pending_at, updated_at = excluded.updated_at
  `).bind(userId, machineKey, laneId, computer.instance_id, uploadId, total, fingerprint, sealedFacts, now, now).run();
  return json({ uploadId, partBytes: CLOUD_BACKUP_MAX_PART_BYTES });
}

async function handlePutPart(request: Request, env: CloudEnv, userId: string, machineKey: string, laneId: string, uploadId: string, kind: CloudBackupKind, part: number, now: number): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > CLOUD_BACKUP_MAX_PART_BYTES) return tooLarge();
  const computer = await writingComputer(env, request, userId, machineKey, null);
  if (!computer) return noComputer();
  const row = await readRow(env, userId, machineKey, laneId);
  if (!row || row.pending_upload_id !== uploadId || row.pending_at == null || now - row.pending_at > UPLOAD_STALE_MS) {
    return fail("backup_upload_gone", "This upload of the lane's work ended. Start it again.", 409);
  }
  const plain = new Uint8Array(await request.arrayBuffer());
  if (plain.byteLength === 0) return fail("bad_request", "That part is empty.", 400);
  if (plain.byteLength > CLOUD_BACKUP_MAX_PART_BYTES) return tooLarge();
  // Every part of an upload counts against the size it declared: a computer can't send more than it said.
  if (part * CLOUD_BACKUP_MAX_PART_BYTES > (row.pending_bytes ?? 0) + 2 * CLOUD_BACKUP_MAX_PART_BYTES) return tooLarge();
  const keys = await userKeys(env, userId, now);
  const bucket = bucketOf(env);
  if (!keys || !bucket) return unavailable();
  const prefix = uploadPrefix(userId, machineKey, laneId, uploadId);
  await bucket.put(partKey(prefix, kind, part), await sealBytes(keys.aes, backupPartAad(userId, machineKey, laneId, uploadId, kind, part), plain));
  return json({ ok: true, bytes: plain.byteLength });
}

/** The sizes in R2 of parts 1..n of one kind; null when one is missing. */
async function storedBytes(bucket: R2Bucket, prefix: string, kind: CloudBackupKind, parts: number): Promise<number | null> {
  let total = 0;
  for (let part = 1; part <= parts; part += 1) {
    const head = await bucket.head(partKey(prefix, kind, part));
    if (!head) return null;
    total += Math.max(0, head.size - SEAL_OVERHEAD);
  }
  return total;
}

async function handleCommit(request: Request, env: CloudEnv, userId: string, machineKey: string, laneId: string, uploadId: string, now: number): Promise<Response> {
  const body = await readJson(request);
  if (!body) return fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);
  const computer = await writingComputer(env, request, userId, machineKey, body.instanceId);
  if (!computer) return noComputer();
  const maxParts = Math.ceil(CLOUD_BACKUP_MAX_BYTES / CLOUD_BACKUP_MAX_PART_BYTES) + 1;
  const bundleParts = count(body.bundleParts, maxParts);
  const patchParts = count(body.patchParts, maxParts);
  if (!bundleParts || patchParts == null) return fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);
  const row = await readRow(env, userId, machineKey, laneId);
  if (!row || row.pending_upload_id !== uploadId) return fail("backup_upload_gone", "This upload of the lane's work ended. Start it again.", 409);
  const bucket = bucketOf(env);
  if (!bucket) return unavailable();
  const prefix = uploadPrefix(userId, machineKey, laneId, uploadId);
  // The sizes in R2 are the truth, not the counts the computer sent.
  const bundleBytes = await storedBytes(bucket, prefix, "bundle", bundleParts);
  const patchBytes = await storedBytes(bucket, prefix, "patch", patchParts);
  if (bundleBytes == null || patchBytes == null || bundleBytes === 0) {
    return fail("backup_incomplete", "Some parts of this lane's saved work are missing. Upload it again.", 409);
  }
  if (bundleBytes + patchBytes > CLOUD_BACKUP_MAX_BYTES) return tooLarge();
  if ((await accountBytes(env, userId, { machineKey, laneId })) + bundleBytes + patchBytes > CLOUD_BACKUP_MAX_ACCOUNT_BYTES) return accountFull();
  // Parts past the counts (a retry that sent fewer) are not part of the backup.
  const listed = await bucket.list({ prefix, limit: 1000 });
  const extra = listed.objects.map((object) => object.key).filter((key) => {
    const [kind, part] = key.slice(prefix.length).split("/");
    const n = Number(part);
    return !(kind === "bundle" && n >= 1 && n <= bundleParts) && !(kind === "patch" && n >= 1 && n <= patchParts);
  });
  if (extra.length) await bucket.delete(extra);
  const committed = await env.DB.prepare(`
    update cloud_lane_backups set
      instance_id = ?, upload_id = pending_upload_id, r2_prefix = ?, fingerprint = pending_fingerprint, facts_sealed = pending_facts_sealed,
      bundle_bytes = ?, patch_bytes = ?, bundle_parts = ?, patch_parts = ?, saved_at = ?,
      restored_at = null, restored_by_machine_key = null,
      pending_upload_id = null, pending_bytes = null, pending_fingerprint = null, pending_facts_sealed = null, pending_at = null,
      updated_at = ?
    where user_id = ? and machine_key = ? and lane_id = ? and pending_upload_id = ?
  `).bind(computer.instance_id, prefix, bundleBytes, patchBytes, bundleParts, patchParts, now, now, userId, machineKey, laneId, uploadId).run();
  if ((committed.meta?.changes ?? 0) !== 1) return fail("backup_upload_gone", "This upload of the lane's work ended. Start it again.", 409);
  // The backup it replaces goes only now that the new one is whole.
  if (row.upload_id && row.upload_id !== uploadId) await deleteUnder(bucket, uploadPrefix(userId, machineKey, laneId, row.upload_id));
  // A backup of this lane from another machine that this computer applied is in the new one now.
  const replaced = (await env.DB.prepare("select user_id, machine_key, lane_id from cloud_lane_backups where user_id = ? and lane_id = ? and machine_key <> ? and restored_by_machine_key = ?")
    .bind(userId, laneId, machineKey, machineKey).all<BackupRow>()).results ?? [];
  for (const old of replaced) await deleteBackup(env, old);
  logCloud("cloud.backup_saved", { userId, instanceId: computer.instance_id, bytes: bundleBytes + patchBytes, bundleParts, patchParts });
  const keys = await userKeys(env, userId, now);
  const manifest = await manifestOf(keys, (await readRow(env, userId, machineKey, laneId))!);
  return manifest ? json(manifest) : unavailable();
}

async function handleReadPart(request: Request, env: CloudEnv, userId: string, machineKey: string, laneId: string, kind: CloudBackupKind, part: number, now: number): Promise<Response> {
  // The bundle is the exact restore, for a computer or the desktop; a browser downloads the patch.
  if (kind === "bundle" && fromBrowser(request)) return notFound();
  const row = await readRow(env, userId, machineKey, laneId);
  const parts = kind === "bundle" ? row?.bundle_parts ?? 0 : row?.patch_parts ?? 0;
  if (!row || !row.upload_id || !row.r2_prefix || part > parts) return notFound();
  const bucket = bucketOf(env);
  const keys = await userKeys(env, userId, now);
  if (!bucket || !keys) return unavailable();
  const object = await bucket.get(partKey(row.r2_prefix, kind, part));
  const opened = object ? await openBytes(keys.aes, backupPartAad(userId, machineKey, laneId, row.upload_id, kind, part), new Uint8Array(await object.arrayBuffer())) : null;
  if (!opened) {
    logCloud("cloud.backup_part_unreadable", { userId, kind, part });
    return fail("backup_unreadable", "This lane's saved work can't be read right now.", 503);
  }
  return new Response(opened as Uint8Array<ArrayBuffer>, { status: 200, headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
}

/** One backup, its parts and its row. */
async function deleteBackup(env: CloudEnv, row: Pick<BackupRow, "user_id" | "machine_key" | "lane_id">): Promise<void> {
  const bucket = bucketOf(env);
  if (bucket) await deleteUnder(bucket, `backups/${row.user_id}/${row.machine_key}/${row.lane_id}/`);
  await env.DB.prepare("delete from cloud_lane_backups where user_id = ? and machine_key = ? and lane_id = ?").bind(row.user_id, row.machine_key, row.lane_id).run();
}

/**
 * From the computer: the lane's work is all on GitHub now. Its own backup
 * goes, and so does every backup of the lane it restored (that work is on
 * GitHub with it).
 */
async function handleDelete(request: Request, env: CloudEnv, userId: string, machineKey: string, laneId: string): Promise<Response> {
  const body = await readJson(request);
  const computer = await writingComputer(env, request, userId, machineKey, body?.instanceId ?? null);
  if (!computer) return noComputer();
  const rows = (await env.DB.prepare(`
    select user_id, machine_key, lane_id from cloud_lane_backups
    where user_id = ? and lane_id = ? and (machine_key = ? or restored_by_machine_key = ?)
  `).bind(userId, laneId, machineKey, machineKey).all<BackupRow>()).results ?? [];
  for (const row of rows) await deleteBackup(env, row);
  if (rows.length) logCloud("cloud.backup_deleted", { userId, instanceId: computer.instance_id, reason: "on_github", count: rows.length });
  return json({ deleted: rows.length });
}

/** From the computer that applied another machine's backup of this lane to its own lane. */
async function handleRestored(request: Request, env: CloudEnv, userId: string, machineKey: string, laneId: string, now: number): Promise<Response> {
  const body = await readJson(request);
  if (!body) return fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);
  const computer = await callingComputer(env, request, userId, body.instanceId);
  if (!computer?.machine_key) return noComputer();
  const done = await env.DB.prepare("update cloud_lane_backups set restored_at = ?, restored_by_machine_key = ?, updated_at = ? where user_id = ? and machine_key = ? and lane_id = ? and upload_id is not null")
    .bind(now, computer.machine_key, now, userId, machineKey, laneId).run();
  if ((done.meta?.changes ?? 0) !== 1) return notFound();
  logCloud("cloud.backup_restored", { userId, instanceId: computer.instance_id });
  return json({ ok: true });
}

const LANE_STATES: ReadonlySet<CloudBackupLaneState> = new Set(["clean", "saved", "unchanged", "failed", "too_large"]);

/** The report's lanes, checked; null when unreadable. */
export function readBackupLanes(value: unknown): CloudBackupLaneReport[] | null {
  if (!Array.isArray(value) || value.length > MAX_REPORT_LANES) return null;
  const lanes: CloudBackupLaneReport[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const record = entry as Record<string, unknown>;
    const laneId = typeof record.laneId === "string" && ROW_ID.test(record.laneId) ? record.laneId : null;
    const state = typeof record.state === "string" && LANE_STATES.has(record.state as CloudBackupLaneState) ? record.state as CloudBackupLaneState : null;
    if (!laneId || !state) return null;
    lanes.push({
      laneId,
      laneName: clip(record.laneName, 200),
      state,
      fingerprint: typeof record.fingerprint === "string" && FINGERPRINT.test(record.fingerprint) ? record.fingerprint : null,
      reason: clip(record.reason, 300),
    });
  }
  return lanes;
}

/**
 * `POST /cloud/backups/report`: the computer's state after a save. It is
 * `current` only when the save read every project, and every lane is clean
 * or has a committed backup here with the fingerprint the computer names.
 * It does not mark the computer as resting with it: its own sleep or the
 * 0-hours stop does (`markRestedWithBackups`).
 */
async function handleReport(request: Request, env: CloudEnv, userId: string, now: number): Promise<Response> {
  const body = await readJson(request);
  if (!body) return fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);
  const computer = await callingComputer(env, request, userId, body.instanceId);
  if (!computer?.machine_key || computer.deleted_at != null) return noComputer();
  const reportId = typeof body.reportId === "string" && UPLOAD_ID.test(body.reportId) ? body.reportId : null;
  const lanes = readBackupLanes(body.lanes);
  if (!reportId || !lanes || typeof body.complete !== "boolean") return fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);
  const rows = (await env.DB.prepare("select lane_id, fingerprint from cloud_lane_backups where user_id = ? and machine_key = ? and upload_id is not null")
    .bind(userId, computer.machine_key).all<{ lane_id: string; fingerprint: string | null }>()).results ?? [];
  const saved = new Map(rows.map((row) => [row.lane_id, row.fingerprint]));
  const problems: CloudBackupProblem[] = [];
  for (const lane of lanes) {
    if (lane.state === "clean") continue;
    if ((lane.state === "saved" || lane.state === "unchanged") && lane.fingerprint && saved.get(lane.laneId) === lane.fingerprint) continue;
    const reason = lane.state === "too_large"
      ? CLOUD_BACKUP_TOO_LARGE_SENTENCE
      : lane.reason ?? CLOUD_BACKUP_NOT_SAVED_SENTENCE;
    problems.push({ laneId: lane.laneId, laneName: lane.laneName ?? null, reason });
  }
  const state = body.complete && problems.length === 0 ? "current" : "failed";
  if (!body.complete && problems.length === 0) {
    problems.push({ laneId: "", laneName: null, reason: "ADE couldn't read every project on this computer, so it couldn't save every lane." });
  }
  await env.DB.prepare(`
    update cloud_computers set backup_report_id = ?, backup_report_state = ?, backup_report_at = ?, backup_problems_json = ?
    where instance_id = ? and deleted_at is null
  `).bind(reportId, state, now, problems.length ? JSON.stringify(problems.slice(0, MAX_PROBLEMS)) : null, computer.instance_id).run();
  logCloud("cloud.backup_report", { userId, instanceId: computer.instance_id, state, lanes: lanes.length, problems: problems.length });
  return json({ state });
}

/**
 * The computer went to rest right after report `reportId`: when that report
 * said every lane is saved, the computer rests with current backups. Runs
 * after the status write of its own idle sleep and of the 0-hours stop.
 */
export async function markRestedWithBackups(env: CloudDb, instanceId: string, reportId: string | null, now: number): Promise<boolean> {
  if (!reportId || !UPLOAD_ID.test(reportId)) return false;
  const marked = await env.DB.prepare(`
    update cloud_computers set backup_rest_at = ?
    where instance_id = ? and deleted_at is null and backup_report_id = ? and backup_report_state = 'current'
      and status in ('sleeping', 'stopped')
  `).bind(now, instanceId, reportId).run();
  return (marked.meta?.changes ?? 0) === 1;
}

/** The lanes ADE couldn't save on this computer, from its last report. */
export function backupProblemsOf(computer: Pick<ComputerRow, "backup_problems_json">): CloudBackupProblem[] {
  if (!computer.backup_problems_json) return [];
  try {
    const parsed = JSON.parse(computer.backup_problems_json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is CloudBackupProblem => Boolean(entry) && typeof (entry as CloudBackupProblem).reason === "string") : [];
  } catch {
    return [];
  }
}

/** The sentence a cleanup keeps a computer with: the lanes' own reasons when the report gave them. */
export function backupNotSavedReason(computer: Pick<ComputerRow, "backup_problems_json">): string {
  const problems = backupProblemsOf(computer);
  if (problems.length === 0) return CLOUD_BACKUP_NOT_SAVED_SENTENCE;
  const named = problems.map((problem) => (problem.laneName ? `${problem.laneName}: ${problem.reason}` : problem.reason));
  return `${CLOUD_BACKUP_NOT_SAVED_SENTENCE} ${[...new Set(named)].slice(0, 3).join(" ")}`.slice(0, 300);
}

async function handleList(url: URL, env: CloudEnv, userId: string, now: number): Promise<Response> {
  const laneId = url.searchParams.get("laneId");
  if (laneId != null && !ROW_ID.test(laneId)) return json({ backups: [] });
  const rows = (laneId
    ? await env.DB.prepare("select * from cloud_lane_backups where user_id = ? and lane_id = ? and upload_id is not null order by saved_at desc limit ?").bind(userId, laneId, LIST_LIMIT).all<BackupRow>()
    : await env.DB.prepare("select * from cloud_lane_backups where user_id = ? and upload_id is not null order by saved_at desc limit ?").bind(userId, LIST_LIMIT).all<BackupRow>()).results ?? [];
  if (rows.length === 0) return json({ backups: [] });
  const keys = await userKeys(env, userId, now);
  if (!keys) return unavailable();
  const backups = (await Promise.all(rows.map((row) => manifestOf(keys, row)))).filter((entry): entry is CloudLaneBackup => entry != null);
  return json({ backups });
}

/** `/cloud/backups[/...]`. The caller passed the access gate. */
export async function routeLaneBackups(request: Request, url: URL, path: string, env: CloudEnv, userId: string, now: number): Promise<Response> {
  const segments = segmentsAfter(path, CLOUD_PATHS.backups);
  if (segments.length === 0) return request.method === "GET" ? handleList(url, env, userId, now) : notFound();
  // Every write comes from a computer, never from a browser page.
  if (request.method !== "GET" && fromBrowser(request)) return notFound();
  if (segments.length === 1 && segments[0] === "report" && request.method === "POST") return handleReport(request, env, userId, now);
  const [machineKey, laneId, action, ...rest] = segments;
  if (!machineKey || !laneId || !ROW_ID.test(machineKey) || !ROW_ID.test(laneId)) return notFound();
  if (segments.length === 2) {
    if (request.method === "GET") {
      const row = await readRow(env, userId, machineKey, laneId);
      const manifest = row ? await manifestOf(await userKeys(env, userId, now), row) : null;
      return manifest ? json(manifest) : notFound();
    }
    if (request.method === "DELETE") return handleDelete(request, env, userId, machineKey, laneId);
    return notFound();
  }
  if (segments.length === 3 && action === "restored" && request.method === "POST") return handleRestored(request, env, userId, machineKey, laneId, now);
  if (segments.length === 3 && action === "uploads" && request.method === "POST") return handleStart(request, env, userId, machineKey, laneId, now);
  const partOf = (text: string | undefined): number | null => (text && /^[1-9][0-9]{0,3}$/.test(text) ? Number(text) : null);
  if (segments.length === 4 && action && KINDS.has(action) && request.method === "GET") {
    const part = partOf(rest[0]);
    return part ? handleReadPart(request, env, userId, machineKey, laneId, action as CloudBackupKind, part, now) : notFound();
  }
  if (action === "uploads" && rest.length >= 2) {
    const uploadId = rest[0]!;
    if (!UPLOAD_ID.test(uploadId)) return notFound();
    if (rest.length === 2 && rest[1] === "commit" && request.method === "POST") return handleCommit(request, env, userId, machineKey, laneId, uploadId, now);
    const part = partOf(rest[2]);
    if (rest.length === 3 && KINDS.has(rest[1]!) && part && request.method === "PUT") {
      return handlePutPart(request, env, userId, machineKey, laneId, uploadId, rest[1] as CloudBackupKind, part, now);
    }
  }
  return notFound();
}

/** Every backup made on these machine keys goes (the person deleted the lane with its computer). */
export async function deleteBackupsForMachines(env: CloudEnv, userId: string, machineKeys: ReadonlyArray<string | null | undefined>): Promise<number> {
  let removed = 0;
  for (const machineKey of new Set(machineKeys.filter((key): key is string => Boolean(key)))) {
    const rows = (await env.DB.prepare("select user_id, machine_key, lane_id from cloud_lane_backups where user_id = ? and machine_key = ? limit 500")
      .bind(userId, machineKey).all<BackupRow>()).results ?? [];
    for (const row of rows) await deleteBackup(env, row);
    removed += rows.length;
  }
  if (removed) logCloud("cloud.backup_deleted", { userId, reason: "lane_deleted", count: removed });
  return removed;
}

/** Every backup of one lane, on every machine key, goes (the person deleted the lane). */
export async function deleteBackupsForLane(env: CloudEnv, userId: string, laneId: string): Promise<number> {
  const rows = (await env.DB.prepare("select user_id, machine_key, lane_id from cloud_lane_backups where user_id = ? and lane_id = ? limit 500")
    .bind(userId, laneId).all<BackupRow>()).results ?? [];
  for (const row of rows) await deleteBackup(env, row);
  if (rows.length) logCloud("cloud.backup_deleted", { userId, reason: "lane_deleted", count: rows.length });
  return rows.length;
}
