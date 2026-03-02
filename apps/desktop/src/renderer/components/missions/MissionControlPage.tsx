import React, { useState, useEffect, useCallback, useMemo } from "react";
import type {
  OrchestratorChatMessage,
  OrchestratorChatThread,
  OrchestratorRunGraph,
  OrchestratorStep,
  OrchestratorAttempt
} from "../../../shared/types";
import { AgentPresencePanel } from "./AgentPresencePanel";
import { ActivityFeed } from "./ActivityFeed";
import { MissionComposer } from "./MissionComposer";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";
import { useThreadEventRefresh } from "../../hooks/useThreadEventRefresh";

type MissionControlPageProps = {
  missionId: string;
  missionTitle: string;
  runId: string;
  graph: OrchestratorRunGraph;
  threads: OrchestratorChatThread[];
  onSendMessage: (threadId: string, content: string) => void;
  onSteerStep: (stepKey: string, message: string) => void;
};

function hashToHue(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

function formatElapsed(startIso: string): string {
  const ms = Math.max(0, Date.now() - Date.parse(startIso));
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

export function MissionControlPage({
  missionId,
  missionTitle,
  runId,
  graph,
  threads,
  onSendMessage,
  onSteerStep
}: MissionControlPageProps) {
  const [messages, setMessages] = useState<OrchestratorChatMessage[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState("");

  // Compute progress
  const { completedCount, totalCount, pct, runningCount } = useMemo(() => {
    const steps = graph.steps;
    const completed = steps.filter((s) => s.status === "succeeded" || s.status === "skipped").length;
    const running = steps.filter((s) => s.status === "running").length;
    const total = steps.length;
    return {
      completedCount: completed,
      totalCount: total,
      pct: total > 0 ? Math.round((completed / total) * 100) : 0,
      runningCount: running
    };
  }, [graph.steps]);

  // Agent color map
  const agentColors = useMemo(() => {
    const map = new Map<string, string>();
    for (const step of graph.steps) {
      const hue = hashToHue(step.stepKey);
      map.set(step.stepKey, `hsl(${hue}, 60%, 65%)`);
    }
    map.set("coordinator", COLORS.accent);
    return map;
  }, [graph.steps]);

  // Step keys for tab completion
  const stepKeys = useMemo(() => graph.steps.map((s) => s.stepKey), [graph.steps]);

  // Elapsed time timer
  useEffect(() => {
    const startTime = graph.run.createdAt;
    setElapsed(formatElapsed(startTime));
    const interval = window.setInterval(() => setElapsed(formatElapsed(startTime)), 1000);
    return () => window.clearInterval(interval);
  }, [graph.run.createdAt]);

  // Fetch all messages across all threads for unified feed
  const refreshAllMessages = useCallback(async () => {
    try {
      const results = await Promise.all(
        threads.map((thread) =>
          window.ade.orchestrator.getThreadMessages({
            missionId,
            threadId: thread.id,
            limit: 100,
          })
        )
      );
      const allMsgs = results.flat();
      // Sort chronologically
      allMsgs.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
      setMessages(allMsgs);
    } catch {
      // ignore
    }
  }, [missionId, threads]);

  useEffect(() => {
    void refreshAllMessages();
  }, [refreshAllMessages]);

  // Listen for thread events
  useThreadEventRefresh({
    missionId,
    onRefresh: refreshAllMessages,
  });

  // Filter messages by selected agent
  const filteredMessages = useMemo(() => {
    if (!selectedAgent) return messages;
    return messages.filter(
      (m) => m.stepKey === selectedAgent || m.role === "orchestrator"
    );
  }, [messages, selectedAgent]);

  // Handle composer send
  const handleComposerSend = useCallback(
    (target: string, content: string) => {
      if (target === "coordinator" || target === "all") {
        // Find the coordinator thread
        const coordThread = threads.find((t) => t.threadType === "coordinator");
        if (coordThread) {
          onSendMessage(coordThread.id, content);
        }
      } else {
        // target is a stepKey — route as steering
        onSteerStep(target, content);
      }
    },
    [threads, onSendMessage, onSteerStep]
  );

  const handleAgentSelect = useCallback((stepKey: string | null) => {
    setSelectedAgent((prev) => (prev === stepKey ? null : stepKey));
  }, []);

  return (
    <div className="flex h-full flex-col" style={{ background: COLORS.pageBg }}>
      {/* Header */}
      <div
        className="px-4 py-3 flex items-center gap-4"
        style={{ borderBottom: `1px solid ${COLORS.border}` }}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="text-sm font-semibold truncate"
              style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}
            >
              {missionTitle}
            </span>
            <span
              className="text-xs px-1.5 py-0.5"
              style={{ background: `${COLORS.success}18`, color: COLORS.success, border: `1px solid ${COLORS.success}30` }}
            >
              {pct}%
            </span>
          </div>
          {/* Progress bar */}
          <div className="mt-1.5 h-1 w-full" style={{ background: COLORS.border }}>
            <div
              className="h-full transition-all duration-500"
              style={{
                width: `${pct}%`,
                background: pct === 100 ? COLORS.success : COLORS.accent
              }}
            />
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs shrink-0" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
          <span>{completedCount}/{totalCount} steps</span>
          <span>{runningCount} running</span>
          <span>{elapsed}</span>
        </div>
      </div>

      {/* Main area: sidebar + feed */}
      <div className="flex flex-1 min-h-0">
        {/* Agent Presence Panel */}
        <AgentPresencePanel
          steps={graph.steps}
          attempts={graph.attempts}
          selectedAgent={selectedAgent}
          onSelectAgent={handleAgentSelect}
          agentColors={agentColors}
        />

        {/* Activity Feed + Composer */}
        <div className="flex flex-1 flex-col min-w-0">
          <ActivityFeed
            messages={filteredMessages}
            agentColors={agentColors}
            selectedAgent={selectedAgent}
          />
          <MissionComposer
            stepKeys={stepKeys}
            onSend={handleComposerSend}
          />
        </div>
      </div>
    </div>
  );
}
