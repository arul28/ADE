import { motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight, Download, Github, BookOpen } from "lucide-react";
import { LINKS } from "../../lib/links";

/**
 * Left column of the fold — eyebrow, serif display headline,
 * sub, CTAs, byline rule.
 */
export function Lede() {
  const reduceMotion = useReducedMotion() ?? true;

  const container = {
    hidden: {},
    show: {
      transition: {
        staggerChildren: reduceMotion ? 0 : 0.09,
        delayChildren: reduceMotion ? 0 : 0.35,
      },
    },
  };
  const item = {
    hidden: reduceMotion ? {} : { opacity: 0, y: 14 },
    show: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.65, ease: [0.22, 1, 0.36, 1] as const },
    },
  };

  return (
    <motion.div variants={container} initial="hidden" animate="show">
      <motion.p
        variants={item}
        className="mb-3 flex items-center gap-3 text-[11px] font-medium uppercase tracking-[0.34em] text-[color:var(--color-violet-bright)]"
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--color-violet-bright)]" />
        A Demonstration
      </motion.p>

      <motion.div
        variants={item}
        className="mb-6 inline-flex items-center gap-2.5 rounded-full border border-[color:var(--color-violet-bright)]/40 bg-[color:var(--color-violet-bright)]/10 px-3.5 py-1.5 text-[12px] font-medium uppercase tracking-[0.22em] text-[color:var(--color-cream)] shadow-[0_0_24px_-8px_rgba(167,139,250,0.5)]"
      >
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[color:var(--color-violet-bright)] opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-[color:var(--color-violet-bright)]" />
        </span>
        100% Free
        <span className="text-[color:var(--color-cream-faint)]">·</span>
        Open source
        <span className="text-[color:var(--color-cream-faint)]">·</span>
        <a
          href={LINKS.github}
          target="_blank"
          rel="noreferrer"
          className="text-[color:var(--color-violet-bright)] underline-offset-4 transition-colors hover:text-[color:var(--color-cream)] hover:underline"
        >
          AGPL-3.0
        </a>
      </motion.div>

      <motion.h1
        variants={item}
        className="font-serif font-normal tracking-[-0.02em] text-[color:var(--color-cream)]"
        style={{
          fontSize: "clamp(40px, 5.2vw, 76px)",
          lineHeight: 1.04,
          margin: 0,
          paddingBottom: "0.08em",
        }}
      >
        Every AI<br />
        coding tool.<br />
        <em className="italic text-[color:var(--color-violet-bright)]">One</em>{" "}
        app.
      </motion.h1>

      <motion.p
        variants={item}
        className="mt-5 max-w-[44ch] font-sans text-[color:var(--color-cream-muted)]"
        style={{ fontSize: "16px", lineHeight: 1.55 }}
      >
        A single native workspace for{" "}
        <strong className="font-medium text-[color:var(--color-cream)]">
          every AI coding agent
        </strong>
        .{" "}
        <strong className="font-medium text-[color:var(--color-cream)]">
          macOS
        </strong>
        ,{" "}
        <strong className="font-medium text-[color:var(--color-cream)]">
          iOS
        </strong>
        ,{" "}
        <strong className="font-medium text-[color:var(--color-cream)]">
          CLI
        </strong>{" "}
        — synced in real time.
      </motion.p>

      <motion.div variants={item} className="mt-6 flex flex-wrap gap-3">
        <a
          href={LINKS.releases}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 rounded-[2px] bg-[color:var(--color-cream)] px-[18px] py-3 text-[14px] font-medium text-[color:var(--color-bg)] transition-all duration-200 hover:-translate-y-[1px] hover:bg-white"
        >
          <Download className="h-4 w-4" /> Download DMG{" "}
          <span className="font-serif italic">→</span>
        </a>
        <a
          href={LINKS.github}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 rounded-[2px] border border-[color:var(--color-hairline-strong)] px-[18px] py-3 text-[14px] font-medium text-[color:var(--color-cream)] transition-colors hover:border-[color:var(--color-cream)] hover:bg-white/[0.04]"
        >
          <Github className="h-4 w-4" /> View on GitHub
        </a>
        <a
          href={LINKS.docs}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 rounded-[2px] border border-[color:var(--color-hairline-strong)] px-[18px] py-3 text-[14px] font-medium text-[color:var(--color-cream)] transition-colors hover:border-[color:var(--color-cream)] hover:bg-white/[0.04]"
        >
          <BookOpen className="h-4 w-4" /> Read the docs{" "}
          <ArrowUpRight className="h-3.5 w-3.5 text-[color:var(--color-cream-faint)]" />
        </a>
      </motion.div>

      <motion.div
        variants={item}
        className="mt-6 flex items-center gap-3 text-[10.5px] uppercase tracking-[0.22em] text-[color:var(--color-cream-faint)]"
      >
        <span className="inline-block h-px w-10 bg-[color:var(--color-hairline-strong)]" />
        By ADE &middot; Published Apr 2026
      </motion.div>
    </motion.div>
  );
}
