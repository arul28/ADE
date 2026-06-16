import type { CSSProperties } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "../../lib/cn";

const VARIANTS = {
  light:
    "bg-[color:var(--color-paper)] border-[color:var(--color-ink-hairline-strong)] shadow-[0_10px_24px_-12px_rgba(24,21,15,0.5)]",
  dark:
    "bg-[#0f0d0a] border-[color:var(--color-ink)] shadow-[0_10px_24px_-12px_rgba(24,21,15,0.5)]",
  hero:
    "bg-[color:var(--color-paper)] border-[color:var(--color-ink-hairline-strong)] shadow-[0_10px_28px_-14px_rgba(0,0,0,0.55)]",
} as const;

export function AgentBadge({
  src,
  name,
  className = "",
  style,
  rotate = 0,
  variant = "light",
  delay = 0,
  floatPhase = 0,
  anchor = "left",
}: {
  src: string;
  name: string;
  className?: string;
  style?: CSSProperties;
  rotate?: number;
  variant?: keyof typeof VARIANTS;
  delay?: number;
  floatPhase?: number;
  anchor?: "left" | "right";
}) {
  const reduceMotion = useReducedMotion() ?? true;

  return (
    <div
      className={cn(
        "absolute -translate-y-1/2",
        anchor === "right" ? "translate-x-1/2" : "-translate-x-1/2",
        className
      )}
      style={style}
    >
      <motion.div
        initial={reduceMotion ? false : { opacity: 0, scale: 0.55 }}
        animate={
          reduceMotion
            ? { opacity: 1, scale: 1 }
            : {
                opacity: 1,
                scale: 1,
                y: [0, -8, 0, 6, 0],
                x: [0, 4, 0, -3, 0],
              }
        }
        transition={{
          opacity: { duration: 0.65, delay, ease: [0.22, 1, 0.36, 1] },
          scale: { duration: 0.65, delay, ease: [0.22, 1, 0.36, 1] },
          y: {
            duration: 5.5 + floatPhase * 0.4,
            repeat: Infinity,
            ease: "easeInOut",
            delay: delay + floatPhase * 0.25,
          },
          x: {
            duration: 6.8 + floatPhase * 0.35,
            repeat: Infinity,
            ease: "easeInOut",
            delay: delay + floatPhase * 0.35,
          },
        }}
      >
        <div
          className={cn(
            "relative z-50 grid h-[56px] w-[56px] place-items-center rounded-full border",
            VARIANTS[variant]
          )}
          style={{ transform: `rotate(${rotate}deg)` }}
          aria-label={name}
          title={name}
        >
          <img
            src={src}
            alt=""
            aria-hidden
            loading="lazy"
            decoding="async"
            className="block h-[34px] w-[34px] object-contain"
          />
        </div>
      </motion.div>
    </div>
  );
}
