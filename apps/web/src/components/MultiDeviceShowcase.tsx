import { motion, useReducedMotion } from "framer-motion";
import { Container } from "./Container";

/**
 * Flagship "One app. Every device." section.
 * Device screens are placeholders — swap the `src` paths below when real
 * desktop/iOS/CLI screenshots are ready.
 */
export function MultiDeviceShowcase() {
  const reduceMotion = useReducedMotion();

  return (
    <section className="relative overflow-hidden border-y border-border/60 py-20 sm:py-28">
      {/* Violet wire-grid floor */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.18]"
        style={{
          background: [
            "radial-gradient(ellipse 70% 50% at 50% 50%, rgba(124,58,237,0.25) 0%, transparent 70%)",
          ].join(", "),
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[40%] opacity-25"
        style={{
          backgroundImage:
            "linear-gradient(rgba(124,58,237,0.45) 1px, transparent 1px), linear-gradient(90deg, rgba(124,58,237,0.45) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
          maskImage:
            "linear-gradient(to top, rgba(0,0,0,1), rgba(0,0,0,0)), linear-gradient(to top, rgba(0,0,0,1) 0%, rgba(0,0,0,0.6) 60%, rgba(0,0,0,0) 100%)",
          maskComposite: "intersect",
          WebkitMaskImage:
            "linear-gradient(to top, rgba(0,0,0,1), rgba(0,0,0,0))",
          transform: "perspective(900px) rotateX(62deg) translateY(5%)",
          transformOrigin: "center top",
        }}
      />

      <Container className="relative">
        <div className="mx-auto max-w-3xl text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-accent/90">
            <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
            Desktop · Mobile · CLI
          </div>
          <h2 className="mt-5 text-4xl font-bold tracking-tight text-fg sm:text-5xl lg:text-6xl leading-[1.05]">
            One app.{" "}
            <span className="bg-gradient-to-r from-violet-300 via-accent to-indigo-300 bg-clip-text text-transparent">
              Every device.
            </span>
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-muted-fg sm:text-lg">
            The same missions, lanes, and agents — on your Mac, in your pocket,
            and in your terminal. Synced in real time.
          </p>
        </div>

        {/* Device stage */}
        <div className="relative mx-auto mt-14 grid max-w-6xl grid-cols-12 items-center gap-6 sm:mt-20">
          {/* Animated sync beams (SVG overlay, hidden on mobile) */}
          <SyncBeams reduceMotion={!!reduceMotion} />

          {/* MacBook (left, 7 cols) */}
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: 40, rotateY: -8 }}
            whileInView={reduceMotion ? undefined : { opacity: 1, y: 0, rotateY: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
            className="col-span-12 lg:col-span-7 relative z-10"
            style={{ transformStyle: "preserve-3d" }}
          >
            <DeviceLabel label="Desktop" sub="macOS · native" />
            <MacBookMock src="/images/screenshots/lanes.png" />
            <FloatingChip
              className="-top-3 -right-3 sm:top-6 sm:right-8"
              delay={0.4}
              reduceMotion={!!reduceMotion}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Mission “fix-login” running
            </FloatingChip>
          </motion.div>

          {/* iPhone (right, 5 cols) */}
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: 40, rotateY: 12 }}
            whileInView={reduceMotion ? undefined : { opacity: 1, y: 0, rotateY: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.9, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
            className="col-span-12 lg:col-span-5 relative z-20 flex justify-center lg:justify-start"
            style={{ transformStyle: "preserve-3d" }}
          >
            <div className="relative">
              <DeviceLabel label="iOS" sub="iPhone · Lanes + Chat" />
              <IPhoneMock src="/images/screenshots/lanes.png" />
              <FloatingChip
                className="top-10 -right-8 sm:-right-12"
                delay={0.7}
                reduceMotion={!!reduceMotion}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                Synced · 1s ago
              </FloatingChip>
              <FloatingChip
                className="bottom-10 -left-6"
                delay={1.0}
                reduceMotion={!!reduceMotion}
              >
                Approved PR #284
              </FloatingChip>
            </div>
          </motion.div>

          {/* Terminal (bottom, full width) */}
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: 24 }}
            whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.8, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="col-span-12 lg:col-start-3 lg:col-span-8 relative z-10 mt-4"
          >
            <DeviceLabel label="CLI" sub="ade-cli · headless" inline />
            <TerminalMock />
          </motion.div>
        </div>

        {/* "Alternative to" badges row */}
        <div className="mt-14 flex flex-wrap items-center justify-center gap-2 text-[11px] sm:text-xs">
          <span className="text-muted-fg/70">Alternative to</span>
          {[
            "Cursor",
            "Claude Code",
            "Codex",
            "Factory",
            "Conductor",
            "Paperclip",
          ].map((name) => (
            <span
              key={name}
              className="rounded-full border border-border/60 bg-card/40 px-2.5 py-1 font-medium text-muted-fg hover:text-fg hover:border-accent/40 transition-colors"
            >
              {name}
            </span>
          ))}
          <span className="rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 font-semibold text-accent">
            + a mobile app none of them have
          </span>
        </div>
      </Container>
    </section>
  );
}

