import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ArrowUpRight, Download, Github, Menu, Star, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { LINKS } from "../../lib/links";
import type { InstallPlatform } from "../../lib/installTargets";
import {
  MARKETING_CTA_LABELS,
  MARKETING_CTA_POSITIONS,
  MARKETING_FEATURES,
} from "../../lib/marketingAnalytics";
import { useInstallDialog } from "../install/InstallDialogProvider";

const PRODUCT_HUNT_URL =
  "https://www.producthunt.com/products/ade-agentic-development-environment?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-ade-2";
const PRODUCT_HUNT_BADGE =
  "https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1205327&theme=dark";
const STARS_CACHE_KEY = "ade-github-stars";

/** The visitor's desktop platform, so one button opens the right installer. */
export function guessPlatform(): InstallPlatform {
  if (typeof navigator === "undefined") return "mac";
  return /windows/i.test(navigator.userAgent) ? "windows" : "mac";
}

function formatStars(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1)}k` : String(count);
}

/**
 * The repo's star count, read once per browser session from the public GitHub
 * API. The button still shows without a count if the request fails or hits
 * the anonymous rate limit.
 */
function useGithubStars(): number | null {
  const [stars, setStars] = useState<number | null>(() => {
    const cached = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(STARS_CACHE_KEY);
    return cached ? Number(cached) : null;
  });
  useEffect(() => {
    if (stars !== null) return;
    const controller = new AbortController();
    fetch(`https://api.github.com/repos/${LINKS.repo}`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { stargazers_count?: unknown } | null) => {
        if (typeof data?.stargazers_count !== "number") return;
        sessionStorage.setItem(STARS_CACHE_KEY, String(data.stargazers_count));
        setStars(data.stargazers_count);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [stars]);
  return stars;
}

const linkClass = "rounded-md text-[13px] text-white/60 transition-colors hover:text-white focus-ring";

const CHANGELOG_URL = `${LINKS.docs}/changelog`;

/**
 * The site's one header, on every page: the logo, three links, and the
 * download button. Below `md` the links move into a menu.
 */
