// Getting a Linear credential into this plugin's own secret store.
//
// Two ways in, in the order a real user meets them:
//
//   1. **OAuth.** The host opens the browser (or the phone's in-app auth view),
//      owns the loopback listener and the `state`; the plugin supplies the
//      query parameters, holds the PKCE verifier, and performs the exchange
//      itself over a host it declared in `network`.
//   2. **An API key.** `lin_api_…`, pasted. Linear takes it as a BARE
//      `authorization` value, which is why the mode is stored beside it.
//
// There is deliberately no third way. This plugin used to ask ADE to hand over
// the credential its compiled Linear surface already held, which made a real
// sign-in the second-best path and made the plugin untestable on a machine
// that had never connected ADE to Linear. A plugin nobody can install cleanly
// is not a plugin, so the handoff is gone and every install signs in.
//
// ## Why the plugin performs the exchange
//
// ADE brokers the AUTHORIZATION and never the credential: the host hands back
// the callback parameters as data, and the token exists for the first time
// inside this process. A host that held the token would have to refresh it,
// and refreshing a grant it cannot use is a responsibility with no matching
// capability.
//
// ## Where the client id comes from
//
// `client_id` identifies ADE to Linear, and it is not this plugin's to invent.
// Two doors, tried in this order:
//
//   1. **This plugin's own store.** Put there by a completed exchange
//      (`LINEAR_OAUTH_CLIENT_ID`), and it is what a refresh has to send. A user
//      who registered their own OAuth app has theirs here too.
//   2. **`ade.auth.officialClient("linear")`.** ADE lends the honoured owner of
//      the built-in Linear surface its OWN public client id — the same id that
//      appears in the authorize URL of every sign-in ADE has ever run. A public
//      client id is not a credential, so this is what makes OAuth work on every
//      install, fresh ones included.
//
// ADE never lends the client SECRET, and there is no shape in which it could:
// the answer has no field for one. That is the correct outcome — the exchange
// below is a public-client exchange and PKCE stands in for the secret.

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
 * The panels a sign-in can be started from.
 *
 * A completed sign-in has to put the reader back where they pressed the button,
 * and completion is the one moment that cannot work out where that was: the
 * `auth.completed` event carries the flow, never the screen, and by then the
 * action that was pressed has long since returned. So the ORIGIN is recorded
 * when the flow BEGINS — the press site names its own panel — and carried on
 * the pending attempt, exactly as the PKCE verifier is.
 *
 * Three panels can start one: the issue list's "Connect Linear" card, the issue
 * detail's copy of it, and the settings panel's own button. Anything else — a
 * CLI word, an agent tool, a press from a build whose schema predates this —
 * names nothing and gets {@link DEFAULT_AUTH_ORIGIN}, which is the panel the
 * connection lives on and therefore the one place a reader is never moved away
 * from by mistake.
 */
const AUTH_ORIGINS = ["issues", "issue", "settings"];

/** Where a sign-in that named no origin is treated as having started. */
const DEFAULT_AUTH_ORIGIN = "settings";

/**
 * One of {@link AUTH_ORIGINS}, or the default.
 *
 * Deliberately total: an origin arrives from a panel press, which is data a
 * client sent, so a value nobody declared must land on a panel that exists
 * rather than on a `panelId` the host would refuse.
 */
function normalizeAuthOrigin(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return AUTH_ORIGINS.includes(text) ? text : DEFAULT_AUTH_ORIGIN;
}

/**
 * The scopes, ported from `linearOAuthService.ts:260`.
 *
 * `admin` is not ambition. Linear only delivers data-change webhooks for a
 * workspace whose authorization carries it, so an OAuth connection without
 * `admin` is one where the ingress channel silently never fires — and a
 * webhook that never fires is indistinguishable from a workspace where nothing
 * happened.
 *
 * So a CUSTOM client asks for `admin` too. Someone who registers their own
 * Linear app is asking for the whole product, not for a narrower one, and the
 * narrowed grant bought them nothing: it did not protect a workspace they
 * already own, and it cost them every automation the plugin has. The consent
 * screen is where a workspace admin decides what to approve; guessing on their
 * behalf here only made the guess wrong.
 *
 * Two constants, one value, on purpose. The official app's list is a fallback —
 * `begin` prefers whatever the broker names, because that registration is
 * ADE's to describe — and the custom one is the only list there is. Merging
 * them would tie a change in ADE's own grant to every self-registered app.
 */
