import { ADE_FREE_MODELS, adeFreeModelByAlias, adeFreeModelById, type AdeFreeModel } from "../../../desktop/src/shared/adeFreeModels";
import { readBoundedBody } from "../sinkUtils";
import type { CloudWaitUntil } from "./analytics";
import {
  CLOUD_FREE_MODELS_CHAT_HEADER,
  CLOUD_FREE_MODELS_TERMS_VERSION,
  CLOUD_PATHS,
  type CloudFreeModelsErrorCode,
  type CloudFreeModelsState,
  type CloudSponsoredConsent,
} from "./contract";
import {
  ALL,
  accountEmailHash,
  clientIp,
  clientUa,
  countStatement,
  countUnder,
  gravitySessionId,
  hashedEmailFor,
  readDevice,
  sponsoredFormatOf,
  type GravityEnv,
} from "./gravity";
import {
  clearFreeViewers,
  freeYesHolds,
  honorFreeGpc,
  outsideInferenceCountries,
  readFreeConsent,
  shownFreeConsent,
} from "./freeModelsConsent";
import { ROW_ID, UNREADABLE_REQUEST_MESSAGE, badRequest, json, readJson, shortString } from "./http";
import { utcDay } from "./plans";
import { readCloudSettings, type CloudSettings } from "./settings";
import { gpcOptsOut, sponsoredRequester, type SponsoredRequester } from "./sponsoredConsent";
import { inferenceReaches, inferenceSwitch, type InferenceSwitch } from "./sponsoredSwitch";
import { logCloud, reportCloudFailure, takeRequest } from "./store";

/**
 * ADE Free Models: Gravity's hosted models (inference.trygravity.ai), paid
 * for by the sponsored cards in the chats that use them, on any plan and any
 * machine. OpenCode runs them through its OpenAI-compatible provider
 * `ade-free`, pointed here with the account's own sign-in; this Worker holds
 * Gravity's key, checks every rule on every call, and forwards the call with
 * what Gravity needs to pay for it: the chat's session (the same one its cards
 * use), the person's hashed email, and the address of the person watching
 * (never the address of the machine the chat runs on).
 *
 * A call goes only when all hold, in this order:
 * - the switch: the `gravity_inference` setting held under `GRAVITY_INFERENCE`,
 *   both keys set, and `all` reaching non-testers only while ads are live;
 * - the account's yes to the ADE Free Models sheet, for the current terms;
 * - someone has the chat open in ADE (`POST /seen` from their device): a
 *   record no older than 10 minutes, or a turn still running (a call in the
 *   last 5 minutes) with a record no older than an hour. Automations,
 *   scheduled wakes and chats nobody watches get nothing;
 * - the watcher is in Gravity's countries (`GRAVITY_INFERENCE_COUNTRIES`);
 * - the account's minute, ADE's minute, and the account's day.
 *
 * Refusals are OpenAI-shaped errors with ADE's words and a
 * `CloudFreeModelsErrorCode`. Only Gravity's own retry-safe 429 stays a 429:
 * OpenCode's client retries 429 and 5xx answers, so everything else is a 4xx
 * it shows at once.
 */

/** Gravity's own id for each ADE Free Model. A model can move here without an app release. */
const GRAVITY_MODELS: Record<string, string> = {
  "deepseek-v4.1-flash": "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
  "glm-5.3-flash": "@cf/zai-org/glm-5.3-flash",
};

const DEFAULT_INFERENCE_BASE = "https://inference.trygravity.ai/v1";
/** Gravity's request size limit. */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
/** Gravity's output limit per call. */
const MAX_OUTPUT_TOKENS = 65_536;
/** Calls one account may make a UTC day: under Gravity's 3,000 for one person. */
const ACCOUNT_DAILY_REQUESTS = 2_900;
/** A person "has the chat open" when a device of theirs said so this recently. */
const VIEWER_FRESH_MS = 10 * 60_000;
/** A turn still running: its last call this recently, with the person's record no older than `RUNNING_VIEWER_MS`. */
const RUNNING_TURN_MS = 5 * 60_000;
const RUNNING_VIEWER_MS = 60 * 60_000;
/** A streamed line longer than this is never the usage line: it isn't kept to be read. */
const MAX_WATCHED_LINE_CHARS = 64_000;

/** An answer as an OpenAI error, which OpenCode shows as it is. */
const openAiError = (code: string, message: string, status: number, type = "invalid_request_error"): Response =>
  json({ error: { message, type, code } }, status);

