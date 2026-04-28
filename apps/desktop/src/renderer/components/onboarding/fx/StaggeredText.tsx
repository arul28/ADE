import React, { useEffect, useMemo, useRef } from "react";
import { motion } from "motion/react";
import { useReducedMotion } from "./useReducedMotion";

export type StaggeredTextProps = {
  text: string;
  mode?: "word" | "letter";
  staggerMs?: number;
  className?: string;
  style?: React.CSSProperties;
  as?: "h1" | "h2" | "h3" | "span" | "p";
  onComplete?: () => void;
};

type Segment = { key: string; content: string; isSpace: boolean };

function splitText(text: string, mode: "word" | "letter"): Segment[] {
  if (mode === "letter") {
    return Array.from(text).map((ch, i) => ({
      key: `${i}-${ch}`,
      content: ch,
      isSpace: ch === " ",
    }));
  }
  // word mode — preserve spaces as separate segments.
  const parts = text.split(/(\s+)/);
  return parts
    .filter((p) => p.length > 0)
    .map((part, i) => ({
      key: `${i}-${part}`,
      content: part,
      isSpace: /^\s+$/.test(part),
    }));
}

export function StaggeredText({
  text,
  mode = "word",
  staggerMs = 60,
  className,
  style,
  as = "h1",
  onComplete,
}: StaggeredTextProps): JSX.Element {
  const reduced = useReducedMotion();
  const segments = useMemo(() => splitText(text, mode), [text, mode]);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (reduced) {
      onCompleteRef.current?.();
      return;
    }
    // Animated path: last segment's delay + ~400ms typical spring settle.
    const animatedCount = segments.filter((s) => !s.isSpace).length;
    const lastIndex = Math.max(0, animatedCount - 1);
    const totalMs = lastIndex * staggerMs + 500;
    const id = window.setTimeout(() => {
      onCompleteRef.current?.();
    }, totalMs);
    return () => window.clearTimeout(id);
  }, [segments, staggerMs, reduced]);

  const Tag = as as keyof JSX.IntrinsicElements;

  if (reduced) {
    return React.createElement(
      Tag,
      { className, style },
      text,
    );
  }

  // Track animation index separately from segment index so that spaces don't
  // consume a stagger slot.
  let animIndex = 0;
  const children = segments.map((seg) => {
    if (seg.isSpace) {
      // Keep the space as plain text (preserves inline spacing).
      return (
        <span key={seg.key} aria-hidden="false">
          {seg.content}
        </span>
      );
    }
    const delay = (animIndex * staggerMs) / 1000;
    animIndex += 1;
    return (
      <motion.span
        key={seg.key}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay, type: "spring", stiffness: 180, damping: 20 }}
        style={{ display: "inline-block", whiteSpace: "pre" }}
      >
        {seg.content}
      </motion.span>
    );
  });

  return React.createElement(
    Tag,
    { className, style: { ...style } },
    children,
  );
}
