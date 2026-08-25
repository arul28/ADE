import { ArrowsLeftRight, X } from "@phosphor-icons/react";

import { cn } from "../ui/cn";

/**
 * Non-blocking notice above the composer on a subagent chat: this thread still
 * reports to its parent. Take over converts it to a peer; Keep reporting (or
 * dismiss) leaves the channel open. Sending does not answer the prompt.
 */

const CARD_BASE_CLASS =
  "mb-1.5 flex items-start gap-2.5 rounded-[calc(var(--chat-radius-card)-8px)] border px-3 py-2.5";
const ICON_TILE_CLASS =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-violet-400/18 bg-violet-400/[0.08] text-violet-200";
const BUTTON_BASE_CLASS =
  "inline-flex shrink-0 items-center rounded-md border px-2.5 py-1 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-semibold transition-colors disabled:pointer-events-none disabled:opacity-40";

export function ChatSubagentTakeoverBanner({
  parentTitle,
  onTakeOver,
  onKeepReporting,
  className,
}: {
  parentTitle: string | null;
  onTakeOver: () => void;
  onKeepReporting: () => void;
  className?: string;
}) {
  const namedParent = parentTitle?.trim() || null;
  const line = namedParent
    ? `This chat reports back to "${namedParent}". Take it over?`
    : "This chat reports back to its parent. Take it over?";

  return (
    <div
      data-testid="chat-subagent-takeover-banner"
      className={cn(
        CARD_BASE_CLASS,
        "border-violet-400/16 bg-violet-400/[0.05]",
        className,
      )}
    >
      <div className={ICON_TILE_CLASS}>
        <ArrowsLeftRight size={13} weight="bold" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-sans text-[length:calc(var(--chat-font-size)*12/14)] font-semibold text-violet-50/90">
          Take over this chat?
        </div>
        <div className="mt-1 text-[length:calc(var(--chat-font-size)*11/14)] leading-relaxed text-fg/60">
          {line}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            data-testid="chat-subagent-takeover-take"
            className={cn(
              BUTTON_BASE_CLASS,
              "border-violet-300/22 bg-violet-400/[0.10] text-violet-50/85 hover:border-violet-200/38 hover:bg-violet-400/[0.16] focus-visible:border-violet-200/38 focus-visible:bg-violet-400/[0.16]",
            )}
            onClick={onTakeOver}
          >
            Take over
          </button>
          <button
            type="button"
            data-testid="chat-subagent-takeover-keep"
            className={cn(
              BUTTON_BASE_CLASS,
              "border-white/[0.10] bg-white/[0.035] text-fg/70 hover:border-white/[0.2] hover:bg-white/[0.07] hover:text-fg/90 focus-visible:border-white/[0.2] focus-visible:bg-white/[0.07] focus-visible:text-fg/90",
            )}
            onClick={onKeepReporting}
          >
            Keep reporting
          </button>
        </div>
      </div>
      <button
        type="button"
        data-testid="chat-subagent-takeover-dismiss"
        aria-label="Keep reporting"
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-fg/70 transition-colors hover:bg-white/[0.07] hover:text-fg/90"
        onClick={onKeepReporting}
      >
        <X size={12} weight="bold" aria-hidden />
      </button>
    </div>
  );
}
