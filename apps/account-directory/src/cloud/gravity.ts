import { gravityAds } from "@gravity-ai/api";
import { sha256Hex } from "../sinkUtils";
import {
  CLOUD_PATHS,
  isGravityUrl,
  CLOUD_SPONSORED_CONSENTS,
  CLOUD_SPONSORED_DEVICE_TYPES,
  CLOUD_SPONSORED_MESSAGE_MAX_CHARS,
  CLOUD_SPONSORED_NEED_MAX_CHARS,
  CLOUD_SPONSORED_OSES,
  CLOUD_SPONSORED_TRACKING,
  type CloudSponsoredAd,
  type CloudSponsoredAdAnswer,
  type CloudSponsoredConsent,
  type CloudSponsoredDevice,
  type CloudSponsoredIndexAnswer,
  type CloudSponsoredMessage,
  type CloudSponsoredNoAdReason,
  type CloudSponsoredPick,
  type CloudSponsoredState,
} from "./contract";
import { readClerkUser } from "./email";
import { ROW_ID, UNREADABLE_REQUEST_MESSAGE, badRequest, fail, json, readJson, shortString } from "./http";
import { utcDay } from "./plans";
import { loadAccount, logCloud, ownedComputer, reportCloudFailure, type AccountRow, type CloudEnv } from "./store";

/**
 * Gravity (trygravity.com): sponsored cards under finished replies, and the
 * Index's service picks for agents, in the Free plan's ADE Cloud chats
 * (`docs/plans/pricing-v2-and-gravity.md`). Account-wide, so it lives here:
 * this Worker holds the key, decides who sees a card, records the consent and
 * counts the requests. Desktop, web and phone only ask and draw.
 *
 * Who sees one, all checked here on every request:
 * - the switch (`GRAVITY_ADS`): `off` (the default; nothing is sent, the
 *   account state leaves `sponsored` out), `testers` (accounts in
 *   `cloud_sponsored_testers` only) or `all`;
 * - the Free plan (a paid plan, a `past_due` one too, never sees one);
 * - the person's country (`GRAVITY_COUNTRIES`, US and Canada by default);
 * - the account's yes to the one-time question (`cloud_sponsored_consent`);
 * - a chat on one of the account's own ADE Cloud computers: never a chat on
 *   the person's own machine, whatever the plan.
 *
 * Gravity's test ads (`testAd`) are on until `GRAVITY_LIVE` is `1`: free,
 * never counted against the daily limit, never paid.
 *
 * Gravity's rules this follows: one request per ad opportunity (a finished
 * reply asks once; asking again reads the stored answer), the end user's IP
 * and user agent forwarded with `device_type` and `os`, the request made
 * through Gravity's own SDK (`gravityAds`), nothing rewarded for a view or a
 * click, and the daily request limit of a self-serve account
 * (`GRAVITY_DAILY_LIMIT`, shared by ads and the Index). No chat text is kept:
 * a card's own fields only.
 */

type GravityEnv = CloudEnv & {
  /** Secret. Gravity's publisher key: ads, the Index and the reports. Unset: everything here is off. */
  GRAVITY_API_KEY?: string;
  /** `off` (default), `testers` or `all`. */
  GRAVITY_ADS?: string;
  /** `1`: real ads and real Index picks. Anything else: Gravity's test ads. */
  GRAVITY_LIVE?: string;
  /** Countries (ISO alpha-2, comma-separated) where cards show. Default `US,CA`. */
  GRAVITY_COUNTRIES?: string;
  /** Gravity's id of the reply placement. Default `ade_reply`. */
  GRAVITY_PLACEMENT_ID?: string;
  /** Live requests a UTC day, ads and Index together, before ADE stops asking. Default 900 (self-serve allows 1,000). */
  GRAVITY_DAILY_LIMIT?: string;
};

const INDEX_URL = "https://index.trygravity.com/search";
const PLATFORM_URL = "https://platform.trygravity.com";
const INDEX_REPORT_URL = "https://api-interface.trygravity.com/index/attributions";
const REQUEST_TIMEOUT_MS = 4_000;
/** A person "has the chat open" when a client of theirs said so this recently. */
const SPONSORED_VIEWER_FRESH_MS = 10 * 60_000;
/** Ad requests one account may make a UTC day: a busy day of work, never a loop. */
const ACCOUNT_DAILY_ADS = 120;
/** Index searches one account may make a UTC day. */
const ACCOUNT_DAILY_INDEX = 20;
const DEFAULT_DAILY_LIMIT = 900;
/** A turn's stored answer lives this long. */
const TURN_TTL_MS = 24 * 60 * 60_000;
const ALL = "*";
const INDEX_CONTEXT_MESSAGES = 6;
const DEFAULT_COUNTRIES = ["US", "CA"];

