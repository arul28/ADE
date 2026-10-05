import { useEffect, useState } from "react";
import { Github, Star } from "lucide-react";
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

const linkClass = "text-[13px] text-white/60 transition-colors hover:text-white";

export function SiteNav() {
  const { openInstall } = useInstallDialog();
  const platform = guessPlatform();
  const stars = useGithubStars();

  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.07] bg-[#0a0a0f]/75 backdrop-blur-xl">
      <div className="mx-auto flex h-[60px] max-w-[1320px] items-center gap-7 px-5 sm:px-8">
        <a href="/" aria-label="ADE home" className="flex shrink-0 items-center">
          <img src="/logo.png" alt="ADE" className="h-[22px] w-auto" />
        </a>

        <nav className="hidden items-center gap-6 md:flex">
          <a
            href={LINKS.docs}
            target="_blank"
            rel="noreferrer"
            data-ade-analytics-feature={MARKETING_FEATURES.VIEW_DOCS}
            className={linkClass}
          >
            Docs
          </a>
          <a href={`${LINKS.docs}/changelog`} target="_blank" rel="noreferrer" className={linkClass}>
            Changelog
          </a>
          <a
            href={LINKS.webClient}
            target="_blank"
            rel="noreferrer"
            data-ade-analytics-feature={MARKETING_FEATURES.OPEN_WEB_CLIENT}
            data-ade-analytics-cta={MARKETING_CTA_LABELS.OPEN_WEB_CLIENT}
            data-ade-analytics-position={MARKETING_CTA_POSITIONS.NAVBAR}
            className={linkClass}
          >
            Web app
          </a>
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <a
            href={PRODUCT_HUNT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden transition-transform duration-200 hover:-translate-y-px lg:inline-flex"
          >
            <img
              alt="ADE on Product Hunt"
              width={150}
              height={32}
              src={PRODUCT_HUNT_BADGE}
              className="h-[32px] w-auto"
            />
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
          <button
            type="button"
            onClick={() => openInstall(platform)}
            data-ade-analytics-cta={
              platform === "windows" ? MARKETING_CTA_LABELS.DOWNLOAD_WINDOWS : MARKETING_CTA_LABELS.DOWNLOAD_MAC
            }
            data-ade-analytics-position={MARKETING_CTA_POSITIONS.NAVBAR}
            className="h-8 rounded-full bg-[color:var(--color-violet-bright)] px-4 text-[13px] font-medium text-[#0a0a0f] transition-colors hover:bg-[#c4b5fd]"
          >
            Download
          </button>
        </div>
      </div>
    </header>
  );
}
