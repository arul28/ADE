import React from "react";
import { AnimatePresence, motion } from "motion/react";
import { Sparkle, X } from "@phosphor-icons/react";
import { useReducedMotion } from "./fx";
import { useOnboardingStore } from "../../state/onboardingStore";

/**
 * TutorialPromptCard — single welcome surface for new users.
 *
 * Two variants:
 *  - `"hero"`   large center-top card for the no-project launch screen.
 *  - `"corner"` small bottom-right slide-in for in-project sessions.
 *
 * Lifecycle (controlled by parent OnboardingBootstrap):
 *  - Parent queries `window.ade.onboarding.tutorial.shouldPrompt()` on mount
 *    and sets `visible=true` if true.
 *  - Start tour          → onboarding.tutorial.start() + startTour("first-journey")
 *  - Not now             → onboarding.tutorial.dismiss(false) — reappears next launch.
 *  - Not now + silenced  → onboarding.tutorial.dismiss(true) or setSilenced(true) —
 *                          never reappears until user toggles it back on.
 */

export type TutorialPromptVariant = "hero" | "corner";

export type TutorialPromptCardProps = {
  visible: boolean;
  onClose: () => void;
  /** Where to display the prompt. Defaults to "corner" for backwards compat. */
  variant?: TutorialPromptVariant;
};

export function TutorialPromptCard({
  visible,
  onClose,
  variant = "corner",
}: TutorialPromptCardProps): JSX.Element {
  const reduced = useReducedMotion();
  const [silenceNext, setSilenceNext] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const tutorialBridge = React.useMemo(() => {
    const api = typeof window !== "undefined" ? window.ade?.onboarding : undefined;
    return api && (api as any).tutorial
      ? ((api as any).tutorial as {
          start?: () => Promise<unknown>;
          dismiss?: (permanent: boolean) => Promise<unknown>;
          setSilenced?: (silenced: boolean) => Promise<unknown>;
        })
      : null;
  }, []);

  const handleStart = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (tutorialBridge?.start) {
        await tutorialBridge.start();
      }
      // Use startTutorial so backend state AND visual tour both fire.
      await useOnboardingStore.getState().startTutorial();
    } finally {
      setBusy(false);
      onClose();
    }
  }, [busy, tutorialBridge, onClose]);

  const handleNotNow = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (silenceNext && tutorialBridge?.dismiss) {
        await tutorialBridge.dismiss(true);
      } else if (silenceNext && tutorialBridge?.setSilenced) {
        await tutorialBridge.setSilenced(true);
      } else if (tutorialBridge?.dismiss) {
        await tutorialBridge.dismiss(false);
      }
    } finally {
      setBusy(false);
      onClose();
    }
  }, [busy, silenceNext, tutorialBridge, onClose]);

  return (
    <AnimatePresence>
      {visible ? (
        variant === "hero" ? (
          <HeroCard
            key="tutorial-prompt-hero"
            reduced={reduced}
            silenceNext={silenceNext}
            setSilenceNext={setSilenceNext}
            busy={busy}
            onStart={handleStart}
            onNotNow={handleNotNow}
          />
        ) : (
          <CornerCard
            key="tutorial-prompt-corner"
            reduced={reduced}
            silenceNext={silenceNext}
            setSilenceNext={setSilenceNext}
            busy={busy}
            onStart={handleStart}
            onNotNow={handleNotNow}
          />
        )
      ) : null}
    </AnimatePresence>
  );
}

type CardProps = {
  reduced: boolean;
  silenceNext: boolean;
  setSilenceNext: React.Dispatch<React.SetStateAction<boolean>>;
  busy: boolean;
  onStart: () => void;
  onNotNow: () => void;
};

function CornerCard({
  reduced,
  silenceNext,
  setSilenceNext,
  busy,
  onStart,
  onNotNow,
}: CardProps) {
  const content = (
    <div
      role="dialog"
      aria-label="New to ADE? Take the guided tour."
      className="pointer-events-auto flex flex-col gap-3 rounded-lg border p-4 shadow-2xl"
      style={{
        width: 340,
        background: "var(--color-card, var(--color-bg))",
        borderColor: "var(--color-border, rgba(255,255,255,0.08))",
        color: "var(--color-fg)",
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkle size={16} weight="fill" style={{ color: "var(--color-accent)" }} />
          <h3 className="text-sm font-semibold" style={{ margin: 0 }}>
            New to ADE? Take the 10-minute tour.
          </h3>
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onNotNow}
          className="text-muted-fg hover:text-fg transition-colors"
          style={{ background: "transparent", border: "none", cursor: "pointer", padding: 2 }}
        >
          <X size={14} weight="bold" />
        </button>
      </div>

      <p className="text-xs leading-relaxed" style={{ margin: 0, color: "var(--color-muted-fg)" }}>
        We&apos;ll walk you through every surface of ADE — lanes, workers, commits, PRs
        — with a real sample lane you can play with. Clean up takes one click.
      </p>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onStart}
          disabled={busy}
          className="inline-flex items-center justify-center rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-60"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-fg, white)",
            border: "none",
            cursor: busy ? "wait" : "pointer",
          }}
        >
          Start tour
        </button>
        <button
          type="button"
          onClick={onNotNow}
          disabled={busy}
          className="inline-flex items-center justify-center rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-60"
          style={{
            background: "transparent",
            color: "var(--color-fg)",
            border: "1px solid var(--color-border, rgba(255,255,255,0.12))",
            cursor: busy ? "wait" : "pointer",
          }}
        >
          Not now
        </button>
      </div>

      <label className="flex items-center gap-2 text-xs text-muted-fg cursor-pointer select-none">
        <input
          type="checkbox"
          checked={silenceNext}
          onChange={(e) => setSilenceNext(e.target.checked)}
          aria-label="Don't show this again"
        />
        <span>Don&apos;t show this again</span>
      </label>

      <div className="text-[11px]" style={{ color: "var(--color-muted-fg)", opacity: 0.7 }}>
        Replay anytime from the <span aria-label="help">?</span> menu.
      </div>
    </div>
  );

  // z-[9997] so we sit above most app chrome but still beneath the tour
  // overlay (9998) and HelpMenu portal (9999). Previously z-[90] which was
  // getting covered by other floating panes.
  if (typeof window !== "undefined") {
    console.info("[onboarding] TutorialPromptCard corner variant rendering");
  }
  return (
    <div
      className="pointer-events-none fixed"
      style={{ right: 20, bottom: 20, zIndex: 9997 }}
    >
      {reduced ? (
        <motion.div
          key="tutorial-prompt-reduced"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          {content}
        </motion.div>
      ) : (
        <motion.div
          key="tutorial-prompt"
          initial={{ opacity: 0, x: 400 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 400 }}
          transition={{ type: "spring", stiffness: 180, damping: 26 }}
        >
          {content}
        </motion.div>
      )}
    </div>
  );
}