type Mode = "off" | "testers" | "all";

function gravityMode(env: Pick<GravityEnv, "GRAVITY_ADS" | "GRAVITY_API_KEY">): Mode {
  if (!env.GRAVITY_API_KEY?.trim()) return "off";
  const value = env.GRAVITY_ADS?.trim().toLowerCase();
  return value === "all" || value === "testers" ? value : "off";
}

const isLive = (env: GravityEnv): boolean => env.GRAVITY_LIVE?.trim() === "1";

function countriesOf(env: GravityEnv): string[] {
  const list = (env.GRAVITY_COUNTRIES ?? "").split(",").map((code) => code.trim().toUpperCase()).filter((code) => /^[A-Z]{2}$/.test(code));
  return list.length ? list : DEFAULT_COUNTRIES;
}

/**
 * The caller's country as Cloudflare sees it, or null when there is no
 * Cloudflare data (a test, a local run). A code that names no country (Tor's
 * "T1", "XX") is kept as it is, so the country check refuses it.
 */
export function requestCountry(request: Request): string | null {
  const country = (request as Request & { cf?: { country?: unknown } }).cf?.country;
  return typeof country === "string" && country.trim() ? country.trim().toUpperCase() : null;
}

/**
 * Why this account sees no card now, or null when it may. The country is the
 * request's; an unknown one (no Cloudflare data) passes, so local runs work.
 */
async function blockedReason(env: GravityEnv, account: AccountRow, country: string | null): Promise<CloudSponsoredNoAdReason | null> {
  const mode = gravityMode(env);
  if (mode === "off") return "off";
  if (mode === "testers") {
    const row = await env.DB.prepare("select 1 as listed from cloud_sponsored_testers where user_id = ?").bind(account.user_id).first<{ listed: number }>();
    if (!row) return "off";
  }
  // Paid plans have no ads, a `past_due` one included.
  if (account.plan !== "free") return "plan";
  if (country && !countriesOf(env).includes(country)) return "country";
  return null;
}

async function readConsent(env: GravityEnv, userId: string): Promise<{ consent: CloudSponsoredConsent; email_hash: string | null } | null> {
  return env.DB.prepare("select consent, email_hash from cloud_sponsored_consent where user_id = ?")
    .bind(userId).first<{ consent: CloudSponsoredConsent; email_hash: string | null }>();
}

/**
 * The account state's `sponsored`: undefined while the switch doesn't reach
 * this account, so a client shows nothing at all. A paid account the switch
 * reaches still gets it (`ads` false), so its Settings can say there are none.
 */
export async function sponsoredAccountState(env: GravityEnv, account: AccountRow, country: string | null): Promise<CloudSponsoredState | undefined> {
  const reason = await blockedReason(env, account, country);
  if (reason === "off") return undefined;
  const consent = await readConsent(env, account.user_id);
  return { ads: reason == null, consent: consent?.consent ?? null, test: !isLive(env) };
}

/* ---- Counting ---- */

function countStatement(env: GravityEnv, day: string, userId: string, kind: string) {
  return env.DB.prepare(`
    insert into cloud_sponsored_days (day, user_id, kind, count) values (?, ?, ?, 1)
    on conflict (day, user_id, kind) do update set count = count + 1
  `).bind(day, userId, kind);
}

async function count(env: GravityEnv, now: number, userId: string, kinds: string[]): Promise<void> {
  const day = utcDay(now);
  await env.DB.batch(kinds.flatMap((kind) => [countStatement(env, day, userId, kind), countStatement(env, day, ALL, kind)]));
}

const liveDailyLimit = (env: GravityEnv): number => {
  const limit = Number(env.GRAVITY_DAILY_LIMIT ?? DEFAULT_DAILY_LIMIT);
  return Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_DAILY_LIMIT;
};

/** Adds one to a day's count only while it is under `limit`, in one write: true when it did. */
async function countUnder(env: GravityEnv, day: string, userId: string, kind: string, limit: number): Promise<boolean> {
  const result = await env.DB.prepare(`
    insert into cloud_sponsored_days (day, user_id, kind, count) values (?, ?, ?, 1)
    on conflict (day, user_id, kind) do update set count = count + 1 where count < ?
  `).bind(day, userId, kind, limit).run();
  return (result.meta?.changes ?? 0) === 1;
}

