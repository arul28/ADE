import React, { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowSquareOut, Table } from "@phosphor-icons/react";
import { COLORS, fgTint } from "../../../lanes/laneDesignTokens";
import { streamFileBytes } from "../streamBytes";
import { DocumentSurface } from "./DocumentSurface";
import { ooxmlFailureMessage } from "./office/ooxmlError";
import type { SpreadsheetWindow, SpreadsheetWorkbook } from "./office/xlsx";
import type { ViewerProps } from "./types";

/** Matches the PDF viewer's streaming ceiling; past this, open externally. */
const MAX_SPREADSHEET_STREAM_BYTES = 25 * 1024 * 1024;
const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 24;
const GUTTER_WIDTH = 52;

type WorkbookState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; workbook: SpreadsheetWorkbook };

type SheetState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; window: SpreadsheetWindow };

/**
 * `.xlsx` preview: virtualized grid with Excel's own chrome (column letters,
 * row numbers, sheet tabs, date/number formatting).
 *
 * The parse is deliberately tiered so a preview never becomes a stall:
 * the workbook's small parts load first (sheet names), the sheet body is
 * scanned on demand per tab, and the grid only ever materializes the window
 * the reader is scrolling through. The heavy module (fflate) is imported by
 * the parser on demand, so this viewer costs the Files route nothing until a
 * workbook is actually opened.
 */
