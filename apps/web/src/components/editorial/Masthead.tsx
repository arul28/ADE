import { LINKS } from "../../lib/links";
import { MARKETING_FEATURES } from "../../lib/marketingAnalytics";

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
            href={LINKS.docs}
            data-ade-analytics-feature={MARKETING_FEATURES.VIEW_DOCS}
            target="_blank"
            rel="noreferrer"
            className="hidden text-[color:var(--color-cream-muted)] transition-colors hover:text-[color:var(--color-cream)] sm:inline"
          >
            Docs
          </a>
          <a
            href={LINKS.github}
            data-ade-analytics-feature={MARKETING_FEATURES.VIEW_GITHUB}
            target="_blank"
            rel="noreferrer"
            className="hidden text-[color:var(--color-cream-muted)] transition-colors hover:text-[color:var(--color-cream)] sm:inline"
          >
            GitHub
          </a>
          <a
            href={LINKS.testflight}
            data-ade-analytics-feature={MARKETING_FEATURES.DOWNLOAD_IOS}
            target="_blank"
            rel="noreferrer"
            className="text-[color:var(--color-violet-bright)] transition-colors hover:text-[color:var(--color-cream)]"
          >
            iOS <span aria-hidden>↓</span>
          </a>

          {/* Twin primary CTAs — the web client carries the same weight as the
              Mac download so a visitor can open ADE in the browser right now. */}
          <a
            href={LINKS.webClient}
            data-ade-analytics-feature={MARKETING_FEATURES.OPEN_WEB_CLIENT}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-[2px] bg-[color:var(--color-cream)] px-3.5 py-[7px] text-[12px] font-medium normal-case tracking-normal text-[color:var(--color-bg)] transition-all duration-200 hover:-translate-y-[1px] hover:bg-white"
          >
            Open web client <span aria-hidden>↗</span>
          </a>
          <a
            href={LINKS.releasesLatest}
            data-ade-analytics-feature={MARKETING_FEATURES.DOWNLOAD_MAC}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-[2px] bg-[color:var(--color-cream)] px-3.5 py-[7px] text-[12px] font-medium normal-case tracking-normal text-[color:var(--color-bg)] transition-all duration-200 hover:-translate-y-[1px] hover:bg-white"
          >
            Mac <span aria-hidden>↓</span>
          </a>
        </nav>
      </div>
    </header>
  );
}
