import React, { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { CaretLeft, CaretRight, MagnifyingGlassMinus, MagnifyingGlassPlus } from "@phosphor-icons/react";
import { COLORS } from "../../../lanes/laneDesignTokens";
import { streamFileBytes } from "../streamBytes";
import { loadPdfjs } from "./pdfLoader";
import type { ViewerProps } from "./types";

/** In-app PDF viewer: pdf.js → canvas, with page navigation and zoom. */
export function PdfViewer({ workspaceId, tab }: ViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1.25);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Load the document once.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [pdfjs, bytes] = await Promise.all([
          loadPdfjs(),
          streamFileBytes(workspaceId, tab.path, { isCancelled: () => cancelled }),
        ]);
        if (cancelled) return;
        const doc = await pdfjs.getDocument({ data: bytes }).promise;
        if (cancelled) {
          void doc.destroy();
          return;
        }
        docRef.current = doc;
        setPageCount(doc.numPages);
        setPage(1);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      void docRef.current?.destroy();
      docRef.current = null;
    };
  }, [workspaceId, tab.path]);

  // Render the active page at the current zoom.
  useEffect(() => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas || loading) return;
    let cancelled = false;
    (async () => {
      try {
        const pdfPage = await doc.getPage(page);
        if (cancelled) return;
        const dpr = window.devicePixelRatio || 1;
        const viewport = pdfPage.getViewport({ scale: scale * dpr });
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width / dpr}px`;
        canvas.style.height = `${viewport.height / dpr}px`;
        renderTaskRef.current?.cancel();
        const task = pdfPage.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;
        await task.promise;
      } catch {
        // render cancelled by a newer page/zoom request — ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [page, scale, loading]);

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setScale((s) => Math.min(5, Math.max(0.3, s * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5" style={{ borderColor: COLORS.border }}>
        <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="rounded p-1 hover:bg-white/5 disabled:opacity-40">
          <CaretLeft size={14} />
        </button>
        <span className="text-xs tabular-nums" style={{ color: COLORS.textMuted }}>
          {pageCount ? `${page} / ${pageCount}` : "—"}
        </span>
        <button type="button" onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={page >= pageCount} className="rounded p-1 hover:bg-white/5 disabled:opacity-40">
          <CaretRight size={14} />
        </button>
        <div className="mx-2 h-4 w-px" style={{ background: COLORS.border }} />
        <button type="button" onClick={() => setScale((s) => Math.max(0.3, s / 1.2))} className="rounded p-1 hover:bg-white/5">
          <MagnifyingGlassMinus size={14} />
        </button>
        <span className="w-10 text-center text-xs tabular-nums" style={{ color: COLORS.textMuted }}>{Math.round(scale * 100)}%</span>
        <button type="button" onClick={() => setScale((s) => Math.min(5, s * 1.2))} className="rounded p-1 hover:bg-white/5">
          <MagnifyingGlassPlus size={14} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto p-4" onWheel={onWheel}>
        {error ? (
          <div className="mt-8 text-sm" style={{ color: COLORS.danger }}>Failed to render PDF: {error}</div>
        ) : loading ? (
          <div className="mt-8 text-sm" style={{ color: COLORS.textDim }}>Loading PDF…</div>
        ) : (
          <canvas ref={canvasRef} className="shadow-lg" />
        )}
      </div>
    </div>
  );
}
