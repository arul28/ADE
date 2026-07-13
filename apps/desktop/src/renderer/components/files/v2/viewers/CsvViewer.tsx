import React, { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CaretDown, CaretUp, Code, MagnifyingGlass, Table } from "@phosphor-icons/react";
import { COLORS } from "../../../lanes/laneDesignTokens";
import { CodeViewer } from "./CodeViewer";
import type { ViewerProps } from "./types";
import { readViewerMode, rememberViewerMode } from "./viewerModeMemory";

const ROW_HEIGHT = 26;
const MAX_ROWS = 500_000;

type SortState = { col: number; dir: "asc" | "desc" } | null;
type Mode = "table" | "source";

/**
 * CSV/TSV viewer: a virtualized, sortable, filterable table with a frozen
 * header, plus a Source mode that mounts the full editable code editor.
 * Source is only offered when the payload round-trips as text (`!readOnly`):
 * an oversized streamed CSV keeps the table so a partial buffer can never be
 * saved back and truncate the file.
 */
export function CsvViewer(props: ViewerProps) {
  const { workspaceId, tab, content, registry, readOnly } = props;
  const [mode, setModeState] = useState<Mode>(() => readViewerMode<Mode>(tab.id, "table"));
  const setMode = (next: Mode) => {
    rememberViewerMode(tab.id, next);
    setModeState(next);
  };
  const [rows, setRows] = useState<string[][]>([]);
  const [parsing, setParsing] = useState(true);
  const [truncated, setTruncated] = useState(false);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortState>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const delimiter = tab.path.toLowerCase().endsWith(".tsv") ? "\t" : ",";

  // Assemble the full text (live Monaco buffer when Source mode created one,
  // else the readFile payload plus streamed ranges when the first chunk is
  // partial) then parse off the main thread via papaparse's worker.
  useEffect(() => {
    if (mode !== "table") return;
    let cancelled = false;
    setParsing(true);
    setTruncated(false);
    (async () => {
      const live = registry.getValue(tab.id);
      let text = live ?? content.content;
      let next: number | null = live == null && content.isPartial ? content.nextOffset ?? null : null;
      let guard = 0;
      while (next != null) {
        const page = await window.ade.files.readFileRange({ workspaceId, path: tab.path, offset: next, length: 512 * 1024 });
        if (cancelled) return;
        text += page.content;
        next = page.nextOffset;
        if (++guard > 10_000) break;
      }
      Papa.parse<string[]>(text, {
        delimiter,
        worker: true,
        skipEmptyLines: true,
        complete: (result) => {
          if (cancelled) return;
          let data = result.data as string[][];
          if (data.length > MAX_ROWS) {
            data = data.slice(0, MAX_ROWS);
            setTruncated(true);
          }
          setRows(data);
          setParsing(false);
        },
        error: () => {
          if (!cancelled) setParsing(false);
        },
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, tab.id, tab.path, content.content, content.isPartial, content.nextOffset, delimiter, mode, registry]);

  const header = rows[0] ?? [];
  const bodyRows = useMemo(() => rows.slice(1), [rows]);

  // Index-based filter + sort so we never copy row data.
  const visibleIndexes = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    let indexes = bodyRows.map((_, i) => i);
    if (needle) {
      indexes = indexes.filter((i) => bodyRows[i]!.some((cell) => cell.toLowerCase().includes(needle)));
    }
    if (sort) {
      const { col, dir } = sort;
      indexes = [...indexes].sort((a, b) => {
        const av = bodyRows[a]![col] ?? "";
        const bv = bodyRows[b]![col] ?? "";
        const an = Number(av);
        const bn = Number(bv);
        const cmp = Number.isFinite(an) && Number.isFinite(bn) && av !== "" && bv !== ""
          ? an - bn
          : av.localeCompare(bv);
        return dir === "asc" ? cmp : -cmp;
      });
    }
    return indexes;
  }, [bodyRows, filter, sort]);

  const virtualizer = useVirtualizer({
    count: visibleIndexes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  const toggleSort = (col: number) =>
    setSort((prev) =>
      prev?.col === col ? (prev.dir === "asc" ? { col, dir: "desc" } : null) : { col, dir: "asc" },
    );

  const gridTemplate = header.length ? `repeat(${header.length}, minmax(120px, 1fr))` : "1fr";

  const modeToggle = !readOnly ? (
    <div className="flex items-center gap-1">
      <ModeButton active={mode === "table"} onClick={() => setMode("table")} icon={<Table size={14} />} label="Table" />
      <ModeButton active={mode === "source"} onClick={() => setMode("source")} icon={<Code size={14} />} label="Source" />
    </div>
  ) : null;

  if (mode === "source" && !readOnly) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1" style={{ borderColor: COLORS.border }}>
          {modeToggle}
        </div>
        <div className="min-h-0 min-w-0 flex-1">
          <CodeViewer {...props} />
        </div>
      </div>
    );
  }

  if (parsing) {
    return <div className="flex h-full items-center justify-center text-sm" style={{ color: COLORS.textDim }}>Parsing CSV…</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5" style={{ borderColor: COLORS.border }}>
        {modeToggle}
        <div className="relative flex items-center">
          <MagnifyingGlass size={13} style={{ position: "absolute", left: 6, color: COLORS.textDim }} />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter rows…"
            className="rounded border bg-transparent py-0.5 pl-6 pr-2 text-xs outline-none"
            style={{ borderColor: COLORS.border, color: COLORS.textPrimary, minWidth: 180 }}
          />
        </div>
        <span className="ml-auto text-xs" style={{ color: COLORS.textDim }}>
          {visibleIndexes.length.toLocaleString()} / {bodyRows.length.toLocaleString()} rows
          {truncated ? ` · capped at ${MAX_ROWS.toLocaleString()}` : ""}
        </span>
      </div>

      {/* Frozen header */}
      <div
        className="grid shrink-0 border-b text-xs font-semibold"
        style={{ gridTemplateColumns: gridTemplate, borderColor: COLORS.border, background: "rgba(255,255,255,0.03)" }}
      >
        {header.map((cell, col) => (
          <button
            key={col}
            type="button"
            onClick={() => toggleSort(col)}
            className="flex items-center gap-1 truncate px-2 py-1 text-left"
            style={{ color: COLORS.textPrimary }}
            title={cell}
          >
            <span className="truncate">{cell || `col ${col + 1}`}</span>
            {sort?.col === col ? (sort.dir === "asc" ? <CaretUp size={11} /> : <CaretDown size={11} />) : null}
          </button>
        ))}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {virtualizer.getVirtualItems().map((vItem) => {
            const rowIdx = visibleIndexes[vItem.index]!;
            const row = bodyRows[rowIdx]!;
            return (
              <div
                key={vItem.key}
                className="absolute left-0 grid w-full border-b text-xs"
                style={{
                  top: vItem.start,
                  height: ROW_HEIGHT,
                  gridTemplateColumns: gridTemplate,
                  borderColor: "rgba(255,255,255,0.04)",
                }}
              >
                {header.map((_, col) => (
                  <div key={col} className="truncate px-2 py-1" style={{ color: COLORS.textMuted }} title={row[col] ?? ""}>
                    {row[col] ?? ""}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ModeButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs"
      style={{
        color: active ? COLORS.textPrimary : COLORS.textMuted,
        background: active ? "rgba(255,255,255,0.07)" : "transparent",
      }}
    >
      {icon} {label}
    </button>
  );
}
