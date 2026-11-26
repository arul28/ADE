import { gravityAds } from "@gravity-ai/api";
import { sha256Hex } from "../sinkUtils";
import {
  CLOUD_PATHS,
  isGravityUrl,
  CLOUD_SPONSORED_CHOICES,
  CLOUD_SPONSORED_DEVICE_TYPES,
  CLOUD_SPONSORED_FORMATS,
  CLOUD_SPONSORED_MESSAGE_MAX_CHARS,
  CLOUD_SPONSORED_NEED_MAX_CHARS,
  CLOUD_SPONSORED_OSES,
  CLOUD_SPONSORED_RENDERERS,
  CLOUD_SPONSORED_SURFACES,
  CLOUD_SPONSORED_TRACKING,
  type CloudSponsoredAd,
  type CloudSponsoredAdAnswer,
  type CloudSponsoredConsent,
  type CloudSponsoredDevice,
  type CloudSponsoredFormat,
  type CloudSponsoredGravityAd,
  type CloudSponsoredRenderer,
  type CloudSponsoredSurface,
  type CloudSponsoredIndexAnswer,
  type CloudSponsoredMessage,
  type CloudSponsoredNoAdReason,
  type CloudSponsoredPick,
  type CloudSponsoredState,
} from "./contract";
import { readClerkUser } from "./email";
import { ROW_ID, UNREADABLE_REQUEST_MESSAGE, badRequest, fail, json, readJson, shortString } from "./http";
import { utcDay } from "./plans";
import { readCloudSettings, type CloudSettings } from "./settings";
import {
  countryCodesOf,
  gpcOptsOut,
  gpcOverrides,
  readConsent,
  shownAnswer,
  requestNetwork,
  sponsoredRequester,
  startsOnFor,
  startsOnNow,
  yesHolds,
  yesNeedsConfirm,
  type ConsentRow,
  type SponsoredRequester,
} from "./sponsoredConsent";
import { noteSmallLook, smallFreeFrom, smallLookTripwire, smallStateOf, syncSmallRates } from "./sponsoredSmall";
import type { CloudWaitUntil } from "./analytics";
import { gravitySwitches, isTester, switchReaches, type Switches } from "./sponsoredSwitch";
import {
  loadAccount,
  logCloud,
  ownedComputer,
  reportCloudFailure,
  shownPlanIdOf,
  type AccountRow,
  type CloudEnv,
} from "./store";

/**
 * Gravity (trygravity.com): sponsored cards under finished replies, and the
 * Index's service picks for agents, in the Free plan's ADE Cloud chats
 * (`docs/plans/pricing-v2-and-gravity.md`). Account-wide, so it lives here:
 * this Worker holds the key, decides who sees a card, records the consent and
 * counts the requests. Desktop, web and phone only ask and draw.
 *
 * Who sees one, all checked here on every request:
 * - the switch: `off` (the default; nothing is sent, the account state
 *   leaves `sponsored` out), `testers` (accounts in `cloud_sponsored_testers`
 *   only) or `all`. It is the instant `gravity_ads` setting (`settings.ts`),
 *   held under the deploy variable `GRAVITY_ADS` (`off` there is a hard off);
 * - the Free plan (a paid plan, a `past_due` one too, never sees one), or
 *   the account test tool's plan (`shownPlanIdOf`);
 * - the person's country (`GRAVITY_COUNTRIES`, by default US, CA, GB and AU);
 * - the account's yes to the one-time question (`cloud_sponsored_consent`),
 *   or, where cards start on (`GRAVITY_DEFAULT_ON_COUNTRIES`, the US by
 *   default), the yes saved once the person was told they are on
 *   (`startsOnFor`);
 * - a chat on one of the account's own ADE Cloud computers: never a chat on
 *   the person's own machine, whatever the plan.
 *
 * Gravity's test ads (`testAd`) are on until the `gravity_live` setting is
 * `on` and the deploy variable `GRAVITY_LIVE` is `1`: free, never counted
 * against the daily limit, never paid.
 *
 * Gravity's rules this follows: one request per ad opportunity (a finished
 * reply asks once; asking again reads the stored answer), the end user's IP
 * and user agent forwarded with `device_type` and `os`, the request made
 * through Gravity's own SDK (`gravityAds`), nothing rewarded for a view or a
 * click, and an optional ceiling on live requests a day
 * (`GRAVITY_DAILY_LIMIT`, shared by ads and the Index; ADE's Gravity contract
 * has no daily limit, so unset means none). No chat text is kept:
 * a card's own fields only.
 */

