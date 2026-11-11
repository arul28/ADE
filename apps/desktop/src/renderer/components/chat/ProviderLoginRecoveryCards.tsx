/**
 * The sign-in cards above the prompt box that know about ADE Cloud.
 *
 * - `ChatSignInCard`: the provider sign-in card. A Claude chat on an ADE
 *   Cloud computer gets the Claude pass approve in its place: one approve
 *   gives every cloud chat the person's Claude plan. "Sign in on <computer>
 *   instead" keeps the normal sign-in there.
 * - `AccountSwitchRecoveryCard`: the first turn after the chat's account
 *   changed failed. The provider may refuse to continue a conversation that
 *   another account started, so the card offers a new thread with the
 *   history, or the old account again.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { SpinnerGap, X } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { CloudSignInStatus } from "../../../shared/cloudSignIns";
import { useCloudComputer } from "../remoteTargets/useCloudComputer";
import { providerBrand, providerThemeVars } from "../settings/providers/providerBrand";
import { SignInBrandLogo } from "../settings/providers/signInSheetParts";
import { ClaudePassSignInSheet, type ClaudePassRequest } from "../settings/providers/cloud/ClaudePassSignInSheet";
import { CardBannerButtons, CardError, cardEscapeHandler } from "./composerCardParts";
import { ProviderSignInComposer, providerSignInSpec, type ProviderSignInNeed } from "./ProviderSignInCard";

/** How long the card shows a saved pass before it hands the prompt box back. */
const PASS_SAVED_HOLD_MS = 900;
const NEW_PASS: ClaudePassRequest = { renewKey: null, forEmail: null };

type ChatSignInCardProps = Parameters<typeof ProviderSignInComposer>[0];

export function ChatSignInCard(props: ChatSignInCardProps) {
  const { need, pin } = props;
  // Only a Claude chat on another machine can be on a cloud computer.
  const maybeCloud = need.provider === "claude" && pin?.kind === "remote";
  const { box } = useCloudComputer(pin, maybeCloud);
  const [signInHere, setSignInHere] = useState(false);
  if (maybeCloud && box && !signInHere) {
    return (
      <CloudClaudePassCard
        need={need}
        pin={pin}
        machineName={props.machineName}
        onPassSaved={props.onSignedIn}
        onSignInHere={() => setSignInHere(true)}
        onDismiss={props.onDismiss}
        onOpenSettings={props.onOpenSettings}
      />
    );
  }
  return <ProviderSignInComposer {...props} />;
}

