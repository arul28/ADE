import { motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight, BookOpen, Download, Github, Smartphone } from "lucide-react";
import { CopyButton } from "../CopyButton";
import { LINKS } from "../../lib/links";
import {
  MARKETING_CTA_LABELS,
  MARKETING_CTA_POSITIONS,
  MARKETING_FEATURES,
} from "../../lib/marketingAnalytics";

const BREW_INSTALL_CMD = "brew install --cask arul28/ade/ade";

/**
 * Hero fold — centered headline, horizontal CTAs.
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
        className="mt-[clamp(18px,2.2vw,28px)] flex flex-col items-center gap-2"
      >
        <span className="text-[10.5px] uppercase tracking-[0.22em] text-[color:var(--color-cream-faint)]">
          Quick install · macOS
        </span>
        <div className="inline-flex max-w-[min(100%,640px)] items-stretch overflow-hidden rounded-[2px] border border-[color:var(--color-hairline-strong)] bg-black/35">
          <code className="flex items-center whitespace-nowrap px-3.5 py-2 font-mono text-[13px] text-[color:var(--color-cream)] sm:text-[14px]">
            {BREW_INSTALL_CMD}
          </code>
          <div
            aria-hidden
            className="w-px shrink-0 self-stretch bg-[color:var(--color-hairline-strong)]"
          />
          <CopyButton
            value={BREW_INSTALL_CMD}
            analyticsFeature={MARKETING_FEATURES.COPY_INSTALL_COMMAND}
            compact
            className="h-auto shrink-0 rounded-none border-0 bg-transparent px-2.5 py-2 text-[color:var(--color-cream)] shadow-none hover:bg-white/[0.06] hover:shadow-none"
          />
        </div>
      </motion.div>

      <motion.div
        variants={item}
        className="mt-4 flex flex-col items-center gap-3"
      >
        <div className="flex flex-wrap items-center justify-center gap-3">
          <a
            href={LINKS.releasesLatest}
            data-ade-analytics-feature={MARKETING_FEATURES.DOWNLOAD_MAC}
            data-ade-analytics-cta={MARKETING_CTA_LABELS.DOWNLOAD_MAC}
            data-ade-analytics-position={MARKETING_CTA_POSITIONS.HERO}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-[2px] bg-[color:var(--color-cream)] px-5 py-3 text-[14px] font-medium text-[color:var(--color-bg)] transition-all duration-200 hover:-translate-y-[1px] hover:bg-white"
          >
            <Download className="h-4 w-4" /> Download for Mac
          </a>
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
