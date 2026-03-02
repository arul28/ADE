import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { TerminalSessionSummary, TerminalSessionStatus, TerminalToolType } from "../../../shared/types";
import { getModelById, resolveModelAlias } from "../../../shared/modelRegistry";
import { useAppStore } from "../../state/appStore";

function isChatToolType(toolType: string | null | undefined): boolean {
  return toolType === "codex-chat" || toolType === "claude-chat" || toolType === "ai-chat";
}

function inferToolFromResumeCommand(command: string): string | null {
  const n = command.trim().toLowerCase();
  if (n.startsWith("claude ")) return "claude";
  if (n.startsWith("codex ")) return "codex";
  if (n.startsWith("gemini ")) return "gemini";
  return null;
}

function resolveModelDescriptor(modelIdOrAlias: string | null | undefined) {
  const raw = String(modelIdOrAlias ?? "").trim();
  if (!raw.length) return null;
  return getModelById(raw) ?? resolveModelAlias(raw);
}

export function useWorkSessions() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const lanes = useAppStore((s) => s.lanes);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const focusSession = useAppStore((s) => s.focusSession);
  const selectLane = useAppStore((s) => s.selectLane);

  const [sessions, setSessions] = useState<TerminalSessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterLaneId, setFilterLaneId] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<TerminalSessionStatus | "all">("all");
  const [q, setQ] = useState("");
  const [closingPtyIds, setClosingPtyIds] = useState<Set<string>>(new Set());
  const [closingChatSessionId, setClosingChatSessionId] = useState<string | null>(null);
  const [resumingSessionId, setResumingSessionId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  /* ---- Tabs state ---- */
  const [openTabIds, setOpenTabIds] = useState<string[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"tabs" | "grid">("tabs");
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const hasRunningSessionsRef = useRef(false);
  const backgroundRefreshTimerRef = useRef<number | null>(null);

  const refresh = useCallback(async (options: { showLoading?: boolean } = {}) => {
    const showLoading = options.showLoading ?? true;
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;
    if (showLoading) setLoading(true);
    try {
      const rows = await window.ade.sessions.list({ limit: 500 });
      setSessions(rows);
    } finally {
      if (showLoading) setLoading(false);
      refreshInFlightRef.current = false;
      if (refreshQueuedRef.current) {
        refreshQueuedRef.current = false;
        void refresh({ showLoading: false });
      }
    }
  }, []);

  const scheduleBackgroundRefresh = useCallback((delayMs = 450) => {
    if (backgroundRefreshTimerRef.current != null) return;
    backgroundRefreshTimerRef.current = window.setTimeout(() => {
      backgroundRefreshTimerRef.current = null;
      void refresh({ showLoading: false });
    }, delayMs);
  }, [refresh]);

  // Initial fetch
  useEffect(() => {
    refresh({ showLoading: true }).catch(() => {});
  }, [refresh]);

  useEffect(() => {
    hasRunningSessionsRef.current = sessions.some((s) => s.status === "running");
  }, [sessions]);

  // URL params
  useEffect(() => {
    const laneParam = (searchParams.get("laneId") ?? searchParams.get("lane") ?? "").trim();
    if (laneParam && lanes.some((l) => l.id === laneParam)) setFilterLaneId(laneParam);
    const statusParam = (searchParams.get("status") ?? "").trim();
    if (["running", "completed", "failed", "disposed", "all"].includes(statusParam)) {
      setFilterStatus(statusParam as TerminalSessionStatus | "all");
    }
  }, [searchParams, lanes]);

  // Event subscriptions
  useEffect(() => {
    const unsubExit = window.ade.pty.onExit(() => {
      scheduleBackgroundRefresh(120);
    });
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (!hasRunningSessionsRef.current) return;
      scheduleBackgroundRefresh(180);
    }, 5_000);
    return () => {
      try { unsubExit(); } catch { /* ignore */ }
      clearInterval(t);
    };
  }, [scheduleBackgroundRefresh]);

  useEffect(() => {
    const unsubscribe = window.ade.agentChat.onEvent((payload) => {
      const event = payload.event;
      if (event.type === "done") scheduleBackgroundRefresh(200);
      if (event.type === "status" && event.turnStatus !== "started") scheduleBackgroundRefresh(200);
    });
    return unsubscribe;
  }, [scheduleBackgroundRefresh]);

  useEffect(() => {
    return () => {
      if (backgroundRefreshTimerRef.current != null) {
        window.clearTimeout(backgroundRefreshTimerRef.current);
      }
    };
  }, []);

  // Enhanced filtering with prefix search
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sessions.filter((s) => {
      if (filterLaneId !== "all" && s.laneId !== filterLaneId) return false;
      if (filterStatus !== "all" && s.status !== filterStatus) return false;
      if (!needle) return true;

      // Prefix search: lane:, type:, tracked:
      if (needle.startsWith("lane:")) {
        const val = needle.slice(5).trim();
        return s.laneName.toLowerCase().includes(val);
      }
      if (needle.startsWith("type:")) {
        const val = needle.slice(5).trim();
        return (s.toolType ?? "").toLowerCase().includes(val);
      }
      if (needle.startsWith("tracked:")) {
        const val = needle.slice(8).trim();
        if (val === "yes" || val === "true") return s.tracked;
        if (val === "no" || val === "false") return !s.tracked;
        return true;
      }

      return (
        (s.goal ?? s.title).toLowerCase().includes(needle) ||
        s.laneName.toLowerCase().includes(needle) ||
        (s.toolType ?? "").toLowerCase().includes(needle) ||
        (s.lastOutputPreview ?? "").toLowerCase().includes(needle) ||
        (s.summary ?? "").toLowerCase().includes(needle) ||
        (s.resumeCommand ?? "").toLowerCase().includes(needle)
      );
    });
  }, [sessions, filterLaneId, filterStatus, q]);

  const runningSessions = useMemo(
    () => sessions.filter((s) => s.status === "running" && Boolean(s.ptyId)),
    [sessions],
  );

  const selectedSession = useMemo(
    () => (selectedSessionId ? sessions.find((s) => s.id === selectedSessionId) ?? null : null),
    [sessions, selectedSessionId],
  );

  const runningFiltered = useMemo(() => filtered.filter((s) => s.status === "running"), [filtered]);
  const endedFiltered = useMemo(() => filtered.filter((s) => s.status !== "running"), [filtered]);

  // Auto-select first running session
  useEffect(() => {
    if (!selectedSessionId && runningSessions.length > 0) setSelectedSessionId(runningSessions[0]!.id);
  }, [selectedSessionId, runningSessions]);

  /* ---- Tab management ---- */
  const openSessionTab = useCallback(
    (sessionId: string) => {
      setOpenTabIds((prev) => (prev.includes(sessionId) ? prev : [...prev, sessionId]));
      setActiveTabId(sessionId);
      setSelectedSessionId(sessionId);
    },
    [],
  );

  const closeTab = useCallback(
    (sessionId: string) => {
      setOpenTabIds((prev) => {
        const next = prev.filter((id) => id !== sessionId);
        if (activeTabId === sessionId) {
          const idx = prev.indexOf(sessionId);
          const newActive = next[Math.min(idx, next.length - 1)] ?? null;
          setActiveTabId(newActive);
          setSelectedSessionId(newActive);
        }
        return next;
      });
    },
    [activeTabId],
  );

  /* ---- Session actions ---- */

  const markPtyClosed = (ptyId: string) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.ptyId === ptyId
          ? { ...s, ptyId: null, status: "disposed" as const, runtimeState: "killed" as const, endedAt: new Date().toISOString(), exitCode: null }
          : s,
      ),
    );
  };

  const closeSession = useCallback(
    async (ptyId: string) => {
      setClosingPtyIds((prev) => {
        const n = new Set(prev);
        n.add(ptyId);
        return n;
      });
      markPtyClosed(ptyId);
      try {
        await window.ade.pty.dispose({ ptyId });
      } finally {
        setClosingPtyIds((prev) => {
          const n = new Set(prev);
          n.delete(ptyId);
          return n;
        });
        await refresh();
      }
    },
    [refresh],
  );

  const closeAllRunning = useCallback(async () => {
    const ids = runningSessions.map((s) => s.ptyId).filter((id): id is string => Boolean(id));
    await Promise.allSettled(ids.map((id) => closeSession(id)));
  }, [runningSessions, closeSession]);

  const resumeSession = useCallback(
    async (session: TerminalSessionSummary) => {
      if (isChatToolType(session.toolType)) {
        if (resumingSessionId) return;
        setResumingSessionId(session.id);
        try {
          await window.ade.agentChat.resume({ sessionId: session.id });
          selectLane(session.laneId);
          focusSession(session.id);
          setSelectedSessionId(session.id);
          await refresh();
        } finally {
          setResumingSessionId(null);
        }
        return;
      }
      const command = (session.resumeCommand ?? "").trim();
      if (!command || resumingSessionId) return;
      setResumingSessionId(session.id);
      try {
        const toolType = (session.toolType ?? inferToolFromResumeCommand(command) ?? null) as TerminalToolType | null;
        const started = await window.ade.pty.create({
          laneId: session.laneId,
          cols: 100,
          rows: 30,
          title: session.goal?.trim() || session.title || "Terminal",
          tracked: session.tracked,
          toolType,
          startupCommand: command,
        });
        selectLane(session.laneId);
        focusSession(started.sessionId);
        setSelectedSessionId(started.sessionId);
        navigate(`/lanes?laneId=${encodeURIComponent(session.laneId)}&sessionId=${encodeURIComponent(started.sessionId)}`);
      } finally {
        setResumingSessionId(null);
      }
    },
    [focusSession, navigate, refresh, resumingSessionId, selectLane],
  );

  const closeChatSession = useCallback(
    async (sessionId: string) => {
      setClosingChatSessionId(sessionId);
      try {
        await window.ade.agentChat.dispose({ sessionId });
        await refresh();
      } finally {
        setClosingChatSessionId((c) => (c === sessionId ? null : c));
      }
    },
    [refresh],
  );

  /* ---- Launch new sessions ---- */

  const handleLaunchPty = useCallback(
    async (laneId: string, profile: "claude" | "codex" | "shell") => {
      const toolTypeMap = { claude: "claude" as const, codex: "codex" as const, shell: "shell" as const };
      const titleMap = { claude: "Claude Code", codex: "Codex", shell: "Shell" };
      const commandMap = { claude: "claude", codex: "codex", shell: "" };
      const result = await window.ade.pty.create({
        laneId,
        cols: 100,
        rows: 30,
        title: titleMap[profile],
        tracked: true,
        toolType: toolTypeMap[profile],
        startupCommand: commandMap[profile] || undefined,
      });
      selectLane(laneId);
      focusSession(result.sessionId);
      setSelectedSessionId(result.sessionId);
      openSessionTab(result.sessionId);
      await refresh();
    },
    [selectLane, focusSession, refresh, openSessionTab],
  );

  const handleLaunchChat = useCallback(
    async (laneId: string, modelIdOrProvider?: string) => {
      // Accept either a model ID (e.g. "anthropic/claude-sonnet-4-6") or legacy provider ("claude"/"codex")
      let provider: "claude" | "codex" | "unified" = "codex";
      let model = "gpt-5.3-codex";
      let modelId: string | undefined;

      const applyDescriptor = (raw: string | null | undefined): boolean => {
        const descriptor = resolveModelDescriptor(raw);
        if (!descriptor) return false;
        modelId = descriptor.id;
        if (descriptor.isCliWrapped) {
          provider = descriptor.family === "openai" ? "codex" : "claude";
          model = descriptor.shortId;
        } else {
          provider = "unified";
          model = descriptor.id;
        }
        return true;
      };

      if (modelIdOrProvider === "codex") {
        applyDescriptor("openai/gpt-5.3-codex");
      } else if (modelIdOrProvider === "claude") {
        applyDescriptor("anthropic/claude-sonnet-4-6");
      } else if (modelIdOrProvider && modelIdOrProvider.trim().length) {
        applyDescriptor(modelIdOrProvider);
      } else {
        // No explicit model/provider: choose a runnable default from live availability.
        try {
          const status = await window.ade.ai.getStatus();
          const detectedLocal = (status.detectedAuth ?? [])
            .find((entry) => entry.type === "local" && (entry.provider === "lmstudio" || entry.provider === "ollama" || entry.provider === "vllm"));
          if (detectedLocal) {
            const localModelId = detectedLocal.provider === "ollama" ? "ollama/llama-3.3" : `${detectedLocal.provider}/auto`;
            applyDescriptor(localModelId);
          } else if (status.availableProviders.codex) {
            const codexId = status.models.codex?.[0]?.id ?? "openai/gpt-5.3-codex";
            applyDescriptor(codexId) || applyDescriptor("openai/gpt-5.3-codex");
          } else if (status.availableProviders.claude) {
            const claudeId = status.models.claude?.[0]?.id ?? "anthropic/claude-sonnet-4-6";
            applyDescriptor(claudeId) || applyDescriptor("anthropic/claude-sonnet-4-6");
          }
        } catch {
          // Fallback defaults below.
        }

        if (!modelId) {
          applyDescriptor("openai/gpt-5.3-codex") || applyDescriptor("anthropic/claude-sonnet-4-6");
        }
      }

      if (!modelId) {
        throw new Error("No configured chat model is available. Configure Codex/Claude or a local/API model in Settings.");
      }
      const session = await window.ade.agentChat.create({ laneId, provider, model, modelId });
      selectLane(laneId);
      focusSession(session.id);
      setSelectedSessionId(session.id);
      openSessionTab(session.id);
      await refresh();
    },
    [selectLane, focusSession, refresh, openSessionTab],
  );

  return {
    // Data
    sessions,
    lanes,
    filtered,
    runningFiltered,
    endedFiltered,
    runningSessions,
    selectedSession,
    loading,

    // Filters
    filterLaneId,
    setFilterLaneId,
    filterStatus,
    setFilterStatus,
    q,
    setQ,

    // Selection
    selectedSessionId,
    setSelectedSessionId,

    // Tabs
    openTabIds,
    activeTabId,
    viewMode,
    setViewMode,
    openSessionTab,
    closeTab,
    setActiveTabId,

    // In-flight state
    closingPtyIds,
    closingChatSessionId,
    resumingSessionId,

    // Actions
    refresh,
    closeSession,
    closeAllRunning,
    resumeSession,
    closeChatSession,
    handleLaunchPty,
    handleLaunchChat,

    // Navigation helpers
    navigate,
    selectLane,
    focusSession,
  };
}