/**
 * Takes one of the day's requests for this account, and one of Gravity's
 * live ones when live, before the request goes. False when either limit is
 * reached; then nothing is counted. Test requests never count against Gravity's.
 */
async function reserveRequest(env: GravityEnv, now: number, userId: string, kind: "ad" | "index"): Promise<boolean> {
  const day = utcDay(now);
  const request = `${kind}_request`;
  if (!(await countUnder(env, day, userId, request, kind === "ad" ? ACCOUNT_DAILY_ADS : ACCOUNT_DAILY_INDEX))) return false;
  // The Index has no test mode: every search is a live one.
  const live = isLive(env) || kind === "index";
  if (live && !(await countUnder(env, day, ALL, "live_request", liveDailyLimit(env)))) {
    await env.DB.prepare("update cloud_sponsored_days set count = count - 1 where day = ? and user_id = ? and kind = ? and count > 0")
      .bind(day, userId, request).run();
    return false;
  }
  await env.DB.batch([countStatement(env, day, ALL, request), ...(live ? [countStatement(env, day, userId, "live_request")] : [])]);
  return true;
}

/* ---- Reading requests ---- */

function readDevice(value: unknown): CloudSponsoredDevice | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const type = CLOUD_SPONSORED_DEVICE_TYPES.find((entry) => entry === raw.type);
  const os = CLOUD_SPONSORED_OSES.find((entry) => entry === raw.os);
  if (!type || !os) return null;
  const tracking = CLOUD_SPONSORED_TRACKING.find((entry) => entry === raw.tracking) ?? null;
  return { type, os, osVersion: shortString(raw.osVersion, 64), ua: shortString(raw.ua, 512), tracking };
}

/**
 * The account's hashed email for Gravity, when this device may send it. The
 * ADE iPhone and iPad app (its own `ADE-iOS/` user agent) sends it only once
 * the person allowed tracking in Apple's prompt (App Tracking Transparency);
 * any other answer, or none from an older app, leaves it out. Desktop and the
 * web, a browser on an iPhone included, have no such prompt and send it.
 */
function hashedEmailFor(device: { os: string; ua?: string | null; tracking?: string | null } | null, emailHash: string | null): string | null {
  if (!emailHash) return null;
  const iosApp = device?.os === "ios" && /^ADE-iOS\//.test(device.ua ?? "");
  if (iosApp && device?.tracking !== "authorized") return null;
  return emailHash;
}

function readMessages(value: unknown, keep: number): CloudSponsoredMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): CloudSponsoredMessage[] => {
    if (!entry || typeof entry !== "object") return [];
    const { role, content } = entry as Record<string, unknown>;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string" || !content.trim()) return [];
    return [{ role, content: content.trim().slice(0, CLOUD_SPONSORED_MESSAGE_MAX_CHARS) }];
  }).slice(-keep);
}

/** The person's own address: Cloudflare's, never a header a client could set. */
const clientIp = (request: Request): string | null => request.headers.get("cf-connecting-ip")?.trim() || null;
/** A browser's own user agent wins; an app sends its own in `device.ua`. */
function clientUa(request: Request, device: CloudSponsoredDevice): string | null {
  const header = request.headers.get("user-agent")?.trim() ?? "";
  return /Mozilla\//.test(header) ? header.slice(0, 512) : device.ua ?? (header ? header.slice(0, 512) : null);
}

/** Gravity's stable id for the account: never the account id itself. */
const gravityUserId = async (userId: string): Promise<string> => `ade_${(await sha256Hex(`ade.gravity.user\0${userId}`)).slice(0, 32)}`;
/** Gravity's session for one chat, the same for ads and the Index. */
const gravitySessionId = async (userId: string, chatId: string): Promise<string> => `ade_${(await sha256Hex(`ade.gravity.session\0${userId}\0${chatId}`)).slice(0, 32)}`;

const httpsUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
};
/** One of Gravity's own https links, or null: a card opens nothing else. */
const gravityLink = (value: unknown): string | null => (isGravityUrl(value) ? httpsUrl(value) : null);
const plainText = (value: unknown, max: number): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** One of Gravity's ads as a card, or null when it lacks what a card needs. */
function adOfGravity(raw: unknown, test: boolean): CloudSponsoredAd | null {
  if (!raw || typeof raw !== "object") return null;
  const ad = raw as Record<string, unknown>;
  const clickUrl = gravityLink(ad.clickUrl);
  const brand = plainText(ad.brandName, 80);
  const text = plainText(ad.adText, 300);
  if (!clickUrl || !brand || !text) return null;
  return {
    id: crypto.randomUUID(),
    brand,
    title: plainText(ad.title, 120) || brand,
    text,
    cta: plainText(ad.cta, 40) || null,
    clickUrl,
    impUrl: gravityLink(ad.impUrl),
    favicon: httpsUrl(ad.favicon),
    test,
  };
}

/* ---- Routes ---- */

/** `/cloud/sponsored/*`, or null for any other path. */
export async function routeSponsored(request: Request, path: string, env: GravityEnv, userId: string, now: number): Promise<Response | null> {
  if (path === CLOUD_PATHS.sponsoredConsent) return request.method === "PUT" ? handleConsent(request, env, userId, now) : notFound();
  if (path === CLOUD_PATHS.sponsoredSeen) return request.method === "POST" ? handleSeen(request, env, userId, now) : notFound();
  if (path === CLOUD_PATHS.sponsoredAd) return request.method === "POST" ? handleAd(request, env, userId, now) : notFound();
  if (path === CLOUD_PATHS.sponsoredIndex) return request.method === "POST" ? handleIndex(request, env, userId, now) : notFound();
  return null;
}

const notFound = () => fail("not_found", "That ADE Cloud route doesn't exist.", 404);

/**
 * The account's answer, on every machine. A yes keeps the SHA-256 of the
 * account's email now (Gravity's `hashed_email`); a no, or a later no, keeps
 * nothing of it. Allowed while the switch reaches the account, so the answer
 * can be changed back in Settings on any plan.
 */
