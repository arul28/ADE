import { mintDeviceApprovalLink } from "../deviceAppApproval";
import { findByUserCode, normalizeUserCode, resolveDeviceRequestOptions } from "../deviceAuthorization";
import { sha256Hex } from "../sinkUtils";
import { trustedHttpsOrigin } from "../trustedOrigin";
import {
  CLOUD_INSTANCE_HEADER,
  CLOUD_LANE_METADATA,
  CLOUD_LAUNCH_DRAFT_TTL_MS,
  CLOUD_LAUNCH_ENV,
  CLOUD_LAUNCH_JOIN_TTL_MS,
  CLOUD_LAUNCH_MAX_FILE_BYTES,
  CLOUD_LAUNCH_MAX_FILES,
  CLOUD_LAUNCH_MAX_PROMPT_CHARS,
  CLOUD_LAUNCH_MAX_STAGES,
  CLOUD_LAUNCH_METADATA,
  CLOUD_LAUNCH_RECORD_TTL_MS,
  CLOUD_PATHS,
  type CloudLaunchAttachment,
  type CloudLaunchRecord,
  type CloudLaunchStage,
  type CloudLaunchStageStatus,
  type CloudLaunchState,
  type CloudServerLaunchRequest,
  type CloudTierId,
} from "./contract";
import { UNREADABLE_REQUEST_MESSAGE, UUID_PATTERN, fail, json, readJson } from "./http";
import { WAKE_PORT, cloudSizeForTier } from "./plans";
import { CloudProviderError, type CloudProvider } from "./provider";
import { deleteComputer, logCloud, ownedComputer, reportCloudFailure, type CloudEnv } from "./store";
import { createAnswerOf, type CreateComputerExtras, type CreateComputerOutcome } from "./createOutcome";

/**
 * The server launcher (docs/plans/cloud-6/c6-c8-launcher-spec.md, C6): a lane
 * on a new computer for a caller with no computer of its own (the web, the
 * phone, an automation on ADE Cloud). A person with a computer still launches
 * from it (`cloudLaneLaunchService.ts`).
 *
 * The new computer drives its own launch. The server never runs a long step:
 * it makes the computer (the one create path, `createComputer`), keeps the
 * launch's facts, checks a one-time join code, mints the sign-in link and
 * records progress.
 *
 * The join code is the only secret and the only proof: in the computer's env
 * only, 30 minutes, and minting a link only for the launch's account. The
 * `x-ade-instance` header and the provider's metadata name the launch's
 * computer; they prove nothing about who calls. The code is
 * HMAC(`CLOUD_LAUNCH_JOIN_KEY`, launch id and a random salt), so a start
 * retried after a lost create answer puts the same code in the same
 * computer's env; the server keeps the salt and the code's SHA-256, never
 * the code. The first join spends it. While the launch is still joining and
 * the sign-in it named was not approved, the code may join again (a brain
 * that restarted mid-sign-in, or a join whose answer was lost), at most
 * `MAX_REJOINS` times: each join names a fresh device sign-in.
 */

type LaunchRow = {
  launch_id: string;
  user_id: string;
  state: CloudLaunchState;
  kind: string | null;
  size_id: string | null;
  project_origin: string | null;
  lane_id: string | null;
  lane_name: string | null;
  request_json: string | null;
  instance_id: string | null;
  join_salt: string | null;
  join_hash: string | null;
  join_expires_at: number | null;
  join_used_at: number | null;
  join_rejoins: number;
  join_user_code: string | null;
  approval_url: string | null;
  stages_json: string | null;
  error: string | null;
  session_id: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
};

export type LaunchRouteDeps = {
  provider: CloudProvider | null;
  now: number;
  createComputer: (userId: string, provider: CloudProvider, extras: CreateComputerExtras) => Promise<CreateComputerOutcome>;
  /**
   * C4 on the server: refuses a start for a repository a new computer couldn't
   * clone (`serverGitCheck`). Left out, nothing is checked (an automation's run
   * checked what it could when its rule was registered).
   */
  gitCheck?: (origin: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** Told after the computer wrote progress or the launch was cancelled (an automation's run follows its launch). */
  onProgress?: (record: CloudLaunchRecord) => Promise<void>;
};

const UUID = UUID_PATTERN;
const FILE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** `AgentChatPermissionMode` (the desktop's chat types): the modes a chat on the computer accepts. */
const CHAT_PERMISSION_MODES: ReadonlySet<string> = new Set(["default", "auto", "plan", "edit", "full-auto", "config-toml"]);
const SHORT_ID = /^[A-Za-z0-9_.:/-]{1,200}$/;
const STAGE_ID = /^[a-z][a-z0-9_-]{0,39}$/;
const STAGE_STATUSES: ReadonlySet<CloudLaunchStageStatus> = new Set(["pending", "running", "done", "failed", "skipped", "warning"]);
/** Branch names: what git allows that is safe to carry, at a sane length. */
const BRANCH = /^[A-Za-z0-9._/@+-]{1,250}$/;
const NOT_FOUND = "ADE Cloud has no such launch.";
const notFound = () => fail("not_found", NOT_FOUND, 404);
const badRequest = (message: string) => fail("bad_request", message, 400);
const JOIN_REFUSED = "This computer can't join with that code.";
/** What a launch that never signed its computer in shows once its join window closed. */
const JOIN_NEVER_FINISHED = "The new computer couldn't sign in.";
/** How often a spent join code may join again: a brain whose earlier sign-in didn't finish, never a link mint without end. */
const MAX_REJOINS = 5;
/** The computer joined before its launch's create finished: it asks again in a moment. */
const joinNotReady = () => fail("join_not_ready", "The computer is still being set up.", 409);
/** The stages before which a cancel still deletes the computer: nothing of the agent ran yet. */
const AGENT_STAGE = "agent";

/** `/cloud/launches/<id>/<action>/<rest...>`, or null for any other path. */
export function launchRouteOf(path: string): { launchId: string; action: string | undefined; rest: string[] } | null {
  if (!path.startsWith(`${CLOUD_PATHS.launches}/`)) return null;
  const [launchId = "", action, ...rest] = path.slice(CLOUD_PATHS.launches.length + 1).split("/");
  return { launchId: launchId.toLowerCase(), action, rest };
}

/** The join is the one launch route with no account token: the computer has none yet. */
export function isLaunchJoinRequest(path: string, method: string): boolean {
  const route = launchRouteOf(path);
  return method === "POST" && route?.action === "join" && route.rest.length === 0;
}

const r2KeyOf = (userId: string, launchId: string, fileId: string) => `launches/${userId}/${launchId}/${fileId}`;
const r2PrefixOf = (userId: string, launchId: string) => `launches/${userId}/${launchId}/`;

/** Compares two hex digests without stopping at the first difference. */
function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** 16 random bytes: the launch's join salt, kept in its row from the first start. */
const newJoinSalt = (): string => base64Url(crypto.getRandomValues(new Uint8Array(16)));

/**
 * The computer's join code: HMAC-SHA256(`CLOUD_LAUNCH_JOIN_KEY`, launch id and
 * salt), base64url. A retried start works it out again from the kept salt, so
 * the computer an earlier attempt made (adopted by the create's replay) holds
 * the code the row's hash matches. Null when the key isn't set.
 */
async function joinCodeOf(env: CloudEnv, launchId: string, salt: string): Promise<string | null> {
  const secret = env.CLOUD_LAUNCH_JOIN_KEY?.trim();
  if (!secret) return null;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`ade-cloud-launch-join:v1:${launchId}:${salt}`))));
}

