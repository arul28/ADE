import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { URL } from "node:url";

import {
  PLUGIN_AUTH_CALLBACK_KINDS,
  type PluginAuthCallbackKind,
  type PluginManifest,
  type PluginManifestAuthSession,
} from "../../../shared/plugins/manifest";
import {
  PluginSdkError,
  PLUGIN_AUTH_PARAMS_MAX,
  PLUGIN_AUTH_PARAM_VALUE_MAX,
  PLUGIN_AUTH_RESERVED_PARAMS,
  type PluginActionAuthSession,
  type PluginAuthCompletedPayload,
  type PluginAuthFailureReason,
  type PluginAuthSessionStart,
} from "../../../shared/plugins/sdk";
import type { Logger } from "../logging/logger";

/**
 * The host half of `ade.auth.beginSession`: ADE runs one plugin's sign-in for
 * it, and the plugin never touches the parts that make the flow safe.
 *
 * The whole design rests on the host owning three things the child cannot be
 * allowed to choose. The AUTHORIZE ORIGIN comes from the manifest, so a plugin
 * cannot send the user's browser somewhere nobody disclosed at install time.
 * The REDIRECT is either a loopback this process is listening on or ADE's own
 * relay bounce, so a plugin cannot point the provider's code at its own server.
 * And `STATE` is minted here, held here and compared here — the child never
 * sees it, on the way out or on the way back, because a second copy invites a
 * second, weaker check that disagrees with this one.
 *
 * This module is the generalization of `cto/linearOAuthService.ts`, which has
 * been running one hard-coded version of this flow in production. The details
 * that file paid for are carried over deliberately and are marked where they
 * appear: the synchronous callback claim, the EADDRINUSE rewrite, the connection
 * close on shutdown, and never logging the state.
 *
 * Nothing in here shells out, touches a path or branches on `process.platform`.
 * `http.createServer` bound to `127.0.0.1` and `closeAllConnections()` behave
 * identically on Windows, which is the only way a plugin's Connect button works
 * the same on every machine the plugin is installed on.
 */

/**
 * The scheme the phone's in-app auth session watches for.
 *
 * ADE's own scheme rather than a per-plugin one, because a URL scheme is
 * claimed by an INSTALLED APP and a plugin is not an app: there is one binary
 * on the phone and it catches every plugin's callback. Which flow a callback
 * belongs to is decided by `state`, never by the scheme.
 */
export const PLUGIN_AUTH_CALLBACK_SCHEME = "ade";

/** The host component the relay bounces to: `ade://plugin-auth?…`. */
export const PLUGIN_AUTH_APP_CALLBACK_HOST = "plugin-auth";

/**
 * Where the `app` transport sends the provider.
 *
 * Modelled on `LINEAR_MOBILE_OAUTH_REDIRECT_URI`, which proved the shape: a
 * stateless worker route that does exactly one thing, 302 the query string to
 * the app's scheme. The path is generic and names no integration on purpose —
 * this one route serves every plugin's every flow, so a new plugin needs no
 * relay deploy, and the relay learns nothing about which plugin is signing in.
 */
export const PLUGIN_AUTH_APP_REDIRECT_URI =
  "https://ade-github-webhook-relay.arulsharma1028.workers.dev/plugin/auth/callback";

/**
 * How long a begun flow stays live.
 *
 * Ten minutes is a person opening a browser, reading a consent screen and
 * possibly signing in to the provider first. Past it the flow is retired and
 * the plugin is told `expired`, which is the outcome it can act on: `state` is
 * gone, so a callback arriving afterwards is indistinguishable from a forged
 * one and is refused as `state_mismatch`.
 */
export const PLUGIN_AUTH_SESSION_TTL_MS = 10 * 60 * 1000;

const LOOPBACK_HOST = "127.0.0.1";
const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";
const HTML_CONTENT_TYPE = "text/html; charset=utf-8";

