import { memo, type CSSProperties } from "react";
import { File } from "@phosphor-icons/react";

import { COLORS, MONO_FONT } from "../../lanes/laneDesignTokens";
import { PrSection, prSectionAction } from "./prSection";

export type PrFilesChangedFile = { filename: string; additions: number; deletions: number };

/**
 * Five rows. This is a preview under the Checks section, not the Files tab: a
 * 97-file PR must not be able to walk the merge rail off the bottom of the
 * column, and five names is enough to recognise what the PR touches.
 */
const FILES_PREVIEW_LIMIT = 5;

export type PrFilesChangedCardProps = {
  files: PrFilesChangedFile[];
  onOpenFilesTab?: () => void;
  /** Caps the pane height (the right rail passes "34%"). */
  maxHeight?: CSSProperties["maxHeight"];
  /** How many rows to show before folding the rest behind "+N more". */
  previewLimit?: number;
  /**
   * Hairline above the header. On by default: this section's only caller stacks
   * it directly under Checks, and the two lists need a boundary or they read as
   * one long column of rows.
   */
  divided?: boolean;
};

/**
 * "Files changed" section — the diff-stat summary plus a short file preview.
 * Renders in a narrow rail, so every row is a single non-wrapping line: the name
 * truncates and the +/− counts hold their width.
 */
export const PrFilesChangedCard = memo(function PrFilesChangedCard({
  files,
  onOpenFilesTab,
  maxHeight,
  previewLimit = FILES_PREVIEW_LIMIT,
  divided = true,
}: PrFilesChangedCardProps) {
  const totalAdds = files.reduce((sum, f) => sum + (f.additions || 0), 0);
  const totalDels = files.reduce((sum, f) => sum + (f.deletions || 0), 0);
  const preview = files.slice(0, previewLimit);
  const remaining = files.length - preview.length;

  return (
    <PrSection
      data-testid="pr-files-changed-card"
      icon={File}
      title="Files changed"
      meta={
        <span className="whitespace-nowrap">
          {files.length}
          {files.length ? (
            <>
              {" · "}
              <span style={{ color: COLORS.checkPass, fontFamily: MONO_FONT }}>+{totalAdds}</span>{" "}
              <span style={{ color: COLORS.danger, fontFamily: MONO_FONT }}>−{totalDels}</span>
            </>
          ) : null}
        </span>
      }
      inlineEmpty={files.length ? undefined : "No files"}
      action={
        files.length && onOpenFilesTab ? (
          <button type="button" onClick={onOpenFilesTab} style={prSectionAction()}>
            View all
          </button>
        ) : null
      }
      divided={divided}
      scroll
      className="shrink-0"
      style={maxHeight != null ? { maxHeight } : undefined}
    >
      {files.length ? (
        <div className="flex flex-col gap-1" data-testid="pr-files-changed-card-list">
          {preview.map((file) => {
            const name = file.filename.split("/").pop() || file.filename;
            return (
              <button
                key={file.filename}
                type="button"
                onClick={onOpenFilesTab}
                className="flex w-full min-w-0 items-center gap-2 overflow-hidden py-0.5 text-left"
                style={{ background: "none", border: "none", padding: 0, cursor: onOpenFilesTab ? "pointer" : "default" }}
                title={file.filename}
              >
                <span
                  className="min-w-0 flex-1 truncate text-[11px]"
                  style={{ color: COLORS.textSecondary, fontFamily: MONO_FONT }}
                >
                  {name}
                </span>
                {/* The counts never give up width — a squeezed rail truncates the
                    path, not the diff stat. */}
                <span
                  className="shrink-0 text-[10px]"
                  style={{ color: COLORS.checkPass, fontFamily: MONO_FONT }}
                >
                  +{file.additions}
                </span>
                <span
                  className="shrink-0 text-[10px]"
                  style={{ color: COLORS.danger, fontFamily: MONO_FONT }}
                >
                  −{file.deletions}
                </span>
              </button>
            );
          })}
          {remaining > 0 ? (
            <button
              type="button"
              onClick={onOpenFilesTab}
              className="mt-0.5 text-left text-[11px]"
              style={prSectionAction()}
              data-testid="pr-files-changed-card-more"
            >
              +{remaining} more
            </button>
          ) : null}
        </div>
      ) : null}
    </PrSection>
  );
});

export default PrFilesChangedCard;