const MESSAGES: Record<CloudFreeModelsErrorCode, string> = {
  free_models_off: "ADE Free Models aren't available right now.",
  free_models_consent: "Turn on ADE Free Models in ADE first.",
  free_models_country: "ADE Free Models are available only in the US and Canada for now.",
  free_models_not_watched: "ADE Free Models run only while you have this chat open in ADE. Open the chat to continue.",
  free_models_limit: "You've used ADE Free Models a lot in a short time. Try again in a minute.",
  free_models_unknown_model: "That isn't one of the ADE Free Models.",
  free_models_too_large: "This request is too large for ADE Free Models (8 MB at most).",
  free_models_unavailable: "ADE Free Models couldn't answer just now. Try again soon.",
  free_models_locked: "Add a card (no charge) in ADE to unlock ADE Free Models.",
  free_models_no_cards: "ADE Free Models are paid for by the sponsored cards in your chats. Open this chat in ADE and let a card show to keep going.",
};
const STATUS: Record<CloudFreeModelsErrorCode, number> = {
  free_models_off: 403,
  free_models_consent: 403,
  free_models_country: 403,
  free_models_not_watched: 403,
  free_models_limit: 403,
  free_models_unknown_model: 400,
  free_models_too_large: 413,
  // 424, never a 5xx: OpenCode would send the same call again.
  free_models_unavailable: 424,
  free_models_locked: 403,
  free_models_no_cards: 403,
};

/** `/cloud/free-models/*`, or null for any other path. */
export async function routeFreeModels(request: Request, path: string, env: GravityEnv, userId: string, now: number, waitUntil?: CloudWaitUntil): Promise<Response | null> {
  if (path === CLOUD_PATHS.freeModelsChat) {
    if (request.method !== "POST") return openAiError("not_found", "Use POST for chat completions.", 404);
    return handleChat(request, env, userId, now, waitUntil);
  }
  if (path === CLOUD_PATHS.freeModelsModels) {
    if (request.method !== "GET") return openAiError("not_found", "Use GET for the model list.", 404);
    return handleModels(env, userId);
  }
  if (path === CLOUD_PATHS.freeModelsConsent || path === CLOUD_PATHS.freeModelsSeen) {
    const allowed = path === CLOUD_PATHS.freeModelsConsent ? "PUT" : "POST";
    if (request.method !== allowed) return null;
    if (!(await takeRequest(env, userId, "free_models_seen", now))) {
      return json({ error: { code: "rate_limited", message: "Too many requests from this account in the last minute. Try again in a minute." } }, 429);
    }
    return path === CLOUD_PATHS.freeModelsConsent ? handleConsent(request, env, userId, now) : handleSeen(request, env, userId, now);
  }
  return null;
}

/**
 * The account state's `freeModels`: undefined while the switch doesn't reach
 * this account (or a key is missing), so a client shows none of them.
 */
export async function freeModelsAccountState(env: GravityEnv, userId: string, who: SponsoredRequester, now: number): Promise<CloudFreeModelsState | undefined> {
  // No key: no read at all (the account state is polled).
  if (!env.GRAVITY_INFERENCE_KEY?.trim() || !env.GRAVITY_API_KEY?.trim()) return undefined;
  const settings = await readCloudSettings(env);
  const inference = await inferenceSwitch(env, settings);
  if (!(await inferenceReaches(env, userId, inference))) return undefined;
  return stateOf(env, userId, who, now, inference, settings);
}

async function stateOf(env: GravityEnv, userId: string, who: SponsoredRequester, now: number, inference: InferenceSwitch, settings: CloudSettings): Promise<CloudFreeModelsState> {
  // A browser's Global Privacy Control from the US opts the whole account out.
  const consent = await honorFreeGpc(env, userId, await readFreeConsent(env, userId), who, now);
  const outside = outsideInferenceCountries(env, who.country);
  return {
    modelIds: ADE_FREE_MODELS.map((model) => model.id),
    available: !outside,
    ...(outside ? { reason: "country" as const } : {}),
    consent: shownFreeConsent(consent, who),
    // The cards in these chats show where the account's sponsored cards do: its A/B arm, the same on every machine.
    format: await sponsoredFormatOf(env, userId, settings, now, !outside),
    test: !inference.live,
  };
}

