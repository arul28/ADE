import React, { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Copy } from "@phosphor-icons/react";
import { MultiFileDiff, PatchDiff } from "@pierre/diffs/react";
import type { FileContents } from "@pierre/diffs/react";
import type { FileDiff, FilePatch } from "../../../shared/types";
import { MonacoDiffView, type MonacoDiffHandle } from "../lanes/MonacoDiffView";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { useAppearanceStore } from "../../state/appearanceStore";
import { cn } from "../ui/cn";
import { isWhitespaceOnlyTextDiff, stripWhitespaceOnlyPatchChanges, type WhitespaceFilteredPatch } from "./diffWhitespace";
import { readPersistedFlag, writePersistedFlag } from "./persistedFlag";
import { FLOATING_FIND_BAR_RESERVE_PX, FindBar } from "./FindBar";
import { useDiffFind } from "./useDiffFind";

export type AdeDiffViewerHandle = MonacoDiffHandle;

type DiffLayout = "split" | "unified";
type DiffOverflow = "scroll" | "wrap";

type AdeDiffViewerProps = {
  diff?: FileDiff | null;
  patch?: FilePatch | null;
  editable?: boolean;
  className?: string;
  /** The app theme when left out. */
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
  /* Find (⌘F) matches. The colours are index.css's variables, which inherit
     into this shadow root. */
  ::highlight(ade-find) {
    background-color: var(--ade-find-match);
  }
  ::highlight(ade-find-active) {
    background-color: var(--ade-find-current);
    color: var(--ade-find-current-fg);
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
    ...(on ? { border: `1px solid ${COLORS.accentBorder}`, background: "color-mix(in srgb, var(--color-accent) 8%, transparent)" } : {}),
    whiteSpace: "nowrap",
    flexShrink: 0,
    ...extra,
  });
}

/** One option of the Split | Unified segmented control: selected = fill. */
function segmentButton(on: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    height: 22,
    padding: "0 8px",
    fontSize: 11,
    fontWeight: 500,
    fontFamily: SANS_FONT,
    borderRadius: 5,
    border: "none",
    whiteSpace: "nowrap",
    cursor: "pointer",
    color: on ? COLORS.textPrimary : COLORS.textSecondary,
    background: on ? "color-mix(in srgb, var(--color-fg) 10%, transparent)" : "transparent",
  };
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

/** Pierre's line-count options: unchanged runs longer than the threshold collapse, and each expand click reveals this many lines. */
const COLLAPSED_CONTEXT_THRESHOLD = 12;
const EXPANSION_LINE_COUNT = 20;

type DiffOptions = ComponentProps<typeof PatchDiff>["options"];

/** What the viewer's body draws, decided from its inputs before any JSX. */
type DiffView =
  | { kind: "none" }
  | { kind: "binary"; path: string }
  | { kind: "whitespace-hidden" }
  | { kind: "patch"; patch: string }
  | { kind: "files"; oldFile: FileContents; newFile: FileContents }
  | { kind: "empty-patch"; path: string }
  | { kind: "no-text"; path: string };

type DiffViewInput = {
  binary: boolean;
  /** The view is a patch (not two whole files). */
  usesPatch: boolean;
  activePath: string;
  /** The patch as the renderer draws it; "" when there is none. */
  normalizedPatch: string;
  /** The patch with whitespace-only changes removed; null unless Ignore whitespace is on. */
  filteredPatch: WhitespaceFilteredPatch | null;
  /** The two files a non-patch view draws (possibly a truncated preview). */
  files: { old: FileContents; new: FileContents } | null;
  /** A patch view's complete files, drawn only while find needs its collapsed lines. */
  patchFullFiles: { old: FileContents; new: FileContents } | null;
  findExpandAll: boolean;
  whitespaceOnlyTextDiff: boolean;
  hasInlineDiffContent: boolean;
};

function resolveDiffView(input: DiffViewInput): DiffView {
  if (input.binary) return { kind: "binary", path: input.activePath };
  if (input.usesPatch) {
    // Not while Ignore whitespace hides a whitespace-only patch: the full files would show what the toggle hid.
    if (input.findExpandAll && input.patchFullFiles && !input.filteredPatch?.whitespaceOnly) {
      return { kind: "files", oldFile: input.patchFullFiles.old, newFile: input.patchFullFiles.new };
    }
    if (input.filteredPatch) {
      return input.filteredPatch.whitespaceOnly
        ? { kind: "whitespace-hidden" }
        : { kind: "patch", patch: input.filteredPatch.patch };
    }
    if (input.normalizedPatch) return { kind: "patch", patch: input.normalizedPatch };
    return { kind: "empty-patch", path: input.activePath };
  }
  if (!input.files) return { kind: "none" };
  if (input.whitespaceOnlyTextDiff) return { kind: "whitespace-hidden" };
  if (input.hasInlineDiffContent) return { kind: "files", oldFile: input.files.old, newFile: input.files.new };
  return { kind: "no-text", path: input.activePath };
}