/** `github.com/owner/repo` from any spelling a git remote has, or null for anything that isn't GitHub. */
export function githubOriginOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim().replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  const match = /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?|git@)?github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/i.exec(text);
  if (!match) return null;
  return `github.com/${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}`;
}

function shortString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/[\u0000-\u001f]/g, " ").trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

function parseAttachments(value: unknown): CloudLaunchAttachment[] | string {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > CLOUD_LAUNCH_MAX_FILES) return `A launch takes at most ${CLOUD_LAUNCH_MAX_FILES} files.`;
  const out: CloudLaunchAttachment[] = [];
  for (const entry of value) {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    const fileId = typeof record?.fileId === "string" && FILE_ID.test(record.fileId) ? record.fileId : null;
    const name = shortString(record?.name, 200);
    const contentType = shortString(record?.contentType, 120) ?? "application/octet-stream";
    const sizeBytes = typeof record?.sizeBytes === "number" && Number.isInteger(record.sizeBytes) ? record.sizeBytes : -1;
    if (!fileId || !name || sizeBytes < 0 || sizeBytes > CLOUD_LAUNCH_MAX_FILE_BYTES) return "A file on this launch can't be read.";
    if (out.some((file) => file.fileId === fileId)) return "A file is named twice on this launch.";
    out.push({ fileId, name, contentType, sizeBytes });
  }
  return out;
}

/** The start's body as a launch request, or the sentence that says what's wrong. */
export function parseLaunchRequest(body: Record<string, unknown>): CloudServerLaunchRequest | string {
  const launchId = typeof body.launchId === "string" ? body.launchId.trim().toLowerCase() : "";
  if (!UUID.test(launchId)) return "A launch needs a launch id (a UUID).";
  const kind = body.kind === "chat" || body.kind === "lane" ? body.kind : null;
  if (!kind) return "A launch is a chat or a lane.";
  if (!cloudSizeForTier(body.sizeId)) return "That size isn't one ADE Cloud offers.";
  const project = body.project && typeof body.project === "object" ? body.project as Record<string, unknown> : null;
  const origin = githubOriginOf(project?.origin);
  if (!origin) return "Only GitHub repositories can start a lane on ADE Cloud.";
  const lane = body.lane && typeof body.lane === "object" ? body.lane as Record<string, unknown> : null;
  // The computer's launch reserves this id for its lane, which must be a UUID (`chatLaunchService.start`).
  const laneId = typeof lane?.id === "string" && UUID.test(lane.id.trim().toLowerCase()) ? lane.id.trim().toLowerCase() : null;
  const laneName = shortString(lane?.name, 200);
  if (!laneId || !laneName) return "A launch needs its lane's id (a UUID) and name.";
  const from = lane?.from == null ? null : typeof lane.from === "string" && BRANCH.test(lane.from.trim()) ? lane.from.trim() : undefined;
  const existingBranch = lane?.existingBranch == null ? null
    : typeof lane.existingBranch === "string" && BRANCH.test(lane.existingBranch.trim()) ? lane.existingBranch.trim() : undefined;
  if (from === undefined || existingBranch === undefined) return "That branch name can't be used.";
  if (from && existingBranch) return "A lane starts from a branch or works on one, not both.";
  let chat: CloudServerLaunchRequest["chat"];
  if (kind === "chat") {
    const raw = body.chat && typeof body.chat === "object" ? body.chat as Record<string, unknown> : null;
    const provider = typeof raw?.provider === "string" && /^[a-z][a-z0-9_-]{0,39}$/.test(raw.provider) ? raw.provider : null;
    const modelId = typeof raw?.modelId === "string" && SHORT_ID.test(raw.modelId) ? raw.modelId : null;
    const permissions = typeof raw?.permissions === "string" && CHAT_PERMISSION_MODES.has(raw.permissions) ? raw.permissions : null;
    const effort = raw?.effort == null ? null : typeof raw.effort === "string" && /^[a-z][a-z0-9_-]{0,39}$/.test(raw.effort) ? raw.effort : undefined;
    const prompt = typeof raw?.prompt === "string" ? raw.prompt : null;
    if (!provider || !modelId || !permissions || effort === undefined || prompt == null) return "A chat launch needs its provider, model, permissions and first message.";
    if (prompt.length > CLOUD_LAUNCH_MAX_PROMPT_CHARS) return "The first message is too long.";
    const attachments = parseAttachments(raw?.attachments);
    if (typeof attachments === "string") return attachments;
    if (!prompt.trim() && attachments.length === 0) return "The first message is empty.";
    chat = {
      provider,
      modelId,
      ...(effort ? { effort } : {}),
      permissions,
      ...(raw?.fast === true ? { fast: true } : {}),
      prompt,
      ...(attachments.length ? { attachments } : {}),
    };
  }
  const madeByRaw = body.madeBy && typeof body.madeBy === "object" ? body.madeBy as Record<string, unknown> : null;
  const madeBy: CloudServerLaunchRequest["madeBy"] = madeByRaw?.kind === "automation"
    ? { kind: "automation", ruleId: shortString(madeByRaw.ruleId, 120) }
    : { kind: "person" };
  const channel = body.channel === "beta" ? "beta" : "stable";
  return {
    launchId,
    kind,
    sizeId: body.sizeId as CloudTierId,
    project: { origin },
    lane: { id: laneId, name: laneName, ...(from ? { from } : {}), ...(existingBranch ? { existingBranch } : {}) },
    ...(chat ? { chat } : {}),
    madeBy,
    channel,
  };
}