/**
 * The person's answer to the sheet, on every machine. A yes keeps the SHA-256
 * of the account's email now (Gravity needs it on every call) and the terms
 * it was given for; a no keeps nothing of it, and where the person watched
 * from goes in the same transaction. A yes saves only over the answer it
 * read: a no saved meanwhile, on another screen while the email was read,
 * holds. A no saves while the switch is off too.
 */
async function handleConsent(request: Request, env: GravityEnv, userId: string, now: number): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const consent: CloudSponsoredConsent | null = body.consent === "granted" || body.consent === "declined" ? body.consent : null;
  if (!consent) return badRequest("Say granted or declined.");
  const settings = await readCloudSettings(env);
  const inference = await inferenceSwitch(env, settings);
  const reaches = await inferenceReaches(env, userId, inference);
  if (!reaches && consent === "granted") return refusal("free_models_off", 404);
  const who = sponsoredRequester(request);
  if (consent === "granted" && outsideInferenceCountries(env, who.country)) return refusal("free_models_country");
  const before = await readFreeConsent(env, userId);
  const emailHash = consent === "granted" ? await accountEmailHash(env, userId) : null;
  const guard = consent === "declined" ? "" : before ? " where cloud_free_model_consent.decided_at = ?" : " where 0";
  const write = env.DB.prepare(`
    insert into cloud_free_model_consent (user_id, consent, email_hash, decided_at, country, region, gpc, terms_version) values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict (user_id) do update set consent = excluded.consent, email_hash = excluded.email_hash, decided_at = excluded.decided_at,
      country = excluded.country, region = excluded.region, gpc = excluded.gpc, terms_version = excluded.terms_version${guard}
  `).bind(
    userId, consent, emailHash, now, who.country, who.region,
    // A yes from a browser that sends Global Privacy Control is the person's own choice: it holds there.
    consent === "granted" && gpcOptsOut(who) ? 1 : 0,
    CLOUD_FREE_MODELS_TERMS_VERSION,
    ...(guard && before ? [before.decided_at] : []),
  );
  const [saved] = consent === "declined" ? await env.DB.batch([write, clearFreeViewers(env, userId)]) : [await write.run()];
  if (saved?.meta?.changes) logCloud("cloud.free_models.consent", { consent });
  if (!reaches) {
    return json({ modelIds: [], available: false, reason: "unavailable", consent: "declined", format: "below_reply", test: true } satisfies CloudFreeModelsState);
  }
  return json(await stateOf(env, userId, who, now, inference, settings));
}

/**
 * A person has this ADE Free Models chat open, on this device, from here.
 * Kept only while the account's yes holds: it is the address Gravity gets
 * with the chat's calls (the person's, never the chat machine's) and the
 * proof someone watches.
 */
async function handleSeen(request: Request, env: GravityEnv, userId: string, now: number): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const chatId = shortString(body.chatId, 160);
  const device = readDevice(body.device);
  if (!chatId || !isChatId(chatId) || !device) return badRequest("Name the chat and the device.");
  const ip = clientIp(request);
  if (!ip || !(await inferenceReaches(env, userId, await inferenceSwitch(env)))) return json({ ok: false });
  const who = sponsoredRequester(request);
  // A browser's Global Privacy Control from the US opts the whole account out (and clears every record).
  const consent = await honorFreeGpc(env, userId, await readFreeConsent(env, userId), who, now);
  if (!freeYesHolds(consent, who)) return json({ ok: false });
  // Written only while the answer is still yes, in the same statement: a no that lands meanwhile wins.
  await env.DB.prepare(`
    insert into cloud_free_model_viewers (user_id, chat_id, ip, ua, device_type, os, os_version, tracking, country, region, seen_at)
    select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    where exists (select 1 from cloud_free_model_consent where user_id = ? and consent = 'granted' and terms_version >= ?)
    on conflict (user_id, chat_id) do update set ip = excluded.ip, ua = excluded.ua, device_type = excluded.device_type,
      os = excluded.os, os_version = excluded.os_version, tracking = excluded.tracking, country = excluded.country,
      region = excluded.region, seen_at = excluded.seen_at
  `).bind(
    userId, chatId, ip, clientUa(request, device), device.type, device.os, device.osVersion ?? null, device.tracking ?? null, who.country, who.region, now,
    userId, CLOUD_FREE_MODELS_TERMS_VERSION,
  ).run();
  return json({ ok: true });
}

