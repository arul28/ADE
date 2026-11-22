/**
 * The ADE Cloud iPhone on Revyl (`phones.ts` picks the provider per account).
 *
 * ADE's partner key (`REVYL_PARTNER_API_KEY`) lives only here. Each ADE
 * account gets its own Revyl workspace, made for ADE's key under an id
 * (`ade-<userId>`, never an email). The server mints a short session
 * credential for that workspace when it needs one and keeps it in memory only.
 *
 * Revyl has no token for one phone, so a brain never holds a Revyl
 * credential: it calls `POST /cloud/phone/call` with its own account token,
 * and this file sends the call to the account's live phone, from an allowlist
 * (`CALL_ACTIONS`), and passes Revyl's answer back as it is.
 *
 * Revyl's phone has no time limit or spend cap of its own: the phone's
 * `stop_at` (`phones.ts`) is its limit, and the minute tick stops it.
 */

import { CLOUD_PATHS, type CloudPhoneDevice } from "./contract";
import { fail, json } from "./http";
import { logCloud, reportCloudFailure, type CloudEnv } from "./store";

export const REVYL_API_BASE = "https://backend.revyl.ai/api/v1";
const REQUEST_TIMEOUT_MS = 30_000;
/** A build's own calls (the source upload, an install of a large app) get longer. */
const SLOW_REQUEST_TIMEOUT_MS = 120_000;
/** Revyl's idle stop takes 300 to 900 seconds. */
const MIN_IDLE_SECONDS = 300;
/** How long a minted session credential is asked for; it is dropped a few minutes early. */
const SESSION_TTL_SECONDS = 7_200;
const SESSION_MARGIN_MS = 5 * 60_000;
/** A build runs at most this long on Revyl's runners (it bills by the hour). */
const BUILD_TIMEOUT_SECONDS = 900;
/** Revyl's Cloudflare refuses some default user agents. */
const USER_AGENT = "ade-account-directory/1 (+https://ade-app.dev)";

/** ADE's phone names as Revyl's models (`GET /execution/device-targets`). */
const REVYL_DEVICES: Record<CloudPhoneDevice, { model: string; os: string }> = {
  iphone: { model: "iPhone 18 Pro", os: "iOS 27.0" },
  "iphone-pro-max": { model: "iPhone 18 Pro Max", os: "iOS 27.0" },
  ipad: { model: "iPad Pro 13-inch (M4)", os: "iOS 26.2" },
};

export type RevylAnswer = { status: number; body: Record<string, unknown> | null };

/** A Revyl phone in the shape `phones.ts` keeps (NoMac's session shape). */
export type RevylPhoneSession = {
  id: string;
  state: string;
  device?: string;
  ready_at?: string | null;
  created_at?: string;
  ended?: { reason?: string | null; at?: string | null } | null;
  cost?: { billed_seconds?: number; accrued_microunits?: string };
  /** Revyl's workflow run: its device calls name the phone by it. */
  ref: string | null;
};

export const revylConfigured = (env: Pick<CloudEnv, "REVYL_PARTNER_API_KEY">): boolean => Boolean(env.REVYL_PARTNER_API_KEY?.trim());

/**
 * Revyl may start new phones: its key is set AND the owner's switch
 * `CLOUD_PHONE_REVYL` is `on`. Off (the default), every new phone is NoMac's,
 * whatever a beta row or `CLOUD_PHONE_PROVIDER` says; a Revyl phone already
 * running is still read, billed and stopped with the key.
 */
export const revylEnabled = (env: Pick<CloudEnv, "REVYL_PARTNER_API_KEY" | "CLOUD_PHONE_REVYL">): boolean =>
  revylConfigured(env) && env.CLOUD_PHONE_REVYL?.trim().toLowerCase() === "on";

