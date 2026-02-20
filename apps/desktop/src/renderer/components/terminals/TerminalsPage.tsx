import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Clipboard, FileText, Info, LayoutList, Monitor, Play, RefreshCw, Square, Terminal } from "lucide-react";
import type { TerminalSessionSummary, TerminalSessionStatus } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { PaneTilingLayout, type PaneConfig, type PaneSplit } from "../ui/PaneTilingLayout";
import { TerminalView, getTerminalRuntimeHealth } from "./TerminalView";
import { sanitizeTerminalInlineText, sessionIndicatorState } from "../../lib/terminalAttention";
import { AgentChatPane } from "../chat/AgentChatPane";

/* ---- Default tiling layout ---- */

const TERMINALS_TILING_TREE: PaneSplit = {
  type: "split",
  direction: "horizontal",
  children: [
    { node: { type: "pane", id: "sessions" }, defaultSize: 28, minSize: 15 },
    {
      node: {
        type: "split",
        direction: "vertical",
        children: [
          { node: { type: "pane", id: "terminal" }, defaultSize: 70, minSize: 30 },
          { node: { type: "pane", id: "details" }, defaultSize: 30, minSize: 10 }
        ]
      },
      defaultSize: 72,
      minSize: 40
    }
  ]
};

function inferToolFromResumeCommand(command: string): "claude" | "codex" | null {
  const normalized = command.trim().toLowerCase();
  if (normalized.startsWith("claude ")) return "claude";
  if (normalized.startsWith("codex ")) return "codex";
  return null;
}

function isChatToolType(toolType: string | null | undefined): boolean {
  return toolType === "codex-chat" || toolType === "claude-chat";
}

function runtimeStateLabel(state: TerminalSessionSummary["runtimeState"]): string {
  if (state === "waiting-input") return "waiting input";
  return state;
}

/* ---- Component ---- */

