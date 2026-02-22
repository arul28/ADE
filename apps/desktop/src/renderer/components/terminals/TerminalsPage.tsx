import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  BrainCircuit,
  ChevronDown,
  Clipboard,
  FileText,
  Info,
  MessageSquarePlus,
  Monitor,
  Play,
  RefreshCw,
  Square,
  Terminal,
  X,
} from "lucide-react";
import type { TerminalSessionSummary, TerminalSessionStatus } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { PaneTilingLayout, type PaneConfig, type PaneSplit } from "../ui/PaneTilingLayout";
import { TerminalView, getTerminalRuntimeHealth } from "./TerminalView";
import { sanitizeTerminalInlineText, sessionIndicatorState } from "../../lib/terminalAttention";
import { AgentChatPane } from "../chat/AgentChatPane";
import { cn } from "../ui/cn";

/* ---- Layout ---- */

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
          { node: { type: "pane", id: "details" }, defaultSize: 30, minSize: 10 },
        ],
      },
      defaultSize: 72,
      minSize: 40,
    },
  ],
};

/* ---- Helpers ---- */

function isChatToolType(toolType: string | null | undefined): boolean {
  return toolType === "codex-chat" || toolType === "claude-chat";
}

function inferToolFromResumeCommand(command: string): "claude" | "codex" | null {
  const n = command.trim().toLowerCase();
  if (n.startsWith("claude ")) return "claude";
  if (n.startsWith("codex ")) return "codex";
  return null;
}

function runtimeStateLabel(state: TerminalSessionSummary["runtimeState"]): string {
  if (state === "waiting-input") return "waiting input";
  return state;
}

/** Tool-type → left-border accent color class */
function toolBorderClass(toolType: string | null | undefined): string {
  if (toolType === "claude" || toolType === "claude-chat") return "border-l-violet-500";
  if (toolType === "codex" || toolType === "codex-chat") return "border-l-sky-500";
  if (toolType === "shell") return "border-l-border/40";
  return "border-l-border/20";
}

/** Tool-type → badge color */
function toolBadgeClass(toolType: string | null | undefined): string {
  if (toolType === "claude" || toolType === "claude-chat") return "bg-violet-500/12 text-violet-700";
  if (toolType === "codex" || toolType === "codex-chat") return "bg-sky-500/12 text-sky-700";
  return "bg-muted/40 text-muted-fg";
}

function statusDot(session: TerminalSessionSummary): { cls: string; spinning: boolean; label: string } {
  const ind = sessionIndicatorState({
    status: session.status,
    lastOutputPreview: session.lastOutputPreview,
    runtimeState: session.runtimeState,
  });
  if (ind === "running-active")
    return { cls: "border-2 border-emerald-500 border-t-transparent bg-transparent", spinning: true, label: "Running" };
  if (ind === "running-needs-attention")
    return { cls: "border-2 border-amber-400 border-t-transparent bg-transparent", spinning: true, label: "Needs input" };
  if (ind === "failed") return { cls: "bg-red-500", spinning: false, label: "Failed" };
  if (ind === "disposed") return { cls: "bg-red-400/70", spinning: false, label: "Stopped" };
  return { cls: "bg-sky-500/70", spinning: false, label: "Completed" };
}

/* ---- Launch panel subcomponent ---- */