/** Revyl's id for an ADE account's workspace: 1 to 128 of `[A-Za-z0-9_-]`. */
function externalIdFor(userId: string): string | null {
  const id = `ade-${userId}`;
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function revylFetch(key: string, method: string, path: string, init: { body?: unknown; query?: Record<string, string>; timeoutMs?: number } = {}): Promise<Response> {
  const query = init.query && Object.keys(init.query).length ? `?${new URLSearchParams(init.query).toString()}` : "";
  return await fetch(`${REVYL_API_BASE}${path}${query}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/json",
      "user-agent": USER_AGENT,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS),
    redirect: "manual",
  });
}

async function answerOf(response: Response): Promise<RevylAnswer> {
  if (response.status >= 300 && response.status < 400) return { status: 502, body: null };
  const parsed = await response.json().catch(() => null) as unknown;
  return { status: response.status, body: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null };
}

/** A call with ADE's partner key (workspaces and their credentials only). */
async function partner(env: Pick<CloudEnv, "REVYL_PARTNER_API_KEY">, method: string, path: string, body?: unknown): Promise<RevylAnswer> {
  const key = env.REVYL_PARTNER_API_KEY?.trim();
  if (!key) return { status: 503, body: null };
  return await answerOf(await revylFetch(key, method, path, { body })).catch((): RevylAnswer => ({ status: 504, body: null }));
}

/** Revyl's code and words: the partner API's `error` envelope, or the execution API's `detail`. */
export function revylErrorOf(answer: RevylAnswer): { code: string; message: string } {
  const error = answer.body?.error as { code?: unknown; message?: unknown } | undefined;
  const detail = answer.body?.detail;
  const code = typeof error?.code === "string" ? error.code : typeof answer.body?.code === "string" ? answer.body.code : `http_${answer.status}`;
  const message = typeof error?.message === "string" ? error.message
    : typeof detail === "string" ? detail
      : "The phone service did not answer.";
  return { code, message };
}

/* ---- The account's workspace ---- */

type WorkspaceRow = { user_id: string; external_id: string; app_id: string | null };

/** Session credentials minted this isolate's life, by workspace: never stored. */
const sessionKeys = new Map<string, { secret: string; expiresAt: number }>();

/**
 * The account's Revyl workspace, made on its first phone. `auto` makes a new
 * workspace for an address no Revyl account has: the address is ADE's own
 * (`revyl+<hash>@ade-app.dev`), so the person's email never reaches Revyl.
 */
async function workspaceOf(env: CloudEnv, userId: string, now: number): Promise<WorkspaceRow | Response> {
  const known = await env.DB.prepare("select user_id, external_id, app_id from cloud_phone_revyl where user_id = ?").bind(userId).first<WorkspaceRow>();
  if (known) return known;
  const externalId = externalIdFor(userId);
  if (!externalId) return fail("phone_unavailable", "The ADE Cloud iPhone can't be used with this account.", 400);
  const hash = (await sha256Hex(`ade-revyl:${userId}`)).slice(0, 16);
  const answer = await partner(env, "POST", "/partner/connections", {
    external_account_id: externalId,
    external_account_name: `ADE account ${hash.slice(0, 8)}`,
    organization_name: `ADE ${hash.slice(0, 8)}`,
    owner_email: `revyl+${hash}@ade-app.dev`,
    mode: "auto",
  });
  const code = revylErrorOf(answer).code;
  if (answer.status !== 201 && !(answer.status === 409 && code === "already_connected")) {
    reportCloudFailure(`cloud.phone_revyl_connect_failed.${code.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40)}`, { userId, status: answer.status, code }, "cloud-phone");
    return fail("phone_unavailable", "The ADE Cloud iPhone can't start right now. ADE has been told.", 503);
  }
  await env.DB.prepare("insert into cloud_phone_revyl (user_id, external_id, app_id, created_at, updated_at) values (?, ?, null, ?, ?) on conflict(user_id) do nothing")
    .bind(userId, externalId, now, now).run();
  logCloud("cloud.phone_revyl_workspace", { userId, created: answer.status === 201 });
  return { user_id: userId, external_id: externalId, app_id: null };
}

/** A session credential for the workspace: from memory while it lasts, else minted. */
async function workspaceKey(env: CloudEnv, workspace: WorkspaceRow, fresh = false): Promise<string | null> {
  const cached = sessionKeys.get(workspace.external_id);
  if (!fresh && cached && cached.expiresAt - Date.now() > SESSION_MARGIN_MS) return cached.secret;
  sessionKeys.delete(workspace.external_id);
  const answer = await partner(env, "POST", `/partner/connections/${encodeURIComponent(workspace.external_id)}/session-credentials`, { ttl_seconds: SESSION_TTL_SECONDS });
  const credential = answer.body?.credential as { secret?: unknown; expires_at?: unknown } | undefined;
  if (answer.status !== 201 || typeof credential?.secret !== "string") {
    reportCloudFailure("cloud.phone_revyl_credential_failed", { userId: workspace.user_id, status: answer.status, code: revylErrorOf(answer).code }, "cloud-phone");
    return null;
  }
  const expiresAt = typeof credential.expires_at === "string" && Number.isFinite(Date.parse(credential.expires_at))
    ? Date.parse(credential.expires_at)
    : Date.now() + SESSION_TTL_SECONDS * 1000;
  sessionKeys.set(workspace.external_id, { secret: credential.secret, expiresAt });
  return credential.secret;
}

/** One call in the account's workspace; a credential Revyl stopped taking is minted again once. */
async function workspaceCall(env: CloudEnv, workspace: WorkspaceRow, method: string, path: string, init: { body?: unknown; query?: Record<string, string>; timeoutMs?: number } = {}): Promise<Response> {
  let key = await workspaceKey(env, workspace);
  if (!key) return new Response(null, { status: 503 });
  let response = await revylFetch(key, method, path, init);
  if (response.status === 401) {
    key = await workspaceKey(env, workspace, true);
    if (!key) return new Response(null, { status: 503 });
    response = await revylFetch(key, method, path, init);
  }
  return response;
}

async function workspaceJson(env: CloudEnv, workspace: WorkspaceRow, method: string, path: string, init: { body?: unknown; query?: Record<string, string>; timeoutMs?: number } = {}): Promise<RevylAnswer> {
  return await answerOf(await workspaceCall(env, workspace, method, path, init)).catch((): RevylAnswer => ({ status: 504, body: null }));
}

/** The workspace's app that builds go to, made on the first build. */
async function workspaceApp(env: CloudEnv, workspace: WorkspaceRow, now: number): Promise<string | Response> {
  if (workspace.app_id) return workspace.app_id;
  const made = await workspaceJson(env, workspace, "POST", "/apps/", { body: { name: "ADE builds", platform: "iOS" } });
  // Made already (a first build racing another, or a row made again): Revyl names it.
  const existing = made.status === 409 && typeof made.body?.existing_app_id === "string" ? made.body.existing_app_id : null;
  const id = existing ?? (made.status < 300 && typeof made.body?.id === "string" ? made.body.id : null);
  if (!id) {
    reportCloudFailure("cloud.phone_revyl_app_failed", { userId: workspace.user_id, status: made.status, code: revylErrorOf(made).code }, "cloud-phone");
    return fail("phone_unavailable", "The cloud iPhone couldn't set up its builds. Try again in a moment.", 502);
  }
  await env.DB.prepare("update cloud_phone_revyl set app_id = coalesce(app_id, ?), updated_at = ? where user_id = ?").bind(id, now, workspace.user_id).run();
  const row = await env.DB.prepare("select app_id from cloud_phone_revyl where user_id = ?").bind(workspace.user_id).first<{ app_id: string | null }>();
  workspace.app_id = row?.app_id ?? id;
  return workspace.app_id;
}

/* ---- Phones ---- */

const LIVE = new Set(["queued", "pending", "setup", "starting", "provisioning", "initializing", "running"]);
const isoOf = (value: unknown): string | null => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null);

/** Revyl's end words as ADE's (`idle`, `time_limit`, `stopped`, `failed`). */
function endReasonOf(status: string, error: unknown): string {
  if (status === "failed") return typeof error === "string" && /idle/i.test(error) ? "idle" : "failed";
  if (status === "timeout") return "idle";
  return "stopped";
}

/** A Revyl device session as `phones.ts` keeps a phone. */
export function revylSessionOf(raw: Record<string, unknown> | null, device: string | null): RevylPhoneSession | null {
  if (!raw || typeof raw.id !== "string" || typeof raw.status !== "string") return null;
  const status = raw.status.toLowerCase();
  const startedAt = isoOf(raw.started_at);
  const state = status === "running" && startedAt ? "ready"
    : LIVE.has(status) ? "provisioning"
      : status === "stopping" ? "stopping"
        : status === "failed" ? "failed" : "stopped";
  const ended = !LIVE.has(status) && status !== "stopping";
  // Revyl fills `duration_seconds` once a session ends; until then it has run since `started_at`.
  const endedAt = isoOf(raw.ended_at);
  const ran = startedAt ? (Date.parse(endedAt ?? new Date().toISOString()) - Date.parse(startedAt)) / 1_000 : 0;
  const seconds = Math.max(0, Math.ceil(Number(raw.duration_seconds) || ran) || 0);
  return {
    id: raw.id,
    state,
    ...(device ? { device } : {}),
    ready_at: startedAt,
    created_at: isoOf(raw.created_at) ?? undefined,
    ended: ended ? { reason: endReasonOf(status, raw.error_message), at: endedAt } : null,
    // Revyl bills the second at $3.60 an hour: 1,000 micro-dollars a second.
    cost: { billed_seconds: seconds, accrued_microunits: String(seconds * 1_000) },
    ref: typeof raw.workflow_run_id === "string" ? raw.workflow_run_id : null,
  };
}

/** The account's workspace, or null when it has none yet (no phone ever started there). */
async function knownWorkspace(env: Pick<CloudEnv, "DB">, userId: string): Promise<WorkspaceRow | null> {
  return await env.DB.prepare("select user_id, external_id, app_id from cloud_phone_revyl where user_id = ?").bind(userId).first<WorkspaceRow>() ?? null;
}

/** One phone as Revyl answers it now, or null when it can't be read. */
export async function readRevylPhone(env: CloudEnv, userId: string, phoneId: string, device: string | null): Promise<RevylPhoneSession | null> {
  const workspace = await knownWorkspace(env, userId);
  if (!workspace) return null;
  const answer = await workspaceJson(env, workspace, "GET", `/execution/device-sessions/${encodeURIComponent(phoneId)}`);
  return answer.status === 200 ? revylSessionOf(answer.body, device) : null;
}

/**
 * Starts a phone in the account's workspace, or answers one already running
 * there (a start whose answer was lost): one phone per account.
 */
export async function startRevylPhone(env: CloudEnv, userId: string, device: CloudPhoneDevice | undefined, idleSeconds: number, now: number): Promise<{ session: RevylPhoneSession; reused: boolean } | Response> {
  const workspace = await workspaceOf(env, userId, now);
  if (workspace instanceof Response) return workspace;
  const named = device ?? "iphone";
  const active = await workspaceJson(env, workspace, "GET", "/execution/device-sessions/active");
  const running = Array.isArray(active.body?.sessions)
    ? (active.body.sessions as Array<Record<string, unknown>>).find((session) => String(session.platform ?? "").toLowerCase() === "ios")
    : undefined;
  if (running && typeof running.id === "string") {
    const read = await readRevylPhone(env, userId, running.id, named);
    if (read && read.state !== "stopped" && read.state !== "failed") return { session: read, reused: true };
  }
  const target = REVYL_DEVICES[named];
  const started = await workspaceJson(env, workspace, "POST", "/execution/start_device", {
    body: {
      platform: "ios",
      is_simulation: true,
      idle_timeout_seconds: Math.max(MIN_IDLE_SECONDS, idleSeconds),
      device_model: target.model,
      os_version: target.os,
    },
    timeoutMs: SLOW_REQUEST_TIMEOUT_MS,
  });
  const sessionId = started.body?.session_id;
  if (started.status >= 300 || typeof sessionId !== "string") {
    const { code } = revylErrorOf(started);
    reportCloudFailure(`cloud.phone_start_failed.revyl_${code.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40)}`, { userId, status: started.status, code }, "cloud-phone");
    if (started.status === 429) return fail("phone_busy", "Too many phones started in a row. Wait a minute, then try again.", 429);
    return fail("phone_unavailable", started.status >= 500 ? "The ADE Cloud iPhone isn't answering right now. Try again in a moment." : `The ADE Cloud iPhone refused that: ${revylErrorOf(started).message}`, started.status >= 500 ? 502 : 400);
  }
  const read = await readRevylPhone(env, userId, sessionId, named);
  return {
    session: read ?? {
      id: sessionId,
      state: "provisioning",
      device: named,
      created_at: new Date(now).toISOString(),
      ref: typeof started.body?.workflow_run_id === "string" ? started.body.workflow_run_id : null,
    },
    reused: false,
  };
}

/** Stops one phone. Answers Revyl's status (404: already gone). */
export async function stopRevylPhone(env: CloudEnv, userId: string, phoneId: string): Promise<number> {
  const workspace = await knownWorkspace(env, userId);
  if (!workspace) return 404;
  const answer = await workspaceJson(env, workspace, "POST", `/execution/device/sessions/${encodeURIComponent(phoneId)}/stop`);
  return answer.status;
}

/**
 * The view link: ADE's viewer page (`CLOUD_PATHS.phoneViewer`) with the
 * phone's WebRTC stream and its input link after `#`, so neither reaches a
 * server log. The input link carries Revyl's token for this phone's worker.
 */
export async function revylViewUrl(env: CloudEnv, userId: string, ref: string, origin: string, control: boolean): Promise<{ url: string; points: { width: number; height: number } | null } | Response> {
  const workspace = await knownWorkspace(env, userId);
  if (!workspace) return fail("phone_not_running", "Your ADE Cloud iPhone isn't running. Start it first.", 409);
  const answer = await workspaceJson(env, workspace, "GET", `/execution/streaming/worker-connection/${encodeURIComponent(ref)}`);
  const whep = answer.body?.whep_url;
  const socket = answer.body?.worker_ws_url;
  if (answer.status !== 200 || typeof whep !== "string" || !whep.startsWith("https://")) {
    if (answer.status === 200 && answer.body?.status === "not_ready") return fail("phone_starting", "Your ADE Cloud iPhone is still starting. Try again in a moment.", 409);
    reportCloudFailure("cloud.phone_view_failed.revyl", { userId, status: answer.status, code: revylErrorOf(answer).code }, "cloud-phone");
    return fail("phone_unavailable", "The ADE Cloud iPhone isn't answering right now. Try again in a moment.", 502);
  }
  const width = Number(answer.body?.device_width);
  const height = Number(answer.body?.device_height);
  const points = width > 0 && height > 0 ? { width, height } : null;
  const fragment = new URLSearchParams({
    whep,
    ...(control && typeof socket === "string" && socket.startsWith("wss://") ? { ws: socket } : {}),
    ...(points ? { w: String(points.width), h: String(points.height) } : {}),
    ...(Array.isArray(answer.body?.ice_servers) ? { ice: JSON.stringify(answer.body.ice_servers) } : {}),
  });
  return { url: `${origin}${CLOUD_PATHS.phoneViewer}#${fragment.toString()}`, points };
}

/**
 * An account's deletion: its workspace is disconnected (Revyl stops its live
 * phones and revokes its credentials) and its row goes. Throws while Revyl
 * can't finish, so the deletion is retried.
 */
export async function forgetRevylAccount(env: Pick<CloudEnv, "DB" | "REVYL_PARTNER_API_KEY">, userId: string): Promise<void> {
  const workspace = await knownWorkspace(env, userId);
  if (!workspace) return;
  if (!revylConfigured(env)) throw new Error("phone_cleanup_no_revyl_key");
  const answer = await partner(env, "DELETE", `/partner/connections/${encodeURIComponent(workspace.external_id)}`);
  if (answer.status >= 400 && answer.status !== 404) throw new Error(`phone_revyl_disconnect_${revylErrorOf(answer).code}`);
  sessionKeys.delete(workspace.external_id);
  await env.DB.prepare("delete from cloud_phone_revyl where user_id = ?").bind(userId).run();
}

/* ---- `POST /cloud/phone/call` ---- */

/**
 * The calls a brain may make on its live Revyl phone. `proxy` actions go to
 * Revyl's device proxy for that phone (`/execution/device-proxy/<run>/<name>`);
 * the rest are a build's own steps in the account's workspace. Anything else
 * is refused: no call reaches another phone, another workspace, or Revyl's
 * AI-billed steps.
 */
const PROXY_ACTIONS: Record<string, "GET" | "POST"> = {
  health: "GET",
  hierarchy: "GET",
  screenshot: "GET",
  device_logs: "GET",
  appearance: "GET",
  tap: "POST",
  double_tap: "POST",
  longpress: "POST",
  swipe: "POST",
  drag: "POST",
  input: "POST",
  clear_text: "POST",
  key: "POST",
  go_home: "POST",
  open_url: "POST",
  launch: "POST",
  kill_app: "POST",
  install: "POST",
  set_location: "POST",
  push_notification: "POST",
  set_permissions: "POST",
  set_appearance: "POST",
  set_font_size: "POST",
  set_orientation: "POST",
  start_screen_recording: "POST",
  stop_screen_recording: "POST",
};
const BUILD_ACTIONS = new Set(["build.upload_url", "build.start", "build.status", "build.logs", "build.install"]);
export const phoneCallActions = (): string[] => [...Object.keys(PROXY_ACTIONS).map((name) => `proxy.${name}`), ...BUILD_ACTIONS];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCHEME = /^[A-Za-z0-9 _.+()-]{1,200}$/;
/** A folder inside the uploaded project: no `..`, no absolute path, no shell quote. */
const SUB_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9 _.+@()/-]{1,500}$/;

