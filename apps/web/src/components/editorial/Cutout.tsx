import { motion, useReducedMotion } from "framer-motion";
import { cn } from "../../lib/cn";

/**
 * Magazine cutout image — rotated, warm border, soft shadow, italic figure caption.
 * "Develops" on scroll (blur → sharp, opacity 0.4 → 1).
 */
export function Cutout({
  src,
  alt,
  figNumber,
  caption,
  rotate = 1.4,
  className,
  tone = "ink",
}: {
  src: string;
  alt: string;
  figNumber: string;
  caption: string;
  rotate?: number;
  className?: string;
  tone?: "ink" | "cream";
}) {
  const reduceMotion = useReducedMotion();

  return (
    <figure
      className={cn("relative", className)}
      style={{ transform: `rotate(${rotate}deg)` }}
    >
      <motion.div
        initial={reduceMotion ? false : { opacity: 0.3, filter: "blur(12px)" }}
        whileInView={
          reduceMotion ? undefined : { opacity: 1, filter: "blur(0px)" }
        }
        viewport={{ once: true, amount: 0.3 }}
        transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
        className={cn(
          "overflow-hidden",
          tone === "ink"
            ? "border border-[color:var(--color-ink-hairline)] shadow-[0_24px_48px_-24px_rgba(24,21,15,0.45)]"
            : "border border-[color:var(--color-hairline-strong)] shadow-[0_24px_48px_-24px_rgba(0,0,0,0.7)]"
        )}
      >
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          className="block w-full"
        />
      </motion.div>
      <figcaption
        className={cn(
          "mt-4 font-serif italic",
          tone === "ink"
            ? "text-[color:var(--color-ink-muted)]"
            : "text-[color:var(--color-cream-muted)]"
        )}
        style={{
          fontSize: "15px",
          lineHeight: 1.4,
          transform: `rotate(${-rotate}deg)`,
        }}
      >
        <span
          className={cn(
            "mr-2 inline-block align-middle font-sans text-[10px] uppercase tracking-[0.22em] not-italic",
            tone === "ink"
              ? "text-[color:var(--color-accent)]"
              : "text-[color:var(--color-violet-bright)]"
          )}
        >
          {figNumber}
        </span>
        {caption}
      </figcaption>
    </figure>
  );
}