/** `GET /v1/models`: the ADE Free Models by the names OpenCode calls them. */
async function handleModels(env: GravityEnv, userId: string): Promise<Response> {
  if (!(await inferenceReaches(env, userId, await inferenceSwitch(env)))) return refusal("free_models_off");
  return json({
    object: "list",
    data: ADE_FREE_MODELS.map((model) => ({ id: model.alias, object: "model", created: 0, owned_by: "ade-free" })),
  });
}

const refusal = (code: CloudFreeModelsErrorCode, status = STATUS[code], message = MESSAGES[code]): Response => openAiError(code, message, status);

type ViewerRow = { ip: string | null; ua: string | null; os: string; tracking: string | null; country: string | null; seen_at: number };
/** No request's Global Privacy Control is read here: the call comes from the chat's machine, and a record exists only after a yes that held on the person's device. */
const MACHINE: SponsoredRequester = { country: null, region: null, gpc: false };

/** One model call, checked in the order the module comment lists, then sent to Gravity. */
async function handleChat(request: Request, env: GravityEnv, userId: string, now: number, waitUntil?: CloudWaitUntil): Promise<Response> {
  // Counts after the answer: with no `waitUntil` (a test), the caller waits for them.
  const keep = (work: Promise<unknown>): Promise<unknown> => {
    const settled = work.catch((error: unknown) => reportCloudFailure("cloud.free_models.count_failed", { message: error instanceof Error ? error.message : "unknown" }));
    if (!waitUntil) return settled;
    waitUntil(settled);
    return Promise.resolve();
  };
  const refuse = (code: CloudFreeModelsErrorCode, message?: string, status = STATUS[code]): Response => {
    void keep(countStatement(env, utcDay(now), ALL, `fm_refused:${code}`).run());
    return refusal(code, status, message);
  };

  const inference = await inferenceSwitch(env);
  if (!(await inferenceReaches(env, userId, inference))) return refuse("free_models_off");
  const consent = await readFreeConsent(env, userId);
  if (!freeYesHolds(consent, MACHINE)) return refuse("free_models_consent");
  const chatId = shortString(request.headers.get(CLOUD_FREE_MODELS_CHAT_HEADER), 160);
  if (!chatId || !isChatId(chatId)) return refuse("free_models_not_watched", "ADE Free Models run only in an ADE chat.");
  const readViewer = () => env.DB.prepare("select ip, ua, os, tracking, country, seen_at from cloud_free_model_viewers where user_id = ? and chat_id = ?")
    .bind(userId, chatId).first<ViewerRow>();
  const [found, chat] = await Promise.all([
    readViewer(),
    env.DB.prepare("select last_at from cloud_free_model_chats where user_id = ? and chat_id = ?").bind(userId, chatId).first<{ last_at: number }>(),
  ]);
  // A chat nobody reported yet may be the one a person just launched on ADE Cloud (`noteFreeModelLaunch`).
  const viewer = found ?? (chat ? null : (await claimLaunchViewer(env, userId, chatId, now)) ? await readViewer() : null);
  if (!viewer?.ip || !watched(viewer, chat, now)) return refuse("free_models_not_watched");
  // The person's country, from their device: the chat's machine may be anywhere.
  if (outsideInferenceCountries(env, viewer.country)) return refuse("free_models_country");
  // Gravity needs the hashed email on every call. An iPhone without tracking allowed sends none (`hashedEmailFor`).
  const emailHash = hashedEmailFor(viewer, consent.email_hash);
  if (!emailHash) {
    return refuse("free_models_consent", consent.email_hash
      ? "ADE Free Models need tracking allowed for ADE on the iPhone watching this chat (iOS Settings > Privacy > Tracking)."
      : "ADE couldn't read your account's email when you turned on ADE Free Models. Turn them off and on again in ADE.");
  }
  const day = utcDay(now);
  if (!(await takeRequest(env, userId, "free_models", now))) return refuse("free_models_limit");
  if (!(await takeRequest(env, ALL, "free_models_all", now))) return refuse("free_models_limit", "ADE Free Models are busy right now. Try again in a minute.");
  if (!(await countUnder(env, day, userId, "fm_request", ACCOUNT_DAILY_REQUESTS))) {
    return refuse("free_models_limit", "You've used today's ADE Free Models. They come back at midnight UTC.");
  }

  const read = await readBoundedBody(request, MAX_REQUEST_BYTES).catch(() => null);
  if (!read) return refuse("free_models_unavailable", UNREADABLE_REQUEST_MESSAGE, 400);
  if (!read.ok) return refuse("free_models_too_large");
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(read.text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return openAiError("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);
  }
  const model = typeof body.model === "string" ? adeFreeModelByAlias(body.model) ?? adeFreeModelById(body.model) : null;
  const gravityModel = model ? GRAVITY_MODELS[model.alias] : undefined;
  if (!model || !gravityModel) return refuse("free_models_unknown_model");
  const outgoing = gravityBody(body, gravityModel, {
    session_id: await gravitySessionId(userId, chatId),
    email_hash: emailHash,
    user_ip: viewer.ip,
  });

  // Before the call: the chat's cards follow (`gravity.ts` `freeModelAdGate`), and a turn that runs on keeps its window.
  await env.DB.batch([
    env.DB.prepare(`
      insert into cloud_free_model_chats (user_id, chat_id, first_at, last_at, requests, last_model) values (?, ?, ?, ?, 1, ?)
      on conflict (user_id, chat_id) do update set last_at = excluded.last_at, requests = requests + 1, last_model = excluded.last_model
    `).bind(userId, chatId, now, now, model.alias),
    countStatement(env, day, ALL, "fm_request"),
  ]);

  let upstream: Response;
  try {
    upstream = await fetch(`${(env.GRAVITY_INFERENCE_BASE?.trim() || DEFAULT_INFERENCE_BASE).replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GRAVITY_INFERENCE_KEY!.trim()}`,
        "content-type": "application/json",
        accept: outgoing.stream === true ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(outgoing),
      // The person stopped the turn: Gravity stops too.
      signal: request.signal,
    });
  } catch (error) {
    if (request.signal?.aborted) return openAiError("cancelled", "The request was cancelled.", 499);
    reportCloudFailure("cloud.free_models.gravity_unreachable", { message: error instanceof Error ? error.message : "unknown" });
    return refuse("free_models_unavailable");
  }
  if (!upstream.ok) return upstreamRefusal(upstream, model, refuse);

  const record = (usage: Record<string, unknown>, answeredModel: unknown) =>
    keep(recordUsage(env, userId, chatId, typeof answeredModel === "string" ? answeredModel.slice(0, 120) : gravityModel, usage, Date.now()));
  const headers = { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" };
  if (!upstream.body || !/text\/event-stream/i.test(headers["content-type"])) {
    const text = await upstream.text();
    try {
      const answer = JSON.parse(text) as Record<string, unknown>;
      if (answer.usage && typeof answer.usage === "object") await record(answer.usage as Record<string, unknown>, answer.model);
    } catch {
      // Not JSON: passed on as it came.
    }
    return new Response(text, { status: upstream.status, headers });
  }
  return new Response(upstream.body.pipeThrough(usageWatcher(record)), { status: upstream.status, headers });
}

/** A chat's id, never a launch's stand-in record (`launch:<id>`). */
const isChatId = (chatId: string): boolean => ROW_ID.test(chatId) && !chatId.startsWith(LAUNCH_VIEWER_PREFIX);

/** The stand-in record a person's ADE Cloud launch leaves until its chat reports itself. */
const LAUNCH_VIEWER_PREFIX = "launch:";

/**
 * A person launched a chat on an ADE Free Model on ADE Cloud (`launches.ts`):
 * its chat id is made on the new computer, so its first call can come before
 * any device says the chat is open. The launch is that say: a stand-in
 * record with the launching device's address, which the launch's first new
 * chat takes over (`claimLaunchViewer`). Only while the account's yes holds;
 * never for an automation's or an agent's launch.
 */
export async function noteFreeModelLaunch(env: GravityEnv, userId: string, request: Request, launchId: string, now: number): Promise<void> {
  const ip = clientIp(request);
  if (!ip || !(await inferenceReaches(env, userId, await inferenceSwitch(env)))) return;
  const who = sponsoredRequester(request);
  await env.DB.prepare(`
    insert into cloud_free_model_viewers (user_id, chat_id, ip, ua, country, region, seen_at)
    select ?, ?, ?, ?, ?, ?, ?
    where exists (select 1 from cloud_free_model_consent where user_id = ? and consent = 'granted' and terms_version >= ?)
    on conflict (user_id, chat_id) do update set ip = excluded.ip, ua = excluded.ua, country = excluded.country, region = excluded.region, seen_at = excluded.seen_at
  `).bind(
    userId, `${LAUNCH_VIEWER_PREFIX}${launchId}`, ip, request.headers.get("user-agent")?.trim().slice(0, 512) || null, who.country, who.region, now,
    userId, CLOUD_FREE_MODELS_TERMS_VERSION,
  ).run();
}

/**
 * Gives a chat nobody reported the newest launch stand-in of the account from
 * the last 10 minutes, once: the record becomes the chat's (its launch time
 * kept, so the usual windows run from the launch), and no other chat can use
 * it. True when this chat took one.
 */
async function claimLaunchViewer(env: GravityEnv, userId: string, chatId: string, now: number): Promise<boolean> {
  const launch = await env.DB.prepare(`
    select chat_id from cloud_free_model_viewers where user_id = ? and chat_id like 'launch:%' and seen_at >= ? order by seen_at desc limit 1
  `).bind(userId, now - VIEWER_FRESH_MS).first<{ chat_id: string }>();
  if (!launch) return false;
  const moved = await env.DB.prepare("update or ignore cloud_free_model_viewers set chat_id = ? where user_id = ? and chat_id = ?")
    .bind(chatId, userId, launch.chat_id).run();
  return (moved.meta?.changes ?? 0) > 0;
}

/** Whether someone has the chat open: a fresh record, or a running turn with a recent one. */
function watched(viewer: ViewerRow, chat: { last_at: number } | null, now: number): boolean {
  if (now - viewer.seen_at <= VIEWER_FRESH_MS) return true;
  return chat != null && now - chat.last_at <= RUNNING_TURN_MS && now - viewer.seen_at <= RUNNING_VIEWER_MS;
}

/**
 * The call as Gravity takes it: its own model id, what it requires in place
 * of anything the client sent for them, no `n` or audio (Gravity has
 * neither), the output limit held to Gravity's, and the usage asked for on a
 * stream (so the chat's next card can carry it).
 */
function gravityBody(body: Record<string, unknown>, gravityModel: string, required: { session_id: string; email_hash: string; user_ip: string }): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body, model: gravityModel };
  delete out.n;
  delete out.audio;
  if (Array.isArray(out.modalities) && out.modalities.includes("audio")) delete out.modalities;
  for (const field of ["max_tokens", "max_completion_tokens"] as const) {
    if (out[field] === undefined) continue;
    const value = out[field];
    if (typeof value === "number" && Number.isFinite(value)) out[field] = Math.min(MAX_OUTPUT_TOKENS, Math.max(1, Math.floor(value)));
    else delete out[field];
  }
  if (out.stream === true) {
    const options = out.stream_options && typeof out.stream_options === "object" && !Array.isArray(out.stream_options) ? out.stream_options as Record<string, unknown> : {};
    out.stream_options = { ...options, include_usage: true };
  } else {
    delete out.stream_options;
  }
  return { ...out, ...required };
}

