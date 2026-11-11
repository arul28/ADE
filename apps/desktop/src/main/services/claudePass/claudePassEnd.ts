/**
 * The end of a Claude pass: Claude refused its token as no longer valid
 * (expired or revoked at Claude). Only such a refusal ends a pass; the date
 * estimate (save + 365 days) never does.
 *
 * The chat's turn already goes to the sign-in card (agentChatService's auth
 * failure path). This module only decides whether the refusal ends the pass,
 * and hands it to the reconcile (claudePassSync.ts `endPass`), which writes the
 * mark once.
 *
 * Signals that END a pass (all come from the Claude turn in agentChatService):
 *   - `system/api_retry` with `error_status: 401`          → "status_401"
 *   - `error: "authentication_failed"` on `system/api_retry` or on an
 *     assistant message (the SDK's own error code)         → "authentication_failed"
 *   - a result or thrown error whose text has one of
 *     "authentication_error", "invalid authentication credentials",
 *     "api error: 401", "status code: 401", "status 401", "authentication_failed"
 * Signals that do NOT end a pass:
 *   - "not logged in", "login required", "sign in", "/login", "not authenticated",
 *     `auth_status` errors: Claude Code had no credential at all. On a pass
 *     account that means ADE did not hand the token over, not that Claude
 *     refused it.
 *   - 403 (Anthropic uses it for org or model access), 429 and usage limits,
 *     a `rate_limit_event`, 529 / overloaded, 5xx, network errors, timeouts.
 */

/** Text of a refusal of the credential itself (a subset of `isClaudeRuntimeAuthError`). */
const REFUSED_CREDENTIAL = /authentication_error|invalid authentication credentials|api error: 401|status code: 401|status 401\b|authentication_failed/i;

/** True when `signal` means Claude refused the token as no longer valid. */
function claudePassEndSignal(signal: string | null | undefined): boolean {
  const text = signal?.trim() ?? "";
  if (!text) return false;
  if (text === "status_401" || text === "authentication_failed") return true;
  return REFUSED_CREDENTIAL.test(text);
}

type EndHandler = (instanceId: string) => void;
let handler: EndHandler | null = null;

/** The reconcile registers here (installClaudePassSync.ts). */
export function setClaudePassEndHandler(next: EndHandler | null): void {
  handler = next;
}

/**
 * A Claude turn on account `instanceId` failed its sign-in with `signal`.
 * Ends the pass when the account is a pass and the signal is a refusal of the
 * token. Never throws; returns true when it handed the end on.
 */
export function noteClaudePassAuthFailure(instanceId: string | null | undefined, signal: string | null | undefined): boolean {
  const id = instanceId?.trim() ?? "";
  if (!/^pass-(?:legacy|[0-9a-f]{12})$/.test(id) || !handler || !claudePassEndSignal(signal)) return false;
  try {
    handler(id);
    return true;
  } catch {
    return false;
  }
}
