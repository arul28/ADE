import { motion, useReducedMotion } from "framer-motion";
import { cn } from "../../lib/cn";

/**
 * Chapter headline — Instrument Serif display.
 * Line 1: plain. Line 2: italic + violet accent.
 * Animates word-by-word rise on viewport enter.
 */
export function ChapterHeadline({
  line1,
  line2,
  deck,
  tone = "ink",
  className,
}: {
  line1: string;
  line2: string;
  deck?: string;
  tone?: "ink" | "cream";
  className?: string;
}) {
  const reduceMotion = useReducedMotion() ?? true;

  const container = {
    hidden: {},
    show: {
      transition: {
        staggerChildren: reduceMotion ? 0 : 0.06,
        delayChildren: reduceMotion ? 0 : 0.05,
      },
    },
  };
  const word = {
    hidden: reduceMotion ? {} : { opacity: 0, y: 14 },
    show: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] as const },
    },
  };

  const headingColor =
    tone === "ink" ? "text-[color:var(--color-ink)]" : "text-[color:var(--color-cream)]";
  const accentColor =
    tone === "ink"
      ? "text-[color:var(--color-accent)]"
      : "text-[color:var(--color-violet-bright)]";
  const deckColor =
    tone === "ink" ? "text-[color:var(--color-ink-muted)]" : "text-[color:var(--color-cream-muted)]";

  return (
    <motion.div
      variants={container}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, amount: 0.4 }}
      className={className}
    >
      <h2
        className={cn("font-serif font-normal tracking-[-0.02em]", headingColor)}
        style={{
          fontSize: "clamp(40px, 5.2vw, 72px)",
          lineHeight: 1.05,
          margin: 0,
        }}
      >
        <span className="block pb-[0.08em]">
          {line1.split(" ").map((w, i) => (
            <motion.span key={i} variants={word} className="mr-[0.22em] inline-block">
              {w}
            </motion.span>
          ))}
        </span>
        <span className={cn("block pb-[0.12em] italic", accentColor)}>
          {line2.split(" ").map((w, i) => (
            <motion.span key={i} variants={word} className="mr-[0.22em] inline-block">
              {w}
            </motion.span>
          ))}
        </span>
      </h2>

      {deck && (
        <motion.p
          variants={word}
          className={cn("mt-6 font-serif italic", deckColor)}
          style={{
            fontSize: "clamp(19px, 1.8vw, 24px)",
            lineHeight: 1.4,
            maxWidth: "34ch",
          }}
        >
          {deck}
        </motion.p>
      )}
    </motion.div>
  );
}
