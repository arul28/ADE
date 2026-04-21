import React, { useEffect, useRef } from "react";
import type { TourStep as TourStepType } from "../../../onboarding/registry";
import { openExternalUrl } from "../../../lib/openExternal";

type TourStepProps = {
  step: TourStepType;
  stepIndex: number;
  totalSteps: number;
  targetRect: DOMRect | null;
  missing: boolean;
  onNext: () => void;
  onPrev: () => void;
  onDismiss: () => void;
  isLast: boolean;
};

const CARD_WIDTH = 320;
const CARD_GAP = 12;
const EDGE_PAD = 12;

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

export function TourStep({
  step,
  stepIndex,
  totalSteps,
  targetRect,
  missing,
  onNext,
  onPrev,
  onDismiss,
  isLast,
}: TourStepProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const estHeight = 180;
  const pos = computePosition(targetRect, step.placement, CARD_WIDTH, estHeight);

  // Focus-trap: intercept Tab inside the card. Also focus the primary action on mount.
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;

    const primary = card.querySelector<HTMLElement>('[data-tour-primary="true"]');
    if (primary && typeof primary.focus === "function") {
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
  }, [stepIndex]);

  return (
    <div
      ref={cardRef}
      className="ade-tour-step"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`ade-tour-title-${stepIndex}`}
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
        <span
          aria-label={`Step ${stepIndex + 1} of ${totalSteps}`}
          style={{
            fontSize: 11,
            color: "var(--color-muted-fg, #908FA0)",
            whiteSpace: "nowrap",
          }}
        >
          {stepIndex + 1} / {totalSteps}
        </span>
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
        {step.body}
        {missing ? (
          <>
            {" "}
            <em style={{ color: "var(--color-warning, #f59e0b)" }}>
              (This element isn't on screen right now)
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
          Skip
        </button>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            onClick={onPrev}
            disabled={stepIndex === 0}
            style={{
              fontSize: 12,
              padding: "6px 10px",
              background: "transparent",
              color: "var(--color-fg, #F0F0F2)",
              border: "1px solid rgba(255, 255, 255, 0.12)",
              borderRadius: 6,
              cursor: stepIndex === 0 ? "not-allowed" : "pointer",
              opacity: stepIndex === 0 ? 0.5 : 1,
            }}
          >
            Back
          </button>
          <button
            type="button"
            onClick={onNext}
            data-tour-primary="true"
            style={{
              fontSize: 12,
              fontWeight: 600,
              padding: "6px 12px",
              background: "var(--color-accent, #A78BFA)",
              color: "var(--color-accent-fg, #0B0620)",
              border: "1px solid transparent",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            {isLast ? "Finish" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
