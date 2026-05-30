// Shared Linear OAuth token-refresh helper used by both the desktop credential
// service and the headless (ade serve) credential service.
//
// Linear OAuth access tokens expire after ~24h ("expires_in": 86399) and Linear
// issues a rotating refresh_token. Without refreshing, an OAuth connection
// silently breaks a day after sign-in. This helper performs the
// grant_type=refresh_token exchange; the credential services decide when to call
// it (proactively near expiry, or reactively on a 401).

export const LINEAR_OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token";

// Refresh this far before the recorded expiry so an in-flight request never
// races the expiry boundary.
export const LINEAR_TOKEN_REFRESH_BUFFER_MS = 2 * 60 * 1000;

/**
 * True when an OAuth access token with the given ISO `expiresAt` is at or within
 * the refresh buffer of expiry. Returns false when there is no usable expiry
 * (nothing to refresh proactively — the reactive 401 path still applies).
 */
export function linearTokenNeedsRefresh(
  expiresAt: string | null | undefined,
  nowMs: number,
  bufferMs: number = LINEAR_TOKEN_REFRESH_BUFFER_MS,
): boolean {
  if (!expiresAt) return false;
  const expMs = Date.parse(expiresAt);
  if (!Number.isFinite(expMs)) return false;
  return nowMs >= expMs - bufferMs;
}

/**
 * True when an invalid_grant response is likely because another ADE runtime
 * already rotated the refresh token in the shared credential store — not
 * because the user's connection is actually dead.
 *
 * A fresh stored expiry only counts as evidence for proactive refreshes. During
 * a forced refresh after a 401, the access token was already rejected, so expiry
 * alone should not keep a dead refresh token around.
 */
export function linearInvalidGrantLikelyStaleRotation(args: {
  attemptedRefreshToken: string;
  rereadRefreshToken: string | null | undefined;
  rereadExpiresAt: string | null | undefined;
  trustFreshExpiresAt?: boolean;
  nowMs?: number;
}): boolean {
  const nowMs = args.nowMs ?? Date.now();
  if (
    args.rereadRefreshToken
    && args.rereadRefreshToken !== args.attemptedRefreshToken
  ) {
    return true;
  }
  if (
    args.trustFreshExpiresAt !== false
    && args.rereadExpiresAt
    && !linearTokenNeedsRefresh(args.rereadExpiresAt, nowMs)
  ) {
    return true;
  }
  return false;
}

export type LinearTokenRefreshResult =
  | {
      ok: true;
      accessToken: string;
      refreshToken: string | null;
      expiresAt: string | null;
    }
  | {
      ok: false;
      /** HTTP status (0 for a network/transport error). */
      status: number;
      /**
       * The refresh token is no longer valid (revoked / expired / already
       * rotated). The caller should clear the connection and prompt re-auth.
       * Distinguished from transient failures, which should leave the token in
       * place and be retried later.
       */
      invalidGrant: boolean;
      message: string;
    };

/**
 * Exchange a Linear refresh token for a new access token via
 * grant_type=refresh_token. Public (PKCE) clients omit the secret; confidential
 * clients pass it when present.
 */
export async function refreshLinearOAuthAccessToken(params: {
  refreshToken: string;
  clientId: string;
  clientSecret?: string | null;
  fetchImpl?: typeof fetch;
  tokenUrl?: string;
  nowMs?: number;
}): Promise<LinearTokenRefreshResult> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
  });
  if (params.clientSecret?.trim()) {
    body.set("client_secret", params.clientSecret.trim());
  }

  let res: Response;
  try {
    res = await fetchImpl(params.tokenUrl ?? LINEAR_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (error: unknown) {
    return {
      ok: false,
      status: 0,
      invalidGrant: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const payload = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (
    !res.ok ||
    typeof payload.access_token !== "string" ||
    !payload.access_token.trim()
  ) {
    // Only an explicit `invalid_grant` reliably means the refresh token itself
    // is dead (expired / revoked) and the user must reconnect — see RFC 6749
    // §5.2. `invalid_client` (wrong or misconfigured client → 400/401),
    // `invalid_request` (malformed), other 4xx, and 5xx/network failures are
    // NOT the token's fault: keep the token so a client-config or transient
    // error never silently deletes a still-valid refresh token; retry later.
    const invalidGrant = payload.error === "invalid_grant";
    return {
      ok: false,
      status: res.status,
      invalidGrant,
      message:
        payload.error_description ??
        payload.error ??
        `Linear token refresh failed (HTTP ${res.status}).`,
    };
  }

  const nowMs = params.nowMs ?? Date.now();
  const expiresAt =
    typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
      ? new Date(nowMs + payload.expires_in * 1000).toISOString()
      : null;

  return {
    ok: true,
    accessToken: payload.access_token.trim(),
    refreshToken:
      typeof payload.refresh_token === "string" && payload.refresh_token.trim()
        ? payload.refresh_token.trim()
        : null,
    expiresAt,
  };
}