export function SpreadsheetViewer(props: ViewerProps) {
  const { files, workspaceId, tab, rootPath, content } = props;
  const [state, setState] = useState<WorkbookState>({ status: "loading" });
  const [sheetIndex, setSheetIndex] = useState(0);
  const [sheet, setSheet] = useState<SheetState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  // Bytes → workbook. One read of the file, capped, cancellable. The parser
  // itself is imported here, not at module scope: opening the Files tab must
  // not download a spreadsheet reader nobody asked for.
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setSheet({ status: "loading" });
    (async () => {
      try {
        const bytes = await streamFileBytes(files, workspaceId, tab.path, {
          isCancelled: () => cancelled,
          maxBytes: MAX_SPREADSHEET_STREAM_BYTES,
        });
        if (cancelled) return;
        const { openXlsx } = await import("./office/xlsx");
        const workbook = await openXlsx(bytes);
        if (cancelled) return;
        setSheetIndex(workbook.defaultSheetIndex);
        setState({ status: "ready", workbook });
      } catch (err) {
        if (!cancelled) setState({ status: "error", message: ooxmlFailureMessage(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [files, workspaceId, tab.path, reloadKey]);

  // Sheet body, on demand and cached by the workbook object.
  useEffect(() => {
    if (state.status !== "ready") return;
    let cancelled = false;
    setSheet({ status: "loading" });
    state.workbook
      .readSheet(sheetIndex)
      .then((window) => {
        if (!cancelled) setSheet({ status: "ready", window });
      })
      .catch((err: unknown) => {
        if (!cancelled) setSheet({ status: "error", message: ooxmlFailureMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [state, sheetIndex]);

  if (state.status === "loading") {
    return <CenteredMessage>Loading {tab.title}…</CenteredMessage>;
  }

  if (state.status === "error") {
    return (
      <DocumentSurface
        rootPath={rootPath}
        relativePath={tab.path}
        title={tab.title}
        mimeType={content.mimeType ?? null}
        size={content.size}
        notice={state.message}
        extraActions={(
          <button
            type="button"
            onClick={() => setReloadKey((key) => key + 1)}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs"
            style={{ border: `1px solid ${COLORS.border}`, color: COLORS.textPrimary }}
          >
            Try again
          </button>
        )}
      />
    );
  }

  const { workbook } = state;

  const stripText = sheet.status === "ready"
    ? describeTruncation(sheet.window)
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {sheet.status === "ready" && sheet.window.notice ? (
        <div className={VIEWER_STRIP_CLASS} style={VIEWER_STRIP_STYLE}>
          {sheet.window.notice}
        </div>
      ) : null}
      {stripText ? (
        <div className={VIEWER_STRIP_CLASS} style={VIEWER_STRIP_STYLE} title="A preview keeps a bounded window of the sheet; open the file externally for the whole thing.">
          {stripText}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {sheet.status === "loading" ? (
          <CenteredMessage>Loading sheet…</CenteredMessage>
        ) : sheet.status === "error" ? (
          <CenteredMessage>
            <span>{sheet.message}</span>
            <button
              type="button"
              onClick={() => void window.ade.app.openPathInEditor?.({ rootPath, relativePath: tab.path, target: "default" }).catch(() => {})}
              className="mt-2 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs"
              style={{ border: `1px solid ${COLORS.border}`, color: COLORS.textPrimary }}
            >
              <ArrowSquareOut size={14} /> Open externally
            </button>
          </CenteredMessage>
        ) : sheet.window.empty ? (
          <CenteredMessage>This sheet is empty.</CenteredMessage>
        ) : (
          <SheetGrid key={sheetIndex} window={sheet.window} />
        )}
      </div>
      <SheetTabsBar
        workbook={workbook}
        sheetIndex={sheetIndex}
        window={sheet.status === "ready" ? sheet.window : null}
        onSelect={setSheetIndex}
      />
    </div>
  );
}

/**
 * The one-line "this preview is bounded" strip, in the same shape as the
 * explorer's "Some git decorations hidden" hint: a plain muted row at the edge
 * of the surface, not a banner or a toast (see docs/design/notices.md).
 */
const VIEWER_STRIP_CLASS = "shrink-0 border-b px-3 py-1 text-[11px]";
const VIEWER_STRIP_STYLE = { borderColor: COLORS.border, color: COLORS.textDim, background: fgTint(3) } as const;

/** What the bounded window left out, or null when the whole sheet is shown. */
export function describeTruncation(sheetWindow: SpreadsheetWindow): string | null {
  if (!sheetWindow.truncatedRows && !sheetWindow.truncatedCols) return null;
  const parts: string[] = [];
  if (sheetWindow.truncatedRows) {
    parts.push(`${sheetWindow.rows.length.toLocaleString()} of ${sheetWindow.rowCount.toLocaleString()} rows`);
  }
  if (sheetWindow.truncatedCols) {
    parts.push(`${sheetWindow.colWidthsPx.length} of ${sheetWindow.colCount.toLocaleString()} columns`);
  }
  return `Showing the first ${parts.join(" and ")}.`;
}

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center text-sm" style={{ color: COLORS.textDim }}>
      {children}
    </div>
  );
}

/** A1-style column label for a 0-based index: 0 → A, 26 → AA. */
export function columnName(index: number): string {
  let name = "";
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

/** Numbers align right in Excel; everything else sits left. */
export function isNumericCellText(text: string): boolean {
  if (!text) return false;
  return /^-?\d[\d,]*(\.\d+)?%?$/.test(text);
}

/**
 * The grid. Rows are virtualized (like the CSV viewer); the header row and
 * the row-number gutter are sticky, which is what makes a spreadsheet read as
 * a spreadsheet rather than a long list.
 */
function SheetGrid({ window: sheetWindow }: { window: SpreadsheetWindow }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: sheetWindow.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const totalWidth = GUTTER_WIDTH + sheetWindow.colWidthsPx.reduce((sum, width) => sum + width, 0);

  return (
    <div ref={scrollRef} className="h-full min-h-0 overflow-auto">
      <div style={{ width: totalWidth, minWidth: "100%" }}>
        <div className="sticky top-0 z-10 flex" style={{ height: HEADER_HEIGHT }}>
          <div
            className="sticky left-0 z-20 flex shrink-0 items-center justify-center border-b border-r text-[10px]"
            style={{ width: GUTTER_WIDTH, borderColor: fgTint(6), background: COLORS.cardBgSolid, color: COLORS.textDim }}
          >
            <Table size={11} />
          </div>
          {sheetWindow.colWidthsPx.map((width, col) => (
            <div
              key={col}
              className="flex shrink-0 items-center justify-center border-b border-r text-[10px] font-medium"
              style={{ width, borderColor: fgTint(6), background: COLORS.cardBgSolid, color: COLORS.textMuted }}
            >
              {columnName(sheetWindow.firstCol - 1 + col)}
            </div>
          ))}
        </div>

        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = sheetWindow.rows[item.index]!;
            const rowNumber = sheetWindow.rowNumbers[item.index] ?? item.index + 1;
            return (
              <div
                key={item.key}
                className="absolute left-0 flex w-full"
                style={{
                  top: item.start,
                  height: ROW_HEIGHT,
                  background: item.index % 2 === 1 ? fgTint(2) : undefined,
                  borderBottom: `1px solid ${fgTint(4)}`,
                }}
              >
                <div
                  className="sticky left-0 flex shrink-0 items-center justify-end border-r pr-1.5 text-[10px] tabular-nums"
                  style={{ width: GUTTER_WIDTH, borderColor: fgTint(6), background: COLORS.cardBgSolid, color: COLORS.textDim }}
                >
                  {rowNumber}
                </div>
                {sheetWindow.colWidthsPx.map((width, col) => {
                  const text = row[col] ?? "";
                  const numeric = isNumericCellText(text);
                  return (
                    <div
                      key={col}
                      className={`shrink-0 truncate border-r px-2 py-[5px] text-xs ${numeric ? "tabular-nums" : ""}`}
                      style={{
                        width,
                        borderColor: fgTint(3),
                        color: COLORS.textPrimary,
                        textAlign: numeric ? "right" : "left",
                      }}
                      title={text.length > 0 && text.length <= 600 ? text : undefined}
                    >
                      {text}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SheetTabsBar({
  workbook,
  sheetIndex,
  window: sheetWindow,
  onSelect,
}: {
  workbook: SpreadsheetWorkbook;
  sheetIndex: number;
  window: SpreadsheetWindow | null;
  onSelect: (index: number) => void;
}) {
  const counts = sheetWindow && !sheetWindow.empty
    ? `${sheetWindow.rowCount.toLocaleString()} rows × ${sheetWindow.colCount.toLocaleString()} cols`
    : null;
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-t px-2" style={{ borderColor: COLORS.border }}>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1">
        {workbook.sheets.map((sheet, index) => {
          const active = index === sheetIndex;
          return (
            <button
              key={`${sheet.name}-${index}`}
              type="button"
              onClick={() => onSelect(index)}
              title={sheet.path ? sheet.name : `${sheet.name} — not a grid sheet`}
              className="shrink-0 truncate rounded px-2 py-0.5 text-xs"
              style={{
                maxWidth: 200,
                background: active ? fgTint(8) : "transparent",
                color: active ? COLORS.textPrimary : COLORS.textMuted,
                opacity: sheet.hidden && !active ? 0.6 : 1,
              }}
            >
              {sheet.name}
            </button>
          );
        })}
      </div>
      {counts ? (
        <div className="shrink-0 text-[11px] tabular-nums" style={{ color: COLORS.textDim }}>
          {counts}
        </div>
      ) : null}
    </div>
  );
}