function LaunchPanel({
  lanes,
  onLaunchPty,
  onLaunchChat,
}: {
  lanes: { id: string; name: string }[];
  onLaunchPty: (laneId: string, profile: "claude" | "codex" | "shell") => void;
  onLaunchChat: (laneId: string, provider: "claude" | "codex") => void;
}) {
  const [laneId, setLaneId] = useState<string>(lanes[0]?.id ?? "");
  const [chatOpen, setChatOpen] = useState(false);

  useEffect(() => {
    if (!laneId && lanes.length > 0) setLaneId(lanes[0]!.id);
  }, [lanes, laneId]);

  return (
    <div className="border-b border-border/15 bg-[--color-surface-recessed]/40 px-3 py-2.5 space-y-2">
      {/* Lane selector */}
      <div className="flex items-center gap-2">
        <label className="text-[10px] uppercase tracking-wider text-muted-fg/70 shrink-0">Lane</label>
        <div className="relative flex-1">
          <select
            className="h-6 w-full appearance-none rounded bg-muted/30 pl-2 pr-6 text-xs outline-none hover:bg-muted/50 transition-colors cursor-pointer"
            value={laneId}
            onChange={(e) => setLaneId(e.target.value)}
          >
            {lanes.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-fg/60" />
        </div>
      </div>

      {/* Quick-launch row */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          type="button"
          disabled={!laneId}
          onClick={() => onLaunchPty(laneId, "claude")}
          className="inline-flex items-center gap-1 rounded bg-violet-500/12 px-2 py-1 text-[11px] font-medium text-violet-700 transition-all hover:bg-violet-500/20 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40"
        >
          <Terminal className="h-3 w-3" />
          Claude
        </button>
        <button
          type="button"
          disabled={!laneId}
          onClick={() => onLaunchPty(laneId, "codex")}
          className="inline-flex items-center gap-1 rounded bg-sky-500/12 px-2 py-1 text-[11px] font-medium text-sky-700 transition-all hover:bg-sky-500/20 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40"
        >
          <Terminal className="h-3 w-3" />
          Codex
        </button>
        <button
          type="button"
          disabled={!laneId}
          onClick={() => onLaunchPty(laneId, "shell")}
          className="inline-flex items-center gap-1 rounded bg-muted/40 px-2 py-1 text-[11px] font-medium text-muted-fg transition-all hover:bg-muted/70 hover:text-fg active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40"
        >
          <Terminal className="h-3 w-3" />
          Shell
        </button>

        <div className="mx-1 h-3.5 w-px bg-border/40" />

        {/* Chat launch */}
        <div className="relative">
          <button
            type="button"
            disabled={!laneId}
            onClick={() => setChatOpen((v) => !v)}
            className="inline-flex items-center gap-1 rounded border border-accent/30 bg-accent/8 px-2 py-1 text-[11px] font-medium text-accent transition-all hover:bg-accent/15 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40"
          >
            <MessageSquarePlus className="h-3 w-3" />
            Chat
            <ChevronDown className={cn("h-3 w-3 opacity-60 transition-transform", chatOpen && "rotate-180")} />
          </button>
          {chatOpen && (
            <div className="absolute left-0 top-full z-50 mt-1 w-40 rounded border border-border/50 bg-[--color-surface-overlay] py-0.5 shadow-float">
              <button
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted/50"
                onClick={() => { onLaunchChat(laneId, "claude"); setChatOpen(false); }}
              >
                <BrainCircuit className="h-3.5 w-3.5 text-violet-600" />
                Claude chat
              </button>
              <button
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted/50"
                onClick={() => { onLaunchChat(laneId, "codex"); setChatOpen(false); }}
              >
                <BrainCircuit className="h-3.5 w-3.5 text-sky-600" />
                Codex chat
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---- Main component ---- */

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
  const [launchPanelOpen, setLaunchPanelOpen] = useState(false);
  const launchPanelRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await window.ade.sessions.list({ limit: 500 });
      setSessions(rows);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh().catch(() => {}); }, []);

  useEffect(() => {
    const laneParam = (searchParams.get("laneId") ?? searchParams.get("lane") ?? "").trim();
    if (laneParam && lanes.some((l) => l.id === laneParam)) setFilterLaneId(laneParam);
    const statusParam = (searchParams.get("status") ?? "").trim();
    if (["running", "completed", "failed", "disposed", "all"].includes(statusParam)) {
      setFilterStatus(statusParam as TerminalSessionStatus | "all");
    }
  }, [searchParams, lanes]);

  useEffect(() => {
    const unsubExit = window.ade.pty.onExit(() => { refresh().catch(() => {}); });
    const t = setInterval(() => {
      if (sessions.some((s) => s.status === "running")) refresh().catch(() => {});
    }, 2000);
    return () => {
      try { unsubExit(); } catch { /* ignore */ }
      clearInterval(t);
    };
  }, [sessions, refresh]);

  useEffect(() => {
    const unsubscribe = window.ade.agentChat.onEvent((payload) => {
      const event = payload.event;
      if (event.type === "done") refresh().catch(() => {});
      if (event.type === "status" && event.turnStatus !== "started") refresh().catch(() => {});
    });
    return unsubscribe;
  }, [refresh]);

  // Close launch panel on outside click
  useEffect(() => {
    if (!launchPanelOpen) return;
    const handler = (e: MouseEvent) => {
      if (launchPanelRef.current && !launchPanelRef.current.contains(e.target as Node)) {
        setLaunchPanelOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [launchPanelOpen]);

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

  const runningSessions = useMemo(() => sessions.filter((s) => s.status === "running" && Boolean(s.ptyId)), [sessions]);
  const selectedSession = useMemo(() => selectedSessionId ? sessions.find((s) => s.id === selectedSessionId) ?? null : null, [sessions, selectedSessionId]);
  const selectedIsChat = useMemo(() => isChatToolType(selectedSession?.toolType), [selectedSession]);
  const selectedHealth = selectedSession ? getTerminalRuntimeHealth(selectedSession.id) : null;

  useEffect(() => {
    if (!selectedSessionId && runningSessions.length > 0) setSelectedSessionId(runningSessions[0]!.id);
  }, [selectedSessionId, runningSessions]);

  /* ---- Session actions ---- */

  const markPtyClosed = (ptyId: string) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.ptyId === ptyId ? { ...s, ptyId: null, status: "disposed", runtimeState: "killed", endedAt: new Date().toISOString(), exitCode: null } : s
      )
    );
  };

  const closeSession = async (ptyId: string) => {
    setClosingPtyIds((prev) => { const n = new Set(prev); n.add(ptyId); return n; });
    markPtyClosed(ptyId);
    try { await window.ade.pty.dispose({ ptyId }); } finally {
      setClosingPtyIds((prev) => { const n = new Set(prev); n.delete(ptyId); return n; });
      await refresh();
    }
  };

  const closeRunning = async () => {
    const ids = runningSessions.map((s) => s.ptyId).filter((id): id is string => Boolean(id));
    await Promise.allSettled(ids.map((id) => closeSession(id)));
  };

  const resumeSession = useCallback(async (session: TerminalSessionSummary) => {
    if (isChatToolType(session.toolType)) {
      if (resumingSessionId) return;
      setResumingSessionId(session.id);
      try {
        await window.ade.agentChat.resume({ sessionId: session.id });
        selectLane(session.laneId);
        focusSession(session.id);
        setSelectedSessionId(session.id);
        await refresh();
      } finally { setResumingSessionId(null); }
      return;
    }
    const command = (session.resumeCommand ?? "").trim();
    if (!command || resumingSessionId) return;
    setResumingSessionId(session.id);
    try {
      const toolType = session.toolType ?? inferToolFromResumeCommand(command) ?? null;
      const started = await window.ade.pty.create({ laneId: session.laneId, cols: 100, rows: 30, title: session.goal?.trim() || session.title || "Terminal", tracked: session.tracked, toolType, startupCommand: command });
      selectLane(session.laneId);
      focusSession(started.sessionId);
      setSelectedSessionId(started.sessionId);
      navigate(`/lanes?laneId=${encodeURIComponent(session.laneId)}&sessionId=${encodeURIComponent(started.sessionId)}`);
    } finally { setResumingSessionId(null); }
  }, [focusSession, navigate, refresh, resumingSessionId, selectLane]);

  const closeChatSession = useCallback(async (sessionId: string) => {
    setClosingChatSessionId(sessionId);
    try { await window.ade.agentChat.dispose({ sessionId }); await refresh(); }
    finally { setClosingChatSessionId((c) => c === sessionId ? null : c); }
  }, [refresh]);

  /* ---- Launch new sessions ---- */

  const handleLaunchPty = useCallback(async (laneId: string, profile: "claude" | "codex" | "shell") => {
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
    await refresh();
    navigate(`/lanes?laneId=${encodeURIComponent(laneId)}&sessionId=${encodeURIComponent(result.sessionId)}`);
  }, [selectLane, focusSession, refresh, navigate]);

  const handleLaunchChat = useCallback(async (laneId: string, provider: "claude" | "codex") => {
    const defaultModel = provider === "codex" ? "gpt-5.3-codex" : "sonnet";
    const session = await window.ade.agentChat.create({ laneId, provider, model: defaultModel });
    selectLane(laneId);
    focusSession(session.id);
    setSelectedSessionId(session.id);
    await refresh();
    navigate(`/lanes?laneId=${encodeURIComponent(laneId)}&sessionId=${encodeURIComponent(session.id)}`);
  }, [selectLane, focusSession, refresh, navigate]);

  /* ---- Session grouping ---- */

  const runningFiltered = useMemo(() => filtered.filter((s) => s.status === "running"), [filtered]);
  const endedFiltered = useMemo(() => filtered.filter((s) => s.status !== "running"), [filtered]);

  /* ---- Pane configs ---- */

  const paneConfigs: Record<string, PaneConfig> = useMemo(() => ({
    sessions: {
      title: "Sessions",
      icon: Terminal,
      meta: loading ? "loading" : `${filtered.length}`,
      children: (
        <div className="flex h-full flex-col">
          {/* Launch panel */}
          <LaunchPanel
            lanes={lanes.map((l) => ({ id: l.id, name: l.name }))}
            onLaunchPty={(laneId, profile) => { handleLaunchPty(laneId, profile).catch(() => {}); }}
            onLaunchChat={(laneId, provider) => { handleLaunchChat(laneId, provider).catch(() => {}); }}
          />

          {/* Filters */}
          <div className="border-b border-border/15 px-3 py-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <select
                className="h-6 flex-1 rounded bg-muted/25 px-2 text-[11px] outline-none hover:bg-muted/40 transition-colors"
                value={filterLaneId}
                onChange={(e) => setFilterLaneId(e.target.value)}
              >
                <option value="all">All lanes</option>
                {lanes.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              <select
                className="h-6 w-28 rounded bg-muted/25 px-2 text-[11px] outline-none hover:bg-muted/40 transition-colors"
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value as TerminalSessionStatus | "all")}
              >
                <option value="all">All</option>
                <option value="running">Running</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
                <option value="disposed">Disposed</option>
              </select>
            </div>
            <input
              className="h-6 w-full rounded bg-muted/25 px-2 text-[11px] outline-none placeholder:text-muted-fg/50 hover:bg-muted/40 transition-colors"
              placeholder="Search sessions..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>

          {/* Session list */}
          <div className="min-h-0 flex-1 overflow-auto">
            {filtered.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center px-4 py-12 text-center">
                <div className="mb-3 rounded-lg bg-muted/20 p-3">
                  <Terminal className="h-5 w-5 text-muted-fg/40" />
                </div>
                <div className="text-xs font-semibold text-fg/50">No sessions</div>
                <div className="mt-1 text-[11px] text-muted-fg/50 leading-relaxed">
                  Launch a session above to get started.
                </div>
              </div>
            ) : (
              <div>
                {/* Running group */}
                {runningFiltered.length > 0 && (
                  <div>
                    <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/10 bg-bg/90 px-3 py-1 backdrop-blur-sm">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
                        Running · {runningFiltered.length}
                      </span>
                    </div>
                    {runningFiltered.map((s) => <SessionRow key={s.id} session={s} isSelected={selectedSessionId === s.id} onSelect={setSelectedSessionId} onResume={() => resumeSession(s).catch(() => {})} resumingSessionId={resumingSessionId} />)}
                  </div>
                )}

                {/* Ended group */}
                {endedFiltered.length > 0 && (
                  <div>
                    <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/10 bg-bg/90 px-3 py-1 backdrop-blur-sm">
                      <span className="h-1.5 w-1.5 rounded-full bg-border" />
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-fg/60">
                        Ended · {endedFiltered.length}
                      </span>
                    </div>
                    {endedFiltered.map((s) => <SessionRow key={s.id} session={s} isSelected={selectedSessionId === s.id} onSelect={setSelectedSessionId} onResume={() => resumeSession(s).catch(() => {})} resumingSessionId={resumingSessionId} />)}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      ),
    },

    terminal: {
      title: "Terminal",
      icon: Monitor,
      bodyClassName: "overflow-hidden",
      meta: selectedSession
        ? selectedIsChat ? "chat" : selectedSession.status === "running" ? "live" : selectedSession.status
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
                    className={cn(
                      "absolute inset-0 h-full w-full transition-opacity duration-150",
                      selectedSession?.id === session.id ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
                    )}
                  />
                ) : null
              )}
              {selectedSession?.status === "running" && selectedSession.ptyId ? null : (
                <div className="absolute inset-0 flex items-center justify-center bg-bg/60 backdrop-blur-[2px]">
                  <div className="rounded-lg border border-border/20 bg-card/90 px-4 py-2.5 text-xs text-muted-fg shadow-card">
                    Select a running session to interact.
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center px-6">
              <div className="mb-3 rounded-lg bg-muted/20 p-3.5">
                <Monitor className="h-6 w-6 text-muted-fg/35" />
              </div>
              <div className="text-sm font-semibold text-fg/50">
                {selectedSession ? "Session not running" : "No session selected"}
              </div>
              <div className="mt-1.5 max-w-xs text-center text-xs leading-relaxed text-muted-fg/50">
                {selectedSession
                  ? "This session has ended. Select a running session to view its terminal."
                  : "Launch or select a session from the list."}
              </div>
            </div>
          )}
        </div>
      ),
    },

    details: {
      title: "Details",
      icon: Info,
      meta: selectedSession ? selectedSession.status : undefined,
      children: (
        <div className="h-full overflow-auto p-3">
          {selectedSession ? (
            <div className="space-y-2.5">
              {/* Metadata */}
              <div className="rounded-lg border border-border/15 bg-muted/10 p-2.5">
                <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-fg/60">
                  <Info className="h-3 w-3" />
                  Session info
                </div>
                <div className="space-y-0">
                  {[
                    ["Title", (selectedSession.goal ?? selectedSession.title).trim()],
                    ["Lane", selectedSession.laneName],
                    ["Status", selectedSession.status],
                    ["Runtime", runtimeStateLabel(selectedSession.runtimeState)],
                    selectedSession.toolType ? ["Tool", selectedSession.toolType] : null,
                    selectedSession.exitCode != null ? ["Exit", `${selectedSession.exitCode}`] : null,
                    !selectedSession.tracked ? ["Context", "no context"] : null,
                    ["Started", new Date(selectedSession.startedAt).toLocaleTimeString()],
                    selectedSession.endedAt ? ["Ended", new Date(selectedSession.endedAt).toLocaleTimeString()] : null,
                  ].filter((row): row is [string, string] => row != null).map(([label, value]) => (
                    <div key={label} className="flex items-center justify-between gap-2 rounded px-1.5 py-1 text-[11px] hover:bg-muted/20 transition-colors">
                      <span className="text-muted-fg/70 shrink-0">{label}</span>
                      <span className="truncate font-medium text-right">{value}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Last output */}
              {sanitizeTerminalInlineText(selectedSession.lastOutputPreview, 420) ? (
                <div className="rounded-lg border border-border/15 bg-muted/10 p-2.5">
                  <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-fg/60">
                    <Monitor className="h-3 w-3" />
                    Last output
                  </div>
                  <pre className="whitespace-pre-wrap break-words rounded border border-border/10 bg-[--color-surface-recessed] px-2.5 py-2 font-mono text-[10.5px] leading-relaxed text-muted-fg/80">
                    {sanitizeTerminalInlineText(selectedSession.lastOutputPreview, 420)}
                  </pre>
                </div>
              ) : null}

              {/* Summary */}
              {selectedSession.summary && selectedSession.status !== "running" ? (
                <div className="rounded-lg border border-border/15 bg-muted/10 p-2.5">
                  <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-fg/60">
                    <FileText className="h-3 w-3" />
                    Summary
                  </div>
                  <p className="text-[11px] leading-relaxed text-fg/70">{selectedSession.summary}</p>
                </div>
              ) : null}

              {/* Resume command */}
              {selectedSession.status !== "running" && selectedSession.resumeCommand ? (
                <div className="rounded-lg border border-border/15 bg-muted/10 p-2.5">
                  <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-fg/60">
                    <Play className="h-3 w-3" />
                    Resume command
                  </div>
                  <code className="block rounded border border-border/10 bg-[--color-surface-recessed] px-2.5 py-1.5 font-mono text-[10.5px] text-fg/80">
                    {selectedSession.resumeCommand}
                  </code>
                </div>
              ) : null}

              {/* Terminal health */}
              {selectedHealth ? (
                <div className="rounded-lg border border-border/15 bg-muted/10 p-2.5">
                  <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-fg/60">
                    <Info className="h-3 w-3" />
                    Terminal health
                  </div>
                  <div className="grid grid-cols-2 gap-1 text-[10.5px] font-mono text-muted-fg/70">
                    <span>fit_failures: {selectedHealth.fitFailures}</span>
                    <span>zero_dim: {selectedHealth.zeroDimFits}</span>
                    <span>renderer: {selectedHealth.rendererFallbacks}</span>
                    <span>dropped: {selectedHealth.droppedChunks}</span>
                  </div>
                </div>
              ) : null}

              {/* Actions */}
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {selectedSession.status === "running" && selectedSession.ptyId ? (
                  <Button variant="outline" size="sm" disabled={closingPtyIds.has(selectedSession.ptyId)} onClick={() => { if (selectedSession.ptyId) closeSession(selectedSession.ptyId).catch(() => {}); }}>
                    <Square className="h-3.5 w-3.5" />
                    {closingPtyIds.has(selectedSession.ptyId) ? "Closing..." : "Close"}
                  </Button>
                ) : null}
                {selectedSession.status === "running" && selectedIsChat ? (
                  <Button variant="outline" size="sm" disabled={closingChatSessionId === selectedSession.id} onClick={() => closeChatSession(selectedSession.id).catch(() => {})}>
                    <Square className="h-3.5 w-3.5" />
                    {closingChatSessionId === selectedSession.id ? "Ending..." : "End chat"}
                  </Button>
                ) : null}
                {selectedSession.status !== "running" && selectedSession.resumeCommand ? (
                  <>
                    <Button variant="outline" size="sm" disabled={resumingSessionId != null} onClick={() => resumeSession(selectedSession).catch(() => {})}>
                      <Play className="h-3.5 w-3.5" />
                      {resumingSessionId === selectedSession.id ? "Resuming..." : "Resume"}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => { navigator.clipboard.writeText(selectedSession.resumeCommand ?? "").catch(() => {}); }}>
                      <Clipboard className="h-3.5 w-3.5" />
                      Copy
                    </Button>
                  </>
                ) : null}
                <Button variant="outline" size="sm" onClick={() => { selectLane(selectedSession.laneId); focusSession(selectedSession.id); navigate(`/lanes?laneId=${encodeURIComponent(selectedSession.laneId)}&sessionId=${encodeURIComponent(selectedSession.id)}`); }}>
                  Go to lane
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center px-6">
              <div className="mb-3 rounded-lg bg-muted/20 p-3.5">
                <Info className="h-5 w-5 text-muted-fg/35" />
              </div>
              <div className="text-xs font-semibold text-fg/50">No session selected</div>
              <div className="mt-1 text-center text-[11px] text-muted-fg/50 leading-relaxed">
                Click a session from the list to view details.
              </div>
            </div>
          )}
        </div>
      ),
    },
  }), [
    filtered, runningFiltered, endedFiltered, loading, filterLaneId, filterStatus, q, lanes,
    selectedSessionId, selectedSession, selectedIsChat, selectedHealth,
    closingPtyIds, closingChatSessionId, resumingSessionId,
    selectLane, focusSession, navigate, closeSession, closeChatSession, resumeSession,
    handleLaunchPty, handleLaunchChat,
  ]);

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      {/* Header */}
      <div className="border-b border-border/20 px-3 py-2">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold tracking-tight text-fg/80">Work</span>
            {runningSessions.length > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                {runningSessions.length} running
              </span>
            ) : null}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              disabled={runningSessions.length === 0}
              onClick={() => closeRunning().catch(() => {})}
            >
              <Square className="h-3.5 w-3.5" />
              Close all
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => refresh().catch(() => {})}
              title="Refresh"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      <PaneTilingLayout
        layoutId="work:tiling:v2"
        tree={TERMINALS_TILING_TREE}
        panes={paneConfigs}
        className="flex-1 min-h-0"
      />
    </div>
  );
}