function parseJsonColumn<T>(text: string | null, fallback: T, where: { launchId: string; column: string }): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    reportCloudFailure("cloud.launch_column_unreadable", { ...where, message: error instanceof Error ? error.message : "unknown" });
    return fallback;
  }
}

/**
 * A launch still `joining` or `needs_approval` once its join window closed
 * never signed its computer in (a computer with no token can't say so
 * itself), so it reads as failed. The row keeps its state: a computer that
 * did sign in at the last moment still reports `joined`.
 */
const joinNeverFinished = (row: LaunchRow, now: number): boolean =>
  (row.state === "joining" || row.state === "needs_approval") && row.join_expires_at != null && row.join_expires_at <= now;

export function recordOf(row: LaunchRow, now: number): CloudLaunchRecord {
  const neverJoined = joinNeverFinished(row, now);
  return {
    launchId: row.launch_id,
    state: neverJoined ? "failed" : row.state,
    kind: row.kind === "chat" || row.kind === "lane" ? row.kind : null,
    sizeId: (row.size_id as CloudTierId | null) ?? null,
    projectOrigin: row.project_origin,
    laneId: row.lane_id,
    laneName: row.lane_name,
    instanceId: row.instance_id,
    request: parseJsonColumn<CloudServerLaunchRequest | null>(row.request_json, null, { launchId: row.launch_id, column: "request_json" }),
    approval: !neverJoined && row.state === "needs_approval" && row.approval_url && row.join_user_code
      ? { url: row.approval_url, userCode: row.join_user_code }
      : null,
    stages: parseJsonColumn<CloudLaunchStage[]>(row.stages_json, [], { launchId: row.launch_id, column: "stages_json" }),
    sessionId: row.session_id,
    error: neverJoined ? JOIN_NEVER_FINISHED : row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

async function readLaunch(env: CloudEnv, launchId: string): Promise<LaunchRow | null> {
  return await env.DB.prepare("select * from cloud_launches where launch_id = ?").bind(launchId).first<LaunchRow>();
}

/** The caller's own launch, or null: another account's launch doesn't exist for it. */
async function ownLaunch(env: CloudEnv, userId: string, launchId: string): Promise<LaunchRow | null> {
  if (!UUID.test(launchId)) return null;
  const row = await readLaunch(env, launchId);
  return row && row.user_id === userId ? row : null;
}

/** The made computer's name: the lane's, as the desktop names a lane's computer. */
const computerNameOf = (laneName: string): string => laneName.replace(/\s+/g, " ").trim().slice(0, 60) || "ADE computer";

/* ---- Start ---- */

async function handleStart(request: Request, env: CloudEnv, userId: string, deps: LaunchRouteDeps): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const parsed = parseLaunchRequest(body);
  if (typeof parsed === "string") return badRequest(parsed);
  return await startServerLaunch(env, userId, parsed, deps);
}

/**
 * Starts one launch, as `POST /cloud/launches` does: for the route, and for
 * an automation's run (C9) with no request. The same checks, the same one
 * create path; 201 for a computer this call made, 200 for a launch that was
 * already started, or the refusal.
 */
export async function startServerLaunch(env: CloudEnv, userId: string, parsed: CloudServerLaunchRequest, deps: LaunchRouteDeps): Promise<Response> {
  const { now } = deps;
  const launchId = parsed.launchId;

  const existing = await readLaunch(env, launchId);
  // The id finds a computer in the shared provider list, so it can only ever be one account's.
  if (existing && existing.user_id !== userId) return badRequest("That launch id can't be used.");
  // The same launch again answers what it is now. A start whose create didn't
  // finish (`making` with no computer) goes on, and the create's own replay
  // gives back a computer an earlier attempt made.
  if (existing && existing.state !== "draft" && !(existing.state === "making" && !existing.instance_id)) {
    return json(recordOf(existing, now), 200);
  }
  if (!deps.provider) return fail("unavailable", "ADE Cloud can't make a computer right now. Try again soon.", 503);
  if (!env.CLOUD_LAUNCH_JOIN_KEY?.trim()) {
    reportCloudFailure("cloud.launch_join_key_missing");
    return fail("unavailable", "ADE Cloud can't start a lane here right now. Try again soon.", 503);
  }

  // A private repository with no git credential that follows the account: refused before anything is made.
  if (deps.gitCheck) {
    const git = await deps.gitCheck(parsed.project.origin);
    if (!git.ok) {
      logCloud("cloud.launch_refused_git", { userId, launchId });
      return fail("git_credential_missing", git.message, 403);
    }
  }

  // Files first: each one named must already be here, at the size it says.
  for (const file of parsed.chat?.attachments ?? []) {
    const bucket = env.CLOUD_CHATS;
    const head = bucket ? await bucket.head(r2KeyOf(userId, launchId, file.fileId)) : null;
    if (!head || head.size !== file.sizeBytes) return badRequest(`Upload "${file.name}" first, then start the launch.`);
  }

  const requestJson = JSON.stringify(parsed);
  const expiresAt = now + CLOUD_LAUNCH_RECORD_TTL_MS;
  // The join code's salt and hash land with the claim, before the provider is
  // called, so a retry after a lost create answer works the same code out again.
  let salt = newJoinSalt();
  let joinCode = (await joinCodeOf(env, launchId, salt))!;
  // One write: a draft becomes the launch, or a new row is the launch. A start
  // racing this one changes nothing here, goes on into the create, and is
  // answered by its replay (409 while the first create is in flight).
  const claimed = await env.DB.prepare(`
    insert into cloud_launches (launch_id, user_id, state, kind, size_id, project_origin, lane_id, lane_name, request_json, join_salt, join_hash, created_at, updated_at, expires_at)
    values (?, ?, 'making', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict (launch_id) do update set state = 'making', kind = excluded.kind, size_id = excluded.size_id,
      project_origin = excluded.project_origin, lane_id = excluded.lane_id, lane_name = excluded.lane_name,
      request_json = excluded.request_json, join_salt = excluded.join_salt, join_hash = excluded.join_hash,
      updated_at = excluded.updated_at, expires_at = excluded.expires_at
    where cloud_launches.user_id = excluded.user_id and cloud_launches.state = 'draft'
  `).bind(launchId, userId, parsed.kind, parsed.sizeId, parsed.project.origin, parsed.lane.id, parsed.lane.name, requestJson, salt, await sha256Hex(joinCode), now, now, expiresAt).run();
  if ((claimed.meta?.changes ?? 0) !== 1) {
    const row = await readLaunch(env, launchId);
    if (!row || row.user_id !== userId) return badRequest("That launch id can't be used.");
    // Not ours to make: another start holds it (or it's a retry of one that never got a computer).
    if (!(row.state === "making" && !row.instance_id)) return json(recordOf(row, now), 200);
    // A retry: the salt the first attempt kept, so the computer it may have made has this code.
    // Every claim writes the salt, so a `making` row always has one.
    if (!row.join_salt) {
      reportCloudFailure("cloud.launch_join_salt_missing", { launchId });
      return fail("unavailable", "ADE Cloud can't start a lane here right now. Try again soon.", 500);
    }
    salt = row.join_salt;
    joinCode = (await joinCodeOf(env, launchId, salt))!;
  }

  const size = cloudSizeForTier(parsed.sizeId)!;
  const metadata: Record<string, string> = {
    [CLOUD_LANE_METADATA.laneId]: parsed.lane.id,
    [CLOUD_LANE_METADATA.laneName]: parsed.lane.name,
    [CLOUD_LANE_METADATA.projectOrigin]: parsed.project.origin,
    [CLOUD_LAUNCH_METADATA.launchId]: launchId,
    ...(parsed.madeBy?.kind === "automation" ? { ade_made_by_agent: "automation" } : {}),
    created_by: "ade",
    // The same id as the launch: a repeated start finds the computer it made.
    ade_request_id: launchId,
  };
  const joinExpiresAt = now + CLOUD_LAUNCH_JOIN_TTL_MS;
  const joinHash = await sha256Hex(joinCode);
  const outcome = await deps.createComputer(userId, deps.provider, {
    body: {
      name: computerNameOf(parsed.lane.name),
      type: size.type,
      resources: { cpu: size.cpu, memory: size.memoryGb },
      metadata,
      publicPorts: [{ port: WAKE_PORT, label: "ADE wake" }],
      channel: parsed.channel ?? "stable",
    },
    serverEnv: { [CLOUD_LAUNCH_ENV.launchId]: launchId, [CLOUD_LAUNCH_ENV.join]: joinCode },
    // A computer this call made: its join window opens with the adoption, in
    // one batch. It holds exactly this call's code, so the hash is rewritten to
    // match it (a start retried across a key rotation works the code out under
    // the new key); a replay keeps the hash the first attempt wrote.
    onMade: (instance) => [
      env.DB.prepare(`
        update cloud_launches set instance_id = ?, join_hash = ?, join_expires_at = ?, join_used_at = null, join_rejoins = 0, join_user_code = null,
          state = case when state = 'making' then 'joining' else state end, updated_at = ?
        where launch_id = ?
      `).bind(instance.id, joinHash, joinExpiresAt, now, launchId),
    ],
  });
  if (outcome.kind === "replayed") {
    // An earlier start made this computer, with the code worked out from the same salt.
    await env.DB.prepare(`
      update cloud_launches set instance_id = coalesce(instance_id, ?), join_expires_at = coalesce(join_expires_at, ?),
        state = case when state = 'making' then 'joining' else state end, updated_at = ?
      where launch_id = ?
    `).bind(outcome.instance.id, joinExpiresAt, now, launchId).run();
  } else if (outcome.kind !== "made") {
    // Refused (hours, computers, disk): nothing was made, and the launch goes
    // back to what it was (a draft keeps its files), so the same start can be
    // sent again once the reason is gone. A create still in flight keeps it.
    if (outcome.kind === "refused") {
      if (existing?.state === "draft") {
        await env.DB.prepare(`
          update cloud_launches set state = 'draft', expires_at = ?, updated_at = ? where launch_id = ? and state = 'making' and instance_id is null
        `).bind(existing.expires_at, now, launchId).run();
      } else {
        await env.DB.prepare("delete from cloud_launches where launch_id = ? and state = 'making' and instance_id is null").bind(launchId).run();
      }
    }
    return createAnswerOf(outcome);
  }
  const after = (await readLaunch(env, launchId))!;
  // A cancel landed while the computer was being made: it goes now.
  if (after.state === "cancelled" && after.instance_id) await deleteLaunchComputer(env, deps.provider, after, deps.now);
  logCloud("cloud.launch_started", { userId, launchId, instanceId: after.instance_id, launchKind: parsed.kind, replay: outcome.kind === "replayed" });
  return json(recordOf(after, now), outcome.kind === "made" ? 201 : 200);
}

/* ---- Files ---- */

async function handlePutFile(request: Request, env: CloudEnv, userId: string, launchId: string, fileId: string, now: number): Promise<Response> {
  if (!UUID.test(launchId) || !FILE_ID.test(fileId)) return notFound();
  const bucket = env.CLOUD_CHATS;
  if (!bucket) return fail("unavailable", "ADE Cloud can't keep files right now. Start without them.", 503);
  const declared = Number(request.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > CLOUD_LAUNCH_MAX_FILE_BYTES) return fail("file_too_big", "Each file can be at most 25 MB.", 413);
  // A draft row comes to exist with the first file, so the cron removes files a start never named.
  await env.DB.prepare(`
    insert into cloud_launches (launch_id, user_id, state, created_at, updated_at, expires_at)
    values (?, ?, 'draft', ?, ?, ?) on conflict (launch_id) do nothing
  `).bind(launchId, userId, now, now, now + CLOUD_LAUNCH_DRAFT_TTL_MS).run();
  const row = await readLaunch(env, launchId);
  if (!row || row.user_id !== userId) return notFound();
  if (row.state !== "draft") return fail("launch_started", "This launch already started. Add files before you start it.", 409);
  const prefix = r2PrefixOf(userId, launchId);
  const listed = await bucket.list({ prefix, limit: CLOUD_LAUNCH_MAX_FILES + 1 });
  const key = r2KeyOf(userId, launchId, fileId);
  if (listed.objects.length >= CLOUD_LAUNCH_MAX_FILES && !listed.objects.some((object) => object.key === key)) {
    return fail("too_many_files", `A launch takes at most ${CLOUD_LAUNCH_MAX_FILES} files.`, 413);
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > CLOUD_LAUNCH_MAX_FILE_BYTES) return fail("file_too_big", "Each file can be at most 25 MB.", 413);
  const contentType = shortString(request.headers.get("content-type"), 120) ?? "application/octet-stream";
  await bucket.put(key, bytes, { httpMetadata: { contentType } });
  return json({ fileId, sizeBytes: bytes.byteLength }, 201);
}

async function handleGetFile(env: CloudEnv, row: LaunchRow, fileId: string): Promise<Response> {
  if (!FILE_ID.test(fileId)) return notFound();
  const request = parseJsonColumn<CloudServerLaunchRequest | null>(row.request_json, null, { launchId: row.launch_id, column: "request_json" });
  const named = request?.chat?.attachments?.some((file) => file.fileId === fileId);
  const object = named && env.CLOUD_CHATS ? await env.CLOUD_CHATS.get(r2KeyOf(row.user_id, row.launch_id, fileId)) : null;
  if (!object) return notFound();
  return new Response(object.body, {
    status: 200,
    headers: { "content-type": object.httpMetadata?.contentType ?? "application/octet-stream", "cache-control": "no-store" },
  });
}

/* ---- Stages ---- */

function parseStages(value: unknown): CloudLaunchStage[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > CLOUD_LAUNCH_MAX_STAGES) return null;
  const out: CloudLaunchStage[] = [];
  for (const entry of value) {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    const id = typeof record?.id === "string" && STAGE_ID.test(record.id) ? record.id : null;
    const status = typeof record?.status === "string" && STAGE_STATUSES.has(record.status as CloudLaunchStageStatus) ? record.status as CloudLaunchStageStatus : null;
    if (!id || !status) return null;
    out.push({ id, status, detail: shortString(record?.detail, 300), error: shortString(record?.error, 300) });
  }
  return out;
}

