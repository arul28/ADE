import React, { useEffect, useRef } from "react";
import confetti from "canvas-confetti";
import { useReducedMotion } from "./useReducedMotion";

export type FireConfettiOptions = {
  particleCount?: number;
  spread?: number;
  origin?: { x: number; y: number };
  colors?: string[];
};

const DEFAULT_COLORS = ["#8B5CF6", "#3B82F6", "#F59E0B", "#10B981", "#EF4444"];

export function fireConfetti(opts: FireConfettiOptions = {}): void {
  const {
    particleCount = 140,
    spread = 70,
    origin = { x: 0.5, y: 0.35 },
    colors = DEFAULT_COLORS,
  } = opts;
  try {
    confetti({
      particleCount,
      spread,
      origin,
      colors,
      scalar: 0.9,
      disableForReducedMotion: true,
    });
  } catch {
    /* ignore — non-browser or confetti failure is non-fatal. */
  }
}

export type ConfettiTriggerProps = {
  fire: boolean;
  onDone?: () => void;
};

export function ConfettiTrigger({ fire, onDone }: ConfettiTriggerProps): JSX.Element {
  const reduced = useReducedMotion();
  const prevFireRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const wasFire = prevFireRef.current;
    prevFireRef.current = fire;
    if (fire && !wasFire) {
      if (!reduced) {
        fireConfetti();
      }
      const id = window.setTimeout(() => {
        onDoneRef.current?.();
      }, 1200);
      return () => window.clearTimeout(id);
    }
    return;
  }, [fire, reduced]);

  return <></>;
}
