import React, { useEffect, useRef, useState, useMemo } from "react";
import type { OrchestratorAttempt, OrchestratorStep } from "../../../shared/types";
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

const EXECUTOR_BADGE: Record<string, { label: string; color: string }> = {
  claude: { label: "Claude", color: "bg-violet-500/20 text-violet-300 border-violet-500/30" },
  codex: { label: "Codex", color: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" },
  shell: { label: "Shell", color: "bg-amber-500/20 text-amber-300 border-amber-500/30" },
  manual: { label: "Manual", color: "bg-blue-500/20 text-blue-300 border-blue-500/30" },
};

const DEFAULT_BADGE = { label: "Worker", color: "bg-muted/20 text-muted-fg border-border/20" };

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
        if (!cancelled) setText(tail);
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
      className="flex-1 overflow-auto bg-muted/5 p-2 text-[10px] font-mono leading-relaxed text-fg/80 whitespace-pre-wrap break-all"
    >
      {text || <span className="text-muted-fg italic">Waiting for output...</span>}
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
      <div className="flex items-center justify-center rounded border border-border/20 bg-card/60 p-6 text-[11px] text-muted-fg">
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
            className="flex flex-col rounded border border-border/20 bg-card/60 overflow-hidden"
            style={{ minHeight: 180, maxHeight: 320 }}
          >
            {/* Header */}
            <div className="flex items-center gap-2 border-b border-border/15 px-2.5 py-1.5">
              <div className="h-2 w-2 rounded-full bg-green-400 animate-pulse" />
              <span className="flex-1 truncate text-[11px] font-medium text-fg">
                {worker.stepTitle}
              </span>
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-[10px] font-medium border",
                  badge.color
                )}
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
