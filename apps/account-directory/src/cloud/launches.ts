import { mintDeviceApprovalLink } from "../deviceAppApproval";
import { unsettledPhoneMilli } from "./credits";
import { findByUserCode, normalizeUserCode, resolveDeviceRequestOptions } from "../deviceAuthorization";
import { readBoundedBytes, sha256Hex } from "../sinkUtils";
import { trustedHttpsOrigin } from "../trustedOrigin";
import {
  CLOUD_AUTO_SIZE,
  CLOUD_AUTO_SIZE_MEMORY_MS,
  CLOUD_INSTANCE_HEADER,
  CLOUD_LANE_METADATA,
  CLOUD_LAUNCH_DRAFT_TTL_MS,
  CLOUD_LAUNCH_ENV,
  CLOUD_LAUNCH_JOIN_TTL_MS,
  CLOUD_LAUNCH_MAX_ARGS_BYTES,
  CLOUD_LAUNCH_MAX_DRAFT_BYTES_PER_ACCOUNT,
  CLOUD_LAUNCH_MAX_FILE_BYTES,
  CLOUD_LAUNCH_MAX_FILES,
  CLOUD_LAUNCH_MAX_OPEN_DRAFTS,
  CLOUD_LAUNCH_MAX_PROMPT_CHARS,
  CLOUD_LAUNCH_MAX_STAGES,
  CLOUD_LAUNCH_METADATA,
  CLOUD_LAUNCH_RECORD_TTL_MS,
  CLOUD_LAUNCH_SIGN_IN_TIMED_OUT,
  CLOUD_PATHS,
  type CloudAutoSizeRefusal,
  type CloudLaunchAttachment,
  type CloudLaunchAutoSize,
  type CloudLaunchList,
  type CloudLaunchRecord,
  type CloudLaunchSignIn,
  type CloudLaunchSummary,
  type CloudLaunchStage,
  type CloudLaunchSizeChoice,
  type CloudLaunchStageStatus,
  type CloudLaunchState,
  type CloudMachineLaunchFacts,
  type CloudServerLaunchRequest,
  type CloudTierId,
  type CloudUpdateChannel,
  CLOUD_REMOTE_SIGN_IN_KINDS,
  cloudRemoteSignInOf,
} from "./contract";
import { ROW_ID, UNREADABLE_REQUEST_MESSAGE, UUID_PATTERN, badRequest, clippedText, fail, json, readJson, shortString } from "./http";
import { WAKE_PORT, cloudSizeForTier, type CloudSize } from "./plans";
import { CloudProviderError, type CloudProvider } from "./provider";
import { requestNetwork } from "./sponsoredConsent";
import { noteComputerJoin } from "./sponsoredSmall";
import {
  LAUNCH_COMPUTER_DELETED,
  deleteComputer,
  isOutOfHoursFor,
  listComputers,
  liveUsedMilli,
  loadAccount,
  logCloud,
  ownedComputer,
  parseJsonColumn,
  readSetting,
  reportCloudFailure,
  type CloudEnv,
  type ComputerRow,
} from "./store";
import { createAnswerOf, type CreateComputerExtras, type CreateComputerOutcome } from "./createOutcome";
import { launchChannel, readUpdateChannel, readUpdateTargets } from "./updates";
import { markKeepLaneStatement } from "./lanesWithoutComputer";
import type { ServerGitCheck } from "./accountVault";
// A cycle (chatMessages imports this file); only called at request time.
import { carryLaunchMessagesToChat } from "./chatMessages";
import {
  LAUNCH_MESSAGE_ID,
  accountLaunchMessagesStatement,
  dropFirstMessageStatement,
  expiredLaunchMessagesStatement,
  failQueuedMessagesStatement,
  firstMessageDeliveredStatement,
  chatMessagesDeliveredStatement,
  firstMessageStatement,
  refusedStartMessagesStatement,
  routeLaunchMessages,
} from "./launchMessages";

/**
 * The server launcher (docs/plans/cloud-6/c6-c8-launcher-spec.md, C6): every
 * lane on a new computer of its own. An ADE app or CLI sends it and then
 * follows the computer's own launch (`cloudLaneLaunchService.ts`); a caller
 * with no computer (the web, the phone, an automation on ADE Cloud) reads
 * the record here.
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

/**
 * `retrying`: a Retry holds the launch while it deletes the failed computer
 * (`restartFailedLaunch`). Never shown: the record reads `making` with no
 * computer. Starts answer it as it is, and the old computer's reports and
 * joins are refused.
 */
type LaunchRowState = CloudLaunchState | "retrying";

export type LaunchRow = {
  launch_id: string;
  user_id: string;
  state: LaunchRowState;
  kind: string | null;
  size_id: string | null;
  /** `CloudLaunchAutoSize["why"]` once the computer is bigger than the size asked for (migration 0036). */
  auto_size: string | null;
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
  /** Migration 0039: the saved chat this launch continues (`continueChat`). */
  continue_machine_key?: string | null;
  continue_chat_id?: string | null;
  session_id: string | null;
  /** While `waiting_for_sign_in`: CloudLaunchSignIn as JSON (migration 0038). */
  sign_in_json: string | null;
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
  gitCheck?: (origin: string) => Promise<ServerGitCheck>;
  /**
   * The owner's kill switch and the account's hourly launch limit, asked only
   * for a launch that makes a new computer (never a replay of one). Left out
   * (an automation's run), only the create's own checks run.
   */
  refuseNewLaunch?: () => Promise<Response | null>;
  /** Told after the computer wrote progress or the launch was cancelled (an automation's run follows its launch). */
  onProgress?: (record: CloudLaunchRecord) => Promise<void>;
};

