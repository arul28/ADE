import { memo, type CSSProperties } from "react";

import { COLORS, MONO_FONT, SANS_FONT, floatingPane } from "../../lanes/laneDesignTokens";

export type PrFilesChangedFile = { filename: string; additions: number; deletions: number };

const FILES_PREVIEW_LIMIT = 6;

export type PrFilesChangedCardProps = {
  files: PrFilesChangedFile[];
  onOpenFilesTab?: () => void;
  /** Caps the pane height (the left "what changed" rail passes "38%"). */
  maxHeight?: CSSProperties["maxHeight"];
  /** How many rows to show before folding the rest behind "+N more". */
  previewLimit?: number;
};

/**
 * "N files changed" pane — the diff-stat summary plus a short file preview.
 * Lives in the left "what changed" rail under the commits pane (it used to sit
 * in the right metadata rail, which is now reserved for "can this land").
 */
export const PrFilesChangedCard = memo(function PrFilesChangedCard({
  files,
  onOpenFilesTab,
  maxHeight,
  previewLimit = FILES_PREVIEW_LIMIT,
}: PrFilesChangedCardProps) {
  const totalAdds = files.reduce((sum, f) => sum + (f.additions || 0), 0);
  const totalDels = files.reduce((sum, f) => sum + (f.deletions || 0), 0);
  const preview = files.slice(0, previewLimit);
  const remaining = files.length - preview.length;

  return (
    <section
      data-testid="pr-files-changed-card"
      className="flex min-h-0 shrink-0 flex-col overflow-hidden"
      style={floatingPane({ padding: 0, overflow: "hidden", ...(maxHeight != null ? { maxHeight } : {}) })}
    >
      <div className="flex shrink-0 items-center justify-between px-3 pb-1 pt-2.5">
        <span className="text-[11px] font-medium" style={{ color: COLORS.textMuted, fontFamily: SANS_FONT }}>
          {files.length} {files.length === 1 ? "file" : "files"} changed
        </span>
        {files.length && onOpenFilesTab ? (
          <button
            type="button"
            onClick={onOpenFilesTab}
            className="text-[11px]"
            style={{ color: COLORS.accent, fontFamily: SANS_FONT, background: "none", border: "none", cursor: "pointer" }}
          >
            View all
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1">
        {files.length ? (
          <div className="flex flex-col gap-1">
            <div className="mb-0.5 flex items-center gap-2 text-[11px]" style={{ fontFamily: MONO_FONT }}>
              <span style={{ color: COLORS.checkPass }}>+{totalAdds}</span>
              <span style={{ color: COLORS.danger }}>−{totalDels}</span>
            </div>
            {preview.map((file) => {
              const name = file.filename.split("/").pop() || file.filename;
              return (
                <button
                  key={file.filename}
                  type="button"
                  onClick={onOpenFilesTab}
                  className="flex items-center gap-2 rounded py-0.5 text-left transition-colors"
                  style={{ background: "none", border: "none", cursor: onOpenFilesTab ? "pointer" : "default" }}
                  title={file.filename}
                >
                  <span
                    className="min-w-0 flex-1 truncate text-[11px]"
                    style={{ color: COLORS.textSecondary, fontFamily: MONO_FONT }}
                  >
                    {name}
                  </span>
                  <span className="text-[10px]" style={{ color: COLORS.checkPass, fontFamily: MONO_FONT }}>
                    +{file.additions}
                  </span>
                  <span className="text-[10px]" style={{ color: COLORS.danger, fontFamily: MONO_FONT }}>
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
                style={{ color: COLORS.accent, fontFamily: SANS_FONT, background: "none", border: "none", cursor: "pointer" }}
              >
                +{remaining} more
              </button>
            ) : null}
          </div>
        ) : (
          <span className="text-[12px]" style={{ color: COLORS.textDim, fontFamily: SANS_FONT }}>
            No files
          </span>
        )}
      </div>
    </section>
  );
});

export default PrFilesChangedCard;