export type GravityEnv = CloudEnv & {
  /** Secret. Gravity's publisher key: ads, the Index and the reports. Unset: everything here is off. */
  GRAVITY_API_KEY?: string;
  /** The highest the `gravity_ads` setting may go: `off` (default, a hard off), `testers` or `all`. */
  GRAVITY_ADS?: string;
  /** `1` lets the `gravity_live` setting turn on real ads and real Index picks. Anything else: Gravity's test ads only. */
  GRAVITY_LIVE?: string;
  /** Countries (ISO alpha-2, comma-separated) where cards show. Default `US,CA,GB,AU`. */
  GRAVITY_COUNTRIES?: string;
  /**
   * Countries where cards start on: the person is told they are on and can
   * turn them off, instead of being asked first. Default `US`; an empty value
   * turns this off, so every country is asked.
   */
  GRAVITY_DEFAULT_ON_COUNTRIES?: string;
  /** Optional: live requests a UTC day, ads and Index together, before ADE stops asking. Unset: no ceiling (the contract has no daily limit). */
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
/** A turn's stored answer lives this long. */
const TURN_TTL_MS = 24 * 60 * 60_000;
const ALL = "*";
const INDEX_CONTEXT_MESSAGES = 6;
/** Where Gravity fills real ads (Gravity, 2026-11-24): the US, Canada, the UK and Australia. */
const DEFAULT_COUNTRIES = ["US", "CA", "GB", "AU"];

/**
 * Gravity's placement for each format, and the slug part of its id: each
 * surface and format is its own registered placement, `ade-<surface>-<slug>`
 * (registered 2026-11-24 with Gravity's placements API), so Gravity reports
 * each one apart. An inline sentence keeps its ad text short.
 */
const PLACEMENTS: Record<CloudSponsoredFormat, { placement: "below_response" | "bottom_page" | "inline_response"; slug: string; maxChars?: number }> = {
  below_reply: { placement: "below_response", slug: "below" },
  above_prompt: { placement: "bottom_page", slug: "above-prompt" },
  inline: { placement: "inline_response", slug: "inline", maxChars: 120 },
};

/** Whether a country is outside `GRAVITY_COUNTRIES`. An unknown one (no Cloudflare data) is inside. */
function outsideCountryList(env: GravityEnv, country: string | null): boolean {
  return Boolean(country) && !countriesOf(env).includes(country!);
}

/**
 * Whether the caller is outside the countries cards are shown in. While ads
 * are Gravity's test ads, a tester is inside from anywhere: test ads pay
 * nobody, and the owner tests from wherever they are. (The Index has no test
 * mode, so it checks the list itself.)
 */
async function outsideCountries(env: GravityEnv, account: AccountRow, country: string | null, switches: Switches): Promise<boolean> {
  if (!outsideCountryList(env, country)) return false;
  return switches.live || !(await isTester(env, account.user_id));
}

function countriesOf(env: GravityEnv): string[] {
  const list = countryCodesOf(env.GRAVITY_COUNTRIES);
  return list.length ? list : DEFAULT_COUNTRIES;
}

/**
 * Why this account sees no card now, or null when it may. The country is the
 * request's; an unknown one (no Cloudflare data) passes, so local runs work.
 */
async function blockedReason(env: GravityEnv, account: AccountRow, country: string | null, switches?: Switches): Promise<CloudSponsoredNoAdReason | null> {
  const read = switches ?? (await gravitySwitches(env));
  if (!(await switchReaches(env, account, read.mode))) return "off";
  // Paid plans have no ads, a `past_due` one included; the test tool's plan counts as the plan.
  if (shownPlanIdOf(account) !== "free") return "plan";
  if (await outsideCountries(env, account, country, read)) return "country";
  return null;
}

/** Deletes where the person watched from (address, device), in the same transaction as the no it follows. */
const clearViewers = (env: GravityEnv, userId: string) => env.DB.prepare("delete from cloud_sponsored_viewers where user_id = ?").bind(userId);

/**
 * Turns the account's answer into a no when this request's Global Privacy
 * Control overrides it (`gpcOverrides`: from the US, over no answer or a yes
 * not given from such a browser): cards stop on every device, the Index
 * stops, Small uses credits, and no notice starts cards on another device.
 * Saved only over the answer it read, with the viewer rows cleared in the
 * same transaction; one saved meanwhile is checked once more. Returns the
 * account's answer as it now is.
 */
async function honorGpc(env: GravityEnv, account: AccountRow, read: ConsentRow | null, who: SponsoredRequester, now: number): Promise<ConsentRow | null> {
  let consent = read;
  for (let tries = 0; tries < 2 && gpcOverrides(consent, who); tries += 1) {
    const flip = consent
      ? env.DB.prepare(`
        update cloud_sponsored_consent set consent = 'declined', email_hash = null, decided_at = ?, source = 'gpc', country = ?, gpc = 0, looked_at = null, looked_asn = null
        where user_id = ? and consent = 'granted' and decided_at = ?
      `).bind(now, who.country, account.user_id, consent.decided_at)
      : env.DB.prepare(`
        insert into cloud_sponsored_consent (user_id, consent, email_hash, decided_at, source, country, gpc) values (?, 'declined', null, ?, 'gpc', ?, 0)
        on conflict (user_id) do nothing
      `).bind(account.user_id, now, who.country);
    // Only after this flip: an answer saved meanwhile keeps its viewers.
    const clear = env.DB.prepare(`
      delete from cloud_sponsored_viewers where user_id = ?
        and exists (select 1 from cloud_sponsored_consent where user_id = ? and consent = 'declined' and source = 'gpc' and decided_at = ?)
    `).bind(account.user_id, account.user_id, now);
    const [saved] = await env.DB.batch([flip, clear]);
    if (!saved?.meta?.changes) {
      consent = await readConsent(env, account.user_id);
      continue;
    }
    logCloud("cloud.sponsored.consent", { consent: "declined", source: "gpc" });
    await syncSmallRates(env, account, now);
    return { consent: "declined", email_hash: null, decided_at: now, source: "gpc", country: who.country, gpc: 0, looked_at: null, looked_asn: null };
  }
  return consent;
}

/**
 * The account state's `sponsored`: undefined while the switch doesn't reach
 * this account, so a client shows nothing at all. A paid account the switch
 * reaches still gets it (`ads` false), so its Settings can say there are none.
 */
export async function sponsoredAccountState(env: GravityEnv, account: AccountRow, who: SponsoredRequester, now: number): Promise<CloudSponsoredState | undefined> {
  const settings = await readCloudSettings(env);
  const switches = await gravitySwitches(env, settings);
  const reason = await blockedReason(env, account, who.country, switches);
  if (reason === "off") return undefined;
  // An account joins the A/B test's arm only once ads reach it.
  const [read, format] = await Promise.all([readConsent(env, account.user_id), sponsoredFormatOf(env, account.user_id, settings, now, reason == null)]);
  // A browser's Global Privacy Control from the US opts the whole account out.
  const consent = await honorGpc(env, account, read, who, now);
  const answer = await shownAnswer(env, consent, who, now);
  return {
    ads: reason == null,
    consent: answer,
    // Not asked where cards start on: the client tells the person they are on, and saves that (`PUT /consent` `notice`).
    ...(startsOnNow(env, consent, answer, who) && reason == null ? { startsOn: true } : {}),
    // A yes after a no (theirs, or their browser's Global Privacy Control) is asked twice, as California has it.
    ...(yesNeedsConfirm(consent, answer, who) ? { confirmYes: true } : {}),
    // The no came from a browser's Global Privacy Control: Settings says so.
    ...(answer === "declined" && consent?.source === "gpc" ? { gpcOff: true } : {}),
    test: !switches.live,
    format,
    ...smallStateOf(account, consent, who, now),
  };
}

/**
 * Where the account's cards show: the owner's choice for it, else the
 * `gravity_format` switch. Under `split`, the account's arm of the A/B test:
 * the one it was first given (kept in `cloud_sponsored_formats`), or, the
 * first time ads reach it (`assign`), one drawn by its id at the split's
 * weights and kept, the same on every machine.
 */
async function sponsoredFormatOf(env: GravityEnv, userId: string, settings: CloudSettings, now: number, assign: boolean): Promise<CloudSponsoredFormat> {
  const row = await env.DB.prepare("select format, source from cloud_sponsored_formats where user_id = ?").bind(userId).first<{ format: string; source: string }>();
  if (row?.source === "owner" && isSponsoredFormat(row.format)) return row.format;
  if (settings.gravity_format !== "split") return settings.gravity_format;
  if (row?.source === "split" && isSponsoredFormat(row.format)) return row.format;
  const format = splitArm(userId, settings.gravity_format_split);
  if (!assign) return format;
  // Never for an account being deleted: its deletion may already have cleared this table.
  const written = await env.DB.prepare(`
    insert into cloud_sponsored_formats (user_id, format, source, set_at)
    select ?, ?, 'split', ? where not exists (select 1 from cloud_accounts where user_id = ? and deleted_at is not null)
    on conflict (user_id) do nothing
  `).bind(userId, format, now, userId).run();
  if ((written.meta?.changes ?? 0) > 0) return format;
  // Another write got there first (the owner's choice, or another screen's split): that one holds.
  const saved = await env.DB.prepare("select format from cloud_sponsored_formats where user_id = ?").bind(userId).first<{ format: string }>();
  return isSponsoredFormat(saved?.format) ? saved.format : format;
}

/** The split's arms in the order its weights are written: under the reply, inline, above the prompt box. */
const SPLIT_ARMS: readonly CloudSponsoredFormat[] = ["below_reply", "inline", "above_prompt"];

/** The arm an account's id falls in at these weights: a stable bucket from 0 to 99. */
export function splitArm(userId: string, weights: string): CloudSponsoredFormat {
  let hash = 0x811c9dc5;
  for (const char of `ade-ad-format:${userId}`) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  const bucket = hash % 100;
  let edge = 0;
  const parts = weights.split("-").map(Number);
  for (const [index, arm] of SPLIT_ARMS.entries()) {
    edge += parts[index] ?? 0;
    if (bucket < edge) return arm;
  }
  return SPLIT_ARMS[0]!;
}

export const isSponsoredFormat = (value: unknown): value is CloudSponsoredFormat =>
  typeof value === "string" && (CLOUD_SPONSORED_FORMATS as readonly string[]).includes(value);

/** The app that asks for a card; an older client names none, and its device says which. */
function surfaceOf(value: unknown, device: CloudSponsoredDevice): CloudSponsoredSurface {
  if (typeof value === "string" && (CLOUD_SPONSORED_SURFACES as readonly string[]).includes(value)) return value as CloudSponsoredSurface;
  return device.os === "ios" ? "ios" : "desktop";
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

/** The optional ceiling on live requests a day, or null for none (unset or not a positive number). */
const liveDailyLimit = (env: GravityEnv): number | null => {
  const limit = Number(env.GRAVITY_DAILY_LIMIT);
  return env.GRAVITY_DAILY_LIMIT && Number.isFinite(limit) && limit > 0 ? limit : null;
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
async function reserveRequest(env: GravityEnv, now: number, userId: string, kind: "ad" | "index", switches: Switches): Promise<boolean> {
  const day = utcDay(now);
  const request = `${kind}_request`;
  if (!(await countUnder(env, day, userId, request, kind === "ad" ? ACCOUNT_DAILY_ADS : ACCOUNT_DAILY_INDEX))) return false;
  // The Index has no test mode: every search is a live one.
  const live = switches.live || kind === "index";
  const ceiling = live ? liveDailyLimit(env) : null;
  if (ceiling !== null && !(await countUnder(env, day, ALL, "live_request", ceiling))) {
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
function adOfGravity(raw: unknown, test: boolean, renderer: CloudSponsoredRenderer | null): CloudSponsoredAd | null {
  if (!raw || typeof raw !== "object") return null;
  const ad = raw as Record<string, unknown>;
  const clickUrl = gravityLink(ad.clickUrl);
  const brand = plainText(ad.brandName, 80);
  const text = plainText(ad.adText, 300);
  if (!clickUrl || !brand || !text) return null;
  const impUrl = gravityLink(ad.impUrl);
  return {
    id: crypto.randomUUID(),
    brand,
    title: plainText(ad.title, 120) || brand,
    text,
    cta: plainText(ad.cta, 40) || null,
    clickUrl,
    impUrl,
    favicon: httpsUrl(ad.favicon),
    test,
    ...(renderer ? { gravity: gravityAdOf(ad, clickUrl, impUrl, renderer) } : {}),
  };
}

/** Gravity's designs are a few kilobytes; anything far past that is not one. */
const MAX_RENDERER_SPEC_CHARS = 32_000;
const optionalText = (value: unknown, max: number): string | undefined => plainText(value, max) || undefined;

/**
 * Gravity's ad for its own renderer: its design and copy, in its own field
 * names, with the links already checked. Only what ADE draws goes through: a
 * frame, a prompt action, an MCP connect or a data unit is left out (the
 * request asks for none), so the renderer falls back to the design.
 */
function gravityAdOf(ad: Record<string, unknown>, clickUrl: string, impUrl: string | null, renderer: CloudSponsoredRenderer): CloudSponsoredGravityAd {
  const render = ad.render && typeof ad.render === "object" ? ad.render as Record<string, unknown> : null;
  const mode = render?.mode === "spec" || render?.mode === "native" ? render.mode : null;
  let spec = typeof ad.renderer_spec === "string" ? (() => {
    try { return JSON.parse(ad.renderer_spec as string) as unknown; } catch { return null; }
  })() : ad.renderer_spec;
  if (!spec || typeof spec !== "object" || Array.isArray(spec) || JSON.stringify(spec).length > MAX_RENDERER_SPEC_CHARS) spec = null;
  const out: CloudSponsoredGravityAd = {
    adText: plainText(ad.adText, 300),
    clickUrl,
    ...(impUrl ? { impUrl } : {}),
    ...(mode ? { render: { mode, ...(typeof render?.layout === "string" ? { layout: render.layout.slice(0, 40) } : {}) } } : {}),
    ...(ad.hasDeeplink === true ? { hasDeeplink: true } : {}),
  };
  const texts: Array<[keyof CloudSponsoredGravityAd, number]> = [
    ["title", 120], ["cta", 40], ["brandName", 80], ["placement", 40], ["placement_id", 120], ["campaignId", 120],
    ["variant", 80], ["experiment_id", 120], ["composition_id", 120], ["renderer_key", 120],
  ];
  for (const [field, max] of texts) {
    const value = optionalText(ad[field], max);
    if (value) (out as Record<string, unknown>)[field] = value;
  }
  for (const field of ["url", "favicon", "brandImage"] as const) {
    const value = httpsUrl(ad[field]);
    if (value) out[field] = value;
  }
  if (spec && renderer === "psp1") {
    const design = spec as Record<string, unknown>;
    const fields = out as Record<string, unknown>;
    spec = { ...design, root: withRowSpacers(design.root, (node) => psp1Draws(node, fields)) };
  }
  if (spec) out.renderer_spec = spec as Record<string, unknown>;
  return out;
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** An empty, ungated `box` whose only style is `grow: 1`: a flexible gap, nothing drawn. */
function isGrowGap(node: unknown): boolean {
  if (!isObject(node) || node.type !== "box" || node.showIf !== undefined || (Array.isArray(node.children) && node.children.length > 0)) return false;
  const style = isObject(node.style) ? node.style : {};
  const keys = Object.keys(style);
  return keys.length === 1 && Number(style.grow) === 1;
}

/** The ad fields a PSP-1 design can bind (`SpecConstants.bindableFields` in Gravity's Swift SDK). */
const PSP1_FIELDS = new Set(["adText", "title", "cta", "brandName", "url", "favicon", "brandImage"]);

/**
 * Whether Gravity's Swift SDK draws a node for this ad (`SpecAdView`'s
 * `willRender`): a `showIf` field must be filled, text must resolve to
 * something (a `{field}` it can't fill becomes nothing), and an image needs
 * its link. The SDK leaves out children that draw nothing before it places
 * spacers, so a spacer on one of them would be lost.
 */
function psp1Draws(node: Record<string, unknown>, fields: Record<string, unknown>): boolean {
  const value = (name: unknown) => (typeof name === "string" && PSP1_FIELDS.has(name) && typeof fields[name] === "string" ? fields[name] as string : "");
  if (node.showIf !== undefined && !value(node.showIf)) return false;
  if (node.type === "box" || node.type === "link") return true;
  if (node.type === "image") return node.bind !== undefined ? Boolean(value(node.bind)) : typeof node.src === "string" && node.src.length > 0;
  if (node.type !== "text") return false;
  if (node.bind !== undefined) return Boolean(value(node.bind));
  return typeof node.text === "string" && node.text.replace(/\{([A-Za-z0-9_]+)\}/g, (_all, name: string) => value(name)).length > 0;
}

/**
 * A PSP-1 design with each flexible gap in a row turned into `spacerBefore`
 * on the next item the SDK draws for this ad: the same layout, PSP-1's own
 * way to push an item to the end. Gravity's Swift SDK (1.2.2) draws an empty
 * `grow` box as a frame that splits the row with the text beside it, so a
 * brand name wraps on a phone; it draws `spacerBefore` as a spacer. A gap
 * with nothing drawn after it, or a second gap before the same item, stays as
 * it is. Remove once the SDK is fixed.
 */
function withRowSpacers(node: unknown, draws: (node: Record<string, unknown>) => boolean): unknown {
  if (!isObject(node) || !Array.isArray(node.children)) return node;
  const inRow = !isObject(node.style) || node.style.direction !== "column";
  const children = node.children.map((child) => (inRow && isGrowGap(child) ? child : withRowSpacers(child, draws)));
  if (!inRow) return { ...node, children };
  const spaced = new Set<number>();
  const kept = new Set<number>();
  children.forEach((child, index) => {
    if (!isGrowGap(child)) return;
    const next = children.findIndex((item, at) => at > index && isObject(item) && !isGrowGap(item) && draws(item));
    if (next < 0 || spaced.has(next)) kept.add(index);
    else spaced.add(next);
  });
  return {
    ...node,
    children: children.flatMap((child, index) => {
      if (isGrowGap(child)) return kept.has(index) ? [child] : [];
      if (!spaced.has(index) || !isObject(child)) return [child];
      return [{ ...child, style: { ...(isObject(child.style) ? child.style : {}), spacerBefore: true } }];
    }),
  };
}

const FAVICON_MAX_BYTES = 24_000;
const FAVICON_TIMEOUT_MS = 1_500;
const FAVICON_TYPES = /^image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon)$/;

/**
 * The ad's icon as a `data:` image, for Gravity's web renderer: the desktop
 * app's page loads images only from hosts it lists (`rendererCsp.ts`), and an
 * advertiser's icon can be on any host. Null when it can't be read quickly
 * or isn't a small raster image; the design then draws without it.
 */
async function inlineFavicon(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FAVICON_TIMEOUT_MS),
      cf: { cacheTtl: 86_400, cacheEverything: true },
    } as RequestInit);
    const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!response.ok || !FAVICON_TYPES.test(type) || !response.body) return null;
    if (Number(response.headers.get("content-length") ?? 0) > FAVICON_MAX_BYTES) {
      await response.body.cancel();
      return null;
    }
    // Read only up to the cap: the advertiser's host decides how much it sends.
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > FAVICON_MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    if (!size) return null;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `data:${type};base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}

/* ---- Routes ---- */

/** `/cloud/sponsored/*`, or null for any other path. */
export async function routeSponsored(request: Request, path: string, env: GravityEnv, userId: string, now: number, waitUntil?: CloudWaitUntil): Promise<Response | null> {
  if (path === CLOUD_PATHS.sponsoredConsent) return request.method === "PUT" ? handleConsent(request, env, userId, now, waitUntil) : notFound();
  if (path === CLOUD_PATHS.sponsoredSeen) return request.method === "POST" ? handleSeen(request, env, userId, now, waitUntil) : notFound();
  if (path === CLOUD_PATHS.sponsoredAd) return request.method === "POST" ? handleAd(request, env, userId, now) : notFound();
  if (path === CLOUD_PATHS.sponsoredIndex) return request.method === "POST" ? handleIndex(request, env, userId, now) : notFound();
  if (path === CLOUD_PATHS.sponsoredHide) return request.method === "POST" ? handleHide(request, env, userId, now) : notFound();
  return null;
}

const notFound = () => fail("not_found", "That ADE Cloud route doesn't exist.", 404);

/**
 * The account's answer, on every machine. A yes keeps the SHA-256 of the
 * account's email now (Gravity's `hashed_email`); a no, or a later no, keeps
 * nothing of it. Allowed while the switch reaches the account, so the answer
 * can be changed back in Settings on any plan. `notice` is the yes saved when
 * the person was told cards are on, only where they start on
 * (`startsOnFor`), and never over an answer that still holds: of two screens,
 * the person's own yes or no wins.
 */
async function handleConsent(request: Request, env: GravityEnv, userId: string, now: number, waitUntil?: CloudWaitUntil): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const choice = CLOUD_SPONSORED_CHOICES.find((entry) => entry === body.consent);
  if (!choice) return badRequest("Say granted, declined or notice.");
  const account = await loadAccount(env, userId, now);
  const switches = await gravitySwitches(env);
  if ((await blockedReason(env, account, null, switches)) === "off") return notFound();
  const who = sponsoredRequester(request);
  const consent: CloudSponsoredConsent = choice === "declined" ? "declined" : "granted";
  // A yes keeps Free's Small unlimited, for cards Gravity shows only in its
  // countries: from anywhere else it is refused (a tester's test ads aside).
  if (consent === "granted" && (await outsideCountries(env, account, who.country, switches))) {
    return fail("unavailable", "Sponsored cards aren't shown in your country yet, so they can't be turned on.", 403);
  }
  const answered = async () => json((await sponsoredAccountState(env, account, who, now)) ?? { ads: false, consent: null, test: !switches.live });
  let before: ConsentRow | null = null;
  if (choice === "granted") {
    before = await honorGpc(env, account, await readConsent(env, userId), who, now);
    if (body.confirmed !== true && yesNeedsConfirm(before, await shownAnswer(env, before, who, now), who)) {
      return fail("sponsored_confirm", "Turning sponsored cards back on takes a second confirm. Try again, or update ADE if it doesn't ask.", 409);
    }
  }
  if (choice === "notice") {
    if (!startsOnFor(env, who)) return fail("unavailable", "Sponsored cards don't start on where you are, so ADE asks first.", 409);
    before = await readConsent(env, userId);
    // An answer that holds, or any no (even one run out), stands: the person is asked, never told.
    if (!startsOnNow(env, before, await shownAnswer(env, before, who, now), who)) return answered();
  }
  let emailHash: string | null = null;
  if (consent === "granted") {
    const email = await readClerkUser(env, userId).then((user) => user?.email ?? null).catch((error: unknown) => {
      // The yes still counts; Gravity just gets no hashed email for this account.
      reportCloudFailure("cloud.sponsored.email_read_failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    });
    emailHash = email ? await sha256Hex(email.trim().toLowerCase()) : null;
  }
  // A yes (a notice's, or the person's own) saves only over the row it read: a no saved meanwhile,
  // say on another screen while the email was read, holds. With no row read, any answer saved
  // meanwhile holds. A no always saves.
  const guard = consent === "declined" ? "" : before ? " where cloud_sponsored_consent.decided_at = ?" : " where 0";
  // A yes from the US makes Small free from now, like a look, and keeps the network it came from
  // (Free Small's tripwire). Over a yes, the later of this and the row's look when it is written holds
  // (a trip's, or one saved while the email was read), with its network: never moved back. A no keeps neither.
  const lookedAt = consent === "granted" && smallFreeFrom(who.country) ? now : null;
  const lookedAsn = lookedAt == null ? null : requestNetwork(request);
  const heldLook = "case when cloud_sponsored_consent.consent = 'granted' then coalesce(cloud_sponsored_consent.looked_at, 0) else 0 end";
  const write = env.DB.prepare(`
    insert into cloud_sponsored_consent (user_id, consent, email_hash, decided_at, source, country, gpc, looked_at, looked_asn) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict (user_id) do update set consent = excluded.consent, email_hash = excluded.email_hash, decided_at = excluded.decided_at,
      source = excluded.source, country = excluded.country, gpc = excluded.gpc,
      looked_at = case when excluded.consent = 'granted' then nullif(max(coalesce(excluded.looked_at, 0), ${heldLook}), 0) end,
      looked_asn = case when excluded.consent = 'granted' then
        case when coalesce(excluded.looked_at, 0) >= ${heldLook} then excluded.looked_asn else cloud_sponsored_consent.looked_asn end end${guard}
  `).bind(
    userId, consent, emailHash, now, choice === "notice" ? "notice" : "answer", who.country,
    // A yes from a browser that sends Global Privacy Control, past the second confirm: it holds there.
    choice === "granted" && gpcOptsOut(who) ? 1 : 0,
    lookedAt, lookedAsn,
    ...(guard && before ? [before.decided_at] : []),
  );
  // A no keeps nothing of where the person watched from: their address and device go too, in the same transaction.
  const [saved] = consent === "declined" ? await env.DB.batch([write, clearViewers(env, userId)]) : [await write.run()];
  // Lost to an answer saved meanwhile: that one holds, and the state says so.
  if (!saved?.meta?.changes) return answered();
  logCloud("cloud.sponsored.consent", { consent: choice });
  // Small's rate follows the answer at once (`smallUsesNoHours`).
  await syncSmallRates(env, account, now);
  // A yes from the US restarts Small's week, so a script could send yeses instead of looks: the same tripwire.
  if (lookedAt != null) await smallLookTripwire(env, account, lookedAsn, now, waitUntil);
  return answered();
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
async function handleSeen(request: Request, env: GravityEnv, userId: string, now: number, waitUntil?: CloudWaitUntil): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const device = readDevice(body.device);
  if (!device) return badRequest("Say which device this is.");
  const account = await loadAccount(env, userId, now);
  const who = sponsoredRequester(request);
  const country = who.country;
  const blocked = await blockedReason(env, account, country);
  const read = await readConsent(env, userId);
  // A browser's Global Privacy Control from the US opts the whole account out (cards stop on every device).
  const consent = blocked === "off" ? read : await honorGpc(env, account, read, who, now);
  if (blocked || !yesHolds(env, consent, who)) {
    // The latest look doesn't allow cards (the person travelled, or their browser now sends Global
    // Privacy Control): no earlier look, on any of their computers, lets the Index answer its agents.
    // (Without a yes there are no rows to clear.)
    if (consent?.consent === "granted") await clearViewers(env, userId).run();
    return json({ ok: false });
  }
  const computer = await ownCloudComputer(env, userId, body.instanceId);
  if (!computer) return json({ ok: false });
  // Written only while the answer is still yes, in the same statement: a "no" that lands meanwhile wins.
  await env.DB.prepare(`
    insert into cloud_sponsored_viewers (user_id, instance_id, ip, ua, device_type, os, os_version, tracking, country, region, seen_at)
    select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    where exists (select 1 from cloud_sponsored_consent where user_id = ? and consent = 'granted')
    on conflict (user_id, instance_id) do update set ip = excluded.ip, ua = excluded.ua, device_type = excluded.device_type,
      os = excluded.os, os_version = excluded.os_version, tracking = excluded.tracking, country = excluded.country,
      region = excluded.region, seen_at = excluded.seen_at
  `).bind(userId, computer.instance_id, clientIp(request), clientUa(request, device), device.type, device.os, device.osVersion ?? null, device.tracking ?? null, country, who.region, now, userId).run();
  // From the US, the look keeps Free's Small free (`sponsoredSmall.ts`); its network feeds the tripwire.
  await noteSmallLook(env, account, consent, country, requestNetwork(request), now, waitUntil);
  return json({ ok: true });
}

/** A reply's ask is being answered: the row is claimed, Gravity's answer not in yet. */
const PENDING_TURN = "pending";

/**
 * The reply's saved answer. One asked for another placement (the reply opened
 * on another surface, the format changed, or it was saved before placements
 * were) is no card here: its tracking links count for that placement, and
 * the inline length limit may not hold.
 */
async function readTurn(env: GravityEnv, userId: string, chatId: string, turnId: string, placementId: string, now: number): Promise<CloudSponsoredAdAnswer | null> {
  const row = await env.DB.prepare("select ad_json, reason, created_at, placement_id from cloud_sponsored_turns where user_id = ? and chat_id = ? and turn_id = ?")
    .bind(userId, chatId, turnId).first<{ ad_json: string | null; reason: string | null; created_at: number; placement_id: string | null }>();
  if (!row || now - row.created_at > TURN_TTL_MS) return null;
  if (row.placement_id !== placementId) return { ad: null, reason: "no_fill" };
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
async function claimTurn(env: GravityEnv, userId: string, chatId: string, turnId: string, format: CloudSponsoredFormat, placementId: string, now: number): Promise<boolean> {
  const [, claim] = await env.DB.batch([
    env.DB.prepare("delete from cloud_sponsored_turns where created_at < ?").bind(now - TURN_TTL_MS),
    env.DB.prepare(`
      insert into cloud_sponsored_turns (user_id, chat_id, turn_id, ad_json, reason, created_at, format, placement_id) values (?, ?, ?, null, ?, ?, ?, ?)
      on conflict (user_id, chat_id, turn_id) do nothing
    `).bind(userId, chatId, turnId, PENDING_TURN, now, format, placementId),
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
  const switches = await gravitySwitches(env);
  const who = sponsoredRequester(request);
  const blocked = await blockedReason(env, account, who.country, switches);
  if (blocked) return none(blocked);
  // A browser's Global Privacy Control from the US opts the whole account out, not just this card.
  const consent = await honorGpc(env, account, await readConsent(env, userId), who, now);
  if (!yesHolds(env, consent, who)) return none("consent");
  // Only a chat on one of the account's own ADE Cloud computers: never one on the person's own machine.
  const computer = await ownCloudComputer(env, userId, body.instanceId);
  if (!computer) return none("not_cloud");
  // And the chat itself runs there: that computer saved a copy of it after a
  // turn (`chats.ts`), and it is a person's chat, not a subagent's. Never
  // stored, so the first reply's ask may come again once its copy is saved.
  const copy = await env.DB.prepare("select parent_chat_id from cloud_chat_copies where user_id = ? and chat_id = ? and instance_id = ? limit 1")
    .bind(userId, chatId, computer.instance_id).first<{ parent_chat_id: string | null }>();
  if (!copy || copy.parent_chat_id) return none("not_cloud");
  const format = isSponsoredFormat(body.format) ? body.format : "below_reply";
  // The inline format is ADE's own linked sentence at the reply's end, never a
  // card, so it never asks for Gravity's design.
  const renderer = format === "inline" ? null : CLOUD_SPONSORED_RENDERERS.find((entry) => entry === body.renderer) ?? null;
  const slot = PLACEMENTS[format];
  const placementId = `ade-${surfaceOf(body.surface, device)}-${slot.slug}`;
  // One request per finished reply: a second ask (a reload, a second screen) reads the first answer.
  const stored = await readTurn(env, userId, chatId, turnId, placementId, now);
  // A real ad saved before ads went back to test ads still keeps to the countries, tester or not.
  if (stored?.ad && !stored.ad.test && outsideCountryList(env, who.country)) return none("country");
  if (stored) return json(stored);
  const messages = readMessages(body.messages, 2);
  if (!messages.length) return none("no_fill");
  if (!(await claimTurn(env, userId, chatId, turnId, format, placementId, now))) return none("no_fill");
  if (!(await reserveRequest(env, now, userId, "ad", switches))) {
    await releaseTurn(env, userId, chatId, turnId);
    return none("limit");
  }

  const live = switches.live;
  const ip = clientIp(request);
  // The A/B test's counts: requests, fills and hides per format.
  // A failed count never holds the reply's claim: the ad is asked for all the same.
  await count(env, now, userId, [`ad_request:${format}`]).catch(() => reportCloudFailure("cloud.sponsored.count_failed", {}));
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
    [{
      placement: slot.placement,
      placement_id: placementId,
      ...(slot.maxChars ? { max_ad_text_chars: slot.maxChars } : {}),
      // No data units or image layouts: their pictures come from the
      // advertiser's own hosts, which ADE's pages don't load, and the Swift
      // SDK draws neither. Left out as Gravity's Swift SDK leaves it out (the
      // web SDK would otherwise declare them), so the engine sends its design.
      capabilities: undefined,
    }],
    // Gravity's design only for a client that draws it with Gravity's renderer
    // (`renderer`); never a frame, which no ADE client hosts.
    {
      apiKey: env.GRAVITY_API_KEY,
      production: live,
      supportsSpec: renderer !== null,
      ...(renderer ? { specCapabilities: renderer } : {}),
      enableFrames: false,
      timeoutMs: REQUEST_TIMEOUT_MS,
    },
  ).catch(() => null);
  if (!result || (result.status !== 200 && result.status !== 204 && result.status !== 202)) {
    // Gravity's answer is never an error for the person: no card, and the owner hears of it.
    reportCloudFailure("cloud.sponsored.ad_failed", { status: result?.status ?? 0 });
    await releaseTurn(env, userId, chatId, turnId);
    return none("unavailable");
  }
  const ad = adOfGravity(result.ads[0], !live, renderer);
  if (ad?.gravity?.favicon && renderer === "web1") {
    const inlined = await inlineFavicon(ad.gravity.favicon);
    if (inlined) ad.gravity.favicon = inlined;
    else delete ad.gravity.favicon;
  }
  const answer: CloudSponsoredAdAnswer = ad ? { ad } : { ad: null, reason: "no_fill" };
  if (ad) await count(env, now, userId, ["ad_fill", `ad_fill:${format}`]);
  await saveTurn(env, userId, chatId, turnId, answer);
  return json(answer);
}

/**
 * The person hid a reply's card: counted once per reply, under the format it
 * was asked in, for the A/B test. Only a reply that got a card counts; the
 * answer is always a 200, and nothing is kept but the count.
 */
async function handleHide(request: Request, env: GravityEnv, userId: string, now: number): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const chatId = shortString(body.chatId, 160);
  const turnId = shortString(body.turnId, 160);
  if (!chatId || !ROW_ID.test(chatId) || !turnId || !ROW_ID.test(turnId)) return badRequest("Name the chat and its reply.");
  // The counts and the reply's mark in one transaction: a hide is counted exactly when it is marked.
  const unhidden = "user_id = ? and chat_id = ? and turn_id = ? and ad_json is not null and hidden_at is null and created_at >= ?";
  const since = now - TURN_TTL_MS;
  const countHide = (who: string) => env.DB.prepare(`
    insert into cloud_sponsored_days (day, user_id, kind, count)
    select ?, ?, 'ad_hide:' || coalesce(format, 'below_reply'), 1 from cloud_sponsored_turns where ${unhidden}
    on conflict (day, user_id, kind) do update set count = count + 1
  `).bind(utcDay(now), who, userId, chatId, turnId, since);
  const results = await env.DB.batch([
    countHide(userId),
    countHide(ALL),
    env.DB.prepare(`update cloud_sponsored_turns set hidden_at = ? where ${unhidden}`).bind(now, userId, chatId, turnId, since),
  ]);
  return json({ ok: true, counted: (results[2]?.meta?.changes ?? 0) > 0 });
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
    .bind(userId, computer.instance_id).first<{ ip: string | null; ua: string | null; os: string; tracking: string | null; country: string | null; region: string | null; seen_at: number }>();
  // The country is the person's, from their last look at the chat: the agent's computer is not where they are.
  const switches = await gravitySwitches(env);
  const blocked = await blockedReason(env, account, viewer?.country ?? null, switches);
  if (blocked) return none(blocked);
  // Gravity's Index has no test mode, so before go-live only the testers' searches reach it,
  // and a tester abroad gets none: its picks are real recommendations.
  if (!switches.live && switches.mode !== "testers") return none("off");
  if (outsideCountryList(env, viewer?.country ?? null)) return none("country");
  const consent = await readConsent(env, userId);
  // The person's country, state and browser are those of their last look at the chat (a viewer row exists only after a yes that held there).
  if (!yesHolds(env, consent, { country: viewer?.country ?? null, region: viewer?.region ?? null, gpc: false })) return none("consent");
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
  if (!(await reserveRequest(env, now, userId, "index", switches))) return none("limit");
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

/* ---- The formats' A/B test ---- */

const FORMAT_WORDS: Record<CloudSponsoredFormat, string> = { below_reply: "under the reply", inline: "inline", above_prompt: "above the prompt box" };

/** Which format one of Gravity's placement rows is, by its id (`ade-<surface>-<slug>`) or its type. */
function formatOfPlacement(entry: Record<string, unknown>): CloudSponsoredFormat | null {
  const key = String(entry.placement_id ?? entry.slug ?? entry.placement ?? "");
  for (const [format, slot] of Object.entries(PLACEMENTS) as [CloudSponsoredFormat, (typeof PLACEMENTS)[CloudSponsoredFormat]][]) {
    if (key === slot.placement || key.endsWith(`-${slot.slug}`)) return format;
  }
  return null;
}

/**
 * The A/B scoreboard for the last `days` UTC days: each format's accounts
 * (its arm of the split, and their answers), ADE's own counts (card requests,
 * cards filled, cards hidden), and Gravity's per-placement report (views,
 * clicks, revenue), which pays on its own numbers. Gravity's part is null
 * when its report can't be read.
 */
export async function sponsoredAbReport(env: GravityEnv, now: number, days: number) {
  const settings = await readCloudSettings(env);
  const since = utcDay(now - (days - 1) * 24 * 60 * 60_000);
  const [counts, arms] = await Promise.all([
    env.DB.prepare("select kind, sum(count) as total from cloud_sponsored_days where user_id = ? and day >= ? and kind like 'ad_%:%' group by kind")
      .bind(ALL, since).all<{ kind: string; total: number }>(),
    env.DB.prepare(`
      select f.format, f.source, count(*) as accounts,
        coalesce(sum(c.consent = 'granted'), 0) as granted,
        -- A no a browser's Global Privacy Control made is no answer to the card's format.
        coalesce(sum(c.consent = 'declined' and c.source != 'gpc'), 0) as declined
      from cloud_sponsored_formats f left join cloud_sponsored_consent c on c.user_id = f.user_id
      group by f.format, f.source
    `).all<{ format: string; source: string; accounts: number; granted: number; declined: number }>(),
  ]);
  const total = new Map((counts.results ?? []).map((row) => [row.kind, row.total]));
  let gravity: Record<string, unknown>[] | null = null;
  if (env.GRAVITY_API_KEY?.trim()) {
    gravity = await fetch(`${PLATFORM_URL}/publisher-dashboard/placements?days=${days}`, {
      headers: { "x-api-key": env.GRAVITY_API_KEY.trim(), accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    }).then(async (response) => {
      const body = response.ok ? await response.json() as { placements?: unknown } : null;
      return Array.isArray(body?.placements) ? body.placements as Record<string, unknown>[] : null;
    }).catch(() => null);
  }
  const weights = settings.gravity_format_split.split("-").map(Number);
  const ratio = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 1000 : null);
  return {
    format: settings.gravity_format,
    split: settings.gravity_format_split,
    days,
    since,
    gravityReadable: gravity != null,
    arms: SPLIT_ARMS.map((format, index) => {
      const arm = (arms.results ?? []).filter((row) => row.format === format);
      const inTest = arm.find((row) => row.source === "split");
      const requests = total.get(`ad_request:${format}`) ?? 0;
      const fills = total.get(`ad_fill:${format}`) ?? 0;
      const hides = total.get(`ad_hide:${format}`) ?? 0;
      const placements = gravity?.filter((entry) => formatOfPlacement(entry) === format) ?? null;
      const sum = (field: string) => (placements ?? []).reduce((acc, entry) => acc + (typeof entry[field] === "number" ? entry[field] as number : 0), 0);
      const impressions = sum("impressions");
      const clicks = sum("clicks");
      return {
        format,
        name: FORMAT_WORDS[format],
        weight: weights[index] ?? 0,
        accounts: inTest?.accounts ?? 0,
        granted: inTest?.granted ?? 0,
        declined: inTest?.declined ?? 0,
        ownerSet: arm.find((row) => row.source === "owner")?.accounts ?? 0,
        requests,
        fills,
        fillRate: ratio(fills, requests),
        hides,
        hidesPerCard: ratio(hides, fills),
        gravity: placements ? { impressions, clicks, ctr: ratio(clicks, impressions), revenue: Math.round(sum("revenue") * 100) / 100 } : null,
      };
    }),
  };
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
  const { mode, live } = await gravitySwitches(env);
  if (mode === "off" && rows.length === 0) return [];
  const n = (kind: string) => counts.get(kind) ?? 0;
  const lines = [
    `Sponsored (${mode}${live ? ", live" : ", test ads"}): ${n("ad_request")} ad requests, ${n("ad_fill")} filled; ${n("index_request")} Index searches, ${n("index_pick")} picks.`,
  ];
  const byFormat = SPLIT_ARMS.filter((format) => n(`ad_request:${format}`) + n(`ad_fill:${format}`) + n(`ad_hide:${format}`) > 0)
    .map((format) => `${FORMAT_WORDS[format]} ${n(`ad_request:${format}`)} asked, ${n(`ad_fill:${format}`)} filled, ${n(`ad_hide:${format}`)} hidden`);
  if (byFormat.length) lines.push(`Formats (${(await readCloudSettings(env)).gravity_format}): ${byFormat.join("; ")}.`);
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
