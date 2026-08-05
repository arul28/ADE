import { Fragment, useCallback, useEffect, useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight, Download, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { CopyButton } from "../CopyButton";
import { LINKS } from "../../lib/links";
import type { InstallTarget } from "../../lib/installTargets";
import {
  ANALYTICS_CTA_ATTRIBUTE,
  ANALYTICS_CTA_POSITION_ATTRIBUTE,
  ANALYTICS_FEATURE_ATTRIBUTE,
  MARKETING_CTA_POSITIONS,
  MARKETING_FEATURES,
} from "../../lib/marketingAnalytics";

const FOCUSABLE =
  'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])';

/** The violet all-caps rule used across the editorial sections. */
function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "m-0 inline-flex items-center gap-3 text-[10px] uppercase tracking-[0.3em] text-[color:var(--color-violet-bright)]",
        className,
      )}
    >
      <span aria-hidden className="inline-block h-px w-6 bg-[color:var(--color-hairline-strong)]" />
      {children}
    </p>
  );
}

function CommandLine({
  command,
  analyticsFeature,
  label,
}: {
  command: string;
  analyticsFeature?: InstallTarget["terminal"]["analyticsFeature"];
  label: string;
}) {
  return (
    <div className="flex items-start gap-2 rounded-[2px] border border-[color:var(--color-hairline-strong)] bg-black/30 py-2 pl-3 pr-2">
      {/* This is the string people came for, so it must never be clipped and
          must never break mid-token. Each word is its own nowrap span and the
          spaces between them are the only break opportunities — CSS alone
          can't do this, because the default break rules happily split
          "https://ade-app.dev/..." at the hyphen in "ade-app". */}
      <code className="min-w-0 flex-1 whitespace-pre-wrap font-mono text-[12.5px] leading-[1.65] text-[color:var(--color-cream)]">
        <span aria-hidden className="mr-2 select-none text-[color:var(--color-violet-bright)]">
          $
        </span>
        {command.split(" ").map((word, index) => (
          <Fragment key={`${word}-${index}`}>
            {index > 0 ? " " : null}
            <span className="whitespace-nowrap">{word}</span>
          </Fragment>
        ))}
      </code>
      <CopyButton
        value={command}
        variant="editorial"
        compact
        label={label}
        analyticsFeature={analyticsFeature}
      />
    </div>
  );
}

/**
 * The install dialog body. Mounted (and animated) by InstallDialogProvider —
 * this component owns focus, escape, and the click-outside surface.
 */