const COMPUTER_STATES: ReadonlySet<string> = new Set(["joined", "running", "done", "failed"]);

async function handleStages(request: Request, env: CloudEnv, row: LaunchRow, now: number): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  if (row.state === "cancelled" || row.state === "draft" || !row.instance_id) return fail("launch_closed", "This launch isn't running.", 409);
  const state = body.state === undefined ? null : typeof body.state === "string" && COMPUTER_STATES.has(body.state) ? body.state : undefined;
  const stages = parseStages(body.stages);
  if (state === undefined || (body.stages !== undefined && !stages)) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  // A finished launch stays finished: a report that left the computer before the last one can land after it.
  if (row.state === "done" && state !== "done") return fail("launch_closed", "This launch already finished.", 409);
  const sessionId = body.sessionId === undefined ? undefined : shortString(body.sessionId, 120);
  const error = body.error === undefined ? undefined : shortString(body.error, 400);
  await env.DB.prepare(`
    update cloud_launches set
      state = coalesce(?, state),
      stages_json = coalesce(?, stages_json),
      session_id = case when ? then ? else session_id end,
      error = case when ? then ? else error end,
      approval_url = case when ? is not null then null else approval_url end,
      updated_at = ?
    where launch_id = ? and state <> 'cancelled' and (state <> 'done' or ? = 'done')
  `).bind(
    state, stages ? JSON.stringify(stages) : null,
    sessionId !== undefined ? 1 : 0, sessionId ?? null,
    error !== undefined ? 1 : 0, error ?? null,
    state, now, row.launch_id, state,
  ).run();
  return json(recordOf((await readLaunch(env, row.launch_id))!, now));
}

