import React, { useState, useEffect, useMemo, useRef } from "react";
import type { OrchestratorRunGraph } from "../../../shared/types";
import { COLORS, MONO_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { isRecord } from "./missionHelpers";

export function WorkTab({ runGraph }: { runGraph: OrchestratorRunGraph | null }) {
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(null);
  const [transcriptTail, setTranscriptTail] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const transcriptRef = useRef<HTMLPreElement>(null);
  const visibleRef = useRef(true);

  useEffect(() => {
    const onVisChange = () => { visibleRef.current = document.visibilityState === "visible"; };
    document.addEventListener("visibilitychange", onVisChange);
    return () => document.removeEventListener("visibilitychange", onVisChange);
  }, []);

  const activeAttempts = useMemo(() => {
    if (!runGraph) return [];
    return runGraph.attempts
      .filter((attempt) => attempt.status === "running" && typeof attempt.executorSessionId === "string" && attempt.executorSessionId.length > 0)
      .sort((a, b) => Date.parse(b.startedAt ?? b.createdAt) - Date.parse(a.startedAt ?? a.createdAt));
  }, [runGraph]);

  useEffect(() => {
    if (!activeAttempts.length) {
      setSelectedAttemptId(null);
      setTranscriptTail("");
      return;
    }
    setSelectedAttemptId((prev) => (prev && activeAttempts.some((attempt) => attempt.id === prev) ? prev : activeAttempts[0]!.id));
  }, [activeAttempts]);

  const selectedAttempt = useMemo(
    () => activeAttempts.find((attempt) => attempt.id === selectedAttemptId) ?? null,
    [activeAttempts, selectedAttemptId]
  );
  const selectedStep = useMemo(
    () => (runGraph && selectedAttempt ? runGraph.steps.find((step) => step.id === selectedAttempt.stepId) ?? null : null),
    [runGraph, selectedAttempt]
  );

  useEffect(() => {
    if (!selectedAttempt?.executorSessionId) return;
    let cancelled = false;
    const readTail = async () => {
      try {
        const tail = await window.ade.sessions.readTranscriptTail({
          sessionId: selectedAttempt.executorSessionId!,
          maxBytes: 16_000
        });
        if (!cancelled) setTranscriptTail(tail);
      } catch {
        if (!cancelled) setTranscriptTail("(unable to read worker transcript)");
      }
    };
    void readTail();
    const timer = window.setInterval(() => {
      if (!visibleRef.current) return;
      void readTail();
    }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedAttempt?.executorSessionId]);

  useEffect(() => {
    if (!autoScroll || !transcriptRef.current) return;
    transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [autoScroll, transcriptTail]);

  const relatedEvents = useMemo(() => {
    if (!runGraph?.runtimeEvents || !selectedAttempt) return [];
    return [...runGraph.runtimeEvents]
      .filter((event) => event.attemptId === selectedAttempt.id || event.stepId === selectedAttempt.stepId)
      .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
      .slice(-200);
  }, [runGraph?.runtimeEvents, selectedAttempt]);

  const filesTouched = useMemo(() => {
    const files = new Map<string, number>();
    for (const event of relatedEvents) {
      const payload = isRecord(event.payload) ? event.payload : {};
      const candidates = [
        typeof payload.filePath === "string" ? payload.filePath : null,
        typeof payload.path === "string" ? payload.path : null,
        typeof payload.file === "string" ? payload.file : null
      ].filter((entry): entry is string => Boolean(entry));
      for (const file of candidates) {
        files.set(file, (files.get(file) ?? 0) + 1);
      }
    }
    return [...files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [relatedEvents]);

  const toolsCalled = useMemo(() => {
    const tools = new Map<string, number>();
    for (const event of relatedEvents) {
      const payload = isRecord(event.payload) ? event.payload : {};
      const toolName =
        typeof payload.toolName === "string"
          ? payload.toolName
          : typeof payload.tool === "string"
            ? payload.tool
            : event.eventType.startsWith("tool_")
              ? event.eventType
              : null;
      if (!toolName) continue;
      tools.set(toolName, (tools.get(toolName) ?? 0) + 1);
    }
    return [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [relatedEvents]);

  if (!runGraph) {
    return (
      <div className="flex h-full items-center justify-center text-xs" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
        No orchestrator run yet.
      </div>
    );
  }

  if (!activeAttempts.length) {
    return (
      <div className="flex h-full items-center justify-center text-xs" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
        No active workers right now.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center gap-2 px-3 py-2" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
        <span className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>Follow</span>
        <select
          value={selectedAttemptId ?? ""}
          onChange={(event) => setSelectedAttemptId(event.target.value)}
          className="h-7 px-2 text-[10px] outline-none"
          style={{ ...outlineButton(), background: COLORS.recessedBg }}
        >
          {activeAttempts.map((attempt) => {
            const step = runGraph.steps.find((entry) => entry.id === attempt.stepId);
            return (
              <option key={attempt.id} value={attempt.id}>
                {(step?.title ?? attempt.stepId.slice(0, 8)).slice(0, 70)}
              </option>
            );
          })}
        </select>
        <span className="ml-auto text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
          {selectedStep ? `Phase: ${String((selectedStep.metadata as Record<string, unknown> | null)?.phaseName ?? "Development")}` : ""}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        <div className="min-h-0 min-w-0 flex-1" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
          <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
            <span className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>Live Output</span>
            <button
              className="text-[10px] font-bold uppercase tracking-[1px]"
              style={{ color: autoScroll ? COLORS.accent : COLORS.textMuted, fontFamily: MONO_FONT }}
              onClick={() => setAutoScroll((prev) => !prev)}
            >
              {autoScroll ? "Auto-scroll" : "Scroll lock"}
            </button>
          </div>
          <pre
            ref={transcriptRef}
            className="h-full overflow-auto p-3 text-[10px] whitespace-pre-wrap"
            style={{ color: COLORS.textSecondary, fontFamily: MONO_FONT, background: COLORS.recessedBg }}
          >
            {transcriptTail || "Waiting for transcript output..."}
          </pre>
        </div>

        <div className="w-full space-y-3 lg:w-[320px] lg:shrink-0">
          <div className="p-2" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
            <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>Files Modified</div>
            <div className="mt-2 space-y-1">
              {filesTouched.length === 0 ? (
                <div className="text-[10px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>No file events yet.</div>
              ) : filesTouched.map(([file, count]) => (
                <div key={file} className="flex items-center justify-between text-[10px]" style={{ fontFamily: MONO_FONT }}>
                  <span className="truncate pr-2" style={{ color: COLORS.textSecondary }}>{file}</span>
                  <span style={{ color: COLORS.textMuted }}>{count}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="p-2" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
            <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>Tools Called</div>
            <div className="mt-2 space-y-1">
              {toolsCalled.length === 0 ? (
                <div className="text-[10px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>No tool events yet.</div>
              ) : toolsCalled.map(([tool, count]) => (
                <div key={tool} className="flex items-center justify-between text-[10px]" style={{ fontFamily: MONO_FONT }}>
                  <span className="truncate pr-2" style={{ color: COLORS.textSecondary }}>{tool}</span>
                  <span style={{ color: COLORS.textMuted }}>{count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