function CloudClaudePassCard({
  need,
  pin,
  machineName,
  onPassSaved,
  onSignInHere,
  onDismiss,
  onOpenSettings,
}: {
  need: ProviderSignInNeed;
  pin: OpenProjectBinding | null;
  machineName: string;
  onPassSaved: () => void;
  onSignInHere: () => void;
  onDismiss: () => void;
  onOpenSettings: () => void;
}) {
  const brand = providerBrand("claude");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [status, setStatus] = useState<CloudSignInStatus | null>(null);
  const mountedRef = useRef(true);

  // The account's passes and the approve: read only while the sheet is open.
  const reload = useCallback(async () => {
    try {
      const next = await window.ade?.cloud?.cloudSignInStatus?.();
      if (mountedRef.current && next) setStatus(next);
    } catch (error) {
      console.warn("[chat] reading the Claude passes failed", error);
    }
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (!sheetOpen) return undefined;
    void reload();
    const off = window.ade?.cloud?.onCloudSignInChanged?.(() => void reload());
    return () => off?.();
  }, [reload, sheetOpen]);
  const applyStatus = useCallback((next: CloudSignInStatus | null | undefined) => {
    if (next) setStatus(next);
  }, []);

  // Saved: the cloud computer takes the pass on its next sign-in pass; ask it
  // for one now, so the message that waits can go at once.
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const onPassSavedRef = useRef(onPassSaved);
  onPassSavedRef.current = onPassSaved;
  useEffect(() => {
    if (!saved) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await window.ade?.providerLogins?.captureNow?.({}, pinRef.current);
        } catch (error) {
          // The cloud computer takes the pass on its own next pass.
          console.warn("[chat] asking the cloud computer to take the pass failed", error);
        }
        if (!cancelled) onPassSavedRef.current();
      })();
    }, PASS_SAVED_HOLD_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [saved]);

  const heading = need.reason === "failed-turn" ? "Approve a Claude pass again" : "Approve a Claude pass";
  const reason = need.reason === "failed-turn"
    ? `${machineName} has no Claude pass that works. Approve one, and your message sends again.`
    : `${machineName} runs on ADE Cloud. One approve lets your cloud chats use your Claude plan for about a year.`;

  return (
    <div
      role="group"
      aria-label={heading}
      data-testid="cloud-claude-pass-card"
      data-sign-in-card="true"
      className="ade-icc"
      data-light={brand.lightBanner ? "true" : undefined}
      style={{ ...providerThemeVars(brand), ["--ig-accent" as string]: brand.accent }}
      tabIndex={-1}
      // The sheet's own keys bubble here through React; while it is open, Esc is the sheet's.
      onKeyDown={cardEscapeHandler({ signingIn: false, cancelSignIn: () => undefined, responding: sheetOpen, onDecline: onDismiss })}
    >
      <div className="ade-icc-banner" style={brand.banner}>
        {brand.bannerArt ? (
          <img className="ade-icc-banner-art ade-psc-banner-art" src={brand.bannerArt.src} alt="" draggable={false} style={{ opacity: brand.bannerArt.opacity ?? 1 }} />
        ) : null}
        <div className="ade-icc-banner-shade" aria-hidden />
        <span className="ade-icc-logo"><SignInBrandLogo providerId="claude" size={25} turn={saved} /></span>
        <span className="ade-icc-heading">
          <span className="ade-icc-heading-text"><span className="ade-icc-title">{heading}</span></span>
        </span>
        <span className="ade-icc-banner-tools">
          <span className="ade-icc-chip" title={`This chat runs on ${machineName}`}>on {machineName}</span>
          <CardBannerButtons
            onOpenSettings={onOpenSettings}
            onDecline={onDismiss}
            responding={false}
            signingIn={false}
            cancelSignIn={() => undefined}
            testIdPrefix="cloud-claude-pass"
          />
        </span>
      </div>
      <div className="ade-icc-body">
        <div className="ade-sis" data-compact="true" data-card="true">
          {saved ? (
            <p className="ade-icc-reason" role="status">
              <SpinnerGap size={13} weight="bold" className="motion-safe:animate-spin" /> Pass saved. Sending to {machineName}…
            </p>
          ) : (
            <>
              <p className="ade-icc-reason">{reason}</p>
              <div className="ade-sis-start-row">
                <button
                  type="button"
                  className="ade-icc-primary ade-icc-primary-brand"
                  autoFocus
                  data-testid="cloud-claude-pass-start"
                  onClick={() => setSheetOpen(true)}
                >
                  Approve a pass
                </button>
                <button type="button" className="ade-icc-link ade-icc-link-dim" onClick={onSignInHere}>
                  Sign in on {machineName} instead
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      {sheetOpen ? (
        <ClaudePassSignInSheet
          request={NEW_PASS}
          status={status}
          applyStatus={applyStatus}
          reload={reload}
          onSaved={() => setSaved(true)}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
    </div>
  );
}

export function AccountSwitchRecoveryCard({
  provider,
  fromLabel,
  toLabel,
  canChangeBack,
  onNewThread,
  onChangeBack,
  onDismiss,
}: {
  provider: string;
  fromLabel: string;
  toLabel: string;
  /** The old account is a saved account of the chat (not ADE Cloud's pick). */
  canChangeBack: boolean;
  onNewThread: () => Promise<string | null>;
  onChangeBack: () => Promise<string | null>;
  onDismiss: () => void;
}) {
  const label = providerSignInSpec(provider)?.label ?? provider;
  const brand = providerBrand(provider);
  const [busy, setBusy] = useState<"new" | "back" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (which: "new" | "back", action: () => Promise<string | null>) => {
    setBusy(which);
    setError(null);
    const failure = await action().catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
    setBusy(null);
    if (failure) setError(failure);
  }, []);
  const heading = `${label} did not continue this chat`;
  return (
    <div
      role="group"
      aria-label={heading}
      data-testid="account-switch-recovery-card"
      className="ade-icc"
      data-light={brand.lightBanner ? "true" : undefined}
      style={{ ...providerThemeVars(brand), ["--ig-accent" as string]: brand.accent }}
      tabIndex={-1}
      onKeyDown={cardEscapeHandler({ signingIn: false, cancelSignIn: () => undefined, responding: busy != null, onDecline: onDismiss })}
    >
      <div className="ade-icc-banner" style={brand.banner}>
        <div className="ade-icc-banner-shade" aria-hidden />
        <span className="ade-icc-logo"><SignInBrandLogo providerId={provider} size={25} turn={false} /></span>
        <span className="ade-icc-heading">
          <span className="ade-icc-heading-text"><span className="ade-icc-title">{heading}</span></span>
        </span>
        <span className="ade-icc-banner-tools">
          <button type="button" className="ade-icc-close" aria-label="Not now" title="Not now (Esc)" onClick={onDismiss} disabled={busy != null}>
            <X size={13} weight="bold" />
          </button>
        </span>
      </div>
      <div className="ade-icc-body">
        <div className="ade-sis" data-compact="true" data-card="true">
          <p className="ade-icc-reason">
            The last message failed after the switch from {fromLabel} to {toLabel}. {label} may not continue a
            conversation that another account started. Your message is saved.
          </p>
          <div className="ade-sis-start-row">
            <button
              type="button"
              className="ade-icc-primary ade-icc-primary-brand"
              autoFocus
              disabled={busy != null}
              data-testid="account-switch-new-thread"
              onClick={() => void run("new", onNewThread)}
            >
              {busy === "new" ? <SpinnerGap size={13} weight="bold" className="motion-safe:animate-spin" /> : null}
              Continue in a new thread
            </button>
            {canChangeBack ? (
              <button
                type="button"
                className="ade-icc-link"
                disabled={busy != null}
                data-testid="account-switch-change-back"
                onClick={() => void run("back", onChangeBack)}
              >
                {busy === "back" ? "Changing back…" : `Change back to ${fromLabel}`}
              </button>
            ) : null}
          </div>
        </div>
        {error ? <CardError id="account-switch-error" message={error} /> : null}
      </div>
    </div>
  );
}