export function TerminalsPage() {
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

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await window.ade.sessions.list({ limit: 500 });
      setSessions(rows);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh().catch(() => {});
  }, []);

  useEffect(() => {
    const laneParam = (searchParams.get("laneId") ?? searchParams.get("lane") ?? "").trim();
    if (laneParam && lanes.some((l) => l.id === laneParam)) {
      setFilterLaneId(laneParam);
    }

    const statusParam = (searchParams.get("status") ?? "").trim();
    if (
      statusParam === "running" ||
      statusParam === "completed" ||
      statusParam === "failed" ||
      statusParam === "disposed" ||
      statusParam === "all"
    ) {
      setFilterStatus(statusParam);
    }
  }, [searchParams, lanes]);

  useEffect(() => {
    const unsubExit = window.ade.pty.onExit(() => {
      refresh().catch(() => {});
    });
    const t = setInterval(() => {
      if (sessions.some((s) => s.status === "running")) {
        refresh().catch(() => {});
      }
    }, 2000);
    return () => {
      try {
        unsubExit();
      } catch {
        // ignore
      }
      clearInterval(t);
    };
  }, [sessions]);

  useEffect(() => {
    const unsubscribe = window.ade.agentChat.onEvent((payload) => {
      const event = payload.event;
      if (event.type === "done") {
        refresh().catch(() => {});
      }
      if (event.type === "status" && event.turnStatus !== "started") {
        refresh().catch(() => {});
      }
    });
    return unsubscribe;
  }, [refresh]);

  useEffect(() => {
    // Default to selected lane filter (toggleable by user selecting "all").
    if (selectedLaneId && filterLaneId === "all") {
      // Leave as "all" until user opts in.
    }
  }, [selectedLaneId, filterLaneId]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sessions.filter((s) => {
      if (filterLaneId !== "all" && s.laneId !== filterLaneId) return false;
      if (filterStatus !== "all" && s.status !== filterStatus) return false;
      if (!needle) return true;
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
    [sessions]
  );

  const selectedSession = useMemo(
    () => (selectedSessionId ? sessions.find((s) => s.id === selectedSessionId) ?? null : null),
    [sessions, selectedSessionId]
  );
  const selectedIsChat = useMemo(() => isChatToolType(selectedSession?.toolType), [selectedSession]);
  const selectedHealth = selectedSession ? getTerminalRuntimeHealth(selectedSession.id) : null;

  // Auto-select the first running session if nothing is selected
  useEffect(() => {
    if (!selectedSessionId && runningSessions.length > 0) {
      setSelectedSessionId(runningSessions[0]!.id);
    }
  }, [selectedSessionId, runningSessions]);

  const markPtyClosed = (ptyId: string) => {
    setSessions((prev) =>
      prev.map((session) =>
        session.ptyId === ptyId
          ? {
              ...session,
              ptyId: null,
              status: "disposed",
              runtimeState: "killed",
              endedAt: new Date().toISOString(),
              exitCode: null
            }
          : session
      )
    );
  };

  const closeSession = async (ptyId: string) => {
    setClosingPtyIds((prev) => {
      if (prev.has(ptyId)) return prev;
      const next = new Set(prev);
      next.add(ptyId);
      return next;
    });
    markPtyClosed(ptyId);
    try {
      await window.ade.pty.dispose({ ptyId });
    } finally {
      setClosingPtyIds((prev) => {
        if (!prev.has(ptyId)) return prev;
        const next = new Set(prev);
        next.delete(ptyId);
        return next;
      });
      await refresh();
    }
  };

  const closeRunning = async () => {
    const ptyIds = runningSessions
      .map((session) => session.ptyId)
      .filter((ptyId): ptyId is string => Boolean(ptyId));
    await Promise.allSettled(ptyIds.map((ptyId) => closeSession(ptyId)));
  };

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
        const toolType =
          session.toolType ??
          inferToolFromResumeCommand(command) ??
          null;
        const started = await window.ade.pty.create({
          laneId: session.laneId,
          cols: 100,
          rows: 30,
          title: session.goal?.trim() || session.title || "Terminal",
          tracked: session.tracked,
          toolType,
          startupCommand: command
        });
        selectLane(session.laneId);
        focusSession(started.sessionId);
        setSelectedSessionId(started.sessionId);
        navigate(
          `/lanes?laneId=${encodeURIComponent(session.laneId)}&sessionId=${encodeURIComponent(started.sessionId)}`
        );
      } finally {
        setResumingSessionId(null);
      }
    },
    [focusSession, navigate, refresh, resumingSessionId, selectLane]
  );

  const closeChatSession = useCallback(async (sessionId: string) => {
    setClosingChatSessionId(sessionId);
    try {
      await window.ade.agentChat.dispose({ sessionId });
      await refresh();
    } finally {
      setClosingChatSessionId((current) => (current === sessionId ? null : current));
    }
  }, [refresh]);

  const sessionDot = useCallback((session: TerminalSessionSummary): { className: string; spinning: boolean; title: string } => {
    const indicator = sessionIndicatorState({
      status: session.status,
      lastOutputPreview: session.lastOutputPreview,
      runtimeState: session.runtimeState
    });
    if (indicator === "running-active") {
      return {
        className: "border-2 border-emerald-500 border-t-transparent bg-transparent",
        spinning: true,
        title: "Running"
      };
    }
    if (indicator === "running-needs-attention") {
      return {
        className: "border-2 border-amber-400 border-t-transparent bg-transparent",
        spinning: true,
        title: "Running (needs input)"
      };
    }
    if (indicator === "failed") {
      return {
        className: "bg-red-500",
        spinning: false,
        title: "Failed"
      };
    }
    if (indicator === "disposed") {
      return {
        className: "bg-red-400/80",
        spinning: false,
        title: "Stopped"
      };
    }
    return {
      className: "bg-sky-500",
      spinning: false,
      title: "Completed"
    };
  }, []);

  /* ---- Pane configs ---- */

  const paneConfigs: Record<string, PaneConfig> = useMemo(
    () => ({
      sessions: {
        title: "Sessions",
        icon: LayoutList,
        meta: loading ? "Loading..." : `${filtered.length} sessions`,
        children: (
          <div className="flex h-full flex-col">
            {/* Filters */}
            <div className="border-b border-border/30 px-3 py-2.5">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <label className="flex-1 space-y-1">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-fg/70">Lane</div>
                    <select
                      className="h-7 w-full rounded-md border border-border/20 bg-muted/20 px-2 text-xs outline-none transition-colors hover:bg-muted/40 focus:border-accent/30 focus:ring-1 focus:ring-accent/20"
                      value={filterLaneId}
                      onChange={(e) => setFilterLaneId(e.target.value)}
                    >
                      <option value="all">All lanes</option>
                      {lanes.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex-1 space-y-1">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-fg/70">Status</div>
                    <select
                      className="h-7 w-full rounded-md border border-border/20 bg-muted/20 px-2 text-xs outline-none transition-colors hover:bg-muted/40 focus:border-accent/30 focus:ring-1 focus:ring-accent/20"
                      value={filterStatus}
                      onChange={(e) => setFilterStatus(e.target.value as any)}
                    >
                      <option value="all">All</option>
                      <option value="running">Running</option>
                      <option value="completed">Completed</option>
                      <option value="failed">Failed</option>
                      <option value="disposed">Disposed</option>
                    </select>
                  </label>
                </div>

                <label className="space-y-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-fg/70">Search</div>
                  <input
                    className="h-7 w-full rounded-md border border-border/20 bg-muted/20 px-2 text-xs outline-none transition-colors placeholder:text-muted-fg/50 hover:bg-muted/40 focus:border-accent/30 focus:ring-1 focus:ring-accent/20"
                    placeholder="title, lane, output..."
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                  />
                </label>
              </div>
            </div>

            {/* Session list */}
            <div className="min-h-0 flex-1 overflow-auto px-2 py-1.5">
              {filtered.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center px-4 py-10">
                  <div className="mb-3 rounded-xl bg-muted/25 p-3">
                    <Terminal className="h-5 w-5 text-muted-fg/50" />
                  </div>
                  <div className="text-xs font-semibold text-fg/60">No sessions</div>
                  <div className="mt-1 text-center text-[11px] leading-relaxed text-muted-fg/60">Start a terminal from a lane, then use this view to jump between sessions.</div>
                </div>
              ) : (
                <div className="flex flex-col gap-px">
                  {filtered.map((s, idx) => {
                    const isSelected = selectedSessionId === s.id;
                    const dot = sessionDot(s);
                    return (
                      <React.Fragment key={s.id}>
                        {idx > 0 && <div className="mx-2 border-b border-border/10" />}
                        <div className="group relative">
                          <button
                            type="button"
                            className={`w-full rounded-lg p-2.5 pr-8 text-left transition-all duration-150 ${
                              isSelected
                                ? "border-l-2 border-l-accent bg-accent/10 shadow-sm ring-1 ring-accent/20"
                                : "border-l-2 border-l-transparent hover:bg-muted/30 hover:shadow-sm"
                            }`}
                            onClick={() => setSelectedSessionId(s.id)}
                          >
                            <div className="flex items-center gap-2">
                              <span
                                title={dot.title}
                                className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot.className} ${dot.spinning ? "animate-spin" : ""}`}
                              />
                              <span className={`truncate text-xs font-semibold ${isSelected ? "text-accent" : ""}`}>
                                {(s.goal ?? s.title).trim()}
                              </span>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-[18px] text-[11px] text-muted-fg">
                              <span className="truncate">{s.laneName}</span>
                              <Chip className="text-[10px]">{s.status}</Chip>
                              {s.toolType ? <Chip className="text-[10px]">{s.toolType}</Chip> : null}
                            </div>
                          </button>
                          {s.status !== "running" && s.resumeCommand ? (
                            <button
                              type="button"
                              className="absolute right-2 top-2 inline-flex items-center gap-1 rounded border border-border/40 bg-card/90 px-1.5 py-0.5 text-[10px] text-muted-fg opacity-0 transition-opacity hover:text-fg group-hover:opacity-100"
                              title={`Resume in lane ${s.laneName}`}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                resumeSession(s).catch(() => {});
                              }}
                            >
                              <Play className="h-3 w-3" />
                              Resume
                            </button>
                          ) : null}
                        </div>
                      </React.Fragment>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )
      },
      terminal: {
        title: "Terminal",
        icon: Monitor,
        bodyClassName: "overflow-hidden",
        meta: selectedSession
          ? selectedIsChat
            ? "chat"
            : selectedSession.status === "running"
              ? "live"
              : selectedSession.status
          : undefined,
        children: (
          <div className="h-full w-full">
            {selectedSession && selectedIsChat ? (
              <AgentChatPane laneId={selectedSession.laneId} lockSessionId={selectedSession.id} />
            ) : runningSessions.length > 0 ? (
              <div className="relative h-full w-full">
                {runningSessions.map((session) =>
                  session.ptyId ? (
                    <TerminalView
                      key={session.id}
                      ptyId={session.ptyId}
                      sessionId={session.id}
                      className={`absolute inset-0 h-full w-full ${
                        selectedSession?.id === session.id ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
                      }`}
                    />
                  ) : null
                )}
                {selectedSession?.status === "running" && selectedSession.ptyId ? null : (
                  <div className="absolute inset-0 flex items-center justify-center bg-bg/70 backdrop-blur-[1px]">
                    <div className="rounded-lg border border-border/20 bg-card/90 px-3 py-2 text-xs text-muted-fg">
                      Select a running session to interact.
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center px-6">
                <div className="mb-3 rounded-xl bg-muted/20 p-3.5">
                  <Monitor className="h-6 w-6 text-muted-fg/40" />
                </div>
                <div className="text-sm font-semibold text-fg/60">
                  {selectedSession ? "Session not running" : "No session selected"}
                </div>
                <div className="mt-1.5 max-w-xs text-center text-xs leading-relaxed text-muted-fg/60">
                  {selectedSession
                    ? "This session has ended. Select a running session to see its terminal."
                    : "Select a session from the list to view its terminal."}
                </div>
              </div>
            )}
          </div>
        )
      },
      details: {
        title: "Details",
        icon: Info,
        meta: selectedSession
          ? `${selectedSession.status}`
          : undefined,
        children: (
          <div className="h-full overflow-auto p-3">
            {selectedSession ? (
              <div className="space-y-3">
                {/* Session metadata */}
                <div className="rounded-xl border border-border/15 bg-muted/15 p-3">
                  <div className="mb-2.5 flex items-center gap-2 border-l-2 border-l-accent/50 pl-2">
                    <Info className="h-3 w-3 text-accent/60" />
                    <span className="text-[10px] font-bold uppercase tracking-wider text-muted-fg/80">Session info</span>
                  </div>
                  <div className="space-y-0 text-xs">
                    <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/20">
                      <span className="text-muted-fg/80">Title</span>
                      <span className="truncate font-medium">{(selectedSession.goal ?? selectedSession.title).trim()}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/20">
                      <span className="text-muted-fg/80">Lane</span>
                      <span className="truncate">{selectedSession.laneName}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/20">
                      <span className="text-muted-fg/80">Status</span>
                      <Chip className="text-[10px]">{selectedSession.status}</Chip>
                    </div>
                    <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/20">
                      <span className="text-muted-fg/80">Runtime</span>
                      <Chip className="text-[10px]">{runtimeStateLabel(selectedSession.runtimeState)}</Chip>
                    </div>
                    {selectedSession.toolType ? (
                      <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/20">
                        <span className="text-muted-fg/80">Tool</span>
                        <Chip className="text-[10px]">{selectedSession.toolType}</Chip>
                      </div>
                    ) : null}
                    {selectedSession.exitCode != null ? (
                      <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/20">
                        <span className="text-muted-fg/80">Exit code</span>
                        <Chip className="text-[10px]">exit {selectedSession.exitCode}</Chip>
                      </div>
                    ) : null}
                    {!selectedSession.tracked ? (
                      <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/20">
                        <span className="text-muted-fg/80">Context</span>
                        <Chip className="text-[10px]">no context</Chip>
                      </div>
                    ) : null}
                    <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/20">
                      <span className="text-muted-fg/80">Started</span>
                      <span className="text-[11px] text-fg/70">{new Date(selectedSession.startedAt).toLocaleString()}</span>
                    </div>
                    {selectedSession.endedAt ? (
                      <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/20">
                        <span className="text-muted-fg/80">Ended</span>
                        <span className="text-[11px] text-fg/70">{new Date(selectedSession.endedAt).toLocaleString()}</span>
                      </div>
                    ) : null}
                  </div>
                </div>

                {/* Output preview */}
                {sanitizeTerminalInlineText(selectedSession.lastOutputPreview, 420) ? (
                  <div className="rounded-xl border border-border/15 bg-muted/15 p-3">
                    <div className="mb-2.5 flex items-center gap-2 border-l-2 border-l-accent/50 pl-2">
                      <Monitor className="h-3 w-3 text-accent/60" />
                      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-fg/80">Last output</span>
                    </div>
                    <div className="whitespace-pre-wrap break-words rounded-lg border border-border/10 bg-[--color-surface-recessed] px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-fg/90 shadow-inset">
                      {sanitizeTerminalInlineText(selectedSession.lastOutputPreview, 420)}
                    </div>
                  </div>
                ) : null}

                {/* Summary */}
                {selectedSession.summary && selectedSession.status !== "running" ? (
                  <div className="rounded-xl border border-border/15 bg-muted/15 p-3">
                    <div className="mb-2.5 flex items-center gap-2 border-l-2 border-l-accent/50 pl-2">
                      <FileText className="h-3 w-3 text-accent/60" />
                      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-fg/80">Summary</span>
                    </div>
                    <div className="whitespace-pre-wrap text-xs leading-relaxed text-fg/70">
                      {selectedSession.summary}
                    </div>
                  </div>
                ) : null}

                {selectedSession.status !== "running" && selectedSession.resumeCommand ? (
                  <div className="rounded-xl border border-border/15 bg-muted/15 p-3">
                    <div className="mb-2.5 flex items-center gap-2 border-l-2 border-l-accent/50 pl-2">
                      <Play className="h-3 w-3 text-accent/60" />
                      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-fg/80">Resume command</span>
                    </div>
                    <div className="rounded-lg border border-border/10 bg-[--color-surface-recessed] px-3 py-2 font-mono text-[11px] text-fg/80">
                      {selectedSession.resumeCommand}
                    </div>
                    <div className="mt-2 text-[11px] text-muted-fg">
                      Click resume to launch a new terminal in this lane and run this command automatically.
                    </div>
                  </div>
                ) : null}

                {selectedHealth ? (
                  <div className="rounded-xl border border-border/15 bg-muted/15 p-3">
                    <div className="mb-2.5 flex items-center gap-2 border-l-2 border-l-accent/50 pl-2">
                      <Info className="h-3 w-3 text-accent/60" />
                      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-fg/80">Terminal health</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-fg">
                      <div>fit_failures: {selectedHealth.fitFailures}</div>
                      <div>zero_dim_fits: {selectedHealth.zeroDimFits}</div>
                      <div>renderer_fallbacks: {selectedHealth.rendererFallbacks}</div>
                      <div>dropped_chunks: {selectedHealth.droppedChunks}</div>
                    </div>
                  </div>
                ) : null}

                {/* Actions */}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {selectedSession.status === "running" && selectedSession.ptyId ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={closingPtyIds.has(selectedSession.ptyId)}
                      onClick={() => {
                        const ptyId = selectedSession.ptyId;
                        if (!ptyId) return;
                        closeSession(ptyId).catch(() => {});
                      }}
                      title="Close terminal session"
                    >
                      <Square className="h-3.5 w-3.5" />
                      {closingPtyIds.has(selectedSession.ptyId) ? "Closing..." : "Close"}
                    </Button>
                  ) : null}
                  {selectedSession.status === "running" && selectedIsChat ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={closingChatSessionId === selectedSession.id}
                      onClick={() => closeChatSession(selectedSession.id).catch(() => {})}
                      title="End chat session"
                    >
                      <Square className="h-3.5 w-3.5" />
                      {closingChatSessionId === selectedSession.id ? "Closing..." : "End chat"}
                    </Button>
                  ) : null}
                  {selectedSession.status !== "running" && selectedSession.resumeCommand ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={resumingSessionId != null}
                        onClick={() => resumeSession(selectedSession).catch(() => {})}
                        title="Resume in this lane"
                      >
                        <Play className="h-3.5 w-3.5" />
                        {resumingSessionId === selectedSession.id ? "Resuming..." : "Resume"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          navigator.clipboard.writeText(selectedSession.resumeCommand ?? "").catch(() => {});
                        }}
                        title="Copy resume command"
                      >
                        <Clipboard className="h-3.5 w-3.5" />
                        Copy
                      </Button>
                    </>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      selectLane(selectedSession.laneId);
                      focusSession(selectedSession.id);
                      navigate(
                        `/lanes?laneId=${encodeURIComponent(selectedSession.laneId)}&sessionId=${encodeURIComponent(selectedSession.id)}`
                      );
                    }}
                    title="Open lane"
                  >
                    Lane
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      selectLane(selectedSession.laneId);
                      navigate(`/lanes?laneId=${encodeURIComponent(selectedSession.laneId)}&inspectorTab=context`);
                    }}
                    title="Open lane context"
                  >
                    Context
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center px-6">
                <div className="mb-3 rounded-xl bg-muted/20 p-3.5">
                  <Info className="h-5 w-5 text-muted-fg/40" />
                </div>
                <div className="text-xs font-semibold text-fg/60">No session selected</div>
                <div className="mt-1.5 text-center text-[11px] leading-relaxed text-muted-fg/50">Select a session from the list to view its details.</div>
              </div>
            )}
          </div>
        )
      }
    }),
    [
      filtered,
      loading,
      filterLaneId,
      filterStatus,
      q,
      lanes,
      selectedSessionId,
      selectedSession,
      selectedIsChat,
      selectedHealth,
      closingPtyIds,
      closingChatSessionId,
      sessionDot,
      selectLane,
      focusSession,
      navigate,
      closeSession,
      closeChatSession,
      resumeSession,
      resumingSessionId
    ]
  );

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      {/* Header toolbar */}
      <div className="border-b border-border/30 bg-gradient-to-b from-surface/60 to-transparent px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-sm font-bold tracking-tight text-fg/80">Terminals</div>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              disabled={runningSessions.length === 0}
              title={runningSessions.length ? "Close all running sessions" : "No running sessions"}
              onClick={() => closeRunning().catch(() => {})}
            >
              <Square className="h-3.5 w-3.5" />
              Close Running ({runningSessions.length})
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7"
              title="Refresh sessions"
              onClick={() => refresh().catch(() => {})}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {/* Pane tiling layout */}
      <PaneTilingLayout
        layoutId="terminals:tiling:v1"
        tree={TERMINALS_TILING_TREE}
        panes={paneConfigs}
        className="flex-1 min-h-0"
      />
    </div>
  );
}
