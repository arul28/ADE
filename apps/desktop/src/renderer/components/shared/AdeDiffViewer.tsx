import React, { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import { MultiFileDiff, PatchDiff } from "@pierre/diffs/react";
import type { FileContents } from "@pierre/diffs/react";
import type { FileDiff, FilePatch } from "../../../shared/types";
import { MonacoDiffView, type MonacoDiffHandle } from "../lanes/MonacoDiffView";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { cn } from "../ui/cn";

export type AdeDiffViewerHandle = MonacoDiffHandle;

type DiffLayout = "split" | "unified";
type DiffOverflow = "scroll" | "wrap";

type AdeDiffViewerProps = {
  diff?: FileDiff | null;
  patch?: FilePatch | null;
  editable?: boolean;
  className?: string;
  theme?: "dark" | "light";
  compact?: boolean;
  showToolbar?: boolean;
};

const DIFF_UNSAFE_CSS = `
  [data-diffs-header="default"] {
    display: none;
  }
  [data-code] {
    scrollbar-width: thin;
  }
  [data-diff],
  [data-file] {
    border-radius: 0;
  }
`;

function makeFileContents(path: string, contents: string, suffix: string): FileContents {
  return {
    name: path,
    contents,
    cacheKey: `${path}:${suffix}:${contents.length}`,
  };
}

function normalizePatchForRenderer(patch: FilePatch): string {
  const text = patch.patch.trimEnd();
  if (!text) return "";
  if (text.startsWith("diff --git ") || text.startsWith("--- ")) return text;

  const oldPath = patch.oldPath ?? patch.path;
  const oldHeader = patch.status === "added" ? "/dev/null" : `a/${oldPath}`;
  const newHeader = patch.status === "deleted" ? "/dev/null" : `b/${patch.path}`;
  return [`diff --git a/${oldPath} b/${patch.path}`, `--- ${oldHeader}`, `+++ ${newHeader}`, text].join("\n");
}

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {
    // Clipboard write is best-effort from an explicit user click.
  });
}

