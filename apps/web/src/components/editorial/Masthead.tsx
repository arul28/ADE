import { LINKS } from "../../lib/links";

/**
 * Magazine masthead — top bar on the dark cover.
 * Real ADE wordmark on the left, issue label centered, small nav on right.
 */
export function Masthead() {
  return (
    <header className="relative z-10 border-b border-[color:var(--color-hairline)]">
      <div className="mx-auto flex max-w-[1240px] items-center gap-4 px-[clamp(20px,3vw,40px)] py-[11px] sm:gap-6">
        <a href="/" className="flex items-center gap-2" aria-label="ADE home">
          <img
            src="/images/ade-wordmark.png"
            alt="ADE"
            className="h-[22px] w-auto"
            style={{ filter: "brightness(1.05)" }}
          />
        </a>

        <div className="hidden flex-1 text-center md:block">
          <span className="text-[11px] uppercase tracking-[0.22em] text-[color:var(--color-cream-muted)]">
            Vol. 1 &middot; v1.1.0 &middot; Apr 2026
          </span>
        </div>

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
            href={LINKS.releases}
            target="_blank"
            rel="noreferrer"
            className="text-[color:var(--color-violet-bright)] transition-colors hover:text-[color:var(--color-cream)]"
          >
            Download <span aria-hidden>&darr;</span>
          </a>
        </nav>
      </div>
    </header>
  );
}
