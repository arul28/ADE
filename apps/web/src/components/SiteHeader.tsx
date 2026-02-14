import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ArrowUpRight, Menu, X } from "lucide-react";
import { cn } from "../lib/cn";
import { LINKS } from "../lib/links";
import { Container } from "./Container";
import { LinkButton } from "./LinkButton";

type NavItem = { label: string; to: string; kind?: "internal" | "external" };

export function SiteHeader() {
  const location = useLocation();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // Close the mobile menu on navigation.
    setOpen(false);
  }, [location.pathname, location.hash]);

  const items = useMemo<NavItem[]>(
    () => [
      { label: "Product", to: "/#product", kind: "internal" },
      { label: "Features", to: "/#features", kind: "internal" },
      { label: "Architecture", to: "/#architecture", kind: "internal" },
      { label: "Docs", to: LINKS.docs, kind: "external" }
    ],
    []
  );

  return (
    <header className="sticky top-0 z-40">
      <div className="glass border-b border-border/70">
        <Container className="flex h-16 items-center justify-between">
          <div className="flex items-center gap-3">
            <Link className="focus-ring inline-flex items-center gap-3 rounded-lg" to="/">
              <img
                src="/images/ade-mark.svg"
                alt="ADE"
                className="h-9 w-9 rounded-[12px] shadow-glass-sm"
              />
              <div className="hidden sm:block">
                <div className="text-sm font-semibold leading-none text-fg">ADE</div>
                <div className="text-xs text-muted-fg">Agentic Development Environment</div>
              </div>
            </Link>
          </div>

          <nav className="hidden items-center gap-2 md:flex">
            {items.map((item) =>
              item.kind === "external" ? (
                <a
                  key={item.label}
                  className="focus-ring rounded-md px-3 py-2 text-sm font-medium text-muted-fg transition-colors hover:text-fg"
                  href={item.to}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="inline-flex items-center gap-1">
                    {item.label} <ArrowUpRight className="h-4 w-4" />
                  </span>
                </a>
              ) : (
                <Link
                  key={item.label}
                  className="focus-ring rounded-md px-3 py-2 text-sm font-medium text-muted-fg transition-colors hover:text-fg"
                  to={item.to}
                >
                  {item.label}
                </Link>
              )
            )}

            <LinkButton to="/download" variant="primary" size="sm" className="ml-1">
              Download
            </LinkButton>
          </nav>

          <div className="flex items-center gap-2 md:hidden">
            <LinkButton to="/download" variant="primary" size="sm">
              Download
            </LinkButton>
            <button
              type="button"
              className="focus-ring inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card/70 text-fg"
              onClick={() => setOpen((v) => !v)}
              aria-label={open ? "Close menu" : "Open menu"}
              aria-expanded={open}
            >
              {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </Container>
      </div>

      <div
        className={cn(
          "md:hidden",
          open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        )}
      >
        <div className="glass border-b border-border/70">
          <Container className="py-3">
            <div className="flex flex-col gap-1">
              {items.map((item) =>
                item.kind === "external" ? (
                  <a
                    key={item.label}
                    className="focus-ring rounded-lg px-3 py-2 text-sm font-medium text-fg"
                    href={item.to}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span className="inline-flex items-center gap-1">
                      {item.label} <ArrowUpRight className="h-4 w-4" />
                    </span>
                  </a>
                ) : (
                  <Link
                    key={item.label}
                    className="focus-ring rounded-lg px-3 py-2 text-sm font-medium text-fg"
                    to={item.to}
                  >
                    {item.label}
                  </Link>
                )
              )}
            </div>
          </Container>
        </div>
      </div>
    </header>
  );
}

