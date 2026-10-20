import React, { createContext, useContext } from "react";
import type {
  WordBlock,
  WordImage,
  WordParagraph,
  WordRun,
  WordTable,
  WordTableCell,
} from "./office/docx";

// Colours of the rendered page. A Word page is paper: it stays light in every
// app theme, so these are fixed values rather than theme tokens.
export const PAGE_BACKGROUND = "#ffffff";
export const PAGE_INK = "#202124";
export const PAGE_SHADOW =
  "0 2px 12px rgba(0,0,0,.14), 0 16px 38px rgba(0,0,0,.12)";
const PAGE_INK_MUTED = "#5f6368";
const PAGE_INK_FAINT = "#6b7280";
const PAGE_RULE = "#e5e7eb";
const PAGE_GRID = "#d1d5db";
const PAGE_HEADER_FILL = "#f3f4f6";
const PAGE_BREAK_INK = "#9ca3af";
const PAGE_LINK = "#0563c1";

/** What every block needs from the reader that renders it. */
export type WordBlockContext = {
  scale: number;
  mediaUrls: Map<string, string>;
  /** Prefix that keeps this reader's element ids apart from another open document's. */
  idScope: string;
  registerHeading: (id: string, node: HTMLElement | null) => void;
  onOpenLink: (url: string) => void;
  /** Scroll to a bookmark by name, inside this reader only. */
  onFollowBookmark: (name: string) => void;
};

const BlockContext = createContext<WordBlockContext | null>(null);

export const WordBlockProvider = BlockContext.Provider;

function useBlockContext(): WordBlockContext {
  const context = useContext(BlockContext);
  if (!context) throw new Error("Word blocks render inside a WordBlockProvider.");
  return context;
}

/** The DOM id of a bookmark's anchor, scoped to one reader. */
export function bookmarkElementId(idScope: string, name: string): string {
  return `${idScope}-bookmark-${encodeURIComponent(name)}`;
}

const HEADING_TAGS: Record<number, "h1" | "h2" | "h3"> = {
  1: "h1",
  2: "h2",
  3: "h3",
};

const BORDER_PROPERTY = {
  top: "borderTop",
  right: "borderRight",
  bottom: "borderBottom",
  left: "borderLeft",
} as const;

export function WordBlockView({ block }: { block: WordBlock }) {
  if (block.kind === "pageBreak") return <PageBreak />;
  if (block.kind === "image") return <ImageBlock block={block} />;
  if (block.kind === "table") return <TableView table={block} />;
  return <ParagraphBlock block={block} />;
}

function PageBreak() {
  return (
    <div
      aria-label="Page break"
      className="my-8 flex items-center gap-3"
      style={{ color: PAGE_BREAK_INK }}
    >
      <span className="h-px flex-1 border-t border-dashed" />
      <span className="text-[10px]">Page break</span>
      <span className="h-px flex-1 border-t border-dashed" />
    </div>
  );
}

function ImageBlock({ block }: { block: WordImage }) {
  const { scale, mediaUrls } = useBlockContext();
  const src = block.path ? mediaUrls.get(block.path) : null;

  if (!src) {
    return (
      <div
        className="my-2 rounded border border-dashed px-3 py-2 text-center text-xs"
        style={{ borderColor: PAGE_GRID, color: PAGE_INK_FAINT }}
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

function ParagraphBlock({ block }: { block: WordParagraph }) {
  const { scale, idScope, registerHeading } = useBlockContext();
  const Tag = block.headingLevel
    ? (HEADING_TAGS[block.headingLevel] ?? "h4")
    : "p";
  const headingId = block.headingLevel ? block.id : null;
  const headingRef = headingId
    ? (node: HTMLElement | null) => registerHeading(headingId, node)
    : undefined;
  // Every bookmark gets its own empty anchor, so a link to any of them lands
  // on this paragraph.
  const anchors = block.bookmarks.map((name) => (
    <span key={name} id={bookmarkElementId(idScope, name)} />
  ));
  const runs = block.runs.map((run, index) => (
    <RunView key={index} run={run} />
  ));

  return (
    <Tag
      id={block.id ? `${idScope}-${block.id}` : undefined}
      data-heading-id={headingId ?? undefined}
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
        color: block.style === "subtitle" ? PAGE_INK_MUTED : undefined,
        borderBottom:
          block.style === "title" ? `1px solid ${PAGE_RULE}` : undefined,
        paddingBottom: block.style === "title" ? ".25em" : undefined,
        overflowWrap: "anywhere",
      }}
    >
      {block.list ? (
        <>
          <ListMarker
            marker={block.list.marker}
            level={block.list.level}
            scale={scale}
          />
          {/* The grid has two columns; the anchors ride in the text column. */}
          <span style={{ minWidth: 0 }}>
            {anchors}
            {runs}
          </span>
        </>
      ) : (
        <>
          {anchors}
          {runs}
        </>
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

function RunView({ run }: { run: WordRun }) {
  const { scale, onOpenLink, onFollowBookmark } = useBlockContext();
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
  const href = run.href;

  if (!href) return content;

  return (
    <a
      href={href}
      style={{ ...style, color: PAGE_LINK, textDecoration: "underline" }}
      onClick={(event) => {
        event.preventDefault();
        // `#name` is a bookmark in this document; anything else was already
        // narrowed to a web or mail link by the parser.
        if (href.startsWith("#")) onFollowBookmark(href.slice(1));
        else onOpenLink(href);
      }}
    >
      {content}
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

function TableView({ table }: { table: WordTable }) {
  const { scale } = useBlockContext();

  return (
    <div
      className="my-3 max-w-full overflow-x-auto"
      style={{ contentVisibility: "auto" }}
    >
      <table
        style={{ borderCollapse: "collapse", width: "100%", fontSize: ".92em" }}
      >
        <tbody>
          {table.rows.map((row, rowIndex) => {
            const header = rowIndex < table.headerRows;
            const Cell = header ? "th" : "td";

            return (
              <tr key={rowIndex}>
                {row.cells.map((cell, cellIndex) => (
                  <Cell
                    key={cellIndex}
                    colSpan={cell.colSpan}
                    rowSpan={cell.rowSpan}
                    style={cellStyle(cell, header, scale)}
                  >
                    {cell.blocks.map((nested, index) => (
                      <WordBlockView key={index} block={nested} />
                    ))}
                  </Cell>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function cellStyle(
  cell: WordTableCell,
  header: boolean,
  scale: number,
): React.CSSProperties {
  const style: React.CSSProperties = {
    border: `1px solid ${PAGE_GRID}`,
    background: cell.fill ?? (header ? PAGE_HEADER_FILL : undefined),
    verticalAlign: "top",
    textAlign: "left",
    padding: `${5 * scale}px ${7 * scale}px`,
    fontWeight: header ? 600 : undefined,
  };

  for (const side of ["top", "right", "bottom", "left"] as const) {
    const border = cell.borders[side];
    if (border)
      style[BORDER_PROPERTY[side]] = `${border.width}px solid ${border.color}`;
  }

  return style;
}