/* ---- Cancel ---- */

async function deleteLaunchComputer(
  env: CloudEnv,
  provider: CloudProvider,
  row: LaunchRow,
  now: number,
  why: { who: string; reason: string } = { who: "launch_cancel", reason: "launch_cancelled" },
): Promise<void> {
  if (!row.instance_id) return;
  const computer = await ownedComputer(env, row.user_id, row.instance_id);
  if (!computer) return;
  await deleteComputer(env, provider, computer, why, now);
}

async function handleCancel(env: CloudEnv, row: LaunchRow, deps: LaunchRouteDeps): Promise<Response> {
  const cannotDelete = () => fail("unavailable", "ADE Cloud can't delete the computer right now. Delete it in Settings › ADE Cloud.", 503);
  if (row.state === "cancelled") {
    // A delete that failed last time is tried again while the computer is still on the account.
    if (row.instance_id && await ownedComputer(env, row.user_id, row.instance_id)) {
      if (!deps.provider) return cannotDelete();
      await deleteLaunchComputer(env, deps.provider, row, deps.now);
    }
    return json(recordOf(row, deps.now));
  }
  const stages = parseJsonColumn<CloudLaunchStage[]>(row.stages_json, [], { launchId: row.launch_id, column: "stages_json" });
  const agentStarted = stages.some((stage) => stage.id === AGENT_STAGE && stage.status !== "pending");
  if (row.state === "done" || agentStarted) {
    return fail("launch_started", "The lane already started. Delete its computer to stop it.", 409);
  }
  // Closed first, so the computer's next write is refused and a create in
  // flight deletes what it made. The computer to delete is the one the row
  // holds after this write: a create that adopted one since the read above is
  // deleted here, never left behind. The agent's stage is checked again in the
  // same write: a report that it started, landing since the read, wins.
  const closed = await env.DB.prepare(`
    update cloud_launches set state = 'cancelled', approval_url = null, updated_at = ? where launch_id = ? and state not in ('done', 'cancelled')
      and not exists (
        select 1 from json_each(case when json_valid(stages_json) then stages_json else '[]' end)
        where json_extract(value, '$.id') = ? and coalesce(json_extract(value, '$.status'), 'pending') <> 'pending'
      )
    returning instance_id
  `).bind(deps.now, row.launch_id, AGENT_STAGE).first<{ instance_id: string | null }>();
  const latest = (await readLaunch(env, row.launch_id))!;
  if (!closed) {
    // Another cancel won (its delete is retried like any), or the launch finished meanwhile.
    if (latest.state === "cancelled") return await handleCancel(env, latest, deps);
    return fail("launch_started", "The lane already started. Delete its computer to stop it.", 409);
  }
  if (closed.instance_id) {
    if (!deps.provider) return cannotDelete();
    await deleteLaunchComputer(env, deps.provider, { ...latest, instance_id: closed.instance_id }, deps.now);
  }
  logCloud("cloud.launch_cancelled", { userId: row.user_id, launchId: row.launch_id, instanceId: closed.instance_id });
  return json(recordOf(latest, deps.now));
}

