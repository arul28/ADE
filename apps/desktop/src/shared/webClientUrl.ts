import { buildDeeplink, type DeeplinkTarget } from "./deeplinks";
import { encodePairingQrUrl } from "./pairingQr";
import type { SyncPairingQrPayload } from "./types/sync";

export const WEB_CLIENT_BASE_URL = "https://app.ade-app.dev";

function withWebClientOrigin(rawUrl: string): string {
  const url = new URL(rawUrl);
  const base = new URL(WEB_CLIENT_BASE_URL);
  url.protocol = base.protocol;
  url.host = base.host;
  return url.toString();
}

export function buildWebClientUrl(target: DeeplinkTarget): string {
  return withWebClientOrigin(buildDeeplink(target, { form: "https" }));
}

// Still consumed by the runtime pairing-info commands and the CLI: the QR wire
// encoding remains a smart pairing URL even though no user-facing "pairing
// link" surface exists anymore.
export function buildWebClientPairUrl(payload: SyncPairingQrPayload): string {
  return withWebClientOrigin(encodePairingQrUrl(payload));
}

/**
 * ADE Web's own sign-in page, for a sign-in started on a computer (the desktop
 * app or `ade login`). It runs the Clerk sign-in in ADE's card, then goes on to
 * the authorize URL in `?continue=`, which comes back to that computer.
 */
export const WEB_CLIENT_SIGN_IN_PATH = "/sign-in";
/** Where Google, GitHub and Apple send the browser back to after ADE's sign-in card. */
export const WEB_CLIENT_SIGN_IN_RETURN_PATH = "/sign-in/return";

export function buildWebClientSignInUrl(authorizeUrl: string): string {
  const url = new URL(WEB_CLIENT_SIGN_IN_PATH, WEB_CLIENT_BASE_URL);
  url.searchParams.set("continue", authorizeUrl);
  return url.toString();
}
