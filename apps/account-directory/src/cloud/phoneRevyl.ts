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
 * `stop_at` (`phones.ts`) is its limit, and the minute tick stops it. Its view
 * link opens ADE's own viewer page (`phoneViewerPage.ts`).
 */

import { CLOUD_PHONE_IDLE_SECONDS } from "../../../desktop/src/shared/cloudPhone";
import { CLOUD_PATHS, withoutPhoneProviderNames, type CloudPhoneDevice } from "./contract";
import { fail, json } from "./http";
import { LIVE_STATES, TOKEN_MINUTES, VIEW_MINUTES, stopRefused, type PhoneProviderServer, type PhoneRead, type PhoneWhere } from "./phoneProvider";
import { accountRules, logCloud, reportCloudFailure, type CloudEnv } from "./store";

/** What Revyl bills ADE: the second, at $3.60 an hour, which is 1,000 micro-dollars a second. */
export const REVYL_MICROS_PER_SECOND = 1_000;

const REVYL_API_BASE = "https://backend.revyl.ai/api/v1";
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

type RevylAnswer = { status: number; body: Record<string, unknown> | null };

/** A Revyl phone in the shape `phones.ts` keeps (NoMac's session shape). */
type RevylPhoneSession = {
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

const revylConfigured = (env: Pick<CloudEnv, "REVYL_PARTNER_API_KEY">): boolean => Boolean(env.REVYL_PARTNER_API_KEY?.trim());

/**
 * Revyl may start new phones: its key is set AND the owner's switch
 * `CLOUD_PHONE_REVYL` is `on`. Off (the default), every new phone is NoMac's,
 * whatever a beta row or `CLOUD_PHONE_PROVIDER` says; a Revyl phone already
 * running is still read, billed and stopped with the key.
 */
const revylEnabled = (env: Pick<CloudEnv, "REVYL_PARTNER_API_KEY" | "CLOUD_PHONE_REVYL">): boolean =>
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

/** A timeout or a dropped connection: answered like a gateway timeout, and logged (the path, never a credential). */
function unreachable(method: string, path: string, error: unknown): RevylAnswer {
  logCloud("cloud.phone_revyl_unreachable", { method, path, message: error instanceof Error ? error.message : "unknown" });
  return { status: 504, body: null };
}

/** A call with ADE's partner key (workspaces and their credentials only). */
async function partner(env: Pick<CloudEnv, "REVYL_PARTNER_API_KEY">, method: string, path: string, body?: unknown): Promise<RevylAnswer> {
  const key = env.REVYL_PARTNER_API_KEY?.trim();
  if (!key) return { status: 503, body: null };
  try {
    return await answerOf(await revylFetch(key, method, path, { body }));
  } catch (error) {
    return unreachable(method, path, error);
  }
}

/** Revyl's code and words: the partner API's `error` envelope, or the execution API's `detail`. */
function revylErrorOf(answer: RevylAnswer): { code: string; message: string } {
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
  // Kept only for an account that still exists: one deleted meanwhile has its connection taken back at once.
  const kept = await env.DB.prepare(`
    insert into cloud_phone_revyl (user_id, external_id, app_id, created_at, updated_at)
    select ?, ?, null, ?, ? where exists (select 1 from cloud_accounts where user_id = ? and deleted_at is null)
    on conflict(user_id) do nothing
  `).bind(userId, externalId, now, now, userId).run();
  if ((kept.meta?.changes ?? 0) === 0 && !(await env.DB.prepare("select 1 from cloud_phone_revyl where user_id = ?").bind(userId).first())) {
    const undone = await partner(env, "DELETE", `/partner/connections/${encodeURIComponent(externalId)}`);
    if (undone.status >= 400 && undone.status !== 404) reportCloudFailure("cloud.phone_revyl_orphan_disconnect_failed", { userId, status: undone.status, code: revylErrorOf(undone).code }, "cloud-phone");
    return fail("phone_unavailable", "The ADE Cloud iPhone can't be used with this account.", 400);
  }
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
  try {
    return await answerOf(await workspaceCall(env, workspace, method, path, init));
  } catch (error) {
    return unreachable(method, path, error);
  }
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
function revylSessionOf(raw: Record<string, unknown> | null, device: string | null): RevylPhoneSession | null {
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
    cost: { billed_seconds: seconds, accrued_microunits: String(seconds * REVYL_MICROS_PER_SECOND) },
    ref: typeof raw.workflow_run_id === "string" ? raw.workflow_run_id : null,
  };
}

/** The account's workspace, or null when it has none yet (no phone ever started there). */
async function knownWorkspace(env: Pick<CloudEnv, "DB">, userId: string): Promise<WorkspaceRow | null> {
  return await env.DB.prepare("select user_id, external_id, app_id from cloud_phone_revyl where user_id = ?").bind(userId).first<WorkspaceRow>() ?? null;
}

/** One phone as Revyl answers it now, or null when it can't be read. */
async function readRevylPhone(env: CloudEnv, userId: string, phoneId: string, device: string | null): Promise<RevylPhoneSession | null> {
  const workspace = await knownWorkspace(env, userId);
  if (!workspace) return null;
  const answer = await workspaceJson(env, workspace, "GET", `/execution/device-sessions/${encodeURIComponent(phoneId)}`);
  return answer.status === 200 ? revylSessionOf(answer.body, device) : null;
}

/**
 * Starts a phone in the account's workspace, or answers one already running
 * there (a start whose answer was lost): one phone per account.
 */
async function startRevylPhone(env: CloudEnv, userId: string, device: CloudPhoneDevice | undefined, idleSeconds: number, now: number): Promise<{ session: RevylPhoneSession; reused: boolean } | Response> {
  const workspace = await workspaceOf(env, userId, now);
  if (workspace instanceof Response) return workspace;
  const named = device ?? "iphone";
  const active = await workspaceJson(env, workspace, "GET", "/execution/device-sessions/active");
  const running = Array.isArray(active.body?.sessions)
    ? (active.body.sessions as Array<Record<string, unknown>>).find((session) => String(session.platform ?? "").toLowerCase() === "ios")
    : undefined;
  if (running && typeof running.id === "string") {
    // Only a phone still coming up or running: never one stopping, nor one ADE already saw end (a stop, then a start).
    const read = await readRevylPhone(env, userId, running.id, named);
    const row = read ? await env.DB.prepare("select state from cloud_phones where phone_id = ?").bind(running.id).first<{ state: string }>() : null;
    if (read && (read.state === "ready" || read.state === "provisioning") && row?.state !== "ended") return { session: read, reused: true };
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
    // A 5xx, a timeout, or a success with no session id may have made a phone: unknown (502), never a refusal.
    const unknown = started.status >= 500 || started.status < 300;
    return fail("phone_unavailable", unknown ? "The ADE Cloud iPhone isn't answering right now. Try again in a moment." : `The ADE Cloud iPhone refused that: ${withoutPhoneProviderNames(revylErrorOf(started).message)}`, unknown ? 502 : 400);
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
async function stopRevylPhone(env: CloudEnv, userId: string, phoneId: string): Promise<number> {
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
async function revylViewUrl(env: CloudEnv, userId: string, ref: string, origin: string, control: boolean): Promise<{ url: string; points: { width: number; height: number } | null } | Response> {
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

/** Revyl's phone time: `cloud_phones.cost_micros` already counts it, so a day's other costs leave it out. */
const PHONE_METER = "ios_simulator_seconds";

type CostWorkspace = WorkspaceRow & { plan: string | null; stripe_status: string | null };
type RevylCostEnv = Pick<CloudEnv, "DB" | "REVYL_PARTNER_API_KEY">;

/** Revyl's price for each meter (`GET /partner/usage`), or null when it can't be read (reported). */
async function revylPrices(env: RevylCostEnv): Promise<Map<string, number> | null> {
  const priced = await partner(env, "GET", "/partner/usage");
  const meters = Array.isArray(priced.body?.meters) ? priced.body.meters as Array<Record<string, unknown>> : null;
  if (priced.status !== 200 || !meters) {
    reportCloudFailure("cloud.revyl_day_prices_failed", { status: priced.status, code: revylErrorOf(priced).code });
    return null;
  }
  return new Map(meters.flatMap((meter) => typeof meter.meter === "string" && Number.isFinite(Number(meter.unit_price_usd))
    ? [[meter.meter, Number(meter.unit_price_usd)] as const] : []));
}

/**
 * Each workspace's charges on each of `days` (UTC) beyond its phones' time,
 * written to `cloud_revyl_days` (a day read again gets the new amount and
 * keeps its first `free`, so a later plan change never moves past use). `free`
 * is the plan the account's Revyl phones that day started on, or its plan at
 * the first read on a day it ran none (a build with no phone). Answers how many
 * workspace-days could not be read.
 */
async function writeWorkspaceDays(env: RevylCostEnv, prices: Map<string, number>, workspaces: CostWorkspace[], days: string[], now: number): Promise<number> {
  const statements: D1PreparedStatement[] = [];
  let unread = 0;
  for (const day of days) {
    const from = Date.parse(`${day}T00:00:00Z`);
    const phoneFree = new Map(((await env.DB.prepare(`
      select user_id, max(free) as free from cloud_phones where provider = 'revyl' and created_at >= ? and created_at < ? group by user_id
    `).bind(from, from + 86_400_000).all<{ user_id: string; free: number }>()).results ?? []).map((row) => [row.user_id, row.free]));
    const range = new URLSearchParams({ from: `${day}T00:00:00Z`, to: new Date(from + 86_400_000).toISOString().replace(".000Z", "Z") });
    for (const workspace of workspaces) {
      const answer = await partner(env, "GET", `/partner/connections/${encodeURIComponent(workspace.external_id)}/usage?${range.toString()}`);
      const rows = Array.isArray(answer.body?.usage) ? answer.body.usage as Array<Record<string, unknown>> : null;
      if (answer.status !== 200 || !rows) {
        unread += 1;
        continue;
      }
      let usd = 0;
      for (const row of rows) {
        const feature = typeof row.feature === "string" ? row.feature : "";
        const price = feature !== PHONE_METER ? prices.get(feature) : undefined;
        if (price == null) continue;
        // A meter counts seconds or, for AI use, millicents; Revyl's price is per that unit.
        const amount = Number(feature.endsWith("_millicents") ? row.millicents : row.seconds);
        if (Number.isFinite(amount) && amount > 0) usd += amount * price;
      }
      const free = phoneFree.get(workspace.user_id)
        ?? (accountRules({ plan: workspace.plan === "paid" ? "paid" : "free", stripe_status: workspace.stripe_status }) === "free" ? 1 : 0);
      statements.push(env.DB.prepare(`
        insert into cloud_revyl_days (user_id, day, cost_micros, free, read_at) values (?, ?, ?, ?, ?)
        on conflict (user_id, day) do update set cost_micros = excluded.cost_micros, read_at = excluded.read_at
      `).bind(workspace.user_id, day, Math.round(usd * 1_000_000), free, now));
    }
  }
  if (statements.length) await env.DB.batch(statements);
  return unread;
}

const COST_WORKSPACES_SQL = `
  select r.user_id, r.external_id, r.app_id, a.plan, a.stripe_status
  from cloud_phone_revyl r left join cloud_accounts a on a.user_id = r.user_id`;

/**
 * What Revyl charged each account's workspace on `days` (UTC) beyond its
 * phones' own time, app builds mostly, at Revyl's own prices, kept in
 * `cloud_revyl_days` for the free-use cap and the owner's report. The daily
 * job passes the last few days, so a day that failed to read (or that Revyl
 * filled in late) is read again the next run; a workspace that can't be read
 * is reported.
 */
export async function recordRevylDayCosts(env: CloudEnv, days: string[], now: number): Promise<void> {
  if (!revylConfigured(env)) return;
  const workspaces = (await env.DB.prepare(COST_WORKSPACES_SQL).all<CostWorkspace>()).results ?? [];
  if (workspaces.length === 0) return;
  const prices = await revylPrices(env);
  if (!prices) return;
  const unread = await writeWorkspaceDays(env, prices, workspaces, days, now);
  if (unread) reportCloudFailure("cloud.revyl_day_usage_failed", { days: days.length, unread });
  logCloud("cloud.revyl_day_costs", { days: days.length, workspaces: workspaces.length, unread });
}

/** The days a deleted account's workspace is read for before it is disconnected: the daily job's window and today. */
export const REVYL_COST_DAYS_BACK = 3;

/** A workspace's charges for the daily job's days and today, read before its account's deletion disconnects it. */
async function finalRevylCosts(env: RevylCostEnv, userId: string, now: number): Promise<void> {
  const workspace = await env.DB.prepare(`${COST_WORKSPACES_SQL} where r.user_id = ?`).bind(userId).first<CostWorkspace>();
  if (!workspace) return;
  const prices = await revylPrices(env);
  if (!prices) return;
  const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
  const days = Array.from({ length: REVYL_COST_DAYS_BACK + 1 }, (_, index) => new Date(today - (REVYL_COST_DAYS_BACK - index) * 86_400_000).toISOString().slice(0, 10));
  const unread = await writeWorkspaceDays(env, prices, [workspace], days, now);
  if (unread) reportCloudFailure("cloud.revyl_final_costs_unread", { unread });
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
  // Its last charges first: once disconnected they can't be read, and the daily job reads only connected workspaces.
  // Best effort: a failed read never keeps the account from being deleted.
  await finalRevylCosts(env, userId, Date.now()).catch((error: unknown) => {
    reportCloudFailure("cloud.revyl_final_costs_failed", { message: error instanceof Error ? error.message : "unknown" });
  });
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
  performance_metrics: "GET",
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
  shake: "POST",
  start_screen_recording: "POST",
  stop_screen_recording: "POST",
};
const BUILD_ACTIONS = new Set(["build.upload_url", "build.start", "build.status", "build.logs", "build.install"]);
/** Revyl's words for a build that finished, whichever way (`build.status`'s `status`). */
const BUILD_ENDED = new Set(["success", "succeeded", "completed", "failed", "error", "cancelled", "canceled", "timeout"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCHEME = /^[A-Za-z0-9 _.+()-]{1,200}$/;
/**
 * A folder inside the uploaded project: no `..`, no absolute path, no control
 * character or backslash. Any other name is fine (`buildCommand` single-quotes
 * it), so whatever folder the brain finds or a person names, the build takes.
 */
const SUB_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\u0000-\u001f\u007f\\]{1,500}$/;

/** The passthrough: Revyl's status, type and body as they are (a screenshot's PNG, a recording's video). */
function passthrough(response: Response): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  const type = response.headers.get("content-type");
  if (type) headers.set("content-type", type);
  return new Response(response.body, { status: response.status, headers });
}

/** Single-quoted for sh. */
const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/** How long the runner may spend fetching Apple's Metal Toolchain (about 870 MB for Xcode 27.2) inside the build's own limit. */
const METAL_DOWNLOAD_SECONDS = 420;

/**
 * The build step ADE runs on Revyl's runner, from the brain's choices only
 * (never a command it sends): find the workspace or project in `path` (or
 * take the one `path` names), the scheme (the first, unless named), then
 * build for the Simulator into `build/` at the project's top, where the
 * artifact is collected. Xcode 26 and later ship the Metal compiler as a
 * separate download: a build that failed for want of it (a `.metal` file in
 * the app or a Swift package) fetches it, time-bound, and builds once more,
 * so a project without Metal never pays for the download.
 */
function buildCommand(input: { sub: string; scheme: string | null; configuration: "Debug" | "Release"; clean: boolean }): string {
  // A `path` that names the project or workspace itself builds that one, from its folder.
  const named = /\.(xcodeproj|xcworkspace)\/?$/i.test(input.sub) ? input.sub.replace(/\/+$/, "") : null;
  const folder = named ? (named.includes("/") ? named.slice(0, named.lastIndexOf("/")) : ".") : input.sub;
  // A named workspace keeps its folder's pods (uploads never carry `Pods/`), without trading the named one for another.
  const pods = "if [ -f Podfile ] && [ ! -d Pods ] && command -v pod >/dev/null 2>&1; then pod install; fi";
  const find = named
    ? [pods, named.toLowerCase().endsWith(".xcworkspace") ? `WS=${shellQuote(`./${named.slice(named.lastIndexOf("/") + 1)}`)}; PJ=` : `WS=; PJ=${shellQuote(`./${named.slice(named.lastIndexOf("/") + 1)}`)}`]
    : [
      "WS=$(find . -maxdepth 1 -name '*.xcworkspace' ! -name 'project.xcworkspace' | head -n 1)",
      "PJ=$(find . -maxdepth 1 -name '*.xcodeproj' | head -n 1)",
      "if [ -z \"$WS$PJ\" ] && [ -f project.yml ] && command -v xcodegen >/dev/null 2>&1; then xcodegen generate; PJ=$(find . -maxdepth 1 -name '*.xcodeproj' | head -n 1); fi",
      "if [ -f Podfile ] && [ ! -d Pods ] && command -v pod >/dev/null 2>&1; then pod install; WS=$(find . -maxdepth 1 -name '*.xcworkspace' ! -name 'project.xcworkspace' | head -n 1); fi",
    ];
  return [
    "set -eu",
    "ROOT=$(pwd)",
    `cd ${shellQuote(folder)}`,
    ...find,
    "if [ -n \"$WS\" ]; then set -- -workspace \"$WS\"; elif [ -n \"$PJ\" ]; then set -- -project \"$PJ\"; else echo 'No Xcode workspace or project found to build. Pass --path <folder>: the folder inside the project with the .xcodeproj or .xcworkspace.' >&2; exit 65; fi",
    `SCHEME=${shellQuote(input.scheme ?? "")}`,
    "if [ -z \"$SCHEME\" ]; then SCHEME=$(xcodebuild \"$@\" -list 2>/dev/null | awk '/Schemes:/{f=1;next} f&&NF{sub(/^ +/,\"\");print;exit}'); fi",
    "if [ -z \"$SCHEME\" ]; then echo 'No scheme found to build.' >&2; exit 65; fi",
    "echo \"ADE: building $SCHEME (" + input.configuration + ")\"",
    "mkdir -p \"$ROOT/build\"",
    "LOG=\"$ROOT/build/ade-xcodebuild.log\"",
    "CODE_FILE=\"$ROOT/build/ade-xcodebuild.code\"",
    `ACTION=${shellQuote(input.clean ? "clean build" : "build")}`,
    // The log is kept to tell why it failed; the exit code goes through a file because a pipe answers tee's.
    `ade_xcodebuild() { if xcodebuild "$@" -scheme "$SCHEME" -configuration ${input.configuration} -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath "$ROOT/build" ARCHS=arm64 CODE_SIGNING_ALLOWED=NO $ACTION; then echo 0 > "$CODE_FILE"; else echo $? > "$CODE_FILE"; fi; }`,
    // The first build's toolchain line stays out of the build's output: a fetch follows it, and a failure there says so
    // itself, so a later error is never blamed on a toolchain that was fetched.
    "{ ade_xcodebuild \"$@\"; } 2>&1 | tee \"$LOG\" | sed '/missing Metal Toolchain/d'",
    "CODE=$(cat \"$CODE_FILE\")",
    "if [ \"$CODE\" = 0 ]; then exit 0; fi",
    "if ! grep -q 'missing Metal Toolchain' \"$LOG\"; then exit \"$CODE\"; fi",
    `echo "ADE: this project compiles Metal shaders and the runner's Xcode has no Metal Toolchain; fetching it (up to ${METAL_DOWNLOAD_SECONDS} s), then building again."`,
    // Bounded by the shell alone: the fetch is stopped at the limit, and its failure is the one error below.
    "xcodebuild -downloadComponent MetalToolchain & FETCH=$!",
    `WAITED=0; while kill -0 "$FETCH" 2>/dev/null; do if [ "$WAITED" -ge ${METAL_DOWNLOAD_SECONDS} ]; then kill "$FETCH" 2>/dev/null || true; break; fi; sleep 2; WAITED=$((WAITED + 2)); done`,
    "if ! wait \"$FETCH\"; then echo \"error: The build runner couldn't fetch Apple's Metal Toolchain, which this project needs for its .metal shaders (missing Metal Toolchain).\" >&2; exit \"$CODE\"; fi",
    "echo 'ADE: fetched the Metal Toolchain; building again.'",
    "ACTION=build",
    "{ ade_xcodebuild \"$@\"; } 2>&1 | tee \"$LOG\"",
    "exit \"$(cat \"$CODE_FILE\")\"",
  ].join("\n");
}

const stringArg = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * `POST /cloud/phone/call` for an account whose live phone is Revyl's.
 * `phoneId` and `ref` name that phone (`phones.ts` read it live just now).
 */
async function routeRevylCall(env: CloudEnv, userId: string, phone: { id: string; ref: string | null }, body: Record<string, unknown>, now: number): Promise<Response> {
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
    }).catch((error: unknown) => {
      logCloud("cloud.phone_revyl_unreachable", { method, path: `proxy.${name}`, message: error instanceof Error ? error.message : "unknown" });
      return new Response(null, { status: 504 });
    });
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
    // One build at a time per phone (Revyl's runners bill by the hour): claimed in this write, so two starts can't both run.
    // Only a claim that never got Revyl's answer (no job) lapses; a build Revyl took, or may have, holds it until
    // it ends or the phone does (an accepted build waits for a runner with no bound).
    const claim = () => env.DB.prepare("update cloud_phones set build_started_at = ?, build_job = null where phone_id = ? and user_id = ? and (build_started_at is null or (build_job is null and build_started_at <= ?))")
      .bind(now, phone.id, userId, now - BUILD_TIMEOUT_SECONDS * 1000).run();
    let claimed = await claim();
    if ((claimed.meta?.changes ?? 0) !== 1) {
      // The held build may have ended with nobody following it (ADE closed, a status read failed): asked once,
      // an ended one frees the claim. An unknown outcome (`unknown`) stays held.
      const held = await env.DB.prepare("select build_job from cloud_phones where phone_id = ? and user_id = ?").bind(phone.id, userId).first<{ build_job: string | null }>();
      const job = held?.build_job;
      if (job && UUID.test(job)) {
        const status = await workspaceJson(env, workspace, "GET", `/apps/remote/${encodeURIComponent(job)}/status`);
        if (status.status === 200 && BUILD_ENDED.has(String(status.body?.status ?? "").toLowerCase())) {
          await env.DB.prepare("update cloud_phones set build_started_at = null, build_job = null where phone_id = ? and user_id = ? and build_job = ?").bind(phone.id, userId, job).run();
          claimed = await claim();
        }
      }
    }
    if ((claimed.meta?.changes ?? 0) !== 1) {
      return fail("phone_busy", "A build is already running on your ADE Cloud iPhone. Wait for it to finish, or stop the phone and start a new one.", 409);
    }
    const answer = await workspaceJson(env, workspace, "POST", "/apps/remote", {
      body: { build_definition_hash: await sha256Hex(JSON.stringify(recipe)), git_branch_name: "ade", recipe, source: { key, type: "archive" }, timeout_seconds: BUILD_TIMEOUT_SECONDS },
      timeoutMs: SLOW_REQUEST_TIMEOUT_MS,
    });
    const buildJob = typeof answer.body?.build_job_id === "string" ? answer.body.build_job_id : null;
    // A start Revyl refused runs nothing: the claim goes back. A 5xx or a timeout may hide a build Revyl took:
    // the claim holds (`unknown`) until the phone ends, so a retry can't bill a second one; a new phone builds again.
    if (answer.status < 300) {
      await env.DB.prepare("update cloud_phones set build_job = ? where phone_id = ? and user_id = ? and build_started_at = ?").bind(buildJob ?? "unknown", phone.id, userId, now).run();
    } else if (answer.status < 500) {
      await env.DB.prepare("update cloud_phones set build_started_at = null where phone_id = ? and user_id = ? and build_started_at = ?").bind(phone.id, userId, now).run();
    } else {
      await env.DB.prepare("update cloud_phones set build_job = 'unknown' where phone_id = ? and user_id = ? and build_started_at = ?").bind(phone.id, userId, now).run();
    }
    logCloud("cloud.phone_revyl_build", { userId, status: answer.status });
    return json(answer.body ?? {}, answer.status);
  }
  const job = stringArg(args.job);
  if (action === "build.status" || action === "build.logs") {
    if (!job || !UUID.test(job)) return fail("bad_request", "job is the build's id.", 400);
    const answer = await workspaceJson(env, workspace, "GET", `/apps/remote/${encodeURIComponent(job)}/${action === "build.status" ? "status" : "logs"}`, { query });
    // A finished build (whichever way) frees the phone for the next one: only its own claim, never one
    // still waiting for Revyl's answer (no job yet) or a newer build's.
    if (action === "build.status" && answer.status === 200 && BUILD_ENDED.has(String(answer.body?.status ?? "").toLowerCase())) {
      await env.DB.prepare("update cloud_phones set build_started_at = null, build_job = null where phone_id = ? and user_id = ? and build_job = ?").bind(phone.id, userId, job).run();
    }
    return json(answer.body ?? {}, answer.status);
  }
  // build.install: the build's app, into the live phone.
  const version = stringArg(args.version_id);
  if (!version || !UUID.test(version)) return fail("bad_request", "version_id is the build's version.", 400);
  if (!phone.ref) return fail("phone_starting", "Your ADE Cloud iPhone is still starting. Try again in a moment.", 409);
  const build = await workspaceJson(env, workspace, "GET", `/apps/builds/${encodeURIComponent(version)}`, { query: { include_download_url: "true" } });
  if (build.status !== 200 || build.body?.app_id !== app) return fail("bad_request", "That build isn't one of this account's.", 400);
  const named = typeof build.body?.download_url === "string" && build.body.download_url.startsWith("https://") ? build.body.download_url : undefined;
  const download = named ?? Object.values(build.body ?? {}).find((value): value is string => typeof value === "string" && value.startsWith("https://"));
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

/* ---- The provider record (`phones.ts`) ---- */

/** One phone as Revyl answers it now, in the shape `phones.ts` keeps, or null when it can't be read. */
async function readKept(env: CloudEnv, userId: string, phoneId: string, where: PhoneWhere): Promise<PhoneRead | null> {
  const session = await readRevylPhone(env, userId, phoneId, where.device).catch((error: unknown) => {
    logCloud("cloud.phone_revyl_read_failed", { userId, phoneId, message: error instanceof Error ? error.message : "unknown" });
    return null;
  });
  return session ? { session: { ...session, provider: "revyl", ref: session.ref ?? where.ref }, stopNotice: null } : null;
}

export const REVYL_PHONE: PhoneProviderServer = {
  canStart: revylEnabled,
  hasKey: revylConfigured,
  ownsTimeLimit: false,
  stopFailedEvent: "cloud.phone_stop_failed.revyl_",

  async start(env, { userId, device, now }) {
    const started = await startRevylPhone(env, userId, device, CLOUD_PHONE_IDLE_SECONDS, now);
    return started instanceof Response ? started : { session: { ...started.session, provider: "revyl" }, reused: started.reused };
  },

  read: readKept,

  async stop(env, userId, phoneId, where) {
    const status = await stopRevylPhone(env, userId, phoneId).catch(() => 504);
    if (stopRefused(status)) return { ok: false, status, code: `http_${status}` };
    const after = await readKept(env, userId, phoneId, where);
    // Revyl reads a phone it just took a stop for as running a few seconds more: it is stopping (ended here).
    if (after && status < 300 && LIVE_STATES.has(after.session.state)) {
      after.session.state = "stopping";
      after.session.ended = { reason: "stopped", at: null };
    }
    return { ok: true, status, after };
  },

  // No per-phone token at Revyl: the brain calls the phone through `/cloud/phone/call`, as itself.
  startAnswer: async (_env, _session, _userId, now) => ({ token: { token: "", expiresAt: now + TOKEN_MINUTES * 60_000 }, apiBase: "" }),

  async view(env, { userId, phone, control, origin, now }) {
    if (!phone.ref) return fail("phone_starting", "Your ADE Cloud iPhone is still starting. Try again in a moment.", 409);
    const view = await revylViewUrl(env, userId, phone.ref, origin, control);
    if (view instanceof Response) return view;
    // The stream link lasts the phone's life; the pane asks again before this.
    return { url: view.url, expiresAt: now + VIEW_MINUTES * 60_000, control, provider: "revyl" };
  },

  call: routeRevylCall,
};
