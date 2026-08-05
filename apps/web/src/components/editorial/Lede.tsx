import { motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight, BookOpen, Github, Smartphone, Terminal } from "lucide-react";
import { LINKS } from "../../lib/links";
import { useInstallDialog } from "../install/InstallDialogProvider";
import {
  MARKETING_CTA_LABELS,
  MARKETING_CTA_POSITIONS,
  MARKETING_FEATURES,
} from "../../lib/marketingAnalytics";

// The Windows download is permanently on: v1.2.52 shipped the first signed
// Windows installer, so the VITE_ADE_WINDOWS_DOWNLOAD_ENABLED gate this
// constant used to read is retired. ADE_WINDOWS_PUBLIC_RELEASE_ENABLED remains
// the CI-side switch that produces the assets.

/**
 * Real platform marks. lucide dropped brand logos over trademark concerns, so
 * its `Apple`/`Monitor` glyphs are generic shapes that read as the wrong thing
 * next to a real one. These are the actual marks, inlined rather than pulled
 * from an icon package for one use each. `currentColor` so they inherit the
 * button's text colour in both states.
 */
function AppleMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 384 512" fill="currentColor" aria-hidden focusable="false">
      <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
    </svg>
  );
}

/** The flat four-pane mark used since Windows 8, not the older tilted flag. */
function WindowsMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false">
      <path d="M0 3.449 9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801" />
    </svg>
  );
}

/**
 * Hero fold — centered headline, horizontal CTAs.
 */
export function Lede() {
  const reduceMotion = useReducedMotion() ?? true;
  const { openInstall } = useInstallDialog();

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
    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      className="flex w-full max-w-[1200px] flex-col items-center pb-[clamp(12px,2vw,24px)] pt-0 text-center"
    >
      <motion.h1
        variants={item}
        className="font-serif font-normal tracking-[-0.02em] text-[color:var(--color-cream)]"
        style={{
          fontSize: "clamp(40px, 5.4vw, 82px)",
          lineHeight: 1.02,
          margin: 0,
          paddingBottom: "0.08em",
        }}
      >
        <em className="italic text-[color:var(--color-violet-bright)]">Every</em> AI coding tool.
        <br />
        <em className="italic text-[color:var(--color-violet-bright)]">One</em> app that runs{" "}
        <span className={reduceMotion ? "" : "ade-rainbow-text"}>everywhere</span>.
      </motion.h1>

      <motion.div
        variants={item}
        className="mt-[clamp(22px,2.8vw,34px)] flex flex-col items-center gap-3"
      >
        <div className="flex flex-wrap items-center justify-center gap-3">
          {/* Mac and Windows open the install dialog — terminal one-liner or a
              direct download, visitor's choice — rather than dumping people on
              a GitHub releases page full of assets they'd have to decode. */}
          <button
            type="button"
            onClick={() => openInstall("mac")}
            data-ade-analytics-cta={MARKETING_CTA_LABELS.DOWNLOAD_MAC}
            data-ade-analytics-position={MARKETING_CTA_POSITIONS.HERO}
            className="inline-flex items-center gap-2 rounded-[2px] bg-[color:var(--color-cream)] px-5 py-3 text-[14px] font-medium text-[color:var(--color-bg)] transition-all duration-200 hover:-translate-y-[1px] hover:bg-white"
          >
            <AppleMark className="h-4 w-4" /> Download for Mac
          </button>
          {/* Windows sits beside macOS rather than behind a download page.
              The wording is pinned by the Windows release contract test, which
              used to pin the download page. */}
          <button
            type="button"
            onClick={() => openInstall("windows")}
            data-ade-analytics-cta={MARKETING_CTA_LABELS.DOWNLOAD_WINDOWS}
            data-ade-analytics-position={MARKETING_CTA_POSITIONS.HERO}
            title="Windows 10/11 x64. Per-user installer, no administrator rights."
            className="inline-flex items-center gap-2 rounded-[2px] border border-[color:var(--color-hairline-strong)] px-5 py-3 text-[14px] font-medium text-[color:var(--color-cream)] transition-colors hover:border-[color:var(--color-cream)] hover:bg-white/[0.04]"
          >
            <WindowsMark className="h-[15px] w-[15px]" />
            Download for Windows
          </button>
          <a
            href={LINKS.testflight}
            data-ade-analytics-feature={MARKETING_FEATURES.DOWNLOAD_IOS}
            data-ade-analytics-cta={MARKETING_CTA_LABELS.DOWNLOAD_IOS}
            data-ade-analytics-position={MARKETING_CTA_POSITIONS.HERO}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-[2px] border border-[color:var(--color-hairline-strong)] px-5 py-3 text-[14px] font-medium text-[color:var(--color-cream)] transition-colors hover:border-[color:var(--color-cream)] hover:bg-white/[0.04]"
          >
            <Smartphone className="h-4 w-4" /> Download for iOS
          </a>
        </div>
        <p className="flex flex-wrap items-center justify-center gap-x-2 text-[13px] text-[color:var(--color-cream-faint)]">
          {/* No Linux desktop app — but the brain runs anywhere, and that is
              the part that matters for a headless box. */}
          <button
            type="button"
            onClick={() => openInstall("linux")}
            className="inline-flex items-center gap-1 text-[color:var(--color-cream-muted)] underline decoration-[color:var(--color-hairline-strong)] underline-offset-4 transition-colors hover:text-[color:var(--color-cream)]"
          >
            <Terminal className="h-3.5 w-3.5" aria-hidden /> Linux
          </button>
          <span aria-hidden>·</span>
          <a
            href={LINKS.github}
            data-ade-analytics-feature={MARKETING_FEATURES.VIEW_GITHUB}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[color:var(--color-cream-muted)] underline decoration-[color:var(--color-hairline-strong)] underline-offset-4 transition-colors hover:text-[color:var(--color-cream)]"
          >
            <Github className="h-3.5 w-3.5" /> GitHub
          </a>
          <span aria-hidden>·</span>
          <a
            href={LINKS.docs}
            data-ade-analytics-feature={MARKETING_FEATURES.VIEW_DOCS}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[color:var(--color-cream-muted)] underline decoration-[color:var(--color-hairline-strong)] underline-offset-4 transition-colors hover:text-[color:var(--color-cream)]"
          >
            <BookOpen className="h-3.5 w-3.5" /> Docs
            <ArrowUpRight className="h-3 w-3 text-[color:var(--color-cream-faint)]" />
          </a>
        </p>
      </motion.div>
    </motion.div>
  );
}