/* ---- The account-token routes ---- */

export async function routeLaunches(request: Request, path: string, env: CloudEnv, userId: string, deps: LaunchRouteDeps): Promise<Response> {
  if (path === CLOUD_PATHS.launches) {
    return request.method === "POST" ? handleStart(request, env, userId, deps) : notFound();
  }
  const route = launchRouteOf(path);
  if (!route) return notFound();
  const { launchId, action, rest } = route;
  if (action === "files" && rest.length === 1) {
    if (request.method === "PUT") return handlePutFile(request, env, userId, launchId, rest[0]!, deps.now);
    if (request.method === "GET") {
      const row = await ownLaunch(env, userId, launchId);
      return row ? handleGetFile(env, row, rest[0]!) : notFound();
    }
    return notFound();
  }
  if (rest.length) return notFound();
  const row = await ownLaunch(env, userId, launchId);
  if (!row) return notFound();
  if (action === undefined) {
    if (request.method === "GET") return json(recordOf(row, deps.now));
    if (request.method === "DELETE") return await followedBy(await handleCancel(env, row, deps), env, launchId, deps);
    return notFound();
  }
  if (action === "stages" && request.method === "PUT") return await followedBy(await handleStages(request, env, row, deps.now), env, launchId, deps);
  return notFound();
}

/** A write that changed the launch tells `onProgress` (an automation's run). Its failure never fails the write. */
async function followedBy(response: Response, env: CloudEnv, launchId: string, deps: LaunchRouteDeps): Promise<Response> {
  if (!deps.onProgress || !response.ok) return response;
  const row = await readLaunch(env, launchId);
  if (row) {
    await deps.onProgress(recordOf(row, deps.now)).catch((error: unknown) => {
      reportCloudFailure("cloud.launch_progress_follow_failed", { launchId, error: error instanceof Error ? error.message : "unknown" });
    });
  }
  return response;
}

/* ---- The join: the computer, with no account token ---- */

/** The page a person opens to approve the computer's device sign-in. */
function approvalPageOf(env: CloudEnv, request: Request, userCode: string): string {
  const origin = trustedHttpsOrigin(env.DEVICE_PAGE_ORIGIN, { requireExactOrigin: true }) ?? new URL(request.url).origin;
  return `${origin}/device?user_code=${encodeURIComponent(userCode)}`;
}

/** Whether the provider's own record says this computer was made for this launch. */
async function instanceIsLaunchs(provider: CloudProvider, instanceId: string, launchId: string): Promise<boolean | "unreadable"> {
  try {
    const instance = await provider.getInstance(instanceId);
    return instance.status !== "deleted" && instance.metadata[CLOUD_LAUNCH_METADATA.launchId] === launchId;
  } catch (error) {
    if (error instanceof CloudProviderError && error.status === 404) return false;
    reportCloudFailure("cloud.launch_join_check_failed", { launchId, code: error instanceof CloudProviderError ? error.code : "unknown" });
    return "unreadable";
  }
}

/** The join's sentence when the sign-in link couldn't be minted, by the device approval's error. */
const MINT_FAILED: Record<string, string> = {
  expired: "The computer's sign-in expired. It starts a new one.",
  not_found: "ADE has no such sign-in. The computer starts a new one.",
  already_used: "That sign-in was already used. The computer starts a new one.",
};
const MINT_UNAVAILABLE = "ADE's account service can't approve sign-ins right now. Try again in a moment.";

/**
 * Whether the device sign-in a launch's join named was approved: the computer
 * holds (or can still collect) its session, so it never needs to join again.
 */
async function signInApproved(env: CloudEnv, userCode: string | null): Promise<boolean> {
  if (!userCode) return false;
  const signIn = await findByUserCode(env, userCode);
  return signIn?.status === "approved" || signIn?.status === "consumed";
}

/**
 * `POST /cloud/launches/:launch/join`. The code is checked before anything
 * else is read for the caller: its hash, then its time. The code is the only
 * proof; the header and the provider's metadata only name the computer, and
 * must name the launch's. A computer whose launch's create hasn't finished
 * (`making`, no computer recorded yet) is told to ask again
 * (`join_not_ready`). Claimed atomically while the launch is still joining,
 * then the link is minted for the launch's own account; a link that couldn't
 * be minted puts the claim back, so the computer can ask again with a fresh
 * sign-in. A code already spent may join again while the launch is
 * `joining` or `needs_approval` and the sign-in it named was not approved (a
 * brain that restarted mid-sign-in, a lost answer), at most `MAX_REJOINS`
 * times: that join names a fresh device sign-in, and an approval page shown
 * for the old one is withdrawn.
 */