/** The passthrough: Revyl's status, type and body as they are (a screenshot's PNG, a recording's video). */
function passthrough(response: Response): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  const type = response.headers.get("content-type");
  if (type) headers.set("content-type", type);
  return new Response(response.body, { status: response.status, headers });
}

/** Single-quoted for sh. */
const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/**
 * The build step ADE runs on Revyl's runner, from the brain's choices only
 * (never a command it sends): find the workspace or project in `path`, the
 * scheme (the first, unless named), then build for the Simulator into
 * `build/` at the project's top, where the artifact is collected.
 */
function buildCommand(input: { sub: string; scheme: string | null; configuration: "Debug" | "Release"; clean: boolean }): string {
  return [
    "set -eu",
    "ROOT=$(pwd)",
    `cd ${shellQuote(input.sub)}`,
    "WS=$(find . -maxdepth 1 -name '*.xcworkspace' ! -name 'project.xcworkspace' | head -n 1)",
    "PJ=$(find . -maxdepth 1 -name '*.xcodeproj' | head -n 1)",
    "if [ -z \"$WS$PJ\" ] && [ -f project.yml ] && command -v xcodegen >/dev/null 2>&1; then xcodegen generate; PJ=$(find . -maxdepth 1 -name '*.xcodeproj' | head -n 1); fi",
    "if [ -f Podfile ] && [ ! -d Pods ] && command -v pod >/dev/null 2>&1; then pod install; WS=$(find . -maxdepth 1 -name '*.xcworkspace' ! -name 'project.xcworkspace' | head -n 1); fi",
    "if [ -n \"$WS\" ]; then set -- -workspace \"$WS\"; elif [ -n \"$PJ\" ]; then set -- -project \"$PJ\"; else echo 'No Xcode workspace or project found to build.' >&2; exit 65; fi",
    `SCHEME=${shellQuote(input.scheme ?? "")}`,
    "if [ -z \"$SCHEME\" ]; then SCHEME=$(xcodebuild \"$@\" -list 2>/dev/null | awk '/Schemes:/{f=1;next} f&&NF{sub(/^ +/,\"\");print;exit}'); fi",
    "if [ -z \"$SCHEME\" ]; then echo 'No scheme found to build.' >&2; exit 65; fi",
    "echo \"ADE: building $SCHEME (" + input.configuration + ")\"",
    `xcodebuild "$@" -scheme "$SCHEME" -configuration ${input.configuration} -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath "$ROOT/build" ARCHS=arm64 CODE_SIGNING_ALLOWED=NO ${input.clean ? "clean " : ""}build`,
  ].join("\n");
}

