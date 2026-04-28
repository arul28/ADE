import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../../state/appStore";
import { useOnboardingStore } from "../../state/onboardingStore";
import { openExternalUrl } from "../../lib/openExternal";
import { docs } from "../../onboarding/docsLinks";

type Hint = {
  id: string;
  body: string;
  docUrl?: string;
};

const SESSION_KEY = "ade.didYouKnow.shown";

const DEFAULT_HINTS: Hint[] = [
  {
    id: "lanes-parallel",
    body: "Did you know? Each Lane is its own folder on disk, so changes in one Lane can't mess up another.",
    docUrl: docs.lanesOverview,
  },
  {
    id: "help-menu",
    body: "Did you know? You can replay any tour anytime from the Help menu in the top-right.",
    docUrl: docs.welcome,
  },
  {
    id: "help-chip",
    body: "Did you know? The small \"?\" next to a word opens a quick plain-English definition.",
    docUrl: docs.keyConcepts,
  },
];

type DidYouKnowProps = {
  hints?: Hint[];
};

export function DidYouKnow({ hints }: DidYouKnowProps) {
  const onboardingEnabled = useAppStore((s) => s.onboardingEnabled);
  const didYouKnowEnabled = useAppStore((s) => s.didYouKnowEnabled);
  const activeTourId = useOnboardingStore((s) => s.activeTourId);
  const [dismissed, setDismissed] = useState(false);
  const [hint, setHint] = useState<Hint | null>(null);

  useEffect(() => {
    if (activeTourId) return;
    if (!onboardingEnabled || !didYouKnowEnabled) return;
    try {
      if (sessionStorage.getItem(SESSION_KEY) === "1") return;
    } catch {
      // sessionStorage unavailable — fall through and show anyway.
    }
    const pool = hints && hints.length > 0 ? hints : DEFAULT_HINTS;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    setHint(pick ?? null);
    try {
      sessionStorage.setItem(SESSION_KEY, "1");
    } catch {
      /* ignore */
    }
  }, [activeTourId, onboardingEnabled, didYouKnowEnabled, hints]);

  if (activeTourId) return null;
  if (!onboardingEnabled || !didYouKnowEnabled) return null;
  if (!hint || dismissed) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="ade-didyouknow"
      style={{
        position: "fixed",
        bottom: 18,
        right: 18,
        zIndex: 9996,
        maxWidth: 340,
        background: "var(--color-popup-bg, #151325)",
        color: "var(--color-fg, #F0F0F2)",
        border: "1px solid rgba(255, 255, 255, 0.10)",
        borderRadius: 10,
        padding: "12px 14px",
        boxShadow: "0 12px 30px -8px rgba(0, 0, 0, 0.6)",
        fontFamily: "var(--font-sans)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 10,
        }}
      >
        <p
          style={{
            fontSize: 12.5,
            lineHeight: 1.5,
            margin: 0,
            color: "var(--color-muted-fg, #B7B6C3)",
          }}
        >
          {hint.body}
        </p>
        <button
          type="button"
          aria-label="Dismiss hint"
          onClick={() => setDismissed(true)}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--color-muted-fg, #908FA0)",
            fontSize: 16,
            lineHeight: 1,
            cursor: "pointer",
            padding: 2,
          }}
        >
          ×
        </button>
      </div>
      {hint.docUrl ? (
        <a
          href={hint.docUrl}
          onClick={(e) => {
            e.preventDefault();
            openExternalUrl(hint.docUrl);
          }}
          className="ade-stt-doc"
          style={{ display: "inline-block", marginTop: 6 }}
        >
          Learn more →
        </a>
      ) : null}
    </div>,
    document.body,
  );
}