async function handleConsent(request: Request, env: GravityEnv, userId: string, now: number): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const consent = CLOUD_SPONSORED_CONSENTS.find((entry) => entry === body.consent);
  if (!consent) return badRequest("Say granted or declined.");
  const account = await loadAccount(env, userId, now);
  if ((await blockedReason(env, account, null)) === "off") return notFound();
  let emailHash: string | null = null;
  if (consent === "granted") {
    const email = await readClerkUser(env, userId).then((user) => user?.email ?? null).catch((error: unknown) => {
      // The yes still counts; Gravity just gets no hashed email for this account.
      reportCloudFailure("cloud.sponsored.email_read_failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    });
    emailHash = email ? await sha256Hex(email.trim().toLowerCase()) : null;
  }
  await env.DB.prepare(`
    insert into cloud_sponsored_consent (user_id, consent, email_hash, decided_at) values (?, ?, ?, ?)
    on conflict (user_id) do update set consent = excluded.consent, email_hash = excluded.email_hash, decided_at = excluded.decided_at
  `).bind(userId, consent, emailHash, now).run();
  // A no keeps nothing of where the person watched from: their address and device go too.
  if (consent === "declined") await env.DB.prepare("delete from cloud_sponsored_viewers where user_id = ?").bind(userId).run();
  logCloud("cloud.sponsored.consent", { consent });
  const state = await sponsoredAccountState(env, account, requestCountry(request));
  return json(state ?? { ads: false, consent, test: !isLive(env) });
}

/** The computer, when it is the account's own live ADE Cloud computer. */
async function ownCloudComputer(env: GravityEnv, userId: string, value: unknown) {
  const instanceId = shortString(value, 64);
  return instanceId && ROW_ID.test(instanceId) ? ownedComputer(env, userId, instanceId) : null;
}

/**
 * A person has one of this computer's chats or terminals open. Kept only for
 * an account that may see cards and said yes: it is the address and device
 * the Index sends with an agent's search, and the proof someone watches.
 */
async function handleSeen(request: Request, env: GravityEnv, userId: string, now: number): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const device = readDevice(body.device);
  if (!device) return badRequest("Say which device this is.");
  const account = await loadAccount(env, userId, now);
  const country = requestCountry(request);
  if ((await blockedReason(env, account, country)) || (await readConsent(env, userId))?.consent !== "granted") return json({ ok: false });
  const computer = await ownCloudComputer(env, userId, body.instanceId);
  if (!computer) return json({ ok: false });
  // Written only while the answer is still yes, in the same statement: a "no" that lands meanwhile wins.
  await env.DB.prepare(`
    insert into cloud_sponsored_viewers (user_id, instance_id, ip, ua, device_type, os, os_version, tracking, country, seen_at)
    select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    where exists (select 1 from cloud_sponsored_consent where user_id = ? and consent = 'granted')
    on conflict (user_id, instance_id) do update set ip = excluded.ip, ua = excluded.ua, device_type = excluded.device_type,
      os = excluded.os, os_version = excluded.os_version, tracking = excluded.tracking, country = excluded.country, seen_at = excluded.seen_at
  `).bind(userId, computer.instance_id, clientIp(request), clientUa(request, device), device.type, device.os, device.osVersion ?? null, device.tracking ?? null, country, now, userId).run();
  return json({ ok: true });
}

/** A reply's ask is being answered: the row is claimed, Gravity's answer not in yet. */
const PENDING_TURN = "pending";

async function readTurn(env: GravityEnv, userId: string, chatId: string, turnId: string, now: number): Promise<CloudSponsoredAdAnswer | null> {
  const row = await env.DB.prepare("select ad_json, reason, created_at from cloud_sponsored_turns where user_id = ? and chat_id = ? and turn_id = ?")
    .bind(userId, chatId, turnId).first<{ ad_json: string | null; reason: string | null; created_at: number }>();
  if (!row || now - row.created_at > TURN_TTL_MS) return null;
  if (!row.ad_json) {
    const reason = !row.reason || row.reason === PENDING_TURN ? "no_fill" : row.reason as CloudSponsoredNoAdReason;
    return { ad: null, reason };
  }
  try {
    return { ad: JSON.parse(row.ad_json) as CloudSponsoredAd };
  } catch {
    reportCloudFailure("cloud.sponsored.turn_unreadable", {});
    return { ad: null, reason: "no_fill" };
  }
}

/**
 * Claims a reply before Gravity is asked: of two screens asking at once, only
 * the one that wrote the row asks. False when another ask holds it.
 */
async function claimTurn(env: GravityEnv, userId: string, chatId: string, turnId: string, now: number): Promise<boolean> {
  const [, claim] = await env.DB.batch([
    env.DB.prepare("delete from cloud_sponsored_turns where created_at < ?").bind(now - TURN_TTL_MS),
    env.DB.prepare(`
      insert into cloud_sponsored_turns (user_id, chat_id, turn_id, ad_json, reason, created_at) values (?, ?, ?, null, ?, ?)
      on conflict (user_id, chat_id, turn_id) do nothing
    `).bind(userId, chatId, turnId, PENDING_TURN, now),
  ]);
  return (claim?.meta?.changes ?? 0) === 1;
}

async function saveTurn(env: GravityEnv, userId: string, chatId: string, turnId: string, answer: CloudSponsoredAdAnswer): Promise<void> {
  await env.DB.prepare("update cloud_sponsored_turns set ad_json = ?, reason = ? where user_id = ? and chat_id = ? and turn_id = ?")
    .bind(answer.ad ? JSON.stringify(answer.ad) : null, answer.ad ? null : answer.reason ?? "no_fill", userId, chatId, turnId).run();
}

/** Gravity didn't answer: the claim goes, so a later ask for this reply may try again. */
async function releaseTurn(env: GravityEnv, userId: string, chatId: string, turnId: string): Promise<void> {
  await env.DB.prepare("delete from cloud_sponsored_turns where user_id = ? and chat_id = ? and turn_id = ? and reason = ?")
    .bind(userId, chatId, turnId, PENDING_TURN).run();
}

/**
 * One card under a finished reply. The client asks only while a person has
 * the chat open; every rule is checked again here. An answer of no card is a
 * 200 with its reason, never an error: the client shows nothing either way.
 */
async function handleAd(request: Request, env: GravityEnv, userId: string, now: number): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const chatId = shortString(body.chatId, 160);
  const turnId = shortString(body.turnId, 160);
  const device = readDevice(body.device);
  if (!chatId || !ROW_ID.test(chatId) || !turnId || !ROW_ID.test(turnId) || !device) return badRequest("Name the chat, its reply and the device.");
  const none = (reason: CloudSponsoredNoAdReason) => json({ ad: null, reason } satisfies CloudSponsoredAdAnswer);

  const account = await loadAccount(env, userId, now);
  const blocked = await blockedReason(env, account, requestCountry(request));
  if (blocked) return none(blocked);
  const consent = await readConsent(env, userId);
  if (consent?.consent !== "granted") return none("consent");
  // Only a chat on one of the account's own ADE Cloud computers: never one on the person's own machine.
  const computer = await ownCloudComputer(env, userId, body.instanceId);
  if (!computer) return none("not_cloud");
  // And the chat itself runs there: that computer saved a copy of it after a
  // turn (`chats.ts`), and it is a person's chat, not a subagent's. Never
  // stored, so the first reply's ask may come again once its copy is saved.
  const copy = await env.DB.prepare("select parent_chat_id from cloud_chat_copies where user_id = ? and chat_id = ? and instance_id = ? limit 1")
    .bind(userId, chatId, computer.instance_id).first<{ parent_chat_id: string | null }>();
  if (!copy || copy.parent_chat_id) return none("not_cloud");
  // One request per finished reply: a second ask (a reload, a second screen) reads the first answer.
  const stored = await readTurn(env, userId, chatId, turnId, now);
  if (stored) return json(stored);
  const messages = readMessages(body.messages, 2);
  if (!messages.length) return none("no_fill");
  if (!(await claimTurn(env, userId, chatId, turnId, now))) return none("no_fill");
  if (!(await reserveRequest(env, now, userId, "ad"))) {
    await releaseTurn(env, userId, chatId, turnId);
    return none("limit");
  }

  const live = isLive(env);
  const ip = clientIp(request);
  const hashedEmail = hashedEmailFor(device, consent.email_hash);
  const result = await gravityAds(
    {
      body: {
        gravity_context: {
          sessionId: await gravitySessionId(userId, chatId),
          user: { id: await gravityUserId(userId), ...(hashedEmail ? { hashed_email: hashedEmail } : {}) },
          device: {
            ua: clientUa(request, device) ?? undefined,
            device_type: device.type,
            os: device.os,
            ...(device.osVersion ? { os_version: device.osVersion } : {}),
          },
        },
      },
      headers: ip ? { "x-forwarded-for": ip } : {},
    },
    messages,
    [{ placement: "below_response", placement_id: env.GRAVITY_PLACEMENT_ID?.trim() || "ade_reply" }],
    { apiKey: env.GRAVITY_API_KEY, production: live, supportsSpec: false, timeoutMs: REQUEST_TIMEOUT_MS },
  ).catch(() => null);
  if (!result || (result.status !== 200 && result.status !== 204 && result.status !== 202)) {
    // Gravity's answer is never an error for the person: no card, and the owner hears of it.
    reportCloudFailure("cloud.sponsored.ad_failed", { status: result?.status ?? 0 });
    await releaseTurn(env, userId, chatId, turnId);
    return none("unavailable");
  }
  const ad = adOfGravity(result.ads[0], !live);
  const answer: CloudSponsoredAdAnswer = ad ? { ad } : { ad: null, reason: "no_fill" };
  if (ad) await count(env, now, userId, ["ad_fill"]);
  await saveTurn(env, userId, chatId, turnId, answer);
  return json(answer);
}