const stringArg = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * `POST /cloud/phone/call` for an account whose live phone is Revyl's.
 * `phoneId` and `ref` name that phone (`phones.ts` read it live just now).
 */
export async function routeRevylCall(env: CloudEnv, userId: string, phone: { id: string; ref: string | null }, body: Record<string, unknown>, now: number): Promise<Response> {
  const action = typeof body.action === "string" ? body.action : "";
  const args = body.body && typeof body.body === "object" && !Array.isArray(body.body) ? body.body as Record<string, unknown> : {};
  const query = body.query && typeof body.query === "object" && !Array.isArray(body.query)
    ? Object.fromEntries(Object.entries(body.query as Record<string, unknown>).filter((entry): entry is [string, string] => /^[a-z_]{1,40}$/.test(entry[0]) && typeof entry[1] === "string" && entry[1].length <= 200))
    : {};
  const workspace = await knownWorkspace(env, userId);
  if (!workspace) return fail("phone_not_running", "Your ADE Cloud iPhone isn't running. Start it first.", 409);

  if (action.startsWith("proxy.")) {
    const name = action.slice("proxy.".length);
    const method = Object.hasOwn(PROXY_ACTIONS, name) ? PROXY_ACTIONS[name] : undefined;
    if (!method) return fail("bad_request", `${action} isn't a cloud iPhone action.`, 400);
    if (!phone.ref) return fail("phone_starting", "Your ADE Cloud iPhone is still starting. Try again in a moment.", 409);
    // Revyl names a recording only when it starts: the phone's row keeps it, so any brain of the account stops it.
    const stopping = name === "stop_screen_recording";
    if (stopping && typeof args.recording_id !== "string") {
      const row = await env.DB.prepare("select recording_ref from cloud_phones where phone_id = ? and user_id = ?").bind(phone.id, userId).first<{ recording_ref: string | null }>();
      if (!row?.recording_ref) return fail("not_recording", "No recording is running on this cloud iPhone.", 404);
      args.recording_id = row.recording_ref;
    }
    const slow = name === "install" || stopping;
    const response = await workspaceCall(env, workspace, method, `/execution/device-proxy/${encodeURIComponent(phone.ref)}/${name}`, {
      ...(method === "POST" ? { body: args } : {}),
      query,
      ...(slow ? { timeoutMs: SLOW_REQUEST_TIMEOUT_MS } : {}),
    }).catch(() => new Response(null, { status: 504 }));
    if (name === "start_screen_recording" && response.ok) {
      const started = await response.clone().json().catch(() => null) as { recording_id?: unknown } | null;
      if (typeof started?.recording_id === "string") {
        await env.DB.prepare("update cloud_phones set recording_ref = ? where phone_id = ? and user_id = ?").bind(started.recording_id, phone.id, userId).run();
      }
    } else if (stopping && response.status < 500) {
      await env.DB.prepare("update cloud_phones set recording_ref = null where phone_id = ? and user_id = ?").bind(phone.id, userId).run();
    }
    return passthrough(response);
  }
  if (!BUILD_ACTIONS.has(action)) return fail("bad_request", `${action || "That"} isn't a cloud iPhone action.`, 400);
  const app = await workspaceApp(env, workspace, now);
  if (app instanceof Response) return app;

  if (action === "build.upload_url") {
    const size = Number(args.file_size);
    if (!Number.isInteger(size) || size <= 0 || size > 2 * 1024 ** 3) return fail("bad_request", "file_size is the archive's size in bytes, up to 2 GB.", 400);
    const answer = await workspaceJson(env, workspace, "POST", "/apps/remote/upload-url", { body: { app_id: app, file_size: size, filename: "source.tar.gz" } });
    return json(answer.body ?? {}, answer.status);
  }
  if (action === "build.start") {
    const key = stringArg(args.source_key);
    // Only a source this workspace's app uploaded to.
    if (!key || !key.includes(`/build-sources/${app}/`) || key.length > 500) return fail("bad_request", "source_key is the key build.upload_url answered.", 400);
    const sub = stringArg(args.path) ?? ".";
    if (sub !== "." && !SUB_PATH.test(sub)) return fail("bad_request", "path is a folder inside the project.", 400);
    const scheme = stringArg(args.scheme);
    if (scheme && !SCHEME.test(scheme)) return fail("bad_request", "That scheme name can't be built.", 400);
    const configuration = args.configuration === "Release" ? "Release" : "Debug";
    // `prebuilt`: the source is one Simulator `.app` built elsewhere; the runner only hands it back as the build's app.
    const prebuilt = args.prebuilt === true;
    const recipe = {
      app_id: app,
      artifacts: [{ name: "app", path: prebuilt ? "*.app" : `build/Build/Products/${configuration}-iphonesimulator/*.app`, type: "app" }],
      build_steps: [{ command: prebuilt ? "set -eu\nls -d ./*.app" : buildCommand({ sub, scheme, configuration, clean: args.clean === true }), type: "run" }],
      framework: "ios",
      platform: "ios",
      profile: "ade",
    };
    const answer = await workspaceJson(env, workspace, "POST", "/apps/remote", {
      body: { build_definition_hash: await sha256Hex(JSON.stringify(recipe)), git_branch_name: "ade", recipe, source: { key, type: "archive" }, timeout_seconds: BUILD_TIMEOUT_SECONDS },
      timeoutMs: SLOW_REQUEST_TIMEOUT_MS,
    });
    logCloud("cloud.phone_revyl_build", { userId, status: answer.status });
    return json(answer.body ?? {}, answer.status);
  }
  const job = stringArg(args.job);
  if (action === "build.status" || action === "build.logs") {
    if (!job || !UUID.test(job)) return fail("bad_request", "job is the build's id.", 400);
    const answer = await workspaceJson(env, workspace, "GET", `/apps/remote/${encodeURIComponent(job)}/${action === "build.status" ? "status" : "logs"}`, { query });
    return json(answer.body ?? {}, answer.status);
  }
  // build.install: the build's app, into the live phone.
  const version = stringArg(args.version_id);
  if (!version || !UUID.test(version)) return fail("bad_request", "version_id is the build's version.", 400);
  if (!phone.ref) return fail("phone_starting", "Your ADE Cloud iPhone is still starting. Try again in a moment.", 409);
  const build = await workspaceJson(env, workspace, "GET", `/apps/builds/${encodeURIComponent(version)}`, { query: { include_download_url: "true" } });
  if (build.status !== 200 || build.body?.app_id !== app) return fail("bad_request", "That build isn't one of this account's.", 400);
  const download = Object.values(build.body ?? {}).find((value): value is string => typeof value === "string" && value.startsWith("https://"));
  if (!download) return fail("phone_unavailable", "The build has no app to install.", 502);
  const bundleId = typeof (build.body?.metadata as { bundle_id?: unknown } | undefined)?.bundle_id === "string"
    ? (build.body!.metadata as { bundle_id: string }).bundle_id
    : typeof build.body?.package_id === "string" ? build.body.package_id : undefined;
  const installed = await workspaceJson(env, workspace, "POST", `/execution/device-proxy/${encodeURIComponent(phone.ref)}/install`, {
    body: { app_url: download, build_id: version, ...(bundleId ? { bundle_id: bundleId } : {}) },
    timeoutMs: SLOW_REQUEST_TIMEOUT_MS,
  });
  return json({ ...(installed.body ?? {}), ...(bundleId && !installed.body?.bundle_id ? { bundle_id: bundleId } : {}) }, installed.status);
}

