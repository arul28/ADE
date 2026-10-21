import { ANNOUNCEMENTS_SEEN_STORAGE_KEY } from "../components/announcements/announcementSeen";
import { PROMPT_STORAGE_KEY } from "../components/app/suggestions/chatSendSignals";
import { POSTPONED_SUGGESTIONS_STORAGE_KEY } from "./adeTipsSuggestions";
import { LEGACY_LANE_TEMPLATE_KEY, SUGGESTIONS_STORAGE_KEY } from "./situationalSuggestions";

/**
 * Where onboarding's later tiers keep what this computer has seen:
 * situational suggestions and tip cards, the repeated-prompt signal,
 * suggestions filed into ADE Tips, and "What's new" pages.
 */
export const ONBOARDING_TIER_STORAGE_KEYS = [
  SUGGESTIONS_STORAGE_KEY,
  LEGACY_LANE_TEMPLATE_KEY,
  PROMPT_STORAGE_KEY,
  POSTPONED_SUGGESTIONS_STORAGE_KEY,
  ANNOUNCEMENTS_SEEN_STORAGE_KEY,
] as const;

/**
 * Forgets all of it on this computer (dev builds and the browser preview);
 * `keepWhatsNew` leaves the seen "What's new" pages alone. The stores keep
 * their copies until the page reloads, so call it before they first read or
 * reload after.
 */
export function resetOnboardingTiers({ keepWhatsNew = false }: { keepWhatsNew?: boolean } = {}): void {
  for (const key of ONBOARDING_TIER_STORAGE_KEYS) {
    if (keepWhatsNew && key === ANNOUNCEMENTS_SEEN_STORAGE_KEY) continue;
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Storage unavailable: nothing was kept.
    }
  }
}
