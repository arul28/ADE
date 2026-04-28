import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Term } from "../../onboarding/glossary";
import { openExternalUrl } from "../../lib/openExternal";

type Side = "top" | "bottom" | "left" | "right";

type GlossaryPopoverProps = {
  term: Term;
  anchor: HTMLElement;
  side?: Side;
  onClose: () => void;
};

const GAP = 8;
const VIEWPORT_PAD = 10;

function computePosition(
  anchor: HTMLElement,
  side: Side,
  width: number,
  height: number,
): { top: number; left: number } {
  const r = anchor.getBoundingClientRect();
  const vw = typeof window !== "undefined" ? window.innerWidth : 0;
  const vh = typeof window !== "undefined" ? window.innerHeight : 0;

  let top = 0;
  let left = 0;
  if (side === "bottom") {
    top = r.bottom + GAP;
    left = r.left + r.width / 2 - width / 2;
  } else if (side === "top") {
    top = r.top - GAP - height;
    left = r.left + r.width / 2 - width / 2;
  } else if (side === "right") {
    top = r.top + r.height / 2 - height / 2;
    left = r.right + GAP;
  } else {
    top = r.top + r.height / 2 - height / 2;
    left = r.left - GAP - width;
  }
  left = Math.max(VIEWPORT_PAD, Math.min(left, vw - width - VIEWPORT_PAD));
  top = Math.max(VIEWPORT_PAD, Math.min(top, vh - height - VIEWPORT_PAD));
  return { top, left };
}

export function GlossaryPopover({
  term,
  anchor,
  side = "bottom",
  onClose,
}: GlossaryPopoverProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const width = 280;
  const estHeight = 180;
  const [pos, setPos] = useState(() => computePosition(anchor, side, width, estHeight));

  const remeasure = useCallback(() => {
    if (!anchor) return;
    const next = computePosition(anchor, side, width, cardRef.current?.offsetHeight ?? estHeight);
    setPos(next);
  }, [anchor, side]);

  useEffect(() => {
    remeasure();
    window.addEventListener("resize", remeasure);
    window.addEventListener("scroll", remeasure, true);
    return () => {
      window.removeEventListener("resize", remeasure);
      window.removeEventListener("scroll", remeasure, true);
    };
  }, [remeasure]);

  // Escape to close + click-outside to close.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onClick = (e: MouseEvent) => {
      const card = cardRef.current;
      if (!card) return;
      const target = e.target as Node | null;
      if (!target) return;
      if (card.contains(target)) return;
      if (anchor.contains(target)) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onClick);
    };
  }, [anchor, onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={cardRef}
      role="dialog"
      aria-label={term.term}
      className="ade-glossary-popover"
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width,
        zIndex: 9999,
        background: "var(--color-popup-bg, #151325)",
        color: "var(--color-fg, #F0F0F2)",
        border: "1px solid rgba(255, 255, 255, 0.10)",
        borderRadius: 10,
        padding: "12px 14px",
        boxShadow: "0 12px 30px -8px rgba(0, 0, 0, 0.6)",
        fontFamily: "var(--font-sans)",
      }}
    >
      <h3 style={{ fontSize: 13, fontWeight: 600, margin: "0 0 4px" }}>{term.term}</h3>
      <p
        style={{
          fontSize: 11.5,
          lineHeight: 1.45,
          margin: "0 0 6px",
          color: "var(--color-muted-fg, #B7B6C3)",
        }}
      >
        {term.shortDefinition}
      </p>
      <p
        style={{
          fontSize: 11.5,
          lineHeight: 1.5,
          margin: "0 0 8px",
          color: "var(--color-muted-fg, #908FA0)",
        }}
      >
        {term.longDefinition}
      </p>
      <a
        href={term.docUrl}
        onClick={(e) => {
          e.preventDefault();
          openExternalUrl(term.docUrl);
        }}
        className="ade-stt-doc"
        style={{ display: "inline-block" }}
      >
        Read more →
      </a>
    </div>,
    document.body,
  );
}
