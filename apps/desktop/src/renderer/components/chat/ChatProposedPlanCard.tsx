import React, { useCallback, useEffect, useRef, useState } from "react";
import { ListChecks, CopySimple, ArrowsOut, X } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { ChatStatusGlyph } from "./chatStatusVisuals";
import { ChatMarkdown } from "./chatMarkdown";

/* ── Types ── */

interface ChatProposedPlanCardProps {
  source: string;
  description: string | null;
  question: string | null;
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
}

/* ── Constants ── */

const FULL_VIEW_THRESHOLD = 2000;

/* ── Component ── */

const ChatProposedPlanCard = React.memo(function ChatProposedPlanCard({
  source,
  description,
  question,
  disabled,
  onApprove,
  onReject,
}: ChatProposedPlanCardProps) {
  const [fullViewOpen, setFullViewOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  const bodyText = description ?? question ?? "The agent has prepared a plan.";
  const offerFullView = bodyText.length > FULL_VIEW_THRESHOLD;

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(bodyText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [bodyText]);

  // When the modal is open: lock body scroll, move focus into the dialog,
  // trap Tab/Shift+Tab inside the focusable elements, and restore focus to
  // the trigger button when the dialog closes.
  useEffect(() => {
    if (!fullViewOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        event.preventDefault();
        setFullViewOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const container = modalRef.current;
      if (!container) return;
      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("data-focus-skip"));
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      triggerRef.current?.focus?.();
    };
  }, [fullViewOpen]);

  return (
    <>
      <div className="relative overflow-hidden rounded-xl border border-amber-500/[0.10] bg-gradient-to-br from-amber-950/15 via-[#12101A] to-[#12101A] p-4">
        {/* Gradient accent line */}
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber-400/25 to-transparent" />

        {/* ── Header ── */}
        <div className="mb-2.5 flex items-center gap-2">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-amber-500/[0.10] shadow-[0_0_0_3px_rgba(245,158,11,0.08)]">
            <ChatStatusGlyph status="waiting" size={11} />
          </span>
          <ListChecks size={13} weight="bold" className="text-amber-400/60" />
          <span className="text-amber-300/50 font-mono text-[9px] uppercase tracking-[0.16em]">
            Plan Approval &middot; {source}
          </span>
        </div>

        {/* ── Body ── */}
        <div
          data-testid="chat-proposed-plan-body"
          className="mb-2 max-h-[22rem] overflow-y-auto pr-1 text-[12px] leading-6 text-fg/82"
        >
          <ChatMarkdown tone="amber">{bodyText}</ChatMarkdown>
        </div>

        {offerFullView && (
          <div className="mb-2.5 flex items-center">
            <button
              type="button"
              className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.14em] text-amber-300/55 transition-colors hover:text-amber-200/80"
              onClick={(event) => {
                triggerRef.current = event.currentTarget;
                setFullViewOpen(true);
              }}
            >
              <ArrowsOut size={9} weight="bold" />
              View full plan
            </button>
          </div>
        )}

        {/* ── Actions ── */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={disabled}
            className={cn(
              "rounded-lg border border-emerald-400/25 bg-emerald-500/[0.10] px-3 py-1.5 text-[11px] font-medium text-emerald-300 transition-colors",
              "hover:bg-emerald-500/[0.16] disabled:pointer-events-none disabled:opacity-40",
            )}
            onClick={onApprove}
          >
            Approve &amp; Implement
          </button>
          <button
            type="button"
            disabled={disabled}
            className={cn(
              "rounded-lg border border-white/[0.06] px-3 py-1.5 text-[11px] text-fg/50 transition-colors",
              "hover:bg-white/[0.04] disabled:pointer-events-none disabled:opacity-40",
            )}
            onClick={onReject}
          >
            Reject &amp; Revise
          </button>
          <button
            type="button"
            className="ml-auto flex items-center gap-1 rounded-[var(--chat-radius-pill)] border border-white/[0.06] px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-fg/35 transition-colors hover:bg-white/[0.04] hover:text-fg/55"
            onClick={handleCopy}
          >
            <CopySimple size={10} weight="bold" />
            {copied ? "Copied" : "Copy Plan"}
          </button>
        </div>
      </div>

      {fullViewOpen ? (
        <div
          data-testid="chat-proposed-plan-full-view"
          role="dialog"
          aria-modal="true"
          aria-label="Plan approval full view"
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-[radial-gradient(circle_at_top,rgba(245,158,11,0.12),rgba(8,7,12,0.84))] px-4 backdrop-blur-md"
          onClick={(event) => {
            if (event.target === event.currentTarget) setFullViewOpen(false);
          }}
        >
          <div
            ref={modalRef}
            className="ade-glass-card flex h-[min(88vh,900px)] w-full max-w-3xl flex-col overflow-hidden border-amber-500/15 bg-[linear-gradient(180deg,rgba(24,18,12,0.94),rgba(14,11,18,0.9))] shadow-[var(--shadow-panel)]">
            <div className="flex items-center justify-between gap-3 border-b border-amber-400/12 bg-[linear-gradient(90deg,rgba(245,158,11,0.10),transparent)] px-5 py-3">
              <div className="flex items-center gap-2">
                <ListChecks size={14} weight="bold" className="text-amber-300/75" />
                <div className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-amber-200/80">
                  Plan Approval &middot; {source}
                </div>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                className="text-muted-fg/45 transition-colors hover:text-fg/80"
                onClick={() => setFullViewOpen(false)}
                aria-label="Close full plan view"
              >
                <X size={14} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-5 text-[13px] leading-6 text-fg/88">
              <ChatMarkdown tone="amber">{bodyText}</ChatMarkdown>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-amber-400/10 bg-[linear-gradient(180deg,rgba(245,158,11,0.04),transparent)] px-5 py-3">
              <button
                type="button"
                className="flex items-center gap-1 rounded-[var(--chat-radius-pill)] border border-white/[0.06] px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-fg/45 transition-colors hover:bg-white/[0.04] hover:text-fg/70"
                onClick={handleCopy}
              >
                <CopySimple size={10} weight="bold" />
                {copied ? "Copied" : "Copy Plan"}
              </button>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={disabled}
                  className={cn(
                    "rounded-lg border border-emerald-400/25 bg-emerald-500/[0.10] px-3 py-1.5 text-[11px] font-medium text-emerald-300 transition-colors",
                    "hover:bg-emerald-500/[0.16] disabled:pointer-events-none disabled:opacity-40",
                  )}
                  onClick={() => { setFullViewOpen(false); onApprove(); }}
                >
                  Approve &amp; Implement
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  className={cn(
                    "rounded-lg border border-white/[0.06] px-3 py-1.5 text-[11px] text-fg/55 transition-colors",
                    "hover:bg-white/[0.04] disabled:pointer-events-none disabled:opacity-40",
                  )}
                  onClick={() => { setFullViewOpen(false); onReject(); }}
                >
                  Reject &amp; Revise
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
});

export { ChatProposedPlanCard };
export type { ChatProposedPlanCardProps };
