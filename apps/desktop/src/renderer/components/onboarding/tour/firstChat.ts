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

/**
 * Sets the open draft's model through its composer
 * (`ade:agent-chat:set-draft-model` in `AgentChatPane`). Retries while the
 * draft mounts after navigation; false when no draft took it in time.
 */
export async function setDraftModel(modelId: string, timeoutMs = 4_000): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const detail: { modelId: string; handled?: boolean } = { modelId };
    window.dispatchEvent(new CustomEvent("ade:agent-chat:set-draft-model", { detail }));
    if (detail.handled) return true;
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  return false;
}

/**
 * The composer remembers the last launched model and controls
 * (`ade.chat.last*` keys in `AgentChatPane`). The first chat runs on a cheap
 * model the user did not pick, so the tour puts their own choice back once
 * the step is over: new chats keep starting on what they had before.
 */
const REMEMBERED_LAUNCH_PREFIX = "ade.chat.last";

export type RememberedLaunchSnapshot = Map<string, string | null>;

export function snapshotRememberedLaunch(): RememberedLaunchSnapshot {
  const snapshot: RememberedLaunchSnapshot = new Map();
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(REMEMBERED_LAUNCH_PREFIX)) snapshot.set(key, window.localStorage.getItem(key));
    }
  } catch {
    // Storage unavailable: nothing to restore later either.
  }
  return snapshot;
}

/** Puts every `ade.chat.last*` key back as it was, removing ones the first chat added. */
export function restoreRememberedLaunch(snapshot: RememberedLaunchSnapshot): void {
  try {
    const current: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(REMEMBERED_LAUNCH_PREFIX)) current.push(key);
    }
    for (const key of current) {
      if (!snapshot.has(key)) window.localStorage.removeItem(key);
    }
    for (const [key, value] of snapshot) {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    }
  } catch {
    // Storage unavailable: the composer keeps the cheap model as last used.
  }
}
