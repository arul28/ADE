import type { ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "../../lib/cn";

/**
 * Cream article chapter scaffold. Includes:
 *   - running head (issue/dateline/page)
 *   - folio (Chapter N / title / page number)
 *   - children (headline, body, images)
 *
 * Children fade in on viewport enter.
 */
export function Chapter({
  chapterNumber,
  chapterTitle,
  pageNumber,
  children,
  className,
  id,
}: {
  chapterNumber: string;
  chapterTitle: string;
  pageNumber: string;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const reduceMotion = useReducedMotion() ?? true;

  return (
    <section
      id={id}
      className={cn(
        "relative bg-[color:var(--color-paper)] text-[color:var(--color-ink)]",
        className
      )}
    >
      <div className="mx-auto max-w-[1520px] px-[clamp(20px,3vw,48px)] py-[clamp(24px,3vw,52px)]">
        {/* running head */}
        <div className="mb-6 flex items-baseline justify-between border-b border-[color:var(--color-ink-hairline)] pb-3 text-[11px] uppercase tracking-[0.24em] text-[color:var(--color-ink-muted)]">
          <span>ADE &middot; April &rsquo;26</span>
          <span className="hidden sm:block">The Agentic Development Environment</span>
          <span>{`Vol. 1 · v1.1.0 · ${pageNumber}`}</span>
        </div>

        {/* folio */}
        <motion.div
          initial={reduceMotion ? false : { opacity: 0, y: 10 }}
          whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.6 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="mb-8 grid grid-cols-3 items-baseline gap-4 text-[11px] uppercase tracking-[0.26em]"
        >
          <span className="font-medium text-[color:var(--color-accent)]">
            {chapterNumber}
          </span>
          <span className="text-center text-[color:var(--color-ink-muted)]">
            {chapterTitle}
          </span>
          <span className="text-right text-[color:var(--color-ink-muted)]">
            Page {pageNumber}
          </span>
        </motion.div>

        {children}
      </div>
    </section>
  );
}

/** Paragraph with drop cap on the first letter. */
export function ChapterBody({
  children,
  dropCap = false,
  className,
  tone = "ink",
}: {
  children: ReactNode;
  dropCap?: boolean;
  className?: string;
  tone?: "ink" | "cream";
}) {
  const reduceMotion = useReducedMotion() ?? true;
  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 10 }}
      whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.4 }}
      transition={{ duration: 0.6, delay: 0.05, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        "mb-5 font-sans",
        tone === "ink"
          ? "text-[color:var(--color-ink)]"
          : "text-[color:var(--color-cream)]",
        dropCap &&
          "first-letter:float-left first-letter:mt-[6px] first-letter:mr-[10px] first-letter:font-serif first-letter:text-[68px] first-letter:leading-[0.85] first-letter:text-[color:var(--color-accent)]",
        className
      )}
      style={{ fontSize: "16.5px", lineHeight: 1.65 }}
    >
      {children}
    </motion.div>
  );
}

/** Italic byline with short rule. */
export function Byline({
  author = "By ADE Staff",
  date = "April 2026",
  tone = "ink",
}: {
  author?: string;
  date?: string;
  tone?: "ink" | "cream";
}) {
  return (
    <div
      className={cn(
        "mt-10 flex items-center gap-3 text-[10.5px] uppercase tracking-[0.22em]",
        tone === "ink"
          ? "text-[color:var(--color-ink-muted)]"
          : "text-[color:var(--color-cream-faint)]"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-block h-px w-8",
          tone === "ink"
            ? "bg-[color:var(--color-ink-hairline-strong)]"
            : "bg-[color:var(--color-hairline-strong)]"
        )}
      />
      {author} &middot; {date}
    </div>
  );
}
