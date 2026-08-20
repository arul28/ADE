import { describe, expect, it } from "vitest";
import {
  GitHubOAuthError,
  pollGitHubAppDeviceFlow,
  refreshGitHubAppUserToken,
  startGitHubAppDeviceFlow,
} from "./githubAppUserAuth";

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

async function captureError(run: () => Promise<unknown>): Promise<GitHubOAuthError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubOAuthError);
    return error as GitHubOAuthError;
  }
  throw new Error("Expected the call to reject.");
}

describe("refreshGitHubAppUserToken", () => {
  it("rejects an HTTP-200 OAuth error body as a definitive dead-token failure", async () => {
    // GitHub answers a rejected refresh token with HTTP 200 and an error body,
    // which is why "did the response parse" is not the same question as "did the
    // refresh work".
    const fetchImpl = async (): Promise<Response> => jsonResponse({
      error: "bad_refresh_token",
      error_description: "The refresh token passed is incorrect or expired.",
      error_uri: "https://docs.github.com/apps",
    });

    const error = await captureError(() => refreshGitHubAppUserToken({
      refreshToken: "ghr_dead",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userAgent: "ade-test",
    }));

    expect(error.oauthError).toBe("bad_refresh_token");
    expect(error.status).toBe(200);
    expect(error.message).toContain("refresh token");
  });

  it("carries the status and retry-after of a rate-limited refresh", async () => {
    const fetchImpl = async (): Promise<Response> => jsonResponse(
      { error: "too_many_requests", error_description: "You have exceeded a secondary rate limit." },
      { status: 429, headers: { "retry-after": "120" } },
    );

    const error = await captureError(() => refreshGitHubAppUserToken({
      refreshToken: "ghr_live",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userAgent: "ade-test",
    }));

    expect(error.status).toBe(429);
    expect(error.retryAfterSec).toBe(120);
    expect(error.oauthError).toBe("too_many_requests");
  });

  it("returns the rotated refresh token when GitHub rotates it", async () => {
    const fetchImpl = async (): Promise<Response> => jsonResponse({
      access_token: "ghu_new",
      token_type: "bearer",
      expires_in: 28_800,
      refresh_token: "ghr_rotated",
      refresh_token_expires_in: 15_811_200,
    });

    const record = await refreshGitHubAppUserToken({
      refreshToken: "ghr_old",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userAgent: "ade-test",
    });

    expect(record.accessToken).toBe("ghu_new");
    expect(record.refreshToken).toBe("ghr_rotated");
  });
});

describe("device flow transport", () => {
  it("carries the status and retry-after of a rate-limited device-code request", async () => {
    const fetchImpl = async (): Promise<Response> => jsonResponse(
      { error: "too_many_requests" },
      { status: 429, headers: { "retry-after": "60" } },
    );

    const error = await captureError(() => startGitHubAppDeviceFlow({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userAgent: "ade-test",
    }));

    expect(error.status).toBe(429);
    expect(error.retryAfterSec).toBe(60);
  });

  it("keeps reporting HTTP-200 device-flow errors as poll results", async () => {
    const fetchImpl = async (): Promise<Response> => jsonResponse({ error: "authorization_pending" });

    const result = await pollGitHubAppDeviceFlow({
      deviceCode: "device",
      intervalSec: 5,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userAgent: "ade-test",
    });

    expect(result.status).toBe("pending");
  });
});
