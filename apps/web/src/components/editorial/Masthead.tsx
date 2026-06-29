import { LINKS } from "../../lib/links";

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

        <nav className="ml-auto flex shrink-0 items-center gap-3 text-[11px] uppercase tracking-[0.12em] sm:gap-5 sm:text-[12px] sm:tracking-[0.14em]">
          <a
            href={LINKS.docs}
            target="_blank"
            rel="noreferrer"
            className="text-[color:var(--color-cream-muted)] transition-colors hover:text-[color:var(--color-cream)]"
          >
            Docs
          </a>
          <a
            href={LINKS.github}
            target="_blank"
            rel="noreferrer"
            className="text-[color:var(--color-cream-muted)] transition-colors hover:text-[color:var(--color-cream)]"
          >
            GitHub
          </a>
          <a
            href={LINKS.releasesLatest}
            target="_blank"
            rel="noreferrer"
            className="text-[color:var(--color-violet-bright)] transition-colors hover:text-[color:var(--color-cream)]"
          >
            Mac <span aria-hidden>&darr;</span>
          </a>
          <a
            href={LINKS.testflight}
            target="_blank"
            rel="noreferrer"
            className="text-[color:var(--color-violet-bright)] transition-colors hover:text-[color:var(--color-cream)]"
          >
            iOS <span aria-hidden>&darr;</span>
          </a>
        </nav>
      </div>
    </header>
  );
}
