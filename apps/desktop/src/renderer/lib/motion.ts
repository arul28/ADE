/**
 * Shared animation variants and constants for the ADE motion system.
 * Uses the `motion` library (Framer Motion successor).
 */
import type { Transition, Variants } from "motion/react";

/* ── Transitions ── */

export const springSnappy: Transition = {
  type: "spring",
  stiffness: 300,
  damping: 20,
};

export const springGentle: Transition = {
  type: "spring",
  stiffness: 260,
  damping: 25,
};

export const easeOut150: Transition = {
  duration: 0.15,
  ease: "easeOut",
};

export const easeIn100: Transition = {
  duration: 0.1,
  ease: "easeIn",
};

/* ── Page Transitions ── */

export const pageTransition: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: easeOut150 },
  exit: { opacity: 0, transition: easeIn100 },
};

/* ── Stagger Containers ── */

export const staggerContainer: Variants = {
  animate: {
    transition: {
      staggerChildren: 0.03,
    },
  },
};

export const staggerContainerSlow: Variants = {
  animate: {
    transition: {
      staggerChildren: 0.05,
    },
  },
};

export const staggerItem: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: easeOut150 },
};

/* ── Card / Interactive Variants ── */

export const cardHover = {
  scale: 1.02,
  boxShadow: "var(--shadow-card-hover)",
  transition: springSnappy,
};

export const cardTap = {
  scale: 0.98,
  transition: { duration: 0.1 },
};

/* ── Slide / Panel Variants ── */

export const slideInRight: Variants = {
  initial: { opacity: 0, x: 24 },
  animate: { opacity: 1, x: 0, transition: springGentle },
  exit: { opacity: 0, x: 24, transition: easeIn100 },
};

export const slideInUp: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: easeOut150 },
};

/* ── Fade / Scale Variants ── */

export const fadeScale: Variants = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1, transition: easeOut150 },
  exit: { opacity: 0, scale: 0.96, transition: easeIn100 },
};

/* ── Button Variants ── */

export const buttonHover = {
  scale: 1.02,
  transition: springSnappy,
};

export const buttonTap = {
  scale: 0.97,
  transition: { duration: 0.1 },
};

/* ── Pulse / Glow (for status indicators) ── */

export const pulseGlow: Variants = {
  animate: {
    boxShadow: [
      "0 0 0 0 var(--color-glow)",
      "0 0 0 6px transparent",
    ],
    transition: {
      duration: 2,
      repeat: Infinity,
      ease: "easeInOut",
    },
  },
};

/* ── Layout animation transition ── */

export const layoutTransition: Transition = {
  type: "spring",
  stiffness: 300,
  damping: 30,
};
