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
 *   const parts = await readAdeCloudSignInParts();
 *   const answer = adeCloudProviderSignIn("codex", parts);
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
    keyringIsThisComputer: false,
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

/** The account's half of an answer, read once for every provider (`readAdeCloudSignInParts`). */
export type AdeCloudSignInParts = {
  account: AdeCloudAccountPart;
  saved: CloudSignInStatus["saved"] | null;
};

/**
 * Reads the account's sign-ins and saved ADE Cloud keys (account-level, no
 * pin), for `adeCloudProviderSignIn`. Never throws: a read that fails is
 * `account: failed` or `saved: null`, and the reason is logged.
 *
 * A brain that cannot read the account (a dev brain, sync off, signed out,
 * the vault unreadable) answers with no sign-ins at all. That is "not known",
 * never "not signed in": it reads as `failed`, so no card comes from it.
 */
export async function readAdeCloudSignInParts(): Promise<AdeCloudSignInParts> {
  const bridge = typeof window === "undefined" ? undefined : window.ade;
  const [account, signIns] = await Promise.allSettled([
    bridge?.providerLogins?.status?.({}) ?? Promise.resolve(null),
    bridge?.cloud?.cloudSignInStatus?.() ?? Promise.resolve(null),
  ]);
  if (account.status === "rejected") console.warn("[cloud] reading the account's sign-ins failed", account.reason);
  if (signIns.status === "rejected") console.warn("[cloud] reading the saved ADE Cloud keys failed", signIns.reason);
  const status: ProviderLoginStatus | null = account.status === "fulfilled" ? account.value ?? null : null;
  const readsAccount = status != null && (status.thisComputer.capture === "on" || status.thisComputer.reason === "all_off");
  const saved: CloudSignInStatus | null = signIns.status === "fulfilled" ? signIns.value ?? null : null;
  return {
    account: status && readsAccount
      ? { state: "ok", status }
      : account.status === "rejected" || status != null ? { state: "failed" } : { state: "loading" },
    saved: saved && !saved.unknown ? saved.saved : null,
  };
}
