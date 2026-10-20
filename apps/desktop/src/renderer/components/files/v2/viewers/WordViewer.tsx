import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { ListBullets, TextT } from "@phosphor-icons/react";
import { COLORS, fgTint } from "../../../lanes/laneDesignTokens";
import { openUrlInAdeBrowser } from "../../../../lib/openExternal";
import { Banner } from "../../../ui/notice";
import type { WordBlock, WordDocument } from "./office/docx";
import { OoxmlPreviewShell } from "./OoxmlPreviewShell";
import { ViewerModeToggleButton } from "./ViewerModeToggle";
import { readViewerMode, rememberViewerMode } from "./viewerModeMemory";
import {
  bookmarkElementId,
  PAGE_BACKGROUND,
  PAGE_INK,
  PAGE_SHADOW,
  WordBlockProvider,
  WordBlockView,
  type WordBlockContext,
} from "./WordBlocks";
import { ZoomControls } from "./ZoomControls";
import type { ViewerProps } from "./types";

/** The shell rejects larger files before streaming them into the reader. */
const MAX_WORD_STREAM_BYTES = 25 * 1024 * 1024;
/** Images decoded per document; the rest show their placeholder. */
const MAX_LOADED_IMAGES = 160;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.1;

type Mode = "page" | "outline";
type StoredMode = Mode | "page-outline";
type View = { mode: Mode; outlineOpen: boolean };
/** `"fit"` follows the pane width; a number is a fixed zoom. */
type Zoom = number | "fit";

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function viewFromStored(stored: StoredMode): View {
  return {
    mode: stored === "outline" ? "outline" : "page",
    outlineOpen: stored === "page-outline",
  };
}

function storedFromView(view: View): StoredMode {
  return view.mode === "page" && view.outlineOpen ? "page-outline" : view.mode;
}

