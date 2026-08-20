import { describe, expect, it } from "vitest";
import { GITHUB_APP_USER_AUTH_RENEWING_COPY } from "../../../shared/types";
import {
  GitHubAppUserAuthError,
  classifyAppUserAuthFailure,
} from "./githubAppUserAuthFailure";

const RETRY_AT = "2026-08-20T12:00:30.000Z";

describe("classifyAppUserAuthFailure", () => {
  it("reports ADE's own refresh lease as renewing rather than a failed check", () => {
    // `blocked` with nothing refused is one ADE process renewing the credential
    // while the rest wait. The repo axis already said so; the credential
    // inventory called the same wait a failed authentication check.
    const failure = classifyAppUserAuthFailure(new GitHubAppUserAuthError(
      "GitHub paused ADE's authorization renewal. ADE retries on its own.",
      "blocked",
      RETRY_AT,
      null,
    ));

    expect(failure.authFailure).toEqual({
      kind: "renewing",
      message: GITHUB_APP_USER_AUTH_RENEWING_COPY,
      retryAt: RETRY_AT,
    });
  });

  it("keeps GitHub's own refusal when the pause carries one", () => {
    const failure = classifyAppUserAuthFailure(new GitHubAppUserAuthError(
      "GitHub paused ADE's authorization renewal. ADE retries on its own.",
      "blocked",
      RETRY_AT,
      { kind: "rate_limited", status: 429, oauthError: null },
    ));

    expect(failure.authFailure.kind).toBe("rate_limited");
    expect(failure.authFailure.retryAt).toBe(RETRY_AT);
  });

  it("asks for re-authorization when the refresh token is gone", () => {
    const failure = classifyAppUserAuthFailure(new GitHubAppUserAuthError(
      "ADE GitHub App authorization expired. Re-authorize ADE with GitHub.",
      "needs_reauth",
      null,
      { kind: "dead_token", status: 401, oauthError: "bad_refresh_token" },
    ));

    expect(failure.authFailure.kind).toBe("invalid_token");
    expect(failure.authFailure.retryAt).toBeNull();
  });
});
