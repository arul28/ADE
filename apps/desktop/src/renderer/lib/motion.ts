/**
 * Shared animation variants and constants for the ADE motion system.
 * Uses the `motion` library (Framer Motion successor).
 */
import type { Transition, Variants } from "motion/react";

/* ── Transitions (internal) ── */

const easeOut150: Transition = {
  duration: 0.15,
  ease: "easeOut",
};

const easeIn100: Transition = {
  duration: 0.1,
  ease: "easeIn",
};

/* ── Fade / Scale Variants ── */

export const fadeScale: Variants = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1, transition: easeOut150 },
  exit: { opacity: 0, scale: 0.96, transition: easeIn100 },
};
