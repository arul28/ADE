import type { ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "../../lib/cn";

/**
 * Editorial pull quote — italic serif, violet, 2px violet left rule.
 * Animates in with a gentle fade+rise on viewport enter.
 */
export function PullQuote({
  children,
  className,
  tone = "ink",
}: {
  children: ReactNode;
  className?: string;
  tone?: "ink" | "cream";
}) {
  const reduceMotion = useReducedMotion() ?? true;

  return (
    <motion.blockquote
      initial={reduceMotion ? false : { opacity: 0, y: 14 }}
      whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.4 }}
      transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        "my-7 border-l-[2px] border-[color:var(--color-accent)] py-[18px] pl-6 font-serif italic",
        tone === "ink"
          ? "text-[color:var(--color-accent)]"
          : "text-[color:var(--color-violet-bright)]",
        className
      )}
      style={{ fontSize: "clamp(22px, 2.4vw, 30px)", lineHeight: 1.25 }}
    >
      {children}
    </motion.blockquote>
  );
}
