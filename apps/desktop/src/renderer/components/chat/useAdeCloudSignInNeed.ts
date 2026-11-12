/**
 * The pre-send sign-in check for a draft bound for ADE Cloud.
 *
 * The local sign-in card (#2171) asks the chat's computer, which a draft that
 * runs on a new ADE Cloud computer does not use (`draftSkipsLocalSignIn`).
 * This asks the account instead: the sign-ins the account carries to ADE
 * Cloud (`providerLogins.status`, its `cloud` picks) and the Claude passes,
 * plus the saved ADE Cloud keys (`cloud.cloudSignInStatus`). The words come
 * from `adeCloudProviderSignIn`, the same answer Settings › Providers › ADE
 * Cloud draws, so the card and that page never disagree.
 *
 * Only a definite "not signed in" holds Send. While the reads are out, when
 * one fails, or for a provider that signs in on the cloud computer itself
 * (nothing to know before that computer exists), there is no card.
 *
 * Swap point: the whole read is `readAdeCloudSignInParts`, beside the
 * answer it feeds. The sign-in backend is being reworked in parallel; when its
 * read API changes, change that one function.
 *
 * Cost: reads only while a draft is bound for ADE Cloud with a provider
 * picked, on open and on the two change events. No timer, no poll.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { isProviderLoginProvider, type ProviderLoginProvider } from "../../../shared/types/providerLogins";
import { adeCloudSettingsSearch } from "../settings/SettingsMachineScope";
import {
  adeCloudProviderSignIn,
  readAdeCloudSignInParts,
  type AdeCloudSignInParts,
} from "../settings/providers/cloud/adeCloudProviderSignIn";
import { providerSignInSpec } from "./ProviderSignInCard";

export type AdeCloudSignInNeed = {
  provider: ProviderLoginProvider;
  /** Claude needs a pass on ADE Cloud; any other provider needs a sign-in there. */
  kind: "claude-pass" | "sign-in";
  /** Changes with the need (provider and its line), so the strip remounts for a new one. */
  key: string;
};

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
  navigate,
}: {
  /** A draft bound for ADE Cloud, with nothing else holding its send. */
  enabled: boolean;
  /** The provider whose sign-in the picked model needs (null: its route brings its own). */
  provider: string | null;
  navigate: (to: string) => void;
}): {
  need: AdeCloudSignInNeed | null;
  recheck: () => void;
  /** Why Send is off while the need holds, for the composer. */
  blockReason: string | null;
  /** Opens Settings › Providers › ADE Cloud on the provider's page (Claude's has the pass sheet). */
  openSignIn: () => void;
} {
  const active = enabled && Boolean(provider);
  const [state, setState] = useState<AdeCloudSignInParts | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    return onAdeCloudSignInChanged(() => setTick((value) => value + 1));
  }, [active]);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    void readAdeCloudSignInParts().then(
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
    const { account } = state;
    // Sign-ins switched off for ADE Cloud: the person signs in on each cloud
    // computer, a choice and not a missing sign-in.
    if (account.state === "ok" && !account.status.cloud.enabled) return null;
    const answer = adeCloudProviderSignIn(provider, {
      account,
      saved: state.saved,
      // No computer to ask yet: Send makes a new one, which starts with the
      // account's sign-ins. "Unknown" keeps a provider that signs in on the
      // cloud computer itself from reading as not signed in.
      cloud: { state: "unknown" },
    });
    if (answer.state !== "not_signed_in") return null;
    return {
      provider,
      kind: provider === "claude" ? "claude-pass" : "sign-in",
      key: `ade-cloud:${provider}:${answer.line}`,
    };
  }, [active, provider, state]);

  const recheck = useCallback(() => setTick((value) => value + 1), []);
  const blockReason = need
    ? need.kind === "claude-pass"
      ? "Claude needs a pass on ADE Cloud first"
      : `Sign in to ${providerSignInSpec(need.provider)?.label ?? need.provider} on ADE Cloud first`
    : null;
  const needProvider = need?.provider ?? null;
  const openSignIn = useCallback(() => {
    if (!needProvider) return;
    navigate(`/settings${adeCloudSettingsSearch({ provider: needProvider })}`);
  }, [navigate, needProvider]);
  return { need, recheck, blockReason, openSignIn };
}