const UUID = UUID_PATTERN;
const FILE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** `AgentChatPermissionMode` (the desktop's chat types): the modes a chat on the computer accepts. */
const CHAT_PERMISSION_MODES: ReadonlySet<string> = new Set(["default", "auto", "plan", "edit", "full-auto", "config-toml"]);
/**
 * An ADE model registry id, as the desktop sends it: OpenCode and Pi ids carry
 * the provider's own model name `encodeURIComponent`-escaped
 * (`opencode/openrouter/anthropic%2Fclaude-…`), so that alphabet too.
 */
const MODEL_ID = /^[A-Za-z0-9_.:/%!~*'()-]{1,300}$/;
const STAGE_ID = /^[a-z][a-z0-9_-]{0,39}$/;
const STAGE_STATUSES: ReadonlySet<CloudLaunchStageStatus> = new Set(["pending", "running", "done", "failed", "skipped", "warning"]);
/** Branch names: what git allows that is safe to carry, at a sane length. */
const BRANCH = /^[A-Za-z0-9._/@+-]{1,250}$/;
const utf8 = new TextEncoder();
/** A value's JSON size in bytes (UTF-8), the unit of `CLOUD_LAUNCH_MAX_ARGS_BYTES`; a string's length counts UTF-16 units. */
const jsonBytes = (value: unknown): number => utf8.encode(JSON.stringify(value)).byteLength;

const NOT_FOUND = "ADE Cloud has no such launch.";
const notFound = () => fail("not_found", NOT_FOUND, 404);
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

export const r2KeyOf = (userId: string, launchId: string, fileId: string) => `launches/${userId}/${launchId}/${fileId}`;
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

/** A new lane's name from the first message: its first line, a few words. The computer renames it (`autoName`). */
function laneNameFromPrompt(chat: unknown): string {
  const prompt = chat && typeof chat === "object" ? (chat as Record<string, unknown>).prompt : null;
  const line = typeof prompt === "string" ? prompt.replace(/[\u0000-\u001f]/g, " ").trim().split(/\s+/).slice(0, 8).join(" ") : "";
  return (line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line) || "New lane";
}

export function parseAttachments(value: unknown): CloudLaunchAttachment[] | string {
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

/** A parsed start: a chat always names its first message (the launch id when the client left it out). */
export type ParsedLaunchRequest = CloudServerLaunchRequest & { chat?: NonNullable<CloudServerLaunchRequest["chat"]> & { messageId: string } };

/** The start's body as a launch request, or the sentence that says what's wrong. */
export function parseLaunchRequest(body: Record<string, unknown>): ParsedLaunchRequest | string {
  const launchId = typeof body.launchId === "string" ? body.launchId.trim().toLowerCase() : "";
  if (!UUID.test(launchId)) return "A launch needs a launch id (a UUID).";
  const kind = body.kind === "chat" || body.kind === "lane" ? body.kind : null;
  if (!kind) return "A launch is a chat or a lane.";
  // Left out (the web, the phone): Small, ADE's default, which may move up once (`CLOUD_AUTO_SIZE`).
  const sizeOmitted = body.sizeId === undefined || body.sizeId === null;
  const sizeId = sizeOmitted ? CLOUD_AUTO_SIZE.from : body.sizeId;
  if (!cloudSizeForTier(sizeId)) return "That size isn't one ADE Cloud offers.";
  const project = body.project && typeof body.project === "object" ? body.project as Record<string, unknown> : null;
  const origin = githubOriginOf(project?.origin);
  if (!origin) return "Only GitHub repositories can start a lane on ADE Cloud.";
  const lane = body.lane && typeof body.lane === "object" ? body.lane as Record<string, unknown> : null;
  // The computer's launch reserves this id for its lane, which must be a UUID (`chatLaunchService.start`).
  // Left out (a new lane from the web or the phone): the launch id, so a retried start names the same lane.
  const laneId = lane?.id == null ? launchId
    : typeof lane.id === "string" && UUID.test(lane.id.trim().toLowerCase()) ? lane.id.trim().toLowerCase() : null;
  // Left out: a name from the first message, which the computer renames with the AI name.
  const laneNameOmitted = lane?.name == null;
  const laneName = laneNameOmitted ? laneNameFromPrompt(body.chat) : shortString(lane?.name, 200);
  if (!laneId || !laneName) return "A launch needs its lane's id (a UUID) and name.";
  const from = lane?.from == null ? null : typeof lane.from === "string" && BRANCH.test(lane.from.trim()) ? lane.from.trim() : undefined;
  const existingBranch = lane?.existingBranch == null ? null
    : typeof lane.existingBranch === "string" && BRANCH.test(lane.existingBranch.trim()) ? lane.existingBranch.trim() : undefined;
  if (from === undefined || existingBranch === undefined) return "That branch name can't be used.";
  if (from && existingBranch) return "A lane starts from a branch or works on one, not both.";
  let chat: ParsedLaunchRequest["chat"];
  if (kind === "chat") {
    const raw = body.chat && typeof body.chat === "object" ? body.chat as Record<string, unknown> : null;
    const provider = typeof raw?.provider === "string" && /^[a-z][a-z0-9_-]{0,39}$/.test(raw.provider) ? raw.provider : null;
    const modelId = typeof raw?.modelId === "string" && MODEL_ID.test(raw.modelId) ? raw.modelId : null;
    const permissions = typeof raw?.permissions === "string" && CHAT_PERMISSION_MODES.has(raw.permissions) ? raw.permissions : null;
    const effort = raw?.effort == null ? null : typeof raw.effort === "string" && /^[a-z][a-z0-9_-]{0,39}$/.test(raw.effort) ? raw.effort : undefined;
    const prompt = typeof raw?.prompt === "string" ? raw.prompt : null;
    const messageId = raw?.messageId == null ? launchId : typeof raw.messageId === "string" && LAUNCH_MESSAGE_ID.test(raw.messageId) ? raw.messageId : null;
    if (!messageId) return "The first message's id can't be used.";
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
      messageId,
    };
  }
  const madeByRaw = body.madeBy && typeof body.madeBy === "object" ? body.madeBy as Record<string, unknown> : null;
  const agent = madeByRaw?.agent === "chat" || madeByRaw?.agent === "automation" || madeByRaw?.agent === "mcp" ? madeByRaw.agent : null;
  const madeBy: CloudServerLaunchRequest["madeBy"] = madeByRaw?.kind === "automation"
    ? { kind: "automation", ruleId: shortString(madeByRaw.ruleId, 120) }
    : madeByRaw?.kind === "agent" && agent
      ? { kind: "agent", agent, chatSessionId: shortString(madeByRaw.chatSessionId, 200) }
      : { kind: "person" };
  // What the app asked for; left out (the web and the phone send none) is
  // decided when the computer is made, from the stable image (`launchChannel`).
  const channel = readUpdateChannel(body.channel);
  const sizeChoice: CloudLaunchSizeChoice | null = body.sizeChoice === "default" || body.sizeChoice === "capped" || body.sizeChoice === "picked"
    ? body.sizeChoice
    : sizeOmitted ? "default" : null;
  // Continue a saved chat on the new computer: needs the chat's own lane, named by the caller.
  let continueChat: CloudServerLaunchRequest["continueChat"];
  if (body.continueChat != null) {
    const raw = typeof body.continueChat === "object" && !Array.isArray(body.continueChat) ? body.continueChat as Record<string, unknown> : null;
    const machineKey = typeof raw?.machineKey === "string" && ROW_ID.test(raw.machineKey.trim()) ? raw.machineKey.trim() : null;
    const chatId = typeof raw?.chatId === "string" && ROW_ID.test(raw.chatId.trim()) ? raw.chatId.trim() : null;
    if (!machineKey || !chatId) return "The chat to continue can't be read.";
    if (raw?.kind != null && raw.kind !== "chat" && raw.kind !== "cli") return "The chat to continue can't be read.";
    if (kind !== "chat") return "Only a chat launch continues a chat.";
    if (lane?.id == null) return "A launch that continues a chat names the chat's lane.";
    continueChat = { machineKey, chatId, ...(raw?.kind === "cli" ? { kind: "cli" as const } : {}) };
  }
  // An ADE app's own launch args, kept as sent: the computer parses them as every entry's.
  let launch: Record<string, unknown> | null = null;
  if (body.launch != null) {
    if (typeof body.launch !== "object" || Array.isArray(body.launch)) return "The launch's settings can't be read.";
    if (jsonBytes(body.launch) > CLOUD_LAUNCH_MAX_ARGS_BYTES) return "The launch's settings are too big.";
    launch = body.launch as Record<string, unknown>;
  }
  return {
    launchId,
    kind,
    sizeId: sizeId as CloudTierId,
    ...(sizeChoice ? { sizeChoice } : {}),
    project: { origin },
    lane: {
      id: laneId,
      name: laneName,
      ...(from ? { from } : {}),
      ...(existingBranch ? { existingBranch } : {}),
      // A lane on a branch keeps the branch's name.
      ...((lane?.autoName === true || laneNameOmitted) && !existingBranch ? { autoName: true } : {}),
    },
    ...(chat ? { chat } : {}),
    madeBy,
    ...(channel ? { channel } : {}),
    ...(launch ? { launch } : {}),
    ...(continueChat ? { continueChat } : {}),
  };
}

/**
 * A launch still `joining` or `needs_approval` once its join window closed
 * never signed its computer in (a computer with no token can't say so
 * itself), so it reads as failed. The row keeps its state: a computer that
 * did sign in at the last moment still reports `joined`.
 */
const joinNeverFinished = (row: LaunchRow, now: number): boolean =>
  (row.state === "joining" || row.state === "needs_approval") && row.join_expires_at != null && row.join_expires_at <= now;

/** A Retry still `retrying` this long stopped mid-delete (its Worker ended): the next Retry takes it over. */
const RETRY_HOLD_MS = 5 * 60_000;
const RETRY_STOPPED = "The retry stopped before its new computer was made. Retry again.";
const retryHoldStopped = (row: LaunchRow, now: number): boolean => now - row.updated_at >= RETRY_HOLD_MS;

export function recordOf(row: LaunchRow, now: number): CloudLaunchRecord {
  const neverJoined = joinNeverFinished(row, now);
  const retrying = row.state === "retrying";
  // A hold whose Worker stopped mid-delete reads as failed, so the caller's
  // Retry (a POST with `retry`) takes it over (`restartFailedLaunch`).
  const retryStopped = retrying && retryHoldStopped(row, now);
  return {
    launchId: row.launch_id,
    state: neverJoined || retryStopped ? "failed" : retrying ? "making" : row.state as CloudLaunchState,
    kind: row.kind === "chat" || row.kind === "lane" || row.kind === "machine" ? row.kind : null,
    sizeId: (row.size_id as CloudTierId | null) ?? null,
    autoSize: autoSizeOf(row),
    projectOrigin: row.project_origin,
    laneId: row.lane_id,
    laneName: row.lane_name,
    instanceId: retrying ? null : row.instance_id,
    // A computer with nothing on it has no lane's facts: an app that reads `request` sees none.
    request: row.kind === "machine" ? null : parseJsonColumn<CloudServerLaunchRequest | null>(row.request_json, null, { launchId: row.launch_id, column: "request_json" }),
    approval: !neverJoined && row.state === "needs_approval" && row.approval_url && row.join_user_code
      ? { url: row.approval_url, userCode: row.join_user_code }
      : null,
    stages: parseJsonColumn<CloudLaunchStage[]>(row.stages_json, [], { launchId: row.launch_id, column: "stages_json" }),
    sessionId: row.session_id,
    error: neverJoined ? JOIN_NEVER_FINISHED : retryStopped ? RETRY_STOPPED : row.error,
    signIn: row.state === "waiting_for_sign_in" ? signInOfRow(row) : null,
    machine: row.kind === "machine" ? machineFactsOf(row) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

/** A `machine` launch's facts, kept in its `request_json`. */
function machineFactsOf(row: LaunchRow): CloudMachineLaunchFacts | null {
  const raw = parseJsonColumn<Record<string, unknown> | null>(row.request_json, null, { launchId: row.launch_id, column: "request_json" });
  if (!raw) return null;
  return {
    type: raw.type === "vm" ? "vm" : "default",
    name: typeof raw.name === "string" ? raw.name : "ADE computer",
    movedFrom: typeof raw.movedFrom === "string" ? raw.movedFrom : null,
  };
}

function signInOfRow(row: LaunchRow): CloudLaunchSignIn | null {
  return parseJsonColumn<CloudLaunchSignIn | null>(row.sign_in_json, null, { launchId: row.launch_id, column: "sign_in_json" });
}

/** One row of `GET /cloud/launches?active=1`. */
function summaryOf(row: LaunchRow, now: number): CloudLaunchSummary {
  const record = recordOf(row, now);
  const running = record.stages.find((stage) => stage.status === "running" || stage.status === "failed");
  return {
    launchId: record.launchId,
    state: record.state,
    kind: record.kind,
    projectOrigin: record.projectOrigin,
    laneId: record.laneId,
    laneName: record.laneName,
    instanceId: record.instanceId,
    approval: record.approval,
    sessionId: record.sessionId,
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    stage: running ?? record.stages[record.stages.length - 1] ?? null,
    signIn: record.signIn ?? null,
    provider: record.request?.chat?.provider ?? null,
    modelId: record.request?.chat?.modelId ?? null,
  };
}

function autoSizeOf(row: LaunchRow): CloudLaunchAutoSize | null {
  if (row.auto_size !== "remembered" && row.auto_size !== "setup_memory") return null;
  return { from: CLOUD_AUTO_SIZE.from, to: CLOUD_AUTO_SIZE.to, why: row.auto_size };
}

/* ---- Sizing itself (CLOUD_AUTO_SIZE) ---- */

/** The setup a launch runs, as `cloud_repo_sizes.setup_key` keys it: its lane template's id, or '' for the project's default. */
function setupKeyOf(request: CloudServerLaunchRequest | null): string {
  const laneConfig = request?.launch?.laneConfig;
  const templateId = laneConfig && typeof laneConfig === "object" ? (laneConfig as Record<string, unknown>).templateId : null;
  return shortString(templateId, 120) ?? "";
}

/**
 * The size a launch starts at: Medium for a default-size Small whose
 * repository's setup (same account, origin and lane template) needed Medium
 * within `CLOUD_AUTO_SIZE_MEMORY_MS`; otherwise the size it asked for. Medium
 * uses hours, so an account out of hours for it stays at Small (its create
 * would be refused `out_of_hours`; Small may still run). A remembered size
 * that can't be read starts at the size asked for, and the launch's setup
 * moves it up again if it needs to.
 */
async function startSizeOf(env: CloudEnv, userId: string, parsed: CloudServerLaunchRequest, now: number): Promise<{ sizeId: CloudTierId; remembered: boolean }> {
  if (parsed.sizeChoice !== "default" || parsed.sizeId !== CLOUD_AUTO_SIZE.from) return { sizeId: parsed.sizeId, remembered: false };
  try {
    const row = await env.DB.prepare(`
      select size_id from cloud_repo_sizes where user_id = ? and project_origin = ? and setup_key = ? and recorded_at > ?
    `).bind(userId, parsed.project.origin, setupKeyOf(parsed), now - CLOUD_AUTO_SIZE_MEMORY_MS).first<{ size_id: string }>();
    if (row?.size_id === CLOUD_AUTO_SIZE.to) {
      const medium = cloudSizeForTier(CLOUD_AUTO_SIZE.to)!;
      const account = await loadAccount(env, userId, now);
      const liveUsed = liveUsedMilli(account, await listComputers(env, userId), now) + await unsettledPhoneMilli(env, account, now);
      if (!isOutOfHoursFor(account, liveUsed, medium.multiplierMilli)) return { sizeId: CLOUD_AUTO_SIZE.to, remembered: true };
    }
  } catch (error) {
    reportCloudFailure("cloud.launch_repo_size_read_failed", { message: error instanceof Error ? error.message : "unknown" });
  }
  return { sizeId: parsed.sizeId, remembered: false };
}

/**
 * The disk this repository's setup (same account, origin and lane template)
 * grew its computer to within `CLOUD_AUTO_SIZE_MEMORY_MS`, or null. A read
 * that fails (the table not there yet) is null: the launch starts at 4 GB.
 */
async function rememberedSetupDiskGb(env: CloudEnv, userId: string, parsed: CloudServerLaunchRequest, now: number): Promise<number | null> {
  try {
    const row = await env.DB.prepare(`
      select disk_gb from cloud_repo_disks where user_id = ? and project_origin = ? and setup_key = ? and recorded_at > ?
    `).bind(userId, parsed.project.origin, setupKeyOf(parsed), now - CLOUD_AUTO_SIZE_MEMORY_MS).first<{ disk_gb: number }>();
    return typeof row?.disk_gb === "number" ? row.disk_gb : null;
  } catch (error) {
    reportCloudFailure("cloud.launch_repo_disk_read_failed", { message: error instanceof Error ? error.message : "unknown" });
    return null;
  }
}

/**
 * Remembers `diskGb` for the repository of the launch still setting up on
 * `computer` (its agent not started), after the provider grew that disk.
 * A grow outside a launch's setup (later work, a person's) records nothing.
 * Best effort: a failure is reported, never thrown, so the grow stands.
 */
export async function rememberLaunchSetupDisk(env: CloudEnv, computer: ComputerRow, diskGb: number, now: number): Promise<void> {
  try {
    const row = await env.DB.prepare(`
      select launch_id, project_origin, request_json from cloud_launches
      where instance_id = ? and user_id = ? and project_origin is not null
        and state not in ('draft', 'done', 'failed', 'cancelled', 'retrying')
        and not exists (
          select 1 from json_each(case when json_valid(stages_json) then stages_json else '[]' end)
          where json_extract(value, '$.id') = ? and coalesce(json_extract(value, '$.status'), 'pending') <> 'pending'
        )
      order by created_at desc limit 1
    `).bind(computer.instance_id, computer.user_id, AGENT_STAGE).first<{ launch_id: string; project_origin: string; request_json: string | null }>();
    if (!row) return;
    const request = parseJsonColumn<CloudServerLaunchRequest | null>(row.request_json, null, { launchId: row.launch_id, column: "request_json" });
    // The most this repository's setup needed: a launch that started smaller (the plan's
    // leftover, the 4 GB fallback) and grew only partway never lowers it, and leaves the
    // peak's own date and launch, so an old peak still ages out of the memory window. A
    // row past the window is replaced, as `rememberedSetupDiskGb` no longer reads it.
    // Every `cloud_repo_disks.*` here is the row before this update.
    const keepsPeak = "cloud_repo_disks.recorded_at > ? and cloud_repo_disks.disk_gb > excluded.disk_gb";
    const windowStart = now - CLOUD_AUTO_SIZE_MEMORY_MS;
    await env.DB.prepare(`
      insert into cloud_repo_disks (user_id, project_origin, setup_key, disk_gb, launch_id, recorded_at) values (?, ?, ?, ?, ?, ?)
      on conflict (user_id, project_origin, setup_key) do update set
        disk_gb = case when ${keepsPeak} then cloud_repo_disks.disk_gb else excluded.disk_gb end,
        launch_id = case when ${keepsPeak} then cloud_repo_disks.launch_id else excluded.launch_id end,
        recorded_at = case when ${keepsPeak} then cloud_repo_disks.recorded_at else excluded.recorded_at end
    `).bind(computer.user_id, row.project_origin, setupKeyOf(request), diskGb, row.launch_id, now, windowStart, windowStart, windowStart).run();
    logCloud("cloud.launch_repo_disk_recorded", { launchId: row.launch_id, diskGb });
  } catch (error) {
    reportCloudFailure("cloud.launch_repo_disk_write_failed", { message: error instanceof Error ? error.message : "unknown" });
  }
}

/**
 * Whether `computer` may move from Small to Medium for `launchId`'s setup
 * (a resize with `{ origin: "auto", launchId }`): the launch is this
 * account's, this computer is its computer, its size was ADE's default and
 * it hasn't moved up yet. On yes, the statements that record the move with
 * the resize's own batch (the launch's size, and the repository remembered),
 * so a resize the provider refused records nothing.
 */
export async function launchAutoSizeCheck(
  env: CloudEnv,
  computer: ComputerRow,
  launchId: string,
  to: { tier: CloudTierId | null },
  now: number,
): Promise<{ ok: true; statements: D1PreparedStatement[] } | { ok: false; reason: CloudAutoSizeRefusal }> {
  const row = UUID.test(launchId) ? await readLaunch(env, launchId) : null;
  if (!row || row.user_id !== computer.user_id || row.instance_id !== computer.instance_id) return { ok: false, reason: "not_launch" };
  if (row.state === "cancelled" || row.state === "retrying" || row.state === "draft") return { ok: false, reason: "not_launch" };
  const request = parseJsonColumn<CloudServerLaunchRequest | null>(row.request_json, null, { launchId, column: "request_json" });
  const choice = request?.sizeChoice ?? "picked";
  if (choice !== "default") return { ok: false, reason: choice === "capped" ? "capped" : "picked" };
  // One step, once: a launch already at Medium (moved, or started there from memory), or a computer that isn't a Small.
  const small = cloudSizeForTier(CLOUD_AUTO_SIZE.from)!;
  if (
    row.size_id !== CLOUD_AUTO_SIZE.from
    || to.tier !== CLOUD_AUTO_SIZE.to
    || computer.type !== small.type || computer.cpu !== small.cpu || computer.memory_gb !== small.memoryGb
  ) {
    return { ok: false, reason: "moved" };
  }
  const origin = row.project_origin ?? request?.project.origin ?? null;
  return {
    ok: true,
    statements: [
      // Only the row this check read: a second move that raced this one finds it Medium already.
      env.DB.prepare("update cloud_launches set size_id = ?, auto_size = 'setup_memory', updated_at = ? where launch_id = ? and size_id = ?")
        .bind(CLOUD_AUTO_SIZE.to, now, launchId, CLOUD_AUTO_SIZE.from),
      ...(origin
        ? [env.DB.prepare(`
            insert into cloud_repo_sizes (user_id, project_origin, setup_key, size_id, launch_id, recorded_at) values (?, ?, ?, ?, ?, ?)
            on conflict (user_id, project_origin, setup_key) do update set size_id = excluded.size_id, launch_id = excluded.launch_id, recorded_at = excluded.recorded_at
          `).bind(computer.user_id, origin, setupKeyOf(request), CLOUD_AUTO_SIZE.to, launchId, now)]
        : []),
    ],
  };
}

/** The launch still continuing this chat on this lane (`continueChat`), if one is. */
export async function activeContinueLaunch(env: CloudEnv, userId: string, laneId: string, chatId: string): Promise<LaunchRow | null> {
  return await env.DB.prepare(`
    select * from cloud_launches where user_id = ? and lane_id = ? and continue_chat_id = ? and state not in ('failed', 'cancelled', 'done')
    order by created_at desc limit 1
  `).bind(userId, laneId, chatId).first<LaunchRow>();
}

export async function readLaunch(env: CloudEnv, launchId: string): Promise<LaunchRow | null> {
  return await env.DB.prepare("select * from cloud_launches where launch_id = ?").bind(launchId).first<LaunchRow>();
}

/** The caller's own launch, or null: another account's launch doesn't exist for it. */
async function ownLaunch(env: CloudEnv, userId: string, launchId: string): Promise<LaunchRow | null> {
  if (!UUID.test(launchId)) return null;
  const row = await readLaunch(env, launchId);
  return row && row.user_id === userId ? row : null;
}

/**
 * `github.com/owner/name` of one of the account's projects (a merged one
 * names the project it became), or null: not the account's, removed, or not
 * on github.com.
 */
async function accountProjectOrigin(env: CloudEnv, userId: string, raw: unknown): Promise<string | null> {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 80) return null;
  let id = raw.trim();
  for (let hop = 0; hop < 3; hop += 1) {
    const row = await env.DB.prepare("select host, owner, name, removed_at, merged_into from account_projects where user_id = ? and id = ?")
      .bind(userId, id).first<{ host: string; owner: string; name: string; removed_at: number | null; merged_into: string | null }>();
    if (!row) return null;
    if (row.merged_into) {
      id = row.merged_into;
      continue;
    }
    if (row.removed_at != null || row.host.toLowerCase() !== "github.com") return null;
    return githubOriginOf(`github.com/${row.owner}/${row.name}`);
  }
  return null;
}

/** The made computer's name: the lane's, as the desktop names a lane's computer. */
const computerNameOf = (laneName: string): string => laneName.replace(/\s+/g, " ").trim().slice(0, 60) || "ADE computer";

/* ---- Start ---- */

async function handleStart(request: Request, env: CloudEnv, userId: string, deps: LaunchRouteDeps): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  if (body.kind === "machine") return await handleMachineStart(env, userId, body, deps);
  // One of the account's projects, named by id (the web, the phone): its GitHub origin.
  const project = body.project && typeof body.project === "object" ? body.project as Record<string, unknown> : null;
  if (project?.accountProjectId != null) {
    const origin = await accountProjectOrigin(env, userId, project.accountProjectId);
    if (!origin) return badRequest("That project isn't one of your GitHub projects.");
    if (project.origin != null && githubOriginOf(project.origin) !== origin) return badRequest("The project and its origin don't match.");
    body.project = { origin };
  }
  const parsed = parseLaunchRequest(body);
  if (typeof parsed === "string") return badRequest(parsed);
  let restarted = false;
  if (body.retry === true) {
    const answer = await restartFailedLaunch(env, userId, parsed.launchId, deps);
    if (answer instanceof Response) return answer;
    restarted = answer === "restarted";
  }
  return await startServerLaunch(env, userId, parsed, deps, { restarted });
}

/** Whether the computer reported its agent's stage: from then on the lane is the person's, never deleted for them. */
function agentStartedIn(row: LaunchRow): boolean {
  const stages = parseJsonColumn<CloudLaunchStage[]>(row.stages_json, [], { launchId: row.launch_id, column: "stages_json" });
  return stages.some((stage) => stage.id === AGENT_STAGE && stage.status !== "pending");
}

/**
 * A Retry of a launch whose computer failed before its agent started (it
 * couldn't join in time, clone or start): the failed computer is deleted,
 * and the launch goes back to `making` with no computer, which the start
 * below then makes again, under the same id. Anything else (still running,
 * finished, an agent that started) is left as it is, and the start answers
 * it.
 *
 * The retry is claimed first, against the row this read saw: a join or a
 * report that landed since wins, and its computer is kept. The claim marks
 * the launch `retrying` and keeps the old computer on it until the delete
 * finishes, so another start answers the launch instead of making or
 * adopting a computer, and the old computer's reports and joins are
 * refused. The record's deadline starts again. A delete the provider
 * refuses puts the launch back as failed with that computer, so a later
 * Retry deletes it instead of leaving it on the account.
 */
async function restartFailedLaunch(env: CloudEnv, userId: string, launchId: string, deps: LaunchRouteDeps): Promise<Response | "restarted" | null> {
  const row = await ownLaunch(env, userId, launchId);
  if (!row) return null;
  const failed = row.state === "failed" || joinNeverFinished(row, deps.now)
    || (row.state === "retrying" && retryHoldStopped(row, deps.now));
  if (!failed || agentStartedIn(row)) return null;
  // A Retry makes a new computer: refused before the failed one is deleted.
  const refusal = await deps.refuseNewLaunch?.();
  if (refusal) return refusal;
  if (row.instance_id && !deps.provider) return fail("unavailable", "ADE Cloud can't delete the failed computer right now. Try again soon.", 503);
  // One live launch per continued chat: a newer send already started another one, and the chat's messages go there.
  const continuing = () => fail("computer_busy", "This chat already continues on another new computer. Its messages go there.", 409);
  if (row.continue_chat_id && row.lane_id) {
    const other = await activeContinueLaunch(env, userId, row.lane_id, row.continue_chat_id);
    if (other && other.launch_id !== row.launch_id) return continuing();
  }
  const claim = () => env.DB.prepare(`
    update cloud_launches set state = 'retrying', join_expires_at = null, join_used_at = null, join_rejoins = 0,
      join_user_code = null, approval_url = null, stages_json = null, error = null, session_id = null, sign_in_json = null, updated_at = ?, expires_at = ?
    where launch_id = ? and user_id = ? and updated_at = ? and state = ?
  `).bind(deps.now, deps.now + CLOUD_LAUNCH_RECORD_TTL_MS, launchId, userId, row.updated_at, row.state).run();
  let claimed: Awaited<ReturnType<typeof claim>>;
  try {
    claimed = await claim();
  } catch (error) {
    // A send started the other launch between the read above and this claim (`cloud_launches_continue`).
    if (row.continue_chat_id && error instanceof Error && /UNIQUE/i.test(error.message)) return continuing();
    throw error;
  }
  if ((claimed.meta?.changes ?? 0) !== 1) return null;
  if (row.instance_id) {
    try {
      await deleteLaunchComputer(env, deps.provider!, row, deps.now, { who: "launch_retry", reason: "launch_retried" });
    } catch (error) {
      // Back as it failed, holding its computer (a cancel meanwhile keeps its own state).
      await env.DB.prepare(`
        update cloud_launches set state = 'failed', error = ?, updated_at = ? where launch_id = ? and user_id = ? and state = 'retrying'
      `).bind(row.error ?? "The launch's computer failed.", deps.now, launchId, userId).run();
      reportCloudFailure("cloud.launch_retry_delete_failed", { launchId, code: error instanceof Error ? error.name : "unknown" });
      return fail("unavailable", "ADE Cloud can't delete the failed computer right now. Try again soon.", 503);
    }
  }
  // Released for the start below; a cancel that landed meanwhile keeps the launch cancelled.
  const released = await env.DB.prepare(`
    update cloud_launches set state = 'making', instance_id = null, updated_at = ? where launch_id = ? and user_id = ? and state = 'retrying'
  `).bind(deps.now, launchId, userId).run();
  logCloud("cloud.launch_retried", { userId, launchId, instanceId: row.instance_id });
  return (released.meta?.changes ?? 0) === 1 ? "restarted" : null;
}

/**
 * Starts one launch, as `POST /cloud/launches` does: for the route, and for
 * an automation's run (C9) with no request. The same checks, the same one
 * create path; 201 for a computer this call made, 200 for a launch that was
 * already started, or the refusal.
 */
export async function startServerLaunch(
  env: CloudEnv,
  userId: string,
  parsed: ParsedLaunchRequest,
  deps: LaunchRouteDeps,
  /** `restarted`: this start follows a Retry that deleted the launch's failed computer (`restartFailedLaunch`). */
  options: { restarted?: boolean } = {},
): Promise<Response> {
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
  // One launch continues one chat on one lane: a second start (another device, a resend) answers the first.
  if (parsed.continueChat && (!existing || existing.state === "draft")) {
    const running = await activeContinueLaunch(env, userId, parsed.lane.id, parsed.continueChat.chatId);
    if (running) return json(recordOf(running, now), 200);
  }
  // Only a launch that is new here: a start of one already making its computer goes on to the create's replay.
  if (!existing || existing.state === "draft") {
    const refusal = await deps.refuseNewLaunch?.();
    if (refusal) return refusal;
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
      logCloud("cloud.launch_refused_git", { userId, launchId, reason: git.code });
      // `github_app_not_installed` carries the page that installs the App (`installUrl`).
      return fail(git.code, git.message, 403, git.installUrl ? { installUrl: git.installUrl } : undefined);
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
  // A default-size Small of a repository whose setup needed Medium starts at Medium (the request keeps what was asked).
  const start = await startSizeOf(env, userId, parsed, now);
  const autoSize = start.remembered ? "remembered" : null;
  let sizeId = start.sizeId;
  // The join code's salt and hash land with the claim, before the provider is
  // called, so a retry after a lost create answer works the same code out again.
  let salt = newJoinSalt();
  let joinCode = (await joinCodeOf(env, launchId, salt))!;
  // One write: a draft becomes the launch, or a new row is the launch. A start
  // racing this one changes nothing here, goes on into the create, and is
  // answered by its replay (409 while the first create is in flight).
  const claim = async () => await env.DB.prepare(`
    insert into cloud_launches (launch_id, user_id, state, kind, size_id, auto_size, project_origin, lane_id, lane_name, request_json, join_salt, join_hash, created_at, updated_at, expires_at,
      continue_machine_key, continue_chat_id)
    values (?, ?, 'making', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict (launch_id) do update set state = 'making', kind = excluded.kind, size_id = excluded.size_id, auto_size = excluded.auto_size,
      project_origin = excluded.project_origin, lane_id = excluded.lane_id, lane_name = excluded.lane_name,
      request_json = excluded.request_json, join_salt = excluded.join_salt, join_hash = excluded.join_hash,
      updated_at = excluded.updated_at, expires_at = excluded.expires_at,
      continue_machine_key = excluded.continue_machine_key, continue_chat_id = excluded.continue_chat_id
    where cloud_launches.user_id = excluded.user_id and cloud_launches.state = 'draft'
  `).bind(
    launchId, userId, parsed.kind, start.sizeId, autoSize, parsed.project.origin, parsed.lane.id, parsed.lane.name, requestJson, salt, await sha256Hex(joinCode), now, now, expiresAt,
    parsed.continueChat?.machineKey ?? null, parsed.continueChat?.chatId ?? null,
  ).run();
  let claimed: D1Result;
  try {
    claimed = await claim();
  } catch (error) {
    // Two starts raced to continue the same chat: the unique index let one in, and this one answers it.
    if (parsed.continueChat && error instanceof Error && /UNIQUE/i.test(error.message)) {
      const running = await activeContinueLaunch(env, userId, parsed.lane.id, parsed.continueChat.chatId);
      if (running) return json(recordOf(running, now), 200);
    }
    throw error;
  }
  const claimedDraft = existing?.state === "draft" && (claimed.meta?.changes ?? 0) === 1;
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
    if (options.restarted) {
      // A Retry deleted the failed computer: nothing of the first attempt is
      // left to replay, so this start is a new one. It takes the size chosen
      // now (a repository that since needed Medium starts there) and the
      // request as sent now (its size choice is what a setup move checks:
      // an agent whose limits were lowered sends "capped").
      await env.DB.prepare(`
        update cloud_launches set size_id = ?, auto_size = ?, request_json = ?, updated_at = ?
        where launch_id = ? and user_id = ? and state = 'making' and instance_id is null
      `).bind(start.sizeId, autoSize, requestJson, now, launchId, userId).run();
    } else if (cloudSizeForTier(row.size_id)) {
      // A create still in flight, or one whose answer was lost: the computer it may have made is the size it chose.
      sizeId = row.size_id as CloudTierId;
    }
  }

  // The first message is row 1 of the launch's messages: sent once, as the chat's first message.
  // A draft's earlier start that was refused may have left one: the start that turned the
  // draft into the launch replaces it with its prompt, and so does a Retry (its prompt or
  // model may have changed, and the failed attempt's row 1 can't be delivered); any other
  // start keeps what is there.
  if (parsed.chat) {
    const first = firstMessageStatement(env, launchId, userId, parsed.chat, now);
    if (claimedDraft) await env.DB.batch([dropFirstMessageStatement(env, launchId), first]);
    else if (options.restarted) await env.DB.batch([dropFirstMessageStatement(env, launchId, "retry"), first]);
    else await first.run();
  }

  const size = cloudSizeForTier(sizeId)!;
  const metadata: Record<string, string> = {
    [CLOUD_LANE_METADATA.laneId]: parsed.lane.id,
    [CLOUD_LANE_METADATA.laneName]: parsed.lane.name,
    [CLOUD_LANE_METADATA.projectOrigin]: parsed.project.origin,
    [CLOUD_LAUNCH_METADATA.launchId]: launchId,
    ...(parsed.madeBy?.kind === "automation" ? { ade_made_by_agent: "automation" } : {}),
    ...(parsed.madeBy?.kind === "agent" ? { ade_made_by_agent: parsed.madeBy.agent } : {}),
    ...(parsed.madeBy?.kind === "agent" && parsed.madeBy.chatSessionId ? { ade_made_by_chat: parsed.madeBy.chatSessionId } : {}),
    created_by: "ade",
    // The same id as the launch: a repeated start finds the computer it made.
    ade_request_id: launchId,
  };
  const joinExpiresAt = now + CLOUD_LAUNCH_JOIN_TTL_MS;
  const joinHash = await sha256Hex(joinCode);
  const outcome = await deps.createComputer(userId, deps.provider, {
    // The disk this repository's setup needed before: no fill, restart and setup again.
    setupDiskGb: await rememberedSetupDiskGb(env, userId, parsed, now),
    body: {
      name: computerNameOf(parsed.lane.name),
      type: size.type,
      resources: { cpu: size.cpu, memory: size.memoryGb },
      metadata,
      publicPorts: [{ port: WAKE_PORT, label: "ADE wake" }],
      channel: launchChannel(await readUpdateTargets(env), parsed.channel),
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
      // One batch, messages first: they go only while the launch is still this unmade start.
      if (existing?.state === "draft") {
        // Its first message goes too; the next start writes its own.
        await env.DB.batch([
          refusedStartMessagesStatement(env, launchId, "first"),
          env.DB.prepare("update cloud_launches set state = 'draft', expires_at = ?, updated_at = ? where launch_id = ? and state = 'making' and instance_id is null")
            .bind(existing.expires_at, now, launchId),
        ]);
      } else {
        // Its messages go with it; the same start sent again writes them again.
        await env.DB.batch([
          refusedStartMessagesStatement(env, launchId, "all"),
          env.DB.prepare("delete from cloud_launches where launch_id = ? and state = 'making' and instance_id is null").bind(launchId),
        ]);
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

/* ---- A computer with nothing on it (`kind: "machine"`) ---- */

/**
 * The server setting that turns `machine` launches on: the ADE version that
 * runs them (`cloudBootLaunch.ts` signs in and stops). Unset (the default),
 * every `machine` launch, and so every server move, is refused with
 * `machine_launch_unavailable`, and an ADE app falls back to its own way.
 * Set, it is the new computer's `ADE_MIN_VERSION`: the image's entrypoint
 * installs it before the brain's first start, so an image whose own ADE
 * predates `machine` never reads the launch.
 */
export const MACHINE_LAUNCH_MIN_VERSION_SETTING = "machine_launch_min_version";
/** The same shape as a client's `ADE_MIN_VERSION` (`CLIENT_ENV` in routes.ts). */
const ADE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

/** The ADE version a `machine` launch's computer installs, or null while they're off. */
export async function machineLaunchMinVersion(env: CloudEnv): Promise<string | null> {
  const value = (await readSetting(env, MACHINE_LAUNCH_MIN_VERSION_SETTING))?.trim() ?? "";
  return ADE_VERSION.test(value) ? value : null;
}

export const MACHINE_LAUNCH_UNAVAILABLE = "machine_launch_unavailable";
const machineLaunchUnavailable = () =>
  fail(MACHINE_LAUNCH_UNAVAILABLE, "Making a computer from here needs the next ADE update. Try again after it ships.", 409);

/** A `machine` launch to start: from `POST /cloud/launches`, or a move's new computer (`moves.ts`). */
export type MachineLaunchInput = {
  launchId: string;
  size: CloudSize;
  name: string;
  /** The app's update track, as asked; left out is chosen as for any launch (`launchChannel`). */
  channel: CloudUpdateChannel | null;
  /** A move: the computer this one replaces. Its disk carries over, under the plan's limits as a move. */
  moveFromInstanceId?: string | null;
  /** More metadata for the computer (a move's lane facts, `ade_moved_from`). */
  metadata?: Record<string, string>;
};

/** `POST /cloud/launches` with `kind: "machine"`: a person's new computer, from the web or the phone. */
async function handleMachineStart(env: CloudEnv, userId: string, body: Record<string, unknown>, deps: LaunchRouteDeps): Promise<Response> {
  const launchId = typeof body.launchId === "string" ? body.launchId.trim().toLowerCase() : "";
  if (!UUID.test(launchId)) return badRequest("A launch needs a launch id (a UUID).");
  const size = body.sizeId == null ? cloudSizeForTier("small") : cloudSizeForTier(body.sizeId);
  if (!size) return badRequest("That size isn't one ADE Cloud offers.");
  const madeBy = body.madeBy && typeof body.madeBy === "object" ? body.madeBy as Record<string, unknown> : null;
  if (madeBy && madeBy.kind !== "person") return fail("person_only", "Only you can make a new computer this way. Ask in ADE.", 403);
  if (body.name != null && !shortString(body.name, 60)) return badRequest("That name isn't valid.");
  return await startMachineLaunch(env, userId, {
    launchId,
    size,
    name: shortString(body.name, 60) ?? "ADE computer",
    channel: readUpdateChannel(body.channel),
  }, deps);
}

/**
 * Starts a `machine` launch: the same one create path, join code and records
 * as a lane's (`startServerLaunch`), with no project, lane or chat. 201 for a
 * computer this call made, 200 for the same launch again, or the refusal. The
 * computer signs in, writes its machine key, and reports `done`.
 */
export async function startMachineLaunch(env: CloudEnv, userId: string, input: MachineLaunchInput, deps: LaunchRouteDeps): Promise<Response> {
  const { now } = deps;
  const { launchId, size } = input;
  const existing = await readLaunch(env, launchId);
  if (existing && (existing.user_id !== userId || existing.kind !== "machine")) return badRequest("That launch id can't be used.");
  // The same launch again answers what it is; a start whose create didn't finish goes on into the create's replay.
  if (existing && !(existing.state === "making" && !existing.instance_id)) return json(recordOf(existing, now), 200);
  const minVersion = await machineLaunchMinVersion(env);
  if (!minVersion) return machineLaunchUnavailable();
  if (!existing) {
    const refusal = await deps.refuseNewLaunch?.();
    if (refusal) return refusal;
  }
  if (!deps.provider) return fail("unavailable", "ADE Cloud can't make a computer right now. Try again soon.", 503);
  if (!env.CLOUD_LAUNCH_JOIN_KEY?.trim()) {
    reportCloudFailure("cloud.launch_join_key_missing");
    return fail("unavailable", "ADE Cloud can't make a computer right now. Try again soon.", 503);
  }
  let salt = existing?.join_salt ?? newJoinSalt();
  if (!existing) {
    const facts = { launchId, kind: "machine", sizeId: size.tier, type: size.type, name: input.name, movedFrom: input.moveFromInstanceId ?? null };
    const firstHash = await sha256Hex((await joinCodeOf(env, launchId, salt))!);
    const claimed = await env.DB.prepare(`
      insert into cloud_launches (launch_id, user_id, state, kind, size_id, request_json, join_salt, join_hash, created_at, updated_at, expires_at)
      values (?, ?, 'making', 'machine', ?, ?, ?, ?, ?, ?, ?) on conflict (launch_id) do nothing
    `).bind(launchId, userId, size.tier, JSON.stringify(facts), salt, firstHash, now, now, now + CLOUD_LAUNCH_RECORD_TTL_MS).run();
    if ((claimed.meta?.changes ?? 0) !== 1) {
      // Another start of the same id got in first: answer it, or go on into its create's replay.
      const row = await readLaunch(env, launchId);
      if (!row || row.user_id !== userId || row.kind !== "machine") return badRequest("That launch id can't be used.");
      if (!(row.state === "making" && !row.instance_id)) return json(recordOf(row, now), 200);
      salt = row.join_salt ?? salt;
    }
  }
  const joinCode = (await joinCodeOf(env, launchId, salt))!;
  const joinHash = await sha256Hex(joinCode);
  const joinExpiresAt = now + CLOUD_LAUNCH_JOIN_TTL_MS;
  const outcome = await deps.createComputer(userId, deps.provider, {
    body: {
      name: computerNameOf(input.name),
      type: size.type,
      resources: { cpu: size.cpu, memory: size.memoryGb },
      metadata: {
        ...input.metadata,
        [CLOUD_LAUNCH_METADATA.launchId]: launchId,
        created_by: "ade",
        // The same id as the launch: a repeated start finds the computer it made.
        ade_request_id: launchId,
      },
      publicPorts: [{ port: WAKE_PORT, label: "ADE wake" }],
      channel: launchChannel(await readUpdateTargets(env), input.channel),
      ...(input.moveFromInstanceId ? { moveFromInstanceId: input.moveFromInstanceId } : {}),
    },
    // The version that knows `machine`, installed before the first brain start.
    serverEnv: { [CLOUD_LAUNCH_ENV.launchId]: launchId, [CLOUD_LAUNCH_ENV.join]: joinCode, ADE_MIN_VERSION: minVersion },
    onMade: (instance) => [
      env.DB.prepare(`
        update cloud_launches set instance_id = ?, join_hash = ?, join_expires_at = ?, join_used_at = null, join_rejoins = 0, join_user_code = null,
          state = case when state = 'making' then 'joining' else state end, updated_at = ?
        where launch_id = ?
      `).bind(instance.id, joinHash, joinExpiresAt, now, launchId),
    ],
  });
  if (outcome.kind === "replayed") {
    await env.DB.prepare(`
      update cloud_launches set instance_id = coalesce(instance_id, ?), join_expires_at = coalesce(join_expires_at, ?),
        state = case when state = 'making' then 'joining' else state end, updated_at = ?
      where launch_id = ?
    `).bind(outcome.instance.id, joinExpiresAt, now, launchId).run();
  } else if (outcome.kind !== "made") {
    // Refused (hours, disk, the move's own rules): nothing was made, and the same start may be sent again.
    if (outcome.kind === "refused") {
      await env.DB.prepare("delete from cloud_launches where launch_id = ? and state = 'making' and instance_id is null").bind(launchId).run();
    }
    return createAnswerOf(outcome);
  }
  const after = (await readLaunch(env, launchId))!;
  if (after.state === "cancelled" && after.instance_id) await deleteLaunchComputer(env, deps.provider, after, deps.now);
  logCloud("cloud.launch_started", { userId, launchId, instanceId: after.instance_id, launchKind: "machine", replay: outcome.kind === "replayed" });
  return json(recordOf(after, now), outcome.kind === "made" ? 201 : 200);
}

/* ---- A server copy's sign-in (`copies.ts`) ---- */

/**
 * A server copy's fork joins as a `machine` launch's computer does, with the
 * same code rules (single use, 30 minutes, only its hash kept, bound to the
 * fork's instance id), but the provider's fork takes no env. So the launch
 * row is made before the fork (its id goes in the fork's metadata), bound to
 * the fork once it is made (`bindCopyLaunchStatement`), and its 30 minutes
 * start only when the server hands the fork its code (`openCopyLaunchJoin`).
 * Until then a join finds no window open. False when the launch id is
 * another account's or another kind's, or the join key isn't set.
 */
export async function prepareCopyLaunch(
  env: CloudEnv,
  userId: string,
  launchId: string,
  facts: { sizeId: CloudTierId | null; type: "default" | "vm"; name: string; copiedFrom: string },
  now: number,
): Promise<boolean> {
  const existing = await readLaunch(env, launchId);
  if (existing) return existing.user_id === userId && existing.kind === "machine";
  const salt = newJoinSalt();
  const code = await joinCodeOf(env, launchId, salt);
  if (!code) {
    reportCloudFailure("cloud.launch_join_key_missing");
    return false;
  }
  const request = { launchId, kind: "machine", sizeId: facts.sizeId, type: facts.type, name: facts.name, movedFrom: null, copiedFrom: facts.copiedFrom };
  await env.DB.prepare(`
    insert into cloud_launches (launch_id, user_id, state, kind, size_id, request_json, join_salt, join_hash, created_at, updated_at, expires_at)
    values (?, ?, 'making', 'machine', ?, ?, ?, ?, ?, ?, ?) on conflict (launch_id) do nothing
  `).bind(launchId, userId, facts.sizeId, JSON.stringify(request), salt, await sha256Hex(code), now, now, now + CLOUD_LAUNCH_RECORD_TTL_MS).run();
  const row = await readLaunch(env, launchId);
  return row?.user_id === userId && row.kind === "machine";
}

/** Binds a copy's launch to its fork, in the batch that adopts the fork (a launch already bound keeps its computer). */
export function bindCopyLaunchStatement(env: CloudEnv, launchId: string, instanceId: string, now: number): D1PreparedStatement {
  return env.DB.prepare("update cloud_launches set instance_id = ?, updated_at = ? where launch_id = ? and instance_id is null").bind(instanceId, now, launchId);
}

/**
 * Whether the join would still take this launch's code from its computer:
 * never used, or used by a sign-in nobody approved yet with rejoins left
 * (the join's own rule for a brain that restarted mid-sign-in).
 */
export async function launchCodeStillJoins(env: CloudEnv, launch: Pick<LaunchRow, "join_used_at" | "join_rejoins" | "join_user_code">): Promise<boolean> {
  if (launch.join_used_at == null) return true;
  return launch.join_rejoins < MAX_REJOINS && !(await signInApproved(env, launch.join_user_code));
}

/**
 * Opens a copy's join for its fork and works its code out again from the
 * kept salt (the code itself is never stored), for the one exec that hands
 * it over. The window opens once: handing the code again (a brain that lost
 * it) keeps the first 30 minutes. `signed_in` once the fork reported its
 * launch done; `closed` for a launch that ended or names another computer.
 */
export async function openCopyLaunchJoin(
  env: CloudEnv,
  launchId: string,
  instanceId: string,
  now: number,
): Promise<{ kind: "code"; code: string } | { kind: "signed_in" } | { kind: "closed" }> {
  const row = await readLaunch(env, launchId);
  if (!row || (row.instance_id != null && row.instance_id !== instanceId)) return { kind: "closed" };
  if (row.state === "done") return { kind: "signed_in" };
  const opened = await env.DB.prepare(`
    update cloud_launches set instance_id = coalesce(instance_id, ?), state = case when state = 'making' then 'joining' else state end,
      join_expires_at = coalesce(join_expires_at, ?), updated_at = ?
    where launch_id = ? and coalesce(instance_id, ?) = ? and state in ('making', 'joining', 'needs_approval')
  `).bind(instanceId, now + CLOUD_LAUNCH_JOIN_TTL_MS, now, launchId, instanceId, instanceId).run();
  const code = row.join_salt ? await joinCodeOf(env, launchId, row.join_salt) : null;
  if ((opened.meta?.changes ?? 0) !== 1 || !code) return { kind: "closed" };
  return { kind: "code", code };
}

/* ---- Files ---- */

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
async function handlePutFile(request: Request, env: CloudEnv, userId: string, launchId: string, fileId: string, now: number): Promise<Response> {
  if (!UUID.test(launchId) || !FILE_ID.test(fileId)) return notFound();
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
  const row = await readLaunch(env, launchId);
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

async function handleGetFile(env: CloudEnv, row: LaunchRow, fileId: string): Promise<Response> {
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
    out.push({ id, status, detail: clippedText(record?.detail, 300), error: clippedText(record?.error, 300) });
  }
  return out;
}

const COMPUTER_STATES: ReadonlySet<string> = new Set(["joined", "waiting_for_sign_in", "running", "done", "failed"]);
const SIGN_IN_KINDS: ReadonlySet<string> = new Set(CLOUD_REMOTE_SIGN_IN_KINDS);

/** The sign-in a waiting launch names, as the computer sent it: links and codes only, each checked. */
export function parseSignIn(value: unknown): CloudLaunchSignIn | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const record = typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const row = cloudRemoteSignInOf(record?.provider);
  if (!record || !row) return undefined;
  const kind = typeof record.kind === "string" && SIGN_IN_KINDS.has(record.kind) ? record.kind as CloudLaunchSignIn["kind"] : row.remoteSignIn;
  const url = typeof record.url === "string" && record.url.length <= 2_000 && /^https:\/\/[^\s]+$/i.test(record.url.trim()) ? record.url.trim() : null;
  const jobId = typeof record.jobId === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(record.jobId) ? record.jobId : null;
  return {
    provider: row.provider,
    label: row.label,
    kind,
    jobId,
    url,
    userCode: shortString(record.userCode, 64),
    needsPastedCode: record.needsPastedCode === true,
    signInId: kind === "api_key" ? row.accountSignIn : shortString(record.signInId, 40),
    reason: clippedText(record.reason, 300),
  };
}

async function handleStages(request: Request, env: CloudEnv, row: LaunchRow, now: number): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  if (row.state === "cancelled" || row.state === "draft" || row.state === "retrying" || !row.instance_id) return fail("launch_closed", "This launch isn't running.", 409);
  const state = body.state === undefined ? null : typeof body.state === "string" && COMPUTER_STATES.has(body.state) ? body.state : undefined;
  const stages = parseStages(body.stages);
  const signIn = parseSignIn(body.signIn);
  if (state === undefined || (body.stages !== undefined && !stages) || signIn === undefined && body.signIn !== undefined) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  // A launch waits on a sign-in only while it names one; any other state clears it.
  if (state === "waiting_for_sign_in" && !signIn) return badRequest("A launch waiting for a sign-in names the sign-in.");
  const signInJson = state === "waiting_for_sign_in" ? JSON.stringify(signIn) : null;
  // A finished launch stays finished: a report that left the computer before the last one can land after it.
  if (row.state === "done" && state !== "done") return fail("launch_closed", "This launch already finished.", 409);
  // A launch the server ended (no join, no sign-in) is having its computer deleted: a late report doesn't revive it.
  if (row.state === "failed" && serverEnded(row.error) && state !== "failed") return fail("launch_closed", "This launch isn't running.", 409);
  const sessionId = body.sessionId === undefined ? undefined : shortString(body.sessionId, 120);
  const error = body.error === undefined ? undefined : clippedText(body.error, 400);
  const written = await env.DB.prepare(`
    update cloud_launches set
      state = coalesce(?, state),
      stages_json = coalesce(?, stages_json),
      session_id = case when ? then ? else session_id end,
      error = case when ? then ? else error end,
      approval_url = case when ? is not null then null else approval_url end,
      sign_in_json = case when ? is not null then ? else sign_in_json end,
      updated_at = ?
    where launch_id = ? and instance_id = ? and state not in ('cancelled', 'retrying') and (state <> 'done' or ? = 'done')
      and (state <> 'failed' or coalesce(error, '') not in (?, ?, ?) or ? = 'failed')
  `).bind(
    state, stages ? JSON.stringify(stages) : null,
    sessionId !== undefined ? 1 : 0, sessionId ?? null,
    error !== undefined ? 1 : 0, error ?? null,
    state,
    state, signInJson,
    now, row.launch_id, row.instance_id, state,
    JOIN_NEVER_FINISHED, SIGN_IN_NEVER_FINISHED, LAUNCH_COMPUTER_DELETED, state,
  ).run();
  // Only the computer this report was checked against, and never into a Retry
  // that claimed the launch since this request read it.
  if ((written.meta?.changes ?? 0) !== 1) return fail("launch_closed", "This launch isn't running.", 409);
  // The chat exists: the computer started it with the first message.
  if (sessionId) {
    await firstMessageDeliveredStatement(env, row.launch_id, sessionId, now).run();
    // A chat's message this launch carries reads delivered, even after an earlier try marked it failed.
    await chatMessagesDeliveredStatement(env, row.launch_id, now).run();
    // The follow-ups queued on the launch join the new chat's queue, so the chat shows a failed one.
    try {
      await carryLaunchMessagesToChat(env, row, sessionId, now);
    } catch (error) {
      // The report itself stands: only the chat's view of the follow-ups is missing.
      reportCloudFailure("cloud.launch_messages_carry_failed", { userId: row.user_id, launchId: row.launch_id, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  // The computer gave up on the sign-in itself: its queued messages fail as with the server's
  // own timeout, and the minute cron deletes the computer (`failUnjoinedLaunches`).
  if (state === "failed" && error === SIGN_IN_NEVER_FINISHED) await failQueuedMessagesStatement(env, row.launch_id, SIGN_IN_NEVER_FINISHED, now).run();
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
    update cloud_launches set state = 'cancelled', approval_url = null, sign_in_json = null, updated_at = ? where launch_id = ? and state not in ('done', 'cancelled')
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
    if (request.method === "POST") return handleStart(request, env, userId, deps);
    if (request.method === "GET" && new URL(request.url).searchParams.get("active") === "1") return handleActiveList(env, userId, deps.now);
    return notFound();
  }
  const route = launchRouteOf(path);
  if (!route) return notFound();
  const { launchId, action, rest } = route;
  if (action === "messages") {
    const row = await ownLaunch(env, userId, launchId);
    return row ? await routeLaunchMessages(request, env, row, rest, deps.now) : notFound();
  }
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

/* ---- The caller's launches in progress ---- */

/** Most launches the active list answers. */
const ACTIVE_LIST_LIMIT = 50;
/** A failed launch stays on the active list this long, so a person who closed the tab still sees why. */
const ACTIVE_FAILED_MS = 24 * 60 * 60_000;

async function handleActiveList(env: CloudEnv, userId: string, now: number): Promise<Response> {
  const rows = (await env.DB.prepare(`
    select * from cloud_launches
    where user_id = ? and state not in ('draft', 'done', 'cancelled') and (state <> 'failed' or updated_at > ?)
      -- A computer with nothing on it is followed by its own caller (a move, the phone's new computer), never listed:
      -- an older app reads every row here as a chat or a lane.
      and coalesce(kind, '') <> 'machine'
      -- A launch still "in progress" on a deleted computer is not (one left from before the delete closed it).
      -- A failure stays for its window with its error and Retry; a Retry in flight stays too.
      and (state in ('failed', 'retrying')
        or not exists (select 1 from cloud_computers c where c.instance_id = cloud_launches.instance_id and c.deleted_at is not null))
      -- A failure a later launch of the same lane replaced has nothing left to retry.
      and (state <> 'failed' or lane_id is null or not exists (
        select 1 from cloud_launches later
        where later.user_id = cloud_launches.user_id and later.lane_id = cloud_launches.lane_id
          and later.created_at > cloud_launches.created_at and later.state not in ('draft', 'cancelled')))
    order by created_at desc limit ?
  `).bind(userId, now - ACTIVE_FAILED_MS, ACTIVE_LIST_LIMIT).all<LaunchRow>()).results ?? [];
  const answer: CloudLaunchList = { launches: rows.map((row) => summaryOf(row, now)) };
  return json(answer);
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
  if (row.state === "cancelled" || row.state === "failed" || row.state === "done" || row.state === "retrying") return fail("launch_closed", "This launch isn't running.", 409);

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
  // The network the computer joined from is ADE Cloud's own (Free Small's tripwire, `sponsoredSmall.ts`). Never fails the join.
  await noteComputerJoin(env, instanceId, requestNetwork(request)).catch((error: unknown) => {
    reportCloudFailure("cloud.computer_join_network_failed", { message: error instanceof Error ? error.message : "unknown" });
  });
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
 * How long a launch may wait on a provider sign-in before the server ends it
 * and deletes its computer. The computer gives up a little sooner by itself
 * (`SIGN_IN_WAIT_MS` in cloudBootLaunch.ts).
 */
const SIGN_IN_WAIT_MS = 45 * 60_000;
/** The computer's own timeout reports the same error, so both end the same way. */
const SIGN_IN_NEVER_FINISHED = CLOUD_LAUNCH_SIGN_IN_TIMED_OUT;
/** The server's own endings: the computer is deleted with or after them, so no report brings the launch back. */
const serverEnded = (error: string | null): boolean => error === JOIN_NEVER_FINISHED || error === SIGN_IN_NEVER_FINISHED || error === LAUNCH_COMPUTER_DELETED;

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
  // A launch that waited on a provider sign-in too long: nothing of the agent
  // ran, so it ends like a computer that never joined (the computer gives up
  // on its own first; this is for one that stopped answering).
  const stalled = (await env.DB.prepare(`
    select * from cloud_launches where state = 'waiting_for_sign_in' and updated_at <= ? limit ?
  `).bind(now - SIGN_IN_WAIT_MS, UNJOINED_PER_TICK).all<LaunchRow>()).results ?? [];
  for (const row of stalled) {
    const failed = await env.DB.prepare(`
      update cloud_launches set state = 'failed', error = ?, sign_in_json = null, updated_at = ?
      where launch_id = ? and state = 'waiting_for_sign_in' and updated_at <= ?
    `).bind(SIGN_IN_NEVER_FINISHED, now, row.launch_id, now - SIGN_IN_WAIT_MS).run();
    if ((failed.meta?.changes ?? 0) !== 1) continue;
    ended += 1;
    logCloud("cloud.launch_sign_in_never_finished", { userId: row.user_id, launchId: row.launch_id, instanceId: row.instance_id });
    await failQueuedMessagesStatement(env, row.launch_id, SIGN_IN_NEVER_FINISHED, now).run();
    try {
      await deleteLaunchComputer(env, provider, row, now, { who: "launch_sign_in", reason: "launch_sign_in_never_finished" });
      const latest = await readLaunch(env, row.launch_id);
      if (latest && deps.onProgress) await deps.onProgress(recordOf(latest, now));
    } catch (error) {
      reportCloudFailure("cloud.launch_sign_in_end_failed", { launchId: row.launch_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
    }
  }
  // A launch failed here whose computer is still on the account (a delete that
  // failed, a Worker that stopped between the claim and the delete, or a
  // computer that reported its own sign-in timeout): delete it.
  const left = (await env.DB.prepare(`
    select l.* from cloud_launches l join cloud_computers c on c.instance_id = l.instance_id and c.user_id = l.user_id
    where l.state = 'failed' and l.error in (?, ?) and c.deleted_at is null limit ?
  `).bind(JOIN_NEVER_FINISHED, SIGN_IN_NEVER_FINISHED, UNJOINED_PER_TICK).all<LaunchRow>()).results ?? [];
  for (const row of left) {
    const why = row.error === SIGN_IN_NEVER_FINISHED
      ? { who: "launch_sign_in", reason: "launch_sign_in_never_finished" }
      : { who: "launch_join", reason: "launch_never_joined" };
    await deleteLaunchComputer(env, provider, row, now, why).catch((error: unknown) => {
      reportCloudFailure("cloud.launch_never_joined_end_failed", { launchId: row.launch_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
    });
  }
  // A failed launch that continued a lane with no computer, before its agent
  // ran: the new computer took the lane (its adoption ended the lane's row
  // here) but never made it, so every later send would go to a computer
  // without the lane or its chat. Its computer goes, and the lane is kept
  // without one again, so the next send starts a new computer as before.
  const continued = (await env.DB.prepare(`
    select l.* from cloud_launches l join cloud_computers c on c.instance_id = l.instance_id and c.user_id = l.user_id
    where l.state = 'failed' and l.continue_chat_id is not null and l.lane_id is not null and c.deleted_at is null
      and not exists (
        select 1 from json_each(case when json_valid(l.stages_json) then l.stages_json else '[]' end)
        where json_extract(value, '$.id') = ? and coalesce(json_extract(value, '$.status'), 'pending') <> 'pending'
      )
    limit ?
  `).bind(AGENT_STAGE, UNJOINED_PER_TICK).all<LaunchRow>()).results ?? [];
  for (const row of continued) {
    try {
      const computer = await ownedComputer(env, row.user_id, row.instance_id!);
      if (!computer) continue;
      const facts = {
        laneId: computer.lane_id ?? row.lane_id,
        laneName: computer.lane_name ?? row.lane_name,
        projectOrigin: computer.lane_project_origin ?? row.project_origin,
        branch: computer.lane_branch ?? continuedBranchOf(row),
      };
      if (facts.laneId && facts.laneName) await markKeepLaneStatement(env, computer, facts, "freed").run();
      await deleteComputer(env, provider, computer, { who: "launch_continue", reason: "launch_continue_failed" }, now);
      logCloud("cloud.launch_continue_failed_lane_kept", { userId: row.user_id, launchId: row.launch_id, instanceId: row.instance_id });
    } catch (error) {
      reportCloudFailure("cloud.launch_continue_failed_end_failed", { launchId: row.launch_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
    }
  }
  return ended;
}

/** The branch a continue launch named for its lane, from its stored request. */
function continuedBranchOf(row: LaunchRow): string | null {
  const request = parseJsonColumn<{ lane?: { existingBranch?: unknown } } | null>(row.request_json, null, { launchId: row.launch_id, column: "request_json" });
  const branch = request?.lane?.existingBranch;
  return typeof branch === "string" && branch.trim() ? branch.trim() : null;
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
  await env.DB.batch(rows.flatMap((row) => [
    expiredLaunchMessagesStatement(env, row.launch_id, now),
    env.DB.prepare("delete from cloud_launches where launch_id = ? and expires_at < ?").bind(row.launch_id, now),
  ]));
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
  await env.DB.batch([
    accountLaunchMessagesStatement(env, userId),
    env.DB.prepare("delete from cloud_launches where user_id = ?").bind(userId),
  ]);
}
