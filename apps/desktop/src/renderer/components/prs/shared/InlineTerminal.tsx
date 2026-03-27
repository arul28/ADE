import { useEffect, useRef, useState } from "react";
import { CaretUp, CaretDown } from "@phosphor-icons/react";
import { cn } from "../../ui/cn";
import { formatElapsedSince } from "../../../lib/format";
import type { PtyDataEvent } from "../../../../shared/types";

type InlineTerminalProps = {
  ptyId: string;
  sessionId: string;
  provider: "codex" | "claude";
  startedAt: string;
  exitCode: number | null;
  minimized: boolean;
  onToggleMinimize: () => void;
};

export function InlineTerminal({
  ptyId,
  provider,
  startedAt,
  exitCode,
  minimized,
  onToggleMinimize,
}: InlineTerminalProps) {
  const [output, setOutput] = useState("");
  const [elapsed, setElapsed] = useState(() => formatElapsedSince(startedAt));
  const preRef = useRef<HTMLPreElement>(null);

  // Subscribe to pty data
  useEffect(() => {
    const unsub = window.ade.pty.onData((ev: PtyDataEvent) => {
      if (ev.ptyId !== ptyId) return;
      setOutput((prev) => {
        const next = prev + ev.data;
        if (next.length > 200_000) {
          return "[Output truncated - showing last 200k characters]\n" + next.slice(-200_000);
        }
        return next;
      });
    });
    return unsub;
  }, [ptyId]);

  // Auto-scroll on new output
  useEffect(() => {
    if (preRef.current && !minimized) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [output, minimized]);

  // Elapsed timer
  useEffect(() => {
    if (exitCode !== null) {
      setElapsed(formatElapsedSince(startedAt));
      return;
    }
    const timer = setInterval(() => setElapsed(formatElapsedSince(startedAt)), 1000);
    return () => clearInterval(timer);
  }, [startedAt, exitCode]);

  const isRunning = exitCode === null;

  let statusColor: string;
  if (isRunning) {
    statusColor = "text-blue-400";
  } else if (exitCode === 0) {
    statusColor = "text-emerald-400";
  } else {
    statusColor = "text-red-400";
  }

  let statusLabel: string;
  if (isRunning) {
    statusLabel = "Running";
  } else if (exitCode === 0) {
    statusLabel = "Completed";
  } else {
    statusLabel = `Failed (${exitCode})`;
  }

  return (
    <div className="rounded-xl border border-border/20 bg-card/45 backdrop-blur-sm shadow-card overflow-hidden">
      {/* Header */}
      <button
        type="button"
        onClick={onToggleMinimize}
        className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-xs hover:bg-muted/20 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className={cn("font-medium", statusColor)}>
            {statusLabel}
          </span>
          <span className="text-muted-fg/60">{provider}</span>
          <span className="text-muted-fg/40">{elapsed}</span>
        </div>
        {minimized ? <CaretDown size={14} /> : <CaretUp size={14} />}
      </button>

      {/* Terminal output */}
      {!minimized && (
        <pre
          ref={preRef}
          className="max-h-60 overflow-auto bg-black/40 px-3 py-2 font-mono text-[11px] leading-[1.5] text-gray-300 scrollbar-thin"
        >
          <code>{output || (isRunning ? "Waiting for output..." : "(no output)")}</code>
        </pre>
      )}
    </div>
  );
}
