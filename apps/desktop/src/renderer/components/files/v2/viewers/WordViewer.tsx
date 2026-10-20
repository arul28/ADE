import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowsOut,
  ListBullets,
  Minus,
  Plus,
  TextT,
} from "@phosphor-icons/react";
import { COLORS, fgTint } from "../../../lanes/laneDesignTokens";
import { openUrlInAdeBrowser } from "../../../../lib/openExternal";
import type {
  WordBlock,
  WordDocument,
  WordParagraph,
  WordRun,
  WordTable,
} from "./office/docx";
import { OoxmlPreviewShell } from "./OoxmlPreviewShell";
import { ViewerModeToggleButton } from "./ViewerModeToggle";
import { readViewerMode, rememberViewerMode } from "./viewerModeMemory";
import type { ViewerProps } from "./types";

/** The shell rejects larger files before streaming them into the reader. */
const MAX_WORD_STREAM_BYTES = 25 * 1024 * 1024;
const PAGE_SHADOW = "0 2px 12px rgba(0,0,0,.14), 0 16px 38px rgba(0,0,0,.12)";

type Mode = "page" | "outline";
type StoredMode = Mode | "page-outline";

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
  const [storedMode, setStoredMode] = useState<StoredMode>(() =>
    readViewerMode<StoredMode>(tabId, "page"),
  );
  const mode: Mode = storedMode === "outline" ? "outline" : "page";
  const [outlineOpen, setOutlineOpen] = useState(storedMode === "page-outline");
  const [zoom, setZoom] = useState(1);
  const [fitToWidth, setFitToWidth] = useState(true);
  const [fitScale, setFitScale] = useState(1);
  const [currentHeading, setCurrentHeading] = useState<string | null>(null);
  const [mediaUrls, setMediaUrls] = useState<Map<string, string>>(new Map());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const headingNodes = useRef(new Map<string, HTMLElement>());

  const scale = fitToWidth ? fitScale : zoom;

  const setView = (next: Mode) => {
    const nextStoredMode =
      next === "page" && outlineOpen ? "page-outline" : next;
    rememberViewerMode(tabId, nextStoredMode);
    setStoredMode(nextStoredMode);
  };

  const setOutlineRail = (open: boolean) => {
    setOutlineOpen(open);
    const nextStoredMode = mode === "page" && open ? "page-outline" : mode;
    rememberViewerMode(tabId, nextStoredMode);
    setStoredMode(nextStoredMode);
  };

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
    const imagePaths = document.blocks.flatMap((block) =>
      block.kind === "image" && block.path ? [block.path] : [],
    );
    const paths = Array.from(new Set(imagePaths)).slice(0, 160);
    let cancelled = false;
    const createdUrls: string[] = [];

    const loadImages = async () => {
      const nextUrls = new Map<string, string>();

      for (const path of paths) {
        const media = await document.loadMedia(path).catch(() => null);
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

  const goToHeading = (id: string) => {
    setView("page");
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
      setFitToWidth(false);
      setZoom((value) => Math.min(2, value + 0.1));
    } else if (event.key === "-") {
      event.preventDefault();
      setFitToWidth(false);
      setZoom((value) => Math.max(0.5, value - 0.1));
    } else if (event.key === "0") {
      event.preventDefault();
      setFitToWidth(true);
    }
  };

  const notices = describeNotices(document);
  const pageCount = Math.max(
    1,
    1 + document.blocks.filter((block) => block.kind === "pageBreak").length,
  );

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
        fitToWidth={fitToWidth}
        zoom={zoom}
        wordCount={document.wordCount}
        pageCount={pageCount}
        onSelectMode={setView}
        onToggleOutline={() => setOutlineRail(!outlineOpen)}
        onZoomOut={() => {
          setFitToWidth(false);
          setZoom((value) => Math.max(0.5, value - 0.1));
        }}
        onFitWidth={() => setFitToWidth(true)}
        onZoomIn={() => {
          setFitToWidth(false);
          setZoom((value) => Math.min(2, value + 0.1));
        }}
        onZoom100={() => {
          setFitToWidth(false);
          setZoom(1);
        }}
      />

      {notices || document.truncated ? (
        <NoticeStrip
          notices={notices}
          truncated={document.truncated}
          blockCount={document.blocks.length}
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
        <DocumentCanvas
          ref={scrollRef}
          document={document}
          mode={mode}
          scale={scale}
          mediaUrls={mediaUrls}
          currentHeading={currentHeading}
          registerHeading={registerHeading}
          onSelectHeading={goToHeading}
        />
      </div>
    </div>
  );
}

function WordToolbar({
  mode,
  outlineOpen,
  fitToWidth,
  zoom,
  wordCount,
  pageCount,
  onSelectMode,
  onToggleOutline,
  onZoomOut,
  onFitWidth,
  onZoomIn,
  onZoom100,
}: {
  mode: Mode;
  outlineOpen: boolean;
  fitToWidth: boolean;
  zoom: number;
  wordCount: number;
  pageCount: number;
  onSelectMode: (mode: Mode) => void;
  onToggleOutline: () => void;
  onZoomOut: () => void;
  onFitWidth: () => void;
  onZoomIn: () => void;
  onZoom100: () => void;
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
        <button
          type="button"
          onClick={onZoomOut}
          aria-label="Zoom out"
          className="rounded p-1 hover:bg-fg/5"
        >
          <Minus size={13} />
        </button>
        <button
          type="button"
          onClick={onFitWidth}
          title="Fit width"
          className="min-w-12 rounded px-1 py-0.5 text-[10px]"
          style={{ color: COLORS.textMuted }}
        >
          {fitToWidth ? "Fit" : `${Math.round(zoom * 100)}%`}
        </button>
        <button
          type="button"
          onClick={onZoomIn}
          aria-label="Zoom in"
          className="rounded p-1 hover:bg-fg/5"
        >
          <Plus size={13} />
        </button>
        <button
          type="button"
          onClick={onZoom100}
          aria-label="100% zoom"
          title="100%"
          className="rounded p-1 hover:bg-fg/5"
        >
          <ArrowsOut size={13} />
        </button>
      </div>
    </div>
  );
}

function NoticeStrip({
  notices,
  truncated,
  blockCount,
}: {
  notices: string | null;
  truncated: boolean;
  blockCount: number;
}) {
  const lines = [
    notices,
    truncated
      ? `Showing the first ${blockCount.toLocaleString()} blocks.`
      : null,
  ].filter(Boolean);

  return (
    <div
      className="shrink-0 border-b px-3 py-1 text-[11px]"
      style={{
        borderColor: COLORS.border,
        color: COLORS.textDim,
        background: fgTint(3),
      }}
    >
      {lines.join(" ")}
    </div>
  );
}

const DocumentCanvas = React.forwardRef<
  HTMLDivElement,
  {
    document: WordDocument;
    mode: Mode;
    scale: number;
    mediaUrls: Map<string, string>;
    currentHeading: string | null;
    registerHeading: (id: string, node: HTMLElement | null) => void;
    onSelectHeading: (id: string) => void;
  }
>(function DocumentCanvas(
  {
    document,
    mode,
    scale,
    mediaUrls,
    currentHeading,
    registerHeading,
    onSelectHeading,
  },
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
              background: "#fff",
              color: "#202124",
              boxShadow: PAGE_SHADOW,
              padding: pagePadding,
              boxSizing: "border-box",
              fontSize: `${16 * scale}px`,
              lineHeight: 1.45,
            }}
          >
            {document.blocks.map((block, index) => (
              <WordBlockView
                key={index}
                block={block}
                scale={scale}
                mediaUrls={mediaUrls}
                registerHeading={registerHeading}
                onOpenLink={openUrlInAdeBrowser}
              />
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
          const paragraph = blocks[heading.blockIndex] as
            WordParagraph | undefined;

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
                {paragraph ? renderRunsText(paragraph.runs) : heading.text}
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

function renderRunsText(runs: WordRun[]): string {
  return runs.map((run) => run.text).join("");
}

function WordBlockView({
  block,
  scale,
  mediaUrls,
  registerHeading,
  onOpenLink,
}: {
  block: WordBlock;
  scale: number;
  mediaUrls: Map<string, string>;
  registerHeading: (id: string, node: HTMLElement | null) => void;
  onOpenLink: (url: string) => void;
}) {
  if (block.kind === "pageBreak") return <PageBreak />;
  if (block.kind === "image")
    return <ImageBlock block={block} scale={scale} mediaUrls={mediaUrls} />;
  if (block.kind === "table") {
    return (
      <TableView
        table={block}
        scale={scale}
        mediaUrls={mediaUrls}
        registerHeading={registerHeading}
        onOpenLink={onOpenLink}
      />
    );
  }

  return (
    <ParagraphBlock
      block={block}
      scale={scale}
      registerHeading={registerHeading}
      onOpenLink={onOpenLink}
    />
  );
}

function PageBreak() {
  return (
    <div
      aria-label="Page break"
      className="my-8 flex items-center gap-3"
      style={{ color: "#9ca3af" }}
    >
      <span className="h-px flex-1 border-t border-dashed" />
      <span className="text-[10px]">Page break</span>
      <span className="h-px flex-1 border-t border-dashed" />
    </div>
  );
}

function ImageBlock({
  block,
  scale,
  mediaUrls,
}: {
  block: Extract<WordBlock, { kind: "image" }>;
  scale: number;
  mediaUrls: Map<string, string>;
}) {
  const src = block.path ? mediaUrls.get(block.path) : null;

  if (!src) {
    return (
      <div
        className="my-2 rounded border border-dashed px-3 py-2 text-center text-xs"
        style={{ borderColor: "#d1d5db", color: "#6b7280" }}
      >
        Image not shown: {block.alt}
      </div>
    );
  }

  return (
    <div className="my-3 text-center" style={{ contentVisibility: "auto" }}>
      <img
        src={src}
        alt={block.alt}
        loading="lazy"
        style={{
          display: "inline-block",
          maxWidth: "100%",
          width: block.widthPx
            ? Math.min(block.widthPx * scale, 720 * scale)
            : "auto",
          height: block.heightPx ? "auto" : undefined,
          objectFit: "contain",
        }}
      />
    </div>
  );
}

function ParagraphBlock({
  block,
  scale,
  registerHeading,
  onOpenLink,
}: {
  block: WordParagraph;
  scale: number;
  registerHeading: (id: string, node: HTMLElement | null) => void;
  onOpenLink: (url: string) => void;
}) {
  const Tag =
    block.headingLevel === 1
      ? "h1"
      : block.headingLevel === 2
        ? "h2"
        : block.headingLevel === 3
          ? "h3"
          : block.headingLevel
            ? "h4"
            : "p";
  const headingRef =
    block.headingLevel && block.id
      ? (node: HTMLElement | null) => registerHeading(block.id!, node)
      : undefined;

  return (
    <Tag
      id={block.id ?? undefined}
      data-heading-id={block.headingLevel ? (block.id ?? undefined) : undefined}
      ref={headingRef}
      style={{
        contentVisibility: "auto",
        display: block.list ? "grid" : undefined,
        gridTemplateColumns: block.list
          ? "max-content minmax(0, 1fr)"
          : undefined,
        columnGap: block.list ? `${4 * scale}px` : undefined,
        textAlign: block.align,
        marginTop: block.beforePx * scale,
        marginBottom: block.afterPx * scale,
        marginLeft: (block.indentLeftPx + block.indentFirstPx) * scale,
        marginRight: block.indentRightPx * scale,
        lineHeight: block.lineHeight || undefined,
        fontSize: fontSizeForParagraph(block, scale),
        fontWeight:
          block.headingLevel || block.style === "title" ? 600 : undefined,
        color: block.style === "subtitle" ? "#5f6368" : undefined,
        borderBottom: block.style === "title" ? "1px solid #e5e7eb" : undefined,
        paddingBottom: block.style === "title" ? ".25em" : undefined,
        overflowWrap: "anywhere",
      }}
    >
      {block.list ? (
        <ListMarker
          marker={block.list.marker}
          level={block.list.level}
          scale={scale}
        />
      ) : null}
      {block.list ? (
        <span style={{ minWidth: 0 }}>
          {block.runs.map((run, index) => (
            <RunView
              key={index}
              run={run}
              scale={scale}
              onOpenLink={onOpenLink}
            />
          ))}
        </span>
      ) : (
        block.runs.map((run, index) => (
          <RunView
            key={index}
            run={run}
            scale={scale}
            onOpenLink={onOpenLink}
          />
        ))
      )}
    </Tag>
  );
}

function fontSizeForParagraph(
  block: WordParagraph,
  scale: number,
): string | undefined {
  if (block.style === "title") return `${32 * scale}px`;
  if (block.style === "subtitle") return `${18.4 * scale}px`;
  if (block.headingLevel)
    return `${16 * Math.max(1.05, 1.65 - block.headingLevel * 0.1) * scale}px`;
  return undefined;
}

function ListMarker({
  marker,
  level,
  scale,
}: {
  marker: string;
  level: number;
  scale: number;
}) {
  const markerWidth = Math.min(32, 16 + level * 18) * scale;

  return (
    <span
      aria-hidden="true"
      style={{
        display: "block",
        minWidth: markerWidth,
        textAlign: "right",
      }}
    >
      {marker}
    </span>
  );
}

function RunView({
  run,
  scale,
  onOpenLink,
}: {
  run: WordRun;
  scale: number;
  onOpenLink: (url: string) => void;
}) {
  const style: React.CSSProperties = {
    fontWeight: run.bold ? 700 : undefined,
    fontStyle: run.italic ? "italic" : undefined,
    textDecoration: textDecorationForRun(run),
    verticalAlign: run.vertical ?? undefined,
    fontSize: run.sizePt ? `${((run.sizePt * 4) / 3) * scale}px` : undefined,
    fontFamily: run.family,
    color: run.color ?? undefined,
    backgroundColor: run.highlight ?? undefined,
    whiteSpace: "pre-wrap",
  };
  const content = <span style={style}>{run.text}</span>;

  if (!run.href) return content;
  if (run.href.startsWith("#")) {
    return (
      <InternalLink run={run} style={style}>
        {content}
      </InternalLink>
    );
  }

  return (
    <a
      href={run.href}
      style={{ ...style, color: "#0563c1", textDecoration: "underline" }}
      onClick={(event) => {
        event.preventDefault();
        onOpenLink(run.href!);
      }}
    >
      {content}
    </a>
  );
}

function InternalLink({
  run,
  style,
  children,
}: {
  run: WordRun;
  style: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <a
      href={run.href!}
      style={{ ...style, color: "#0563c1", textDecoration: "underline" }}
      onClick={(event) => {
        event.preventDefault();
        try {
          const id = decodeURIComponent(run.href!.slice(1));
          globalThis.document
            .getElementById(id)
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
        } catch {
          // A malformed bookmark is inert; it must not interrupt reading.
        }
      }}
    >
      {children}
    </a>
  );
}

function textDecorationForRun(run: WordRun): string | undefined {
  const decorations = [
    run.underline ? "underline" : "",
    run.strike ? "line-through" : "",
  ].filter(Boolean);

  return decorations.length ? decorations.join(" ") : undefined;
}

function TableView({
  table,
  scale,
  mediaUrls,
  registerHeading,
  onOpenLink,
}: {
  table: WordTable;
  scale: number;
  mediaUrls: Map<string, string>;
  registerHeading: (id: string, node: HTMLElement | null) => void;
  onOpenLink: (url: string) => void;
}) {
  return (
    <div
      className="my-3 max-w-full overflow-x-auto"
      style={{ contentVisibility: "auto" }}
    >
      <table
        style={{ borderCollapse: "collapse", width: "100%", fontSize: ".92em" }}
      >
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.cells.map((cell, cellIndex) => {
                const Cell = rowIndex < table.headerRows ? "th" : "td";

                return (
                  <Cell
                    key={cellIndex}
                    colSpan={cell.colSpan}
                    rowSpan={cell.rowSpan}
                    style={cellStyle(cell, rowIndex < table.headerRows, scale)}
                  >
                    {cell.blocks.map((nested, index) => (
                      <WordBlockView
                        key={index}
                        block={nested}
                        scale={scale}
                        mediaUrls={mediaUrls}
                        registerHeading={registerHeading}
                        onOpenLink={onOpenLink}
                      />
                    ))}
                  </Cell>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function cellStyle(
  cell: WordTable["rows"][number]["cells"][number],
  header: boolean,
  scale: number,
): React.CSSProperties {
  const style: React.CSSProperties = {
    border: "1px solid #d1d5db",
    background: cell.fill ?? (header ? "#f3f4f6" : undefined),
    verticalAlign: "top",
    textAlign: "left",
    padding: `${5 * scale}px ${7 * scale}px`,
    fontWeight: header ? 600 : undefined,
  };

  for (const side of ["top", "right", "bottom", "left"] as const) {
    const border = cell.borders[side];
    if (!border) continue;
    const property =
      `border${side[0]!.toUpperCase()}${side.slice(1)}` as "borderTop";
    style[property] = `${border.width}px solid ${border.color}`;
  }

  return style;
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