/** Every image path in the blocks, table cells included, up to `limit`. */
function collectImagePaths(
  blocks: WordBlock[],
  into: Set<string>,
  limit: number,
): Set<string> {
  for (const block of blocks) {
    if (into.size >= limit) break;
    if (block.kind === "image" && block.path) into.add(block.path);
    else if (block.kind === "table")
      for (const row of block.rows)
        for (const cell of row.cells)
          collectImagePaths(cell.blocks, into, limit);
  }
  return into;
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Native WordprocessingML preview, loaded only when a `.docx` file is opened. */
export function WordViewer(props: ViewerProps) {
  const { files, workspaceId, tab, rootPath, content } = props;

  return (
    <OoxmlPreviewShell<WordDocument>
      files={files}
      workspaceId={workspaceId}
      path={tab.path}
      byteCap={MAX_WORD_STREAM_BYTES}
      declaredSize={content.totalSize ?? content.size}
      loadingLabel={`Loading ${tab.title}…`}
      fallback={{
        rootPath,
        title: tab.title,
        mimeType: content.mimeType ?? null,
        size: content.size,
      }}
      load={async (bytes) => {
        const { openDocx } = await import("./office/docx");
        return openDocx(bytes);
      }}
    >
      {(document) => <DocumentReader document={document} tabId={tab.id} />}
    </OoxmlPreviewShell>
  );
}

function DocumentReader({
  document,
  tabId,
}: {
  document: WordDocument;
  tabId: string;
}) {
  const [view, setViewState] = useState<View>(() =>
    viewFromStored(readViewerMode<StoredMode>(tabId, "page")),
  );
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [fitScale, setFitScale] = useState(1);
  const [currentHeading, setCurrentHeading] = useState<string | null>(null);
  const [mediaUrls, setMediaUrls] = useState<Map<string, string>>(new Map());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const headingNodes = useRef(new Map<string, HTMLElement>());
  // Element ids are scoped to this reader: two open documents (or a heading
  // and a bookmark of the same name) never share one.
  const idScope = `word-${useId().replace(/:/g, "")}`;

  const scale = zoom === "fit" ? fitScale : zoom;
  const { mode, outlineOpen } = view;

  const updateView = (next: View) => {
    rememberViewerMode(tabId, storedFromView(next));
    setViewState(next);
  };

  const zoomBy = (delta: number) => setZoom(clampZoom(scale + delta));

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const updateFitScale = () => {
      const availableWidth = Math.max(120, element.clientWidth - 20);
      setFitScale(Math.min(1, availableWidth / document.pageWidthPx));
    };

    updateFitScale();
    const observer = new ResizeObserver(updateFitScale);
    observer.observe(element);
    return () => observer.disconnect();
  }, [document.pageWidthPx]);

  useEffect(() => {
    const paths = collectImagePaths(
      document.blocks,
      new Set(),
      MAX_LOADED_IMAGES,
    );
    let cancelled = false;
    const createdUrls: string[] = [];

    const loadImages = async () => {
      const nextUrls = new Map<string, string>();

      for (const path of paths) {
        const media = await document
          .loadMedia(path)
          .catch((error: unknown) => {
            // Past the media cap or unreadable: the block keeps its placeholder.
            console.warn("[files.word_preview] image not loaded", {
              path,
              reason: errorReason(error),
            });
            return null;
          });
        if (cancelled) return;
        if (!media) continue;

        const url = URL.createObjectURL(
          new Blob([media.bytes], { type: media.mimeType }),
        );
        createdUrls.push(url);
        nextUrls.set(path, url);
      }

      if (!cancelled) setMediaUrls(nextUrls);
    };

    void loadImages();
    return () => {
      cancelled = true;
      createdUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [document]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || typeof IntersectionObserver !== "function") return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visibleHeadings = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const headingId =
          visibleHeadings[0]?.target.getAttribute("data-heading-id");
        if (headingId) setCurrentHeading(headingId);
      },
      { root, rootMargin: "-12% 0px -72% 0px", threshold: 0 },
    );

    headingNodes.current.forEach((heading) => observer.observe(heading));
    return () => observer.disconnect();
  }, [document, mode, outlineOpen]);

  const registerHeading = useCallback(
    (id: string, node: HTMLElement | null) => {
      if (node) {
        headingNodes.current.set(id, node);
      } else {
        headingNodes.current.delete(id);
      }
    },
    [],
  );

  const followBookmark = useCallback(
    (encodedName: string) => {
      let target: Element | null | undefined;
      try {
        const id = bookmarkElementId(idScope, decodeURIComponent(encodedName));
        target = scrollRef.current?.querySelector(`[id="${CSS.escape(id)}"]`);
      } catch (error) {
        // A malformed bookmark is inert; it must not interrupt reading.
        console.warn("[files.word_preview] internal link not followed", {
          bookmark: encodedName,
          reason: errorReason(error),
        });
        return;
      }
      if (!target) {
        console.warn("[files.word_preview] internal link not followed", {
          bookmark: encodedName,
          reason: "no bookmark with this name",
        });
        return;
      }
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    [idScope],
  );

  const blockContext = useMemo<WordBlockContext>(
    () => ({
      scale,
      mediaUrls,
      idScope,
      registerHeading,
      onOpenLink: openUrlInAdeBrowser,
      onFollowBookmark: followBookmark,
    }),
    [scale, mediaUrls, idScope, registerHeading, followBookmark],
  );

  const goToHeading = (id: string) => {
    updateView({ ...view, mode: "page" });
    requestAnimationFrame(() => {
      headingNodes.current
        .get(id)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    setCurrentHeading(id);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;

    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomBy(ZOOM_STEP);
    } else if (event.key === "-") {
      event.preventDefault();
      zoomBy(-ZOOM_STEP);
    } else if (event.key === "0") {
      event.preventDefault();
      setZoom("fit");
    }
  };

  const notices = describeNotices(document);
  const pageCount = Math.max(
    1,
    1 + document.blocks.filter((block) => block.kind === "pageBreak").length,
  );
  const noticeTitle = [
    notices,
    document.truncated
      ? `Showing the first ${document.blocks.length.toLocaleString()} blocks.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-label="Word document preview"
    >
      <WordToolbar
        mode={mode}
        outlineOpen={outlineOpen}
        scale={scale}
        fitActive={zoom === "fit"}
        wordCount={document.wordCount}
        pageCount={pageCount}
        onSelectMode={(next) => updateView({ ...view, mode: next })}
        onToggleOutline={() =>
          updateView({ ...view, outlineOpen: !outlineOpen })
        }
        onZoomOut={() => zoomBy(-ZOOM_STEP)}
        onZoomIn={() => zoomBy(ZOOM_STEP)}
        onFit={() => setZoom("fit")}
      />

      {noticeTitle ? (
        <Banner
          layout="inline"
          model={{
            id: "word-preview-notices",
            tone: document.truncated ? "info" : "neutral",
            title: noticeTitle,
          }}
          style={{ margin: "6px 8px 0" }}
        />
      ) : null}

      <div className="flex min-h-0 flex-1">
        {outlineOpen ? (
          <OutlineRail
            headings={document.headings}
            activeId={currentHeading}
            onSelect={goToHeading}
          />
        ) : null}
        <WordBlockProvider value={blockContext}>
          <DocumentCanvas
            ref={scrollRef}
            document={document}
            mode={mode}
            scale={scale}
            currentHeading={currentHeading}
            onSelectHeading={goToHeading}
          />
        </WordBlockProvider>
      </div>
    </div>
  );
}

function WordToolbar({
  mode,
  outlineOpen,
  scale,
  fitActive,
  wordCount,
  pageCount,
  onSelectMode,
  onToggleOutline,
  onZoomOut,
  onZoomIn,
  onFit,
}: {
  mode: Mode;
  outlineOpen: boolean;
  scale: number;
  fitActive: boolean;
  wordCount: number;
  pageCount: number;
  onSelectMode: (mode: Mode) => void;
  onToggleOutline: () => void;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFit: () => void;
}) {
  return (
    <div
      className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-2 py-1"
      style={{ borderColor: COLORS.border }}
    >
      <TextT size={14} style={{ color: COLORS.textDim }} />
      <span
        className="min-w-0 flex-1 truncate text-xs"
        style={{ color: COLORS.textMuted }}
      >
        {wordCount.toLocaleString()} words · about {pageCount} page
        {pageCount === 1 ? "" : "s"}
      </span>
      <button
        type="button"
        onClick={onToggleOutline}
        aria-pressed={outlineOpen}
        aria-label="Toggle outline"
        title="Toggle outline"
        className="rounded p-1.5"
        style={{
          color: outlineOpen ? COLORS.textPrimary : COLORS.textDim,
          background: outlineOpen ? fgTint(8) : "transparent",
        }}
      >
        <ListBullets size={14} />
      </button>
      <ViewerModeToggleButton
        active={mode === "page"}
        onClick={() => onSelectMode("page")}
        icon={<TextT size={13} />}
        label="Page"
      />
      <ViewerModeToggleButton
        active={mode === "outline"}
        onClick={() => onSelectMode("outline")}
        icon={<ListBullets size={13} />}
        label="Outline"
      />
      <div
        className="flex items-center gap-0.5 border-l pl-1"
        style={{ borderColor: COLORS.border }}
      >
        <ZoomControls
          percent={scale * 100}
          onZoomOut={onZoomOut}
          onZoomIn={onZoomIn}
          onFit={onFit}
          fitActive={fitActive}
        />
      </div>
    </div>
  );
}

const DocumentCanvas = React.forwardRef<
  HTMLDivElement,
  {
    document: WordDocument;
    mode: Mode;
    scale: number;
    currentHeading: string | null;
    onSelectHeading: (id: string) => void;
  }
>(function DocumentCanvas(
  { document, mode, scale, currentHeading, onSelectHeading },
  ref,
) {
  const pagePadding = [
    document.marginsPx.top,
    document.marginsPx.right,
    document.marginsPx.bottom,
    document.marginsPx.left,
  ]
    .map((margin) => `${margin * scale}px`)
    .join(" ");

  return (
    <div
      ref={ref}
      className="min-h-0 min-w-0 flex-1 overflow-auto"
      style={{ background: fgTint(3) }}
    >
      <div
        className="mx-auto my-5"
        style={{
          width: `${document.pageWidthPx * scale}px`,
          maxWidth: "calc(100% - 20px)",
        }}
      >
        {mode === "outline" ? (
          <OutlineDocument
            headings={document.headings}
            blocks={document.blocks}
            activeId={currentHeading}
            onSelect={onSelectHeading}
          />
        ) : (
          <article
            className="min-h-[60vh]"
            style={{
              width: "100%",
              minHeight: `${document.pageHeightPx * scale}px`,
              background: PAGE_BACKGROUND,
              color: PAGE_INK,
              boxShadow: PAGE_SHADOW,
              padding: pagePadding,
              boxSizing: "border-box",
              fontSize: `${16 * scale}px`,
              lineHeight: 1.45,
            }}
          >
            {document.blocks.map((block, index) => (
              <WordBlockView key={index} block={block} />
            ))}
          </article>
        )}
      </div>
    </div>
  );
});

function OutlineRail({
  headings,
  activeId,
  onSelect,
}: {
  headings: WordDocument["headings"];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <aside
      className="w-48 shrink-0 overflow-auto border-r p-2"
      style={{ borderColor: COLORS.border, background: fgTint(2) }}
      aria-label="Document outline"
    >
      <div
        className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wide"
        style={{ color: COLORS.textDim }}
      >
        Outline
      </div>
      {headings.length ? (
        headings.map((heading) => (
          <button
            key={heading.id}
            type="button"
            onClick={() => onSelect(heading.id)}
            className="mb-0.5 block w-full rounded px-2 py-1 text-left text-xs"
            style={{
              paddingLeft: `${8 + (heading.level - 1) * 10}px`,
              background: activeId === heading.id ? fgTint(9) : "transparent",
              color:
                activeId === heading.id ? COLORS.textPrimary : COLORS.textMuted,
            }}
          >
            {heading.text}
          </button>
        ))
      ) : (
        <p className="px-2 text-xs" style={{ color: COLORS.textDim }}>
          No headings in this document.
        </p>
      )}
    </aside>
  );
}

function OutlineDocument({
  headings,
  blocks,
  activeId,
  onSelect,
}: {
  headings: WordDocument["headings"];
  blocks: WordBlock[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div
      className="rounded-lg border p-4"
      style={{ borderColor: COLORS.border, background: COLORS.cardBgSolid }}
    >
      {headings.length ? (
        headings.map((heading) => {
          const block = blocks[heading.blockIndex];

          return (
            <button
              key={heading.id}
              type="button"
              onClick={() => onSelect(heading.id)}
              className="mb-1 block w-full rounded px-2 py-1 text-left"
              style={{
                paddingLeft: `${8 + (heading.level - 1) * 14}px`,
                background: activeId === heading.id ? fgTint(8) : "transparent",
                color: COLORS.textPrimary,
              }}
            >
              <span className="text-xs font-medium">
                {block?.kind === "paragraph"
                  ? block.runs.map((run) => run.text).join("")
                  : heading.text}
              </span>
            </button>
          );
        })
      ) : (
        <p className="text-xs" style={{ color: COLORS.textDim }}>
          No headings in this document.
        </p>
      )}
    </div>
  );
}

function describeNotices(document: WordDocument): string | null {
  const { notices } = document;
  const entries: Array<[number, string]> = [
    [notices.charts, "chart"],
    [notices.textBoxes, "text box"],
    [notices.shapes, "shape"],
    [notices.footnotes, "footnote"],
    [notices.endnotes, "endnote"],
    [notices.comments, "comment"],
    [notices.headers, "header"],
    [notices.footers, "footer"],
    [notices.unsupportedImages, "image"],
    [notices.trimmedTables, "trimmed table"],
  ];
  const parts = entries
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}${count === 1 ? "" : "s"}`);

  return parts.length
    ? `Not shown in this preview: ${parts.join(", ")}.`
    : null;
}
