import { motion, useReducedMotion } from "framer-motion";
import { Download, Github } from "lucide-react";
import { LINKS } from "../../lib/links";
import { IPhoneFrame } from "./IPhoneFrame";

/**
 * Dark back cover — final CTA + colophon.
 */
export function BackCover() {
  const reduceMotion = useReducedMotion() ?? true;

  return (
    <section id="quickstart" className="relative overflow-hidden bg-[color:var(--color-bg)] text-[color:var(--color-cream)]">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: [
            "radial-gradient(ellipse 60% 50% at 50% 50%, rgba(124,58,237,0.22) 0%, transparent 70%)",
            "radial-gradient(ellipse 40% 50% at 20% 120%, rgba(167,139,250,0.1) 0%, transparent 70%)",
          ].join(", "),
        }}
      />

      <div className="relative mx-auto grid max-w-[1240px] grid-cols-1 items-center gap-[clamp(32px,4vw,64px)] px-[clamp(20px,3vw,40px)] py-[clamp(56px,6vw,88px)] lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div>
          <motion.p
            initial={reduceMotion ? false : { opacity: 0, y: 10 }}
            whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.5 }}
            transition={{ duration: 0.6 }}
            className="mb-6 inline-flex items-center gap-3 text-[11px] uppercase tracking-[0.34em] text-[color:var(--color-violet-bright)]"
          >
            <span className="inline-block h-px w-10 bg-[color:var(--color-hairline-strong)]" />
            Back Cover
          </motion.p>

          <motion.h2
            initial={reduceMotion ? false : { opacity: 0, y: 14 }}
            whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ duration: 0.75, ease: [0.22, 1, 0.36, 1] }}
            className="max-w-[14ch] font-serif font-normal tracking-[-0.02em] text-[color:var(--color-cream)]"
            style={{
              fontSize: "clamp(44px, 5.6vw, 82px)",
              lineHeight: 1.06,
              margin: 0,
              paddingBottom: "0.1em",
            }}
          >
            The last AI coding app{" "}
            <em className="italic text-[color:var(--color-violet-bright)]">
              you&rsquo;ll download.
            </em>
          </motion.h2>

          <motion.p
            initial={reduceMotion ? false : { opacity: 0, y: 10 }}
            whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ duration: 0.6, delay: 0.15 }}
            className="mt-6 max-w-[40ch] font-serif italic text-[color:var(--color-cream-muted)]"
            style={{ fontSize: "20px", lineHeight: 1.4 }}
          >
            Free. Open source. Local-first. Bring your own keys.
          </motion.p>

          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: 10 }}
            whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ duration: 0.6, delay: 0.25 }}
            className="mt-9 flex flex-wrap gap-3"
          >
            <a
              href={LINKS.releases}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-[2px] bg-[color:var(--color-cream)] px-[22px] py-[14px] text-[15px] font-medium text-[color:var(--color-bg)] transition-colors duration-200 hover:bg-white"
            >
              <Download className="h-4 w-4" /> Download DMG{" "}
              <span className="font-serif italic">→</span>
            </a>
            <a
              href={LINKS.github}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-[2px] border border-[color:var(--color-hairline-strong)] px-[22px] py-[14px] text-[15px] font-medium text-[color:var(--color-cream)] transition-colors hover:border-[color:var(--color-cream)] hover:bg-white/[0.04]"
            >
              <Github className="h-4 w-4" /> View source on GitHub
            </a>
          </motion.div>

          {/* Colophon */}
          <div className="mt-14 border-t border-[color:var(--color-hairline)] pt-6">
            <p
              className="font-serif italic text-[color:var(--color-cream-faint)]"
              style={{ fontSize: "13.5px", lineHeight: 1.55 }}
            >
              Colophon &middot; Set in Instrument Serif &amp; Inter Tight.
              Printed to the web from a single <code className="not-italic">git push</code>.
              &copy; ADE, 2026. Free forever. Source on GitHub.
            </p>
          </div>
        </div>

        {/* Right column — MacBook + iPhone composition */}
        <div className="relative flex justify-center lg:justify-end">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -m-6"
            style={{
              background:
                "radial-gradient(ellipse 55% 55% at 50% 50%, rgba(124,58,237,0.45) 0%, rgba(124,58,237,0.1) 45%, transparent 75%)",
              filter: "blur(14px)",
            }}
          />
          <div className="relative aspect-[1/0.85] w-full max-w-[420px]">
            {/* small MacBook */}
            <div
              className="absolute left-0 top-[8%] w-[78%]"
              style={{
                transform: "rotate(-2deg)",
                filter: "drop-shadow(0 20px 40px rgba(0,0,0,0.5))",
              }}
            >
              <div className="relative aspect-[16/10] overflow-hidden rounded-t-[9px] border border-[color:var(--color-hairline-strong)] bg-[#07070b]">
                <div className="absolute left-[8px] top-[7px] z-[2] flex gap-1">
                  <span className="h-2 w-2 rounded-full bg-[#ff5f57]" />
                  <span className="h-2 w-2 rounded-full bg-[#febc2e]" />
                  <span className="h-2 w-2 rounded-full bg-[#28c840]" />
                </div>
                <img
                  src="/images/screenshots/lanes.png"
                  alt="ADE on macOS"
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover object-top"
                />
              </div>
              <div
                className="relative h-[8px] rounded-b-[12px] border-x border-b border-[color:var(--color-hairline)]"
                style={{
                  background: "linear-gradient(180deg, #1e1e24, #0d0d12)",
                }}
              />
            </div>
            {/* small iPhone */}
            <div
              className="absolute right-0 bottom-0 w-[32%]"
              style={{
                transform: "rotate(4deg)",
                filter: "drop-shadow(0 20px 40px rgba(124,58,237,0.55))",
              }}
            >
              <div className="relative aspect-[9/19.5] overflow-hidden rounded-[28px] border-[5px] border-[#0c0c12] bg-black ring-1 ring-[color:var(--color-hairline-strong)]">
                <div className="absolute left-1/2 top-[6px] z-[2] h-[17px] w-[42%] -translate-x-1/2 rounded-full bg-black" />
                <img
                  src="/images/screenshots/agent-chat.png"
                  alt="ADE on iOS"
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover object-left-top"
                />
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 rounded-[23px]"
                  style={{ boxShadow: "inset 0 0 32px rgba(124,58,237,0.35)" }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
