import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import type { OrchestratorRunGraph, OrchestratorTeamMember } from "../../../shared/types";
import { COLORS, MONO_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { isRecord } from "./missionHelpers";
import { useMissionPolling } from "./useMissionPolling";

const TEAM_STATUS_COLOR: Record<OrchestratorTeamMember["status"], string> = {
  spawning: "#A78BFA",
  active: "#22C55E",
  idle: "#F59E0B",
  completing: "#60A5FA",
  terminated: "#6B7280",
  failed: "#EF4444",
};

const TEAM_SOURCE_LABEL: Record<OrchestratorTeamMember["source"], string> = {
  "ade-worker": "ADE WORKER",
  "ade-subagent": "SUBAGENT",
  "claude-native": "NATIVE",
};
const TERMINATED_AUTO_COLLAPSE_MS = 2 * 60 * 1000;

function teamStatusLabel(status: OrchestratorTeamMember["status"]): string {
  return status.replace(/_/g, " ").toUpperCase();
}

export function WorkTab({ runGraph }: { runGraph: OrchestratorRunGraph | null }) {
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(null);
  const [transcriptTail, setTranscriptTail] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [showCollapsedTerminated, setShowCollapsedTerminated] = useState(false);
  const [teamMembers, setTeamMembers] = useState<OrchestratorTeamMember[]>([]);
  const transcriptRef = useRef<HTMLPreElement>(null);
  const runId = runGraph?.run.id ?? null;

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

  const sessionId = selectedAttempt?.executorSessionId ?? null;

  const refreshTeamMembers = useCallback(() => {
    if (!runId) {
      setTeamMembers([]);
      return;
    }
    window.ade.orchestrator.getTeamMembers({ runId }).then(
      (members) => setTeamMembers(Array.isArray(members) ? members : []),
      () => setTeamMembers([]),
    );
  }, [runId]);

  // Initial transcript load
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const tail = await window.ade.sessions.readTranscriptTail({ sessionId, maxBytes: 16_000 });
        if (!cancelled) setTranscriptTail(tail);
      } catch {
        if (!cancelled) setTranscriptTail("(unable to read worker transcript)");
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  // Polling via shared coordinator (replaces per-component setInterval)
  const pollTranscript = useCallback(() => {
    if (!sessionId) return;
    window.ade.sessions.readTranscriptTail({ sessionId, maxBytes: 16_000 }).then(
      (tail) => setTranscriptTail(tail),
      () => setTranscriptTail("(unable to read worker transcript)")
    );
  }, [sessionId]);

  useMissionPolling(pollTranscript, 2_000, !!sessionId);
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

  const flattenedTeamMembers = useMemo(() => {
    const byCreated = [...teamMembers].sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
    );
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
        <span className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>Follow</span>
        <select
          value={selectedAttemptId ?? ""}
          onChange={(event) => setSelectedAttemptId(event.target.value)}
          disabled={activeAttempts.length === 0}
          className="h-7 px-2 text-[10px] outline-none"
          style={{ ...outlineButton(), background: COLORS.recessedBg }}
        >
          {activeAttempts.length === 0 ? (
            <option value="">No active attempts</option>
          ) : null}
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
            {sessionId
              ? (transcriptTail || "Waiting for transcript output...")
              : "No active worker selected."}
          </pre>
        </div>

        <div className="w-full space-y-3 lg:w-[320px] lg:shrink-0">
          <div className="p-2" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
            <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
              Team Members
            </div>
            {collapsedTerminatedCount > 0 ? (
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="text-[9px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
                  {collapsedTerminatedCount} terminated member{collapsedTerminatedCount === 1 ? "" : "s"} auto-collapsed
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
                  No team members registered.
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
                    className="rounded-none border px-2 py-1.5"
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
                        {teamStatusLabel(member.status)}
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