export function InstallDialog({
  target,
  onClose,
}: {
  target: InstallTarget;
  onClose: () => void;
}) {
  const reduceMotion = useReducedMotion() ?? true;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = `install-dialog-${target.platform}`;

  // Restore focus to whatever opened the dialog. Captured on mount because by
  // cleanup time document.activeElement is already the dialog.
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => openerRef.current?.focus?.();
  }, []);

  // Scroll lock. Reads the inline value so nested locks (mobile nav) restore
  // to what they set rather than to "".
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null || element === panel,
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  const hasDownloads = Boolean(target.downloads);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6"
      onKeyDown={onKeyDown}
    >
      <motion.button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-[#05050a]/80 backdrop-blur-[3px]"
        initial={reduceMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={reduceMotion ? undefined : { opacity: 0 }}
        transition={{ duration: 0.18 }}
      />

      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        initial={reduceMotion ? false : { opacity: 0, y: 12, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={reduceMotion ? undefined : { opacity: 0, y: 8, scale: 0.99 }}
        transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
        className={cn(
          "relative w-full max-h-[calc(100dvh-2rem)] overflow-y-auto outline-none",
          hasDownloads ? "max-w-[800px]" : "max-w-[540px]",
          "rounded-[2px] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-bg)]",
          "text-[color:var(--color-cream)] shadow-[0_28px_80px_rgba(0,0,0,0.65)]",
        )}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 70% 60% at 50% 0%, rgba(124,58,237,0.16) 0%, transparent 70%)",
          }}
        />

        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="focus-ring absolute right-3 top-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-[2px] text-[color:var(--color-cream-faint)] transition-colors hover:bg-white/[0.06] hover:text-[color:var(--color-cream)]"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>

        <div className="relative px-[clamp(20px,3.5vw,34px)] pb-[clamp(20px,3vw,28px)] pt-[clamp(24px,3.5vw,32px)]">
          <Eyebrow>Install</Eyebrow>
          <h2
            id={titleId}
            className="mt-3 font-serif font-normal tracking-[-0.02em] text-[color:var(--color-cream)]"
            style={{ fontSize: "clamp(26px,3.2vw,34px)", lineHeight: 1.1, margin: "12px 0 0" }}
          >
            {target.title}
          </h2>
          {target.subtitle ? (
            <p className="mt-2 max-w-[46ch] font-serif italic text-[15px] leading-[1.45] text-[color:var(--color-cream-muted)]">
              {target.subtitle}
            </p>
          ) : null}

          <div
            className={cn(
              "mt-7 grid gap-[clamp(20px,2.6vw,28px)]",
              // The terminal column carries a full shell command, so it gets
              // the wider half.
              hasDownloads &&
                "sm:grid-cols-[1.08fr_0.92fr] sm:divide-x sm:divide-[color:var(--color-hairline)]",
            )}
          >
            <section className={cn(hasDownloads && "sm:pr-[clamp(20px,2.6vw,28px)]")}>
              <h3 className="m-0 text-[13px] font-semibold uppercase tracking-[0.12em] text-[color:var(--color-cream)]">
                {target.terminal.heading}
              </h3>
              <div className="mt-3">
                <CommandLine
                  command={target.terminal.command}
                  analyticsFeature={target.terminal.analyticsFeature}
                  label={`Copy the ${target.platform} install command`}
                />
              </div>
              {target.terminal.blurb ? (
                <p className="mt-3 max-w-[42ch] text-[13px] leading-[1.55] text-[color:var(--color-cream-muted)]">
                  {target.terminal.blurb}
                </p>
              ) : null}
            </section>

            {target.downloads ? (
              <section className="sm:pl-[clamp(20px,2.6vw,28px)]">
                <h3 className="m-0 text-[13px] font-semibold uppercase tracking-[0.12em] text-[color:var(--color-cream)]">
                  {target.downloads.heading}
                </h3>
                <div className="mt-3 flex flex-col gap-2">
                  {target.downloads.options.map((option) => (
                    <a
                      key={option.href}
                      href={option.href}
                      {...{
                        [ANALYTICS_CTA_ATTRIBUTE]: option.analyticsCta,
                        [ANALYTICS_CTA_POSITION_ATTRIBUTE]: MARKETING_CTA_POSITIONS.INSTALL_DIALOG,
                      }}
                      className="focus-ring group inline-flex items-center justify-between gap-3 rounded-[2px] border border-[color:var(--color-hairline-strong)] px-4 py-3 text-left transition-colors hover:border-[color:var(--color-cream)] hover:bg-white/[0.05]"
                    >
                      <span className="flex flex-col">
                        <span className="text-[14px] font-medium text-[color:var(--color-cream)]">
                          {option.label}
                        </span>
                        <span className="text-[12px] text-[color:var(--color-cream-faint)]">
                          {option.detail}
                        </span>
                      </span>
                      <Download
                        aria-hidden
                        className="h-4 w-4 shrink-0 text-[color:var(--color-cream-faint)] transition-colors group-hover:text-[color:var(--color-cream)]"
                      />
                    </a>
                  ))}
                </div>
                {target.downloads.blurb ? (
                  <p className="mt-3 max-w-[36ch] text-[13px] leading-[1.55] text-[color:var(--color-cream-muted)]">
                    {target.downloads.blurb}
                  </p>
                ) : null}
              </section>
            ) : null}
          </div>

          <div className="mt-7 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-[color:var(--color-hairline)] pt-4">
            {target.footnote.text ? (
              <p className="m-0 text-[12.5px] text-[color:var(--color-cream-faint)]">
                {target.footnote.text}
              </p>
            ) : null}
            {target.footnote.command ? (
              <>
                <code className="font-mono text-[12px] text-[color:var(--color-cream-muted)]">
                  {target.footnote.command}
                </code>
                <CopyButton
                  value={target.footnote.command}
                  variant="editorial"
                  compact
                  label="Copy the Homebrew command"
                  analyticsFeature={target.footnote.commandAnalyticsFeature}
                />
              </>
            ) : null}
            {/* Escape hatch for anyone who wants checksums, an older version,
                or a brain binary for a machine they aren't sitting at. */}
            <a
              href={LINKS.releasesLatest}
              target="_blank"
              rel="noreferrer"
              {...{ [ANALYTICS_FEATURE_ATTRIBUTE]: MARKETING_FEATURES.VIEW_RELEASES }}
              className="focus-ring ml-auto inline-flex items-center gap-1 rounded-[2px] text-[12.5px] text-[color:var(--color-cream-faint)] underline decoration-[color:var(--color-hairline-strong)] underline-offset-4 transition-colors hover:text-[color:var(--color-cream)]"
            >
              All releases
              <ArrowUpRight className="h-3 w-3" aria-hidden />
            </a>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
