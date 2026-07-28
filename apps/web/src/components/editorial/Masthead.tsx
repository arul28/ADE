import { LINKS } from "../../lib/links";
import { MARKETING_FEATURES } from "../../lib/marketingAnalytics";
import { ArrowUpRight, BookOpen, Download, Github, Smartphone } from "lucide-react";

/**
 * Magazine masthead — top bar on the dark cover.
 * ADE wordmark on the left, small nav on the right.
 */
export function Masthead() {
  return (
    <header className="relative z-10 border-b border-[color:var(--color-hairline)]">
      <div className="mx-auto flex max-w-[1520px] items-center gap-4 px-[clamp(20px,3vw,48px)] py-[11px] sm:gap-6">
        <a href="/" className="flex items-center gap-2" aria-label="ADE home">
          <img
            src="/logo.png"
            alt="ADE"
            className="h-[22px] w-auto"
            style={{ filter: "brightness(1.05)" }}
          />
        </a>

        <nav className="ml-auto flex shrink-0 items-center gap-3 text-[11px] uppercase tracking-[0.12em] sm:gap-4 sm:text-[12px] sm:tracking-[0.14em]">
          <a
            href="https://www.producthunt.com/products/ade-agentic-development-environment?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-ade-2"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden rounded-[2px] transition-transform duration-200 hover:-translate-y-px focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-violet-bright)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--color-bg)] sm:inline-flex"
          >
            <img
              alt="ADE - All your coding agents, synced everywhere, free forever | Product Hunt"
              width="134"
              height="29"
              src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1205327&theme=light&t=1785224288348"
            />
          </a>
          <a
            href={LINKS.docs}
            data-ade-analytics-feature={MARKETING_FEATURES.VIEW_DOCS}
            target="_blank"
            rel="noreferrer"
            className="hidden items-center gap-1 text-[color:var(--color-cream-muted)] transition-colors hover:text-[color:var(--color-cream)] sm:inline-flex"
          >
            <BookOpen className="h-3.5 w-3.5" /> Docs
          </a>
          <a
            href={LINKS.github}
            data-ade-analytics-feature={MARKETING_FEATURES.VIEW_GITHUB}
            target="_blank"
            rel="noreferrer"
            className="hidden items-center gap-1 text-[color:var(--color-cream-muted)] transition-colors hover:text-[color:var(--color-cream)] sm:inline-flex"
          >
            <Github className="h-3.5 w-3.5" /> GitHub
          </a>
          <a
            href={LINKS.testflight}
            data-ade-analytics-feature={MARKETING_FEATURES.DOWNLOAD_IOS}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-[2px] border border-[color:var(--color-violet-bright)] bg-[color:var(--color-violet-bright)]/10 px-3 py-[7px] text-[12px] font-medium normal-case tracking-normal text-[color:var(--color-violet-bright)] transition-all duration-200 hover:-translate-y-px hover:bg-[color:var(--color-violet-bright)]/20"
          >
            <Smartphone className="h-3.5 w-3.5" /> iOS
          </a>
          <a
            href={LINKS.releasesLatest}
            data-ade-analytics-feature={MARKETING_FEATURES.DOWNLOAD_MAC}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-[2px] border border-[color:var(--color-violet-bright)] bg-[color:var(--color-violet-bright)]/10 px-3 py-[7px] text-[12px] font-medium normal-case tracking-normal text-[color:var(--color-violet-bright)] transition-all duration-200 hover:-translate-y-px hover:bg-[color:var(--color-violet-bright)]/20"
          >
            <Download className="h-3.5 w-3.5" /> Mac
          </a>
          <a
            href={LINKS.webClient}
            data-ade-analytics-feature={MARKETING_FEATURES.OPEN_WEB_CLIENT}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-[2px] bg-[color:var(--color-violet-bright)] px-3.5 py-[7px] text-[12px] font-medium normal-case tracking-normal text-[color:var(--color-bg)] transition-all duration-200 hover:-translate-y-px hover:bg-[color:var(--color-violet-bright)]/85"
          >
            <span className="sm:hidden">Web</span>
            <span className="hidden sm:inline">Open web client</span>
            <ArrowUpRight className="h-3.5 w-3.5" />
          </a>
        </nav>
      </div>
    </header>
  );
}