export async function handleLaunchJoin(request: Request, env: CloudEnv, path: string, deps: { provider: CloudProvider | null; now: number }): Promise<Response> {
  const route = launchRouteOf(path);
  const launchId = route?.launchId ?? "";
  if (!UUID.test(launchId)) return notFound();
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const nonce = typeof body.nonce === "string" && body.nonce.length >= 20 && body.nonce.length <= 200 ? body.nonce : null;
  if (!nonce) return fail("join_refused", JOIN_REFUSED, 403);
  const row = await readLaunch(env, launchId);
  if (!row?.join_hash || !sameDigest(await sha256Hex(nonce), row.join_hash)) return fail("join_refused", JOIN_REFUSED, 403);
  const { now } = deps;
  // The create's answer was lost and no retried start adopted the computer yet: its code is right, its window not open.
  if (row.state === "making" && !row.instance_id) return joinNotReady();
  if (row.join_expires_at == null || row.join_expires_at <= now) return fail("join_expired", "This computer's join code expired. Cancel the launch and start it again.", 410);
  const joinExpiresAt = row.join_expires_at;
  const instanceId = request.headers.get(CLOUD_INSTANCE_HEADER)?.trim() ?? "";
  if (!instanceId || instanceId !== row.instance_id) {
    logCloud("cloud.launch_join_wrong_computer", { launchId });
    return fail("join_refused", JOIN_REFUSED, 403);
  }
  if (row.state === "cancelled" || row.state === "failed" || row.state === "done") return fail("launch_closed", "This launch isn't running.", 409);

  if (body.needsApproval === true) {
    // Only after the code was spent by this computer: it names the sign-in a person approves.
    if (row.join_used_at == null || !row.join_user_code) return fail("join_refused", JOIN_REFUSED, 403);
    if (row.state !== "joining" && row.state !== "needs_approval") return fail("launch_closed", "This launch is past its join.", 409);
    // A sign-in the person didn't approve in its 10 minutes is replaced by a
    // fresh one from the same computer; the person still approves it themselves.
    const freshCode = typeof body.userCode === "string" ? normalizeUserCode(body.userCode) : null;
    // A sign-in already approved is never swapped for another: the computer has its session.
    if (freshCode && freshCode !== row.join_user_code && await signInApproved(env, row.join_user_code)) {
      return fail("join_used", "This computer's join code was already used.", 409);
    }
    const userCode = freshCode ?? row.join_user_code;
    await env.DB.prepare(`
      update cloud_launches set state = 'needs_approval', join_user_code = ?, approval_url = ?, updated_at = ? where launch_id = ? and state in ('joining', 'needs_approval')
    `).bind(userCode, approvalPageOf(env, request, userCode), now, launchId).run();
    logCloud("cloud.launch_needs_approval", { launchId });
    return json({ ok: true, state: "needs_approval", joinExpiresAt });
  }

  const rejoin = row.join_used_at != null;
  const joinUsed = () => fail("join_used", "This computer's join code was already used.", 409);
  if (rejoin && row.state !== "joining" && row.state !== "needs_approval") return joinUsed();
  if (rejoin && (row.join_rejoins >= MAX_REJOINS || await signInApproved(env, row.join_user_code))) {
    logCloud("cloud.launch_rejoin_refused", { launchId, rejoins: row.join_rejoins });
    return joinUsed();
  }
  const userCode = typeof body.userCode === "string" ? normalizeUserCode(body.userCode) : null;
  if (!userCode) return badRequest("The join needs the computer's sign-in code.");
  if (!deps.provider) return fail("unavailable", "ADE Cloud can't check this computer right now. Try again soon.", 503);
  const isLaunchs = await instanceIsLaunchs(deps.provider, instanceId, launchId);
  if (isLaunchs === "unreadable") return fail("unavailable", "ADE Cloud can't check this computer right now. Try again soon.", 503);
  if (!isLaunchs) {
    reportCloudFailure("cloud.launch_join_metadata_mismatch", { launchId });
    return fail("join_refused", JOIN_REFUSED, 403);
  }
  // The claim holds only if nothing moved since the read: the same spend (none,
  // or the one a rejoin saw), the same rejoin count, the code, its time, the
  // computer, and a launch still joining (a cancel during the provider check
  // above wins). A rejoin counts against `MAX_REJOINS`.
  const rejoinCount = rejoin ? 1 : 0;
  const claimed = await env.DB.prepare(`
    update cloud_launches set join_used_at = ?, join_user_code = ?, approval_url = null, join_rejoins = join_rejoins + ?,
      state = case when state = 'needs_approval' then 'joining' else state end, updated_at = ?
    where launch_id = ? and coalesce(join_used_at, 0) = ? and join_rejoins = ? and join_hash = ? and join_expires_at > ? and instance_id = ?
      and state in ('joining', 'needs_approval')
  `).bind(now, userCode, rejoinCount, now, launchId, row.join_used_at ?? 0, row.join_rejoins, row.join_hash, now, instanceId).run();
  if ((claimed.meta?.changes ?? 0) !== 1) {
    const latest = await readLaunch(env, launchId);
    return latest && latest.state !== "joining" && latest.state !== "needs_approval"
      ? fail("launch_closed", "This launch isn't running.", 409)
      : joinUsed();
  }
  const link = await mintDeviceApprovalLink(env, { userId: row.user_id, userCode, origin: new URL(request.url).origin }, resolveDeviceRequestOptions({}));
  if (!link.ok) {
    // Back to what the claim found: an unspent code stays unspent, and a rejoin that minted nothing isn't counted.
    logCloud("cloud.launch_join_mint_failed", { launchId, error: link.error, rejoin });
    await env.DB.prepare("update cloud_launches set join_used_at = ?, join_user_code = ?, join_rejoins = join_rejoins - ? where launch_id = ? and join_used_at = ?")
      .bind(row.join_used_at, row.join_user_code, rejoinCount, launchId, now).run();
    return fail(link.error, MINT_FAILED[link.error] ?? MINT_UNAVAILABLE, link.status);
  }
  logCloud("cloud.launch_joined", { launchId, userId: row.user_id, rejoin });
  return json({ url: link.url, joinExpiresAt });
}