/**
 * Passes a stream through untouched, reading only its lines that carry a
 * `usage` object (the last chunk, with `include_usage`). `done` gets the
 * last one when the stream ends.
 */
function usageWatcher(done: (usage: Record<string, unknown>, model: unknown) => Promise<unknown>): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let pending = "";
  let skipping = false;
  let found: { usage: Record<string, unknown>; model: unknown } | null = null;
  const readLine = (line: string) => {
    if (!line.startsWith("data:") || !/"usage"\s*:\s*\{/.test(line)) return;
    try {
      const chunk = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
      if (chunk.usage && typeof chunk.usage === "object") found = { usage: chunk.usage as Record<string, unknown>, model: chunk.model };
    } catch {
      // Not a JSON line: nothing to read.
    }
  };
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      const lines = (pending + decoder.decode(chunk, { stream: true })).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (skipping) {
          skipping = false;
          continue;
        }
        readLine(line);
      }
      if (pending.length > MAX_WATCHED_LINE_CHARS) {
        pending = "";
        skipping = true;
      }
    },
    async flush() {
      if (!skipping) readLine(pending + decoder.decode());
      const last = found as { usage: Record<string, unknown>; model: unknown } | null;
      if (last) await done(last.usage, last.model);
    },
  });
}

const tokenCount = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

