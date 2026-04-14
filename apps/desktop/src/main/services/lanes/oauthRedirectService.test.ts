import { EventEmitter } from "node:events";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createOAuthRedirectService } from "./oauthRedirectService";
import type { OAuthRedirectEvent, ProxyRoute } from "../../../shared/types";

// Mock node:http — we replace `http.request` so the oauth service's
// defaultRequestUpstream can be exercised deterministically. All other existing
// tests inject a fake `requestUpstream`, so they never touch `http.request`.
const httpRequestMock = vi.fn();
vi.mock("node:http", async () => {
  const actual = await vi.importActual<typeof import("node:http")>("node:http");
  return {
    ...actual,
    default: {
      ...actual,
      request: (...args: unknown[]) => httpRequestMock(...args),
    },
    request: (...args: unknown[]) => httpRequestMock(...args),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

function mockReq(url: string, host = "localhost:8080"): any {
  return { url, headers: { host }, method: "GET" };
}

function mockRes(): any {
  const res: any = new EventEmitter();
  Object.assign(res, {
    writeHead: vi.fn(),
    end: vi.fn(),
    headersSent: false,
    statusCode: 200,
  });
  return res;
}

function finishRes(res: any, statusCode = 200) {
  res.statusCode = statusCode;
  res.emit("finish");
}

function makeRoute(
  laneId: string,
  targetPort: number,
  status: ProxyRoute["status"] = "active",
): ProxyRoute {
  return {
    laneId,
    hostname: `${laneId}.localhost`,
    targetPort,
    status,
    createdAt: new Date().toISOString(),
  };
}

function locationFrom(res: any): string | null {
  const call = res.writeHead.mock.calls.at(-1);
  const headers = call?.[1] as Record<string, string | string[] | undefined> | undefined;
  const location = headers?.location;
  return typeof location === "string" ? location : Array.isArray(location) ? location[0] ?? null : null;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("oauthRedirectService", () => {
  let events: OAuthRedirectEvent[];
  let routes: ProxyRoute[];
  let logger: ReturnType<typeof createLogger>;
  let forwardToPort: ReturnType<typeof vi.fn>;
  let requestUpstream: ReturnType<typeof vi.fn>;
  let svc: ReturnType<typeof createOAuthRedirectService>;

  beforeEach(() => {
    events = [];
    routes = [];
    logger = createLogger();
    forwardToPort = vi.fn();
    requestUpstream = vi.fn();

    svc = createOAuthRedirectService({
      logger,
      broadcastEvent: (ev) => events.push(ev),
      getRoutes: () => routes,
      getProxyPort: () => 8080,
      getHostnameSuffix: () => ".localhost",
      forwardToPort,
      requestUpstream: requestUpstream as any,
    });
  });

  afterEach(() => {
    svc.dispose();
  });

  // =========================================================================
  // 1. State parameter encoding / decoding
  // =========================================================================

  describe("state parameter encoding/decoding", () => {
    it("encodeState produces correct format with 'ade:' prefix", () => {
      const encoded = svc.encodeState("lane-1", "original-state-abc");
      expect(encoded).toMatch(/^ade:/);
    });

    it("decodeState recovers original laneId and state", () => {
      const encoded = svc.encodeState("lane-1", "original-state-abc");
      const decoded = svc.decodeState(encoded);
      expect(decoded).toEqual({
        laneId: "lane-1",
        originalState: "original-state-abc",
      });
    });

    it("decodeState returns null for non-ADE state strings", () => {
      expect(svc.decodeState("some-random-oauth-state")).toBeNull();
      expect(svc.decodeState("notade:something")).toBeNull();
      expect(svc.decodeState("xyz123")).toBeNull();
    });

    it("decodeState returns null for malformed strings", () => {
      // Has prefix but no separator after the base64 segment
      expect(svc.decodeState("ade:")).toBeNull();
      // Has prefix but only one segment (no second colon)
      expect(svc.decodeState("ade:onlyone")).toBeNull();
    });

    it("roundtrip: encode then decode preserves values", () => {
      const cases = [
        { laneId: "my-lane", state: "s3cr3t" },
        { laneId: "lane-42", state: "a=1&b=2&c=3" },
        { laneId: "feat/oauth-flow", state: "nonce-999" },
      ];
      for (const { laneId, state } of cases) {
        const encoded = svc.encodeState(laneId, state);
        const decoded = svc.decodeState(encoded);
        expect(decoded).toEqual({ laneId, originalState: state });
      }
    });

    it("handles lane IDs with special characters (spaces, slashes, unicode)", () => {
      const specialIds = [
        "lane with spaces",
        "lane/with/slashes",
        "lane-with-emoji-\u{1F680}",
        "lane\u00FC\u00E4\u00F6",
      ];
      for (const laneId of specialIds) {
        const encoded = svc.encodeState(laneId, "state");
        const decoded = svc.decodeState(encoded);
        expect(decoded).not.toBeNull();
        expect(decoded!.laneId).toBe(laneId);
        expect(decoded!.originalState).toBe("state");
      }
    });

    it("handles empty original state", () => {
      const encoded = svc.encodeState("lane-1", "");
      const decoded = svc.decodeState(encoded);
      expect(decoded).toEqual({ laneId: "lane-1", originalState: "" });
    });

    it("rejects empty lane IDs when encoding state", () => {
      expect(() => svc.encodeState("   ", "original-state")).toThrow(
        "laneId",
      );
    });

    it("handles very long state strings", () => {
      const longState = "x".repeat(5000);
      const encoded = svc.encodeState("lane-1", longState);
      const decoded = svc.decodeState(encoded);
      expect(decoded).toEqual({ laneId: "lane-1", originalState: longState });
    });

    it("rejects tampered encoded states", () => {
      const encoded = svc.encodeState("lane-1", "original-state");
      const tampered = encoded.replace(
        Buffer.from("lane-1").toString("base64url"),
        Buffer.from("lane-2").toString("base64url"),
      );
      expect(svc.decodeState(tampered)).toBeNull();
    });
  });

  // =========================================================================
  // 2. OAuth callback detection (isOAuthCallback)
  // =========================================================================

  describe("isOAuthCallback", () => {
    it("detects default callback paths", () => {
      expect(svc.isOAuthCallback("/oauth/callback")).toBe(true);
      expect(svc.isOAuthCallback("/auth/callback")).toBe(true);
      expect(svc.isOAuthCallback("/api/auth/callback")).toBe(true);
      expect(svc.isOAuthCallback("/callback")).toBe(true);
    });

    it("case insensitive matching", () => {
      expect(svc.isOAuthCallback("/OAuth/Callback")).toBe(true);
      expect(svc.isOAuthCallback("/AUTH/CALLBACK")).toBe(true);
      expect(svc.isOAuthCallback("/Api/Auth/Callback")).toBe(true);
    });

    it("ignores query parameters when matching path", () => {
      expect(svc.isOAuthCallback("/oauth/callback?code=abc&state=xyz")).toBe(
        true,
      );
      expect(svc.isOAuthCallback("/auth/callback?foo=bar")).toBe(true);
    });

    it("returns false for non-callback paths", () => {
      expect(svc.isOAuthCallback("/home")).toBe(false);
      expect(svc.isOAuthCallback("/api/users")).toBe(false);
      expect(svc.isOAuthCallback("/oauth")).toBe(false);
      expect(svc.isOAuthCallback("/oauth/callback/extra")).toBe(false);
      expect(svc.isOAuthCallback("/")).toBe(false);
    });
  });

  // =========================================================================
  // 3. Request handling (handleRequest)
  // =========================================================================

  describe("handleRequest", () => {
    it("returns false when disabled", () => {
      const disabled = createOAuthRedirectService({
        logger,
        config: { enabled: false },
        broadcastEvent: (ev) => events.push(ev),
        getRoutes: () => routes,
        getProxyPort: () => 8080,
        getHostnameSuffix: () => ".localhost",
        forwardToPort,
      });

      const req = mockReq("/oauth/callback?code=abc&state=ade:x:y");
      const res = mockRes();
      expect(disabled.handleRequest(req, res)).toBe(false);
      disabled.dispose();
    });

    it("returns false for non-callback URLs", () => {
      const req = mockReq("/api/users?code=abc");
      const res = mockRes();
      expect(svc.handleRequest(req, res)).toBe(false);
    });

    it("returns false when state parameter is missing", () => {
      const req = mockReq("/oauth/callback?code=abc");
      const res = mockRes();
      expect(svc.handleRequest(req, res)).toBe(false);
    });

    it("returns false when state is not ADE-encoded (pass through to normal routing)", () => {
      const req = mockReq("/oauth/callback?code=abc&state=random-state-value");
      const res = mockRes();
      expect(svc.handleRequest(req, res)).toBe(false);
    });

    it("routes callback to correct lane when state is ADE-encoded and route exists", () => {
      routes.push(makeRoute("lane-1", 3001));
      const encoded = svc.encodeState("lane-1", "orig");
      const req = mockReq(
        `/oauth/callback?code=abc&state=${encodeURIComponent(encoded)}`,
      );
      const res = mockRes();

      const handled = svc.handleRequest(req, res);

      expect(handled).toBe(true);
      expect(forwardToPort).toHaveBeenCalledWith(req, res, 3001);
      expect(svc.listSessions()[0].status).toBe("active");
      expect(events.map((event) => event.type)).not.toContain("oauth-callback-routed");
    });

    it("calls forwardToPort with correct targetPort", () => {
      routes.push(makeRoute("lane-A", 4500));
      const encoded = svc.encodeState("lane-A", "s");
      const req = mockReq(
        `/auth/callback?code=xyz&state=${encodeURIComponent(encoded)}`,
      );
      const res = mockRes();

      svc.handleRequest(req, res);

      expect(forwardToPort).toHaveBeenCalledTimes(1);
      expect(forwardToPort.mock.calls[0][2]).toBe(4500);
    });

    it("rewrites state parameter back to original value before forwarding", () => {
      routes.push(makeRoute("lane-1", 3001));
      const encoded = svc.encodeState("lane-1", "my-original-state");
      let forwardedUrl = "";
      forwardToPort.mockImplementation((forwardedReq: { url?: string }) => {
        forwardedUrl = forwardedReq.url ?? "";
      });
      const req = mockReq(
        `/oauth/callback?code=abc&state=${encodeURIComponent(encoded)}`,
      );
      const res = mockRes();

      svc.handleRequest(req, res);

      // During forwarding the req.url should have been temporarily rewritten
      // and then restored. We verify via the forwardToPort call: at call time
      // req.url had the rewritten state.
      expect(forwardedUrl).toContain("state=my-original-state");
      expect(forwardedUrl).not.toContain(encodeURIComponent(encoded));
      expect(req.url).toContain(encodeURIComponent(encoded));
    });

    it("returns 502 error page when lane has no active route", () => {
      // No routes at all
      const encoded = svc.encodeState("lane-missing", "orig");
      const req = mockReq(
        `/oauth/callback?code=abc&state=${encodeURIComponent(encoded)}`,
      );
      const res = mockRes();

      const handled = svc.handleRequest(req, res);

      expect(handled).toBe(true);
      expect(res.writeHead).toHaveBeenCalledWith(502, {
        "Content-Type": "text/html",
      });
      expect(res.end).toHaveBeenCalled();
      expect(forwardToPort).not.toHaveBeenCalled();
    });

    it("error page includes helpful message mentioning the lane name", () => {
      const encoded = svc.encodeState("my-feature-lane", "orig");
      const req = mockReq(
        `/oauth/callback?code=abc&state=${encodeURIComponent(encoded)}`,
      );
      const res = mockRes();

      svc.handleRequest(req, res);

      const html = res.end.mock.calls[0][0] as string;
      expect(html).toContain("my-feature-lane");
      expect(html).toContain("OAuth");
    });

    it("returns 502 when route exists but is inactive", () => {
      routes.push(makeRoute("lane-1", 3001, "inactive"));
      const encoded = svc.encodeState("lane-1", "orig");
      const req = mockReq(
        `/oauth/callback?code=abc&state=${encodeURIComponent(encoded)}`,
      );
      const res = mockRes();

      const handled = svc.handleRequest(req, res);

      expect(handled).toBe(true);
      expect(res.writeHead).toHaveBeenCalledWith(502, {
        "Content-Type": "text/html",
      });
    });

    it("creates OAuth session on successful routing", () => {
      routes.push(makeRoute("lane-1", 3001));
      const encoded = svc.encodeState("lane-1", "orig");
      const req = mockReq(
        `/oauth/callback?code=abc&state=${encodeURIComponent(encoded)}`,
      );
      const res = mockRes();

      svc.handleRequest(req, res);
      finishRes(res);

      const sessions = svc.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].laneId).toBe("lane-1");
      expect(sessions[0].status).toBe("completed");
    });

    it("marks routed sessions failed when the upstream response errors", () => {
      routes.push(makeRoute("lane-1", 3001));
      const encoded = svc.encodeState("lane-1", "orig");
      const req = mockReq(
        `/oauth/callback?code=abc&state=${encodeURIComponent(encoded)}`,
      );
      const res = mockRes();

      svc.handleRequest(req, res);
      finishRes(res, 502);

      const sessions = svc.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("failed");
      expect(sessions[0].error).toContain("status 502");
    });

    it("creates failed OAuth session when route not found", () => {
      const encoded = svc.encodeState("no-such-lane", "orig");
      const req = mockReq(
        `/oauth/callback?code=abc&state=${encodeURIComponent(encoded)}`,
      );
      const res = mockRes();

      svc.handleRequest(req, res);

      const sessions = svc.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].laneId).toBe("no-such-lane");
      expect(sessions[0].status).toBe("failed");
      expect(sessions[0].error).toBeDefined();
    });

    it("rewrites auth starts onto the stable ADE callback URL", async () => {
      routes.push(makeRoute("lane-1", 3001));
      requestUpstream.mockResolvedValue({
        statusCode: 307,
        headers: {
          location:
            "https://accounts.google.com/o/oauth2/v2/auth?state=raw-state&redirect_uri=http%3A%2F%2Flane-1.localhost%3A8080%2Fapi%2Fauth%2Fgoogle%2Fcallback&scope=openid",
          "set-cookie": ["versic-oauth-state=raw-state; Path=/; HttpOnly"],
        },
        body: Buffer.alloc(0),
      });

      const req = mockReq("/api/auth/google", "lane-1.localhost:8080");
      const res = mockRes();

      expect(svc.handleRequest(req, res)).toBe(true);

      await vi.waitFor(() => {
        expect(res.writeHead).toHaveBeenCalled();
      });

      const rewrittenLocation = locationFrom(res);
      expect(rewrittenLocation).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Foauth%2Fcallback");
      expect(rewrittenLocation).toContain("state=ade%3A");
      expect(svc.listSessions()).toHaveLength(1);
      expect(svc.listSessions()[0].status).toBe("pending");
    });

    it("replays the callback response back on the lane host after routing through the stable callback", async () => {
      routes.push(makeRoute("lane-1", 3001));
      requestUpstream
        .mockResolvedValueOnce({
          statusCode: 307,
          headers: {
            location:
              "https://accounts.google.com/o/oauth2/v2/auth?state=raw-state&redirect_uri=http%3A%2F%2Flane-1.localhost%3A8080%2Fapi%2Fauth%2Fgoogle%2Fcallback&scope=openid",
            "set-cookie": [
              "versic-oauth-state=raw-state; Path=/; HttpOnly",
              "versic-oauth-redirect=%2Fdashboard; Path=/",
            ],
          },
          body: Buffer.alloc(0),
        })
        .mockResolvedValueOnce({
          statusCode: 302,
          headers: {
            location: "/dashboard",
            "set-cookie": ["versic-access-token=test-token; Path=/; HttpOnly"],
          },
          body: Buffer.alloc(0),
        });

      const startReq = mockReq("/api/auth/google", "lane-1.localhost:8080");
      const startRes = mockRes();
      expect(svc.handleRequest(startReq, startRes)).toBe(true);
      await vi.waitFor(() => {
        expect(startRes.writeHead).toHaveBeenCalled();
      });

      const rewrittenLocation = locationFrom(startRes)!;
      const encodedState = new URL(rewrittenLocation).searchParams.get("state");
      expect(encodedState).toBeTruthy();

      const callbackReq = mockReq(
        `/oauth/callback?code=test-code&state=${encodeURIComponent(encodedState!)}`,
      );
      const callbackRes = mockRes();
      expect(svc.handleRequest(callbackReq, callbackRes)).toBe(true);

      await vi.waitFor(() => {
        expect(callbackRes.writeHead).toHaveBeenCalled();
      });

      expect(requestUpstream).toHaveBeenCalledTimes(2);
      expect(requestUpstream.mock.calls[1][0].overridePath).toContain("/api/auth/google/callback");
      expect(requestUpstream.mock.calls[1][0].overridePath).toContain("state=raw-state");
      expect(requestUpstream.mock.calls[1][0].overrideHeaders.cookie).toContain("versic-oauth-state=raw-state");
      expect(requestUpstream.mock.calls[1][0].overrideHeaders.host).toBe("lane-1.localhost:8080");

      const finalizeLocation = locationFrom(callbackRes);
      expect(finalizeLocation).toContain("lane-1.localhost:8080/__ade/oauth/finalize?token=");
      const finalizeToken = new URL(finalizeLocation!).searchParams.get("token");
      expect(finalizeToken).toBeTruthy();

      const finalizeReq = mockReq(
        `/__ade/oauth/finalize?token=${encodeURIComponent(finalizeToken!)}`,
        "lane-1.localhost:8080",
      );
      const finalizeRes = mockRes();
      expect(svc.handleRequest(finalizeReq, finalizeRes)).toBe(true);

      expect(finalizeRes.writeHead).toHaveBeenCalledWith(302, {
        location: "/dashboard",
        "set-cookie": ["versic-access-token=test-token; Path=/; HttpOnly"],
      });
      expect(svc.listSessions()).toHaveLength(1);
      expect(svc.listSessions()[0].status).toBe("completed");
    });
  });

  // =========================================================================
  // 4. Multi-lane concurrent OAuth flows
  // =========================================================================

  describe("multi-lane concurrent OAuth flows", () => {
    it("two lanes with different encoded states route correctly", () => {
      routes.push(makeRoute("lane-A", 3001), makeRoute("lane-B", 3002));

      const stateA = svc.encodeState("lane-A", "origA");
      const stateB = svc.encodeState("lane-B", "origB");

      const reqA = mockReq(
        `/oauth/callback?code=a&state=${encodeURIComponent(stateA)}`,
      );
      const reqB = mockReq(
        `/oauth/callback?code=b&state=${encodeURIComponent(stateB)}`,
      );
      const resA = mockRes();
      const resB = mockRes();

      expect(svc.handleRequest(reqA, resA)).toBe(true);
      expect(svc.handleRequest(reqB, resB)).toBe(true);
      finishRes(resA);
      finishRes(resB);

      expect(forwardToPort).toHaveBeenCalledWith(reqA, resA, 3001);
      expect(forwardToPort).toHaveBeenCalledWith(reqB, resB, 3002);
    });

    it("sessions track per-lane", () => {
      routes.push(makeRoute("lane-A", 3001), makeRoute("lane-B", 3002));

      const stateA = svc.encodeState("lane-A", "a");
      const stateB = svc.encodeState("lane-B", "b");

      const resA = mockRes();
      svc.handleRequest(
        mockReq(`/oauth/callback?state=${encodeURIComponent(stateA)}`),
        resA,
      );
      finishRes(resA);
      const resB = mockRes();
      svc.handleRequest(
        mockReq(`/oauth/callback?state=${encodeURIComponent(stateB)}`),
        resB,
      );
      finishRes(resB);

      const sessions = svc.listSessions();
      expect(sessions).toHaveLength(2);

      const laneIds = sessions.map((s) => s.laneId);
      expect(laneIds).toContain("lane-A");
      expect(laneIds).toContain("lane-B");
    });

    it("concurrent callbacks don't interfere with each other", () => {
      routes.push(
        makeRoute("lane-1", 4001),
        makeRoute("lane-2", 4002),
        makeRoute("lane-3", 4003),
      );

      for (const [id, port] of [
        ["lane-1", 4001],
        ["lane-2", 4002],
        ["lane-3", 4003],
      ] as const) {
        const state = svc.encodeState(id, `orig-${id}`);
        const req = mockReq(
          `/oauth/callback?state=${encodeURIComponent(state)}`,
        );
        const res = mockRes();
        svc.handleRequest(req, res);
        finishRes(res);
        expect(forwardToPort).toHaveBeenCalledWith(req, res, port);
      }

      const sessions = svc.listSessions();
      expect(sessions).toHaveLength(3);
      expect(sessions.every((s) => s.status === "completed")).toBe(true);
    });
  });

  // =========================================================================
  // 5. Session tracking
  // =========================================================================

  describe("session tracking", () => {
    it("listSessions returns all sessions", () => {
      routes.push(makeRoute("lane-1", 3001));

      // Successful session
      const s1 = svc.encodeState("lane-1", "a");
      const res1 = mockRes();
      svc.handleRequest(
        mockReq(`/oauth/callback?state=${encodeURIComponent(s1)}`),
        res1,
      );
      finishRes(res1);

      // Failed session (no route)
      const s2 = svc.encodeState("nonexistent", "b");
      svc.handleRequest(
        mockReq(`/oauth/callback?state=${encodeURIComponent(s2)}`),
        mockRes(),
      );

      expect(svc.listSessions()).toHaveLength(2);
    });

    it("sessions have correct status transitions (active -> completed, active -> failed)", () => {
      routes.push(makeRoute("lane-ok", 3001));

      // Completed session
      const ok = svc.encodeState("lane-ok", "s");
      const okRes = mockRes();
      svc.handleRequest(
        mockReq(`/oauth/callback?state=${encodeURIComponent(ok)}`),
        okRes,
      );
      finishRes(okRes);

      // Failed session
      const fail = svc.encodeState("lane-missing", "s");
      svc.handleRequest(
        mockReq(`/oauth/callback?state=${encodeURIComponent(fail)}`),
        mockRes(),
      );

      const sessions = svc.listSessions();
      const completed = sessions.find((s) => s.laneId === "lane-ok");
      const failed = sessions.find((s) => s.laneId === "lane-missing");

      expect(completed!.status).toBe("completed");
      expect(completed!.completedAt).toBeDefined();

      expect(failed!.status).toBe("failed");
      expect(failed!.completedAt).toBeDefined();
      expect(failed!.error).toBeDefined();
    });

    it("broadcastEvent is called for session lifecycle events", () => {
      routes.push(makeRoute("lane-1", 3001));
      const encoded = svc.encodeState("lane-1", "s");
      const res = mockRes();

      svc.handleRequest(
        mockReq(`/oauth/callback?state=${encodeURIComponent(encoded)}`),
        res,
      );
      finishRes(res);

      // Expect session-started, session-completed, and callback-routed events
      const types = events.map((e) => e.type);
      expect(types).toContain("oauth-session-started");
      expect(types).toContain("oauth-session-completed");
      expect(types).toContain("oauth-callback-routed");
    });

    it("broadcastEvent fires session-failed for missing routes", () => {
      const encoded = svc.encodeState("ghost", "s");
      svc.handleRequest(
        mockReq(`/oauth/callback?state=${encodeURIComponent(encoded)}`),
        mockRes(),
      );

      const types = events.map((e) => e.type);
      expect(types).toContain("oauth-session-started");
      expect(types).toContain("oauth-session-failed");
      expect(types).not.toContain("oauth-callback-routed");
    });
  });

  // =========================================================================
  // 6. Redirect URI generation
  // =========================================================================

  describe("redirect URI generation", () => {
    it("generates one stable ADE-managed callback URI for the generic helper", () => {
      const infos = svc.generateRedirectUris();
      expect(infos).toHaveLength(1);
      expect(infos[0].provider).toBe("Generic");
      expect(infos[0].uris).toEqual(["http://localhost:8080/oauth/callback"]);
      expect(infos[0].instructions).toContain("ADE-managed callback URL");
    });

    it("Google provider returns specific URI and instructions", () => {
      const infos = svc.generateRedirectUris("google");
      expect(infos).toHaveLength(1);
      expect(infos[0].provider).toBe("Google");
      expect(infos[0].uris).toEqual(["http://localhost:8080/oauth/callback"]);
      expect(infos[0].instructions).toContain("Google Cloud Console");
    });

    it("GitHub provider returns specific URI and instructions", () => {
      const infos = svc.generateRedirectUris("github");
      expect(infos).toHaveLength(1);
      expect(infos[0].provider).toBe("GitHub");
      expect(infos[0].uris).toEqual(["http://localhost:8080/oauth/callback"]);
      expect(infos[0].instructions).toContain("GitHub OAuth App");
    });

    it("Auth0 provider returns the stable ADE callback URI and instructions", () => {
      const infos = svc.generateRedirectUris("auth0");
      expect(infos).toHaveLength(1);
      expect(infos[0].provider).toBe("Auth0");
      expect(infos[0].uris).toEqual(["http://localhost:8080/oauth/callback"]);
      expect(infos[0].instructions).toContain("Auth0");
      expect(infos[0].instructions).toContain("Allowed Callback URLs");
    });

    it("uses current proxy port in URIs", () => {
      const custom = createOAuthRedirectService({
        logger,
        broadcastEvent: (ev) => events.push(ev),
        getRoutes: () => routes,
        getProxyPort: () => 9999,
        getHostnameSuffix: () => ".localhost",
        forwardToPort,
      });

      const infos = custom.generateRedirectUris("google");
      expect(infos[0].uris[0]).toContain(":9999");
      custom.dispose();
    });

    it("unknown provider falls back to the generic stable callback URI", () => {
      const infos = svc.generateRedirectUris("okta");
      expect(infos).toHaveLength(1);
      expect(infos[0].provider).toBe("okta");
      expect(infos[0].uris).toEqual(["http://localhost:8080/oauth/callback"]);
    });
  });

  // =========================================================================
  // 7. Config updates
  // =========================================================================

  describe("config updates", () => {
    it("updateConfig changes enabled flag", () => {
      svc.updateConfig({ enabled: false });
      expect(svc.getConfig().enabled).toBe(false);

      svc.updateConfig({ enabled: true });
      expect(svc.getConfig().enabled).toBe(true);
    });

    it("updateConfig changes callback paths", () => {
      svc.updateConfig({ callbackPaths: ["/custom/callback"] });
      const cfg = svc.getConfig();
      expect(cfg.callbackPaths).toEqual(["/custom/callback"]);

      // The new path should be detected
      expect(svc.isOAuthCallback("/custom/callback")).toBe(true);
      // Old defaults should no longer match
      expect(svc.isOAuthCallback("/oauth/callback")).toBe(false);
    });

    it("updateConfig rejects malformed callback path payloads", () => {
      expect(() =>
        svc.updateConfig({
          callbackPaths: "/oauth/callback" as unknown as string[],
        }),
      ).toThrow("array of strings");
    });

    it("updateConfig changes routing mode", () => {
      svc.updateConfig({ routingMode: "hostname" });
      expect(svc.getConfig().routingMode).toBe("hostname");
    });

    it("broadcasts config-changed event", () => {
      events.length = 0;
      svc.updateConfig({ enabled: false });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("oauth-config-changed");
      expect(events[0].status).toBeDefined();
      expect(events[0].status!.enabled).toBe(false);
    });
  });

  // =========================================================================
  // 8. Dispose
  // =========================================================================

  describe("dispose", () => {
    it("clears all sessions", () => {
      routes.push(makeRoute("lane-1", 3001));
      const encoded = svc.encodeState("lane-1", "s");
      svc.handleRequest(
        mockReq(`/oauth/callback?state=${encodeURIComponent(encoded)}`),
        mockRes(),
      );
      expect(svc.listSessions().length).toBeGreaterThan(0);

      svc.dispose();
      expect(svc.listSessions()).toHaveLength(0);
    });
  });

  // =========================================================================
  // 9. getStatus
  // =========================================================================

  describe("getStatus", () => {
    it("returns current status with config values", () => {
      const status = svc.getStatus();
      expect(status.enabled).toBe(true);
      expect(status.routingMode).toBe("state-parameter");
      expect(status.callbackPaths).toEqual([
        "/oauth/callback",
        "/auth/callback",
        "/api/auth/callback",
        "/api/auth/google/callback",
        "/callback",
      ]);
      expect(status.activeSessions).toEqual([]);
    });
  });

  // =========================================================================
  // 10. defaultRequestUpstream — timeout, abort/close listeners, body buffering
  // =========================================================================
  //
  // These tests exercise the internal defaultRequestUpstream closure by NOT
  // injecting a `requestUpstream` and driving flow through `handleRequest`.
  // All http.request calls go through our mock so we can simulate upstream
  // responses, timeouts, and client-side events deterministically.
  describe("defaultRequestUpstream (private helper — driven through handleRequest)", () => {
    let nativeSvc: ReturnType<typeof createOAuthRedirectService>;
    let nativeRoutes: ProxyRoute[];
    let nativeEvents: OAuthRedirectEvent[];

    function makeIncomingReq(opts: {
      url: string;
      host: string;
      method: string;
    }): any {
      const req: any = new EventEmitter();
      req.url = opts.url;
      req.headers = { host: opts.host };
      req.method = opts.method;
      req.complete = false;
      return req;
    }

    /**
     * Build a fake upstream ClientRequest returned from http.request().
     * `onEnd` fires whenever the service calls `upstreamReq.end(…)`.
     * `emitResponse(res)` delivers a fake upstream IncomingMessage to the callback.
     * `emitError(err)` fires the "error" listener the service registered.
     */
    function makeFakeUpstream(): {
      upstreamReq: any;
      onEnd: ReturnType<typeof vi.fn>;
      emitResponse: (statusCode: number, headers: Record<string, unknown>, body?: Buffer | string) => void;
      emitError: (err: Error) => void;
      setCallback: (cb: (res: any) => void) => void;
      callback?: (res: any) => void;
    } {
      const onEnd = vi.fn();
      const upstreamReq: any = new EventEmitter();
      upstreamReq.end = onEnd;
      const harness: any = { upstreamReq, onEnd };
      harness.setCallback = (cb: (res: any) => void) => {
        harness.callback = cb;
      };
      harness.emitResponse = (statusCode: number, headers: Record<string, unknown>, body: Buffer | string = "") => {
        const upstreamRes: any = new EventEmitter();
        upstreamRes.statusCode = statusCode;
        upstreamRes.headers = headers;
        // Invoke service-registered callback.
        harness.callback?.(upstreamRes);
        // Deliver body data then end.
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
        upstreamRes.emit("data", buf);
        upstreamRes.emit("end");
      };
      harness.emitError = (err: Error) => {
        upstreamReq.emit("error", err);
      };
      return harness;
    }

    beforeEach(() => {
      httpRequestMock.mockReset();
      nativeRoutes = [];
      nativeEvents = [];
      nativeSvc = createOAuthRedirectService({
        logger: createLogger(),
        broadcastEvent: (ev) => nativeEvents.push(ev),
        getRoutes: () => nativeRoutes,
        getProxyPort: () => 8080,
        getHostnameSuffix: () => ".localhost",
        forwardToPort: vi.fn(),
        // deliberately NO requestUpstream — drives defaultRequestUpstream
      });
    });

    afterEach(() => {
      nativeSvc.dispose();
      vi.useRealTimers();
    });

    // -----------------------------------------------------------------------
    // GET-path (auth-start) covers:
    //   * GET bypasses body buffering → upstreamReq.end() called immediately w/ no args
    //   * 30s timeout rejects with TimeoutError and aborts the AbortController
    //   * After success, a late timer tick is a no-op (settled guard)
    // -----------------------------------------------------------------------

    it("GET request bypasses body buffering: upstreamReq.end() called immediately with no args", () => {
      nativeRoutes.push(makeRoute("lane-1", 3001));
      const fake = makeFakeUpstream();
      httpRequestMock.mockImplementation((_options: any, cb: (res: any) => void) => {
        fake.setCallback(cb);
        return fake.upstreamReq;
      });

      const req = makeIncomingReq({
        url: "/api/auth/google",
        host: "lane-1.localhost:8080",
        method: "GET",
      });
      const res = mockRes();

      expect(nativeSvc.handleRequest(req, res)).toBe(true);

      expect(httpRequestMock).toHaveBeenCalledTimes(1);
      // First end() call should be a single no-arg invocation (no body for GET).
      expect(fake.onEnd).toHaveBeenCalledTimes(1);
      expect(fake.onEnd.mock.calls[0]).toEqual([]);
    });

    it("upstream request signal is an AbortSignal (so aborts cancel the outbound socket)", () => {
      nativeRoutes.push(makeRoute("lane-1", 3001));
      const fake = makeFakeUpstream();
      httpRequestMock.mockImplementation((_options: any, cb: (res: any) => void) => {
        fake.setCallback(cb);
        return fake.upstreamReq;
      });

      const req = makeIncomingReq({
        url: "/api/auth/google",
        host: "lane-1.localhost:8080",
        method: "GET",
      });
      nativeSvc.handleRequest(req, mockRes());

      const options = httpRequestMock.mock.calls[0][0];
      expect(options, "http.request options must be defined").toBeTruthy();
      expect(options.signal, "AbortSignal must be wired to the upstream request").toBeInstanceOf(AbortSignal);
      expect(options.signal.aborted, "signal starts un-aborted").toBe(false);
    });

    it("30s timeout rejects with TimeoutError and aborts the AbortController signal", async () => {
      vi.useFakeTimers();
      nativeRoutes.push(makeRoute("lane-1", 3001));
      const fake = makeFakeUpstream();
      let capturedSignal: AbortSignal | undefined;
      httpRequestMock.mockImplementation((options: any, cb: (res: any) => void) => {
        capturedSignal = options.signal;
        fake.setCallback(cb);
        // Simulate http: when aborted via signal, the request emits an error.
        options.signal?.addEventListener("abort", () => {
          const reason = (options.signal as any).reason;
          fake.emitError(reason instanceof Error ? reason : new Error("aborted"));
        });
        return fake.upstreamReq;
      });

      const req = makeIncomingReq({
        url: "/api/auth/google",
        host: "lane-1.localhost:8080",
        method: "GET",
      });
      const res = mockRes();
      expect(nativeSvc.handleRequest(req, res)).toBe(true);

      // Advance 30 seconds → timeout fires.
      await vi.advanceTimersByTimeAsync(30_000);
      // Let any microtask follow-ups flush.
      await vi.runAllTimersAsync();

      expect(capturedSignal, "signal must have been captured").toBeTruthy();
      expect(capturedSignal!.aborted, "AbortController.abort must fire on timeout").toBe(true);
      const reason = (capturedSignal as any).reason;
      expect(reason, "abort reason should be the TimeoutError").toBeInstanceOf(Error);
      expect(reason.name).toBe("TimeoutError");
      expect(reason.message).toMatch(/timed out after 30/i);

      // handleRequest catches and writes a 502 error page.
      expect(res.writeHead).toHaveBeenCalledWith(502, { "Content-Type": "text/html" });
    });

    it("resolves successfully on upstream response and a subsequent 30s timer tick is a no-op (settled flag)", async () => {
      vi.useFakeTimers();
      nativeRoutes.push(makeRoute("lane-1", 3001));
      const fake = makeFakeUpstream();
      httpRequestMock.mockImplementation((_options: any, cb: (res: any) => void) => {
        fake.setCallback(cb);
        return fake.upstreamReq;
      });

      const req = makeIncomingReq({
        url: "/api/auth/google",
        host: "lane-1.localhost:8080",
        method: "GET",
      });
      const res = mockRes();
      expect(nativeSvc.handleRequest(req, res)).toBe(true);

      // Upstream responds immediately — status 200 w/ a non-redirect location (parsedRedirect is null)
      // so the service just replays the response via sendUpstreamResponse.
      fake.emitResponse(200, {}, "hello");
      await vi.runAllTimersAsync();

      // First writeHead call should be the success replay (status 200), not 502.
      expect(res.writeHead).toHaveBeenCalled();
      const firstCall = res.writeHead.mock.calls[0];
      expect(firstCall[0], "success should not produce a 502").not.toBe(502);

      const writeHeadCountBefore = res.writeHead.mock.calls.length;

      // Fire the 30s timer that the timeout scheduled — cleanup should have
      // cleared it, so we shouldn't see any additional writeHead(502) coming
      // from a "late" timeout path.
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.runAllTimersAsync();

      expect(res.writeHead.mock.calls.length, "settled flag must prevent double-settle from late timeout").toBe(writeHeadCountBefore);
    });

    // -----------------------------------------------------------------------
    // Non-GET path (managed callback) covers:
    //   * POST buffers chunks and ends upstream with a concatenated Buffer
    //   * Client 'aborted' rejects with AbortError and aborts the signal
    //   * Client 'close' before complete rejects with AbortError
    //   * Client 'close' after completion is a no-op
    // -----------------------------------------------------------------------

    /**
     * Set up a pending OAuth start for lane-1 so that subsequent callbacks go
     * through handleManagedCallback (which calls sendUpstreamRequest with the
     * incoming req directly — allowing POST method etc).
     *
     * Returns the encoded state to be passed back in the callback.
     */
    async function primePendingStart(laneId: string, targetPort: number): Promise<string> {
      nativeRoutes.push(makeRoute(laneId, targetPort));
      const fake = makeFakeUpstream();
      httpRequestMock.mockImplementationOnce((_options: any, cb: (res: any) => void) => {
        fake.setCallback(cb);
        return fake.upstreamReq;
      });

      const startReq = makeIncomingReq({
        url: "/api/auth/google",
        host: `${laneId}.localhost:8080`,
        method: "GET",
      });
      const startRes = mockRes();
      expect(nativeSvc.handleRequest(startReq, startRes)).toBe(true);

      fake.emitResponse(307, {
        location:
          "https://accounts.google.com/o/oauth2/v2/auth?state=raw-state&redirect_uri=http%3A%2F%2Flane-1.localhost%3A8080%2Fapi%2Fauth%2Fgoogle%2Fcallback&scope=openid",
      });

      // Wait for the auth-start promise to settle (microtask flush).
      await vi.waitFor(() => {
        expect(startRes.writeHead).toHaveBeenCalled();
      });

      const rewrittenLocation = locationFrom(startRes);
      expect(rewrittenLocation, "auth-start must rewrite to the stable callback").toBeTruthy();
      const encodedState = new URL(rewrittenLocation!).searchParams.get("state");
      expect(encodedState, "rewritten URL must embed an ADE state").toBeTruthy();
      return encodedState!;
    }

    it("POST callback buffers chunks and sends a concatenated Buffer to upstreamReq.end()", async () => {
      const encodedState = await primePendingStart("lane-1", 3001);

      // Now set up the upstream for the managed callback call.
      const fake = makeFakeUpstream();
      httpRequestMock.mockImplementationOnce((_options: any, cb: (res: any) => void) => {
        fake.setCallback(cb);
        return fake.upstreamReq;
      });

      const callbackReq = makeIncomingReq({
        url: `/oauth/callback?code=xyz&state=${encodeURIComponent(encodedState)}`,
        host: "lane-1.localhost:8080",
        method: "POST",
      });
      const callbackRes = mockRes();
      expect(nativeSvc.handleRequest(callbackReq, callbackRes)).toBe(true);

      // For POST, the service should NOT have called end() yet — it's waiting for body end.
      expect(fake.onEnd, "POST must not call end() before client 'end' fires").not.toHaveBeenCalled();

      // Feed body chunks (mix Buffer + string to exercise both branches).
      callbackReq.emit("data", Buffer.from("hello "));
      callbackReq.emit("data", "world");
      callbackReq.emit("end");

      // Service synchronously forwards end() with the concatenated buffer.
      expect(fake.onEnd).toHaveBeenCalledTimes(1);
      const endArg = fake.onEnd.mock.calls[0][0];
      expect(Buffer.isBuffer(endArg), "upstream end() should receive a Buffer").toBe(true);
      expect((endArg as Buffer).toString("utf8")).toBe("hello world");

      // Complete the upstream so the flow can fully settle (no dangling timers).
      fake.emitResponse(200, {}, "ok");
      await vi.waitFor(() => {
        expect(callbackRes.writeHead).toHaveBeenCalled();
      });
    });

    it("client 'aborted' event rejects with AbortError and aborts the AbortController signal", async () => {
      const encodedState = await primePendingStart("lane-1", 3001);

      const fake = makeFakeUpstream();
      let capturedSignal: AbortSignal | undefined;
      httpRequestMock.mockImplementationOnce((options: any, cb: (res: any) => void) => {
        capturedSignal = options.signal;
        fake.setCallback(cb);
        return fake.upstreamReq;
      });

      const callbackReq = makeIncomingReq({
        url: `/oauth/callback?code=xyz&state=${encodeURIComponent(encodedState)}`,
        host: "lane-1.localhost:8080",
        method: "POST",
      });
      const callbackRes = mockRes();
      expect(nativeSvc.handleRequest(callbackReq, callbackRes)).toBe(true);

      callbackReq.emit("aborted");

      await vi.waitFor(() => {
        expect(callbackRes.writeHead).toHaveBeenCalledWith(502, { "Content-Type": "text/html" });
      });

      expect(capturedSignal!.aborted, "AbortController must have been aborted").toBe(true);
      const reason = (capturedSignal as any).reason;
      expect(reason, "abort reason should be an AbortError").toBeInstanceOf(Error);
      expect(reason.name).toBe("AbortError");
    });

    it("client 'close' event before req.complete rejects with AbortError", async () => {
      const encodedState = await primePendingStart("lane-1", 3001);

      const fake = makeFakeUpstream();
      let capturedSignal: AbortSignal | undefined;
      httpRequestMock.mockImplementationOnce((options: any, cb: (res: any) => void) => {
        capturedSignal = options.signal;
        fake.setCallback(cb);
        return fake.upstreamReq;
      });

      const callbackReq = makeIncomingReq({
        url: `/oauth/callback?code=xyz&state=${encodeURIComponent(encodedState)}`,
        host: "lane-1.localhost:8080",
        method: "POST",
      });
      // Explicitly mark the request as incomplete → close should reject.
      callbackReq.complete = false;
      const callbackRes = mockRes();
      expect(nativeSvc.handleRequest(callbackReq, callbackRes)).toBe(true);

      callbackReq.emit("close");

      await vi.waitFor(() => {
        expect(callbackRes.writeHead).toHaveBeenCalledWith(502, { "Content-Type": "text/html" });
      });

      expect(capturedSignal!.aborted).toBe(true);
      expect((capturedSignal as any).reason).toBeInstanceOf(Error);
      expect((capturedSignal as any).reason.name).toBe("AbortError");
    });

    it("client 'close' fired AFTER the upstream response has settled is a no-op", async () => {
      const encodedState = await primePendingStart("lane-1", 3001);

      const fake = makeFakeUpstream();
      httpRequestMock.mockImplementationOnce((_options: any, cb: (res: any) => void) => {
        fake.setCallback(cb);
        return fake.upstreamReq;
      });

      const callbackReq = makeIncomingReq({
        url: `/oauth/callback?code=xyz&state=${encodeURIComponent(encodedState)}`,
        host: "lane-1.localhost:8080",
        method: "POST",
      });
      const callbackRes = mockRes();
      expect(nativeSvc.handleRequest(callbackReq, callbackRes)).toBe(true);

      // Drive body end → upstream end → response.
      callbackReq.emit("end");
      fake.emitResponse(200, {}, "done");

      // Wait for the managed-callback promise to settle (it writes a 302 redirect).
      await vi.waitFor(() => {
        expect(callbackRes.writeHead).toHaveBeenCalled();
      });
      const callsBefore = callbackRes.writeHead.mock.calls.length;

      // Now simulate the usual late "close" that fires when the client socket tears down.
      callbackReq.complete = true;
      callbackReq.emit("close");

      // No second writeHead should happen (the settled flag + listener cleanup prevent it).
      expect(callbackRes.writeHead.mock.calls.length, "late 'close' must be a no-op after settlement").toBe(callsBefore);
    });
  });
});