/* ---- The minute cron ---- */

/** The computers whose launch is still joining inside its window: the no-check-in sleep leaves them awake. */
export async function computersJoiningLaunches(env: CloudEnv, now: number): Promise<Set<string>> {
  const rows = (await env.DB.prepare(`
    select instance_id from cloud_launches where state in ('joining', 'needs_approval') and join_expires_at > ? and instance_id is not null
  `).bind(now).all<{ instance_id: string }>()).results ?? [];
  return new Set(rows.map((row) => row.instance_id));
}


/**
 * How long past its join window a launch whose computer never signed in is
 * left alone: a join claimed in the window's last minute can still have its
 * sign-in approved (10 minutes) and report `joined`.
 */
const JOIN_GIVE_UP_GRACE_MS = 15 * 60_000;
/** Most never-joined launches one tick ends; the rest wait for the next. */
const UNJOINED_PER_TICK = 20;

/**
 * Launches whose computer never signed in, past the join window and a grace:
 * reads already showed them failed, and now the computer is deleted and the
 * row says failed, so it stops counting against the account's computers and
 * disk. The computer goes first: a delete that fails leaves the launch for the
 * next tick. `onProgress` follows each (an automation's run ends with it). One
 * indexed read when there are none.
 */
export async function failUnjoinedLaunches(
  env: CloudEnv,
  deps: { provider: CloudProvider | null; now?: number; onProgress?: (record: CloudLaunchRecord) => Promise<void> },
): Promise<number> {
  const now = deps.now ?? Date.now();
  const rows = (await env.DB.prepare(`
    select * from cloud_launches where state in ('joining', 'needs_approval') and join_expires_at <= ? limit ?
  `).bind(now - JOIN_GIVE_UP_GRACE_MS, UNJOINED_PER_TICK).all<LaunchRow>()).results ?? [];
  const provider = deps.provider;
  if (!provider) return 0;
  let ended = 0;
  for (const row of rows) {
    // Claimed first: a join that lands after this read finds the launch closed
    // (`launch_closed`), and one that landed before it makes this claim miss,
    // so a computer that did join is never deleted.
    const failed = await env.DB.prepare(`
      update cloud_launches set state = 'failed', error = ?, approval_url = null, updated_at = ?
      where launch_id = ? and state in ('joining', 'needs_approval') and join_expires_at <= ?
    `).bind(JOIN_NEVER_FINISHED, now, row.launch_id, now - JOIN_GIVE_UP_GRACE_MS).run();
    if ((failed.meta?.changes ?? 0) !== 1) continue;
    try {
      await deleteLaunchComputer(env, provider, row, now, { who: "launch_join", reason: "launch_never_joined" });
    } catch (error) {
      // The read below tries the delete again on later ticks, until the computer is gone.
      reportCloudFailure("cloud.launch_never_joined_end_failed", { launchId: row.launch_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
    }
    try {
      ended += 1;
      logCloud("cloud.launch_never_joined", { userId: row.user_id, launchId: row.launch_id, instanceId: row.instance_id });
      const latest = await readLaunch(env, row.launch_id);
      if (latest && deps.onProgress) await deps.onProgress(recordOf(latest, now));
    } catch (error) {
      reportCloudFailure("cloud.launch_never_joined_end_failed", { launchId: row.launch_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
    }
  }
  // A launch failed here whose computer is still on the account (a delete that
  // failed, or a Worker that stopped between the claim and the delete): delete again.
  const left = (await env.DB.prepare(`
    select l.* from cloud_launches l join cloud_computers c on c.instance_id = l.instance_id and c.user_id = l.user_id
    where l.state = 'failed' and l.error = ? and c.deleted_at is null limit ?
  `).bind(JOIN_NEVER_FINISHED, UNJOINED_PER_TICK).all<LaunchRow>()).results ?? [];
  for (const row of left) {
    await deleteLaunchComputer(env, provider, row, now, { who: "launch_join", reason: "launch_never_joined" }).catch((error: unknown) => {
      reportCloudFailure("cloud.launch_never_joined_end_failed", { launchId: row.launch_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
    });
  }
  return ended;
}

/** Most launch records one tick deletes; the rest wait for the next. */
const EXPIRE_PER_TICK = 50;

/** Deletes launch records past `expires_at`, and their files. One indexed read when there are none. */
export async function expireCloudLaunches(env: CloudEnv, now = Date.now()): Promise<number> {
  const rows = (await env.DB.prepare("select launch_id, user_id from cloud_launches where expires_at < ? limit ?")
    .bind(now, EXPIRE_PER_TICK).all<Pick<LaunchRow, "launch_id" | "user_id">>()).results ?? [];
  if (rows.length === 0) return 0;
  const bucket = env.CLOUD_CHATS;
  for (const row of rows) {
    if (!bucket) break;
    // Every page: parallel uploads can leave more than the 10 a launch takes, and this is their only cleanup.
    let cursor: string | undefined;
    do {
      const listed = await bucket.list({ prefix: r2PrefixOf(row.user_id, row.launch_id), cursor, limit: 100 });
      if (listed.objects.length) await bucket.delete(listed.objects.map((object) => object.key));
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }
  await env.DB.batch(rows.map((row) => env.DB.prepare("delete from cloud_launches where launch_id = ? and expires_at < ?").bind(row.launch_id, now)));
  return rows.length;
}

/** Every launch of one account, for an account deletion. */
export async function deleteAccountLaunches(env: Pick<CloudEnv, "DB" | "CLOUD_CHATS">, userId: string): Promise<void> {
  const bucket = env.CLOUD_CHATS;
  if (bucket) {
    let cursor: string | undefined;
    do {
      const listed = await bucket.list({ prefix: `launches/${userId}/`, cursor, limit: 500 });
      if (listed.objects.length) await bucket.delete(listed.objects.map((object) => object.key));
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }
  await env.DB.prepare("delete from cloud_launches where user_id = ?").bind(userId).run();
}
