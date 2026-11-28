/**
 * The sign-in slot above the prompt box.
 *
 * The prompt box stays mounted and usable below it, so nothing the person
 * typed moves or hides while a provider is signed out. Two states:
 * - the strip: one line that says the provider is not signed in on the chat's
 *   machine, with a "Sign in" button (and, for a brand-new person, "Use a
 *   free model");
 * - the card: `ProviderSignInComposer`, shown after "Sign in" or at once when
 *   a send just failed on the sign-in. The card draws its own frame.
 *
 * All strip styling lives in `providerSignInSlot.css`, so a design pass can
 * tune it in one place. `ComposerStrip` is the one strip frame: the sign-in
 * strip and the newer-version strip (`ModelUpgradeStrip.tsx`) are both built
 * from it, and `ComposerNoticeStack` joins two of them into one tab.
 */
import { Children, memo, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Gift } from "@phosphor-icons/react";
import { THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import { ProviderLogo } from "../shared/ProviderLogos";
import { providerColor } from "../usage/providerColors";
import { providerSignInSpec } from "./ProviderSignInCard";
import "./providerSignInSlot.css";

/**
 * One strip above the prompt box: a logo, one sentence (a shorter one when
 * the box is narrow), then its actions. `accent` tints it; text and edges mix
 * the tint into theme tokens, so light themes read the same as dark ones.
 */
export function ComposerStrip({
  accent,
  logo,
  long,
  short,
  title,
  testId,
  dataAttributes,
  children,
}: {
  accent: string;
  logo: ReactNode;
  /** The sentence: lead text, then the emphasized name, then its end. */
  long: { lead: string; strong: string; end: string };
  /** The narrowest box: this replaces the sentence before a button is cut. */
  short: string;
  title?: string;
  testId: string;
  dataAttributes?: Record<`data-${string}`, string>;
  children: ReactNode;
}) {
  return (
    <div
      className="ade-psi-strip"
      data-testid={testId}
      {...dataAttributes}
      title={title}
      style={{ "--psi-accent": accent } as CSSProperties}
    >
      <span className="ade-psi-logo" aria-hidden>{logo}</span>
      <span className="ade-psi-text ade-psi-long">
        <span className="ade-psi-lead">{long.lead}</span>
        <span className="ade-psi-machine" title={long.strong}>{long.strong}</span>
        <span className="ade-psi-end">{long.end}</span>
      </span>
      <span className="ade-psi-text ade-psi-short">
        <span className="ade-psi-lead">{short}</span>
      </span>
      {children}
    </div>
  );
}

/**
 * The strips above the prompt box as one tab on it. Two at once (not signed
 * in, and a newer version) stack in one frame, each its own line, rather than
 * two tabs fighting for the box's top edge. Nothing to show renders nothing.
 */
export function ComposerNoticeStack({ children }: { children: ReactNode }) {
  const items = Children.toArray(children);
  if (items.length === 0) return null;
  if (items.length === 1) return <>{items}</>;
  return <div className="ade-psi-stack" data-testid="composer-notice-stack">{items}</div>;
}

export const ProviderSignInStrip = memo(function ProviderSignInStrip({
  provider,
  machineName,
  runsHere,
  adeCloudPass = false,
  onSignIn,
  onUseFreeModel,
}: {
  provider: string;
  machineName: string;
  /** The chat runs on the computer in front of the person. */
  runsHere: boolean;
  /** Claude on ADE Cloud: what it needs there is a pass, not a sign-in. */
  adeCloudPass?: boolean;
  onSignIn: () => void;
  /**
   * Shown only to a brand-new person (nothing signed in, never was): switch
   * this chat to a free model instead (`shared/freeModels.ts`).
   */
  onUseFreeModel?: () => void;
}) {
  // A pass is Claude's own (the account's plan), not Claude Code's sign-in.
  const label = adeCloudPass ? "Claude" : providerSignInSpec(provider)?.label ?? provider;
  const where = runsHere || machineName === THIS_MACHINE_NAME ? "this computer" : machineName;
  return (
    <ComposerStrip
      accent={providerColor(provider)}
      logo={<ProviderLogo family={provider} size={13} />}
      long={{
        lead: adeCloudPass ? `${label} needs a pass on ` : `${label} isn't signed in on `,
        strong: where,
        end: ".",
      }}
      short={adeCloudPass ? `${label}: needs a pass` : `${label}: not signed in`}
      testId="provider-sign-in-strip"
      dataAttributes={{ "data-provider": provider }}
    >
      {onUseFreeModel ? (
        <button
          type="button"
          className="kit-btn ade-psi-button ade-psi-free"
          data-size="sm"
          data-testid="provider-sign-in-use-free-model"
          onClick={onUseFreeModel}
        >
          <Gift size={11} weight="fill" aria-hidden className="ade-psi-free-mark" />
          <span className="ade-psi-long">Use a free model</span>
          <span className="ade-psi-short">Free model</span>
        </button>
      ) : null}
      <button type="button" className="kit-btn ade-psi-button" data-size="sm" onClick={onSignIn}>
        Sign in
      </button>
    </ComposerStrip>
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
