import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import type { OrchestratorRunGraph, OrchestratorTeamMember, OrchestratorStepStatus } from "../../../shared/types";
import { COLORS, MONO_FONT, outlineButton } from "../lanes/laneDesignTokens";
import {
  compactText,
  filterExecutionSteps,
  isRecord,
  stepIntentSummary,
} from "./missionHelpers";
import { relativeWhen } from "../../lib/format";
import { useMissionPolling } from "./useMissionPolling";

const TEAM_STATUS_COLOR: Record<OrchestratorTeamMember["status"], string> = {
  spawning: "#A78BFA",
  active: "#22C55E",
  idle: "#F59E0B",
  completing: "#60A5FA",
  terminated: "#6B7280",
  failed: "#EF4444",
};

const TEAM_STATUS_LABEL: Record<OrchestratorTeamMember["status"], string> = {
  spawning: "Starting",
  active: "Active",
  idle: "Idle",
  completing: "Wrapping up",
  terminated: "Ended",
  failed: "Failed",
};

const TEAM_SOURCE_LABEL: Record<OrchestratorTeamMember["source"], string> = {
  "ade-worker": "Worker",
  "ade-subagent": "Sub-agent",
  "claude-native": "Native",
};

const TERMINATED_AUTO_COLLAPSE_MS = 2 * 60 * 1000;

type ValidatorLineageEntry = {
  stepId: string;
  stepKey: string;
  title: string;
  status: OrchestratorStepStatus;
  role: string;
  model: string;
  autoSpawnedValidation: boolean;
  targetStepId: string | null;
  targetStepKey: string | null;
  targetStepStatus: OrchestratorStepStatus | null;
};

