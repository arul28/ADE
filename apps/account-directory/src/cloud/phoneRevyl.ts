/**
 * The ADE Cloud iPhone on Revyl (`phones.ts` picks the provider per account):
 * its phones, their device calls, and what Revyl charges each account.
 *
 * Each account's calls run in its own Revyl workspace
 * (`phoneRevylWorkspace.ts`, which holds ADE's partner key); builds are the
 * account's, not a phone's (`phoneRevylBuild.ts`).
 *
 * Revyl has no token for one phone, so a brain never holds a Revyl
 * credential: it calls `POST /cloud/phone/call` with its own account token,
 * and this file sends the call to the account's live phone, from an allowlist
 * (`PROXY_ACTIONS`), and passes Revyl's answer back as it is.
 *
 * Revyl's phone has no time limit or spend cap of its own: the phone's
 * `stop_at` (`phones.ts`) is its limit, and the minute tick stops it. Its view
 * link opens ADE's own viewer page (`phoneViewerPage.ts`).
 */

import { CLOUD_PHONE_IDLE_SECONDS } from "../../../desktop/src/shared/cloudPhone";
import { CLOUD_PATHS, withoutPhoneProviderNames, type CloudPhoneDevice } from "./contract";
import { fail, json } from "./http";
import { LIVE_STATES, TOKEN_MINUTES, VIEW_MINUTES, stopRefused, type PhoneProviderServer, type PhoneRead, type PhoneWhere } from "./phoneProvider";
import { UUID, callParts, revylDefaultImage, revylToolchainOf, stringArg } from "./phoneRevylBuild";
import { SLOW_REQUEST_TIMEOUT_MS, forgetSessionKey, knownWorkspace, partner, revylConfigured, revylErrorOf, workspaceApp, workspaceCall, workspaceJson, workspaceOf, type WorkspaceRow } from "./phoneRevylWorkspace";
import { accountRules, logCloud, reportCloudFailure, type CloudEnv } from "./store";

/** What Revyl bills ADE: the second, at $3.60 an hour, which is 1,000 micro-dollars a second. */
export const REVYL_MICROS_PER_SECOND = 1_000;
/** Revyl's idle stop takes 300 to 900 seconds. */
const MIN_IDLE_SECONDS = 300;

/** ADE's phone names as Revyl's models (`GET /execution/device-targets`). */
const REVYL_DEVICES: Record<CloudPhoneDevice, { model: string; os: string }> = {
  iphone: { model: "iPhone 18 Pro", os: "iOS 27.0" },
  "iphone-pro-max": { model: "iPhone 18 Pro Max", os: "iOS 27.0" },
  ipad: { model: "iPad Pro 13-inch (M4)", os: "iOS 26.2" },
};

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

/**
 * Revyl may start new phones: its key is set AND the owner's switch
 * `CLOUD_PHONE_REVYL` is `on`. Off (the default), every new phone is NoMac's,
 * whatever a beta row or `CLOUD_PHONE_PROVIDER` says; a Revyl phone already
 * running is still read, billed and stopped with the key.
 */
const revylEnabled = (env: Pick<CloudEnv, "REVYL_PARTNER_API_KEY" | "CLOUD_PHONE_REVYL">): boolean =>
  revylConfigured(env) && env.CLOUD_PHONE_REVYL?.trim().toLowerCase() === "on";


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
  forgetSessionKey(workspace.external_id);
  await env.DB.prepare("delete from cloud_phone_revyl where user_id = ?").bind(userId).run();
}

/* ---- `POST /cloud/phone/call` ---- */

/**
 * The calls a brain may make on its live Revyl phone. `proxy` actions go to
 * Revyl's device proxy for that phone (`/execution/device-proxy/<run>/<name>`);
 * `build.install` puts a build's app on it. Builds themselves belong to the
 * account, not to a phone (`routeRevylBuild`). Anything else is refused: no
 * call reaches another phone, another workspace, or Revyl's AI-billed steps.
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

/** The passthrough: Revyl's status, type and body as they are (a screenshot's PNG, a recording's video). */
function passthrough(response: Response): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  const type = response.headers.get("content-type");
  if (type) headers.set("content-type", type);
  return new Response(response.body, { status: response.status, headers });
}


/**
 * `POST /cloud/phone/call` for an account whose live phone is Revyl's: its
 * device calls and `build.install`. `phoneId` and `ref` name that phone
 * (`phones.ts` read it live just now).
 */
async function routeRevylCall(env: CloudEnv, userId: string, phone: { id: string; ref: string | null }, body: Record<string, unknown>, now: number): Promise<Response> {
  const { action, args, query } = callParts(body);
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
    // A launch restarts the app, its launch values included: slow on a large app.
    const slow = name === "install" || name === "launch" || stopping;
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
  if (action !== "build.install") return fail("bad_request", `${action || "That"} isn't a cloud iPhone action.`, 400);
  const app = await workspaceApp(env, workspace, now);
  if (app instanceof Response) return app;
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
  // Builds run on Revyl's build runners, before a phone starts (`routeRevylBuild`).
  toolchain: (env) => ({ ...revylToolchainOf(revylDefaultImage(env)), buildsBeforePhone: true }),

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
