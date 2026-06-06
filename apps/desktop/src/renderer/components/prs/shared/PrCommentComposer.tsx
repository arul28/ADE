import { memo, useCallback, type KeyboardEvent } from "react";
import { LockSimple, PaperPlaneTilt } from "@phosphor-icons/react";

import { ChatComposerShell } from "../../chat/ChatComposerShell";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import { cn } from "../../ui/cn";
import { PrMarkdownEditor } from "./PrMarkdownEditor";

export type PrCommentComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  repoOwner: string;
  repoName: string;
  busy?: boolean;
  placeholder?: string;
  /** When set, the composer is disabled and shows this message instead (e.g. unmapped PRs). */
  lockedMessage?: string;
};

export const PrCommentComposer = memo(function PrCommentComposer({
  value,
  onChange,
  onSubmit,
  repoOwner,
  repoName,
  busy = false,
  placeholder = "Leave a comment…",
  lockedMessage,
}: PrCommentComposerProps) {
  const locked = Boolean(lockedMessage);
  const canSubmit = !busy && !locked && value.trim().length > 0;

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
      event.preventDefault();
      if (!canSubmit) return;
      onSubmit();
    },
    [canSubmit, onSubmit],
  );

  return (
    <div
      data-testid="pr-comment-composer"
      className="shrink-0 px-4 pb-4 pt-3"
      style={{
        background:
          "linear-gradient(180deg, transparent 0%, color-mix(in srgb, var(--color-bg) 72%, transparent) 26%, var(--color-bg) 100%)",
      }}
    >
      <ChatComposerShell mode="standard" className="overflow-hidden rounded-[18px]">
        <div className="flex flex-col">
          <PrMarkdownEditor
            value={value}
            onChange={onChange}
            repoOwner={repoOwner}
            repoName={repoName}
            placeholder={placeholder}
            disabled={busy || locked}
            minHeight={60}
            maxHeight={220}
            ariaLabel="PR comment"
            onKeyDown={handleKeyDown}
          />
          <div
            className="flex items-center justify-between gap-2 px-3 py-2"
            style={{ borderTop: `1px solid ${COLORS.border}` }}
          >
            <span
              className="inline-flex items-center gap-1.5 text-[11px]"
              style={{ color: COLORS.textDim, fontFamily: SANS_FONT }}
            >
              {locked ? <LockSimple size={11} /> : null}
              {locked ? lockedMessage : "Markdown supported · ⏎ to send"}
            </span>
            <button
              type="button"
              disabled={!canSubmit}
              onClick={() => {
                if (!canSubmit) return;
                onSubmit();
              }}
              aria-label="Post comment"
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium transition-all",
                canSubmit
                  ? "border-accent/30 bg-accent/12 text-accent hover:border-accent/45 hover:bg-accent/18 active:scale-[0.97]"
                  : "cursor-not-allowed border-white/[0.04] bg-white/[0.02] text-muted-fg/20",
              )}
            >
              <PaperPlaneTilt size={13} weight="fill" />
              Comment
            </button>
          </div>
        </div>
      </ChatComposerShell>
    </div>
  );
});

export default PrCommentComposer;
