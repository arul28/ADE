import type { ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "../lib/cn";
import { revealTransition } from "../lib/motion";

export function Reveal({
  children,
  className,
  delay = 0,
  amount = 0.25
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  /** How much of the element must be on screen to reveal it. Use "some" for a block that can be taller than four screens. */
  amount?: number | "some" | "all";
}) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      className={cn(className)}
      initial={reduceMotion ? undefined : { opacity: 0, y: 18, scale: 0.99 }}
      whileInView={reduceMotion ? undefined : { opacity: 1, y: 0, scale: 1 }}
      viewport={{ once: true, amount }}
      transition={revealTransition(delay)}
    >
      {children}
    </motion.div>
  );
}
