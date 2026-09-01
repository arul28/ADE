// Getting a Linear credential into this plugin's own secret store.
//
// Three ways in, in the order a real user meets them:
//
//   1. **The handoff.** On the day this plugin replaces the compiled
//      integration, every existing user already has a working Linear
//      connection. `ade.auth.requestHandoff("linear")` shows the person a card
//      naming exactly which secrets move, and their yes copies them. Without
//      it, release day is a day on which everyone reconnects.
//   2. **OAuth.** The host opens the browser (or the phone's in-app auth view),
//      owns the loopback listener and the `state`; the plugin supplies the
//      query parameters, holds the PKCE verifier, and performs the exchange
//      itself over a host it declared in `network`.
//   3. **An API key.** `lin_api_…`, pasted. Linear takes it as a BARE
//      `authorization` value, which is why the mode is stored beside it.
//
// ## Why the plugin performs the exchange
//
// ADE brokers the AUTHORIZATION and never the credential: the host hands back
// the callback parameters as data, and the token exists for the first time
// inside this process. A host that held the token would have to refresh it,
// and refreshing a grant it cannot use is a responsibility with no matching
// capability.
//
// ## The client id is not ours to invent
//
// `client_id` identifies ADE to Linear, and no SDK verb hands a plugin ADE's.
// It arrives exactly one way: `LINEAR_OAUTH_CLIENT_ID` through the handoff. So
// a user who declines the handoff and has no client id of their own can
// connect by API key and not by OAuth. That is a real gap and it is in the
// report — see `connectStatus`, which says so in the panel rather than
// producing an authorize URL that Linear would refuse.

"use strict";

const crypto = require("node:crypto");

const {
  SECRET_ACCESS_TOKEN,
  SECRET_AUTH_MODE,
  SECRET_CLIENT_ID,
  SECRET_EXPIRES_AT,
  SECRET_REFRESH_TOKEN,
  TOKEN_URL,
} = require("./linearApi");

/** The one `authSessions[].id` the manifest declares. */
const AUTH_SESSION_ID = "linear";

/**
 * The scopes, ported from `linearOAuthService.ts:260`.
 *
 * `admin` is not ambition. Linear only delivers data-change webhooks for a
 * workspace whose authorization carries it, so an OAuth connection without
 * `admin` is one where the ingress channel silently never fires — and a
 * webhook that never fires is indistinguishable from a workspace where nothing
 * happened. The built-in narrows to `read,write` for a CUSTOM OAuth client,
 * where the user registered the app themselves and webhooks are their own to
 * arrange; the same rule applies here.
 */
const SCOPES_ADE_APP = "read,write,admin";
const SCOPES_CUSTOM = "read,write";

/** A Linear personal API key. Matched before it is stored so a paste of the wrong string is refused here. */
const API_KEY_PATTERN = /^lin_api_[A-Za-z0-9]{20,}$/;

/**
 * A PKCE pair.
 *
 * S256 with a 32-byte verifier, base64url with no padding — the shape Linear
 * accepts and the shape the built-in sends. Generated with `node:crypto`
 * rather than `Math.random`, because a guessable verifier defeats the whole
 * point of the exchange being the plugin's.
 */
function createPkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * The authorize parameters, minus the two the host owns.
 *
 * `redirect_uri` and `state` are refused by name
 * (`PLUGIN_AUTH_RESERVED_PARAMS`) — the host mints and checks both. Everything
 * else is byte-for-byte what `buildAuthorizeUrl` sends, so a workspace that
 * consented to ADE sees the same screen.
 */
function authorizeParams(clientId, challenge, scopes) {
  return {
    client_id: clientId,
    response_type: "code",
    scope: scopes,
    actor: "user",
    prompt: "consent",
    code_challenge_method: "S256",
    code_challenge: challenge,
  };
}

/**
 * Build the connection manager.
 *
 * `sdk`, `api`, `fetch` and `now` are injected. The whole flow — begin,
 * complete, exchange, store — runs in a test with no browser and no Linear.
 */