function HeroCard({
  reduced,
  silenceNext,
  setSilenceNext,
  busy,
  onStart,
  onNotNow,
}: CardProps) {
  const content = (
    <div
      role="dialog"
      aria-label="Welcome to ADE. Take the guided tour."
      className="pointer-events-auto flex flex-col gap-5 rounded-xl border shadow-2xl"
      style={{
        width: 520,
        maxWidth: "calc(100vw - 48px)",
        padding: "32px 36px",
        background:
          "radial-gradient(120% 140% at 0% 0%, rgba(167, 139, 250, 0.10), transparent 55%), var(--color-card, var(--color-popup-bg, #141022))",
        borderColor: "var(--color-border, rgba(255,255,255,0.10))",
        color: "var(--color-fg, #F0F0F2)",
        boxShadow:
          "0 30px 80px -20px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(167, 139, 250, 0.08)",
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkle
            size={22}
            weight="fill"
            style={{ color: "var(--color-accent, #A78BFA)" }}
          />
          <span
            style={{
              fontSize: 11,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              fontWeight: 600,
              color: "var(--color-accent, #A78BFA)",
            }}
          >
            Welcome to ADE
          </span>
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onNotNow}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--color-muted-fg, #908FA0)",
            cursor: "pointer",
            padding: 4,
          }}
        >
          <X size={16} weight="bold" />
        </button>
      </div>

      <div className="flex flex-col gap-3">
        <h2
          style={{
            margin: 0,
            fontSize: 30,
            lineHeight: 1.15,
            fontWeight: 700,
            letterSpacing: "-0.02em",
          }}
        >
          Take the 10-minute guided tour.
        </h2>
        <p
          style={{
            margin: 0,
            fontSize: 15,
            lineHeight: 1.55,
            color: "var(--color-muted-fg, #B7B6C3)",
          }}
        >
          We&apos;ll walk you through opening a project and every surface of ADE —
          lanes, workers, commits, PRs — with a real sample lane you can play with.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onStart}
          disabled={busy}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "10px 20px",
            fontSize: 14,
            fontWeight: 600,
            borderRadius: 8,
            background: "var(--color-accent, #A78BFA)",
            color: "var(--color-accent-fg, #0B0620)",
            border: "1px solid transparent",
            boxShadow: "0 6px 18px -6px rgba(167, 139, 250, 0.5)",
            cursor: busy ? "wait" : "pointer",
            opacity: busy ? 0.6 : 1,
          }}
        >
          Start tour
        </button>
        <button
          type="button"
          onClick={onNotNow}
          disabled={busy}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "10px 16px",
            fontSize: 14,
            fontWeight: 500,
            borderRadius: 8,
            background: "transparent",
            color: "var(--color-fg)",
            border: "1px solid var(--color-border, rgba(255, 255, 255, 0.12))",
            cursor: busy ? "wait" : "pointer",
            opacity: busy ? 0.6 : 1,
          }}
        >
          Not now
        </button>
      </div>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 12.5,
          color: "var(--color-muted-fg, #908FA0)",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <input
          type="checkbox"
          checked={silenceNext}
          onChange={(e) => setSilenceNext(e.target.checked)}
          aria-label="Don't show this again"
        />
        <span>Don&apos;t show this again</span>
      </label>

      <div
        style={{
          fontSize: 11.5,
          color: "var(--color-muted-fg, #908FA0)",
          opacity: 0.75,
          borderTop: "1px solid rgba(255,255,255,0.06)",
          paddingTop: 12,
        }}
      >
        You can replay this anytime from the <span aria-label="help">?</span> menu in the
        top-right.
      </div>
    </div>
  );

  if (typeof window !== "undefined") {
    console.info("[onboarding] TutorialPromptCard hero variant rendering");
  }
  return (
    <div
      className="pointer-events-none fixed"
      style={{
        top: 80,
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        padding: "0 24px",
        zIndex: 9997,
      }}
    >
      {reduced ? (
        <motion.div
          key="tutorial-prompt-hero-reduced"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          {content}
        </motion.div>
      ) : (
        <motion.div
          key="tutorial-prompt-hero"
          initial={{ opacity: 0, y: -8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.98 }}
          transition={{ type: "spring", stiffness: 240, damping: 28 }}
        >
          {content}
        </motion.div>
      )}
    </div>
  );
}