const SCOPES_ADE_APP = "read,write,admin";
const SCOPES_CUSTOM = "read,write,admin";

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

  /**
   * The OAuth client this plugin should sign in with.
   *
   * `{clientId, source, scopes}` or `null` when nothing on this machine can
   * supply one. `source` is `"official"` for ADE's own registered app and
   * `"custom"` for an app the user registered themselves.
   *
   * ## Why both doors are opened every time
   *
   * A stored client id WINS — after an exchange, the id the token was issued to
   * is the only id its refresh can be redeemed with, and quietly preferring
   * ADE's would break exactly the self-hosted setups that registered their own.
   * But which app a stored id belongs to still has to be decided, because the
   * scope list depends on it, and the only honest way to decide is to compare
   * it against ADE's. That is the same test the compiled integration uses
   * (`linearCredentialService.ts:705` — "Compare by client id, not by which
   * branch resolved"), and it means a stored id that IS ADE's is recognised as
   * ADE's rather than mistaken for a custom one.
   */
  async function resolveClient() {
    // Refused for every plugin that does not own the built-in Linear surface,
    // and on a host that lends no official clients at all. Both are ordinary
    // states rather than failures — the panel falls back to the API key — so
    // the refusal is swallowed here rather than reported as an error.
    let official = null;
    try {
      const answer = await sdk.auth.officialClient("linear");
      const id = answer?.clientId ? String(answer.clientId).trim() : "";
      if (id) {
        official = {
          clientId: id,
          scopes: Array.isArray(answer.scopes) && answer.scopes.length > 0
            ? answer.scopes.join(",")
            : null,
        };
      }
    } catch (error) {
      log("debug", `ADE lends no Linear OAuth client here: ${error?.message ?? error}`);
    }

    const stored = await sdk.secrets.get(SECRET_CLIENT_ID).catch(() => null);
    const storedId = stored ? String(stored).trim() : "";
    if (storedId) {
      const isOfficial = Boolean(official) && storedId === official.clientId;
      return {
        clientId: storedId,
        source: isOfficial ? "official" : "custom",
        scopes: isOfficial ? official.scopes : null,
      };
    }

    if (!official) return null;
    return { clientId: official.clientId, source: "official", scopes: official.scopes };
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
    const client = await resolveClient();
    return {
      connected: Boolean(credential.token),
      authMode: credential.authMode ?? null,
      canOAuth: Boolean(client),
      // Which app the sign-in would present itself as. The panel says so,
      // because "Sign in with Linear" behaves differently for the two: ADE's
      // app carries the webhook grant and a user's own does not.
      clientSource: client?.source ?? null,
      // Said plainly, because the alternative is an authorize URL Linear
      // refuses and a user who cannot tell why. Reached now only where ADE
      // lends nothing — a non-owner build, or a host with no broker — rather
      // than on every fresh install, which is what it used to mean.
      oauthBlockedReason: client
        ? null
        : "This copy of ADE has no Linear OAuth client to sign in with. Paste a Linear API key instead.",
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
  async function begin(options = {}) {
    const origin = normalizeAuthOrigin(options?.origin);
    const client = await resolveClient();
    if (!client) {
      const status = await connectStatus();
      return { ok: false, message: status.oauthBlockedReason, code: "no_client_id" };
    }
    const id = client.clientId;
    const pkce = createPkcePair();
    // Both sources ask for `admin`, because Linear delivers a webhook to
    // neither without it. They still read from different constants: ADE's own
    // app takes the list from the broker when the broker names one — the
    // registration is ADE's, so the grant it needs is ADE's to state — and a
    // client the user registered gets the plugin's own list, never the
    // broker's, because handing somebody else's app ADE's list would ask a
    // workspace to approve permissions ADE described for an app that is not
    // ADE's.
    const scopes = client.source === "official"
      ? (client.scopes ?? SCOPES_ADE_APP)
      : SCOPES_CUSTOM;

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
      // Held beside the verifier because it has the same lifetime and the same
      // owner: it belongs to THIS attempt, and a late callback from a cancelled
      // one must not carry it into the next flow's completion.
      origin,
    };
    return { ok: true, origin, authSession: { sessionId: AUTH_SESSION_ID }, transport: start.transport };
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

    // On EVERY outcome, not just the successful one. A sign-in that failed
    // still leaves a reader looking at the screen they pressed the button on,
    // and the caller decides what to put back on it from the same field either
    // way. An ignored callback carries none: nothing began here, so there is
    // no reader waiting on it and nothing to move.
    const origin = live.origin ?? DEFAULT_AUTH_ORIGIN;

    if (payload.ok !== true) {
      // `canceled` is the user closing the window and needs no message: they
      // know they did it. Everything else is a state the panel must show.
      if (payload.reason === "canceled") return { ok: false, silent: true, origin, reason: payload.reason };
      return {
        ok: false,
        origin,
        reason: payload.reason,
        message: payload.message ?? `Linear sign-in ${payload.reason}.`,
      };
    }

    const code = typeof payload.params?.code === "string" ? payload.params.code.trim() : "";
    if (!code) return { ok: false, origin, message: "Linear completed the sign-in without a code." };

    try {
      await exchange({ code, verifier: live.verifier, redirectUri: live.redirectUri, clientId: live.clientId });
    } catch (error) {
      return { ok: false, origin, message: error?.message ?? "Could not exchange the Linear code for a token." };
    }
    await data?.refreshConnection().catch(() => {});
    return { ok: true, origin, message: "Connected to Linear." };
  }

  /**
   * Trade the authorization code for a token, and store it.
   *
   * A public-client exchange: `client_id` and no `client_secret`, because ADE's
   * secret is ADE's identity to Linear rather than the user's and ADE lends no
   * secret to anyone. `code_verifier` is what stands in for it, which is why
   * the PKCE pair had to be the plugin's.
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
    // The client id has to survive so the REFRESH can send it. It came from
    // ADE's broker or from the user's own registration, and neither is
    // guaranteed to still answer when the token expires.
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
   *
   * The CLIENT ID is one of them, and it was the one left behind. It is stored
   * so a refresh can send it (`exchange`), and it is also what `resolveClient`
   * reads FIRST — so a disconnected plugin kept reporting `source: "custom"`
   * and the next sign-in went out as the user's own registered app rather than
   * through ADE's broker. That difference is not cosmetic: ADE's app carries
   * the webhook grant and a user's own does not, so the reader would have
   * reconnected into a workspace that silently never delivers an event.
   */
  async function disconnect() {
    for (const name of [
      SECRET_ACCESS_TOKEN,
      SECRET_REFRESH_TOKEN,
      SECRET_EXPIRES_AT,
      SECRET_AUTH_MODE,
      SECRET_CLIENT_ID,
    ]) {
      await sdk.secrets.delete(name).catch(() => {});
    }
    await data?.refreshConnection().catch(() => {});
    return { ok: true, message: "Disconnected from Linear." };
  }

  return {
    AUTH_SESSION_ID,
    begin,
    cancel,
    resolveClient,
    complete,
    connectStatus,
    disconnect,
    exchange,
    saveApiKey,
  };
}

module.exports = {
  API_KEY_PATTERN,
  AUTH_ORIGINS,
  AUTH_SESSION_ID,
  DEFAULT_AUTH_ORIGIN,
  SCOPES_ADE_APP,
  SCOPES_CUSTOM,
  authorizeParams,
  createConnect,
  createPkcePair,
  normalizeAuthOrigin,
};
