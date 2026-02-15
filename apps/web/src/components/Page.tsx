import type { ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "../lib/cn";
import { pageTransition } from "../lib/motion";

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      className={cn("min-h-[60vh]", className)}
      initial={reduceMotion ? undefined : { opacity: 0, y: 10, scale: 0.995 }}
      animate={reduceMotion ? undefined : { opacity: 1, y: 0, scale: 1 }}
      exit={reduceMotion ? undefined : { opacity: 0, y: -8, scale: 0.99 }}
      transition={pageTransition}
    >
      {children}
    </motion.div>
  );
}