function ViewerState({
  title,
  detail,
}: {
  title: string;
  detail?: string;
}) {
  return (
    <div className="flex h-full w-full items-center justify-center p-4">
      <div style={{ maxWidth: 420, textAlign: "center" }}>
        <div style={{ fontFamily: SANS_FONT, fontSize: 13, color: COLORS.textSecondary }}>{title}</div>
        {detail ? (
          <div style={{ marginTop: 6, fontFamily: MONO_FONT, fontSize: 11, lineHeight: 1.5, color: COLORS.textDim }}>
            {detail}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const AdeDiffViewer = forwardRef<AdeDiffViewerHandle, AdeDiffViewerProps>(function AdeDiffViewer(
  {
    diff,
    patch,
    editable = false,
    className,
    theme = "dark",
    compact = false,
    showToolbar = true,
  },
  ref,
) {
  const monacoRef = useRef<MonacoDiffHandle | null>(null);
  const [layout, setLayout] = useState<DiffLayout>("split");
  const [overflow, setOverflow] = useState<DiffOverflow>("scroll");
  const [lineNumbers, setLineNumbers] = useState(true);

  useImperativeHandle(ref, () => ({
    getModifiedValue: () => monacoRef.current?.getModifiedValue() ?? null,
    revealLineInCenter: (line: number) => {
      monacoRef.current?.revealLineInCenter(line);
    },
  }));

  const activePath = patch?.path ?? diff?.path ?? "";
  const options = useMemo(
    () => ({
      theme: theme === "light" ? "pierre-light" : "pierre-dark",
      themeType: theme,
      diffStyle: layout,
      overflow,
      disableLineNumbers: !lineNumbers,
      hunkSeparators: "line-info-basic",
      lineDiffType: "word",
      collapsedContextThreshold: 12,
      expansionLineCount: 20,
      unsafeCSS: DIFF_UNSAFE_CSS,
    }) as const,
    [layout, lineNumbers, overflow, theme],
  );

  if (editable && diff) {
    return <MonacoDiffView ref={monacoRef} diff={diff} editable className={className} theme={theme} />;
  }

  const binary = Boolean(patch?.isBinary || diff?.isBinary);
  const truncated = Boolean(patch?.isTruncated || diff?.original.isTruncated || diff?.modified.isTruncated);
  const normalizedPatch = patch ? normalizePatchForRenderer(patch) : "";
  const oldFile = diff && !patch ? makeFileContents(diff.path, diff.original.text ?? "", "old") : null;
  const newFile = diff && !patch ? makeFileContents(diff.path, diff.modified.text ?? "", "new") : null;
  const hasInlineDiffContent = Boolean(
    oldFile
    && newFile
    && (
      (diff?.original.text ?? "").length > 0
      || (diff?.modified.text ?? "").length > 0
    ),
  );

  return (
    <div
      className={cn("flex h-full min-h-0 w-full flex-col overflow-hidden rounded-lg border border-border bg-card/60", className)}
      style={{
        ["--diffs-font-family" as string]: MONO_FONT,
        ["--diffs-header-font-family" as string]: SANS_FONT,
        ["--diffs-font-size" as string]: compact ? "12px" : "13px",
        ["--diffs-line-height" as string]: compact ? "18px" : "20px",
        ["--diffs-dark-bg" as string]: "transparent",
        ["--diffs-light-bg" as string]: "transparent",
      }}
    >
      {showToolbar ? (
        <div
          className="flex shrink-0 items-center gap-1 border-b border-border"
          style={{ minHeight: compact ? 30 : 34, padding: compact ? "3px 6px" : "4px 8px", background: COLORS.recessedBg }}
        >
          <button type="button" style={outlineButton({ height: 24, padding: "0 8px", fontSize: 11, borderRadius: 6, color: layout === "split" ? COLORS.accent : COLORS.textSecondary })} onClick={() => setLayout("split")}>
            Split
          </button>
          <button type="button" style={outlineButton({ height: 24, padding: "0 8px", fontSize: 11, borderRadius: 6, color: layout === "unified" ? COLORS.accent : COLORS.textSecondary })} onClick={() => setLayout("unified")}>
            Unified
          </button>
          <button type="button" style={outlineButton({ height: 24, padding: "0 8px", fontSize: 11, borderRadius: 6, color: overflow === "wrap" ? COLORS.accent : COLORS.textSecondary })} onClick={() => setOverflow((value) => (value === "wrap" ? "scroll" : "wrap"))}>
            Wrap
          </button>
          <button type="button" style={outlineButton({ height: 24, padding: "0 8px", fontSize: 11, borderRadius: 6, color: lineNumbers ? COLORS.accent : COLORS.textSecondary })} onClick={() => setLineNumbers((value) => !value)}>
            Lines
          </button>
          {activePath ? (
            <button type="button" style={outlineButton({ height: 24, padding: "0 8px", fontSize: 11, borderRadius: 6, marginLeft: "auto" })} onClick={() => copyText(activePath)}>
              Copy path
            </button>
          ) : null}
        </div>
      ) : null}
      {truncated ? (
        <div style={{ padding: "5px 8px", borderBottom: `1px solid ${COLORS.border}`, fontFamily: MONO_FONT, fontSize: 11, color: COLORS.warning }}>
          Preview is truncated.
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        {binary ? (
          <ViewerState title="Binary diff preview unavailable" detail={activePath} />
        ) : patch ? (
          normalizedPatch ? (
            <PatchDiff patch={normalizedPatch} options={options} />
          ) : (
            <ViewerState title="No patch available" detail={activePath} />
          )
        ) : oldFile && newFile ? (
          hasInlineDiffContent ? (
            <MultiFileDiff oldFile={oldFile} newFile={newFile} options={options} />
          ) : (
            <ViewerState title="No text diff available" detail={activePath} />
          )
        ) : (
          <ViewerState title="No diff selected" />
        )}
      </div>
    </div>
  );
});
