import type { CloudFreeModelsThrottle } from "./contract";
import type { CloudDb } from "./store";

// ADE Free Models' "no ads, no free tokens" rule. Gravity pays for these
// models through the cards in their chats, so an account that keeps calling
// them with no card asked for is slowed, then paused. Counted per account,
// never per chat: a script can make up a new chat id for every call.
//
// The card event is a card request (`gravity.ts` `handleAd`) for a finished
// reply in a chat these models served, once per reply, whatever Gravity
// answers (a card, a test card, or none to show). ADE's apps ask only while
// the card's spot is on screen in a window in front, so a person using them
// in the app resets the meter after every reply; the meter only fills where
// nobody asks for cards.
//
// The lines, by what a real reply costs: OpenCode makes one model call per
// step (a tool call and its answer), plus a short title call for each
// message. A usual reply is 5 to 40 calls; a long autonomous one, with
// OpenCode's own in-chat subagents, can reach 100 to 200 before it finishes
// and asks for its card. Each call sends the whole context again, up to the
// 128K window (OpenCode compacts near it), so a long reply is around 50K to
// 100K input tokens a call. Slowed at 200 calls or 16M input tokens: past
// two of the longest replies with no card between them. Paused at twice that.
// A chat's first reply starts from wherever the account's meter is, far under
// either line after any card request.

/**
 * A meter with no call going through for this long starts over by itself: a
 * paused chat can age out of the day its cards are counted in (`gravity.ts`
 * `freeModelAdGate`), and a pause must never hold an account for good. A
 * script still gets at most one stretch a day.
 */
export const METER_QUIET_RESET_MS = 24 * 60 * 60_000;

/** Calls, or input tokens, with no card request before the account is slowed. */
export const SLOW_AFTER_CALLS = 200;
export const SLOW_AFTER_INPUT_TOKENS = 16_000_000;
/** Calls, or input tokens, with no card request before the account is paused (`free_models_no_cards`). */
export const PAUSE_AFTER_CALLS = 400;
export const PAUSE_AFTER_INPUT_TOKENS = 32_000_000;

export type FreeModelMeter = { calls: number; input_tokens: number; slowed_at: number | null; paused_at: number | null; updated_at: number };

export async function readFreeModelMeter(env: CloudDb, userId: string): Promise<FreeModelMeter | null> {
  return env.DB.prepare("select calls, input_tokens, slowed_at, paused_at, updated_at from cloud_free_model_meters where user_id = ?")
    .bind(userId).first<FreeModelMeter>();
}

/** Where the meter puts the account now, or null while it runs normally. */
export function throttleOf(meter: Pick<FreeModelMeter, "calls" | "input_tokens" | "updated_at"> | null, now: number): CloudFreeModelsThrottle | null {
  if (!meter || now - meter.updated_at > METER_QUIET_RESET_MS) return null;
  if (meter.calls >= PAUSE_AFTER_CALLS || meter.input_tokens >= PAUSE_AFTER_INPUT_TOKENS) return "paused";
  if (meter.calls >= SLOW_AFTER_CALLS || meter.input_tokens >= SLOW_AFTER_INPUT_TOKENS) return "slowed";
  return null;
}

/** One model call that goes to Gravity; after a quiet day, the first of a new stretch. */
export function meterCallStatement(env: CloudDb, userId: string, now: number): D1PreparedStatement {
  const quiet = `cloud_free_model_meters.updated_at < ${now - METER_QUIET_RESET_MS}`;
  return env.DB.prepare(`
    insert into cloud_free_model_meters (user_id, calls, input_tokens, since_at, updated_at) values (?, 1, 0, ?, ?)
    on conflict (user_id) do update set calls = case when ${quiet} then 1 else calls + 1 end,
      input_tokens = case when ${quiet} then 0 else input_tokens end,
      since_at = case when ${quiet} then excluded.since_at else since_at end,
      slowed_at = case when ${quiet} then null else slowed_at end,
      paused_at = case when ${quiet} then null else paused_at end,
      updated_at = excluded.updated_at
  `).bind(userId, now, now);
}

/** A call's input tokens, once its usage is in. */
export function meterTokensStatement(env: CloudDb, userId: string, inputTokens: number, now: number): D1PreparedStatement {
  return env.DB.prepare("update cloud_free_model_meters set input_tokens = input_tokens + ?, updated_at = ? where user_id = ?")
    .bind(inputTokens, now, userId);
}

/** A card was asked for in a chat these models served: the meter starts over. */
export async function resetFreeModelMeter(env: CloudDb, userId: string, now: number): Promise<void> {
  await env.DB.prepare(`
    update cloud_free_model_meters set calls = 0, input_tokens = 0, since_at = ?, slowed_at = null, paused_at = null, updated_at = ?
    where user_id = ? and (calls > 0 or input_tokens > 0 or slowed_at is not null)
  `).bind(now, now, userId).run();
}

/**
 * Marks the stretch as slowed or paused the first time a call finds it so.
 * True when this call is the one that marked it (the owner's report counts it once).
 */
export async function markThrottle(env: CloudDb, userId: string, throttle: CloudFreeModelsThrottle, now: number): Promise<boolean> {
  const marked = await (throttle === "paused"
    ? env.DB.prepare("update cloud_free_model_meters set paused_at = ?, slowed_at = coalesce(slowed_at, ?) where user_id = ? and paused_at is null").bind(now, now, userId)
    : env.DB.prepare("update cloud_free_model_meters set slowed_at = ? where user_id = ? and slowed_at is null").bind(now, userId)
  ).run();
  return (marked.meta?.changes ?? 0) > 0;
}