/* ──────────────────────────────────────────────
   Subcomponents
   ────────────────────────────────────────────── */

function DeviceLabel({
  label,
  sub,
  inline = false,
}: {
  label: string;
  sub: string;
  inline?: boolean;
}) {
  return (
    <div
      className={
        inline
          ? "mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em]"
          : "mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em]"
      }
    >
      <span className="text-accent">{label}</span>
      <span className="text-muted-fg/60">—</span>
      <span className="text-muted-fg/80 normal-case tracking-normal">{sub}</span>
    </div>
  );
}

function MacBookMock({ src }: { src: string }) {
  return (
    <div className="relative">
      {/* Screen */}
      <div className="relative aspect-[16/10] overflow-hidden rounded-t-xl border border-border/70 bg-[#0a0a0f] shadow-[0_40px_120px_-40px_rgba(124,58,237,0.6)]">
        {/* Traffic lights */}
        <div className="absolute left-3 top-3 z-10 flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-yellow-500/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-green-500/70" />
        </div>
        <img
          src={src}
          alt="ADE desktop app"
          className="h-full w-full object-cover object-top"
          loading="eager"
          decoding="async"
        />
      </div>
      {/* Bottom bezel */}
      <div className="relative h-3 rounded-b-[28px] bg-gradient-to-b from-[#1a1a24] to-[#0f0f16] border-x border-b border-border/70">
        <div className="absolute left-1/2 top-0 h-1 w-24 -translate-x-1/2 rounded-b-lg bg-black/70" />
      </div>
    </div>
  );
}

