"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  API_KEY_PATTERN,
  AUTH_SESSION_ID,
  SCOPES_ADE_APP,
  SCOPES_CUSTOM,
  authorizeParams,
  createConnect,
  createPkcePair,
} = require("../connect");
const { createData } = require("../data");
const { createApi, createSdk, response } = require("./support");

/**
 * The two parameters the host owns and refuses by name
 * (`PLUGIN_AUTH_RESERVED_PARAMS`). Sending one is `invalid_args` and the whole
 * sign-in fails.
 */
const RESERVED_PARAMS = ["redirect_uri", "state"];

function build(overrides = {}) {
  const sdk = createSdk(overrides.sdk ?? {});
  // `writeToken` really writes, exactly as `linearApi.createLinearApi` does —
  // the point of these tests is WHICH secrets end up in the store, and a
  // no-op stand-in would let a flow that stored nothing pass.
  const api = createApi({
    writeToken: async ({ accessToken, refreshToken, expiresAt }) => {
      await sdk.secrets.set("LINEAR_ACCESS_TOKEN", accessToken);
      await sdk.secrets.set("LINEAR_AUTH_MODE", "oauth");
      if (refreshToken) await sdk.secrets.set("LINEAR_REFRESH_TOKEN", refreshToken);
      if (expiresAt) await sdk.secrets.set("LINEAR_TOKEN_EXPIRES_AT", expiresAt);
    },
    ...(overrides.api ?? {}),
  });
  const data = createData({ sdk, api });
  const fetches = [];
  const queue = [...(overrides.fetches ?? [])];
  const fetchImpl = async (url, init) => {
    fetches.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error("fetch called with nothing queued");
    if (next instanceof Error) throw next;
    return next;
  };
  const connect = createConnect({
    sdk,
    api,
    data,
    fetch: fetchImpl,
    now: () => Date.parse("2026-08-31T00:00:00.000Z"),
  });
  return { sdk, api, data, connect, fetches };
}

describe("PKCE, which has to be the plugin's own", () => {
  it("mints a fresh verifier every time", () => {
    // A guessable verifier defeats the whole point of the exchange being the
    // plugin's, so it comes from node:crypto and never from Math.random.
    const pairs = Array.from({ length: 20 }, () => createPkcePair().verifier);
    assert.equal(new Set(pairs).size, 20);
  });

  it("uses base64url with no padding, which is what Linear accepts", () => {
    const { verifier, challenge } = createPkcePair();
    assert.match(verifier, /^[A-Za-z0-9_-]+$/);
    assert.match(challenge, /^[A-Za-z0-9_-]+$/);
    assert.ok(!verifier.includes("="));
  });

  it("derives the challenge from the verifier with S256", () => {
    const crypto = require("node:crypto");
    const { verifier, challenge } = createPkcePair();
    assert.equal(challenge, crypto.createHash("sha256").update(verifier).digest("base64url"));
  });
});

describe("the authorize parameters", () => {
  const params = authorizeParams("client-1", "challenge", SCOPES_ADE_APP);

  it("names none of the two the host owns", () => {
    for (const name of RESERVED_PARAMS) assert.ok(!(name in params), `${name} is the host's`);
  });

  it("sends the same values the built-in sends", () => {
    // A workspace that consented to ADE must see the same screen.
    assert.deepEqual(params, {
      client_id: "client-1",
      response_type: "code",
      scope: "read,write,admin",
      actor: "user",
      prompt: "consent",
      code_challenge_method: "S256",
      code_challenge: "challenge",
    });
  });

  it("asks for admin only for ADE's own app, because webhooks need it", () => {
    // Linear only delivers data-change webhooks for a workspace whose
    // authorization carries admin; a custom client arranges its own.
    assert.equal(SCOPES_ADE_APP, "read,write,admin");
    assert.equal(SCOPES_CUSTOM, "read,write");
  });
});

describe("the release-day handoff", () => {
  it("records what the user answered, so the panel can say so", async () => {
    const { sdk, connect } = build({ sdk: { handoff: { builtin: "linear", status: "accepted", secretNames: [] } } });
    const result = await connect.requestHandoff();
    assert.equal(result.status, "accepted");
    assert.equal(await sdk.memory.get("handoffStatus"), "accepted");
  });

  it("treats a decline as a normal state, not an error", async () => {
    // The plugin is simply unconnected, and the ordinary sign-in is still there.
    const { connect } = build({ sdk: { handoff: { builtin: "linear", status: "declined", secretNames: [] } } });
    const result = await connect.requestHandoff();
    assert.equal(result.status, "declined");
  });

  it("survives a host that refused the ask", async () => {
    const sdk = createSdk({});
    sdk.auth.requestHandoff = async () => { throw new Error("not permitted"); };
    const api = createApi();
    const connect = createConnect({ sdk, api, data: createData({ sdk, api }) });
    assert.equal((await connect.requestHandoff()).status, "error");
  });
});

