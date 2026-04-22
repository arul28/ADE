import React, { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { useReducedMotion } from "./useReducedMotion";

export type GhostCursorProps = {
  fromSelector: string | null;
  toSelector: string | null;
  active: boolean;
  click?: boolean;
  onArrive?: () => void;
  durationMs?: number;
};

type Point = { x: number; y: number };

function centerOf(sel: string | null): Point | null {
  if (!sel || typeof document === "undefined") return null;
  const el = document.querySelector(sel) as Element | null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

export function GhostCursor({
  fromSelector,
  toSelector,
  active,
  click = false,
  onArrive,
  durationMs = 900,
}: GhostCursorProps): JSX.Element | null {
  const reduced = useReducedMotion();
  const [points, setPoints] = useState<{ from: Point; to: Point } | null>(null);
  const [showRipple, setShowRipple] = useState(false);
  const onArriveRef = useRef(onArrive);
  onArriveRef.current = onArrive;

  useEffect(() => {
    if (!active) {
      setPoints(null);
      setShowRipple(false);
      return;
    }
    const from = centerOf(fromSelector);
    const to = centerOf(toSelector);
    if (!from || !to) {
      setPoints(null);
      return;
    }
    setPoints({ from, to });
    if (reduced) {
      onArriveRef.current?.();
      if (click) {
        setShowRipple(true);
        const id = window.setTimeout(() => setShowRipple(false), 400);
        return () => window.clearTimeout(id);
      }
      return;
    }
    const arriveId = window.setTimeout(() => {
      onArriveRef.current?.();
      if (click) {
        setShowRipple(true);
        window.setTimeout(() => setShowRipple(false), 400);
      }
    }, durationMs);
    return () => window.clearTimeout(arriveId);
  }, [active, fromSelector, toSelector, click, durationMs, reduced]);

  if (!active || !points) return null;

  const { from, to } = points;

  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 10000,
      }}
    >
      {reduced ? (
        <svg
          width={24}
          height={24}
          style={{
            position: "absolute",
            left: to.x - 4,
            top: to.y - 4,
          }}
        >
          <CursorPath />
        </svg>
      ) : (
        <motion.svg
          width={24}
          height={24}
          initial={{ x: from.x - 4, y: from.y - 4, opacity: 0 }}
          animate={{ x: to.x - 4, y: to.y - 4, opacity: 1 }}
          transition={{ type: "spring", stiffness: 120, damping: 18, duration: durationMs / 1000 }}
          style={{ position: "absolute", left: 0, top: 0 }}
        >
          <CursorPath />
        </motion.svg>
      )}
      {showRipple ? (
        <svg
          width={80}
          height={80}
          style={{
            position: "absolute",
            left: to.x - 40,
            top: to.y - 40,
          }}
        >
          <motion.circle
            cx={40}
            cy={40}
            r={0}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={2}
            initial={{ r: 0, opacity: 0.9 }}
            animate={{ r: 28, opacity: 0 }}
            transition={{ duration: 0.4, ease: "easeOut" }}
          />
        </svg>
      ) : null}
    </div>
  );
}

function CursorPath(): JSX.Element {
  return (
    <path
      d="M2 2 L2 18 L7 14 L10 20 L13 19 L10 13 L16 13 Z"
      fill="var(--color-fg)"
      stroke="var(--color-bg)"
      strokeWidth={1}
      strokeLinejoin="round"
    />
  );
}
