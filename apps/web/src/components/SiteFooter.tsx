import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { Container } from "./Container";
import { LINKS } from "../lib/links";
import {
  MARKETING_CTA_LABELS,
  MARKETING_CTA_POSITIONS,
  MARKETING_FEATURES,
} from "../lib/marketingAnalytics";

export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-border/70 bg-card/30">
      <Container className="py-12">
        <div className="grid gap-10 md:grid-cols-3">
          <div>
            <div className="flex flex-col gap-2">
              <img
                src="/logo.png"
                alt="ADE"
                className="h-9 w-auto object-contain object-left sm:h-10"
                width={200}
                height={40}
                decoding="async"
              />
              <div className="text-xs text-muted-fg">Agentic Development Environment</div>
            </div>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted-fg">
              The all-in-one AI development environment. Agent chat, worktrees,
              automations, and 35+ built-in tools.
            </p>
          </div>

          <div className="grid gap-8 sm:grid-cols-2 md:col-span-2">
            <div>
              <div className="text-sm font-semibold text-fg">Product</div>
              <div className="mt-3 flex flex-col gap-2 text-sm">
                <a className="focus-ring w-fit rounded-md text-muted-fg hover:text-fg" href={LINKS.releasesLatest} data-ade-analytics-feature={MARKETING_FEATURES.DOWNLOAD_MAC} data-ade-analytics-cta={MARKETING_CTA_LABELS.DOWNLOAD_MAC} data-ade-analytics-position={MARKETING_CTA_POSITIONS.FOOTER} target="_blank" rel="noreferrer">
                  Download for Mac
                </a>
                <a className="focus-ring w-fit rounded-md text-muted-fg hover:text-fg" href={LINKS.testflight} data-ade-analytics-feature={MARKETING_FEATURES.DOWNLOAD_IOS} data-ade-analytics-cta={MARKETING_CTA_LABELS.DOWNLOAD_IOS} data-ade-analytics-position={MARKETING_CTA_POSITIONS.FOOTER} target="_blank" rel="noreferrer">
                  Download for iOS
                </a>
                <Link className="focus-ring w-fit rounded-md text-muted-fg hover:text-fg" to="/download" data-ade-analytics-feature={MARKETING_FEATURES.VIEW_DOWNLOAD_PAGE}>
                  All platforms (incl. Windows beta)
                </Link>
                <Link className="focus-ring w-fit rounded-md text-muted-fg hover:text-fg" to="/#features" data-ade-analytics-feature={MARKETING_FEATURES.VIEW_FEATURES}>
                  Features
                </Link>
                <Link className="focus-ring w-fit rounded-md text-muted-fg hover:text-fg" to="/#quickstart" data-ade-analytics-feature={MARKETING_FEATURES.GET_STARTED} data-ade-analytics-cta={MARKETING_CTA_LABELS.GET_STARTED_FREE} data-ade-analytics-position={MARKETING_CTA_POSITIONS.FOOTER}>
                  Get Started
                </Link>
              </div>
            </div>
            <div>
              <div className="text-sm font-semibold text-fg">Links</div>
              <div className="mt-3 flex flex-col gap-2 text-sm">
                <a
                  className="focus-ring inline-flex w-fit items-center gap-1 rounded-md text-muted-fg hover:text-fg"
                  href={LINKS.github}
                  data-ade-analytics-feature={MARKETING_FEATURES.VIEW_GITHUB}
                  target="_blank"
                  rel="noreferrer"
                >
                  GitHub <ArrowUpRight className="h-3.5 w-3.5" />
                </a>
                <a
                  className="focus-ring inline-flex w-fit items-center gap-1 rounded-md text-muted-fg hover:text-fg"
                  href={LINKS.docs}
                  data-ade-analytics-feature={MARKETING_FEATURES.VIEW_DOCS}
                  target="_blank"
                  rel="noreferrer"
                >
                  Documentation <ArrowUpRight className="h-3.5 w-3.5" />
                </a>
                <a
                  className="focus-ring inline-flex w-fit items-center gap-1 rounded-md text-muted-fg hover:text-fg"
                  href={LINKS.releases}
                  data-ade-analytics-feature={MARKETING_FEATURES.VIEW_RELEASES}
                  target="_blank"
                  rel="noreferrer"
                >
                  Releases <ArrowUpRight className="h-3.5 w-3.5" />
                </a>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-10 flex flex-col items-start justify-between gap-3 border-t border-border/70 pt-6 text-xs text-muted-fg sm:flex-row sm:items-center">
          <div>
            © {year} ADE.{" "}
            <a className="focus-ring rounded-md hover:text-fg" href={`${LINKS.github}/blob/main/LICENSE`} target="_blank" rel="noreferrer">
              AGPL-3.0 License.
            </a>
          </div>
          <div className="flex items-center gap-4">
            <Link className="focus-ring rounded-md hover:text-fg" to="/privacy">
              Privacy
            </Link>
            <Link className="focus-ring rounded-md hover:text-fg" to="/terms">
              Terms
            </Link>
          </div>
        </div>
      </Container>
    </footer>
  );
}
