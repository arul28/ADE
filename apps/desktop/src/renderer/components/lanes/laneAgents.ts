import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentChatSessionSummary,
  TerminalSessionSummary,
  TerminalToolType,
} from "../../../shared/types";
import {
  backgroundWorkFromSummary,
  totalBackgroundWork,
  type SessionBackgroundWork,
} from "../../../shared/sessionCanonicalState";
import { listSessionsCached } from "../../lib/sessionListCache";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";

/**
 * Unified live state for an agent row, glanceable at a list level.
 *
 * `monitoring` is a live state, not a calm one — it sorts and pulses with
 * `working`. It exists so a lane whose agents are only watching CI reads
 * differently from one where three agents are mid-build.
 */
export type LaneAgentActivity = "working" | "monitoring" | "awaiting-input" | "idle" | "ended";

export type LaneAgent = {
  /** Session id (chat or terminal) — used to open the agent in the Work tab. */
  sessionId: string;
  laneId: string;
  kind: "chat" | "cli";
  name: string;
  /** Model id (registry) when known; else the runtime model ref. */
  modelId: string | null;
  /** Display label for the model/provider, e.g. "Opus 4.8" or "Codex". */
  providerLabel: string;
  activity: LaneAgentActivity;
  /** Short hint for the activity pulse (last output / awaiting prompt). */
  lastHint: string | null;
  /** Sort key — most recently active first. */
  lastActivityAt: string;
};

/** CLI tool types that are agents (not plain shells). */
const SHELL_TOOL_TYPES = new Set<TerminalToolType>(["shell"]);

/**
 * A session whose turn is over but whose background jobs are not is still a
 * live agent. Without this the Lanes list showed nothing at all while a
 * background fleet ran — the row read "idle" for the whole of it.
 */
function backgroundActivity(summary: {
  backgroundWork?: SessionBackgroundWork;
  activeBackgroundTaskCount?: number;
}): LaneAgentActivity | null {
  const work = backgroundWorkFromSummary(summary);
  if (totalBackgroundWork(work) <= 0) return null;
  return (work?.workingCount ?? 0) > 0 ? "working" : "monitoring";
}

function chatActivity(summary: AgentChatSessionSummary): LaneAgentActivity {
  if (summary.status === "ended") return "ended";
  if (summary.awaitingInput) return "awaiting-input";
  if (summary.status === "active") return "working";
  return backgroundActivity(summary) ?? "idle";
}

function cliActivity(summary: TerminalSessionSummary): LaneAgentActivity {
  if (
    summary.pendingInputItemId
    || summary.attentionRequestedAt
    || summary.attentionSource === "provider_structured"
  ) return "awaiting-input";
  switch (summary.runtimeState) {
    case "running": return "working";
    case "waiting-input": return backgroundActivity(summary) ?? "idle";
    case "exited":
    case "killed": return "ended";
    default: return backgroundActivity(summary) ?? "idle";
  }
}

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  droid: "Droid",
  opencode: "OpenCode",
};

function cliProviderLabel(toolType: TerminalToolType | null): string {
  if (!toolType) return "CLI";
  const base = toolType.replace(/-orchestrated$/, "").replace(/-cli$/, "");
  return PROVIDER_LABELS[base] ?? "CLI";
}

function chatAgentFrom(summary: AgentChatSessionSummary): LaneAgent {
  return {
    sessionId: summary.sessionId,
    laneId: summary.laneId,
    kind: "chat",
    name: summary.title?.trim() || summary.goal?.trim() || "Chat agent",
    modelId: summary.modelId ?? summary.model ?? null,
    providerLabel: PROVIDER_LABELS[summary.provider] ?? summary.provider,
    activity: chatActivity(summary),
    lastHint: summary.awaitingInput
      ? "Awaiting your input"
      : backgroundHint(summary, summary.status === "active")
        ?? summary.summary?.trim()
        ?? summary.lastOutputPreview?.trim()
        ?? null,
    lastActivityAt: summary.lastActivityAt ?? summary.startedAt,
  };
}

/**
 * Background work is the more useful hint than a stale last-output preview:
 * the preview describes the turn that already ended, the count describes what
 * is still running.
 *
 * Callers pass `turnActive` explicitly rather than having this re-read a status
 * field — chat and CLI summaries spell "a turn is running" differently
 * (`status: "active"` vs `runtimeState: "running"`), and a single stringly-typed
 * guard here would silently match neither for one of them.
 */
function backgroundHint(
  summary: {
    backgroundWork?: SessionBackgroundWork;
    activeBackgroundTaskCount?: number;
  },
  turnActive: boolean,
): string | null {
  // A live turn's own output is the better story than a job count.
  if (turnActive) return null;
  const work = backgroundWorkFromSummary(summary);
  const total = totalBackgroundWork(work);
  if (total <= 0) return null;
  const noun = (work?.workingCount ?? 0) > 0 ? "background job" : "monitor";
  return `${total} ${noun}${total === 1 ? "" : "s"} still running`;
}