/** One of Gravity's Index answers as a pick, or null. */
function pickOfIndex(raw: unknown): CloudSponsoredPick | null {
  if (!raw || typeof raw !== "object") return null;
  const answer = raw as Record<string, unknown>;
  const rec = answer.recommendation && typeof answer.recommendation === "object" ? answer.recommendation as Record<string, unknown> : null;
  if (!rec) return null;
  const url = gravityLink(rec.click_url) ?? gravityLink(answer.click_url);
  const name = plainText(rec.name, 80);
  if (!url || !name) return null;
  const objectOf = (value: unknown) => (value && typeof value === "object" ? value as Record<string, unknown> : null);
  const install = objectOf(rec.install) ?? objectOf(answer.install);
  // Every documented step form, in order: plain text, a command, a file to write, or something the person does.
  const stepText = (step: unknown): unknown => {
    if (typeof step === "string") return step;
    const entry = objectOf(step);
    if (!entry) return null;
    const file = typeof entry.file === "string" ? entry.file : null;
    const action = typeof entry.action === "string" ? entry.action : null;
    return entry.text ?? entry.command ?? entry.user_action ?? entry.description ?? (action && file ? `${action}: ${file}` : action ?? file);
  };
  // A command keeps its exact spacing, without control, zero-width or
  // direction marks; one too long to show whole is never cut.
  const stepOf = (step: unknown): string => {
    const value = stepText(step);
    if (typeof value !== "string") return "";
    const clean = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, "").trim();
    return clean.length <= 500 ? clean : "";
  };
  // The steps in order up to the first that can't be shown whole: "Use it"
  // never puts a sequence with a hole in it in the prompt box.
  const steps: string[] = [];
  for (const step of Array.isArray(install?.steps) ? install.steps.slice(0, 8) : []) {
    const text = stepOf(step);
    if (!text) break;
    steps.push(text);
  }
  return {
    id: plainText(answer.search_id, 80) || crypto.randomUUID(),
    name,
    description: plainText(rec.description, 400),
    category: plainText(rec.category, 60) || null,
    url,
    websiteUrl: httpsUrl(rec.website_url),
    docsUrl: httpsUrl(rec.docs_url),
    sponsored: rec.sponsored === true,
    installSteps: steps,
  };
}

