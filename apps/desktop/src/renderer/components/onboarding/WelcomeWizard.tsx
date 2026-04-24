import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useOnboardingStore } from "../../state/onboardingStore";
import { openExternalUrl } from "../../lib/openExternal";
import {
  WelcomeIllustration,
  LanesIllustration,
  MissionsIllustration,
  HelpIllustration,
} from "./illustrations/WelcomeIllustrations";
import { docs } from "../../onboarding/docsLinks";
const INTERACTIVE_SHORTCUT_SELECTOR =
  'button, a[href], input, select, textarea, [contenteditable]:not([contenteditable="false"])';

type Screen = {
  eyebrow: string;
  title: string;
  body: string;
  learnMoreHref: string;
  Illustration: React.FC;
};

// Mintlify slugs verified against docs.json.
// Screens merged: "Worktrees" folded into "Lanes" so the concept is introduced once as
// "a Lane is just a Git worktree." Five-screen copy-wall shortened to four punchier ones.
export const WELCOME_SCREENS: Screen[] = [
  {
    eyebrow: "What ADE is",
    title: "Work on many things at once",
    body: "ADE lets you juggle parallel changes without mixing them up. Think of each change as its own desk.",
    learnMoreHref: docs.welcome,
    Illustration: WelcomeIllustration,
  },
  {
    eyebrow: "The one word you need",
    title: "A Lane is a worktree",
    body: "A Lane is a Git worktree — a real folder on disk with its own branch — that ADE watches over for you.",
    learnMoreHref: docs.lanesOverview,
    Illustration: LanesIllustration,
  },
  {
    eyebrow: "Hand work to AI",
    title: "Missions & Workers",
    body: "Describe a job in plain words and a Worker does it on its own Lane. Your main branch stays untouched.",
    learnMoreHref: docs.keyConcepts,
    Illustration: MissionsIllustration,
  },
  {
    eyebrow: "Always within reach",
    title: "Help lives in the top right",
    body: "The ? icon holds tours, the Glossary, and docs. Hover any button and a tooltip explains what happens.",
    learnMoreHref: docs.gettingStartedFirstLane,
    Illustration: HelpIllustration,
  },
];

function shouldLetEnterActivateTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(INTERACTIVE_SHORTCUT_SELECTOR) != null;
}

