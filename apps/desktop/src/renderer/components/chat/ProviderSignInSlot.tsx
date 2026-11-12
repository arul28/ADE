/**
 * The sign-in slot above the prompt box.
 *
 * The prompt box stays mounted and usable below it, so nothing the person
 * typed moves or hides while a provider is signed out. Two states:
 * - the strip: one line that says the provider is not signed in on the chat's
 *   machine, with a "Sign in" button;
 * - the card: `ProviderSignInComposer`, shown after "Sign in" or at once when
 *   a send just failed on the sign-in. The card draws its own frame.
 *
 * All strip styling lives in `providerSignInSlot.css`, so a design pass can
 * tune it in one place.
 */
import { memo, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import { ProviderLogo } from "../shared/ProviderLogos";
import { providerColor } from "../usage/providerColors";
import { providerSignInSpec } from "./ProviderSignInCard";
import "./providerSignInSlot.css";

export const ProviderSignInStrip = memo(function ProviderSignInStrip({
  provider,
  machineName,
  runsHere,
  adeCloudPass = false,
  onSignIn,
}: {
  provider: string;
  machineName: string;
  /** The chat runs on the computer in front of the person. */
  runsHere: boolean;
  /** Claude on ADE Cloud: what it needs there is a pass, not a sign-in. */
  adeCloudPass?: boolean;
  onSignIn: () => void;
}) {
  // A pass is Claude's own (the account's plan), not Claude Code's sign-in.
  const label = adeCloudPass ? "Claude" : providerSignInSpec(provider)?.label ?? provider;
  const where = runsHere || machineName === THIS_MACHINE_NAME ? "this computer" : machineName;
  return (
    <div
      className="ade-psi-strip"
      data-testid="provider-sign-in-strip"
      data-provider={provider}
      // A brand tint only. Text and edges mix it into theme tokens, so light
      // themes read the same as dark ones.
      style={{ "--psi-accent": providerColor(provider) } as CSSProperties}
    >
      <span className="ade-psi-logo" aria-hidden>
        <ProviderLogo family={provider} size={13} />
      </span>
      <span className="ade-psi-text ade-psi-long">
        <span className="ade-psi-lead">{adeCloudPass ? `${label} needs a pass on\u00a0` : `${label} isn't signed in on\u00a0`}</span>
        <span className="ade-psi-machine" title={where}>{where}</span>
        <span className="ade-psi-end">.</span>
      </span>
      {/* The narrowest prompt box: the sentence shortens before the button
          could be cut. */}
      <span className="ade-psi-text ade-psi-short">
        <span className="ade-psi-lead">{adeCloudPass ? `${label}: needs a pass` : `${label}: not signed in`}</span>
      </span>
      <button type="button" className="kit-btn ade-psi-button" data-size="sm" onClick={onSignIn}>
        Sign in
      </button>
    </div>
  );
});

/**
 * Holds the open card. The card focuses its own button when it mounts; that
 * focus stays only when the person opened it from the strip. When the card
 * goes while focus is inside it, focus goes back to the prompt box.
 */
export function ProviderSignInCardHolder({
  openedFromStrip,
  onReturnFocus,
  children,
}: {
  openedFromStrip: boolean;
  onReturnFocus: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Read during the first render, before the card's own focus runs.
  const [focusBefore] = useState<Element | null>(() => (typeof document === "undefined" ? null : document.activeElement));
  const onReturnFocusRef = useRef(onReturnFocus);
  onReturnFocusRef.current = onReturnFocus;
  const openedFromStripRef = useRef(openedFromStrip);

  // A parent's layout effect runs after the child's mount focus.
  useLayoutEffect(() => {
    const node = ref.current;
    if (
      node
      && !openedFromStripRef.current
      && node.contains(document.activeElement)
      && focusBefore instanceof HTMLElement
      && focusBefore.isConnected
      && !node.contains(focusBefore)
    ) {
      focusBefore.focus({ preventScroll: true });
    }
    return () => {
      // Still in the DOM here; focus the prompt box once the card is gone.
      if (node?.contains(document.activeElement)) queueMicrotask(() => onReturnFocusRef.current());
    };
  }, [focusBefore]);

  return (
    <div ref={ref} className="ade-psi-holder" data-grow={openedFromStrip ? "true" : undefined}>
      {children}
    </div>
  );
}