export function WorkTab({ runGraph }: { runGraph: OrchestratorRunGraph | null }) {
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(null);
  const [transcriptTail, setTranscriptTail] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [showAdvancedOutput, setShowAdvancedOutput] = useState(false);
  const [showAdvancedPanels, setShowAdvancedPanels] = useState(false);
  const [showCollapsedTerminated, setShowCollapsedTerminated] = useState(false);
  const [teamMembers, setTeamMembers] = useState<OrchestratorTeamMember[]>([]);
  const transcriptRef = useRef<HTMLPreElement>(null);
  const runId = runGraph?.run.id ?? null;

  const executableSteps = useMemo(() => filterExecutionSteps(runGraph?.steps ?? []), [runGraph?.steps]);
  const executableStepIds = useMemo(() => new Set(executableSteps.map((step) => step.id)), [executableSteps]);

  const sessionAttempts = useMemo(() => {
    if (!runGraph) return [];
    return runGraph.attempts
      .filter((attempt) => executableStepIds.has(attempt.stepId) && typeof attempt.executorSessionId === "string" && attempt.executorSessionId.length > 0)
      .sort((a, b) => {
        const aRunning = a.status === "running" ? 0 : 1;
        const bRunning = b.status === "running" ? 0 : 1;
        if (aRunning !== bRunning) return aRunning - bRunning;
        return Date.parse(b.startedAt ?? b.createdAt) - Date.parse(a.startedAt ?? a.createdAt);
      });
  }, [executableStepIds, runGraph]);

  useEffect(() => {
    if (!sessionAttempts.length) {
      setSelectedAttemptId(null);
      setTranscriptTail("");
      return;
    }
    setSelectedAttemptId((prev) => (prev && sessionAttempts.some((attempt) => attempt.id === prev) ? prev : sessionAttempts[0]!.id));
  }, [sessionAttempts]);

  const selectedAttempt = useMemo(
    () => sessionAttempts.find((attempt) => attempt.id === selectedAttemptId) ?? null,
    [selectedAttemptId, sessionAttempts]
  );

  const selectedStep = useMemo(
    () => executableSteps.find((step) => step.id === selectedAttempt?.stepId) ?? null,
    [executableSteps, selectedAttempt?.stepId]
  );

  const sessionId = selectedAttempt?.executorSessionId ?? null;

  const refreshTeamMembers = useCallback(() => {
    if (!runId) {
      setTeamMembers([]);
      return;
    }
    window.ade.orchestrator.getTeamMembers({ runId }).then(
      (members) => setTeamMembers(Array.isArray(members) ? members : []),
      () => setTeamMembers([])
    );
  }, [runId]);

  useEffect(() => {
    if (!sessionId || !showAdvancedOutput) return;
    let cancelled = false;
    (async () => {
      try {
        const tail = await window.ade.sessions.readTranscriptTail({ sessionId, maxBytes: 16_000 });
        if (!cancelled) setTranscriptTail(tail);
      } catch {
        if (!cancelled) setTranscriptTail("(unable to read worker transcript)");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, showAdvancedOutput]);

  const pollTranscript = useCallback(() => {
    if (!sessionId || !showAdvancedOutput) return;
    window.ade.sessions.readTranscriptTail({ sessionId, maxBytes: 16_000 }).then(
      (tail) => setTranscriptTail(tail),
      () => setTranscriptTail("(unable to read worker transcript)")
    );
  }, [sessionId, showAdvancedOutput]);

  useMissionPolling(pollTranscript, 2_000, !!sessionId && showAdvancedOutput);
  useMissionPolling(refreshTeamMembers, 5_000, !!runId);

  useEffect(() => {
    void refreshTeamMembers();
  }, [refreshTeamMembers]);

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
        typeof payload.file === "string" ? payload.file : null,
      ].filter((entry): entry is string => Boolean(entry));
      for (const file of candidates) {
        files.set(file, (files.get(file) ?? 0) + 1);
      }
    }
    return [...files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
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
    return [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  }, [relatedEvents]);

  const recentTimeline = useMemo(() => {
    return relatedEvents.slice(-8).reverse();
  }, [relatedEvents]);

  const flattenedTeamMembers = useMemo(() => {
    const byCreated = [...teamMembers].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const byId = new Map(byCreated.map((member) => [member.id, member]));
    const children = new Map<string, OrchestratorTeamMember[]>();
    const roots: OrchestratorTeamMember[] = [];

    for (const member of byCreated) {
      const parentId =
        typeof member.parentWorkerId === "string" && member.parentWorkerId.trim().length > 0
          ? member.parentWorkerId.trim()
          : null;
      if (parentId && byId.has(parentId)) {
        const bucket = children.get(parentId) ?? [];
        bucket.push(member);
        children.set(parentId, bucket);
      } else {
        roots.push(member);
      }
    }

    const out: Array<{ member: OrchestratorTeamMember; depth: number }> = [];
    const seen = new Set<string>();

    const walk = (member: OrchestratorTeamMember, depth: number) => {
      if (seen.has(member.id)) return;
      seen.add(member.id);
      out.push({ member, depth });
      const next = children.get(member.id) ?? [];
      for (const child of next) walk(child, Math.min(depth + 1, 4));
    };

    for (const root of roots) walk(root, 0);
    for (const member of byCreated) {
      if (!seen.has(member.id)) walk(member, 0);
    }

    return out;
  }, [teamMembers]);

  const { visibleTeamMembers, collapsedTerminatedCount } = useMemo(() => {
    const now = Date.now();
    let collapsed = 0;
    const visible = flattenedTeamMembers.filter(({ member }) => {
      if (member.status !== "terminated") return true;
      const stampRaw = member.updatedAt || member.createdAt;
      const stampMs = Date.parse(stampRaw);
      const shouldCollapse = !Number.isFinite(stampMs) || now - stampMs >= TERMINATED_AUTO_COLLAPSE_MS;
      if (shouldCollapse) collapsed += 1;
      if (showCollapsedTerminated) return true;
      return !shouldCollapse;
    });
    return {
      visibleTeamMembers: visible,
      collapsedTerminatedCount: collapsed,
    };
  }, [flattenedTeamMembers, showCollapsedTerminated]);

  const validatorLineage = useMemo(() => {
    if (!runGraph) return [] as ValidatorLineageEntry[];
    const stepById = new Map(runGraph.steps.map((step) => [step.id, step] as const));
    const stepIndexById = new Map(runGraph.steps.map((step) => [step.id, step.stepIndex] as const));
    const entries: ValidatorLineageEntry[] = [];
    for (const step of runGraph.steps) {
      const metadata = isRecord(step.metadata) ? step.metadata : {};
      const autoSpawnedValidation = metadata.autoSpawnedValidation === true;
      const stepType = typeof metadata.stepType === "string" ? metadata.stepType.trim().toLowerCase() : "";
      const taskType = typeof metadata.taskType === "string" ? metadata.taskType.trim().toLowerCase() : "";
      const isValidationStep = autoSpawnedValidation || stepType === "validation" || taskType === "validation";
      if (!isValidationStep) continue;
      const targetStepId = typeof metadata.targetStepId === "string" ? metadata.targetStepId.trim() : "";
      const targetStepKey = typeof metadata.targetStepKey === "string" ? metadata.targetStepKey.trim() : "";
      const targetStep = targetStepId.length > 0 ? stepById.get(targetStepId) ?? null : null;
      const role = typeof metadata.role === "string" && metadata.role.trim().length > 0 ? metadata.role.trim() : "validator";
      const model = typeof metadata.modelId === "string" && metadata.modelId.trim().length > 0 ? metadata.modelId.trim() : "unknown";
      entries.push({
        stepId: step.id,
        stepKey: step.stepKey,
        title: step.title,
        status: step.status,
        role,
        model,
        autoSpawnedValidation,
        targetStepId: targetStep?.id ?? (targetStepId.length > 0 ? targetStepId : null),
        targetStepKey: targetStep?.stepKey ?? (targetStepKey.length > 0 ? targetStepKey : null),
        targetStepStatus: targetStep?.status ?? null,
      });
    }
    entries.sort((a, b) => (stepIndexById.get(a.stepId) ?? 0) - (stepIndexById.get(b.stepId) ?? 0));
    return entries;
  }, [runGraph]);

  if (!runGraph) {
    return (
      <div className="flex h-full items-center justify-center text-xs" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
        No orchestrator run yet.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center gap-2 px-3 py-2" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
        <span className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
          Worker view
        </span>
        <select
          value={selectedAttemptId ?? ""}
          onChange={(event) => setSelectedAttemptId(event.target.value)}
          disabled={sessionAttempts.length === 0}
          className="h-7 min-w-[220px] px-2 text-[10px] outline-none"
          style={{ ...outlineButton(), background: COLORS.recessedBg }}
        >
          {sessionAttempts.length === 0 ? <option value="">No worker sessions yet</option> : null}
          {sessionAttempts.map((attempt) => {
            const step = executableSteps.find((entry) => entry.id === attempt.stepId);
            return (
              <option key={attempt.id} value={attempt.id}>
                [{attempt.status}] {(step?.title ?? attempt.stepId.slice(0, 8)).slice(0, 70)}
              </option>
            );
          })}
        </select>
        <span className="ml-auto text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
          {selectedStep ? `Phase: ${String((selectedStep.metadata as Record<string, unknown> | null)?.phaseName ?? "Development")}` : ""}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        <div className="min-h-0 min-w-0 flex-1 space-y-3 overflow-auto">
          <div className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
            {selectedStep && selectedAttempt ? (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                      Current worker
                    </div>
                    <div className="mt-1 text-sm font-semibold" style={{ color: COLORS.textPrimary }}>
                      {selectedStep.title}
                    </div>
                    <div className="mt-1 text-[11px] leading-relaxed" style={{ color: COLORS.textSecondary }}>
                      {stepIntentSummary(selectedStep)}
                    </div>
                  </div>
                  <div
                    className="px-2 py-1 text-[9px] font-bold uppercase tracking-[1px]"
                    style={{
                      background: `${selectedAttempt.status === "running" ? COLORS.accent : COLORS.textMuted}18`,
                      border: `1px solid ${selectedAttempt.status === "running" ? COLORS.accent : COLORS.border}`,
                      color: selectedAttempt.status === "running" ? COLORS.accent : COLORS.textMuted,
                      fontFamily: MONO_FONT,
                    }}
                  >
                    {selectedAttempt.status}
                  </div>
                </div>

                <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                  {[
                    { label: "Session", value: selectedAttempt.executorSessionId ?? "--" },
                    { label: "Started", value: selectedAttempt.startedAt ? relativeWhen(selectedAttempt.startedAt) : "--" },
                    { label: "Executor", value: selectedAttempt.executorKind },
                    { label: "Latest activity", value: recentTimeline[0] ? compactText(recentTimeline[0].eventType.replace(/_/g, " "), 42) : "Waiting" },
                  ].map((entry) => (
                    <div key={entry.label} className="px-2 py-2" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
                      <div className="text-[9px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                        {entry.label}
                      </div>
                      <div className="mt-1 text-[11px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>
                        {entry.value}
                      </div>
                    </div>
                  ))}
                </div>

                {selectedAttempt.errorMessage ? (
                  <div className="mt-3 px-2 py-2 text-[11px]" style={{ background: `${COLORS.danger}12`, border: `1px solid ${COLORS.danger}28`, color: COLORS.danger }}>
                    {compactText(selectedAttempt.errorMessage, 220)}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="text-[11px]" style={{ color: COLORS.textMuted }}>
                Worker sessions will appear here once a real execution attempt starts.
              </div>
            )}
          </div>

          <div className="grid gap-3 xl:grid-cols-2">
            <div className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
              <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                Files changed
              </div>
              <div className="mt-2 space-y-1">
                {filesTouched.length === 0 ? (
                  <div className="text-[10px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
                    No file activity recorded yet.
                  </div>
                ) : filesTouched.map(([file, count]) => (
                  <div key={file} className="flex items-center justify-between text-[10px]" style={{ fontFamily: MONO_FONT }}>
                    <span className="truncate pr-2" style={{ color: COLORS.textSecondary }}>{file}</span>
                    <span style={{ color: COLORS.textMuted }}>{count}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
              <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                Tools used
              </div>
              <div className="mt-2 space-y-1">
                {toolsCalled.length === 0 ? (
                  <div className="text-[10px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
                    No tool activity recorded yet.
                  </div>
                ) : toolsCalled.map(([tool, count]) => (
                  <div key={tool} className="flex items-center justify-between text-[10px]" style={{ fontFamily: MONO_FONT }}>
                    <span className="truncate pr-2" style={{ color: COLORS.textSecondary }}>{tool}</span>
                    <span style={{ color: COLORS.textMuted }}>{count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                Recent worker signals
              </div>
              <button
                type="button"
                onClick={() => setShowAdvancedOutput((prev) => !prev)}
                className="text-[10px] font-bold uppercase tracking-[1px]"
                style={{ color: showAdvancedOutput ? COLORS.accent : COLORS.textMuted, fontFamily: MONO_FONT }}
              >
                {showAdvancedOutput ? "Hide raw output" : "Show raw output"}
              </button>
            </div>
            <div className="mt-2 space-y-1">
              {recentTimeline.length === 0 ? (
                <div className="text-[10px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
                  No worker events yet.
                </div>
              ) : recentTimeline.map((event) => (
                <div key={event.id ?? `${event.eventType}:${event.occurredAt}`} className="px-2 py-1.5 text-[10px]" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
                  <div className="flex items-center justify-between gap-2" style={{ fontFamily: MONO_FONT }}>
                    <span style={{ color: COLORS.textPrimary }}>{event.eventType.replace(/_/g, " ")}</span>
                    <span style={{ color: COLORS.textMuted }}>{relativeWhen(event.occurredAt)}</span>
                  </div>
                  {(() => {
                    const payload = isRecord(event.payload) ? event.payload : {};
                    const summaryCandidate =
                      typeof payload.summary === "string"
                        ? payload.summary
                        : typeof payload.message === "string"
                          ? payload.message
                          : typeof payload.reason === "string"
                            ? payload.reason
                            : "";
                    return summaryCandidate ? (
                      <div className="mt-1" style={{ color: COLORS.textSecondary }}>
                        {compactText(summaryCandidate, 180)}
                      </div>
                    ) : null;
                  })()}
                </div>
              ))}
            </div>

            {showAdvancedOutput && (
              <div className="mt-3" style={{ border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg }}>
                <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
                  <span className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                    Raw worker transcript
                  </span>
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
                  className="max-h-[320px] overflow-auto p-3 text-[10px] whitespace-pre-wrap"
                  style={{ color: COLORS.textSecondary, fontFamily: MONO_FONT }}
                >
                  {sessionId ? (transcriptTail || "Waiting for transcript output...") : "No worker session selected."}
                </pre>
              </div>
            )}
          </div>
        </div>

        <div className="w-full space-y-3 lg:w-[320px] lg:shrink-0">
          <div className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
            <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
              Collaborators
            </div>
            {collapsedTerminatedCount > 0 ? (
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="text-[9px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
                  {collapsedTerminatedCount} ended collaborator{collapsedTerminatedCount === 1 ? "" : "s"} hidden
                </span>
                <button
                  type="button"
                  className="text-[9px] uppercase tracking-[0.5px]"
                  style={{ color: showCollapsedTerminated ? COLORS.textSecondary : COLORS.accent, fontFamily: MONO_FONT }}
                  onClick={() => setShowCollapsedTerminated((prev) => !prev)}
                >
                  {showCollapsedTerminated ? "Hide" : "Show"}
                </button>
              </div>
            ) : null}
            <div className="mt-2 max-h-[220px] space-y-1 overflow-auto pr-1">
              {visibleTeamMembers.length === 0 ? (
                <div className="text-[10px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
                  No collaborators registered yet.
                </div>
              ) : visibleTeamMembers.map(({ member, depth }) => {
                const metadata = isRecord(member.metadata) ? member.metadata : {};
                const roleName =
                  typeof metadata.teamRole === "string" && metadata.teamRole.trim().length > 0
                    ? metadata.teamRole.trim()
                    : member.role;
                const taskCount = Array.isArray(member.claimedTaskIds) ? member.claimedTaskIds.length : 0;
                return (
                  <div
                    key={member.id}
                    className="border px-2 py-1.5"
                    style={{
                      marginLeft: `${depth * 10}px`,
                      borderColor: COLORS.border,
                      background: COLORS.recessedBg,
                    }}
                  >
                    <div className="flex items-center gap-1">
                      <span
                        className="inline-block h-1.5 w-1.5 rounded-full"
                        style={{ background: TEAM_STATUS_COLOR[member.status] ?? COLORS.textMuted }}
                      />
                      <span className="truncate text-[10px] font-bold" style={{ color: COLORS.textSecondary, fontFamily: MONO_FONT }}>
                        {depth > 0 ? `↳ ${member.id}` : member.id}
                      </span>
                      <span className="ml-auto text-[9px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                        {TEAM_STATUS_LABEL[member.status]}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1 text-[9px]" style={{ fontFamily: MONO_FONT }}>
                      <span className="border px-1 py-0.5" style={{ borderColor: COLORS.border, color: COLORS.textSecondary }}>
                        {roleName}
                      </span>
                      <span className="border px-1 py-0.5" style={{ borderColor: COLORS.border, color: COLORS.textSecondary }}>
                        {TEAM_SOURCE_LABEL[member.source]}
                      </span>
                      <span className="border px-1 py-0.5" style={{ borderColor: COLORS.border, color: COLORS.textMuted }}>
                        {member.model}
                      </span>
                      {taskCount > 0 ? (
                        <span className="border px-1 py-0.5" style={{ borderColor: COLORS.border, color: COLORS.textMuted }}>
                          tasks:{taskCount}
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                Advanced panels
              </div>
              <button
                type="button"
                onClick={() => setShowAdvancedPanels((prev) => !prev)}
                className="text-[10px] font-bold uppercase tracking-[1px]"
                style={{ color: showAdvancedPanels ? COLORS.accent : COLORS.textMuted, fontFamily: MONO_FONT }}
              >
                {showAdvancedPanels ? "Hide" : "Show"}
              </button>
            </div>
            {showAdvancedPanels ? (
              <div className="mt-2 space-y-2">
                <div className="p-2" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
                  <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                    Quality checks
                  </div>
                  <div className="mt-2 space-y-1">
                    {validatorLineage.length === 0 ? (
                      <div className="text-[10px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
                        No validator steps detected.
                      </div>
                    ) : validatorLineage.map((entry) => (
                      <div key={entry.stepId} className="border px-2 py-1.5" style={{ borderColor: `${COLORS.warning}50`, background: `${COLORS.warning}10` }}>
                        <div className="flex items-center gap-1">
                          <span className="text-[9px] font-bold uppercase tracking-[0.5px]" style={{ color: COLORS.warning, fontFamily: MONO_FONT }}>
                            Validation
                          </span>
                          <span className="truncate text-[10px]" style={{ color: COLORS.textSecondary, fontFamily: MONO_FONT }}>
                            {entry.stepKey}
                          </span>
                          <span className="ml-auto text-[9px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                            {entry.status}
                          </span>
                        </div>
                        <div className="mt-1 text-[9px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                          target: {entry.targetStepKey ?? "unlinked"}{entry.targetStepStatus ? ` (${entry.targetStepStatus})` : ""}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-2 text-[10px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
                Validator lineage and other low-level worker internals live here when you need them.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
