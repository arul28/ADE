import type { CloudWaitUntil } from "./analytics";
import { adContextFor, cloudNetworkOf, computerRatesMilli, countAdProof, noteCloudNetworkProof, noteUnverified } from "./adPrice";
import type { CloudAdProofAnswer } from "./contract";
import { blockedReason, freeModelAdGate, honorGpc, ownCloudComputer, ownLivePhone, type GravityEnv } from "./gravity";
import { ROW_ID, UNREADABLE_REQUEST_MESSAGE, badRequest, fail, json, readJson, shortString } from "./http";
import { utcDay, type CloudSize } from "./plans";
import { readCloudSettings } from "./settings";
import { readConsent, requestNetwork, sponsoredRequester, yesHolds } from "./sponsoredConsent";
import { adTerms, pricingV3Mode, pricingV3Reaches } from "./sponsoredSwitch";
import { loadAccount, reportCloudFailure, type AccountRow, type ComputerRow } from "./store";

// Pricing v3's proof from a person's message (`adPrice.ts` has the price):
// `POST /cloud/sponsored/sent`, and a message that wakes a computer at 0
// credits (`routes.ts`). A proof is the app's word: the server never sees a
// cloud chat's messages. What bounds it: one proof per (account, chat,
// message); only the account's own computer or live phone; nothing from the
// network of the account's own cloud computers; and a chat no computer saved
// yet holds the price with ads only briefly, a few times a day.

/** A proof for a chat with no saved copy holds the price with ads this long, not the whole window. */
export const UNSAVED_CHAT_WINDOW_MS = 10 * 60_000;
/** How many proofs for chats with no saved copy one computer takes a UTC day (a phone: one session's 120 minutes). */
export const UNSAVED_CHAT_PROOFS_A_DAY = { computer: 6, phone: 12 } as const;

const notFound = () => fail("not_found", "That DAEX Cloud route doesn't exist.", 404);

/**
 * `POST /sent` is sent with every message on every device: the setting read
 * is kept in the isolate for a few seconds, so a caller Pricing v3 doesn't
 * reach costs one tester check at most, and nothing at `off`.
 */
let sentModeCache: { at: number; mode: Awaited<ReturnType<typeof pricingV3Mode>> } | null = null;
const SENT_MODE_CACHE_MS = 15_000;
async function v3ForSent(env: GravityEnv, userId: string, now: number): Promise<boolean> {
  if (!sentModeCache || now - sentModeCache.at > SENT_MODE_CACHE_MS || now < sentModeCache.at) sentModeCache = { at: now, mode: await pricingV3Mode(env) };
  return pricingV3Reaches(env, userId, sentModeCache.mode);
}

/**
 * Where a chat's saved copies are for one computer: `here` (a person's chat
 * it saved), `unsaved` (no copy anywhere yet: a first message, or a chat the
 * server has never seen), or `elsewhere` (another computer's, or a
 * subagent's). With no computer, `here` means saved on any of them.
 */
async function chatPlace(env: GravityEnv, userId: string, chatId: string, instanceId: string | null): Promise<"here" | "unsaved" | "elsewhere"> {
  const copies = await env.DB.prepare(`
    select count(*) as total, coalesce(max(parent_chat_id is not null), 0) as child, coalesce(max(? is null or instance_id = ?), 0) as here
    from cloud_chat_copies where user_id = ? and chat_id = ?
  `).bind(instanceId, instanceId, userId, chatId).first<{ total: number; child: number; here: number }>();
  if (!copies || copies.total === 0) return "unsaved";
  return copies.here && !copies.child ? "here" : "elsewhere";
}

