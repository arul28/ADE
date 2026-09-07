import { BUILT_IN_BROWSER_HANDOFF_ACTIVE_CODE } from "../../../shared/types/builtInBrowser";

/**
 * Login handoff — the pure half.
 *
 * A handoff is the one state in which the built-in browser is deliberately NOT
 * the agent's: the agent hit a login page, a CAPTCHA, an HTTP-auth dialog or a
 * client-certificate prompt, said so out loud, and handed the tab to the human.
 * Everything stateful (which tab, which timer, which lease to restore) lives in
 * `builtInBrowserService`; this module holds the parts worth testing on their
 * own and the typed error every agent-facing action throws while a handoff is
 * open.
 */

export const DEFAULT_BUILT_IN_BROWSER_HANDOFF_TIMEOUT_MS = 15 * 60_000;
const MIN_HANDOFF_TIMEOUT_MS = 60_000;
const MAX_HANDOFF_TIMEOUT_MS = 2 * 60 * 60_000;

export function normalizeHandoffTimeoutMs(value: unknown): number {
  const raw = typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : DEFAULT_BUILT_IN_BROWSER_HANDOFF_TIMEOUT_MS;
  return Math.max(MIN_HANDOFF_TIMEOUT_MS, Math.min(MAX_HANDOFF_TIMEOUT_MS, raw));
}

/**
 * The origin the auto hand-back offer is measured against.
 *
 * Deliberately origin-level, not URL-level: an identity provider walks the user
 * through several paths on the same host (`/login`, `/mfa`, `/consent`) and a
 * per-URL comparison would offer hand-back on the first hop, before the human
 * has actually signed in anywhere.
 */
export function handoffOrigin(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text === "about:blank") return null;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * Typed policy refusal for agent actions aimed at a handed-off tab.
 *
 * Carries `code` so a caller can branch, and repeats the reason in the message
 * because the desktop bridge and the runtime RPC layer both flatten errors to
 * their message on the way back to `ade browser`.
 */
export class BuiltInBrowserHandoffActiveError extends Error {
  readonly code = BUILT_IN_BROWSER_HANDOFF_ACTIVE_CODE;
  readonly tabId: string;
  readonly reason: string;

  constructor(tabId: string, reason: string) {
    super(
      `${BUILT_IN_BROWSER_HANDOFF_ACTIVE_CODE}: browser tab ${tabId} is handed to the human to ${reason}. `
      + "Agent actions resume when they press Hand back; wait for the handoff to end instead of retrying.",
    );
    this.name = "BuiltInBrowserHandoffActiveError";
    this.tabId = tabId;
    this.reason = reason;
  }
}