export function WelcomeWizard() {
  const wizardOpen = useOnboardingStore((s) => s.wizardOpen);
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const cardRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const closeAsDismissed = useCallback(async () => {
    const ade = (typeof window !== "undefined" ? (window as any).ade : undefined) as
      | { onboarding?: Window["ade"]["onboarding"] }
      | undefined;
    const onboarding = ade?.onboarding ?? null;
    useOnboardingStore.setState({ wizardOpen: false });
    if (onboarding) {
      const progress = await onboarding.markWizardDismissed();
      useOnboardingStore.setState({ progress });
    }
  }, []);

  const closeAsCompleted = useCallback(async () => {
    const ade = (typeof window !== "undefined" ? (window as any).ade : undefined) as
      | { onboarding?: Window["ade"]["onboarding"] }
      | undefined;
    const onboarding = ade?.onboarding ?? null;
    useOnboardingStore.setState({ wizardOpen: false });
    if (onboarding) {
      const progress = await onboarding.markWizardCompleted();
      useOnboardingStore.setState({ progress });
    }
  }, []);

  useEffect(() => {
    if (wizardOpen) {
      setIndex(0);
      setDirection("forward");
    }
  }, [wizardOpen]);

  useEffect(() => {
    if (!wizardOpen) return;
    previouslyFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null;
    return () => {
      const prev = previouslyFocusedRef.current;
      if (prev && typeof prev.focus === "function") {
        try {
          prev.focus();
        } catch {
          /* ignore */
        }
      }
    };
  }, [wizardOpen]);

  useEffect(() => {
    if (!wizardOpen) return;
    const card = cardRef.current;
    if (!card) return;
    const primary = card.querySelector<HTMLElement>('[data-wizard-primary="true"]');
    if (primary) {
      try {
        primary.focus();
      } catch {
        /* ignore */
      }
    }
  }, [wizardOpen, index]);

  useEffect(() => {
    if (!wizardOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void closeAsDismissed();
        return;
      }
      if (e.key === "ArrowRight" || e.key === "Enter") {
        if (e.key === "Enter" && shouldLetEnterActivateTarget(e.target)) return;
        e.preventDefault();
        const isLast = index === WELCOME_SCREENS.length - 1;
        if (isLast) void closeAsCompleted();
        else {
          setDirection("forward");
          setIndex((i) => Math.min(WELCOME_SCREENS.length - 1, i + 1));
        }
        return;
      }
      if (e.key === "ArrowLeft") {
        setDirection("back");
        setIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Tab") {
        const card = cardRef.current;
        if (!card) return;
        const focusables = Array.from(
          card.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => !el.hasAttribute("disabled"));
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [wizardOpen, closeAsDismissed, closeAsCompleted, index]);

  if (!wizardOpen) return null;
  if (typeof document === "undefined") return null;

  const screen = WELCOME_SCREENS[index];
  const isLast = index === WELCOME_SCREENS.length - 1;
  const progressPercent = ((index + 1) / WELCOME_SCREENS.length) * 100;

  return createPortal(
    <div
      className="ade-welcome-backdrop"
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9997,
        background: "rgba(4, 2, 14, 0.62)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        animation: "ade-wizard-backdrop-in 220ms ease-out",
      }}
    >
      <div
        ref={cardRef}
        className="ade-welcome-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ade-welcome-title"
        style={{
          width: "min(560px, 100%)",
          background:
            "radial-gradient(120% 140% at 0% 0%, rgba(167, 139, 250, 0.10), transparent 55%), var(--color-popup-bg, #141022)",
          color: "var(--color-fg, #F0F0F2)",
          border: "1px solid rgba(255, 255, 255, 0.10)",
          borderRadius: 16,
          padding: "0",
          boxShadow: "0 30px 80px -20px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(167, 139, 250, 0.08)",
          fontFamily: "var(--font-sans)",
          overflow: "hidden",
          animation: "ade-wizard-card-in 260ms cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        {/* Progress bar */}
        <div
          style={{
            height: 2,
            background: "rgba(255, 255, 255, 0.06)",
            position: "relative",
          }}
          aria-hidden="true"
        >
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              height: "100%",
              width: `${progressPercent}%`,
              background:
                "linear-gradient(90deg, var(--color-accent, #A78BFA), #EC4899)",
              transition: "width 320ms cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          />
        </div>

        {/* Header: eyebrow + X */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "14px 22px 0",
          }}
        >
          <span
            style={{
              fontSize: 10.5,
              color: "var(--color-accent, #A78BFA)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              fontWeight: 600,
            }}
          >
            {screen.eyebrow}
          </span>
          <button
            type="button"
            aria-label="Skip welcome"
            onClick={() => void closeAsDismissed()}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--color-muted-fg, #908FA0)",
              fontSize: 18,
              lineHeight: 1,
              cursor: "pointer",
              padding: 4,
            }}
          >
            ×
          </button>
        </div>

        {/* Illustration */}
        <div
          key={`illo-${index}`}
          style={{
            padding: "18px 22px 8px",
            display: "flex",
            justifyContent: "center",
            animation:
              direction === "forward"
                ? "ade-wizard-illo-in-forward 320ms cubic-bezier(0.22, 1, 0.36, 1)"
                : "ade-wizard-illo-in-back 320ms cubic-bezier(0.22, 1, 0.36, 1)",
          }}
          aria-hidden="true"
        >
          <screen.Illustration />
        </div>

        {/* Content */}
        <div
          key={`content-${index}`}
          style={{
            padding: "4px 26px 20px",
            animation:
              direction === "forward"
                ? "ade-wizard-text-in-forward 320ms 40ms both cubic-bezier(0.22, 1, 0.36, 1)"
                : "ade-wizard-text-in-back 320ms 40ms both cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        >
          <h2
            id="ade-welcome-title"
            style={{
              fontSize: 22,
              fontWeight: 700,
              margin: "0 0 10px",
              lineHeight: 1.2,
              letterSpacing: "-0.01em",
            }}
          >
            {screen.title}
          </h2>
          <p
            aria-live="polite"
            style={{
              fontSize: 14,
              lineHeight: 1.6,
              color: "var(--color-muted-fg, #B7B6C3)",
              margin: "0 0 14px",
            }}
          >
            {screen.body}
          </p>
          <a
            href={screen.learnMoreHref}
            onClick={(e) => {
              e.preventDefault();
              openExternalUrl(screen.learnMoreHref);
            }}
            className="ade-stt-doc"
            style={{ display: "inline-block", fontSize: 12.5 }}
          >
            Learn more →
          </a>
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "14px 22px 18px",
            borderTop: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          <button
            type="button"
            onClick={() => void closeAsDismissed()}
            style={{
              fontSize: 12.5,
              padding: "7px 12px",
              background: "transparent",
              color: "var(--color-muted-fg, #908FA0)",
              border: "1px solid transparent",
              borderRadius: 7,
              cursor: "pointer",
            }}
          >
            Skip
          </button>
          <span
            aria-hidden="true"
            style={{
              fontSize: 11,
              color: "var(--color-muted-fg, #908FA0)",
            }}
          >
            {index + 1} / {WELCOME_SCREENS.length}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => {
                setDirection("back");
                setIndex((i) => Math.max(0, i - 1));
              }}
              disabled={index === 0}
              style={{
                fontSize: 12.5,
                padding: "7px 12px",
                background: "transparent",
                color: "var(--color-fg, #F0F0F2)",
                border: "1px solid rgba(255, 255, 255, 0.12)",
                borderRadius: 7,
                cursor: index === 0 ? "not-allowed" : "pointer",
                opacity: index === 0 ? 0.5 : 1,
              }}
            >
              Back
            </button>
            <button
              type="button"
              data-wizard-primary="true"
              onClick={() => {
                if (isLast) {
                  void closeAsCompleted();
                } else {
                  setDirection("forward");
                  setIndex((i) => Math.min(WELCOME_SCREENS.length - 1, i + 1));
                }
              }}
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                padding: "7px 16px",
                background: "var(--color-accent, #A78BFA)",
                color: "var(--color-accent-fg, #0B0620)",
                border: "1px solid transparent",
                borderRadius: 7,
                cursor: "pointer",
                boxShadow: "0 4px 12px -4px rgba(167, 139, 250, 0.5)",
              }}
            >
              {isLast ? "Let's go" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
