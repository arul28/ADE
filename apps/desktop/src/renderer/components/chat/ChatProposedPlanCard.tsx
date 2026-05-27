import React, { useCallback, useState } from "react";
import { ListChecks, CopySimple } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { ChatMarkdown } from "./chatMarkdown";
import { ChatStatusGlyph } from "./chatStatusVisuals";

/* ── Types ── */

interface ChatProposedPlanCardProps {
  source: string;
  description: string | null;
  question: string | null;
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
}

/* ── Component ── */

const ChatProposedPlanCard = React.memo(function ChatProposedPlanCard({
  source,
  description,
  question,
  disabled,
  onApprove,
  onReject,
}: ChatProposedPlanCardProps) {
  const [copied, setCopied] = useState(false);
  const bodyText = description?.trim() || question?.trim() || "The agent has prepared a plan.";

  const handleCopy = useCallback(() => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(bodyText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [bodyText]);

  return (
    <div className="relative overflow-hidden rounded-xl border border-emerald-500/[0.12] bg-gradient-to-br from-emerald-950/10 via-[#12101A] to-[#12101A] p-4">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-400/20 to-transparent" />

      <div className="mb-2 flex items-center gap-2">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/[0.10] shadow-[0_0_0_3px_rgba(16,185,129,0.08)]">
          <ChatStatusGlyph status="waiting" size={11} />
        </span>
        <ListChecks size={13} weight="bold" className="text-emerald-400/60" />
        <span className="text-emerald-300/60 font-mono text-[9px] uppercase tracking-[0.16em]">
          Plan ready &middot; {source}
        </span>
      </div>

      <div className="mb-3 max-h-[min(34vh,360px)] overflow-y-auto rounded-lg border border-white/[0.06] bg-black/15 px-3 py-2 text-[12px] leading-relaxed text-fg/75">
        <ChatMarkdown tone="neutral">{bodyText}</ChatMarkdown>
      </div>

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
          Implement
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
          Keep planning
        </button>
        <button
          type="button"
          className="ml-auto flex items-center gap-1 rounded-[var(--chat-radius-pill)] border border-white/[0.06] px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-fg/35 transition-colors hover:bg-white/[0.04] hover:text-fg/55"
          onClick={handleCopy}
        >
          <CopySimple size={10} weight="bold" />
          {copied ? "Copied" : "Copy plan"}
        </button>
      </div>
    </div>
  );
});

export { ChatProposedPlanCard };
export type { ChatProposedPlanCardProps };
