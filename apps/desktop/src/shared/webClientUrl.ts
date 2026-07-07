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

export function buildWebClientPairUrl(payload: SyncPairingQrPayload): string {
  return withWebClientOrigin(encodePairingQrUrl(payload));
}
