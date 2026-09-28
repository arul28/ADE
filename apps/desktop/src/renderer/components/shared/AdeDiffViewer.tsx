import React, { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Copy } from "@phosphor-icons/react";
import { MultiFileDiff, PatchDiff } from "@pierre/diffs/react";
import type { FileContents } from "@pierre/diffs/react";
import type { FileDiff, FilePatch } from "../../../shared/types";
import { MonacoDiffView, type MonacoDiffHandle } from "../lanes/MonacoDiffView";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { cn } from "../ui/cn";
import { isWhitespaceOnlyTextDiff, stripWhitespaceOnlyPatchChanges } from "./diffWhitespace";
import { readPersistedFlag, writePersistedFlag } from "./persistedFlag";

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
  /**
   * Stable per-view id. When set, the Ignore-whitespace toggle is remembered
   * under `ade:diff:ignoreWhitespace:<persistKey>` across mounts, like a view
   * preference; without it the toggle is local to the instance and defaults off.
   */
  persistKey?: string;
};

const IGNORE_WHITESPACE_STORAGE_PREFIX = "ade:diff:ignoreWhitespace:";

function readPersistedIgnoreWhitespace(key: string | undefined): boolean {
  return readPersistedFlag(IGNORE_WHITESPACE_STORAGE_PREFIX, key);
}

function writePersistedIgnoreWhitespace(key: string | undefined, value: boolean): void {
  writePersistedFlag(IGNORE_WHITESPACE_STORAGE_PREFIX, key, value);
}

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

/** Tighter button padding when the toolbar itself is narrow. */
const TOOLBAR_BUTTON_CLASS = "@max-[340px]:px-[5px]!";

/** A toolbar toggle: accent text when on, never wrapping or shrinking. */
function toolbarButton(on: boolean, extra?: React.CSSProperties): React.CSSProperties {
  return outlineButton({
    height: 24,
    padding: "0 8px",
    fontSize: 11,
    borderRadius: 6,
    color: on ? COLORS.accent : COLORS.textSecondary,
    whiteSpace: "nowrap",
    flexShrink: 0,
    ...extra,
  });
}

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
    persistKey,
  },
  ref,
) {
  const monacoRef = useRef<MonacoDiffHandle | null>(null);
  const [layout, setLayout] = useState<DiffLayout>("split");
  const [overflow, setOverflow] = useState<DiffOverflow>("scroll");
  const [lineNumbers, setLineNumbers] = useState(true);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(() => readPersistedIgnoreWhitespace(persistKey));
  const toggleIgnoreWhitespace = useCallback(() => {
    setIgnoreWhitespace((value) => {
      const next = !value;
      writePersistedIgnoreWhitespace(persistKey, next);
      return next;
    });
  }, [persistKey]);

  useImperativeHandle(ref, () => ({
    getModifiedValue: () => monacoRef.current?.getModifiedValue() ?? null,
    revealLineInCenter: (line: number) => {
      monacoRef.current?.revealLineInCenter(line);
    },
  }));

  const activePath = patch?.path ?? diff?.path ?? "";
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
      // Applies only when Pierre computes the diff from oldFile/newFile (the
      // chat turn diff panel); pre-parsed patches are filtered below.
      ...(ignoreWhitespace ? { parseDiffOptions: { ignoreWhitespace: true } } : {}),
    }) as const,
    [ignoreWhitespace, layout, lineNumbers, overflow, theme],
  );
  const filteredPatch = useMemo(
    () => (ignoreWhitespace && normalizedPatch ? stripWhitespaceOnlyPatchChanges(normalizedPatch) : null),
    [ignoreWhitespace, normalizedPatch],
  );
  const whitespaceOnlyTextDiff = ignoreWhitespace && oldFile && newFile
    ? isWhitespaceOnlyTextDiff(oldFile.contents, newFile.contents)
    : false;

  if (editable && diff) {
    return <MonacoDiffView ref={monacoRef} diff={diff} editable className={className} theme={theme} />;
  }

  const binary = Boolean(patch?.isBinary || diff?.isBinary);
  const truncated = Boolean(patch?.isTruncated || diff?.original.isTruncated || diff?.modified.isTruncated);

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
        // One line at any width: labels never wrap, the bar scrolls sideways
        // if it has to, and "Copy path" drops to its icon in narrow panes.
        <div
          className="@container flex shrink-0 flex-nowrap items-center gap-1 overflow-x-auto border-b border-border [scrollbar-width:none]"
          style={{ minHeight: compact ? 30 : 34, padding: compact ? "3px 6px" : "4px 8px", background: COLORS.recessedBg }}
        >
          <button type="button" className={TOOLBAR_BUTTON_CLASS} style={toolbarButton(layout === "split")} onClick={() => setLayout("split")}>
            Split
          </button>
          <button type="button" className={TOOLBAR_BUTTON_CLASS} style={toolbarButton(layout === "unified")} onClick={() => setLayout("unified")}>
            Unified
          </button>
          <button type="button" className={TOOLBAR_BUTTON_CLASS} style={toolbarButton(overflow === "wrap")} onClick={() => setOverflow((value) => (value === "wrap" ? "scroll" : "wrap"))}>
            Wrap
          </button>
          <button type="button" className={TOOLBAR_BUTTON_CLASS} style={toolbarButton(lineNumbers)} onClick={() => setLineNumbers((value) => !value)}>
            Lines
          </button>
          <button
            type="button"
            className={TOOLBAR_BUTTON_CLASS}
            style={toolbarButton(ignoreWhitespace)}
            title="Ignore whitespace-only changes"
            aria-label="Ignore whitespace-only changes"
            aria-pressed={ignoreWhitespace}
            onClick={toggleIgnoreWhitespace}
          >
            Whitespace
          </button>
          {activePath ? (
            <button
              type="button"
              className={TOOLBAR_BUTTON_CLASS}
              style={toolbarButton(false, { marginLeft: "auto", gap: 5 })}
              onClick={() => copyText(activePath)}
              title={`Copy path: ${activePath}`}
              aria-label="Copy path"
            >
              <Copy size={12} aria-hidden />
              <span className="hidden @[400px]:inline">Copy path</span>
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
          ignoreWhitespace && filteredPatch ? (
            filteredPatch.whitespaceOnly ? (
              <ViewerState title="Whitespace-only changes hidden" detail="Turn off Whitespace to see them." />
            ) : (
              <PatchDiff patch={filteredPatch.patch} options={options} />
            )
          ) : normalizedPatch ? (
            <PatchDiff patch={normalizedPatch} options={options} />
          ) : (
            <ViewerState title="No patch available" detail={activePath} />
          )
        ) : oldFile && newFile ? (
          whitespaceOnlyTextDiff ? (
            <ViewerState title="Whitespace-only changes hidden" detail="Turn off Whitespace to see them." />
          ) : hasInlineDiffContent ? (
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