/**
 * A call's tokens on the chat's row, and its usage in Gravity's ad `usage`
 * shape for the chat's next card; the day's totals for the owner's report.
 */
async function recordUsage(env: GravityEnv, userId: string, chatId: string, model: string, usage: Record<string, unknown>, now: number): Promise<void> {
  const details = (usage.prompt_tokens_details ?? usage.input_tokens_details) as Record<string, unknown> | undefined;
  const inputTokens = tokenCount(usage.prompt_tokens ?? usage.input_tokens);
  const cachedInputTokens = Math.min(inputTokens, tokenCount(details?.cached_tokens ?? usage.cached_tokens));
  const outputTokens = tokenCount(usage.completion_tokens ?? usage.output_tokens);
  const day = utcDay(now);
  const add = (kind: string, amount: number) => env.DB.prepare(`
    insert into cloud_sponsored_days (day, user_id, kind, count) values (?, ?, ?, ?)
    on conflict (day, user_id, kind) do update set count = count + excluded.count
  `).bind(day, ALL, kind, amount);
  await env.DB.batch([
    env.DB.prepare(`
      update cloud_free_model_chats set input_tokens = input_tokens + ?, cached_input_tokens = cached_input_tokens + ?, output_tokens = output_tokens + ?,
        last_usage_json = ?, last_usage_at = ?
      where user_id = ? and chat_id = ?
    `).bind(inputTokens, cachedInputTokens, outputTokens, JSON.stringify({ model, inputTokens, cachedInputTokens, outputTokens }), now, userId, chatId),
    add("fm_input_tokens", inputTokens),
    add("fm_cached_input_tokens", cachedInputTokens),
    add("fm_output_tokens", outputTokens),
  ]);
}

