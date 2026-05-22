import { memo, useCallback, type KeyboardEvent } from "react";
import { PaperPlaneTilt } from "@phosphor-icons/react";

import { ChatComposerShell } from "../../chat/ChatComposerShell";
import { cn } from "../../ui/cn";

export type PrCommentComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy?: boolean;
  placeholder?: string;
};

export const PrCommentComposer = memo(function PrCommentComposer({
  value,
  onChange,
  onSubmit,
  busy = false,
  placeholder = "Leave a comment…",
}: PrCommentComposerProps) {
  const canSubmit = !busy && value.trim().length > 0;

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
      <ChatComposerShell mode="standard" className="rounded-[18px]">
        <div className="flex items-end gap-2 px-3 py-2.5">
          <textarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            rows={1}
            disabled={busy}
            aria-label="PR comment"
            className={cn(
              "block max-h-32 min-h-[2.5rem] w-full flex-1 resize-none bg-transparent py-1 font-sans text-[13px] leading-[1.55] text-fg/88 outline-none placeholder:text-muted-fg/35",
              busy ? "cursor-not-allowed opacity-60" : "",
            )}
          />
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => {
              if (!canSubmit) return;
              onSubmit();
            }}
            aria-label="Post comment"
            className={cn(
              "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-all",
              canSubmit
                ? "border-accent/30 bg-accent/12 text-accent hover:border-accent/45 hover:bg-accent/18 active:scale-[0.97]"
                : "border-white/[0.04] bg-white/[0.02] text-muted-fg/20",
            )}
          >
            <PaperPlaneTilt size={14} weight="fill" />
          </button>
        </div>
      </ChatComposerShell>
    </div>
  );
});

export default PrCommentComposer;
