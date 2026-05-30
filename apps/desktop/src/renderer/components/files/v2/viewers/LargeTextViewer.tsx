import React, { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Lock } from "@phosphor-icons/react";
import { COLORS, MONO_FONT } from "../../../lanes/laneDesignTokens";
import type { ViewerProps } from "./types";

const LINE_HEIGHT = 18;
// Cap streamed text so a multi-GB file can't exhaust renderer memory.
const MAX_STREAM_BYTES = 25 * 1024 * 1024;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Read-only, virtualized viewer for oversized text streamed via readFileRange. */
export function LargeTextViewer({ workspaceId, tab, content }: ViewerProps) {
  const [text, setText] = useState(content.content);
  const [streaming, setStreaming] = useState(content.isPartial === true);
  const [capped, setCapped] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setText(content.content);
    if (!content.isPartial || content.nextOffset == null) {
      setStreaming(false);
      return;
    }
    setStreaming(true);
    (async () => {
      let acc = content.content;
      let next: number | null = content.nextOffset ?? null;
      let guard = 0;
      while (next != null) {
        const page = await window.ade.files.readFileRange({
          workspaceId,
          path: tab.path,
          offset: next,
          length: 512 * 1024,
        });
        if (cancelled) return;
        acc += page.content;
        next = page.nextOffset;
        // Surface progressively so the user sees content while it loads.
        setText(acc);
        if (acc.length >= MAX_STREAM_BYTES) {
          setCapped(true);
          break;
        }
        if (++guard > 10_000) break;
      }
      if (!cancelled) setStreaming(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, tab.path, content.content, content.isPartial, content.nextOffset]);

  const lines = useMemo(() => text.split("\n"), [text]);

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 30,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="flex shrink-0 items-center gap-2 border-b px-3 py-1 text-xs"
        style={{ borderColor: COLORS.border, color: COLORS.textMuted }}
      >
        <Lock size={12} /> Read-only
        <span style={{ color: COLORS.textDim }}>· {formatBytes(content.totalSize ?? content.size)}</span>
        {streaming ? <span style={{ color: COLORS.textDim }}>· loading…</span> : null}
        {capped ? <span style={{ color: COLORS.warning }}>· showing first {formatBytes(MAX_STREAM_BYTES)}</span> : null}
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto" style={{ fontFamily: MONO_FONT, fontSize: 12 }}>
        <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {virtualizer.getVirtualItems().map((vItem) => (
            <div
              key={vItem.key}
              className="absolute left-0 flex w-full whitespace-pre"
              style={{ top: vItem.start, height: LINE_HEIGHT, lineHeight: `${LINE_HEIGHT}px` }}
            >
              <span
                className="select-none pr-3 text-right tabular-nums"
                style={{ minWidth: 56, color: COLORS.textDim }}
              >
                {vItem.index + 1}
              </span>
              <span style={{ color: COLORS.textPrimary }}>{lines[vItem.index]}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
