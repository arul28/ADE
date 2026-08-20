import type { GitHubAppUserTokenRecord } from "./githubAppUserAuth";

/**
 * One stored GitHub App user credential, as the credential store holds it.
 *
 * The desktop service tests and the headless CLI twin's tests both write this
 * record, and both care about the same two fields: an access token already past
 * its life (so every call has to refresh) next to a refresh token that is still
 * good. Spelling the whole record out at each call site is how those two facts
 * drifted apart between suites.
 */
export function makeStoredAppUserToken(
  patch: Partial<GitHubAppUserTokenRecord> = {},
): string {
  const record: GitHubAppUserTokenRecord = {
    accessToken: "ghu_stale_app_token",
    tokenType: "bearer",
    scope: null,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    refreshToken: "ghr_live_refresh_token",
    refreshTokenExpiresAt: new Date(Date.now() + 180 * 24 * 3_600_000).toISOString(),
    userLogin: "octocat",
    updatedAt: new Date().toISOString(),
    ...patch,
  };
  return JSON.stringify(record);
}