function IPhoneMock({ src }: { src: string }) {
  return (
    <div className="relative mx-auto aspect-[9/19.5] w-52 sm:w-60 overflow-hidden rounded-[2.5rem] border-[6px] border-[#0f0f16] bg-black shadow-[0_40px_80px_-20px_rgba(124,58,237,0.55)] ring-1 ring-border/80">
      {/* Dynamic Island */}
      <div className="absolute left-1/2 top-2 z-10 h-6 w-20 -translate-x-1/2 rounded-full bg-black" />
      <img
        src={src}
        alt="ADE iOS app"
        className="h-full w-full object-cover object-left-top"
        loading="eager"
        decoding="async"
      />
      {/* Violet inner glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[2rem]"
        style={{
          boxShadow: "inset 0 0 60px rgba(124,58,237,0.25)",
        }}
      />
    </div>
  );
}

function TerminalMock() {
  const lines = [
    { prompt: "$", text: 'ade mission start "fix login redirect bug"', cls: "text-fg" },
    { prompt: "›", text: "Planning phase · 1 worker", cls: "text-muted-fg" },
    { prompt: "›", text: "Development · 3 workers running in parallel", cls: "text-muted-fg" },
    { prompt: "✓", text: "Tests passing · PR #284 opened", cls: "text-emerald-400" },
    { prompt: "✓", text: "Synced to iPhone · 1s ago", cls: "text-accent" },
  ];
  return (
    <div className="relative overflow-hidden rounded-xl border border-border/70 bg-[#07070c]/95 shadow-[0_30px_80px_-30px_rgba(124,58,237,0.5)] backdrop-blur">
      <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-2">
        <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-yellow-500/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-green-500/70" />
        <span className="ml-3 text-[11px] font-mono text-muted-fg/70">
          ade-cli — zsh — 100×24
        </span>
      </div>
      <pre className="px-5 py-4 text-[12.5px] leading-[1.75] font-mono">
        {lines.map((line, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -6 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, amount: 0.6 }}
            transition={{ duration: 0.35, delay: 0.5 + i * 0.18 }}
            className="flex gap-3"
          >
            <span className="select-none text-accent/60">{line.prompt}</span>
            <span className={line.cls}>{line.text}</span>
          </motion.div>
        ))}
      </pre>
    </div>
  );
}

function FloatingChip({
  children,
  className = "",
  delay = 0,
  reduceMotion,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  reduceMotion: boolean;
}) {
  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 10, scale: 0.9 }}
      whileInView={reduceMotion ? undefined : { opacity: 1, y: 0, scale: 1 }}
      viewport={{ once: true, amount: 0.4 }}
      transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}
      className={`absolute z-30 inline-flex items-center gap-2 rounded-full border border-border/80 bg-card/80 px-3 py-1.5 text-[11px] font-medium text-fg backdrop-blur-md shadow-[0_10px_30px_-10px_rgba(124,58,237,0.5)] ${className}`}
    >
      {children}
    </motion.div>
  );
}

function SyncBeams({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 hidden h-full w-full lg:block z-[5]"
      preserveAspectRatio="none"
      viewBox="0 0 100 100"
    >
      <defs>
        <linearGradient id="beam-grad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="rgba(124,58,237,0)" />
          <stop offset="50%" stopColor="rgba(167,139,250,0.9)" />
          <stop offset="100%" stopColor="rgba(124,58,237,0)" />
        </linearGradient>
      </defs>
      {/* Mac → iPhone beam */}
      <motion.line
        x1="55"
        y1="40"
        x2="72"
        y2="45"
        stroke="url(#beam-grad)"
        strokeWidth="0.4"
        strokeLinecap="round"
        initial={{ pathLength: 0, opacity: 0 }}
        whileInView={reduceMotion ? undefined : { pathLength: 1, opacity: [0, 1, 0.6] }}
        viewport={{ once: true, amount: 0.3 }}
        transition={{ duration: 1.2, delay: 0.6, ease: "easeOut" }}
      />
      {/* Mac → Terminal beam */}
      <motion.line
        x1="35"
        y1="65"
        x2="45"
        y2="82"
        stroke="url(#beam-grad)"
        strokeWidth="0.4"
        strokeLinecap="round"
        initial={{ pathLength: 0, opacity: 0 }}
        whileInView={reduceMotion ? undefined : { pathLength: 1, opacity: [0, 1, 0.6] }}
        viewport={{ once: true, amount: 0.3 }}
        transition={{ duration: 1.2, delay: 0.8, ease: "easeOut" }}
      />
      {/* iPhone → Terminal beam */}
      <motion.line
        x1="72"
        y1="68"
        x2="55"
        y2="82"
        stroke="url(#beam-grad)"
        strokeWidth="0.4"
        strokeLinecap="round"
        initial={{ pathLength: 0, opacity: 0 }}
        whileInView={reduceMotion ? undefined : { pathLength: 1, opacity: [0, 1, 0.6] }}
        viewport={{ once: true, amount: 0.3 }}
        transition={{ duration: 1.2, delay: 1.0, ease: "easeOut" }}
      />
    </svg>
  );
}
