import { describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/directory";
import worker from "../src/index";
import {
  deviceConfirmationRequest,
  signInUrlFrom,
  ISSUER,
  makeEnv,
  mintToken,
  OAUTH_CLIENT_ID,
  request,
} from "./helpers";

/**
 * The `/device/*` sign-in bridge: code creation, browser confirmation, the
 * Clerk OAuth + PKCE round trip, and one-time redemption. Split out of
 * `directory.test.ts` verbatim — it is a self-contained protocol with its own
 * failure modes, and it was the largest single thing in that file.
 */

describe("device authorization bridge", () => {
  it("creates, approves with Clerk OAuth + PKCE, and one-time redeems a secret-bound device code", async () => {
    const env = makeEnv();
    let now = Date.parse("2026-07-14T12:00:00.000Z");
    const deviceSecret = "daemon-device-secret-with-at-least-32-bytes";
    const created = await handleRequest(
      request("POST", "/device/code", undefined, { device_secret: deviceSecret }),
      env,
      { now: () => now },
    );
    expect(created.status).toBe(200);
    const device = await created.json() as Record<string, unknown>;
    expect(device).toMatchObject({
      device_code: expect.any(String),
      user_code: expect.stringMatching(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/),
      verification_uri: "https://directory.test/device",
      verification_uri_complete: expect.stringContaining("https://directory.test/device?user_code="),
      expires_in: 600,
      interval: 5,
    });

    const pending = await handleRequest(
      request("POST", "/device/token", undefined, {
        device_code: device.device_code,
        device_secret: deviceSecret,
      }),
      env,
      { now: () => now },
    );
    expect(pending.status).toBe(400);
    expect(await pending.json()).toEqual({ error: "authorization_pending", interval: 5 });

    const approval = await handleRequest(
      deviceConfirmationRequest(String(device.user_code)),
      env,
      { now: () => now },
    );
    // A page that opens Clerk, not a 302: browsers apply `form-action 'self'`
    // to redirects after a form POST, and Chromium blocked the old 302.
    expect(approval.status).toBe(200);
    expect(approval.headers.get("location")).toBeNull();
    expect(approval.headers.get("content-security-policy")).toContain("form-action 'self';");
    const approvalHtml = await approval.clone().text();
    expect(approvalHtml).toContain('<meta http-equiv="refresh" content="0;url=');
    const clerkAuthorizeUrl = await signInUrlFrom(approval);
    expect(clerkAuthorizeUrl.origin + clerkAuthorizeUrl.pathname).toBe(`${ISSUER}/oauth/authorize`);
    expect(clerkAuthorizeUrl.searchParams.get("client_id")).toBe(OAUTH_CLIENT_ID);
    expect(clerkAuthorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(clerkAuthorizeUrl.searchParams.get("redirect_uri")).toBe("https://directory.test/device/callback");
    const state = clerkAuthorizeUrl.searchParams.get("state")!;
    const duplicateApproval = await handleRequest(
      deviceConfirmationRequest(String(device.user_code)),
      env,
      { now: () => now },
    );
    expect(duplicateApproval.status).toBe(409);
    expect(await duplicateApproval.text()).toContain("Sign-in already started");
    const tokenExchange = vi.fn(async (_input: string, init?: RequestInit) => {
      const body = Object.fromEntries(new URLSearchParams(String(init?.body)));
      expect(body).toMatchObject({
        grant_type: "authorization_code",
        code: "clerk-authorization-code",
        client_id: OAUTH_CLIENT_ID,
        redirect_uri: "https://directory.test/device/callback",
      });
      expect(body.code_verifier).toEqual(expect.any(String));
      return new Response(JSON.stringify({
        access_token: "approved-access-token",
        refresh_token: "approved-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const callback = await handleRequest(
      new Request(`https://directory.test/device/callback?code=clerk-authorization-code&state=${encodeURIComponent(state)}`),
      env,
      { now: () => now, fetchImpl: tokenExchange as typeof fetch },
    );
    expect(callback.status).toBe(200);
    const callbackBody = await callback.text();
    expect(callbackBody).toContain("You're signed in");
    expect(callbackBody).toContain("Go back to ADE.");

    const wrongSecret = await handleRequest(
      request("POST", "/device/token", undefined, {
        device_code: device.device_code,
        device_secret: "wrong-device-secret-with-at-least-32-bytes",
      }),
      env,
      { now: () => now },
    );
    expect(wrongSecret.status).toBe(401);
    expect(await wrongSecret.json()).toEqual({ error: "invalid_grant" });

    now += 6_000;
    const redeemed = await handleRequest(
      request("POST", "/device/token", undefined, {
        device_code: device.device_code,
        device_secret: deviceSecret,
      }),
      env,
      { now: () => now },
    );
    expect(redeemed.status).toBe(200);
    expect(await redeemed.json()).toEqual({
      access_token: "approved-access-token",
      refresh_token: "approved-refresh-token",
      token_type: "Bearer",
      expires_in: 3594,
      oauth_issuer: ISSUER,
      oauth_client_id: OAUTH_CLIENT_ID,
    });
    expect(env.DB.deviceRows[0]).toMatchObject({
      status: "consumed",
      access_token: null,
      refresh_token: null,
    });

    const replay = await handleRequest(
      request("POST", "/device/token", undefined, {
        device_code: device.device_code,
        device_secret: deviceSecret,
      }),
      env,
      { now: () => now + 6_000 },
    );
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: "invalid_grant" });

    const expiredReplay = await handleRequest(
      request("POST", "/device/token", undefined, {
        device_code: device.device_code,
        device_secret: deviceSecret,
      }),
      env,
      { now: () => now + 595_000 },
    );
    expect(expiredReplay.status).toBe(400);
    expect(await expiredReplay.json()).toEqual({ error: "expired" });
    expect(env.DB.deviceRows[0]?.status).toBe("consumed");
  });

  it("uses the global fetch receiver for OAuth token exchange", async () => {
    // Production, 2026-09-22: every "Confirm it's you" ended as "Sign-in
    // failed", with "OAuth token exchange failed." in the row. The default
    // `fetchImpl` was the bare global `fetch`, called as a method of the
    // options object, and workerd throws "Illegal invocation" for a `fetch`
    // whose `this` is anything but the global scope. Every other test injects
    // a fake, which never checks its receiver.
    const env = makeEnv();
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    const created = await handleRequest(
      request("POST", "/device/code", undefined, {
        device_secret: "daemon-device-secret-with-at-least-32-bytes",
      }),
      env,
      { now: () => now },
    );
    const device = await created.json() as Record<string, unknown>;
    const approval = await handleRequest(
      deviceConfirmationRequest(String(device.user_code)),
      env,
      { now: () => now },
    );
    const state = (await signInUrlFrom(approval)).searchParams.get("state")!;
    const receivers: unknown[] = [];
    vi.stubGlobal("fetch", function workerdFetch(this: unknown) {
      receivers.push(this);
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
      }
      return Promise.resolve(new Response(JSON.stringify({
        access_token: "approved-access-token",
        token_type: "Bearer",
        expires_in: 3600,
      }), { status: 200, headers: { "content-type": "application/json" } }));
    });
    try {
      const callback = await handleRequest(
        new Request(`https://directory.test/device/callback?code=clerk-code&state=${encodeURIComponent(state)}`),
        env,
        { now: () => now },
      );
      expect(receivers).toHaveLength(1);
      expect(await callback.text()).toContain("You're signed in");
      expect(env.DB.deviceRows[0]?.status).toBe("approved");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("claims concurrent duplicate callbacks before the one-time OAuth exchange", async () => {
    const env = makeEnv();
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    const created = await handleRequest(
      request("POST", "/device/code", undefined, {
        device_secret: "daemon-device-secret-with-at-least-32-bytes",
      }),
      env,
      { now: () => now },
    );
    const device = await created.json() as Record<string, unknown>;
    const approval = await handleRequest(
      deviceConfirmationRequest(String(device.user_code)),
      env,
      { now: () => now },
    );
    const state = (await signInUrlFrom(approval)).searchParams.get("state")!;
    const callbackUrl = `https://directory.test/device/callback?code=one-time-code&state=${encodeURIComponent(state)}`;
    env.DB.synchronizeOAuthStateReads(2);

    let resolveSuccessfulExchange: ((response: Response) => void) | null = null;
    const successfulExchange = new Promise<Response>((resolve) => {
      resolveSuccessfulExchange = resolve;
    });
    let exchangeCalls = 0;
    const fetchImpl = vi.fn((): Promise<Response> => {
      exchangeCalls += 1;
      return exchangeCalls === 1
        ? successfulExchange
        : Promise.resolve(new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }));
    });

    const callbacks = Promise.all([
      handleRequest(new Request(callbackUrl), env, { now: () => now, fetchImpl: fetchImpl as typeof fetch }),
      handleRequest(new Request(callbackUrl), env, { now: () => now, fetchImpl: fetchImpl as typeof fetch }),
    ]);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    resolveSuccessfulExchange!(new Response(JSON.stringify({
      access_token: "winner-access-token",
      refresh_token: "winner-refresh-token",
      token_type: "Bearer",
      expires_in: 3600,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const responses = await callbacks;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(env.DB.deviceRows[0]).toMatchObject({
      status: "approved",
      access_token: "winner-access-token",
      refresh_token: "winner-refresh-token",
      error_message: null,
      code_verifier: null,
      oauth_state_hash: null,
    });
  });

  /**
   * The bug a person actually hit: ADE Alpha on a MacBook could never finish
   * signing in. "Open sign-in page" led to a page headed "Confirmation
   * required" telling them to open the ADE sign-in page — the page they were
   * already on, with nothing to click.
   *
   * The confirmation was refused because the browser sent no `Origin` on a
   * same-origin form POST, and the check compared it to the origin directly.
   */
  it("confirms a same-origin submission whose browser sent no Origin", async () => {
    const env = makeEnv();
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    const created = await handleRequest(
      request("POST", "/device/code", undefined, {
        device_secret: "daemon-device-secret-with-at-least-32-bytes",
      }),
      env,
      { now: () => now },
    );
    const device = await created.json() as Record<string, unknown>;

    const confirmed = await handleRequest(
      deviceConfirmationRequest(String(device.user_code), { origin: "", "sec-fetch-site": "same-origin" }),
      env,
      { now: () => now },
    );

    expect((await signInUrlFrom(confirmed)).pathname).toBe("/oauth/authorize");
    expect(env.DB.deviceRows[0]).toMatchObject({ code_verifier: expect.any(String) });
  });

  /**
   * The same bug after the absent-Origin fix: the page was served with
   * `referrer-policy: no-referrer`, so the browser sent the text `null` as the
   * `Origin` of its own form POST. `"null"` is not empty, so the direct
   * comparison still ran and still refused every confirmation.
   */
  it("confirms a same-origin submission whose browser sent Origin: null", async () => {
    const env = makeEnv();
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    const created = await handleRequest(
      request("POST", "/device/code", undefined, {
        device_secret: "daemon-device-secret-with-at-least-32-bytes",
      }),
      env,
      { now: () => now },
    );
    const device = await created.json() as Record<string, unknown>;

    const preview = await handleRequest(new Request(String(device.verification_uri_complete)), env, { now: () => now });
    expect(preview.headers.get("referrer-policy")).toBe("same-origin");

    const crossSiteNull = await handleRequest(
      deviceConfirmationRequest(String(device.user_code), { origin: "null", "sec-fetch-site": "cross-site" }),
      env,
      { now: () => now },
    );
    expect(crossSiteNull.status).toBe(403);
    const nullNoHint = await handleRequest(
      deviceConfirmationRequest(String(device.user_code), { origin: "null" }),
      env,
      { now: () => now },
    );
    expect(nullNoHint.status).toBe(403);

    const confirmed = await handleRequest(
      deviceConfirmationRequest(String(device.user_code), { origin: "null", "sec-fetch-site": "same-origin" }),
      env,
      { now: () => now },
    );

    expect((await signInUrlFrom(confirmed)).pathname).toBe("/oauth/authorize");
    expect(env.DB.deviceRows[0]).toMatchObject({ code_verifier: expect.any(String) });
  });

  /**
   * The page said "ADE on your computer", so a person with two installs on one
   * Mac could not tell which one asked. The client now sends the name. It is
   * the client's claim, so the page shows it as one and tells the reader to
   * stop if they did not start this.
   */
  it("names the computer that asked, as a claim, and cleans the name", async () => {
    const env = makeEnv();
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    const created = await handleRequest(
      request("POST", "/device/code", undefined, {
        device_secret: "daemon-device-secret-with-at-least-32-bytes",
        machine_name: "  MacBook Pro · Alpha\n<script>x</script>  ",
      }),
      env,
      { now: () => now },
    );
    const device = await created.json() as Record<string, unknown>;
    expect(env.DB.deviceRows[0]?.machine_name).toBe("MacBook Pro · Alpha <script>x</script>");

    const preview = await handleRequest(new Request(String(device.verification_uri_complete)), env, { now: () => now });
    const html = await preview.text();
    expect(html).toContain("A computer named <strong>MacBook Pro · Alpha &lt;script&gt;x&lt;/script&gt;</strong> asked to sign in to ADE.");
    expect(html).toContain("Continue only if you started this on that computer.");
    expect(html).not.toContain("<script>x");

    const long = await handleRequest(
      request("POST", "/device/code", undefined, {
        device_secret: "daemon-device-secret-with-at-least-32-bytes-two",
        machine_name: "x".repeat(500),
      }),
      env,
      { now: () => now },
    );
    expect(long.status).toBe(200);
    expect(env.DB.deviceRows[1]?.machine_name).toHaveLength(80);

    const unnamed = await handleRequest(
      request("POST", "/device/code", undefined, {
        device_secret: "daemon-device-secret-with-at-least-32-bytes-three",
      }),
      env,
      { now: () => now },
    );
    const unnamedDevice = await unnamed.json() as Record<string, unknown>;
    const unnamedPreview = await handleRequest(new Request(String(unnamedDevice.verification_uri_complete)), env, { now: () => now });
    expect(await unnamedPreview.text()).toContain("ADE on your computer asked to sign in.");
    // Format characters go: a right-to-left override could make the name read
    // as another computer.
    await handleRequest(
      request("POST", "/device/code", undefined, {
        device_secret: "daemon-device-secret-with-at-least-32-bytes-four",
        machine_name: "Mac\u202Eorp kooBcaM\u200B",
      }),
      env,
      { now: () => now },
    );
    expect(env.DB.deviceRows[3]?.machine_name).toBe("Mac orp kooBcaM");

    // A code that can no longer be confirmed shows no client-chosen name.
    env.DB.deviceRows[0]!.status = "consumed";
    const deadPreview = await handleRequest(new Request(String(device.verification_uri_complete)), env, { now: () => now });
    const deadHtml = await deadPreview.text();
    expect(deadHtml).not.toContain("A computer named");
    expect(deadHtml).toContain("ADE on your computer asked to sign in.");

  });

  it("keeps verification-link GET previews read-only until explicit confirmation", async () => {
    const env = makeEnv();
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    const created = await handleRequest(
      request("POST", "/device/code", undefined, {
        device_secret: "daemon-device-secret-with-at-least-32-bytes",
      }),
      env,
      { now: () => now },
    );
    const device = await created.json() as Record<string, unknown>;
    const rowBeforePreview = { ...env.DB.deviceRows[0]! };
    const limitsBeforePreview = Array.from(
      env.DB.approvalRateLimits,
      ([key, value]) => [key, { ...value }] as const,
    );

    const firstPreview = await handleRequest(
      new Request(String(device.verification_uri_complete)),
      env,
      { now: () => now },
    );
    const repeatedPreview = await handleRequest(
      new Request(String(device.verification_uri_complete)),
      env,
      { now: () => now },
    );

    expect([firstPreview.status, repeatedPreview.status]).toEqual([200, 200]);
    expect(await firstPreview.text()).toContain('form method="post" action="/device"');
    expect(env.DB.deviceRows[0]).toEqual(rowBeforePreview);
    expect(Array.from(env.DB.approvalRateLimits)).toEqual(limitsBeforePreview);

    const crossSiteSubmit = await handleRequest(
      deviceConfirmationRequest(String(device.user_code), { origin: "https://preview.test" }),
      env,
      { now: () => now },
    );
    expect(crossSiteSubmit.status).toBe(403);
    expect(env.DB.deviceRows[0]).toEqual(rowBeforePreview);
    expect(Array.from(env.DB.approvalRateLimits)).toEqual(limitsBeforePreview);

    // A browser may omit `Origin` on a same-origin form POST. That refused a
    // real confirmation and left the person on a page telling them to open the
    // page they were already on. `Sec-Fetch-Site` decides it instead, and a
    // submission carrying neither header is still refused.
    const noOriginCrossSite = await handleRequest(
      deviceConfirmationRequest(String(device.user_code), { origin: "", "sec-fetch-site": "cross-site" }),
      env,
      { now: () => now },
    );
    expect(noOriginCrossSite.status).toBe(403);
    const noOriginNoHint = await handleRequest(
      deviceConfirmationRequest(String(device.user_code), { origin: "" }),
      env,
      { now: () => now },
    );
    expect(noOriginNoHint.status).toBe(403);
    expect(env.DB.deviceRows[0]).toEqual(rowBeforePreview);

    const confirmed = await handleRequest(
      deviceConfirmationRequest(String(device.user_code)),
      env,
      { now: () => now },
    );
    expect((await signInUrlFrom(confirmed)).pathname).toBe("/oauth/authorize");
    expect(env.DB.deviceRows[0]).toMatchObject({
      status: "pending",
      code_verifier: expect.any(String),
      oauth_state_hash: expect.any(String),
    });
    expect(env.DB.approvalRateLimits.size).toBe(2);
  });

  it("renders the confirm variant with a readonly code when the link carries one", async () => {
    const env = makeEnv();
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    const created = await handleRequest(
      request("POST", "/device/code", undefined, {
        device_secret: "daemon-device-secret-with-at-least-32-bytes",
      }),
      env,
      { now: () => now },
    );
    const device = await created.json() as Record<string, unknown>;

    const preview = await handleRequest(
      new Request(String(device.verification_uri_complete)),
      env,
      { now: () => now },
    );

    expect(preview.status).toBe(200);
    const body = await preview.text();
    expect(body).toContain("Confirm this sign-in");
    expect(body).toContain(String(device.user_code));
    // The code is shown, never typed: it rides a hidden field, so there is no
    // visible code input for the reader to have to fill in.
    expect(body).toContain('type="hidden" name="user_code"');
    expect(body).not.toContain('id="user_code"');
    expect(body).not.toContain("ade login");
  });

  it("renders the code input form when the link carries no code", async () => {
    const env = makeEnv();

    const preview = await handleRequest(
      new Request("https://directory.test/device"),
      env,
      {},
    );

    expect(preview.status).toBe(200);
    const body = await preview.text();
    expect(body).toContain("Sign in to ADE");
    expect(body).toContain('id="user_code"');
    expect(body).toContain("Enter the code shown by <code>ade login</code> in your terminal.");
    expect(body).not.toContain("Confirm this sign-in");
  });

  it("returns expired for a device code after its short TTL", async () => {
    const env = makeEnv();
    const startedAt = Date.parse("2026-07-14T12:00:00.000Z");
    const deviceSecret = "daemon-device-secret-with-at-least-32-bytes";
    const created = await handleRequest(
      request("POST", "/device/code", undefined, { device_secret: deviceSecret }),
      env,
      { now: () => startedAt },
    );
    const device = await created.json() as Record<string, unknown>;

    const expired = await handleRequest(
      request("POST", "/device/token", undefined, {
        device_code: device.device_code,
        device_secret: deviceSecret,
      }),
      env,
      { now: () => startedAt + 601_000 },
    );
    expect(expired.status).toBe(400);
    expect(await expired.json()).toEqual({ error: "expired" });
    expect(env.DB.deviceRows[0]?.status).toBe("expired");
  });

  it("clears expired approved credentials from the scheduled worker without client polling", async () => {
    const env = makeEnv();
    const startedAt = Date.parse("2026-07-14T12:00:00.000Z");
    await handleRequest(
      request("POST", "/device/code", undefined, {
        device_secret: "daemon-device-secret-with-at-least-32-bytes",
      }),
      env,
      { now: () => startedAt },
    );
    Object.assign(env.DB.deviceRows[0]!, {
      status: "approved",
      code_verifier: "temporary-pkce-verifier",
      oauth_state_hash: "temporary-state-hash",
      access_token: "abandoned-access-token",
      refresh_token: "abandoned-refresh-token",
    });
    vi.spyOn(Date, "now").mockReturnValue(startedAt + 601_000);
    let cleanup: Promise<unknown> | undefined;

    await worker.scheduled(
      {} as ScheduledEvent,
      env,
      { waitUntil: (promise) => { cleanup = promise; } } as ExecutionContext,
    );
    await cleanup;

    expect(env.DB.deviceRows[0]).toMatchObject({
      status: "expired",
      code_verifier: null,
      oauth_state_hash: null,
      access_token: null,
      refresh_token: null,
    });
    expect(env.DB.approvalRateLimits.size).toBe(0);

    vi.mocked(Date.now).mockReturnValue(startedAt + 4_201_000);
    cleanup = undefined;
    await worker.scheduled(
      {} as ScheduledEvent,
      env,
      { waitUntil: (promise) => { cleanup = promise; } } as ExecutionContext,
    );
    await cleanup;
    expect(env.DB.deviceRows).toHaveLength(0);
  });

  it("rate-limits device-code issuance separately from approval lookups", async () => {
    const env = makeEnv();
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    const headers = {
      "cf-connecting-ip": "203.0.113.8",
      "content-type": "application/json",
    };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await handleRequest(
        new Request("https://directory.test/device/code", {
          method: "POST",
          headers,
          body: JSON.stringify({ device_secret: "daemon-device-secret-with-at-least-32-bytes" }),
        }),
        env,
        { now: () => now },
      );
      expect(response.status).toBe(200);
    }

    const blocked = await handleRequest(
      new Request("https://directory.test/device/code", {
        method: "POST",
        headers,
        body: JSON.stringify({ device_secret: "daemon-device-secret-with-at-least-32-bytes" }),
      }),
      env,
      { now: () => now },
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect(env.DB.deviceRows).toHaveLength(10);

    const approval = await handleRequest(
      deviceConfirmationRequest("ZZZZ-ZZZZ", { "cf-connecting-ip": "203.0.113.8" }),
      env,
      { now: () => now },
    );
    expect(approval.status).toBe(404);
    expect(env.DB.approvalRateLimits.size).toBe(2);
    expect(Array.from(env.DB.approvalRateLimits.values(), (entry) => entry.attempts).sort()).toEqual([1, 10]);
  });

  it("atomically admits at most ten concurrent device-code issuances per client", async () => {
    const env = makeEnv();
    let now = Date.parse("2026-07-14T12:00:00.000Z");
    env.DB.synchronizeRateLimitReads(25);
    const responses = await Promise.all(Array.from({ length: 25 }, () => handleRequest(
      new Request("https://directory.test/device/code", {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.9",
          "content-type": "application/json",
        },
        body: JSON.stringify({ device_secret: "daemon-device-secret-with-at-least-32-bytes" }),
      }),
      env,
      { now: () => now },
    )));

    expect(responses.filter((response) => response.status === 200)).toHaveLength(10);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(15);
    expect(new Set(responses.map((response) => response.status))).toEqual(new Set([200, 429]));
    expect(env.DB.deviceRows).toHaveLength(10);
    expect(Array.from(env.DB.approvalRateLimits.values(), (entry) => entry.attempts)).toEqual([10]);

    now += 60_000;
    const nextWindow = await handleRequest(
      new Request("https://directory.test/device/code", {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.9",
          "content-type": "application/json",
        },
        body: JSON.stringify({ device_secret: "daemon-device-secret-with-at-least-32-bytes" }),
      }),
      env,
      { now: () => now },
    );
    expect(nextWindow.status).toBe(200);
    expect(env.DB.deviceRows).toHaveLength(11);
    expect(Array.from(env.DB.approvalRateLimits.values(), (entry) => entry.attempts)).toEqual([1]);
  });

  it("rate-limits user-code confirmations on the hosted approval page", async () => {
    const env = makeEnv();
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await handleRequest(
        deviceConfirmationRequest("ABCD-EFGH", { "cf-connecting-ip": "203.0.113.7" }),
        env,
        { now: () => now },
      );
      expect(response.status).toBe(404);
    }
    const blocked = await handleRequest(
      deviceConfirmationRequest("ABCD-EFGH", { "cf-connecting-ip": "203.0.113.7" }),
      env,
      { now: () => now },
    );
    expect(blocked.status).toBe(429);
  });
});
