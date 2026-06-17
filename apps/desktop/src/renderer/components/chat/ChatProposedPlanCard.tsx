import React, { useCallback, useState } from "react";
import { CopySimple } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { ChatMarkdown } from "./chatMarkdown";
import { ProviderLogo } from "../shared/ProviderLogos";
import { pendingInputHeaderLabel } from "../../../shared/pendingInputLabels";

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
  // Provider-identified header — "{Provider} · Plan ready" — matching the
  // question card. The card chrome inherits the per-provider `--chat-accent`.
  const headerLabel = pendingInputHeaderLabel(source, "plan_approval");

  const handleCopy = useCallback(() => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(bodyText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [bodyText]);

  return (
    <div className="relative overflow-hidden rounded-xl border border-[color:color-mix(in_srgb,var(--chat-accent)_22%,transparent)] bg-[#12101A] p-4">
      <div className="absolute inset-x-0 top-0 h-px bg-[color:color-mix(in_srgb,var(--chat-accent)_30%,transparent)]" />

      <div className="mb-2 flex items-center gap-2">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-[var(--chat-radius-pill)] border border-[color:color-mix(in_srgb,var(--chat-accent)_22%,transparent)] bg-black/20">
          <ProviderLogo family={source} size={11} />
        </span>
        <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-[color:color-mix(in_srgb,var(--chat-accent)_82%,white_18%)]">
          {headerLabel}
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
            "rounded-lg border px-3 py-1.5 text-[11px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-40",
            "border-[color:color-mix(in_srgb,var(--chat-accent)_45%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_14%,transparent)] text-[color:color-mix(in_srgb,var(--chat-accent)_88%,white_12%)] hover:bg-[color:color-mix(in_srgb,var(--chat-accent)_22%,transparent)]",
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
