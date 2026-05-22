import React, { useCallback, useMemo, useState } from "react";
import { ChatBubble, PaperPlaneTilt } from "@phosphor-icons/react";
import { ChatMarkdown } from "./chatMarkdown";
import { cn } from "../ui/cn";

export type PlanDocumentViewerProps = {
  content: string;
  tone?: "amber" | "sky" | "neutral";
  className?: string;
  onAddComment?: (args: { lines: number[]; excerpt: string; comment: string }) => void;
};

function splitPlanLines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").split("\n");
}

function excerptForLines(lines: string[], selected: number[]): string {
  const sorted = [...selected].sort((a, b) => a - b);
  const start = sorted[0]! - 1;
  const end = sorted[sorted.length - 1]!;
  return lines.slice(start, end).join("\n").trim();
}

export const PlanDocumentViewer = React.memo(function PlanDocumentViewer({
  content,
  tone = "amber",
  className,
  onAddComment,
}: PlanDocumentViewerProps) {
  const lines = useMemo(() => splitPlanLines(content), [content]);
  const [anchorLine, setAnchorLine] = useState<number | null>(null);
  const [selectedLines, setSelectedLines] = useState<number[]>([]);
  const [commentDraft, setCommentDraft] = useState("");

  const handleLineClick = useCallback((lineNumber: number, extend: boolean) => {
    if (extend && anchorLine != null) {
      const start = Math.min(anchorLine, lineNumber);
      const end = Math.max(anchorLine, lineNumber);
      const range = Array.from({ length: end - start + 1 }, (_, index) => start + index);
      setSelectedLines(range);
      return;
    }
    setAnchorLine(lineNumber);
    setSelectedLines([lineNumber]);
  }, [anchorLine]);

  const submitComment = useCallback(() => {
    const trimmed = commentDraft.trim();
    if (!trimmed.length || selectedLines.length === 0 || !onAddComment) return;
    onAddComment({
      lines: selectedLines,
      excerpt: excerptForLines(lines, selectedLines),
      comment: trimmed,
    });
    setCommentDraft("");
    setSelectedLines([]);
    setAnchorLine(null);
  }, [commentDraft, lines, onAddComment, selectedLines]);

  const selectedSet = useMemo(() => new Set(selectedLines), [selectedLines]);

  return (
    <div className={cn("flex min-h-0 flex-col gap-3", className)}>
      <div className="ade-glass-card min-h-0 flex-1 overflow-hidden rounded-xl border border-white/[0.08] bg-black/10">
        <div className="max-h-full overflow-auto">
          <div className="grid grid-cols-[auto_minmax(0,1fr)]">
            {lines.map((line, index) => {
              const lineNumber = index + 1;
              const selected = selectedSet.has(lineNumber);
              return (
                <React.Fragment key={lineNumber}>
                  <button
                    type="button"
                    aria-label={`Select line ${lineNumber}`}
                    className={cn(
                      "sticky left-0 select-none border-r border-white/[0.06] px-3 py-0.5 text-right font-mono text-[10px] tabular-nums transition-colors",
                      selected
                        ? "bg-violet-500/15 text-violet-200/90"
                        : "bg-[color:color-mix(in_srgb,var(--color-card)_88%,black_12%)] text-muted-fg/45 hover:text-muted-fg/70",
                    )}
                    onClick={(event) => handleLineClick(lineNumber, event.shiftKey)}
                  >
                    {lineNumber}
                  </button>
                  <div
                    className={cn(
                      "min-w-0 px-3 py-0.5 font-mono text-[12px] leading-6 text-fg/82 whitespace-pre-wrap break-words",
                      selected && "bg-violet-500/[0.08]",
                    )}
                    onClick={(event) => handleLineClick(lineNumber, event.shiftKey)}
                    role="presentation"
                  >
                    {line.length ? line : "\u00a0"}
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
        <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-fg/70">
          <ChatBubble size={12} weight="fill" className="text-violet-300/70" />
          <span>
            {selectedLines.length
              ? `Comment on ${selectedLines.length === 1 ? `line ${selectedLines[0]}` : `lines ${selectedLines[0]}-${selectedLines[selectedLines.length - 1]}`}`
              : "Select one or more lines to add a comment"}
          </span>
        </div>
        <textarea
          value={commentDraft}
          disabled={!selectedLines.length || !onAddComment}
          onChange={(event) => setCommentDraft(event.currentTarget.value)}
          rows={3}
          placeholder={onAddComment ? "Add feedback on the selected plan lines…" : "Comments are read-only in this view."}
          className="mb-2 block w-full resize-y rounded-lg border border-white/[0.08] bg-black/15 px-3 py-2 text-[12px] leading-relaxed text-fg/85 outline-none placeholder:text-muted-fg/35 disabled:cursor-not-allowed disabled:opacity-50"
        />
        {onAddComment ? (
          <div className="flex justify-end">
            <button
              type="button"
              disabled={!selectedLines.length || !commentDraft.trim()}
              onClick={submitComment}
              className="inline-flex items-center gap-1.5 rounded-lg border border-violet-400/25 bg-violet-500/10 px-3 py-1.5 text-[11px] font-medium text-violet-200 transition-colors hover:bg-violet-500/16 disabled:pointer-events-none disabled:opacity-40"
            >
              <PaperPlaneTilt size={12} weight="fill" />
              Add to chat context
            </button>
          </div>
        ) : null}
      </div>

      <details className="rounded-xl border border-white/[0.06] bg-black/10 px-4 py-3">
        <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-[0.12em] text-muted-fg/60">
          Rendered preview
        </summary>
        <div className="mt-3 text-[13px] leading-6 text-fg/88">
          <ChatMarkdown tone={tone}>{content}</ChatMarkdown>
        </div>
      </details>
    </div>
  );
});
