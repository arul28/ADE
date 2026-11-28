import type { CloudSponsoredAd, CloudSponsoredAdAnswer, CloudSponsoredFormat, CloudSponsoredNoAdReason } from "./contract";
import type { GravityEnv } from "./gravity";
import { reportCloudFailure } from "./store";

// Each reply's card answer (`cloud_sponsored_turns`), kept a day so every
// screen that opens the reply shows the same card and Gravity is asked once.

/** How long a reply's answer is kept. */
export const TURN_TTL_MS = 24 * 60 * 60_000;

/** A reply's ask is being answered: the row is claimed, Gravity's answer not in yet. */
const PENDING_TURN = "pending";

/**
 * The reply's saved answer. One asked for another placement (the reply opened
 * on another surface, the format changed, or it was saved before placements
 * were) is no card here: its tracking links count for that placement, and
 * the inline length limit may not hold.
 */
export async function readTurn(env: GravityEnv, userId: string, chatId: string, turnId: string, placementId: string, now: number): Promise<CloudSponsoredAdAnswer | null> {
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
export async function claimTurn(env: GravityEnv, userId: string, chatId: string, turnId: string, format: CloudSponsoredFormat, placementId: string, now: number): Promise<boolean> {
  const [, claim] = await env.DB.batch([
    env.DB.prepare("delete from cloud_sponsored_turns where created_at < ?").bind(now - TURN_TTL_MS),
    env.DB.prepare(`
      insert into cloud_sponsored_turns (user_id, chat_id, turn_id, ad_json, reason, created_at, format, placement_id) values (?, ?, ?, null, ?, ?, ?, ?)
      on conflict (user_id, chat_id, turn_id) do nothing
    `).bind(userId, chatId, turnId, PENDING_TURN, now, format, placementId),
  ]);
  return (claim?.meta?.changes ?? 0) === 1;
}

export async function saveTurn(env: GravityEnv, userId: string, chatId: string, turnId: string, answer: CloudSponsoredAdAnswer): Promise<void> {
  await env.DB.prepare("update cloud_sponsored_turns set ad_json = ?, reason = ? where user_id = ? and chat_id = ? and turn_id = ?")
    .bind(answer.ad ? JSON.stringify(answer.ad) : null, answer.ad ? null : answer.reason ?? "no_fill", userId, chatId, turnId).run();
}

/** Gravity didn't answer: the claim goes, so a later ask for this reply may try again. */
export async function releaseTurn(env: GravityEnv, userId: string, chatId: string, turnId: string): Promise<void> {
  await env.DB.prepare("delete from cloud_sponsored_turns where user_id = ? and chat_id = ? and turn_id = ? and reason = ?")
    .bind(userId, chatId, turnId, PENDING_TURN).run();
}