function renderDiffView(view: DiffView, options: DiffOptions): ReactNode {
  switch (view.kind) {
    case "none":
      return <ViewerState title="No diff selected" />;
    case "binary":
      return <ViewerState title="Binary diff preview unavailable" detail={view.path} />;
    case "whitespace-hidden":
      return <ViewerState title="Whitespace-only changes hidden" detail="Turn off Whitespace to see them." />;
    case "patch":
      return <PatchDiff patch={view.patch} options={options} />;
    case "files":
      return <MultiFileDiff oldFile={view.oldFile} newFile={view.newFile} options={options} />;
    case "empty-patch":
      return <ViewerState title="No patch available" detail={view.path} />;
    case "no-text":
      return <ViewerState title="No text diff available" detail={view.path} />;
  }
}

export const AdeDiffViewer = forwardRef<AdeDiffViewerHandle, AdeDiffViewerProps>(function AdeDiffViewer(
  {
    diff,
    patch,
    editable = false,
    className,
    theme: themeProp,
    compact = false,
    showToolbar = true,
    persistKey,
  },
  ref,
) {
  // The app theme unless the caller picks one.
  const appTheme = useAppearanceStore((s) => s.theme);
  const theme = themeProp ?? appTheme;
  const monacoRef = useRef<MonacoDiffHandle | null>(null);
  const findRootRef = useRef<HTMLDivElement | null>(null);
  const findScrollRef = useRef<HTMLDivElement | null>(null);
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
  // The caller passed both sides complete: not binary, not truncated.
  const fullFilesAvailable = Boolean(
    diff
    && !diff.isBinary
    && !diff.original.isTruncated
    && !diff.modified.isTruncated
    && typeof diff.original.text === "string"
    && typeof diff.modified.text === "string",
  );
  // A patch carries only hunks; when the caller also has both files complete,
  // find can draw them to show a match in collapsed lines.
  const patchFullFiles = patch && fullFilesAvailable && diff
    ? { old: makeFileContents(diff.path, diff.original.text ?? "", "old"), new: makeFileContents(diff.path, diff.modified.text ?? "", "new") }
    : null;
  // What find compares the drawn lines against: a file-pair view's own text (a
  // truncated preview's drawn lines all come from it), or a patch's full files.
  const findSourceFiles = oldFile && newFile ? { old: oldFile, new: newFile } : patchFullFiles;
  const find = useDiffFind({
    rootRef: findRootRef,
    scrollRef: findScrollRef,
    fullText: findSourceFiles ? { old: findSourceFiles.old.contents, new: findSourceFiles.new.contents } : null,
  });
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
      collapsedContextThreshold: COLLAPSED_CONTEXT_THRESHOLD,
      expansionLineCount: EXPANSION_LINE_COUNT,
      // Find draws collapsed unchanged lines while it has a match in them.
      ...(find.expandAll ? { expandUnchanged: true } : {}),
      unsafeCSS: DIFF_UNSAFE_CSS,
      // Applies only when Pierre computes the diff from oldFile/newFile (the
      // chat turn diff panel); pre-parsed patches are filtered below.
      ...(ignoreWhitespace ? { parseDiffOptions: { ignoreWhitespace: true } } : {}),
    }) as const,
    [find.expandAll, ignoreWhitespace, layout, lineNumbers, overflow, theme],
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
  const view = resolveDiffView({
    binary,
    usesPatch: Boolean(patch),
    activePath,
    normalizedPatch,
    filteredPatch,
    files: oldFile && newFile ? { old: oldFile, new: newFile } : null,
    patchFullFiles,
    findExpandAll: find.expandAll,
    whitespaceOnlyTextDiff,
    hasInlineDiffContent,
  });

  return (
    <div
      ref={findRootRef}
      data-ade-find-scope="diff"
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
          {/* Split | Unified is one choice (a segmented control); Wrap, Lines
              and Whitespace are independent toggles, set apart by a divider. */}
          <div
            role="radiogroup"
            aria-label="Diff layout"
            className="inline-flex shrink-0 items-center gap-px rounded-[7px] p-px"
            style={{ border: `1px solid ${COLORS.outlineBorder}` }}
          >
            <button type="button" role="radio" aria-checked={layout === "split"} className={TOOLBAR_BUTTON_CLASS} style={segmentButton(layout === "split")} onClick={() => setLayout("split")}>
              Split
            </button>
            <button type="button" role="radio" aria-checked={layout === "unified"} className={TOOLBAR_BUTTON_CLASS} style={segmentButton(layout === "unified")} onClick={() => setLayout("unified")}>
              Unified
            </button>
          </div>
          <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-fg/[0.12]" />
          <button type="button" className={TOOLBAR_BUTTON_CLASS} style={toolbarButton(overflow === "wrap")} aria-pressed={overflow === "wrap"} onClick={() => setOverflow((value) => (value === "wrap" ? "scroll" : "wrap"))}>
            Wrap
          </button>
          <button type="button" className={TOOLBAR_BUTTON_CLASS} style={toolbarButton(lineNumbers)} aria-pressed={lineNumbers} onClick={() => setLineNumbers((value) => !value)}>
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
      <div className="relative flex min-h-0 flex-1 flex-col">
        {find.open ? <FindBar {...find.bar} placeholder="Find in diff" /> : null}
        {/* While find is open the bar floats over the top: room for it, so it never covers line 1. */}
        <div
          ref={findScrollRef}
          className="min-h-0 flex-1 overflow-auto"
          style={{ paddingTop: find.open ? FLOATING_FIND_BAR_RESERVE_PX : undefined }}
        >
          {renderDiffView(view, options)}
        </div>
      </div>
    </div>
  );
});
