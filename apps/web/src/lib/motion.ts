import type { Transition } from "framer-motion";

export const ADE_EASE_OUT = [0.22, 1, 0.36, 1] as const;
export const ADE_EASE_IN_OUT = [0.65, 0, 0.35, 1] as const;

export const pageTransition: Transition = {
  duration: 0.55,
  ease: ADE_EASE_OUT
};

export function revealTransition(delay = 0): Transition {
  return { duration: 0.75, delay, ease: ADE_EASE_OUT };
}

