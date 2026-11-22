/**
 * The link page's view of this browser's ADE Web sign-in.
 *
 * ade-app.dev/open frames this page, hidden, to order its choices by fact: the
 * ADE app first when one of the account's computers is online, ADE Web first
 * when none is. The sign-in lives here, on app.ade-app.dev, so only this page
 * can read it.
 *
 * It never refreshes the session. The refresh token rotates on every use, and
 * a frame that the link page drops mid-refresh (the person picks a choice)
 * would lose the new token and sign ADE Web out. It reads the computers only
 * with the access token ADE Web stored on its last sign-in or refresh, which
 * lives for a day; with no usable one it says "signed in, computers unknown".
 *
 * It answers only the ADE link page's own origins, and only with what that
 * page shows: the names of the online computers.
 */
import { fetchAccountMachines } from "../../../shared/accountDirectory";
import type { AdeAccountMachine } from "../../../shared/types/account";
import { readBrowserAccountConfig } from "../account/client";
import { BrowserAccountSessionStore, usablePersistedAccessToken } from "../account/sessionStore";

/** The origins the answer may go to. A message to any other is dropped by the browser. */
const LINK_PAGE_ORIGINS: readonly string[] = import.meta.env.DEV
  ? ["https://ade-app.dev", "https://www.ade-app.dev", "http://localhost:4180", "http://127.0.0.1:4180"]
  : ["https://ade-app.dev", "https://www.ade-app.dev"];

/** The message the link page reads (apps/web OpenPage.tsx, `readLinkStatus`). */
export type AdeLinkStatusMessage = {
  type: "ade-link-status";
  version: 1;
  signedIn: boolean;
  /** Names of the account's computers that are online now; null when unknown. */
  onlineComputers: string[] | null;
};

/** Leave a minute of life so the read does not race the token's expiry. */
const TOKEN_SKEW_MS = 60_000;

/** A computer that runs the ADE app: not a phone, not another browser. */
function isComputer(machine: AdeAccountMachine): boolean {
  return machine.deviceType !== "phone" && machine.deviceType !== "browser";
}

function computerName(machine: AdeAccountMachine): string {
  return machine.customName?.trim() || machine.name?.trim() || "Your computer";
}

async function readStatus(): Promise<AdeLinkStatusMessage> {
  const signedOut: AdeLinkStatusMessage = { type: "ade-link-status", version: 1, signedIn: false, onlineComputers: null };
  const config = readBrowserAccountConfig(import.meta.env as Record<string, unknown>);
  if (!config) return signedOut;
  const persisted = await new BrowserAccountSessionStore().load().catch(() => null);
  if (!persisted || persisted.issuer !== config.issuer || persisted.clientId !== config.clientId) return signedOut;
  const signedInUnknown: AdeLinkStatusMessage = { ...signedOut, signedIn: true };
  const stored = usablePersistedAccessToken(persisted, Date.now(), TOKEN_SKEW_MS);
  if (!stored) return signedInUnknown;
  const result = await fetchAccountMachines({
    baseUrl: config.directoryBaseUrl,
    accessToken: stored.accessToken,
    timeoutMs: 4_000,
  });
  if (result.state !== "ok") return signedInUnknown;
  return {
    ...signedInUnknown,
    onlineComputers: result.machines.filter((machine) => machine.online && isComputer(machine)).map(computerName),
  };
}

function post(message: AdeLinkStatusMessage): void {
  if (window.parent === window) return;
  for (const origin of LINK_PAGE_ORIGINS) {
    try {
      window.parent.postMessage(message, origin);
    } catch {
      // A malformed origin is a bug here, not the parent's; the others still go.
    }
  }
}

void readStatus()
  .catch((): AdeLinkStatusMessage => ({ type: "ade-link-status", version: 1, signedIn: false, onlineComputers: null }))
  .then(post);