describe("what the settings panel can offer", () => {
  it("can start OAuth on a build that lends an official client, with nothing stored", async () => {
    // The broker is what closed this: `client_id` identifies ADE to Linear, and
    // before `auth.officialClient` existed the only way one reached the plugin
    // was through the credential handoff — so a fresh install that declined it
    // could never sign in.
    const { connect } = build();
    const status = await connect.connectStatus();
    assert.equal(status.canOAuth, true);
    assert.equal(status.clientSource, "official");
    assert.equal(status.oauthBlockedReason, null);
  });

  it("cannot start OAuth where ADE lends nothing, and says why in a sentence", async () => {
    // A non-owner build, or a host with no broker. Producing an authorize URL
    // Linear would refuse is worse than saying so.
    const { connect } = build({ sdk: { officialClient: null } });
    const status = await connect.connectStatus();
    assert.equal(status.canOAuth, false);
    assert.equal(status.clientSource, null);
    assert.match(status.oauthBlockedReason, /API key/);
  });

  it("calls a stored id that is NOT ADE's a custom client", async () => {
    // Which app a stored id belongs to decides the scope list, and the only
    // honest way to decide is to compare it against ADE's.
    const built = build();
    await built.sdk.secrets.set("LINEAR_OAUTH_CLIENT_ID", "somebody-elses-app");
    const status = await built.connect.connectStatus();
    assert.equal(status.canOAuth, true);
    assert.equal(status.clientSource, "custom");
  });

  it("recognises a stored id that IS ADE's as official", async () => {
    // A client id that arrived through the handoff must not be mistaken for a
    // custom one, or the sign-in would drop the webhook grant.
    const built = build();
    await built.sdk.secrets.set("LINEAR_OAUTH_CLIENT_ID", "ade-official-client");
    assert.equal((await built.connect.connectStatus()).clientSource, "official");
  });

  it("stops offering the handoff once it has been answered", async () => {
    const { sdk, connect } = build({ sdk: { handoff: { builtin: "linear", status: "declined", secretNames: [] } } });
    assert.equal((await connect.connectStatus()).canHandoff, true);
    await connect.requestHandoff();
    assert.equal((await connect.connectStatus()).canHandoff, false);
    assert.equal(await sdk.memory.get("handoffStatus"), "declined");
  });
});

describe("beginning the sign-in", () => {
  async function ready(overrides = {}) {
    const built = build(overrides);
    await built.sdk.secrets.set("LINEAR_OAUTH_CLIENT_ID", "client-1");
    return built;
  }

  it("hands back an authSession for the action to return verbatim", async () => {
    // The host fills in the live URL on the way to whichever client the user is
    // on; a plugin must not open a browser itself.
    const { connect } = await ready();
    const result = await connect.begin();
    assert.equal(result.ok, true);
    assert.deepEqual(result.authSession, { sessionId: AUTH_SESSION_ID });
  });

  it("asks for the narrower grant for a client the USER registered", async () => {
    // Webhooks on an app the user registered are the user's to arrange, so the
    // extra grant would be asking for a permission nothing here would use.
    const { sdk, connect } = await ready();
    await connect.begin();
    assert.equal(sdk.calls.find(([name]) => name === "auth.beginSession")[2].scope, SCOPES_CUSTOM);
  });

  it("asks for admin for ADE's own app, because its webhooks need it", async () => {
    // Linear only delivers data-change webhooks for a workspace whose
    // authorization carries `admin`.
    const built = build();
    await built.sdk.secrets.set("LINEAR_OAUTH_CLIENT_ID", "ade-official-client");
    await built.connect.begin();
    const scope = built.sdk.calls.find(([name]) => name === "auth.beginSession")[2].scope;
    assert.equal(scope, SCOPES_ADE_APP);
  });

  it("takes the scope list from the BROKER when it names one", () => {
    // The registration is ADE's, so the grant it needs is ADE's to state — the
    // plugin's constant is the fallback, not the authority.
    assert.equal(SCOPES_ADE_APP, "read,write,admin");
  });

  it("refuses before it starts where ADE lends nothing and nothing is stored", async () => {
    const { sdk, connect } = build({ sdk: { officialClient: null } });
    const result = await connect.begin();
    assert.equal(result.code, "no_client_id");
    assert.equal(sdk.calls.some(([name]) => name === "auth.beginSession"), false);
  });

  it("says a sign-in is already running rather than throwing", async () => {
    const busy = Object.assign(new Error("busy"), { code: "auth_session_busy" });
    const { connect } = await ready({ sdk: { beginSessionThrows: busy } });
    assert.equal((await connect.begin()).code, "busy");
  });

  it("says so when nothing on the machine can show a window", async () => {
    const nothing = Object.assign(new Error("no window"), { code: "auth_unavailable" });
    const { connect } = await ready({ sdk: { beginSessionThrows: nothing } });
    assert.equal((await connect.begin()).code, "unavailable");
  });
});

