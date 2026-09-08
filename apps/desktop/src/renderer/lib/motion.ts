/**
 * Shared animation variants and constants for the ADE motion system.
 * Uses the `motion` library (Framer Motion successor).
 */
import type { Transition, Variants } from "motion/react";

/* ── Easing curves ── */

/**
 * Material's standard curve, and the house default for anything that reveals,
 * slides or resizes in place.
 *
 * It was written out as a bare `[0.4, 0, 0.2, 1]` literal in nine files under
 * three different local names, which is how "the same motion" quietly becomes
 * nine motions. Name it once; a file that wants a *different* curve then has to
 * say so, which is the point.
 */
export const STANDARD_EASE = [0.4, 0, 0.2, 1] as const;

/** The confident settle used for things that arrive rather than open. */
export const EMPHASIZED_EASE = [0.22, 1, 0.36, 1] as const;

/** A deliberate overshoot, for controls that should feel sprung. */
export const OVERSHOOT_EASE = [0.34, 1.56, 0.64, 1] as const;

/** House reveal for bars that slide in under a toolbar. */
export const revealTransition = { duration: 0.18, ease: STANDARD_EASE } as const;

/** The matching exit, deliberately quicker than the reveal. */
export const exitTransition = { duration: 0.14, ease: STANDARD_EASE } as const;

/** Panes and stages, which are larger and so read slower. */
export const paneTransition = { duration: 0.24, ease: STANDARD_EASE } as const;

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
