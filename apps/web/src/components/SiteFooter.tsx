import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { Container } from "./Container";
import { LINKS } from "../lib/links";

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
              missions, memory, automations, and 35+ built-in tools.
            </p>
          </div>

          <div className="grid gap-8 sm:grid-cols-2 md:col-span-2">
            <div>
              <div className="text-sm font-semibold text-fg">Product</div>
              <div className="mt-3 flex flex-col gap-2 text-sm">
                <a className="focus-ring w-fit rounded-md text-muted-fg hover:text-fg" href={LINKS.releases} target="_blank" rel="noreferrer">
                  Download
                </a>
                <Link className="focus-ring w-fit rounded-md text-muted-fg hover:text-fg" to="/#features">
                  Features
                </Link>
                <Link className="focus-ring w-fit rounded-md text-muted-fg hover:text-fg" to="/#quickstart">
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
                  target="_blank"
                  rel="noreferrer"
                >
                  GitHub <ArrowUpRight className="h-3.5 w-3.5" />
                </a>
                <a
                  className="focus-ring inline-flex w-fit items-center gap-1 rounded-md text-muted-fg hover:text-fg"
                  href={LINKS.docs}
                  target="_blank"
                  rel="noreferrer"
                >
                  Documentation <ArrowUpRight className="h-3.5 w-3.5" />
                </a>
                <a
                  className="focus-ring inline-flex w-fit items-center gap-1 rounded-md text-muted-fg hover:text-fg"
                  href={LINKS.releases}
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
          <div>&copy; {year} ADE. MIT License.</div>
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
