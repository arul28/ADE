import type { GitHubAppUserAuthStatus } from "../../shared/types";

/**
 * The GitHub App account status as a healthy machine reports it.
 *
 * The access token is deliberately already LAPSED: it lives eight hours and is
 * renewed from the refresh token on every use, so a lapsed one is ordinary
 * operation. Reading it as "authorization expired" is the bug this fixture's
 * consumers exist to catch, and a default that hides the case hides the bug.
 */
export function makeAppAuth(
  overrides: Partial<GitHubAppUserAuthStatus> = {},
): GitHubAppUserAuthStatus {
  const hourMs = 60 * 60 * 1000;
  return {
    configured: true,
    tokenStored: true,
    userLogin: "arul28",
    expiresAt: new Date(Date.now() - 2 * hourMs).toISOString(),
    refreshTokenExpiresAt: new Date(Date.now() + 180 * 24 * hourMs).toISOString(),
    credentialState: "authorized",
    refreshBlockedUntil: null,
    lastRefreshError: null,
    checkedAt: new Date().toISOString(),
    error: null,
    ...overrides,
  };
}