export function SiteNav() {
  const { openInstall } = useInstallDialog();
  const platform = guessPlatform();
  const stars = useGithubStars();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => setMenuOpen(false), [location.pathname, location.hash]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const onPricing = location.pathname === "/pricing";

  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.07] bg-[#0a0a0f]/75 backdrop-blur-xl">
      <div className="mx-auto flex h-[60px] max-w-[1320px] items-center gap-7 px-5 sm:px-8">
        <Link to="/" aria-label="ADE home" className="focus-ring flex shrink-0 items-center rounded-md">
          <img src="/logo.png" alt="ADE" className="h-[22px] w-auto" />
        </Link>

        <nav className="hidden items-center gap-6 md:flex" aria-label="Main">
          <Link
            to="/pricing"
            aria-current={onPricing ? "page" : undefined}
            data-ade-analytics-feature={MARKETING_FEATURES.VIEW_PRICING}
            className={cn(linkClass, onPricing && "text-white")}
          >
            Pricing
          </Link>
          <a href={LINKS.docs} target="_blank" rel="noreferrer" data-ade-analytics-feature={MARKETING_FEATURES.VIEW_DOCS} className={linkClass}>
            Docs
          </a>
          <a href={CHANGELOG_URL} target="_blank" rel="noreferrer" data-ade-analytics-feature={MARKETING_FEATURES.VIEW_RELEASES} className={linkClass}>
            Changelog
          </a>
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <a
            href={PRODUCT_HUNT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden transition-transform duration-200 hover:-translate-y-px lg:inline-flex"
          >
            <img alt="ADE on Product Hunt" width={150} height={32} src={PRODUCT_HUNT_BADGE} className="h-[32px] w-auto" />
          </a>
          <a
            href={LINKS.github}
            target="_blank"
            rel="noreferrer"
            data-ade-analytics-feature={MARKETING_FEATURES.VIEW_GITHUB}
            className="group hidden h-8 items-center overflow-hidden rounded-full border border-white/12 bg-white/[0.04] text-[13px] text-white/80 transition-colors hover:border-white/30 hover:text-white sm:inline-flex"
          >
            <span className="flex items-center gap-1.5 px-3">
              <Github className="h-4 w-4" /> Star
            </span>
            {stars !== null && (
              <span className="flex h-full items-center gap-1 border-l border-white/12 px-2.5 font-mono text-[12px] text-white/70">
                <Star className="h-3 w-3 fill-amber-300 text-amber-300 transition-transform group-hover:scale-110" />
                {formatStars(stars)}
              </span>
            )}
          </a>
          <a
            href={LINKS.webClient}
            target="_blank"
            rel="noreferrer"
            data-ade-analytics-feature={MARKETING_FEATURES.OPEN_WEB_CLIENT}
            data-ade-analytics-cta={MARKETING_CTA_LABELS.OPEN_WEB_CLIENT}
            data-ade-analytics-position={MARKETING_CTA_POSITIONS.NAVBAR}
            className="focus-ring hidden h-10 items-center gap-1.5 rounded-full bg-white px-[18px] text-[15px] font-semibold text-[#0a0a0f] shadow-[0_0_0_1px_rgba(255,255,255,0.25),0_6px_24px_-6px_rgba(255,255,255,0.45)] transition-[background-color,transform] duration-200 hover:-translate-y-px hover:bg-white/90 md:inline-flex"
          >
            Open web app <ArrowUpRight className="h-4 w-4" strokeWidth={2.4} />
          </a>
          <button
            type="button"
            onClick={() => openInstall(platform)}
            data-ade-analytics-cta={
              platform === "windows" ? MARKETING_CTA_LABELS.DOWNLOAD_WINDOWS : MARKETING_CTA_LABELS.DOWNLOAD_MAC
            }
            data-ade-analytics-position={MARKETING_CTA_POSITIONS.NAVBAR}
            className="focus-ring inline-flex h-10 items-center gap-2 rounded-full bg-[color:var(--color-violet-bright)] px-[18px] text-[15px] font-semibold text-[#0a0a0f] shadow-[0_0_0_1px_rgba(196,181,253,0.4),0_6px_28px_-4px_rgba(167,139,250,0.75)] transition-[background-color,transform] duration-200 hover:-translate-y-px hover:bg-[#c4b5fd]"
          >
            <Download className="h-4 w-4" strokeWidth={2.4} />
            Download
          </button>
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            aria-controls="ade-site-menu"
            className="focus-ring -mr-1 inline-flex h-9 w-9 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/[0.08] hover:text-white md:hidden"
          >
            {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {menuOpen && (
        <div className="fixed inset-x-0 bottom-0 top-[60px] z-40 md:hidden">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-black/60" onClick={() => setMenuOpen(false)} />
          <nav
            id="ade-site-menu"
            aria-label="Main"
            className="relative border-b border-white/[0.08] bg-[#0c0c12] px-5 pb-6 pt-3"
          >
            <MenuLink to="/pricing" feature={MARKETING_FEATURES.VIEW_PRICING}>Pricing</MenuLink>
            <MenuLink href={LINKS.docs} feature={MARKETING_FEATURES.VIEW_DOCS}>Docs</MenuLink>
            <MenuLink href={CHANGELOG_URL} feature={MARKETING_FEATURES.VIEW_RELEASES}>Changelog</MenuLink>
            <MenuLink href={LINKS.github} feature={MARKETING_FEATURES.VIEW_GITHUB}>GitHub</MenuLink>
            <a
              href={LINKS.webClient}
              target="_blank"
              rel="noreferrer"
              data-ade-analytics-feature={MARKETING_FEATURES.OPEN_WEB_CLIENT}
              data-ade-analytics-cta={MARKETING_CTA_LABELS.OPEN_WEB_CLIENT}
              data-ade-analytics-position={MARKETING_CTA_POSITIONS.NAVBAR}
              className="mt-4 flex h-11 items-center justify-center gap-1.5 rounded-full border border-white/20 bg-white/[0.06] text-[15px] font-medium text-white"
            >
              Open web app <ArrowUpRight className="h-4 w-4" />
            </a>
          </nav>
        </div>
      )}
    </header>
  );
}

function MenuLink({
  to,
  href,
  feature,
  children,
}: {
  to?: string;
  href?: string;
  feature: (typeof MARKETING_FEATURES)[keyof typeof MARKETING_FEATURES];
  children: string;
}) {
  const className =
    "focus-ring flex items-center justify-between border-b border-white/[0.06] py-3.5 font-display text-[26px] leading-none text-white";
  if (to) {
    return (
      <Link to={to} data-ade-analytics-feature={feature} className={className}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" data-ade-analytics-feature={feature} className={className}>
      {children}
      <ArrowUpRight className="h-5 w-5 text-white/40" />
    </a>
  );
}
