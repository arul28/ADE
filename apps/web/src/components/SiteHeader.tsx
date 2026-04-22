import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ArrowUpRight, Github, Menu, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { cn } from "../lib/cn";
import { LINKS } from "../lib/links";
import { Container } from "./Container";
import { LinkButton } from "./LinkButton";
import { ADE_EASE_OUT } from "../lib/motion";

type NavItem = { label: string; to: string; kind: "internal" | "external" };

export function SiteHeader() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    setOpen(false);
  }, [location.pathname, location.hash]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 6);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const items = useMemo<NavItem[]>(
    () => [
      { label: "Docs", to: LINKS.docs, kind: "external" },
    ],
    []
  );

  return (
    <header className="sticky top-0 z-50">
      <div
        className={cn(
          "border-b border-border/70 bg-bg/80 backdrop-blur-xl transition-shadow duration-300 [transition-timing-function:var(--ease-out)]",
          scrolled ? "shadow-glass-sm" : undefined
        )}
      >
        <Container className="flex h-16 items-center justify-between">
          <div className="flex items-center gap-3">
            <Link className="focus-ring inline-flex items-center rounded-lg" to="/" aria-label="ADE home">
              <img
                src="/logo.png"
                alt=""
                className="h-9 w-auto object-contain object-left sm:h-10"
                width={180}
                height={36}
                decoding="async"
              />
            </Link>
          </div>

          <nav className="hidden items-center gap-1 md:flex">
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
                    {item.label} <ArrowUpRight className="h-3.5 w-3.5" />
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

            <a
              className="focus-ring ml-1 inline-flex h-9 items-center gap-2 rounded-lg border border-border/70 bg-card/60 px-3 text-sm font-medium text-muted-fg transition-colors hover:text-fg hover:bg-card"
              href={LINKS.github}
              target="_blank"
              rel="noreferrer"
            >
              <Github className="h-4 w-4" />
              GitHub
            </a>

            <LinkButton to={LINKS.releases} variant="primary" size="sm" target="_blank" rel="noreferrer" className="ml-2">
              Download
            </LinkButton>
          </nav>

          <div className="flex items-center gap-2 md:hidden">
            <LinkButton to={LINKS.releases} variant="primary" size="sm" target="_blank" rel="noreferrer">
              Download
            </LinkButton>
            <button
              type="button"
              className={cn(
                "focus-ring inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card/70 text-fg shadow-glass-sm",
                "transition-all duration-200 [transition-timing-function:var(--ease-out)] hover:bg-card/80 active:translate-y-0"
              )}
              onClick={() => setOpen((v) => !v)}
              aria-label={open ? "Close menu" : "Open menu"}
              aria-expanded={open}
              aria-controls="ade-mobile-menu"
            >
              <AnimatePresence initial={false} mode="wait">
                <motion.span
                  key={open ? "close" : "open"}
                  initial={reduceMotion ? undefined : { opacity: 0, rotate: -12, scale: 0.95 }}
                  animate={reduceMotion ? undefined : { opacity: 1, rotate: 0, scale: 1 }}
                  exit={reduceMotion ? undefined : { opacity: 0, rotate: 12, scale: 0.95 }}
                  transition={{ duration: 0.18, ease: ADE_EASE_OUT }}
                  className="inline-flex"
                >
                  {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
                </motion.span>
              </AnimatePresence>
            </button>
          </div>
        </Container>
      </div>

      <AnimatePresence>
        {open ? (
          <motion.div
            className="fixed inset-0 z-40 md:hidden"
            initial={reduceMotion ? undefined : { opacity: 0 }}
            animate={reduceMotion ? undefined : { opacity: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0 }}
            transition={{ duration: 0.2, ease: ADE_EASE_OUT }}
          >
            <button
              type="button"
              aria-label="Close menu"
              className="absolute inset-0 bg-bg/60 backdrop-blur-sm"
              onClick={() => setOpen(false)}
            />
            <motion.div
              id="ade-mobile-menu"
              className="absolute left-0 right-0 top-16 border-b border-border/70 bg-bg/95 backdrop-blur-xl"
              initial={reduceMotion ? undefined : { opacity: 0, y: -10, scale: 0.985 }}
              animate={reduceMotion ? undefined : { opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: -10, scale: 0.985 }}
              transition={{ duration: 0.24, ease: ADE_EASE_OUT }}
            >
              <Container className="py-4">
                <div className="flex flex-col gap-1">
                  {items.map((item) =>
                    item.kind === "external" ? (
                      <a
                        key={item.label}
                        className={cn(
                          "focus-ring rounded-xl px-3 py-2.5 text-sm font-semibold text-fg",
                          "transition-colors duration-200 [transition-timing-function:var(--ease-out)] hover:bg-card/60"
                        )}
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
                        className={cn(
                          "focus-ring rounded-xl px-3 py-2.5 text-sm font-semibold text-fg",
                          "transition-colors duration-200 [transition-timing-function:var(--ease-out)] hover:bg-card/60"
                        )}
                        to={item.to}
                      >
                        {item.label}
                      </Link>
                    )
                  )}
                  <a
                    className={cn(
                      "focus-ring rounded-xl px-3 py-2.5 text-sm font-semibold text-fg",
                      "transition-colors duration-200 [transition-timing-function:var(--ease-out)] hover:bg-card/60"
                    )}
                    href={LINKS.github}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span className="inline-flex items-center gap-1">
                      GitHub <ArrowUpRight className="h-4 w-4" />
                    </span>
                  </a>
                </div>
              </Container>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </header>
  );
}
