import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { Container } from "./Container";
import { LINKS } from "../lib/links";

export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-border/70 bg-card/40">
      <Container className="py-12">
        <div className="grid gap-10 md:grid-cols-3">
          <div>
            <div className="flex items-center gap-3">
              <img src="/images/ade-mark.svg" alt="ADE" className="h-10 w-10 rounded-[14px]" />
              <div>
                <div className="text-sm font-semibold text-fg">ADE</div>
                <div className="text-xs text-muted-fg">Mission control for agentic development.</div>
              </div>
            </div>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted-fg">
              ADE is a desktop cockpit for parallel, agentic coding workflows: lanes (worktrees), terminals,
              packs, conflict prediction, and GitHub integration.
            </p>
          </div>

          <div className="grid gap-8 sm:grid-cols-2 md:col-span-2">
            <div>
              <div className="text-sm font-semibold text-fg">Product</div>
              <div className="mt-3 flex flex-col gap-2 text-sm">
                <Link className="focus-ring w-fit rounded-md text-muted-fg hover:text-fg" to="/download">
                  Download
                </Link>
                <Link className="focus-ring w-fit rounded-md text-muted-fg hover:text-fg" to="/#features">
                  Features
                </Link>
                <Link className="focus-ring w-fit rounded-md text-muted-fg hover:text-fg" to="/#architecture">
                  Architecture
                </Link>
              </div>
            </div>
            <div>
              <div className="text-sm font-semibold text-fg">Links</div>
              <div className="mt-3 flex flex-col gap-2 text-sm">
                <a
                  className="focus-ring inline-flex w-fit items-center gap-1 rounded-md text-muted-fg hover:text-fg"
                  href={LINKS.github}
                  target="_blank"
                  rel="noreferrer"
                >
                  GitHub <ArrowUpRight className="h-4 w-4" />
                </a>
                <a
                  className="focus-ring inline-flex w-fit items-center gap-1 rounded-md text-muted-fg hover:text-fg"
                  href={LINKS.prd}
                  target="_blank"
                  rel="noreferrer"
                >
                  PRD <ArrowUpRight className="h-4 w-4" />
                </a>
                <a
                  className="focus-ring inline-flex w-fit items-center gap-1 rounded-md text-muted-fg hover:text-fg"
                  href={LINKS.releases}
                  target="_blank"
                  rel="noreferrer"
                >
                  Releases <ArrowUpRight className="h-4 w-4" />
                </a>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-10 flex flex-col items-start justify-between gap-3 border-t border-border/70 pt-6 text-xs text-muted-fg sm:flex-row sm:items-center">
          <div>© {year} ADE. All rights reserved.</div>
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