describe("finishing the sign-in", () => {
  async function started(overrides = {}) {
    const built = build(overrides);
    await built.sdk.secrets.set("LINEAR_OAUTH_CLIENT_ID", "client-1");
    await built.connect.begin();
    return built;
  }

  function completed(overrides = {}) {
    return {
      event: "auth.completed",
      sessionId: AUTH_SESSION_ID,
      attempt: "attempt-1",
      ok: true,
      params: { code: "the-code" },
      ...overrides,
    };
  }

  it("exchanges the code and stores the token", async () => {
    const { sdk, connect, fetches } = await started({
      fetches: [response(200, { access_token: "at", refresh_token: "rt", expires_in: 3600 })],
    });
    const result = await connect.complete(completed());
    assert.equal(result.ok, true);
    assert.equal(await sdk.secrets.get("LINEAR_ACCESS_TOKEN"), "at");
    assert.equal(await sdk.secrets.get("LINEAR_AUTH_MODE"), "oauth");
    assert.equal(await sdk.secrets.get("LINEAR_REFRESH_TOKEN"), "rt");
    assert.match(fetches[0].url, /oauth\/token$/);
  });

  it("sends the verifier and no client secret", async () => {
    // ADE's secret is ADE's identity to Linear, and the handoff withholds it.
    // The verifier is what stands in for it.
    const { connect, fetches } = await started({ fetches: [response(200, { access_token: "at", expires_in: 60 })] });
    await connect.complete(completed());
    const body = new URLSearchParams(fetches[0].init.body);
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code"), "the-code");
    assert.equal(body.get("client_id"), "client-1");
    assert.ok(body.get("code_verifier"));
    assert.equal(body.get("client_secret"), null);
  });

  it("keeps the client id, because the REFRESH will need it", async () => {
    const { sdk, connect } = await started({ fetches: [response(200, { access_token: "at", expires_in: 60 })] });
    await connect.complete(completed());
    assert.equal(await sdk.secrets.get("LINEAR_OAUTH_CLIENT_ID"), "client-1");
  });

  it("computes the expiry from expires_in against the injected clock", async () => {
    const { sdk, connect } = await started({ fetches: [response(200, { access_token: "at", expires_in: 3600 })] });
    await connect.complete(completed());
    assert.equal(await sdk.secrets.get("LINEAR_TOKEN_EXPIRES_AT"), "2026-08-31T01:00:00.000Z");
  });

  it("drops a callback from a flow that was cancelled and restarted", async () => {
    // A late callback from the first flow would otherwise be exchanged against
    // the second flow's verifier, failing confusingly instead of quietly.
    const { connect } = await started({ fetches: [] });
    const result = await connect.complete(completed({ attempt: "attempt-0" }));
    assert.equal(result.ignored, "attempt");
  });

  it("drops a completion for a different sign-in entirely", async () => {
    const { connect } = await started({ fetches: [] });
    assert.equal((await connect.complete(completed({ sessionId: "github" }))).ignored, "session");
  });

  it("drops a completion when no flow is live", async () => {
    const { connect } = build();
    assert.equal((await connect.complete(completed())).ignored, "attempt");
  });

  it("says nothing when the user closed the window", async () => {
    // They know they did it.
    const { connect } = await started({ fetches: [] });
    const result = await connect.complete(completed({ ok: false, reason: "canceled", params: undefined }));
    assert.equal(result.ok, false);
    assert.equal(result.silent, true);
  });

  it("reports the other three failure reasons", async () => {
    for (const reason of ["expired", "denied", "state_mismatch"]) {
      const { connect } = await started({ fetches: [] });
      const result = await connect.complete(completed({ ok: false, reason, params: undefined }));
      assert.equal(result.ok, false);
      assert.ok(result.message.length > 0);
      assert.ok(!result.silent);
    }
  });

  it("reports a completion that carried no code", async () => {
    const { connect } = await started({ fetches: [] });
    assert.match((await connect.complete(completed({ params: {} }))).message, /without a code/);
  });

  it("reports what Linear said when it refused the exchange", async () => {
    const { connect } = await started({
      fetches: [response(400, { error: "invalid_grant", error_description: "code expired" })],
    });
    assert.match((await connect.complete(completed())).message, /code expired/);
  });

  it("reports a token endpoint it could not reach", async () => {
    const { connect } = await started({ fetches: [new Error("ECONNREFUSED")] });
    assert.match((await connect.complete(completed())).message, /Could not reach Linear/);
  });

  it("never stores anything when the exchange failed", async () => {
    const { sdk, connect } = await started({ fetches: [response(500, "")] });
    await connect.complete(completed());
    assert.equal(await sdk.secrets.get("LINEAR_ACCESS_TOKEN"), null);
  });
});