/**
 * An agent on an ADE Cloud computer asks the Index for a service the person
 * needs. Only from the account's own cloud computer, only while a person has
 * one of its chats or terminals open (their address and device go with it),
 * and only on an account that may see cards and said yes.
 */
async function handleIndex(request: Request, env: GravityEnv, userId: string, now: number): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const need = typeof body.need === "string" ? body.need.replace(/\s+/g, " ").trim().slice(0, CLOUD_SPONSORED_NEED_MAX_CHARS) : "";
  if (need.length < 3) return badRequest("Say what the person needs.");
  const none = (reason: CloudSponsoredIndexAnswer["reason"]) => json({ pick: null, reason } satisfies CloudSponsoredIndexAnswer);

  const account = await loadAccount(env, userId, now);
  const computer = await ownCloudComputer(env, userId, body.instanceId);
  if (!computer) return none("not_cloud");
  const viewer = await env.DB.prepare("select * from cloud_sponsored_viewers where user_id = ? and instance_id = ?")
    .bind(userId, computer.instance_id).first<{ ip: string | null; ua: string | null; os: string; tracking: string | null; country: string | null; seen_at: number }>();
  // The country is the person's, from their last look at the chat: the agent's computer is not where they are.
  const blocked = await blockedReason(env, account, viewer?.country ?? null);
  if (blocked) return none(blocked);
  // Gravity's Index has no test mode, so before go-live only the testers' searches reach it.
  if (!isLive(env) && gravityMode(env) !== "testers") return none("off");
  const consent = await readConsent(env, userId);
  if (consent?.consent !== "granted") return none("consent");
  if (!viewer?.ip || now - viewer.seen_at > SPONSORED_VIEWER_FRESH_MS) return none("nobody_watching");
  const chatId = shortString(body.chatId, 160);
  if (chatId && ROW_ID.test(chatId)) {
    // The chat runs on this computer and is a person's, not a subagent's. A
    // chat with no copy yet is on its first turn, before its copy is saved.
    const copies = await env.DB.prepare(`
      select count(*) as total, coalesce(max(parent_chat_id is not null), 0) as child, coalesce(max(instance_id = ?), 0) as here
      from cloud_chat_copies where user_id = ? and chat_id = ?
    `).bind(computer.instance_id, userId, chatId).first<{ total: number; child: number; here: number }>();
    if (copies && copies.total > 0 && (copies.child || !copies.here)) return none("not_cloud");
  }
  if (!(await reserveRequest(env, now, userId, "index"))) return none("limit");
  const messages = readMessages(body.messages, INDEX_CONTEXT_MESSAGES);
  // The person's own device decides, as for a card: an iPhone without tracking allowed sends no email.
  const hashedEmail = hashedEmailFor(viewer, consent.email_hash);

  let response: Response;
  try {
    response = await fetch(INDEX_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.GRAVITY_API_KEY! },
      body: JSON.stringify({
        query: need,
        user_ip: viewer.ip,
        ...(viewer.ua ? { user_agent: viewer.ua } : {}),
        ...(chatId && ROW_ID.test(chatId) ? { session_id: await gravitySessionId(userId, chatId) } : {}),
        ...(hashedEmail ? { hashed_email: hashedEmail } : {}),
        ...(viewer.country ? { country: viewer.country } : {}),
        ...(messages.length ? { context: { messages } } : {}),
        max_options: 1,
        vertical: "developer",
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2),
    });
  } catch {
    reportCloudFailure("cloud.sponsored.index_failed", { status: 0 });
    return none("unavailable");
  }
  if (!response.ok) {
    reportCloudFailure("cloud.sponsored.index_failed", { status: response.status });
    return none(response.status === 429 ? "limit" : "unavailable");
  }
  const pick = pickOfIndex(await response.json().catch(() => {
    reportCloudFailure("cloud.sponsored.index_unreadable", { status: response.status });
    return null;
  }));
  if (pick) await count(env, now, userId, ["index_pick"]);
  return json({ pick, ...(pick ? {} : { reason: "no_fill" as const }) } satisfies CloudSponsoredIndexAnswer);
}

