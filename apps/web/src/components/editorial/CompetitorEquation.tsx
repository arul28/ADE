import { Fragment } from "react";
import { motion, useReducedMotion } from "framer-motion";

const COMPETITORS = [
  { name: "Claude Code", short: "Claude", logo: "/images/competitors/claude-code.png" },
  { name: "Codex", short: "Codex", logo: "/images/competitors/codex.png" },
  { name: "OpenCode", short: "OpenC.", logo: "/images/competitors/opencode.png" },
  { name: "T3 Code", short: "T3", logo: "/images/competitors/t3-code.png" },
  { name: "Cursor", short: "Cursor", logo: "/images/competitors/cursor.png" },
  { name: "Superset", short: "Superset", logo: "/images/competitors/superset.png" },
  { name: "Conductor", short: "Cond.", logo: "/images/competitors/conductor.png" },
  { name: "Factory", short: "Factory", logo: "/images/competitors/factory.png" },
  { name: "Paperclip", short: "Paperc.", logo: "/images/competitors/paperclip.png" },
  { name: "OpenClaw", short: "OpenClaw", logo: "/images/competitors/openclaw.png" },
  { name: "GitHub", short: "GitHub", logo: "/images/competitors/github.png" },
] as const;

/**
 * Two-row competitor equation.
 *   Row 1: 11 competitor chips + `+` separators, staggered in left→right.
 *   Row 2: italic serif "equals" + ADE dock icon with violet halo pulse.
 */
export function CompetitorEquation() {
  const reduceMotion = useReducedMotion() ?? true;

  const stagger = 0.065;
  const rowEnd = 0.1 + COMPETITORS.length * stagger;

  const container = {
    hidden: {},
    show: {
      transition: {
        staggerChildren: reduceMotion ? 0 : stagger,
        delayChildren: reduceMotion ? 0 : 0.1,
      },
    },
  };
  const item = {
    hidden: reduceMotion ? {} : { opacity: 0, y: 14, scale: 0.85 },
    show: {
      opacity: 1,
      y: 0,
      scale: 1,
      transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] as const },
    },
  };

  return (
    <div className="flex flex-col items-center gap-3 py-4 sm:gap-4 sm:py-6">
      {/* Row 1 — competitor chips */}
      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="flex max-w-full flex-wrap items-center justify-center gap-1 overflow-x-auto px-4 sm:gap-1.5"
      >
        {COMPETITORS.map((app, i) => (
          <Fragment key={app.name}>
            {i > 0 && (
              <motion.span
                variants={item}
                className="shrink-0 font-serif text-[16px] text-[color:var(--color-cream-faint)] sm:text-[18px]"
              >
                +
              </motion.span>
            )}
            <motion.div variants={item} className="flex shrink-0 flex-col items-center gap-[3px]">
              <div className="group/logo flex h-8 w-8 items-center justify-center overflow-hidden rounded-[8px] border border-[color:var(--color-hairline-strong)] bg-white/[0.045] p-[3px] transition-all duration-300 hover:-translate-y-[2px] hover:border-[color:var(--color-violet-bright)]/55 sm:h-9 sm:w-9">
                <img
                  src={app.logo}
                  alt={app.name}
                  className="h-full w-full object-contain"
                />
              </div>
              <span className="text-[8px] uppercase tracking-[0.08em] text-[color:var(--color-cream-muted)]">
                {app.short}
              </span>
            </motion.div>
          </Fragment>
        ))}
      </motion.div>

      {/* Row 2 — equals + giant ADE side by side */}
      <motion.div
        initial={reduceMotion ? false : { opacity: 0, y: 12 }}
        animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
        transition={{
          duration: 0.7,
          delay: reduceMotion ? 0 : rowEnd + 0.05,
          ease: [0.22, 1, 0.36, 1],
        }}
        className="relative flex items-center gap-4 sm:gap-5"
      >
        <span
          className="font-serif italic text-[color:var(--color-violet-bright)]"
          style={{ fontSize: "clamp(24px, 2.6vw, 34px)" }}
        >
          equals
        </span>

        <div className="relative">
          {!reduceMotion && (
            <motion.div
              aria-hidden
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-[28%]"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{
                opacity: [0, 0.65, 0],
                scale: [0.8, 1.3, 1.7],
              }}
              transition={{
                duration: 1.6,
                delay: rowEnd + 0.4,
                ease: "easeOut",
              }}
              style={{
                width: "96px",
                height: "96px",
                boxShadow: "0 0 110px 34px rgba(124,58,237,0.5)",
              }}
            />
          )}
          <img
            src="/images/ade-dock-icon.png"
            alt="ADE"
            className="relative h-[80px] w-[80px] rounded-[22%] object-contain drop-shadow-[0_14px_48px_rgba(124,58,237,0.6)] sm:h-[96px] sm:w-[96px]"
          />
        </div>
      </motion.div>
    </div>
  );
}
