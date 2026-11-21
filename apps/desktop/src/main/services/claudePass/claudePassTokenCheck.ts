/**
 * One question to Claude about a pass token: does Claude still take it?
 *
 * A chat's sign-in failure is not proof that the token is gone: a turn can
 * fail its sign-in for a moment (an outage, a token handed to the wrong
 * process). So before ADE ends a pass, and once for each ended pass on each
 * brain, it asks Claude's own OAuth usage endpoint with the token. The
 * request spends no usage.
 *
 * - 401: Claude refused the token. Only this ends a pass.
 * - 2xx or 403: Claude knows the token. A 403 is the scope check (a
 *   `claude setup-token` token may not read usage), which runs after the
 *   token is accepted.
 * - Anything else (429, 5xx, no network, a timeout): no answer.
 *
 * The token goes only to the request's Authorization header, never to a log
 * line or an error message.
 */

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const CHECK_TIMEOUT_MS = 10_000;

export type ClaudePassTokenCheck = "refused" | "accepted" | "unknown";

export type ClaudePassTokenChecker = (token: string) => Promise<ClaudePassTokenCheck>;

export async function checkClaudePassToken(token: string, fetchImpl: typeof fetch = fetch): Promise<ClaudePassTokenCheck> {
  try {
    const response = await fetchImpl(CLAUDE_USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": CLAUDE_OAUTH_BETA },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    // The body is not needed; let the connection go.
    void response.body?.cancel().catch(() => undefined);
    if (response.status === 401) return "refused";
    if (response.ok || response.status === 403) return "accepted";
    return "unknown";
  } catch {
    return "unknown";
  }
}
