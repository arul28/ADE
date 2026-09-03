import {
  hasPluginActionAuthSessionRequest,
  readPluginActionAuthSession,
} from "../../../shared/plugins/sdk";
import { openPluginExternalUrl } from "./pluginActionOpenUrl";
import { refusePluginAction } from "./pluginActionToast";

/**
 * The `{authSession}` action-result verb, on desktop and in the web client.
 *
 * ## What was missing
 *
 * Every half of this seam existed except the last one. A plugin returns
 * `{authSession: {sessionId}}`; the host looks that id up in its own table of
 * flows it just started and stamps `url`, `transport` and `callbackScheme` onto
 * the way out (`pluginHostService.ts`); `readPluginActionAuthSession` reads the
 * stamped instruction; iOS presents it in an in-app auth session. The desktop
 * read nothing and opened nothing, so a Connect button on the machine that
 * OWNS the plugin — the only machine whose loopback listener the flow can
 * actually redirect to — was the one place the sign-in did not start.
 *
 * ## Why this is not `openUrl` with extra steps
 *
 * The URL never came from the plugin. `openUrl` opens a link a plugin typed,
 * gated to `https:` because of that; this opens one the HOST built from the
 * plugin's DECLARED `authorizeUrl` plus a `state` only the host holds. The
 * verbs are separate so a client can tell a sign-in from a link — which is what
 * lets the phone use an in-app session and catch the callback — and keeping
 * them separate here means the log line says which one this was.
 *
 * Both transports open externally on the desktop, and neither is a phone's
 * problem in reverse: a `loopback` flow redirects to this machine's own
 * `127.0.0.1`, where the host's listener is, and an `app` flow redirects to
 * ADE's own scheme, which this machine's deeplink handler catches. The phone
 * refuses `loopback` for exactly the reason the desktop accepts it.
 */
export function applyPluginActionAuthSession(
  result: unknown,
  source: { pluginId: string; actionId: string },
): boolean {
  const session = readPluginActionAuthSession(result);
  if (!session) {
    // Worth saying out loud, more than for `openUrl`. The host REMOVES an
    // `authSession` naming no live flow rather than passing a half-built one,
    // so reaching this branch means the plugin asked for a sign-in and the
    // reader is looking at a Connect button that did nothing — which is
    // indistinguishable from a Connect button that is broken.
    if (hasPluginActionAuthSessionRequest(result)) {
      console.warn(
        "[plugin authSession] ignored a sign-in this build could not present",
        source.pluginId,
        source.actionId,
      );
      refusePluginAction(
        source.pluginId,
        source.actionId,
        "It asked to sign you in, but the sign-in it named is no longer running. Press it again.",
      );
    }
    return false;
  }
  console.info(
    "[plugin authSession] opening",
    source.pluginId,
    source.actionId,
    session.sessionId,
    session.transport,
  );
  // The same external opener `{openUrl}` uses: the main process on desktop, a
  // tab in the browser on the web. One door out of a plugin panel, one log line
  // for what a plugin sent a reader to.
  openPluginExternalUrl(session.url, {
    pluginId: source.pluginId,
    source: `${source.actionId} (sign-in)`,
  });
  return true;
}