/** A context error, in any of the ways a provider says it. */
const CONTEXT_ERROR = /context[\s_-]*(length|window)|maximum context|too many tokens|prompt is too long|input is too long|exceeds? the (model'?s? )?(context|token) (limit|window)/i;

/**
 * Gravity's refusal as ADE's. Only its retry-safe 429 stays a 429; a context
 * error becomes OpenAI's `context_length_exceeded`, which OpenCode compacts
 * on; anything about ADE's key or account with Gravity is the owner's to fix
 * (Sentry) and reads as unavailable. Gravity's own words pass only for a
 * request it found wrong, never for a key.
 */
async function upstreamRefusal(upstream: Response, model: AdeFreeModel, refuse: (code: CloudFreeModelsErrorCode, message?: string, status?: number) => Response): Promise<Response> {
  const text = (await upstream.text().catch(() => "")).slice(0, 4_000);
  let error: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (parsed.error && typeof parsed.error === "object") error = parsed.error as Record<string, unknown>;
  } catch {
    // Not JSON: the status decides.
  }
  const code = typeof error.code === "string" ? error.code.slice(0, 64) : "";
  const message = typeof error.message === "string" ? error.message : "";
  const status = upstream.status;
  if (status === 429 && code === "provider_rate_limited") {
    return openAiError("provider_rate_limited", "The model's provider is busy. Try again in a moment.", 429, "rate_limit_error");
  }
  if (status === 429) return refuse("free_models_limit", "You've reached ADE Free Models' limit for now. Try again later.");
  if (status === 403 && code === "unsupported_country_region_territory") return refuse("free_models_country");
  if (status === 413) return refuse("free_models_too_large");
  if ((status === 400 || status === 422) && CONTEXT_ERROR.test(`${code} ${message}`)) {
    return openAiError(
      "context_length_exceeded",
      `This model's maximum context length is ${model.contextWindow} tokens. However, your messages resulted in more tokens. Please reduce the length of the messages.`,
      400,
    );
  }
  // A field ADE should have sent is ADE's to fix; so is any status but a request Gravity found wrong
  // (a key refused, the account suspended, 424's do-not-retry, Gravity down).
  const ours = /^(session_id|email_hash|user_ip)_required$/.test(code);
  if (ours || (status !== 400 && status !== 422)) {
    reportCloudFailure("cloud.free_models.gravity_refused", { status, code: code || `http_${status}` });
    return refuse("free_models_unavailable");
  }
  // A request Gravity found wrong (a tool's schema, a parameter): its words help, with anything key-like cut out.
  const words = message.replace(/gr_inf_[A-Za-z0-9_-]+/g, "[key]").replace(/\s+/g, " ").trim().slice(0, 300);
  return refuse("free_models_unavailable", words ? `ADE Free Models couldn't run this request: ${words}` : MESSAGES.free_models_unavailable, 400);
}