/* ---- `GET /cloud/phone/viewer` ---- */

/**
 * ADE's page for a phone streamed over WebRTC. It plays the `#whep=` stream in
 * a video sized to the screen, under one clear canvas that takes input (no
 * per-frame copy), and with `#ws=` sends the person's touches and keys to the
 * phone in its own points as Revyl's own player does: touch down, move, up;
 * typed text and Enter/Backspace at the field last tapped. Keys arrive through
 * a hidden input that never raises an on-screen keyboard. The desktop pane,
 * the iPhone app and the web app open it as they open NoMac's page: they find
 * the canvas, press "home", and read "not running" when the phone ends.
 */
export function revylViewerPage(): Response {
  return new Response(VIEWER_HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src https: wss:; media-src blob: https:; img-src data: blob:",
    },
  });
}

const VIEWER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>ADE Cloud iPhone</title>
<style>
html,body{margin:0;height:100%;background:#000;overflow:hidden;font:14px -apple-system,system-ui,sans-serif;color:#aaa}
#stage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
#frame{position:relative;background:#000}
#frame video,#frame canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
canvas{touch-action:none;cursor:pointer;background:transparent}
#keys{position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;border:0;padding:0;font-size:16px;pointer-events:none}
#note{position:absolute;left:0;right:0;bottom:16px;text-align:center;pointer-events:none}
#home{position:absolute;left:-1000px;top:0}
</style></head>
<body><div id="stage"><div id="frame"><video id="video" muted playsinline autoplay></video><canvas id="screen" width="1" height="1"></canvas></div></div><input id="keys" inputmode="none" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-hidden="true" tabindex="-1"><div id="note">Connecting to the phone…</div><button id="home" tabindex="-1">Home</button>
<script>
(function(){
  var params = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, "", location.pathname);
  var whep = params.get("whep"), wsUrl = params.get("ws");
  var W = Number(params.get("w")) || 440, H = Number(params.get("h")) || 956;
  var ice = []; try { ice = JSON.parse(params.get("ice") || "[]"); } catch (e) {}
  // The video shows itself; the canvas over it is clear and only takes touches (and is what hosts measure).
  var canvas = document.getElementById("screen"), frame = document.getElementById("frame"), keys = document.getElementById("keys");
  var video = document.getElementById("video"), note = document.getElementById("note");
  var ended = false, live = false;
  function say(text){ note.textContent = text; note.style.display = text ? "" : "none"; }
  function end(){ if (ended) return; ended = true; say("The phone is not running any more."); }
  function fit(){
    var scale = Math.min(innerWidth / W, innerHeight / H);
    frame.style.width = Math.floor(W * scale) + "px"; frame.style.height = Math.floor(H * scale) + "px";
  }
  addEventListener("resize", fit); fit();
  video.addEventListener("playing", function(){ if (!live) { live = true; say(""); } });
  // A web view that wants a tap before video plays (the iPhone app's) gets one.
  function resume(){ if (video.srcObject && video.paused) video.play().catch(function(){ if (!live && !ended) say("Tap to show the phone."); }); }
  async function play(){
    if (!whep) { say("This link has no stream."); return; }
    var pc = new RTCPeerConnection({ iceServers: ice });
    var stream = new MediaStream();
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
    pc.ontrack = function(event){ if (event.track.kind === "video") { stream.addTrack(event.track); video.srcObject = stream; resume(); } };
    pc.onconnectionstatechange = function(){ if (pc.connectionState === "failed" || pc.connectionState === "closed") end(); };
    var offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    await new Promise(function(resolve){ if (pc.iceGatheringState === "complete") return resolve(); var t = setTimeout(resolve, 2000); pc.addEventListener("icegatheringstatechange", function(){ if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(); } }); });
    var answer = await fetch(whep, { method: "POST", headers: { "content-type": "application/sdp" }, body: pc.localDescription.sdp });
    if (answer.status === 404 || answer.status === 410) return end();
    if (!answer.ok) throw new Error("stream " + answer.status);
    await pc.setRemoteDescription({ type: "answer", sdp: await answer.text() });
  }
  play().catch(function(){ if (!ended) say("The phone's picture didn't load. Close and open the view again."); });

  var socket = null, actionId = 0, queue = [];
  function connect(){
    if (!wsUrl || ended) return;
    socket = new WebSocket(wsUrl);
    socket.onopen = function(){ while (queue.length) socket.send(queue.shift()); };
    socket.onclose = function(event){ socket = null; if (event.code === 4404 || event.code === 4410) return end(); if (!ended) setTimeout(connect, 1000); };
    socket.onmessage = function(event){ if (typeof event.data === "string" && /"(SESSION_ENDED|DEVICE_STOPPED|session_ended)"/.test(event.data)) end(); };
  }
  function send(action, fields){
    if (!wsUrl || ended) return;
    var message = JSON.stringify(Object.assign({ event_type: "STREAM", action: "MANUAL_" + action, action_id: ++actionId, client_sent_at_ms: Date.now() }, fields));
    if (socket && socket.readyState === 1) socket.send(message); else { queue.push(message); if (queue.length > 50) queue.shift(); }
  }
  connect();

  function point(event){
    var rect = canvas.getBoundingClientRect();
    return { x: Math.round(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * W), y: Math.round(Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) * H) };
  }
  var down = null;
  // A cancelled press gives no focus by itself: it focuses a hidden input instead, so keys reach this page
  // (in an iframe, and in the iPhone app's web view, which sends keys only to a text field). No on-screen keyboard.
  canvas.addEventListener("pointerdown", function(event){ event.preventDefault(); keys.focus({ preventScroll: true }); resume(); canvas.setPointerCapture && canvas.setPointerCapture(event.pointerId); var p = point(event); down = { x: p.x, y: p.y, at: Date.now(), last: p }; send("TOUCH_DOWN", p); });
  canvas.addEventListener("pointermove", function(event){ if (!down) return; var p = point(event); down.last = p; send("TOUCH_MOVE", p); });
  function lift(event){
    if (!down) return; var p = event && event.clientX !== undefined ? point(event) : down.last; var held = Date.now() - down.at;
    var gesture = Math.hypot(p.x - down.x, p.y - down.y) >= 12 ? "drag" : held >= 500 ? "long_press" : "tap";
    send("TOUCH_UP", { x: p.x, y: p.y, gesture: gesture, duration_ms: held }); down = null;
    if (gesture === "tap") { flush(); lastTap = { x: p.x, y: p.y }; }
  }
  canvas.addEventListener("pointerup", lift); canvas.addEventListener("pointercancel", lift);
  var wheel = null;
  canvas.addEventListener("wheel", function(event){
    event.preventDefault();
    var p = point(event);
    if (!wheel) { wheel = { x: p.x, y: p.y, cx: p.x, cy: p.y, at: Date.now() }; send("TOUCH_DOWN", { x: p.x, y: p.y }); }
    wheel.cx = Math.max(0, Math.min(W, wheel.cx - event.deltaX)); wheel.cy = Math.max(0, Math.min(H, wheel.cy - event.deltaY));
    send("TOUCH_MOVE", { x: Math.round(wheel.cx), y: Math.round(wheel.cy) });
    clearTimeout(wheel.timer);
    wheel.timer = setTimeout(function(){ send("TOUCH_UP", { x: Math.round(wheel.cx), y: Math.round(wheel.cy), gesture: "drag", duration_ms: Date.now() - wheel.at }); wheel = null; }, 120);
  }, { passive: false });
  // Typing goes to the field last tapped, as Revyl's own player sends it: the
  // text at that point, a few keys at a time; Enter and Backspace as keys there.
  var lastTap = null, typed = "", typeTimer = null;
  function flush(){ clearTimeout(typeTimer); typeTimer = null; if (!typed || !lastTap) { typed = ""; return; } send("INPUT", { x: lastTap.x, y: lastTap.y, value: typed, incremental: true, skip_tap: true, clear_first: false }); typed = ""; }
  function type(text){ if (!lastTap) return; typed += text; if (!typeTimer) typeTimer = setTimeout(flush, 25); }
  var NAMED = { Enter: "ENTER", Backspace: "BACKSPACE" };
  addEventListener("keydown", function(event){
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (NAMED[event.key]) { event.preventDefault(); if (!lastTap) return; flush(); send("KEY", { x: lastTap.x, y: lastTap.y, key: NAMED[event.key] }); return; }
    if (Array.from(event.key).length === 1) { event.preventDefault(); type(event.key); }
  });
  // Text that comes with no key (an input method, dictation, a paste of words) arrives as the input's value.
  keys.addEventListener("input", function(){ if (keys.value) { type(keys.value); keys.value = ""; } });
  addEventListener("paste", function(event){
    var text = event.clipboardData && event.clipboardData.getData("text/plain");
    if (text) { event.preventDefault(); type(text.slice(0, 2000)); }
  });
  document.getElementById("home").addEventListener("click", function(){ send("GO_HOME", {}); });
})();
</script></body></html>`;
