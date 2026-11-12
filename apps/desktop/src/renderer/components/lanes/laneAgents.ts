import { PROVIDER_DISPLAY_NAME } from "../../../shared/providers";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentChatEventEnvelope,
  AgentChatSessionSummary,
  OpenProjectBinding,
  TerminalSessionSummary,
  TerminalToolType,
} from "../../../shared/types";
import {
  backgroundWorkFromSummary,
  totalBackgroundWork,
  type SessionBackgroundWork,
} from "../../../shared/sessionCanonicalState";
import { prWatchHint } from "../../../shared/prWatch";
import { canonicalInputFromSummary, sessionCanonicalUiState } from "../../lib/terminalAttention";
import { listSessionsCached } from "../../lib/sessionListCache";
import { shouldRefreshSessionListForChatEvent } from "../../lib/chatSessionEvents";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import { cacheScopePin } from "../../lib/tabBindingKey";

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
 * background fleet ran — the row read "idle" for the whole of it. A live PR
 * watch counts the same way: it wakes the chat on the next change.
 */
function backgroundActivity(summary: {
  backgroundWork?: SessionBackgroundWork;
  activeBackgroundTaskCount?: number;
  activePrWatch?: TerminalSessionSummary["activePrWatch"];
}): LaneAgentActivity | null {
  const work = backgroundWorkFromSummary(summary);
  if ((work?.workingCount ?? 0) > 0) return "working";
  return totalBackgroundWork(work) > 0 || summary.activePrWatch ? "monitoring" : null;
}

/**
 * The activity the Work tab would show for this session row. The Work list,
 * the Activity pane and iOS all read the canonical session state, so a lane
 * view that used its own mapping could call a chat "Idle" while Work calls it
 * "Working". When a terminal row exists, it decides.
 */
function canonicalActivity(summary: TerminalSessionSummary): LaneAgentActivity {
  const state = sessionCanonicalUiState(canonicalInputFromSummary(summary));
  switch (state.phase) {
    case "starting":
      return "working";
    case "running":
      return state.liveness && state.liveness !== "turn" ? "monitoring" : "working";
    case "needs_you":
      return "awaiting-input";
    case "ended":
    case "settled":
    case "stopped":
    case "failed":
      return "ended";
    default:
      return "idle";
  }
}

function chatActivity(summary: AgentChatSessionSummary): LaneAgentActivity {
  if (summary.status === "ended") return "ended";
  if (summary.awaitingInput) return "awaiting-input";
  if (summary.status === "active") return "working";
  return backgroundActivity(summary) ?? "idle";
}

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  droid: "Droid",
  muse: PROVIDER_DISPLAY_NAME.muse,
  opencode: "OpenCode",
};

function cliProviderLabel(toolType: TerminalToolType | null): string {
  if (!toolType) return "CLI";
  const base = toolType.replace(/-orchestrated$/, "").replace(/-cli$/, "");
  return PROVIDER_LABELS[base] ?? "CLI";
}

function chatAgentFrom(summary: AgentChatSessionSummary, row: TerminalSessionSummary | undefined): LaneAgent {
  return {
    sessionId: summary.sessionId,
    laneId: summary.laneId,
    kind: "chat",
    name: summary.title?.trim() || summary.goal?.trim() || "Chat agent",
    modelId: summary.modelId ?? summary.model ?? null,
    providerLabel: PROVIDER_LABELS[summary.provider] ?? summary.provider,
    activity: row ? canonicalActivity(row) : chatActivity(summary),
    lastHint: summary.awaitingInput
      ? "Awaiting your input"
      : liveWorkHint(summary, summary.status === "active")
        ?? summary.summary?.trim()
        ?? summary.lastOutputPreview?.trim()
        ?? null,
    lastActivityAt: summary.lastActivityAt ?? summary.startedAt,
  };
}