/** Proofs for unsaved chats this target took today (`turn_id` `new:<message>`). */
async function unsavedProofsToday(env: GravityEnv, userId: string, target: { instanceId: string | null; phoneId: string | null }, now: number): Promise<number> {
  const dayStart = Date.parse(`${utcDay(now)}T00:00:00Z`);
  const column = target.instanceId ? "instance_id" : "phone_id";
  const row = await env.DB.prepare(`select count(*) as n from cloud_ad_proofs where user_id = ? and ${column} = ? and turn_id like 'new:%' and at >= ?`)
    .bind(userId, target.instanceId ?? target.phoneId, dayStart).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * One person's message as a proof for the computer its chat runs on and the
 * live phone it holds. Ads must hold here (a yes, the notice seen, a country
 * with ads), except in an DAEX Free Models chat, whose ad shows with ads off:
 * its proof counts only for a computer that saved the chat. A chat no
 * computer saved yet opens a short window, a few times a day.
 */
async function proveSent(
  env: GravityEnv,
  request: Request,
  account: AccountRow,
  input: { instanceId: unknown; phoneId: unknown; chatId: string; messageId: string },
  now: number,
  waitUntil?: CloudWaitUntil,
): Promise<CloudAdProofAnswer> {
  const refused = (reason: CloudAdProofAnswer["reason"]): CloudAdProofAnswer => ({ counted: false, reason });
  const userId = account.user_id;
  const who = sponsoredRequester(request);
  const free = await freeModelAdGate(env, userId, input.chatId, who, now);
  const freeModel = free != null && !("reason" in free);
  if (!freeModel) {
    const blocked = await blockedReason(env, account, who.country, undefined, true);
    if (blocked === "country") return refused("no_ads_here");
    if (blocked) return refused("ads_off");
    const consent = await honorGpc(env, account, await readConsent(env, userId), who, now);
    if (!yesHolds(env, consent, who) || consent.notice_seen_at == null) return refused("ads_off");
  }
  const computer = await ownCloudComputer(env, userId, input.instanceId);
  const place = computer ? await chatPlace(env, userId, input.chatId, computer.instance_id) : null;
  const instanceId = computer && (place === "here" || (place === "unsaved" && !freeModel)) ? computer.instance_id : null;
  const phoneId = await ownLivePhone(env, userId, input.phoneId);
  if (!instanceId && !phoneId) return refused("not_cloud");
  const targets = { instanceId, phoneId };
  const asn = requestNetwork(request);
  const network = await cloudNetworkOf(env, userId, asn, now);
  if (network === "own") {
    await noteUnverified(env, account, targets, asn, now, waitUntil);
    return refused("unverified");
  }
  if (network === "cloud") await noteCloudNetworkProof(env, account, asn, now, waitUntil);
  const saved = instanceId ? place === "here" : (await chatPlace(env, userId, input.chatId, null)) === "here";
  if (await messageCounted(env, userId, input.messageId)) return refused("repeat");
  if (saved) return countAdProof(env, account, { chatId: input.chatId, turnId: `msg:${input.messageId}`, kind: "sent", freeModel, ...targets }, now);
  const cap = instanceId ? UNSAVED_CHAT_PROOFS_A_DAY.computer : UNSAVED_CHAT_PROOFS_A_DAY.phone;
  if ((await unsavedProofsToday(env, userId, targets, now)) >= cap) return refused("not_cloud");
  // Kept as a proof whose window ends in a few minutes (never past the whole window's).
  const windowMs = adTerms(await readCloudSettings(env)).windowMinutes * 60_000;
  const targetAt = Math.min(now, now - windowMs + UNSAVED_CHAT_WINDOW_MS);
  return countAdProof(env, account, { chatId: input.chatId, turnId: `new:${input.messageId}`, kind: "sent", freeModel, targetAt, ...targets }, now);
}

/**
 * Pricing v3: a person sent a message in a chat that uses DAEX Cloud (a chat on
 * one of the account's cloud computers, or one that holds its cloud iPhone).
 * The proof restarts that computer's or phone's ad window (`adPrice.ts`). Not
 * found while Pricing v3 doesn't reach the account: apps send it only while
 * the account state has `pricing`.
 */
export async function handleSent(request: Request, env: GravityEnv, userId: string, now: number, waitUntil?: CloudWaitUntil): Promise<Response> {
  if (!(await v3ForSent(env, userId, now))) return notFound();
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const ids = proofIds(body.chatId, body.messageId);
  if (!ids) return badRequest("Name the chat and the message.");
  const account = await loadAccount(env, userId, now);
  return json(await proveSent(env, request, account, { instanceId: body.instanceId, phoneId: body.phoneId, ...ids }, now, waitUntil));
}

/**
 * One message counts once, whatever chat id it came under: a chat saved after
 * it came (`new:` then `msg:`), or a new lane's first message, counted at its
 * launch under the launch id, then sent again by the app under its chat's.
 */
async function messageCounted(env: GravityEnv, userId: string, messageId: string): Promise<boolean> {
  const hit = await env.DB.prepare("select 1 as hit from cloud_ad_proofs where user_id = ? and turn_id in (?, ?) limit 1")
    .bind(userId, `msg:${messageId}`, `new:${messageId}`).first<{ hit: number }>();
  return hit != null;
}

/** A person's first message that makes a new computer (`routes.ts` `createComputer`): its proof, before the computer exists. */
export type FirstMessageProof = { request: Request; chatId: string; messageId: string };

/**
 * Pricing v3: the rate a new computer of `size` starts at when `proof` (a
 * person's first message: a launch's, or an app's create with `adProof`) will
 * count for it: its ad rate. Null when it won't (Pricing v3 or ads not
 * reaching the account, ads off, no ads here, the network of the account's own
 * computers, a message already counted), so the create checks hours at the
 * full rate as before. Never fails the create.
 */
export async function firstMessageRate(env: GravityEnv, account: AccountRow, size: CloudSize, proof: FirstMessageProof, now: number, waitUntil?: CloudWaitUntil): Promise<number | null> {
  try {
    const settings = await readCloudSettings(env);
    if ((await pricingV3Mode(env, settings)) === "off") return null;
    const { ctx } = await adContextFor(env, account);
    if (!ctx.v3) return null;
    const who = sponsoredRequester(proof.request);
    if (await blockedReason(env, account, who.country, undefined, true)) return null;
    const consent = await honorGpc(env, account, await readConsent(env, account.user_id), who, now);
    if (!yesHolds(env, consent, who) || consent.notice_seen_at == null) return null;
    if (await messageCounted(env, account.user_id, proof.messageId)) return null;
    const asn = requestNetwork(proof.request);
    const network = await cloudNetworkOf(env, account.user_id, asn, now);
    if (network === "own") {
      await noteUnverified(env, account, { instanceId: null, phoneId: null }, asn, now, waitUntil);
      return null;
    }
    if (network === "cloud") await noteCloudNetworkProof(env, account, asn, now, waitUntil);
    return computerRatesMilli({ type: size.type, cpu: size.cpu, memory_gb: size.memoryGb, multiplier_milli: size.multiplierMilli, ad_full_milli: null }, ctx).adMilli;
  } catch (error) {
    reportCloudFailure("cloud.ad_price.first_message_failed", { message: error instanceof Error ? error.message : "unknown" });
    return null;
  }
}

/**
 * The new computer was made: `proof` counts for it, for the whole window (the
 * server holds the message, so no short window for a chat it never saw), and
 * it goes to the price with ads from its first minute. Never fails the create.
 */
export async function proveFirstMessage(env: GravityEnv, account: AccountRow, instanceId: string, proof: FirstMessageProof, now: number): Promise<void> {
  try {
    await countAdProof(env, account, { chatId: proof.chatId, turnId: `msg:${proof.messageId}`, kind: "sent", freeModel: false, instanceId, phoneId: null }, now);
  } catch (error) {
    reportCloudFailure("cloud.ad_price.first_message_failed", { message: error instanceof Error ? error.message : "unknown" });
  }
}

export const proofIds = (chatValue: unknown, messageValue: unknown): { chatId: string; messageId: string } | null => {
  const chatId = shortString(chatValue, 160);
  const messageId = shortString(messageValue, 150);
  return chatId && ROW_ID.test(chatId) && messageId && ROW_ID.test(messageId) ? { chatId, messageId } : null;
};

/**
 * A person's message that wakes `computer` while the account has no credits
 * (`routes.ts`: `/start` with `adProof`, and the chat queue): counted first as
 * that message's proof, so a Small on Free with ads on wakes at the price with
 * ads. The caller checks the wake again after. Never fails the wake.
 */
export async function proveWakeMessage(env: GravityEnv, request: Request, account: AccountRow, computer: Pick<ComputerRow, "instance_id">, chatValue: unknown, messageValue: unknown, now: number, waitUntil?: CloudWaitUntil): Promise<void> {
  const ids = proofIds(chatValue, messageValue);
  if (!ids) return;
  try {
    if (!(await pricingV3Reaches(env, account.user_id, await pricingV3Mode(env)))) return;
    await proveSent(env, request, account, { instanceId: computer.instance_id, phoneId: null, ...ids }, now, waitUntil);
  } catch (error) {
    reportCloudFailure("cloud.ad_price.wake_proof_failed", { message: error instanceof Error ? error.message : "unknown" });
  }
}
