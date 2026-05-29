import { describe, expect, it, vi } from "vitest";
import {
  LINEAR_OAUTH_TOKEN_URL,
  linearTokenNeedsRefresh,
  refreshLinearOAuthAccessToken,
} from "./linearTokenRefresh";

const NOW = Date.parse("2026-05-29T12:00:00.000Z");

function okResponse(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload } as unknown as Response;
}
function errResponse(status: number, payload: unknown) {
  return { ok: false, status, json: async () => payload } as unknown as Response;
}

describe("linearTokenNeedsRefresh", () => {
  it("returns false when there is no usable expiry", () => {
    expect(linearTokenNeedsRefresh(null, NOW)).toBe(false);
    expect(linearTokenNeedsRefresh(undefined, NOW)).toBe(false);
    expect(linearTokenNeedsRefresh("not-a-date", NOW)).toBe(false);
  });

  it("returns false when the token is comfortably fresh", () => {
    expect(linearTokenNeedsRefresh(new Date(NOW + 60 * 60 * 1000).toISOString(), NOW)).toBe(false);
  });

  it("returns true at or within the refresh buffer of expiry", () => {
    // 60s out is inside the 2-minute buffer.
    expect(linearTokenNeedsRefresh(new Date(NOW + 60 * 1000).toISOString(), NOW)).toBe(true);
    // already expired.
    expect(linearTokenNeedsRefresh(new Date(NOW - 1000).toISOString(), NOW)).toBe(true);
  });
});

describe("refreshLinearOAuthAccessToken", () => {
  const base = { refreshToken: "rt_old", clientId: "client-123" };

  it("exchanges the refresh token, rotates it, and computes the new expiry", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      okResponse({ access_token: "at_new", refresh_token: "rt_new", expires_in: 86399 }),
    );
    const result = await refreshLinearOAuthAccessToken({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch, nowMs: NOW });

    expect(result).toEqual({
      ok: true,
      accessToken: "at_new",
      refreshToken: "rt_new",
      expiresAt: new Date(NOW + 86399 * 1000).toISOString(),
    });
    const call = fetchImpl.mock.calls[0];
    expect(call[0]).toBe(LINEAR_OAUTH_TOKEN_URL);
    const body = String(call[1]?.body ?? "");
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=rt_old");
    expect(body).toContain("client_id=client-123");
    expect(body).not.toContain("client_secret");
  });

  it("includes client_secret only for a confidential client", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      okResponse({ access_token: "at", expires_in: 100 }),
    );
    await refreshLinearOAuthAccessToken({ ...base, clientSecret: "shh", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(String(fetchImpl.mock.calls[0][1]?.body ?? "")).toContain("client_secret=shh");
  });

  it("flags invalid_grant as a dead refresh token (caller should reconnect)", async () => {
    const fetchImpl = vi.fn(async () => errResponse(400, { error: "invalid_grant", error_description: "expired" }));
    const result = await refreshLinearOAuthAccessToken({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toMatchObject({ ok: false, invalidGrant: true, status: 400, message: "expired" });
  });

  it("treats 5xx and network errors as transient, not invalid_grant", async () => {
    const five = vi.fn(async () => errResponse(503, {}));
    expect(await refreshLinearOAuthAccessToken({ ...base, fetchImpl: five as unknown as typeof fetch }))
      .toMatchObject({ ok: false, invalidGrant: false, status: 503 });

    const net = vi.fn(async () => { throw new Error("ECONNRESET"); });
    expect(await refreshLinearOAuthAccessToken({ ...base, fetchImpl: net as unknown as typeof fetch }))
      .toMatchObject({ ok: false, invalidGrant: false, status: 0, message: "ECONNRESET" });
  });

  it("does not flag client-config / non-invalid_grant 4xx as invalidGrant (keeps the token)", async () => {
    // invalid_client (wrong/misconfigured client) must NOT delete the refresh token.
    const badClient = vi.fn(async () => errResponse(401, { error: "invalid_client", error_description: "bad client" }));
    expect(await refreshLinearOAuthAccessToken({ ...base, fetchImpl: badClient as unknown as typeof fetch }))
      .toMatchObject({ ok: false, invalidGrant: false, status: 401 });

    // invalid_request (malformed) is our bug, not a dead token.
    const malformed = vi.fn(async () => errResponse(400, { error: "invalid_request" }));
    expect(await refreshLinearOAuthAccessToken({ ...base, fetchImpl: malformed as unknown as typeof fetch }))
      .toMatchObject({ ok: false, invalidGrant: false, status: 400 });
  });
});