/**
 * Live work (background jobs, a PR watch) is a more useful hint than a stale
 * last-output preview: the preview describes the turn that already ended, this
 * describes what is still going.
 *
 * Callers pass `turnActive` explicitly rather than having this re-read a status
 * field — chat and CLI summaries spell "a turn is running" differently
 * (`status: "active"` vs `runtimeState: "running"`), and a single stringly-typed
 * guard here would silently match neither for one of them.
 */
function liveWorkHint(
  summary: {
    backgroundWork?: SessionBackgroundWork;
    activeBackgroundTaskCount?: number;
    activePrWatch?: TerminalSessionSummary["activePrWatch"];
  },
  turnActive: boolean,
): string | null {
  // A live turn's own output is the better story than a job count.
  if (turnActive) return null;
  const work = backgroundWorkFromSummary(summary);
  const total = totalBackgroundWork(work);
  if (total <= 0) {
    if (!summary.activePrWatch) return null;
    const hint = prWatchHint(summary.activePrWatch);
    return hint ? `Shipping ${hint}` : "Shipping";
  }
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
    activity: canonicalActivity(summary),
    lastHint:
      summary.pendingInputItemId
      || summary.attentionRequestedAt
      || summary.attentionSource === "provider_structured"
      ? "Awaiting your input"
      : liveWorkHint(summary, summary.runtimeState === "running")
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
  // A chat is mirrored as a terminal row with the same id; that row carries
  // the canonical state the Work tab shows.
  const rowById = new Map(cliSessions.map((row) => [row.id, row]));
  const chatSessionIds = new Set<string>();
  for (const summary of chatSessions) {
    if (summary.archivedAt) continue;
    if (chatSessionIds.has(summary.sessionId)) continue;
    chatSessionIds.add(summary.sessionId);
    agents.push(chatAgentFrom(summary, rowById.get(summary.sessionId)));
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

const EMPTY_LANE_AGENTS: Map<string, LaneAgent[]> = new Map();

function sameLaneAgents(a: readonly LaneAgent[] | undefined, b: readonly LaneAgent[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    if (
      left.sessionId !== right.sessionId
      || left.laneId !== right.laneId
      || left.kind !== right.kind
      || left.name !== right.name
      || left.modelId !== right.modelId
      || left.providerLabel !== right.providerLabel
      || left.activity !== right.activity
      || left.lastHint !== right.lastHint
      || left.lastActivityAt !== right.lastActivityAt
    ) return false;
  }
  return true;
}

/**
 * Hook: returns the merged agent list for a set of lanes, keyed by laneId.
 * Pass the lane ids you want enumerated (usually the visible lanes). Refreshes
 * on agent-chat + terminal-session change events, debounced.
 *
 * A chat that starts, ends, asks or changes state (`shouldRefreshSessionListForChatEvent`)
 * re-reads every chat. Any other event of a chat already listed (streamed text
 * moves its preview) re-reads that chat's summary alone: a full list summarizes
 * up to 500 chats on the brain, and it ran about three times a second while any
 * chat streamed. Events of chats the page does not list are ignored, and with
 * no lanes (the page parked) nothing is read or subscribed.
 *
 * `pin` is the machine of the listed lanes. Null (the machine is offline):
 * nothing is read or subscribed.
 */
export function useLaneAgents(laneIds: string[], pin: OpenProjectBinding | null): Map<string, LaneAgent[]> {
  const [byLane, setByLane] = useState<Map<string, LaneAgent[]>>(EMPTY_LANE_AGENTS);
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const laneKey = useMemo(() => [...laneIds].sort().join(","), [laneIds]);
  const refreshTimerRef = useRef<number | null>(null);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  /** The next refresh re-reads every chat (true), or only `staleChatIdsRef`. */
  const fullRefreshDueRef = useRef(true);
  const staleChatIdsRef = useRef(new Set<string>());
  /** The chats of the listed lanes, by id, as the last read left them. */
  const chatsByIdRef = useRef(new Map<string, AgentChatSessionSummary>());
  const byLaneRef = useRef(byLane);

  const commit = useCallback((next: Map<string, LaneAgent[]>) => {
    const previous = byLaneRef.current;
    let changed = previous.size !== next.size;
    const merged = new Map<string, LaneAgent[]>();
    for (const [laneId, agents] of next) {
      const before = previous.get(laneId);
      if (sameLaneAgents(before, agents)) {
        merged.set(laneId, before!);
      } else {
        changed = true;
        merged.set(laneId, agents);
      }
    }
    if (!changed) return;
    byLaneRef.current = merged;
    setByLane(merged);
  }, []);

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
        const listPin = pinRef.current;
        if (!ids.length || !listPin) {
          chatsByIdRef.current = new Map();
          if (byLaneRef.current.size > 0) {
            byLaneRef.current = EMPTY_LANE_AGENTS;
            setByLane(EMPTY_LANE_AGENTS);
          }
          return;
        }
        const requestedLaneIds = new Set(ids);
        const full = fullRefreshDueRef.current || chatsByIdRef.current.size === 0;
        const staleIds = [...staleChatIdsRef.current];
        fullRefreshDueRef.current = false;
        staleChatIdsRef.current = new Set();
        const [chat, cli] = await Promise.all([
          window.ade.agentChat.list(full ? {} : { sessionIds: staleIds }, listPin).catch(() => null),
          // The session cache is keyed for the tab's machine only.
          (cacheScopePin(listPin)
            ? window.ade.sessions.list({ limit: 500 }, listPin)
            : listSessionsCached({ limit: 500 })
          ).catch(() => []),
        ]);
        if (full) {
          const chatsById = new Map<string, AgentChatSessionSummary>();
          for (const session of chat ?? []) {
            if (requestedLaneIds.has(session.laneId)) chatsById.set(session.sessionId, session);
          }
          chatsByIdRef.current = chatsById;
        } else if (chat) {
          // A brain without `sessionIds` returns every chat; only the named ones are taken.
          const wanted = new Set(staleIds);
          const chatsById = new Map(chatsByIdRef.current);
          for (const session of chat) {
            if (!wanted.has(session.sessionId)) continue;
            if (requestedLaneIds.has(session.laneId)) chatsById.set(session.sessionId, session);
            else chatsById.delete(session.sessionId);
          }
          chatsByIdRef.current = chatsById;
        } else {
          // The read failed; the next event reads everything again.
          fullRefreshDueRef.current = true;
        }
        const chatByLane = new Map<string, AgentChatSessionSummary[]>();
        for (const session of chatsByIdRef.current.values()) {
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
        commit(new Map(entries));
      } while (refreshQueuedRef.current);
    } finally {
      refreshInFlightRef.current = false;
    }
    // `pinKey` carries the pin's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commit, laneKey, pinKey]);

  useEffect(() => {
    // Re-run when the active project changes; listSessionsCached keys by active project.
    void projectRoot;
    fullRefreshDueRef.current = true;
    void refresh();
  }, [projectRoot, refresh]);

  useEffect(() => {
    const subscribedPin = pinRef.current;
    if (!laneKey || !subscribedPin) return;
    const scheduleRefresh = () => {
      if (refreshTimerRef.current != null) return;
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        void refresh();
      }, 350);
    };
    const onChatEvent = (envelope: AgentChatEventEnvelope) => {
      if (shouldRefreshSessionListForChatEvent(envelope)) {
        fullRefreshDueRef.current = true;
      } else if (chatsByIdRef.current.has(envelope.sessionId)) {
        staleChatIdsRef.current.add(envelope.sessionId);
      } else {
        return;
      }
      scheduleRefresh();
    };
    const onSessionsChanged = () => {
      fullRefreshDueRef.current = true;
      scheduleRefresh();
    };
    const offChat = window.ade.agentChat.onEvent(onChatEvent, subscribedPin);
    const offSession = window.ade.sessions.onChanged(onSessionsChanged, subscribedPin);
    return () => {
      if (refreshTimerRef.current != null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      offChat?.();
      offSession?.();
    };
    // `refresh` changes with `pinKey`, which carries the pin's identity.
  }, [laneKey, refresh]);

  return byLane;
}