/**
 * What a plugin may call one of its own authorize parameters.
 *
 * Deliberately narrower than "any string": these become query keys on a URL the
 * host puts in front of the user, and a key carrying `&`, `#` or a newline
 * would let a plugin write structure into a URL it is only supposed to be
 * contributing values to. Every real OAuth parameter — `client_id`, `scope`,
 * `code_challenge_method` — fits comfortably.
 */
const AUTH_PARAM_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

type LiveAuthSession = {
  pluginId: string;
  /** The `authSessions[].id` from the manifest. */
  sessionId: string;
  /** The provider's display name, used only to write a sentence a user reads. */
  provider: string;
  attempt: string;
  /** Host-minted and host-held. Never logged, never given to the child. */
  state: string;
  transport: PluginAuthCallbackKind;
  /** The full authorize URL. Presented to a client; never returned to a plugin. */
  url: string;
  redirectUri: string;
  expiresAt: number;
  /**
   * Set SYNCHRONOUSLY, before anything awaits, by whichever door reaches the
   * flow first — and the reason is the same one `linearOAuthService` records:
   * an authorization code is single use, so a callback replayed while the first
   * one is still in flight must not be able to race it or change its outcome.
   */
  settled: boolean;
  server: http.Server | null;
  /**
   * Trips the moment this attempt is over, however it ended.
   *
   * The host runs no token exchange — that is the plugin's own network call —
   * so nothing here is aborting a fetch. What it does is release anything still
   * waiting on the flow: a response writer parked on a socket a browser never
   * drained would otherwise hold the server open past `cancel()`.
   */
  abortController: AbortController;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * One flow per (plugin, declared id).
 *
 * Both halves are needed, and `:` separates them unambiguously: neither a
 * plugin id nor a manifest identifier may contain one, so no pair of distinct
 * flows can ever collide on a single key and share a busy check.
 */
function liveKey(pluginId: string, sessionId: string): string {
  return `${pluginId}:${sessionId}`;
}

/**
 * The same EADDRINUSE test `linearOAuthService` uses, including the message
 * fallback: not every path that fails to bind sets `code`, and a port collision
 * reported as a generic error would surface to the plugin as `internal_error`
 * when the user's actual remedy is to quit the other program.
 */
function isAddressInUseError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && (error as { code?: unknown }).code === "EADDRINUSE") return true;
  return error instanceof Error && (
    error.message.includes("EADDRINUSE") || error.message.includes("address already in use")
  );
}

function closeServerAndWait(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * Resolve when the response has actually reached the wire, or when the attempt
 * is aborted.
 *
 * The wait matters because the caller closes the loopback server next, and a
 * server closed while the browser is still reading shows the user a failed page
 * instead of "you can close this window" — for a sign-in that in fact succeeded.
 */
function writeResponse(
  response: http.ServerResponse,
  status: number,
  contentType: string,
  body: string,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      response.off("finish", finish);
      response.off("close", finish);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    response.once("finish", finish);
    response.once("close", finish);
    signal?.addEventListener("abort", finish, { once: true });
    try {
      // `connection: close` rather than the default keep-alive, because the
      // server is torn down the moment the flow ends: a socket the browser was
      // holding open for a request it will never make is the difference between
      // shutting the listener down now and waiting on an idle connection.
      response.writeHead(status, { "content-type": contentType, connection: "close" });
      response.end(body);
    } catch {
      // A socket the browser already dropped. The flow's outcome was decided
      // before this write, so there is nothing left to report and nothing to
      // retry — only the close below to let happen.
      finish();
    }
  });
}

/**
 * Flatten a callback's query to the shape the plugin is handed.
 *
 * First value wins for a repeated key. A provider sends each parameter once, so
 * a duplicate is either a proxy artefact or someone appending a second `code`
 * to a URL — and taking the first keeps the value the host validated `state`
 * alongside rather than one bolted on afterwards.
 */
function readQuery(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of params) {
    if (!(key in out)) out[key] = value;
  }
  return out;
}

/**
 * The outcome of one callback, from its parameters alone.
 *
 * Shared by both transports so a loopback redirect and a relay bounce carrying
 * identical parameters produce an identical event — otherwise a plugin would
 * have to handle "denied on desktop" and "denied on the phone" separately, and
 * the second one would be the one nobody tested.
 */