function cliAgentFrom(summary: TerminalSessionSummary): LaneAgent {
  return {
    sessionId: summary.id,
    laneId: summary.laneId,
    kind: "cli",
    name: summary.title?.trim() || summary.goal?.trim() || cliProviderLabel(summary.toolType),
    modelId: null,
    providerLabel: cliProviderLabel(summary.toolType),
    activity: cliActivity(summary),
    lastHint:
      summary.pendingInputItemId
      || summary.attentionRequestedAt
      || summary.attentionSource === "provider_structured"
      ? "Awaiting your input"
      : backgroundHint(summary, summary.runtimeState === "running")
        ?? summary.summary?.trim()
        ?? summary.lastOutputPreview?.trim()
        ?? null,
    lastActivityAt: summary.endedAt ?? summary.startedAt,
  };
}

/**
 * Merges a lane's ADE chat sessions and CLI agent sessions (excluding plain
 * shells) into a single agent list, dead/ended agents last. Live-refreshes on
 * chat + session change events so the activity pulse stays glanceable.
 */
export function buildLaneAgents(
  chatSessions: AgentChatSessionSummary[],
  cliSessions: TerminalSessionSummary[],
): LaneAgent[] {
  const agents: LaneAgent[] = [];
  const chatSessionIds = new Set<string>();
  for (const summary of chatSessions) {
    if (summary.archivedAt) continue;
    if (chatSessionIds.has(summary.sessionId)) continue;
    chatSessionIds.add(summary.sessionId);
    agents.push(chatAgentFrom(summary));
  }
  const cliSessionIds = new Set<string>();
  for (const summary of cliSessions) {
    if (summary.archivedAt) continue;
    if (SHELL_TOOL_TYPES.has(summary.toolType ?? "shell")) continue;
    if (summary.chatSessionId) continue; // child terminal of a chat — not a standalone agent
    if (chatSessionIds.has(summary.id)) continue; // persisted chat session mirrored through sessions.list
    if (cliSessionIds.has(summary.id)) continue;
    cliSessionIds.add(summary.id);
    agents.push(cliAgentFrom(summary));
  }
  // Live agents first (working → awaiting → idle), ended last; within a bucket,
  // most recently active first.
  const rank: Record<LaneAgentActivity, number> = {
    working: 0,
    monitoring: 1,
    "awaiting-input": 2,
    idle: 3,
    ended: 4,
  };
  return agents.sort((a, b) => {
    if (rank[a.activity] !== rank[b.activity]) return rank[a.activity] - rank[b.activity];
    return b.lastActivityAt.localeCompare(a.lastActivityAt);
  });
}

/**
 * Hook: returns the merged agent list for a set of lanes, keyed by laneId.
 * Pass the lane ids you want enumerated (usually the visible lanes). Refreshes
 * on agent-chat + terminal-session change events, debounced.
 */
export function useLaneAgents(laneIds: string[]): Map<string, LaneAgent[]> {
  const [byLane, setByLane] = useState<Map<string, LaneAgent[]>>(new Map());
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const laneKey = useMemo(() => [...laneIds].sort().join(","), [laneIds]);
  const refreshTimerRef = useRef<number | null>(null);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;
    try {
      do {
        refreshQueuedRef.current = false;

        const ids = laneKey ? laneKey.split(",") : [];
        if (!ids.length) {
          setByLane(new Map());
          return;
        }
        const [chat, cli] = await Promise.all([
          window.ade.agentChat.list({}).catch(() => []),
          listSessionsCached({ limit: 500 }).catch(() => []),
        ]);
        const requestedLaneIds = new Set(ids);
        const chatByLane = new Map<string, AgentChatSessionSummary[]>();
        for (const session of chat) {
          if (!requestedLaneIds.has(session.laneId)) continue;
          const rows = chatByLane.get(session.laneId) ?? [];
          rows.push(session);
          chatByLane.set(session.laneId, rows);
        }
        const cliByLane = new Map<string, TerminalSessionSummary[]>();
        for (const session of cli) {
          if (!requestedLaneIds.has(session.laneId)) continue;
          const rows = cliByLane.get(session.laneId) ?? [];
          rows.push(session);
          cliByLane.set(session.laneId, rows);
        }
        const entries = ids.map((laneId) => [
          laneId,
          buildLaneAgents(chatByLane.get(laneId) ?? [], cliByLane.get(laneId) ?? []),
        ] as const);
        setByLane(new Map(entries));
      } while (refreshQueuedRef.current);
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [laneKey]);

  useEffect(() => {
    // Re-run when the active project changes; listSessionsCached keys by active project.
    void projectRoot;
    void refresh();
  }, [projectRoot, refresh]);

  useEffect(() => {
    const scheduleRefresh = () => {
      if (refreshTimerRef.current != null) return;
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        void refresh();
      }, 350);
    };
    const offChat = window.ade.agentChat.onEvent(scheduleRefresh);
    const offSession = window.ade.sessions.onChanged(scheduleRefresh);
    return () => {
      if (refreshTimerRef.current != null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      offChat?.();
      offSession?.();
    };
  }, [refresh]);

  return byLane;
}
