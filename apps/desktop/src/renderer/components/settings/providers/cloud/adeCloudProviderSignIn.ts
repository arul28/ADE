/**
 * "Is this provider signed in on ADE Cloud for this account?", for a caller
 * outside Settings (the pre-send sign-in card of a cloud chat, B14-15): the
 * same answer the ADE Cloud tiles give (`adeCloudTile`), from the account's
 * sign-ins, its saved ADE Cloud keys and its Claude passes.
 *
 * Account-level: the reads take no pin. The account's sign-ins, keys and
 * passes are the same from every computer of the account, so the answer
 * does not depend on which machine the tab is bound to. Two reads per call,
 * on demand; no timer and no poll.
 *
 *   const answer = await readAdeCloudProviderSignIn("codex");
 *   if (answer.state === "not_signed_in") showSignInCard(answer.line, answer.action);
 */
import type { CloudSignInStatus } from "../../../../../shared/cloudSignIns";
import { isProviderLoginProvider, type ProviderLoginProvider, type ProviderLoginStatus } from "../../../../../shared/types/providerLogins";
import {
  adeCloudTile,
  type AdeCloudAccountPart,
  type AdeCloudCloudPart,
  type AdeCloudTileAction,
} from "./adeCloudSignInModel";

export type AdeCloudProviderSignIn =
  /** ADE Cloud can run this provider now. `via` says with what. */
  | { state: "signed_in"; provider: ProviderLoginProvider; via: "sign_in" | "saved_key" | "claude_pass" | "cloud_computer"; line: string }
  /** It can't: `line` says why in plain words, `action` the way out (null: nothing to press here). */
  | { state: "not_signed_in"; provider: ProviderLoginProvider; line: string; action: AdeCloudTileAction | null }
  /** The account could not be read, or this is not a provider ADE Cloud signs in. Don't hold Send on it. */
  | { state: "unknown"; provider: string; line: string };

/**
 * The pure answer from reads the caller already has. `cloud` is what one
 * cloud computer reported, when the caller has it; without it a provider
 * that needs a sign-in on the cloud computer itself reads as not signed in
 * there yet.
 */
export function adeCloudProviderSignIn(
  provider: string,
  parts: {
    account: AdeCloudAccountPart;
    saved: CloudSignInStatus["saved"] | null;
    cloud?: AdeCloudCloudPart;
    now?: number;
  },
): AdeCloudProviderSignIn {
  if (!isProviderLoginProvider(provider)) {
    return { state: "unknown", provider, line: "ADE Cloud doesn't keep a sign-in for this provider." };
  }
  const tile = adeCloudTile({
    provider,
    account: parts.account,
    cloud: parts.cloud ?? { state: "no_computer" },
    saved: parts.saved,
    keychainIsThisMac: false,
    now: parts.now ?? Date.now(),
  });
  const line = tile.facts[0]?.text ?? tile.chipLabel;
  if (tile.state === "connected") {
    const via = tile.source === "saved-key" ? "saved_key"
      : provider === "claude" ? "claude_pass"
        : tile.row === "F1" || tile.row === "T5" ? "cloud_computer"
          : "sign_in";
    return { state: "signed_in", provider, via, line };
  }
  if (tile.state === "sign-in") return { state: "not_signed_in", provider, line, action: tile.action };
  return { state: "unknown", provider, line };
}

/** Reads the account's sign-ins and saved keys (account-level, no pin) and answers for one provider. */
export async function readAdeCloudProviderSignIn(
  provider: string,
  options: { cloud?: AdeCloudCloudPart } = {},
): Promise<AdeCloudProviderSignIn> {
  const bridge = typeof window === "undefined" ? undefined : window.ade;
  if (!isProviderLoginProvider(provider)) return adeCloudProviderSignIn(provider, { account: { state: "failed" }, saved: null });
  const [status, signIns] = await Promise.all([
    bridge?.providerLogins?.status?.({ provider }, null).catch(() => null) ?? Promise.resolve(null),
    bridge?.cloud?.cloudSignInStatus?.().catch(() => null) ?? Promise.resolve(null),
  ]) as [ProviderLoginStatus | null, CloudSignInStatus | null];
  const account: AdeCloudAccountPart = status ? { state: "ok", status } : { state: "failed" };
  const saved = signIns && !signIns.unknown ? signIns.saved : null;
  return adeCloudProviderSignIn(provider, { account, saved, ...(options.cloud ? { cloud: options.cloud } : {}) });
}
