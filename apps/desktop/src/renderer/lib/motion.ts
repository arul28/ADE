/**
 * Shared animation variants and constants for the ADE motion system.
 * Uses the `motion` library (Framer Motion successor).
 */
import type { Transition, Variants } from "motion/react";

/* ── Spring Physics Constants (UI Overhaul) ── */

export const springs = {
  /** Snappy — buttons, toggles, quick state changes */
  snappy: { type: "spring" as const, stiffness: 500, damping: 30 },
  /** Default — most UI transitions */
  default: { type: "spring" as const, stiffness: 300, damping: 25 },
  /** Gentle — page transitions, large movements */
  gentle: { type: "spring" as const, stiffness: 150, damping: 20 },
  /** Bouncy — celebratory moments, completion animations */
  bouncy: { type: "spring" as const, stiffness: 400, damping: 15 },
  /** Slow — ambient background transitions, camera movements */
  slow: { type: "spring" as const, stiffness: 50, damping: 15 },
} as const;

/* ── Transitions ── */

export const springSnappy: Transition = {
  type: "spring",
  stiffness: 500,
  damping: 30,
};

export const springGentle: Transition = {
  type: "spring",
  stiffness: 150,
  damping: 20,
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

/* ── Stagger Patterns (UI Overhaul) ── */

export const staggerContainerFast: Variants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.03, delayChildren: 0.05 }
  }
};

export const staggerItemSpring: Variants = {
  hidden: { opacity: 0, y: 6 },
  visible: {
    opacity: 1,
    y: 0,
    transition: springs.default
  }
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

/* ── Modal / Dialog Variants ── */

export const modalVariants: Variants = {
  hidden: { opacity: 0, scale: 0.96 },
  visible: { opacity: 1, scale: 1, transition: springs.default },
  exit: { opacity: 0, scale: 0.96, transition: { duration: 0.15 } },
};

/* ── Dropdown Variants ── */

export const dropdownVariants: Variants = {
  hidden: { opacity: 0, scaleY: 0.95 },
  visible: {
    opacity: 1,
    scaleY: 1,
    transition: { type: "spring", stiffness: 500, damping: 30 },
  },
  exit: { opacity: 0, scaleY: 0.95, transition: { duration: 0.1 } },
};

export const dropdownItemStagger: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.02 } },
};

export const dropdownItem: Variants = {
  hidden: { opacity: 0, x: -4 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.12 } },
};

/* ── List Item Variants (AnimatePresence) ── */

export const listItemVariants: Variants = {
  hidden: { opacity: 0, height: 0 },
  visible: { opacity: 1, height: "auto", transition: springs.default },
  exit: { opacity: 0, height: 0, transition: { duration: 0.2 } },
};

/* ── Toast Variants ── */

export const toastVariants: Variants = {
  hidden: { opacity: 0, x: 40, scale: 0.95 },
  visible: { opacity: 1, x: 0, scale: 1, transition: springs.default },
  exit: { opacity: 0, x: 40, scale: 0.95, transition: { duration: 0.2 } },
};

/* ── Route Visit Tracking (first-visit stagger) ── */

const _visitedRoutes = new Set<string>();

/**
 * Mark a route as visited and return whether this is the first visit.
 * Pages call this once on mount to decide whether to play stagger entrance.
 */
export function markRouteVisited(route: string): boolean {
  const isFirst = !_visitedRoutes.has(route);
  _visitedRoutes.add(route);
  return isFirst;
}

/**
 * Returns stagger container props for a page.
 * On first visit: plays the stagger entrance animation.
 * On revisit: skips directly to the visible state (no stagger).
 */
export function getStaggerProps(routeKey: string): { variants: Variants; initial: string; animate: string } {
  const isFirst = !_visitedRoutes.has(routeKey);
  _visitedRoutes.add(routeKey);

  if (!isFirst) {
    return {
      variants: {},
      initial: "visible",
      animate: "visible",
    };
  }

  return {
    variants: staggerContainerFast,
    initial: "hidden",
    animate: "visible",
  };
}

/* ── Status Flip (departure-board style) ── */

export const flipVariants: Variants = {
  hidden: { opacity: 0, rotateX: -90 },
  visible: { opacity: 1, rotateX: 0, transition: springs.snappy },
  exit: { opacity: 0, rotateX: 90, transition: { duration: 0.15 } },
};
