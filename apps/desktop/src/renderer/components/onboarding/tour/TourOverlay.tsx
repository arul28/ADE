import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TourStep as TourStepType } from "../../../onboarding/registry";
import { useOnboardingStore } from "../../../state/onboardingStore";
import { TourStep } from "./TourStep";

const SELECTOR_RETRY_MS = 500;
const RETRY_INTERVAL_MS = 50;
const INTERACTIVE_SHORTCUT_SELECTOR =
  'button, a[href], input, select, textarea, [contenteditable]:not([contenteditable="false"])';

type TourOverlayProps = {
  step: TourStepType;
  stepIndex: number;
  totalSteps: number;
};

type TargetState =
  | { kind: "found"; rect: DOMRect }
  | { kind: "missing" };

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function shouldLetEnterActivateTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(INTERACTIVE_SHORTCUT_SELECTOR) != null;
}

export function TourOverlay({ step, stepIndex, totalSteps }: TourOverlayProps) {
  const nextStep = useOnboardingStore((s) => s.nextStep);
  const prevStep = useOnboardingStore((s) => s.prevStep);
  const dismissCurrentTour = useOnboardingStore((s) => s.dismissCurrentTour);
  const completeCurrentTour = useOnboardingStore((s) => s.completeCurrentTour);

  const [target, setTarget] = useState<TargetState>({ kind: "missing" });
  const [reduceMotion] = useState(prefersReducedMotion);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const isLast = stepIndex >= totalSteps - 1;

  const measure = useCallback(() => {
    const el = document.querySelector(step.target) as HTMLElement | null;
    if (el) {
      setTarget({ kind: "found", rect: el.getBoundingClientRect() });
      return true;
    }
    return false;
  }, [step.target]);

  // Retry locating the selector when the step changes. The first 500ms controls
  // the missing fallback, but observation continues so lazy route content can
  // still attach to the active step once it appears.
  useEffect(() => {
    setTarget({ kind: "missing" });
    if (measure()) return;

    let cancelled = false;
    const start = Date.now();
    const interval = window.setInterval(() => {
      if (cancelled) return;
      const found = measure();
      if (found) {
        window.clearInterval(interval);
        return;
      }
      if (Date.now() - start >= SELECTOR_RETRY_MS) {
        setTarget((current) => (current.kind === "found" ? current : { kind: "missing" }));
      }
    }, RETRY_INTERVAL_MS);
    const observer =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => {
            if (cancelled) return;
            if (measure()) {
              window.clearInterval(interval);
              observer?.disconnect();
            }
          })
        : null;
    observer?.observe(document.body, { childList: true, subtree: true });

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      observer?.disconnect();
    };
  }, [measure]);

  // Re-measure on viewport changes.
  useEffect(() => {
    const onChange = () => {
      measure();
    };
    window.addEventListener("resize", onChange);
    window.addEventListener("scroll", onChange, true);
    return () => {
      window.removeEventListener("resize", onChange);
      window.removeEventListener("scroll", onChange, true);
    };
  }, [measure]);

  // Focus management: remember whatever was focused before the tour started, restore on unmount.
  useEffect(() => {
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
  }, []);

  const handleNext = useCallback(() => {
    if (isLast) {
      void completeCurrentTour();
    } else {
      void nextStep();
    }
  }, [isLast, completeCurrentTour, nextStep]);

  const handlePrev = useCallback(() => {
    void prevStep();
  }, [prevStep]);

  const handleDismiss = useCallback(() => {
    void dismissCurrentTour();
  }, [dismissCurrentTour]);

  // Keyboard handling at the document level.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleDismiss();
        return;
      }
      if (e.key === "ArrowRight" || e.key === "Enter") {
        if (e.key === "Enter" && shouldLetEnterActivateTarget(e.target)) return;
        e.preventDefault();
        handleNext();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        handlePrev();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleNext, handlePrev, handleDismiss]);

  if (typeof document === "undefined") return null;

  const targetRect = target.kind === "found" ? target.rect : null;
  const missing = target.kind !== "found";

  return createPortal(
    <div
      className="ade-tour-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={step.title}
      data-reduce-motion={reduceMotion ? "true" : "false"}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9998,
        pointerEvents: "auto",
      }}
    >
      <TourBackdrop rect={targetRect} reduceMotion={reduceMotion} />
      {targetRect ? <TourSpotlight rect={targetRect} /> : null}
      <TourStep
        step={step}
        stepIndex={stepIndex}
        totalSteps={totalSteps}
        targetRect={targetRect}
        missing={missing}
        onNext={handleNext}
        onPrev={handlePrev}
        onDismiss={handleDismiss}
        isLast={isLast}
      />
    </div>,
    document.body,
  );
}

function TourSpotlight({ rect }: { rect: DOMRect }) {
  const padding = 6;
  return (
    <div
      className="ade-tour-spotlight"
      aria-hidden="true"
      style={{
        position: "absolute",
        top: Math.max(0, rect.top - padding),
        left: Math.max(0, rect.left - padding),
        width: rect.width + padding * 2,
        height: rect.height + padding * 2,
      }}
    />
  );
}

type TourBackdropProps = {
  rect: DOMRect | null;
  reduceMotion: boolean;
};

function TourBackdrop({ rect, reduceMotion }: TourBackdropProps) {
  const w = typeof window !== "undefined" ? window.innerWidth : 0;
  const h = typeof window !== "undefined" ? window.innerHeight : 0;
  const padding = 6;
  const radius = 8;

  if (!rect) {
    return (
      <div
        className="ade-tour-backdrop"
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0, 0, 0, 0.55)",
          transition: reduceMotion ? "none" : "background 160ms ease",
        }}
      />
    );
  }

  const x = Math.max(0, rect.left - padding);
  const y = Math.max(0, rect.top - padding);
  const cw = Math.min(w - x, rect.width + padding * 2);
  const ch = Math.min(h - y, rect.height + padding * 2);

  // SVG with a full-screen rect minus a rounded cutout via mask.
  return (
    <svg
      className="ade-tour-backdrop"
      width={w}
      height={h}
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      aria-hidden="true"
    >
      <defs>
        <mask id="ade-tour-mask">
          <rect width={w} height={h} fill="white" />
          <rect x={x} y={y} width={cw} height={ch} rx={radius} ry={radius} fill="black" />
        </mask>
      </defs>
      <rect
        width={w}
        height={h}
        fill="rgba(0,0,0,0.55)"
        mask="url(#ade-tour-mask)"
        style={{ transition: reduceMotion ? "none" : "all 160ms ease" }}
      />
    </svg>
  );
}
