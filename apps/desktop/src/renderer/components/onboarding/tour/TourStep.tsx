import React, { useEffect, useRef } from "react";
import type { TourCtx, TourStep as TourStepType } from "../../../onboarding/registry";
import { openExternalUrl } from "../../../lib/openExternal";

type TourStepProps = {
  step: TourStepType;
  ctx?: TourCtx | null;
  stepIndex: number;
  totalSteps: number;
  targetRect: DOMRect | null;
  missing: boolean;
  canAdvance: boolean;
  fallbackActive: boolean;
  waitingLabel?: string | null;
  onNext: () => void;
  onPrev: () => void;
  onDismiss: () => void;
  isLast: boolean;
};

const CARD_WIDTH = 320;
const CARD_GAP = 12;
const EDGE_PAD = 12;

function renderEmphasis(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={index} style={{ color: "var(--color-fg, #F0F0F2)", fontWeight: 700 }}>
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <React.Fragment key={index}>{part}</React.Fragment>;
  });
}

function computePosition(
  rect: DOMRect | null,
  placement: TourStepType["placement"],
  cardWidth: number,
  estHeight: number,
): { top: number; left: number; centered: boolean } {
  if (typeof window === "undefined") return { top: 0, left: 0, centered: true };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!rect) {
    return {
      top: Math.max(EDGE_PAD, vh / 2 - estHeight / 2),
      left: Math.max(EDGE_PAD, vw / 2 - cardWidth / 2),
      centered: true,
    };
  }

  if (placement === "viewport-top-right") {
    return {
      top: EDGE_PAD,
      left: Math.max(EDGE_PAD, vw - cardWidth - EDGE_PAD),
      centered: false,
    };
  }
  if (placement === "viewport-bottom-right") {
    return {
      top: Math.max(EDGE_PAD, vh - estHeight - EDGE_PAD),
      left: Math.max(EDGE_PAD, vw - cardWidth - EDGE_PAD),
      centered: false,
    };
  }
  if (placement === "viewport-bottom-left") {
    return {
      top: Math.max(EDGE_PAD, vh - estHeight - EDGE_PAD),
      left: EDGE_PAD,
      centered: false,
    };
  }

  // Auto-place: prefer below if there's room, else above, else right, else left, else center.
  let side: "top" | "bottom" | "left" | "right" = "bottom";
  if (placement && placement !== "auto") side = placement;
  else {
    const spaceBelow = vh - rect.bottom;
    const spaceAbove = rect.top;
    const spaceRight = vw - rect.right;
    const spaceLeft = rect.left;
    if (spaceBelow >= estHeight + CARD_GAP) side = "bottom";
    else if (spaceAbove >= estHeight + CARD_GAP) side = "top";
    else if (spaceRight >= cardWidth + CARD_GAP) side = "right";
    else if (spaceLeft >= cardWidth + CARD_GAP) side = "left";
    else
      return {
        top: Math.max(EDGE_PAD, vh / 2 - estHeight / 2),
        left: Math.max(EDGE_PAD, vw / 2 - cardWidth / 2),
        centered: true,
      };
  }

  let top = 0;
  let left = 0;
  if (side === "bottom") {
    top = rect.bottom + CARD_GAP;
    left = rect.left + rect.width / 2 - cardWidth / 2;
  } else if (side === "top") {
    top = rect.top - CARD_GAP - estHeight;
    left = rect.left + rect.width / 2 - cardWidth / 2;
  } else if (side === "right") {
    top = rect.top + rect.height / 2 - estHeight / 2;
    left = rect.right + CARD_GAP;
  } else {
    top = rect.top + rect.height / 2 - estHeight / 2;
    left = rect.left - CARD_GAP - cardWidth;
  }

  // Clamp into viewport.
  left = Math.max(EDGE_PAD, Math.min(left, vw - cardWidth - EDGE_PAD));
  top = Math.max(EDGE_PAD, Math.min(top, vh - estHeight - EDGE_PAD));
  return { top, left, centered: false };
}

function targetShouldKeepFocus(step: TourStepType): boolean {
  if (step.focusTarget) return true;
  if (typeof document === "undefined") return false;
  try {
    const el = document.querySelector(step.target);
    if (!(el instanceof HTMLElement)) return false;
    return el.matches("input, select, textarea, [contenteditable]:not([contenteditable='false'])");
  } catch {
    return false;
  }
}

function focusStepTarget(step: TourStepType): boolean {
  if (typeof document === "undefined") return false;
  try {
    const el = document.querySelector(step.target) as HTMLElement | null;
    if (!el || typeof el.focus !== "function") return false;
    el.focus({ preventScroll: true });
    return true;
  } catch {
    return false;
  }
}

