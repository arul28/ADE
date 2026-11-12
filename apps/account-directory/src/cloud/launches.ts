import { mintDeviceApprovalLink } from "../deviceAppApproval";
import { normalizeUserCode, resolveDeviceRequestOptions } from "../deviceAuthorization";
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
  type CloudInstance,
  type CloudLaunchAttachment,
  type CloudLaunchRecord,
  type CloudLaunchStage,
  type CloudLaunchStageStatus,
  type CloudLaunchState,
  type CloudServerLaunchRequest,
  type CloudTierId,
} from "./contract";
import { UNREADABLE_REQUEST_MESSAGE, fail, json, readJson } from "./http";
import { WAKE_PORT, cloudSizeForTier } from "./plans";
import { CloudProviderError, type CloudProvider } from "./provider";
import { deleteComputer, logCloud, ownedComputer, reportCloudFailure, type CloudEnv } from "./store";
import type { CreateComputerExtras } from "./routes";

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
 * The join code is the only secret: random, in the computer's env only,
 * single use, 30 minutes, bound to the launch's computer (`x-ade-instance`
 * plus the provider's own metadata) and minting a link only for the launch's
 * account. The server keeps its SHA-256, never the code.
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
  join_hash: string | null;
  join_expires_at: number | null;
  join_used_at: number | null;
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
  createComputer: (userId: string, provider: CloudProvider, extras: CreateComputerExtras) => Promise<Response>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LANE_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const SHORT_ID = /^[A-Za-z0-9_.:/-]{1,200}$/;
const STAGE_ID = /^[a-z][a-z0-9_-]{0,39}$/;
const STAGE_STATUSES: ReadonlySet<CloudLaunchStageStatus> = new Set(["pending", "running", "done", "failed", "skipped", "warning"]);
/** Branch names: what git allows that is safe to carry, at a sane length. */
const BRANCH = /^[A-Za-z0-9._/@+-]{1,250}$/;
const NOT_FOUND = "ADE Cloud has no such launch.";
const notFound = () => fail("not_found", NOT_FOUND, 404);
const badRequest = (message: string) => fail("bad_request", message, 400);
const JOIN_REFUSED = "This computer can't join with that code.";
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

/** 32 random bytes, base64url: the computer's one-time join code. */
function newJoinCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
  const laneId = typeof lane?.id === "string" && LANE_ID.test(lane.id.trim()) ? lane.id.trim() : null;
  const laneName = shortString(lane?.name, 200);
  if (!laneId || !laneName) return "A launch needs its lane's id and name.";
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
    const permissions = typeof raw?.permissions === "string" && /^[a-z][a-z0-9_-]{0,39}$/.test(raw.permissions) ? raw.permissions : null;
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

