import type { AiSettingsStatus } from "../../../../shared/types";
import {
  BACKGROUND_UTILITY_CLAUDE_MODEL_ID,
  BACKGROUND_UTILITY_CODEX_MODEL_ID,
  BACKGROUND_UTILITY_CURSOR_MODEL_ID,
} from "../../../../shared/backgroundUtilityModel";
import { getModelById } from "../../../../shared/modelRegistry";

/**
 * The tour's "Send your first chat" step, for someone with no chats yet: a
 * new chat in the primary lane with a short question in the composer, on a
 * cheap model they can already run. They press Send; ADE never sends for them.
 */

export const FIRST_CHAT_PROMPT = "In one sentence, what is this project?";

/** The models ADE already uses for cheap background work, in the welcome card's provider order. */
const UTILITY_MODEL_IDS = [
  BACKGROUND_UTILITY_CLAUDE_MODEL_ID,
  BACKGROUND_UTILITY_CODEX_MODEL_ID,
  BACKGROUND_UTILITY_CURSOR_MODEL_ID,
] as const;

export type FirstChatModel = { id: string; label: string };

/**
 * A cheap model this machine can run now: one of ADE's background-utility
 * models (Haiku, Luna, Composer) when its provider is connected, else the
 * lowest-priced model the registry knows among the runnable ones. Null when
 * nothing runnable has a price (local and ACP agents), or nothing is runnable.
 */
export function pickFirstChatModel(status: AiSettingsStatus | null): FirstChatModel | null {
  const available = new Set<string>(status?.availableModelIds ?? []);
  if (!available.size) return null;
  for (const id of UTILITY_MODEL_IDS) {
    if (!available.has(id)) continue;
    return { id, label: getModelById(id)?.displayName ?? id };
  }
  let cheapest: { id: string; label: string; price: number } | null = null;
  for (const id of available) {
    const descriptor = getModelById(id);
    const price = descriptor?.inputPricePer1M;
    if (!descriptor || descriptor.deprecated || typeof price !== "number") continue;
    if (!cheapest || price < cheapest.price) cheapest = { id, label: descriptor.displayName, price };
  }
  return cheapest ? { id: cheapest.id, label: cheapest.label } : null;
}
