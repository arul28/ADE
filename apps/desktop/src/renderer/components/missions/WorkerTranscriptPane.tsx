import React, { useEffect, useRef, useState, useMemo } from "react";
import type { OrchestratorAttempt, OrchestratorStep } from "../../../shared/types";
import { sanitizeWorkerTranscriptForDisplay } from "../../../shared/workerRuntimeNoise";
import { cn } from "../ui/cn";

type Props = {
  attempts: OrchestratorAttempt[];
  steps?: OrchestratorStep[];
};

type RunningWorker = {
  attemptId: string;
  stepId: string;
  sessionId: string;
  executorKind: string;
  stepTitle: string;
};

const EXECUTOR_BADGE: Record<string, { label: string; style: React.CSSProperties }> = {
  claude: { label: "CLAUDE", style: { background: "#A78BFA18", color: "#A78BFA", border: "1px solid #A78BFA30" } },
  codex: { label: "CODEX", style: { background: "#22C55E18", color: "#22C55E", border: "1px solid #22C55E30" } },
  shell: { label: "SHELL", style: { background: "#F59E0B18", color: "#F59E0B", border: "1px solid #F59E0B30" } },
  manual: { label: "MANUAL", style: { background: "#3B82F618", color: "#3B82F6", border: "1px solid #3B82F630" } },
};

const DEFAULT_BADGE = { label: "WORKER", style: { background: "#71717A18", color: "#71717A", border: "1px solid #71717A30" } as React.CSSProperties };

const POLL_INTERVAL_MS = 2000;
const MAX_BYTES = 4096;

function TranscriptTail({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchTail = async () => {
      try {
        const tail = await window.ade.sessions.readTranscriptTail({
          sessionId,
          maxBytes: MAX_BYTES,
        });
        if (!cancelled) {
          const sanitized = sanitizeWorkerTranscriptForDisplay(tail);
          setText(sanitized || (tail.trim().length > 0 ? "Worker is online, but only bootstrap output has been captured so far." : ""));
        }
      } catch {
        if (!cancelled) setText("(unable to read transcript)");
      }
    };

    void fetchTail();
    const timer = window.setInterval(() => void fetchTail(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [text]);

  return (
    <pre
      ref={scrollRef}
      className="flex-1 overflow-auto p-2 leading-relaxed whitespace-pre-wrap break-all"
      style={{ background: "#0C0A10", fontFamily: "JetBrains Mono, monospace", fontSize: "10px", color: "#A1A1AA" }}
    >
      {text || <span className="italic" style={{ color: "#52525B" }}>Waiting for output...</span>}
    </pre>
  );
}

export function WorkerTranscriptPane({ attempts, steps }: Props) {
  const stepMap = useMemo(() => {
    const map = new Map<string, OrchestratorStep>();
    for (const step of steps ?? []) {
      map.set(step.id, step);
    }
    return map;
  }, [steps]);

  const runningWorkers: RunningWorker[] = useMemo(() => {
    return attempts
      .filter((a) => a.status === "running" && a.executorSessionId)
      .map((a) => ({
        attemptId: a.id,
        stepId: a.stepId,
        sessionId: a.executorSessionId!,
        executorKind: a.executorKind,
        stepTitle: stepMap.get(a.stepId)?.title ?? `Step ${a.stepId.slice(0, 8)}`,
      }));
  }, [attempts, stepMap]);

  if (runningWorkers.length === 0) {
    return (
      <div
        className="flex items-center justify-center p-6 text-[11px]"
        style={{ border: "1px solid #1E1B26", background: "#13101A", color: "#71717A", fontFamily: "JetBrains Mono, monospace", textTransform: "uppercase", letterSpacing: "1px" }}
      >
        No active workers
      </div>
    );
  }

  const gridClass =
    runningWorkers.length === 1
      ? "grid-cols-1"
      : runningWorkers.length <= 2
        ? "grid-cols-1 md:grid-cols-2"
        : "grid-cols-1 md:grid-cols-2";

  return (
    <div className={cn("grid gap-2", gridClass)}>
      {runningWorkers.map((worker) => {
        const badge = EXECUTOR_BADGE[worker.executorKind] ?? DEFAULT_BADGE;
        return (
          <div
            key={worker.attemptId}
            className="flex flex-col overflow-hidden"
            style={{ minHeight: 180, maxHeight: 320, border: "1px solid #1E1B26", background: "#13101A" }}
          >
            {/* Header */}
            <div className="flex items-center gap-2 px-2.5 py-1.5" style={{ borderBottom: "1px solid #1E1B26" }}>
              <div className="h-2 w-2 rounded-full animate-pulse" style={{ background: "#22C55E" }} />
              <span
                className="flex-1 truncate"
                style={{ color: "#FAFAFA", fontFamily: "JetBrains Mono, monospace", fontSize: "11px", fontWeight: 600 }}
              >
                {worker.stepTitle}
              </span>
              <span
                className="px-1.5 py-0.5"
                style={{
                  ...badge.style,
                  fontFamily: "JetBrains Mono, monospace",
                  fontSize: "9px",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "1px",
                }}
              >
                {badge.label}
              </span>
            </div>

            {/* Transcript body */}
            <TranscriptTail sessionId={worker.sessionId} />
          </div>
        );
      })}
    </div>
  );
}