function createConnect(options = {}) {
  const {
    sdk,
    api,
    data,
    fetch: fetchImpl = globalThis.fetch,
    log = () => {},
    now = () => Date.now(),
    tokenUrl = TOKEN_URL,
  } = options;
  if (!sdk || !api) throw new TypeError("createConnect needs sdk and api");

  /**
   * The live flow's verifier and attempt.
   *
   * In memory, never stored: a PKCE verifier that outlived the flow it belongs
   * to is a secret with no purpose and one more thing that could leak. One
   * live attempt at a time, which is also what the host enforces
   * (`auth_session_busy`).
   */
  let pending = null;

  /** The stored OAuth client id, or `null` when only the handoff could supply one. */
  async function clientId() {
    const stored = await sdk.secrets.get(SECRET_CLIENT_ID).catch(() => null);
    return stored ? String(stored).trim() : null;
  }

  /**
   * Ask ADE for the credential it holds for the built-in Linear surface.
   *
   * Asked ONCE per install by the host: after an answer, the same call returns
   * that answer without showing a card again. A `declined` is NOT an error and
   * is never reported as one — the plugin is simply unconnected and the
   * ordinary sign-in is still there.
   */
  async function requestHandoff() {
    let result;
    try {
      result = await sdk.auth.requestHandoff("linear");
    } catch (error) {
      log("warn", `Could not ask for the Linear credential handoff: ${error?.message ?? error}`);
      return { status: "error", message: error?.message ?? String(error) };
    }
    await sdk.memory.set("handoffStatus", result?.status ?? null).catch(() => {});
    if (result?.status === "accepted") {
      log("info", "Adopted ADE's existing Linear connection.");
      await data?.refreshConnection().catch(() => {});
    }
    return result ?? { status: "empty" };
  }

  /**
   * What the settings panel should offer.
   *
   * Three states, because they need three different buttons: a connection that
   * works, a machine that can start OAuth, and a machine that can only take a
   * pasted key. Computing it here rather than in the panel means the CLI and
   * the phone give the same answer.
   */
  async function connectStatus() {
    const credential = await api.readCredential().catch(() => ({ token: null }));
    const id = await clientId();
    const handoffStatus = (await sdk.memory.get("handoffStatus").catch(() => null)) ?? null;
    return {
      connected: Boolean(credential.token),
      authMode: credential.authMode ?? null,
      canOAuth: Boolean(id),
      canHandoff: handoffStatus === null,
      handoffStatus,
      // Said plainly, because the alternative is an authorize URL Linear
      // refuses and a user who cannot tell why.
      oauthBlockedReason: id
        ? null
        : "OAuth needs ADE's Linear client id, which arrives with the connection handoff. Adopt ADE's connection, or paste a Linear API key.",
    };
  }

  /**
   * Start the sign-in.
   *
   * Returns `{authSession: {sessionId}}` for the action handler to return
   * verbatim: the host fills in the live URL on the way to whichever client the
   * user is on, and THAT client presents it — the system browser on desktop, an
   * in-app auth session on the phone. A plugin must not open a browser itself;
   * `openUrl` leaves the app with no way back, which is the gap this verb
   * exists to close.
   */
  async function begin() {
    const id = await clientId();
    if (!id) {
      const status = await connectStatus();
      return { ok: false, message: status.oauthBlockedReason, code: "no_client_id" };
    }
    const pkce = createPkcePair();
    // Custom clients keep the narrower grant. `handoffStatus === "accepted"`
    // is what says the client id is ADE's own rather than one the user pasted.
    const handoffStatus = await sdk.memory.get("handoffStatus").catch(() => null);
    const scopes = handoffStatus === "accepted" ? SCOPES_ADE_APP : SCOPES_CUSTOM;

    let start;
    try {
      start = await sdk.auth.beginSession({
        sessionId: AUTH_SESSION_ID,
        params: authorizeParams(id, pkce.challenge, scopes),
      });
    } catch (error) {
      if (error?.code === "auth_session_busy") {
        return { ok: false, message: "A Linear sign-in is already running.", code: "busy" };
      }
      if (error?.code === "auth_unavailable") {
        return { ok: false, message: "Nothing on this machine can show a sign-in window.", code: "unavailable" };
      }
      return { ok: false, message: error?.message ?? "Could not start the Linear sign-in.", code: error?.code ?? null };
    }

    pending = {
      attempt: start.attempt,
      verifier: pkce.verifier,
      redirectUri: start.redirectUri,
      clientId: id,
    };
    return { ok: true, authSession: { sessionId: AUTH_SESSION_ID }, transport: start.transport };
  }

  /** Give up on a running flow. Idempotent, and safe after it already finished. */
  async function cancel() {
    pending = null;
    await sdk.auth.cancelSession(AUTH_SESSION_ID).catch(() => {});
  }

  /**
   * Handle one `auth.completed`.
   *
   * The `attempt` check is what makes a cancelled-then-restarted flow safe: a
   * late callback from the first flow carries the first attempt and is dropped
   * rather than exchanged against the second flow's verifier, which would fail
   * confusingly instead of being ignored quietly.
   */
  async function complete(payload) {
    if (payload?.sessionId !== AUTH_SESSION_ID) return { ignored: "session" };
    const live = pending;
    if (!live || payload.attempt !== live.attempt) return { ignored: "attempt" };
    pending = null;

    if (payload.ok !== true) {
      // `canceled` is the user closing the window and needs no message: they
      // know they did it. Everything else is a state the panel must show.
      if (payload.reason === "canceled") return { ok: false, silent: true, reason: payload.reason };
      return {
        ok: false,
        reason: payload.reason,
        message: payload.message ?? `Linear sign-in ${payload.reason}.`,
      };
    }

    const code = typeof payload.params?.code === "string" ? payload.params.code.trim() : "";
    if (!code) return { ok: false, message: "Linear completed the sign-in without a code." };

    try {
      await exchange({ code, verifier: live.verifier, redirectUri: live.redirectUri, clientId: live.clientId });
    } catch (error) {
      return { ok: false, message: error?.message ?? "Could not exchange the Linear code for a token." };
    }
    await data?.refreshConnection().catch(() => {});
    return { ok: true, message: "Connected to Linear." };
  }

  /**
   * Trade the authorization code for a token, and store it.
   *
   * A public-client exchange: `client_id` and no `client_secret`, because ADE's
   * secret is ADE's identity to Linear rather than the user's and the handoff
   * deliberately withholds it. `code_verifier` is what stands in for the
   * secret, which is why the PKCE pair had to be the plugin's.
   */
  async function exchange({ code, verifier, redirectUri, clientId: id }) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: id,
      ...(verifier ? { code_verifier: verifier } : {}),
    });
    let response;
    try {
      response = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch (error) {
      throw new Error(`Could not reach Linear to exchange the code: ${error?.message ?? error}`);
    }
    const raw = await response.text();
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }
    if (!response.ok || !payload?.access_token) {
      const reason = typeof payload?.error_description === "string"
        ? payload.error_description
        : typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`;
      throw new Error(`Linear refused the sign-in: ${reason}`);
    }
    await api.writeToken({
      accessToken: String(payload.access_token).trim(),
      refreshToken: payload.refresh_token ? String(payload.refresh_token).trim() : null,
      expiresAt: Number.isFinite(payload.expires_in)
        ? new Date(now() + payload.expires_in * 1000).toISOString()
        : null,
    });
    // The client id has to survive so the REFRESH can send it. It arrived with
    // the handoff or with the user's own registration, and neither is
    // guaranteed to still be there when the token expires.
    await sdk.secrets.set(SECRET_CLIENT_ID, id);
    return { ok: true };
  }

  /**
   * Store a pasted API key.
   *
   * Validated against `lin_api_…` before it is stored, so the failure lands on
   * the paste rather than three screens later as "Linear refused this
   * credential". An OAuth token pasted into the key box is the mistake this
   * catches most often, and it is worth catching: sending one as a bare
   * `authorization` value is a 400 about the header, not a 401.
   */
  async function saveApiKey(value) {
    const key = String(value ?? "").trim();
    if (!key) return { ok: false, message: "Paste a Linear API key." };
    if (!API_KEY_PATTERN.test(key)) {
      return {
        ok: false,
        message: "That does not look like a Linear API key. They start with lin_api_ and come from Linear → Settings → API.",
      };
    }
    await sdk.secrets.set(SECRET_ACCESS_TOKEN, key);
    await sdk.secrets.set(SECRET_AUTH_MODE, "manual");
    // A key that follows an OAuth connection must not inherit its expiry or
    // its refresh token: an API key does not expire, and a stale expiry would
    // send the client refreshing a credential that has no refresh grant.
    await sdk.secrets.delete(SECRET_REFRESH_TOKEN).catch(() => {});
    await sdk.secrets.delete(SECRET_EXPIRES_AT).catch(() => {});

    const connection = await data?.refreshConnection();
    if (connection && !connection.connected) {
      return { ok: false, message: connection.lastError ?? "Linear refused that API key." };
    }
    return { ok: true, message: "Connected to Linear." };
  }

  /**
   * Forget the credential.
   *
   * Every secret, not just the token: leaving the refresh token behind would
   * mean a disconnected plugin still holds a live grant against the user's
   * workspace, which is not what "disconnect" means to anybody.
   */
  async function disconnect() {
    for (const name of [SECRET_ACCESS_TOKEN, SECRET_REFRESH_TOKEN, SECRET_EXPIRES_AT, SECRET_AUTH_MODE]) {
      await sdk.secrets.delete(name).catch(() => {});
    }
    await data?.refreshConnection().catch(() => {});
    return { ok: true, message: "Disconnected from Linear." };
  }

  return {
    AUTH_SESSION_ID,
    begin,
    cancel,
    clientId,
    complete,
    connectStatus,
    disconnect,
    exchange,
    requestHandoff,
    saveApiKey,
  };
}

module.exports = {
  API_KEY_PATTERN,
  AUTH_SESSION_ID,
  SCOPES_ADE_APP,
  SCOPES_CUSTOM,
  authorizeParams,
  createConnect,
  createPkcePair,
};