describe("pasting an API key", () => {
  it("accepts a real Linear key", () => {
    assert.match("lin_api_abcdefghijklmnopqrstuvwxyz", API_KEY_PATTERN);
  });

  it("refuses an OAuth token pasted into the key box", async () => {
    // Sending one as a bare `authorization` value is a 400 about the header,
    // not a 401, so the failure would land three screens later as "Linear
    // refused this credential".
    const { sdk, connect } = build();
    const result = await connect.saveApiKey("lin_oauth_abcdefghijklmnopqrst");
    assert.equal(result.ok, false);
    assert.match(result.message, /lin_api_/);
    assert.equal(await sdk.secrets.get("LINEAR_ACCESS_TOKEN"), null);
  });

  it("refuses an empty paste", async () => {
    assert.equal((await build().connect.saveApiKey("  ")).ok, false);
  });

  it("stores the key in manual mode", async () => {
    const { sdk, connect } = build();
    const result = await connect.saveApiKey("  lin_api_abcdefghijklmnopqrstuv  ");
    assert.equal(result.ok, true);
    assert.equal(await sdk.secrets.get("LINEAR_ACCESS_TOKEN"), "lin_api_abcdefghijklmnopqrstuv");
    assert.equal(await sdk.secrets.get("LINEAR_AUTH_MODE"), "manual");
  });

  it("clears an OAuth expiry and refresh token the key is replacing", async () => {
    // An API key does not expire, and a stale expiry would send the client
    // refreshing a credential that has no refresh grant.
    const { sdk, connect } = build();
    await sdk.secrets.set("LINEAR_REFRESH_TOKEN", "rt");
    await sdk.secrets.set("LINEAR_TOKEN_EXPIRES_AT", "2026-01-01T00:00:00.000Z");
    await connect.saveApiKey("lin_api_abcdefghijklmnopqrstuv");
    assert.equal(await sdk.secrets.get("LINEAR_REFRESH_TOKEN"), null);
    assert.equal(await sdk.secrets.get("LINEAR_TOKEN_EXPIRES_AT"), null);
  });

  it("reports a key Linear then refused", async () => {
    const { connect } = build({
      api: { getConnectionIdentity: async () => { throw Object.assign(new Error("bad key"), { code: "unauthorized" }); } },
    });
    const result = await connect.saveApiKey("lin_api_abcdefghijklmnopqrstuv");
    assert.equal(result.ok, false);
    assert.equal(result.message, "bad key");
  });
});

describe("disconnecting", () => {
  it("forgets every secret, not just the token", async () => {
    // Leaving the refresh token behind means a disconnected plugin still holds
    // a live grant against the user's workspace.
    const { sdk, connect } = build();
    for (const name of ["LINEAR_ACCESS_TOKEN", "LINEAR_REFRESH_TOKEN", "LINEAR_TOKEN_EXPIRES_AT", "LINEAR_AUTH_MODE"]) {
      await sdk.secrets.set(name, "x");
    }
    await connect.disconnect();
    for (const name of ["LINEAR_ACCESS_TOKEN", "LINEAR_REFRESH_TOKEN", "LINEAR_TOKEN_EXPIRES_AT", "LINEAR_AUTH_MODE"]) {
      assert.equal(await sdk.secrets.get(name), null, name);
    }
  });

  it("keeps the client id, so reconnecting by OAuth still works", async () => {
    const { sdk, connect } = build();
    await sdk.secrets.set("LINEAR_OAUTH_CLIENT_ID", "client-1");
    await connect.disconnect();
    assert.equal(await sdk.secrets.get("LINEAR_OAUTH_CLIENT_ID"), "client-1");
  });

  it("cancelling is safe when nothing is running", async () => {
    await assert.doesNotReject(() => build().connect.cancel());
  });
});