function parseJsonColumn<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function recordOf(row: LaunchRow): CloudLaunchRecord {
  return {
    launchId: row.launch_id,
    state: row.state,
    kind: row.kind === "chat" || row.kind === "lane" ? row.kind : null,
    sizeId: (row.size_id as CloudTierId | null) ?? null,
    projectOrigin: row.project_origin,
    laneId: row.lane_id,
    laneName: row.lane_name,
    instanceId: row.instance_id,
    request: parseJsonColumn<CloudServerLaunchRequest | null>(row.request_json, null),
    approval: row.state === "needs_approval" && row.approval_url && row.join_user_code
      ? { url: row.approval_url, userCode: row.join_user_code }
      : null,
    stages: parseJsonColumn<CloudLaunchStage[]>(row.stages_json, []),
    sessionId: row.session_id,
    error: row.error,
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
  const { now } = deps;
  const launchId = parsed.launchId;

  const existing = await readLaunch(env, launchId);
  // The id finds a computer in the shared provider list, so it can only ever be one account's.
  if (existing && existing.user_id !== userId) return badRequest("That launch id can't be used.");
  // The same launch again answers what it is now. A start whose create didn't
  // finish (`making` with no computer) goes on, and the create's own replay
  // gives back a computer an earlier attempt made.
  if (existing && existing.state !== "draft" && !(existing.state === "making" && !existing.instance_id)) {
    return json(recordOf(existing), 200);
  }
  if (!deps.provider) return fail("unavailable", "ADE Cloud can't make a computer right now. Try again soon.", 503);

  // Files first: each one named must already be here, at the size it says.
  for (const file of parsed.chat?.attachments ?? []) {
    const bucket = env.CLOUD_CHATS;
    const head = bucket ? await bucket.head(r2KeyOf(userId, launchId, file.fileId)) : null;
    if (!head || head.size !== file.sizeBytes) return badRequest(`Upload "${file.name}" first, then start the launch.`);
  }

  const requestJson = JSON.stringify(parsed);
  const expiresAt = now + CLOUD_LAUNCH_RECORD_TTL_MS;
  // One write: a draft becomes the launch, or a new row is the launch. A
  // start racing this one finds the row and is answered by it.
  const claimed = await env.DB.prepare(`
    insert into cloud_launches (launch_id, user_id, state, kind, size_id, project_origin, lane_id, lane_name, request_json, created_at, updated_at, expires_at)
    values (?, ?, 'making', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict (launch_id) do update set state = 'making', kind = excluded.kind, size_id = excluded.size_id,
      project_origin = excluded.project_origin, lane_id = excluded.lane_id, lane_name = excluded.lane_name,
      request_json = excluded.request_json, updated_at = excluded.updated_at, expires_at = excluded.expires_at
    where cloud_launches.user_id = excluded.user_id and cloud_launches.state = 'draft'
  `).bind(launchId, userId, parsed.kind, parsed.sizeId, parsed.project.origin, parsed.lane.id, parsed.lane.name, requestJson, now, now, expiresAt).run();
  if ((claimed.meta?.changes ?? 0) !== 1) {
    const row = await readLaunch(env, launchId);
    if (!row || row.user_id !== userId) return badRequest("That launch id can't be used.");
    // Not ours to make: another start holds it (or it's a retry of one that never got a computer).
    if (!(row.state === "making" && !row.instance_id)) return json(recordOf(row), 200);
  }

  const size = cloudSizeForTier(parsed.sizeId)!;
  const joinCode = newJoinCode();
  const joinHash = await sha256Hex(joinCode);
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
  const response = await deps.createComputer(userId, deps.provider, {
    body: {
      name: computerNameOf(parsed.lane.name),
      type: size.type,
      resources: { cpu: size.cpu, memory: size.memoryGb },
      metadata,
      publicPorts: [{ port: WAKE_PORT, label: "ADE wake" }],
      channel: parsed.channel ?? "stable",
    },
    serverEnv: { [CLOUD_LAUNCH_ENV.launchId]: launchId, [CLOUD_LAUNCH_ENV.join]: joinCode },
    // Only a computer this call made carries this code: its hash lands with the adoption, in one batch.
    onMade: (instance) => [
      env.DB.prepare(`
        update cloud_launches set instance_id = ?, join_hash = ?, join_expires_at = ?, join_used_at = null, join_user_code = null,
          state = case when state = 'making' then 'joining' else state end, updated_at = ?
        where launch_id = ?
      `).bind(instance.id, joinHash, now + CLOUD_LAUNCH_JOIN_TTL_MS, now, launchId),
    ],
  });
  if (response.status === 200) {
    // An earlier start made this computer (its code is the one already kept).
    const instance = await response.clone().json() as CloudInstance;
    await env.DB.prepare(`
      update cloud_launches set instance_id = coalesce(instance_id, ?), state = case when state = 'making' then 'joining' else state end, updated_at = ?
      where launch_id = ?
    `).bind(instance.id, now, launchId).run();
  } else if (response.status !== 201) {
    // Refused (hours, computers, disk): nothing was made, and the launch goes
    // back to what it was (a draft keeps its files), so the same start can be
    // sent again once the reason is gone. A create still in flight (409) keeps it.
    if (response.status !== 409) {
      if (existing?.state === "draft") {
        await env.DB.prepare(`
          update cloud_launches set state = 'draft', expires_at = ?, updated_at = ? where launch_id = ? and state = 'making' and instance_id is null
        `).bind(existing.expires_at, now, launchId).run();
      } else {
        await env.DB.prepare("delete from cloud_launches where launch_id = ? and state = 'making' and instance_id is null").bind(launchId).run();
      }
    }
    return response;
  }
  const after = (await readLaunch(env, launchId))!;
  // A cancel landed while the computer was being made: it goes now.
  if (after.state === "cancelled" && after.instance_id) await deleteLaunchComputer(env, deps.provider, after, deps.now);
  logCloud("cloud.launch_started", { userId, launchId, instanceId: after.instance_id, launchKind: parsed.kind, replay: response.status === 200 });
  return json(recordOf(after), response.status === 201 ? 201 : 200);
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
  const named = recordOf(row).request?.chat?.attachments?.some((file) => file.fileId === fileId);
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
    where launch_id = ? and state <> 'cancelled'
  `).bind(
    state, stages ? JSON.stringify(stages) : null,
    sessionId !== undefined ? 1 : 0, sessionId ?? null,
    error !== undefined ? 1 : 0, error ?? null,
    state, now, row.launch_id,
  ).run();
  return json(recordOf((await readLaunch(env, row.launch_id))!));
}

/* ---- Cancel ---- */

async function deleteLaunchComputer(env: CloudEnv, provider: CloudProvider, row: LaunchRow, now: number): Promise<void> {
  if (!row.instance_id) return;
  const computer = await ownedComputer(env, row.user_id, row.instance_id);
  if (!computer) return;
  await deleteComputer(env, provider, computer, { who: "launch_cancel", reason: "launch_cancelled" }, now);
}

async function handleCancel(env: CloudEnv, row: LaunchRow, deps: LaunchRouteDeps): Promise<Response> {
  if (row.state === "cancelled") return json(recordOf(row));
  const agentStarted = recordOf(row).stages.some((stage) => stage.id === AGENT_STAGE && stage.status !== "pending");
  if (row.state === "done" || agentStarted) {
    return fail("launch_started", "The lane already started. Delete its computer to stop it.", 409);
  }
  // Closed first, so the computer's next write is refused and a create in flight deletes what it made.
  await env.DB.prepare("update cloud_launches set state = 'cancelled', approval_url = null, updated_at = ? where launch_id = ?").bind(deps.now, row.launch_id).run();
  if (row.instance_id) {
    if (!deps.provider) return fail("unavailable", "ADE Cloud can't delete the computer right now. Delete it in Settings › ADE Cloud.", 503);
    await deleteLaunchComputer(env, deps.provider, row, deps.now);
  }
  logCloud("cloud.launch_cancelled", { userId: row.user_id, launchId: row.launch_id, instanceId: row.instance_id });
  return json(recordOf((await readLaunch(env, row.launch_id))!));
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
    if (request.method === "GET") return json(recordOf(row));
    if (request.method === "DELETE") return handleCancel(env, row, deps);
    return notFound();
  }
  if (action === "stages" && request.method === "PUT") return handleStages(request, env, row, deps.now);
  return notFound();
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
    return "unreadable";
  }
}

/**
 * `POST /cloud/launches/:launch/join`. The code is checked before anything
 * else is read for the caller: its hash, its time, and the computer that
 * presents it (the header, against the launch's computer and the provider's
 * metadata on it). Spent atomically, then the link is minted for the
 * launch's own account; a link that couldn't be minted gives the code back,
 * so the computer can ask again with a fresh sign-in.
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
  if (row.join_expires_at == null || row.join_expires_at <= now) return fail("join_expired", "This computer's join code expired. Cancel the launch and start it again.", 410);
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
    await env.DB.prepare(`
      update cloud_launches set state = 'needs_approval', approval_url = ?, updated_at = ? where launch_id = ? and state in ('joining', 'needs_approval')
    `).bind(approvalPageOf(env, request, row.join_user_code), now, launchId).run();
    logCloud("cloud.launch_needs_approval", { launchId });
    return json({ ok: true, state: "needs_approval" });
  }

  if (row.join_used_at != null) return fail("join_used", "This computer's join code was already used.", 409);
  const userCode = typeof body.userCode === "string" ? normalizeUserCode(body.userCode) : null;
  if (!userCode) return badRequest("The join needs the computer's sign-in code.");
  if (!deps.provider) return fail("unavailable", "ADE Cloud can't check this computer right now. Try again soon.", 503);
  const isLaunchs = await instanceIsLaunchs(deps.provider, instanceId, launchId);
  if (isLaunchs === "unreadable") return fail("unavailable", "ADE Cloud can't check this computer right now. Try again soon.", 503);
  if (!isLaunchs) {
    reportCloudFailure("cloud.launch_join_metadata_mismatch", { launchId });
    return fail("join_refused", JOIN_REFUSED, 403);
  }
  const claimed = await env.DB.prepare(`
    update cloud_launches set join_used_at = ?, join_user_code = ?, updated_at = ?
    where launch_id = ? and join_used_at is null and join_hash = ? and join_expires_at > ? and instance_id = ?
  `).bind(now, userCode, now, launchId, row.join_hash, now, instanceId).run();
  if ((claimed.meta?.changes ?? 0) !== 1) return fail("join_used", "This computer's join code was already used.", 409);
  const link = await mintDeviceApprovalLink(env, { userId: row.user_id, userCode, origin: new URL(request.url).origin }, resolveDeviceRequestOptions({}));
  if (!link.ok) {
    await env.DB.prepare("update cloud_launches set join_used_at = null, join_user_code = null where launch_id = ? and join_used_at = ?")
      .bind(launchId, now).run();
    const message = link.error === "expired" ? "The computer's sign-in expired. It starts a new one."
      : link.error === "not_found" ? "ADE has no such sign-in. The computer starts a new one."
        : link.error === "already_used" ? "That sign-in was already used. The computer starts a new one."
          : "ADE's account service can't approve sign-ins right now. Try again in a moment.";
    return fail(link.error, message, link.status);
  }
  logCloud("cloud.launch_joined", { launchId, userId: row.user_id });
  return json({ url: link.url });
}

/* ---- The minute cron: expiry only ---- */

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
    const listed = await bucket.list({ prefix: r2PrefixOf(row.user_id, row.launch_id), limit: CLOUD_LAUNCH_MAX_FILES + 5 });
    if (listed.objects.length) await bucket.delete(listed.objects.map((object) => object.key));
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
