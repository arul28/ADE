/**
 * The pre-send sign-in check for a draft bound for ADE Cloud.
 *
 * The local sign-in card (#2171) asks the chat's computer, which a draft that
 * runs on a new ADE Cloud computer does not use (`draftSkipsLocalSignIn`).
 * This asks the account instead: the sign-ins the account carries to ADE
 * Cloud (`providerLogins.status`, its `cloud` picks) and the Claude passes,
 * plus the saved ADE Cloud keys (`cloud.cloudSignInStatus`). The words come
 * from the same tile model Settings › Providers › ADE Cloud draws, so the
 * card and that page never disagree.
 *
 * Only a definite "not signed in" holds Send. While the reads are out, when
 * one fails, or for a provider that signs in on the cloud computer itself
 * (nothing to know before that computer exists), there is no card.
 *
 * Swap point: the whole read is `readAdeCloudSignInState` below. The sign-in
 * backend is being reworked in parallel; when its read API changes, change
 * that one function.
 *
 * Cost: reads only while a draft is bound for ADE Cloud with a provider
 * picked, on open and on the two change events. No timer, no poll.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CloudSignInStatus } from "../../../shared/cloudSignIns";
import {
  isProviderLoginProvider,
  type ProviderLoginProvider,
  type ProviderLoginStatus,
} from "../../../shared/types/providerLogins";
import { adeCloudTile } from "../settings/providers/cloud/adeCloudSignInModel";

export type AdeCloudSignInNeed = {
  provider: ProviderLoginProvider;
  /** Claude needs a pass on ADE Cloud; any other provider needs a sign-in there. */
  kind: "claude-pass" | "sign-in";
  /** Stable while the need holds, so a Not now stays dismissed. */
  key: string;
};

type AdeCloudSignInState = {
  account: ProviderLoginStatus | null;
  accountFailed: boolean;
  saved: CloudSignInStatus["saved"] | null;
};

/**
 * The account's ADE Cloud sign-ins, read once. Unpinned on purpose: these are
 * the account's choices, the same from any of the person's machines, and the
 * tab's machine is the one this window always reaches. Nothing here acts on a
 * chat, a lane or a computer.
 */
async function readAdeCloudSignInState(): Promise<AdeCloudSignInState> {
  const [account, saved] = await Promise.allSettled([
    window.ade?.providerLogins?.status?.({}) ?? Promise.resolve(null),
    window.ade?.cloud?.cloudSignInStatus?.() ?? Promise.resolve(null),
  ]);
  const signIns = saved.status === "fulfilled" ? saved.value : null;
  const status = account.status === "fulfilled" ? account.value ?? null : null;
  // A brain that cannot read the account (a dev brain, sync off, signed out,
  // the vault unreadable) answers with no sign-ins at all. That is "not
  // known", never "not signed in": no card from it.
  const readsAccount = status != null && (status.thisComputer.capture === "on" || status.thisComputer.reason === "all_off");
  return {
    account: readsAccount ? status : null,
    accountFailed: account.status === "rejected" || (status != null && !readsAccount),
    saved: signIns && !signIns.unknown ? signIns.saved : null,
  };
}

/** Subscribes to the two change events while `enabled`; returns an unsubscribe. */
function onAdeCloudSignInChanged(listener: () => void): () => void {
  const offLogins = window.ade?.providerLogins?.onChanged?.(listener);
  const offCloud = window.ade?.cloud?.onCloudSignInChanged?.(listener);
  return () => {
    offLogins?.();
    offCloud?.();
  };
}

export function useAdeCloudSignInNeed({
  enabled,
  provider,
}: {
  /** A draft bound for ADE Cloud, with nothing else holding its send. */
  enabled: boolean;
  /** The provider whose sign-in the picked model needs (null: its route brings its own). */
  provider: string | null;
}): { need: AdeCloudSignInNeed | null; recheck: () => void } {
  const active = enabled && Boolean(provider);
  const [state, setState] = useState<AdeCloudSignInState | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    return onAdeCloudSignInChanged(() => setTick((value) => value + 1));
  }, [active]);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    void readAdeCloudSignInState().then(
      (next) => {
        if (!cancelled) setState(next);
      },
      (error: unknown) => {
        console.warn("[chat] reading the account's ADE Cloud sign-ins failed", error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active, tick]);

  const need = useMemo<AdeCloudSignInNeed | null>(() => {
    if (!active || !state || !provider || !isProviderLoginProvider(provider)) return null;
    const account = state.account
      ? { state: "ok" as const, status: state.account }
      : state.accountFailed ? { state: "failed" as const } : { state: "loading" as const };
    const tile = adeCloudTile({
      provider,
      account,
      // No computer to ask yet: Send makes a new one, which starts with the
      // account's sign-ins.
      cloud: { state: "unknown" },
      saved: state.saved,
      keychainIsThisMac: false,
      now: Date.now(),
    });
    // T1: the person turned sign-ins off for ADE Cloud and signs in on each
    // cloud computer; that is a choice, not a missing sign-in.
    if (tile.state !== "sign-in" || tile.row === "T1") return null;
    return {
      provider,
      kind: provider === "claude" ? "claude-pass" : "sign-in",
      key: `ade-cloud:${provider}:${tile.row}`,
    };
  }, [active, provider, state]);

  const recheck = useCallback(() => setTick((value) => value + 1), []);
  return { need, recheck };
}