/* ---- Session row ---- */

function SessionRow({
  session,
  isSelected,
  onSelect,
  onResume,
  resumingSessionId,
}: {
  session: TerminalSessionSummary;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onResume: () => void;
  resumingSessionId: string | null;
}) {
  const dot = statusDot(session);
  const canResume = session.status !== "running" && Boolean(session.resumeCommand);

  return (
    <div className="group relative border-b border-border/8 last:border-b-0">
      <button
        type="button"
        className={cn(
          "w-full border-l-2 px-3 py-2.5 text-left transition-colors duration-100",
          isSelected
            ? "border-l-accent bg-accent/8 text-fg"
            : "border-l-transparent hover:bg-muted/25 hover:border-l-border/40",
          !isSelected && toolBorderClass(session.toolType),
          isSelected && "border-l-accent"
        )}
        onClick={() => onSelect(session.id)}
      >
        <div className="flex items-center gap-2 min-w-0">
          {/* Status dot */}
          <span
            title={dot.label}
            className={cn("h-2 w-2 shrink-0 rounded-full", dot.cls, dot.spinning && "animate-spin")}
          />
          {/* Title */}
          <span className={cn("min-w-0 flex-1 truncate text-xs font-semibold", isSelected && "text-accent")}>
            {(session.goal ?? session.title).trim()}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-1.5 pl-4">
          <span className="truncate text-[10.5px] text-muted-fg/70">{session.laneName}</span>
          {session.toolType ? (
            <span className={cn("rounded px-1 py-0.5 text-[9.5px] font-medium leading-none", toolBadgeClass(session.toolType))}>
              {session.toolType}
            </span>
          ) : null}
          {session.exitCode != null && session.exitCode !== 0 ? (
            <span className="rounded bg-red-500/12 px-1 py-0.5 text-[9.5px] font-mono font-medium text-red-600 leading-none">
              exit {session.exitCode}
            </span>
          ) : null}
        </div>
      </button>
      {/* Resume on hover */}
      {canResume ? (
        <button
          type="button"
          className="absolute right-2 top-2.5 inline-flex items-center gap-1 rounded border border-border/30 bg-card/90 px-1.5 py-0.5 text-[10px] text-muted-fg opacity-0 transition-opacity hover:text-fg group-hover:opacity-100"
          disabled={resumingSessionId != null}
          onClick={(e) => { e.stopPropagation(); onResume(); }}
          title="Resume"
        >
          <Play className="h-2.5 w-2.5" />
          Resume
        </button>
      ) : null}
    </div>
  );
}