export function TourStep({
  step,
  ctx,
  stepIndex,
  targetRect,
  missing,
  canAdvance,
  fallbackActive,
  waitingLabel,
  onNext,
  onPrev,
  onDismiss,
  isLast,
}: TourStepProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const estHeight = 180;
  const pos = computePosition(targetRect, step.placement, CARD_WIDTH, estHeight);
  const body = step.bodyTemplate && ctx ? step.bodyTemplate(ctx) : step.body;
  const keepFocusOnTarget = targetShouldKeepFocus(step);
  const actionRequirementSatisfied =
    Boolean(step.awaitingActionLabel) &&
    Boolean(step.requires?.length) &&
    canAdvance;
  const isAwaitingAction = Boolean(step.awaitingActionLabel) && !fallbackActive && !actionRequirementSatisfied;
  const primaryDisabled = isAwaitingAction || !canAdvance;
  const primaryLabel =
    fallbackActive
      ? step.fallbackNextLabel ?? "Continue"
      : isAwaitingAction
        ? step.awaitingActionLabel!
        : !canAdvance
          ? waitingLabel ?? "Waiting for required state"
          : step.nextLabel ?? (isLast ? "Finish" : "Next");
  const stopCardEvent = (event: React.SyntheticEvent) => {
    event.stopPropagation();
  };

  // Focus-trap: intercept Tab inside the card. Focus the primary action only
  // when this card is asking for a direct button press; action-waiting steps
  // should leave focus available for the highlighted app control.
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;

    if (keepFocusOnTarget && focusStepTarget(step)) {
      return;
    }

    const primary = card.querySelector<HTMLElement>('[data-tour-primary="true"]');
    if (!keepFocusOnTarget && !primaryDisabled && primary && typeof primary.focus === "function") {
      try {
        primary.focus();
      } catch {
        /* ignore */
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
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
    };
    card.addEventListener("keydown", onKeyDown);
    return () => card.removeEventListener("keydown", onKeyDown);
  }, [keepFocusOnTarget, primaryDisabled, step, stepIndex]);

  return (
    <div
      ref={cardRef}
      className="ade-tour-step"
      role="dialog"
      aria-modal={keepFocusOnTarget ? undefined : true}
      aria-labelledby={`ade-tour-title-${stepIndex}`}
      onPointerDown={stopCardEvent}
      onMouseDown={stopCardEvent}
      onClick={stopCardEvent}
      style={{
        position: "absolute",
        top: pos.top,
        left: pos.left,
        width: CARD_WIDTH,
        background: "var(--color-popup-bg, #151325)",
        color: "var(--color-fg, #F0F0F2)",
        border: "1px solid rgba(255, 255, 255, 0.10)",
        borderRadius: 10,
        padding: "14px 16px",
        boxShadow: "0 12px 40px -8px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.04)",
        fontFamily: "var(--font-sans)",
        pointerEvents: "auto",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <h2
          id={`ade-tour-title-${stepIndex}`}
          style={{ fontSize: 14, fontWeight: 600, margin: 0, lineHeight: 1.3 }}
        >
          {step.title}
        </h2>
      </div>
      <p
        aria-live="polite"
        style={{
          margin: "0 0 10px",
          fontSize: 12.5,
          lineHeight: 1.55,
          color: "var(--color-muted-fg, #B7B6C3)",
        }}
      >
        {renderEmphasis(body)}
        {missing && step.fallbackNotice ? (
          <>
            {" "}
            <em style={{ color: "var(--color-warning, #f59e0b)" }}>
              {step.fallbackNotice}
            </em>
          </>
        ) : null}
      </p>
      {step.docUrl ? (
        <a
          href={step.docUrl}
          onClick={(e) => {
            e.preventDefault();
            openExternalUrl(step.docUrl);
          }}
          className="ade-stt-doc"
          style={{
            display: "inline-block",
            marginBottom: 10,
          }}
        >
          Learn more →
        </a>
      ) : null}
      <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" }}>
        <button
          type="button"
          onClick={onDismiss}
          className="ade-tour-skip"
          style={{
            fontSize: 12,
            padding: "6px 10px",
            background: "transparent",
            color: "var(--color-muted-fg, #908FA0)",
            border: "1px solid transparent",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          Exit tutorial
        </button>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            onClick={onPrev}
            disabled={stepIndex === 0 || step.disableBack}
            style={{
              fontSize: 12,
              padding: "6px 10px",
              background: "transparent",
              color: "var(--color-fg, #F0F0F2)",
              border: "1px solid rgba(255, 255, 255, 0.12)",
              borderRadius: 6,
              cursor: stepIndex === 0 || step.disableBack ? "not-allowed" : "pointer",
              opacity: stepIndex === 0 || step.disableBack ? 0.5 : 1,
            }}
          >
            Back
          </button>
          <button
            type="button"
            onClick={primaryDisabled ? undefined : onNext}
            disabled={primaryDisabled}
            data-tour-primary="true"
            style={{
              fontSize: 12,
              fontWeight: 600,
              padding: "6px 12px",
              background: primaryDisabled
                ? "color-mix(in srgb, var(--color-accent, #A78BFA) 20%, transparent)"
                : "var(--color-accent, #A78BFA)",
              color: primaryDisabled
                ? "var(--color-muted-fg, #B7B6C3)"
                : "var(--color-accent-fg, #0B0620)",
              border: primaryDisabled
                ? "1px solid color-mix(in srgb, var(--color-accent, #A78BFA) 35%, transparent)"
                : "1px solid transparent",
              borderRadius: 6,
              cursor: primaryDisabled ? "default" : "pointer",
            }}
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
