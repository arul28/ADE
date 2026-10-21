/**
 * How far back first-run setup reaches for chats: the ones active this
 * recently are what it imports, what its chat counts and pickers show, and
 * what makes a project suggested. One value for the discovery (main) and the
 * setup card (renderer), so the card's copy says what the import does.
 */
export const ONBOARDING_CHAT_WINDOW_DAYS = 30;
export const ONBOARDING_CHAT_WINDOW_MS = ONBOARDING_CHAT_WINDOW_DAYS * 24 * 3_600_000;