/* ---- The owner's report ---- */

/**
 * The clean-up, twice an hour (minutes 23 and 53, every account, whatever the
 * switch): a reply's answer older than a day, and where a person watched from
 * (IP address, user agent, device, OS) once that is a day old, a computer
 * since deleted included. Nothing outlives a day by more than 30 minutes, or
 * an hour when one run fails. Every other tick makes no query.
 */
export async function pruneSponsored(env: GravityEnv, scheduledTime: number): Promise<void> {
  const minute = new Date(scheduledTime).getUTCMinutes();
  if (minute !== 23 && minute !== 53) return;
  const now = scheduledTime;
  await env.DB.batch([
    env.DB.prepare("delete from cloud_sponsored_turns where created_at < ?").bind(now - TURN_TTL_MS),
    env.DB.prepare("delete from cloud_sponsored_viewers where seen_at < ?").bind(now - TURN_TTL_MS),
  ]);
}

/**
 * Lines for the owner's daily report: ADE's own counts of the day, and what
 * Gravity says the day paid (ads and the Index), against `freeCostMicros`, the
 * day's cost of free-plan use. Nothing while the switch is off and the day
 * had no requests. Gravity's reports are best effort: a failed read says so.
 */
export async function sponsoredReportLines(env: GravityEnv, day: string, freeCostMicros: number | null): Promise<string[]> {
  const rows = (await env.DB.prepare("select kind, count from cloud_sponsored_days where day = ? and user_id = ?")
    .bind(day, ALL).all<{ kind: string; count: number }>()).results ?? [];
  const counts = new Map(rows.map((row) => [row.kind, row.count]));
  const mode = gravityMode(env);
  if (mode === "off" && rows.length === 0) return [];
  const n = (kind: string) => counts.get(kind) ?? 0;
  const lines = [
    `Sponsored (${mode}${isLive(env) ? ", live" : ", test ads"}): ${n("ad_request")} ad requests, ${n("ad_fill")} filled; ${n("index_request")} Index searches, ${n("index_pick")} picks.`,
  ];
  if (!env.GRAVITY_API_KEY?.trim()) return lines;
  const key = env.GRAVITY_API_KEY.trim();
  const read = async (url: string): Promise<Record<string, unknown> | null> => {
    const response = await fetch(url, { headers: { "x-api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    return response.ok ? await response.json() as Record<string, unknown> : null;
  };
  const [ads, index] = await Promise.all([
    read(`${PLATFORM_URL}/publisher-dashboard/stats?start_date=${day}&end_date=${day}`).catch(() => null),
    read(`${INDEX_REPORT_URL}?side=publisher&start_date=${day}&end_date=${day}`).catch(() => null),
  ]);
  const adUsd = typeof ads?.totalRevenue === "number" ? ads.totalRevenue : null;
  const summary = index?.summary && typeof index.summary === "object" ? index.summary as Record<string, unknown> : null;
  const indexUsd = typeof summary?.revenue_cents === "number" ? summary.revenue_cents / 100 : null;
  const freeCost = freeCostMicros == null ? "an unknown amount (couldn't be read)" : `$${(freeCostMicros / 1_000_000).toFixed(2)}`;
  lines.push(
    adUsd == null && indexUsd == null
      ? `Gravity's reports couldn't be read today. Free-plan cost: ${freeCost}.`
      : `Gravity paid ${adUsd == null ? "an unknown amount (report unreadable)" : `$${adUsd.toFixed(2)}`} for ads${typeof ads?.totalImpressions === "number" ? ` (${ads.totalImpressions} views, ${ads.totalClicks ?? 0} clicks)` : ""} and ${indexUsd == null ? "an unknown amount (report unreadable)" : `$${indexUsd.toFixed(2)}`} for the Index${typeof summary?.conversions === "number" ? ` (${summary.conversions} sign-ups)` : ""}, against ${freeCost} of free-plan cost.`,
  );
  return lines;
}