function outcomeFor(
  session: LiveAuthSession,
  params: Record<string, string>,
): { ok: true; params: Record<string, string> } | { ok: false; reason: PluginAuthFailureReason; message: string } {
  const error = params.error;
  if (typeof error === "string" && error.length > 0) {
    const description = params.error_description;
    // Mirrors `LinearOAuthCallback.errorMessage` on iOS: the provider's own
    // sentence when it wrote one, and the bare error code wrapped in a sentence
    // when it did not — `access_denied` on its own is not something a reader can
    // act on.
    return {
      ok: false,
      reason: "denied",
      message: typeof description === "string" && description.length > 0
        ? description
        : `${session.provider} sign-in failed (${error}).`,
    };
  }
  // `state` is stripped rather than passed through. The plugin has no use for
  // it — the host minted it and the host compared it — and a copy in the child
  // is a copy that can leak into the plugin's own logs.
  const { state: _state, ...rest } = params;
  return { ok: true, params: rest };
}

export type PluginAuthSessionService = ReturnType<typeof createPluginAuthSessionService>;

export function createPluginAuthSessionService(deps: {
  logger: Logger;
  /**
   * Deliver the outcome to the child that began the flow.
   *
   * A plain callback rather than an event bus reference because this module has
   * exactly one thing to say and says it once per attempt: the delivery
   * guarantee (queued for a child that is not draining stdin, never coalesced)
   * belongs to the caller that owns the child.
   */
  emitCompleted: (pluginId: string, payload: PluginAuthCompletedPayload) => void;
  now?: () => number;
  appRedirectUri?: string;
}) {
  const { logger } = deps;
  const now = deps.now ?? (() => Date.now());
  const appRedirectUri = deps.appRedirectUri ?? PLUGIN_AUTH_APP_REDIRECT_URI;

  const live = new Map<string, LiveAuthSession>();
  /**
   * The state → flow index, and the ONLY way the `app` transport finds a flow.
   *
   * The phone posts back a query string it caught on a URL scheme; it does not
   * know which machine, plugin or flow minted it, and it must not be able to
   * name one. Routing by the unguessable value the host minted means a caller
   * can only ever address a flow it actually started.
   */
  const byState = new Map<string, LiveAuthSession>();

  const unbind = (session: LiveAuthSession): void => {
    clearTimeout(session.timer);
    live.delete(liveKey(session.pluginId, session.sessionId));
    byState.delete(session.state);
    session.abortController.abort();
  };

  /**
   * Stop listening on the declared port.
   *
   * `close()` alone only stops NEW connections: a socket a browser is holding
   * open counts as neither closed nor in flight, so the listener would linger
   * and the next `begin` would report the user's own port as taken. Idle
   * connections are therefore always dropped.
   *
   * `force` additionally drops connections that are mid-request, and is only
   * for the paths where the flow is over regardless — an expiry, a cancel, a
   * shutdown. It is deliberately NOT used after a successful callback:
   * destroying that socket while the browser is still reading turns a sign-in
   * that worked into a failed page, which is the only feedback the user gets.
   */
  const closeServer = (session: LiveAuthSession, force = false): void => {
    const server = session.server;
    if (!server) return;
    session.server = null;
    void closeServerAndWait(server);
    server.closeIdleConnections();
    if (force) server.closeAllConnections();
  };

  /**
   * Claim the flow and tell the plugin what became of it — at most once.
   *
   * The claim is what makes "exactly once per attempt" true: every door checks
   * and sets `settled` with no await in between, so a second callback finds it
   * already taken and is refused rather than emitting a second event for one
   * authorization.
   */
  const settle = (
    session: LiveAuthSession,
    outcome:
      | { ok: true; params: Record<string, string> }
      | { ok: false; reason: PluginAuthFailureReason; message?: string },
  ): boolean => {
    if (session.settled) return false;
    session.settled = true;
    unbind(session);
    logger.info("plugin.auth_session_completed", {
      pluginId: session.pluginId,
      sessionId: session.sessionId,
      attempt: session.attempt,
      transport: session.transport,
      ok: outcome.ok,
      ...(outcome.ok ? { paramKeys: Object.keys(outcome.params) } : { reason: outcome.reason }),
    });
    deps.emitCompleted(session.pluginId, {
      event: "auth.completed",
      sessionId: session.sessionId,
      attempt: session.attempt,
      ...outcome,
    });
    return true;
  };

  const requireDeclaredFlow = (
    pluginId: string,
    manifest: PluginManifest,
    sessionId: string,
  ): PluginManifestAuthSession => {
    const flow = (manifest.authSessions ?? []).find((entry) => entry.id === sessionId);
    if (!flow) {
      // Refused by name and pointed at the field, for the reason every other
      // undeclared-thing refusal gives: an author who cannot tell a typo from a
      // missing declaration will assume the platform is broken.
      throw new PluginSdkError(
        "not_permitted",
        `Auth session "${sessionId}" is not declared in ${pluginId}'s manifest.`
          + ` Add it to "authSessions" and install the plugin again.`,
      );
    }
    return flow;
  };

  const resolveTransport = (
    flow: PluginManifestAuthSession,
    requested: PluginAuthCallbackKind | undefined,
    client: "desktop" | "mobile" | null | undefined,
  ): PluginAuthCallbackKind => {
    const declared = PLUGIN_AUTH_CALLBACK_KINDS.filter((kind) => flow.callbacks.includes(kind));
    if (requested) {
      // An explicit ask is honoured or refused, never quietly redirected: the
      // caller asking for `loopback` is usually a desktop that has already
      // decided it can catch the redirect itself, and silently giving it the
      // relay bounce would send a user through ADE's servers without anybody
      // choosing that.
      if (!declared.includes(requested)) {
        throw new PluginSdkError(
          "invalid_args",
          `Auth session "${flow.id}" does not declare the "${requested}" callback.`
            + ` It declares ${declared.map((kind) => `"${kind}"`).join(" and ") || "none"}.`,
        );
      }
      return requested;
    }
    // The phone cannot get back from a loopback and a desktop should not pay a
    // round trip through the relay when it can catch the redirect itself, so
    // the asking client picks — but only among what the flow declares.
    const preferred = client === "mobile" ? "app" : client === "desktop" ? "loopback" : null;
    if (preferred && declared.includes(preferred)) return preferred;
    if (declared.length === 1) return declared[0]!;
    // Loopback is the default for a caller that named no client, because a flow
    // reaching this line declares both and the machine running the host is the
    // one most likely to be able to catch a redirect. Falling back to whatever
    // IS declared, rather than failing, keeps a flow that only ever offered one
    // transport working for a caller that did not think to ask for it.
    return declared.includes("loopback") ? "loopback" : declared[0] ?? "loopback";
  };

  const validateParams = (params: Record<string, string>): [string, string][] => {
    const entries = Object.entries(params);
    if (entries.length > PLUGIN_AUTH_PARAMS_MAX) {
      throw new PluginSdkError(
        "invalid_args",
        `A sign-in may carry at most ${PLUGIN_AUTH_PARAMS_MAX} parameters; this one carried ${entries.length}.`,
      );
    }
    for (const [key, value] of entries) {
      if (PLUGIN_AUTH_RESERVED_PARAMS.includes(key.toLowerCase())) {
        // Refused by name rather than overwritten, so the author finds out
        // which half of the safety property the platform is holding. A silent
        // overwrite would leave a plugin that set its own `redirect_uri`
        // believing it had, and debugging a redirect it never sent.
        throw new PluginSdkError(
          "invalid_args",
          `Auth parameter "${key}" is owned by ADE. The host mints "redirect_uri" and "state"`
            + " for every sign-in, so a plugin may not send either — remove it and pass the rest.",
        );
      }
      if (!AUTH_PARAM_KEY_PATTERN.test(key)) {
        throw new PluginSdkError(
          "invalid_args",
          `Auth parameter name "${key}" is not a plain parameter token.`,
        );
      }
      if (typeof value !== "string") {
        throw new PluginSdkError("invalid_args", `Auth parameter "${key}" must be a string.`);
      }
      if (value.length > PLUGIN_AUTH_PARAM_VALUE_MAX) {
        throw new PluginSdkError(
          "invalid_args",
          `Auth parameter "${key}" is longer than the ${PLUGIN_AUTH_PARAM_VALUE_MAX} character ceiling.`,
        );
      }
    }
    return entries;
  };

  const handleLoopbackRequest = (
    session: LiveAuthSession,
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): void => {
    const requestUrl = new URL(request.url ?? "/", session.redirectUri);
    const expectedPath = new URL(session.redirectUri).pathname;
    if (requestUrl.pathname !== expectedPath) {
      // Anything else on this port is not part of the flow — a favicon probe, a
      // stray localhost request from another program. Answering 404 rather than
      // treating it as a callback keeps a mistyped path from retiring a state
      // the user is still about to come back with.
      void writeResponse(response, 404, TEXT_CONTENT_TYPE, "Not found.", session.abortController.signal);
      return;
    }

    const params = readQuery(requestUrl.searchParams);
    if (params.state !== session.state) {
      // Logged WITHOUT either state. Whether one arrived is the diagnostic; the
      // values are the secret this whole flow turns on, and a log file is read
      // by more people and processes than the flow ever was.
      logger.warn("plugin.auth_callback_state_mismatch", {
        pluginId: session.pluginId,
        sessionId: session.sessionId,
        hasState: typeof params.state === "string" && params.state.length > 0,
      });
      void writeResponse(
        response,
        400,
        TEXT_CONTENT_TYPE,
        "This sign-in link does not match the one ADE is waiting for. Return to ADE and start again.",
        session.abortController.signal,
      );
      return;
    }

    const outcome = outcomeFor(session, params);
    // Claimed here, synchronously, before the first await below.
    if (!settle(session, outcome)) {
      void writeResponse(
        response,
        409,
        TEXT_CONTENT_TYPE,
        "This sign-in has already finished. Return to ADE to continue.",
        session.abortController.signal,
      );
      return;
    }

    const reply = outcome.ok
      ? {
        status: 200,
        contentType: HTML_CONTENT_TYPE,
        body: "<!doctype html><html><body style=\"font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:24px\">"
          + `Signed in to ${session.provider}. You can close this window and return to ADE.</body></html>`,
      }
      : {
        status: 400,
        contentType: TEXT_CONTENT_TYPE,
        body: `${session.provider} declined this sign-in. Return to ADE for the details.`,
      };
    // No abort signal on this one, and that is the point: the flow is already
    // settled and its `AbortController` already tripped, so passing it would
    // close the listener before the page the user is waiting on reaches them.
    void writeResponse(response, reply.status, reply.contentType, reply.body)
      .then(() => closeServer(session));
  };

  const listen = async (session: LiveAuthSession, port: number): Promise<void> => {
    const server = http.createServer((request, response) => {
      try {
        handleLoopbackRequest(session, request, response);
      } catch (error) {
        logger.warn("plugin.auth_callback_failed", {
          pluginId: session.pluginId,
          sessionId: session.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        void writeResponse(response, 500, TEXT_CONTENT_TYPE, "This sign-in could not be completed.");
      }
    });
    session.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          server.off("error", onError);
          server.off("close", onClose);
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onClose = () => {
          cleanup();
          reject(new Error("The sign-in callback listener closed before it started."));
        };
        server.once("error", onError);
        server.once("close", onClose);
        server.listen(port, LOOPBACK_HOST, () => {
          cleanup();
          resolve();
        });
      });
    } catch (error) {
      session.server = null;
      try {
        server.close();
      } catch {
        // Best effort: it never bound.
      }
      if (isAddressInUseError(error)) {
        logger.warn("plugin.auth_loopback_port_in_use", {
          pluginId: session.pluginId,
          sessionId: session.sessionId,
          port,
        });
        // Rewritten rather than surfaced raw, and as `auth_session_busy` rather
        // than an internal error: the port is DECLARED in the manifest, so the
        // only ways it is taken are another ADE running this same flow or an
        // unrelated program on the machine. Both are "wait and retry", and the
        // port number is the one fact that lets the user find the other one.
        throw new PluginSdkError(
          "auth_session_busy",
          `The sign-in callback port ${port} is already in use on ${LOOPBACK_HOST}.`
            + " Close the other program using it, or finish the sign-in already in progress, then try again.",
        );
      }
      throw error;
    }
  };

  return {
    async begin(args: {
      pluginId: string;
      manifest: PluginManifest;
      sessionId: string;
      params: Record<string, string>;
      transport?: PluginAuthCallbackKind;
      client?: "desktop" | "mobile" | null;
    }): Promise<PluginAuthSessionStart> {
      const flow = requireDeclaredFlow(args.pluginId, args.manifest, args.sessionId);
      const transport = resolveTransport(flow, args.transport, args.client);
      const entries = validateParams(args.params ?? {});

      const key = liveKey(args.pluginId, args.sessionId);
      if (live.has(key)) {
        // NOT superseded, which is the one place this deliberately parts
        // company with `linearOAuthService`. That service owns a single
        // built-in integration and retires the previous attempt so its fixed
        // port is free; here the previous attempt is a browser window the user
        // is looking at right now, opened by a plugin that may well be calling
        // `begin` from a retry loop. Retiring it under them replaces a consent
        // screen mid-read with one that silently belongs to a different state.
        throw new PluginSdkError(
          "auth_session_busy",
          `A "${args.sessionId}" sign-in is already running for ${args.pluginId}.`
            + " Wait for it to finish, or cancel it before starting another.",
        );
      }

      if (transport === "loopback" && !flow.loopback) {
        // A `loopback` callback with no declared port has nowhere to catch the
        // redirect. The manifest parser drops such a flow, so this only fires
        // for a manifest built in code — and it fails here rather than binding
        // a port nothing registered with the provider.
        throw new PluginSdkError(
          "auth_unavailable",
          `Auth session "${args.sessionId}" declares a loopback callback but no loopback port.`,
        );
      }

      const state = randomBytes(32).toString("base64url");
      const attempt = randomUUID();
      const redirectUri = transport === "loopback" && flow.loopback
        ? `http://${LOOPBACK_HOST}:${flow.loopback.port}${flow.loopback.path}`
        : appRedirectUri;

      const url = new URL(flow.authorizeUrl);
      for (const [name, value] of entries) url.searchParams.set(name, value);
      // Last, and after the plugin's own: the reserved names were refused
      // above, so these two cannot be fighting a plugin's spelling — but
      // writing them last means the host's answer is the one on the URL even
      // if that refusal is ever relaxed.
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);

      const expiresAt = now() + PLUGIN_AUTH_SESSION_TTL_MS;
      const session: LiveAuthSession = {
        pluginId: args.pluginId,
        sessionId: args.sessionId,
        provider: flow.provider,
        attempt,
        state,
        transport,
        url: url.toString(),
        redirectUri,
        expiresAt,
        settled: false,
        server: null,
        abortController: new AbortController(),
        // Armed for real rather than checked lazily, because NOTHING polls this
        // service the way ADE's own Linear renderer polls `getSession`. Without
        // a timer a plugin whose user closed the browser tab would wait on an
        // `auth.completed` that never came, with no way to tell "still going"
        // from "over".
        timer: setTimeout(() => {
          settle(session, { ok: false, reason: "expired" });
          closeServer(session, true);
        }, PLUGIN_AUTH_SESSION_TTL_MS),
      };
      // The timer must not hold the process open: a sign-in nobody finished is
      // not a reason for ADE to refuse to quit.
      if (typeof session.timer.unref === "function") session.timer.unref();

      // Registered BEFORE the bind is awaited. Two `begin` calls that arrive in
      // the same tick would otherwise both find the map empty, both pass the
      // busy check above, and race for one declared port.
      live.set(key, session);
      byState.set(state, session);

      if (transport === "loopback" && flow.loopback) {
        try {
          await listen(session, flow.loopback.port);
        } catch (error) {
          unbind(session);
          session.settled = true;
          throw error;
        }
      }

      logger.info("plugin.auth_session_begun", {
        pluginId: args.pluginId,
        sessionId: args.sessionId,
        attempt,
        transport,
        // Keys only. A value here is a `client_id` at best and a
        // `code_challenge` at worst, and neither belongs in a log file.
        paramKeys: entries.map(([name]) => name),
      });

      return {
        sessionId: args.sessionId,
        attempt,
        transport,
        redirectUri,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    },

    /**
     * The host-stamped instruction a client presents, or null.
     *
     * Null for a flow that is not live is the safe answer, not a gap: the
     * plugin's action result names a session id and nothing else, so a stale or
     * forged id resolving to "nothing to present" is exactly what should
     * happen.
     */
    presentation(pluginId: string, sessionId: string): PluginActionAuthSession | null {
      const session = live.get(liveKey(pluginId, sessionId));
      if (!session || session.settled) return null;
      return {
        sessionId: session.sessionId,
        url: session.url,
        transport: session.transport,
        // Only the `app` transport needs it. On `loopback` the host catches the
        // redirect itself and a client that watched for a scheme would be
        // watching for one nothing ever sends.
        ...(session.transport === "app" ? { callbackScheme: PLUGIN_AUTH_CALLBACK_SCHEME } : {}),
      };
    },

    /**
     * The phone's door: a callback that came back over `ade://plugin-auth`.
     *
     * Routed SOLELY by `state`. The caller names no plugin and no session id
     * because it must not be able to — `state` is the host-minted, unguessable
     * binding, so a caller can only ever address a flow that this host started
     * and that is still live.
     */
    completeAppCallback(args: { params: Record<string, string> }): { ok: boolean; reason?: PluginAuthFailureReason } {
      const state = args.params?.state;
      const session = typeof state === "string" && state.length > 0 ? byState.get(state) : undefined;
      if (!session || session.settled) {
        logger.warn("plugin.auth_app_callback_unmatched", {
          hasState: typeof state === "string" && state.length > 0,
        });
        // Nothing is emitted. There is no flow to emit to, and inventing one
        // from a `pluginId` the caller supplied is the exact door this design
        // does not have.
        return { ok: false, reason: "state_mismatch" };
      }
      const outcome = outcomeFor(session, args.params);
      // Claimed synchronously, like the loopback door, so a link opened twice
      // on the phone cannot deliver one authorization to the plugin twice.
      if (!settle(session, outcome)) return { ok: false, reason: "state_mismatch" };
      closeServer(session, true);
      // `ok` says the host recognised and consumed the callback, not that the
      // provider said yes: a denied callback was routed correctly and the
      // plugin hears `denied` on its own event.
      return { ok: true };
    },

    /** Idempotent: a flow that is not live has already told the plugin why. */
    cancel(pluginId: string, sessionId: string): void {
      const session = live.get(liveKey(pluginId, sessionId));
      if (!session) return;
      settle(session, { ok: false, reason: "canceled" });
      closeServer(session, true);
    },

    /**
     * Retire everything one plugin has running — its child is restarting, or it
     * is being disabled or uninstalled.
     *
     * The plugin IS told, unlike {@link dispose}: a child that comes back needs
     * to know the flow it opened is gone rather than treating it as still
     * pending, and `attempt` already stops it acting on a stale one.
     */
    disposePlugin(pluginId: string): void {
      for (const session of [...live.values()]) {
        if (session.pluginId !== pluginId) continue;
        settle(session, { ok: false, reason: "canceled" });
        closeServer(session, true);
      }
    },

    /**
     * Host shutdown. Every listener closes and NOTHING is emitted: the children
     * these events would go to are being torn down in the same breath, so an
     * emit here reaches a bus that is already gone.
     */
    dispose(): void {
      for (const session of [...live.values()]) {
        session.settled = true;
        unbind(session);
        closeServer(session, true);
      }
      live.clear();
      byState.clear();
    },
  };
}
