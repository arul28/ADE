import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowSquareIn,
  ArrowSquareOut,
  ArrowsClockwise,
  CloudArrowUp,
  Stop,
  Trash,
} from "@phosphor-icons/react";
import type {
  CursorCloudAgentSummary,
  CursorCloudOpenChatResult,
  CursorCloudRepository,
  CursorCloudRunSummary,
} from "../../../shared/types";
import { getModelById } from "../../../shared/modelRegistry";
import { openExternalUrl } from "../../lib/openExternal";
import { repoMatchKey } from "../../lib/cursorCloudUtils";
import { cn } from "../ui/cn";
import { SmartTooltip } from "../ui/SmartTooltip";

const CURSOR_VIOLET = "#A78BFA";

const TERMINAL_STATUSES = new Set(["finished", "completed", "error", "failed", "cancelled", "expired"]);

function isActiveStatus(status: string | undefined | null): boolean {
  if (!status) return false;
  return !TERMINAL_STATUSES.has(status.toLowerCase());
}

function statusToneClass(status: string | undefined | null): string {
  const s = (status ?? "").toLowerCase();
  if (s === "running" || s === "creating") return "border-violet-300/30 bg-violet-500/10 text-violet-100/85";
  if (s === "finished" || s === "completed") return "border-emerald-400/22 bg-emerald-500/8 text-emerald-100/80";
  if (s === "error" || s === "failed") return "border-red-400/22 bg-red-500/8 text-red-200/85";
  if (s === "cancelled" || s === "expired") return "border-white/[0.10] bg-white/[0.03] text-fg/45";
  return "border-white/[0.08] bg-white/[0.025] text-fg/55";
}

function formatAge(value: number | string | null | undefined): string | null {
  const ts = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Date.parse(value)
      : NaN;
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const delta = Date.now() - ts;
  if (delta < 0) return null;
  if (delta < 45_000) return "just now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function shortAgentId(agentId: string): string {
  if (agentId.length <= 10) return agentId;
  return agentId.slice(0, 5) + "…" + agentId.slice(-4);
}

function repoLabel(url: string): string {
  if (!url) return "";
  const trimmed = url.replace(/\.git$/i, "").replace(/\/+$/, "");
  const parts = trimmed.split("/");
  if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  return trimmed;
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+':\s*/i, "").trim() || "Cursor Cloud request failed.";
}

export type ChatCursorCloudPanelHandle = {
  launchWithPrompt: (promptText: string) => Promise<{ agentId: string } | null>;
  hasRequiredFields: () => boolean;
};

type ChatCursorCloudPanelProps = {
  cursorCloudAgentId: string | null;
  cursorRuntime: "local" | "cloud";
  cursorModelIds: string[];
  defaultRepoUrl?: string | null;
  defaultBranch?: string | null;
  defaultModelSdkId?: string | null;
  laneGitRemote?: string | null;
  laneId?: string | null;
  onLaunched?: (agentId: string) => void;
  onClose: () => void;
  onOpened?: (result: CursorCloudOpenChatResult) => void;
  onMissingFields?: (message: string) => void;
};

export const ChatCursorCloudPanel = forwardRef<ChatCursorCloudPanelHandle, ChatCursorCloudPanelProps>(function ChatCursorCloudPanel({
  cursorCloudAgentId,
  cursorRuntime,
  cursorModelIds,
  defaultRepoUrl,
  defaultBranch,
  defaultModelSdkId,
  laneGitRemote,
  laneId,
  onLaunched,
  onClose,
  onOpened,
  onMissingFields,
}, ref) {
  const [repos, setRepos] = useState<CursorCloudRepository[]>([]);
  const [agents, setAgents] = useState<CursorCloudAgentSummary[]>([]);
  const [activeRuns, setActiveRuns] = useState<Record<string, CursorCloudRunSummary[]>>({});
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState(defaultRepoUrl ?? "");
  const [startingRef, setStartingRef] = useState(defaultBranch ?? "");
  const [modelId, setModelId] = useState(defaultModelSdkId ?? "");
  const [prUrl, setPrUrl] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [confirmDeleteAgentId, setConfirmDeleteAgentId] = useState<string | null>(null);
  const [expandedRunKey, setExpandedRunKey] = useState<string | null>(null);
  const reposLoadedRef = useRef(false);

  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    return cursorModelIds
      .filter((id) => id.startsWith("cursor/"))
      .map((id) => {
        const value = id.replace(/^cursor\//, "");
        if (!value || seen.has(value)) return null;
        seen.add(value);
        return {
          id,
          value,
          label: getModelById(id)?.displayName ?? value,
        };
      })
      .filter((entry): entry is { id: string; value: string; label: string } => Boolean(entry));
  }, [cursorModelIds]);

  const refresh = useCallback(async (opts?: { soft?: boolean }) => {
    if (opts?.soft) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const [nextRepos, nextAgents] = await Promise.all([
        reposLoadedRef.current ? Promise.resolve(repos) : window.ade.ai.cursorCloudListRepositories(),
        window.ade.ai.cursorCloudListAgents({ includeArchived, limit: 16 }),
      ]);
      if (!reposLoadedRef.current) {
        setRepos(nextRepos);
        reposLoadedRef.current = true;
      }
      setAgents(nextAgents.items);
      setRepoUrl((current) => {
        if (current) return current;
        if (defaultRepoUrl) return defaultRepoUrl;
        if (laneGitRemote) {
          const targetKey = repoMatchKey(laneGitRemote);
          if (targetKey) {
            const match = nextRepos.find((repo) => repoMatchKey(repo.url) === targetKey);
            if (match) return match.url;
          }
        }
        return nextRepos[0]?.url || "";
      });
      setModelId((current) => current || modelOptions[0]?.value || "");

      const runningAgents = nextAgents.items.filter((agent) => isActiveStatus(agent.status));
      if (runningAgents.length) {
        const runsList = await Promise.all(runningAgents.map(async (agent) => {
          try {
            const result = await window.ade.ai.cursorCloudListRuns({ agentId: agent.agentId, limit: 4 });
            return [agent.agentId, result.items.filter((run) => isActiveStatus(run.status))] as const;
          } catch {
            return [agent.agentId, [] as CursorCloudRunSummary[]] as const;
          }
        }));
        const next: Record<string, CursorCloudRunSummary[]> = {};
        for (const [id, runs] of runsList) next[id] = runs;
        setActiveRuns(next);
      } else {
        setActiveRuns({});
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [defaultRepoUrl, includeArchived, laneGitRemote, modelOptions, repos]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    void refreshRef.current();
    const interval = window.setInterval(() => {
      void refreshRef.current({ soft: true });
    }, 8_000);
    return () => window.clearInterval(interval);
  }, [includeArchived]);

  useEffect(() => {
    if (!defaultRepoUrl) return;
    setRepoUrl((current) => current || defaultRepoUrl);
  }, [defaultRepoUrl]);

  useEffect(() => {
    if (!defaultBranch) return;
    setStartingRef((current) => current || defaultBranch);
  }, [defaultBranch]);

  useEffect(() => {
    if (!defaultModelSdkId) return;
    setModelId((current) => current || defaultModelSdkId);
  }, [defaultModelSdkId]);

  // When the lane's git remote becomes available after initial load (it's
  // fetched async on panel open), upgrade the auto-selection from "first repo"
  // to the lane's repo if it matches a connected one. We only override when
  // the current selection is the fallback first repo and not what the user
  // actively chose.
  useEffect(() => {
    if (!laneGitRemote) return;
    if (repos.length === 0) return;
    const targetKey = repoMatchKey(laneGitRemote);
    if (!targetKey) return;
    const match = repos.find((repo) => repoMatchKey(repo.url) === targetKey);
    if (!match) return;
    setRepoUrl((current) => {
      if (current === match.url) return current;
      // Only upgrade if the current value is empty or the auto-picked first repo.
      if (!current || current === repos[0]?.url) return match.url;
      return current;
    });
  }, [laneGitRemote, repos]);

  const sessionAgent = useMemo(() => {
    if (!cursorCloudAgentId) return null;
    return agents.find((agent) => agent.agentId === cursorCloudAgentId) ?? null;
  }, [agents, cursorCloudAgentId]);

  const sessionActiveRuns = sessionAgent ? activeRuns[sessionAgent.agentId] ?? [] : [];

  const otherActiveAgents = useMemo(() => {
    return agents.filter((agent) => {
      if (!isActiveStatus(agent.status)) return false;
      if (sessionAgent && agent.agentId === sessionAgent.agentId) return false;
      return true;
    });
  }, [agents, sessionAgent]);

  const recentAgents = useMemo(() => {
    return agents
      .filter((agent) => !isActiveStatus(agent.status))
      .filter((agent) => sessionAgent ? agent.agentId !== sessionAgent.agentId : true)
      .slice(0, 6);
  }, [agents, sessionAgent]);

  const launchWithPrompt = useCallback(async (rawPrompt: string): Promise<{ agentId: string } | null> => {
    const trimmedPrompt = rawPrompt.trim();
    const trimmedRepo = repoUrl.trim();
    if (!trimmedPrompt) {
      onMissingFields?.("Type a prompt in the chat composer first.");
      return null;
    }
    if (!trimmedRepo) {
      onMissingFields?.("Pick a repository in the cloud panel first.");
      return null;
    }
    setLoading(true);
    setError(null);
    try {
      const created = await window.ade.ai.cursorCloudCreateRun({
        promptText: trimmedPrompt,
        repoUrl: trimmedRepo,
        startingRef: startingRef.trim() || null,
        modelId: modelId.trim() || null,
        autoCreatePR: false,
        workOnCurrentBranch: false,
        prUrl: prUrl.trim() || null,
        skipReviewerRequest: true,
      });
      setPrUrl("");
      onLaunched?.(created.agent.agentId);
      await refresh({ soft: true });
      return { agentId: created.agent.agentId };
    } catch (err) {
      setError(errorMessage(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, [modelId, onLaunched, onMissingFields, prUrl, refresh, repoUrl, startingRef]);

  useImperativeHandle(ref, () => ({
    launchWithPrompt,
    hasRequiredFields: () => Boolean(repoUrl.trim()),
  }), [launchWithPrompt, repoUrl]);

  const cancelRun = useCallback(async (agentId: string, runId: string) => {
    setBusyAgentId(agentId);
    setError(null);
    try {
      await window.ade.ai.cursorCloudCancelRun({ agentId, runId });
      await refresh({ soft: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyAgentId(null);
    }
  }, [refresh]);

  const archiveAgent = useCallback(async (agentId: string, currentlyArchived: boolean) => {
    setBusyAgentId(agentId);
    setError(null);
    try {
      if (currentlyArchived) await window.ade.ai.cursorCloudUnarchiveAgent(agentId);
      else await window.ade.ai.cursorCloudArchiveAgent(agentId);
      await refresh({ soft: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyAgentId(null);
    }
  }, [refresh]);

  const deleteAgent = useCallback(async (agentId: string) => {
    setBusyAgentId(agentId);
    setError(null);
    try {
      await window.ade.ai.cursorCloudDeleteAgent(agentId);
      setAgents((prev) => prev.filter((agent) => agent.agentId !== agentId));
      setConfirmDeleteAgentId(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyAgentId(null);
    }
  }, []);

  const openChat = useCallback(async (agentId: string) => {
    if (!laneId) {
      setError("Open a lane to open this cloud chat.");
      return;
    }
    setBusyAgentId(agentId);
    setError(null);
    try {
      const result = await window.ade.ai.cursorCloudOpenChat({ cloudAgentId: agentId, laneId });
      // Only close the panel after we've handed the new session id to the
      // parent. If onClose ran first (or unconditionally) the panel would
      // unmount before onOpened could navigate, leaving the user on the
      // previous chat with no visible feedback.
      onOpened?.(result);
      onClose();
    } catch (err) {
      // Log so a silent renderer failure surfaces in DevTools — the panel's
      // error banner only shows while the panel is open.
      // eslint-disable-next-line no-console
      console.error("[cursor-cloud] openChat failed", err);
      setError(errorMessage(err));
    } finally {
      setBusyAgentId(null);
    }
  }, [laneId, onClose, onOpened]);

  return (
    <>
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <CloudArrowUp size={14} weight="fill" style={{ color: CURSOR_VIOLET }} />
          <span className="font-sans text-[12px] font-medium text-fg/80">Cursor Cloud agents</span>
          <RuntimeChip runtime={cursorRuntime} />
          {refreshing ? (
            <ArrowsClockwise size={10} weight="bold" className="animate-spin text-fg/30" />
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void refresh({ soft: true })}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/[0.06] bg-white/[0.025] text-fg/45 transition-colors hover:border-white/[0.10] hover:text-fg/75"
            title="Refresh"
            aria-label="Refresh cloud panel"
            disabled={loading || refreshing}
          >
            <ArrowsClockwise size={12} weight="bold" />
          </button>
          <button
            type="button"
            className="rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-0.5 font-sans text-[10px] font-medium text-fg/50 transition-colors hover:text-fg/80"
            onClick={onClose}
            title="Close cloud panel"
            aria-label="Close cloud panel"
          >
            Close
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="border-b border-red-500/15 bg-red-500/[0.05] px-4 py-2 font-sans text-[11px] leading-5 text-red-200/85">
            {error.includes("Add a Cursor API key")
              ? "Add a Cursor API key in Settings → AI providers."
              : error}
          </div>
        ) : null}

        <div className="space-y-4 px-4 py-3">
          {/* Active runs */}
          {(sessionActiveRuns.length > 0 || otherActiveAgents.length > 0) ? (
            <section>
              <SectionLabel>Active runs</SectionLabel>
              <div className="mt-2 space-y-2">
                {sessionAgent && sessionActiveRuns.length > 0 ? sessionActiveRuns.map((run) => {
                  const key = `${sessionAgent.agentId}:${run.runId}`;
                  return (
                    <ActiveRunRow
                      key={key}
                      agent={sessionAgent}
                      run={run}
                      pinned
                      busy={busyAgentId === sessionAgent.agentId}
                      expanded={expandedRunKey === key}
                      onToggleExpand={() => setExpandedRunKey(expandedRunKey === key ? null : key)}
                      onCancel={() => void cancelRun(sessionAgent.agentId, run.runId)}
                    />
                  );
                }) : null}
                {otherActiveAgents.map((agent) => {
                  const runs = activeRuns[agent.agentId] ?? [];
                  if (runs.length === 0) {
                    return (
                      <ActiveAgentRow
                        key={agent.agentId}
                        agent={agent}
                      />
                    );
                  }
                  return runs.map((run) => {
                    const key = `${agent.agentId}:${run.runId}`;
                    return (
                      <ActiveRunRow
                        key={key}
                        agent={agent}
                        run={run}
                        busy={busyAgentId === agent.agentId}
                        expanded={expandedRunKey === key}
                        onToggleExpand={() => setExpandedRunKey(expandedRunKey === key ? null : key)}
                        onCancel={() => void cancelRun(agent.agentId, run.runId)}
                      />
                    );
                  });
                })}
              </div>
            </section>
          ) : null}


          {/* Recent / archived */}
          <section>
            <div className="flex items-center justify-between gap-2">
              <SectionLabel>Open existing cloud chat</SectionLabel>
              <label className="inline-flex items-center gap-1.5 font-sans text-[10px] text-fg/55">
                <input
                  type="checkbox"
                  checked={includeArchived}
                  onChange={(event) => setIncludeArchived(event.target.checked)}
                  className="h-3 w-3 accent-violet-400"
                />
                Show archived
              </label>
            </div>
            <div className="mt-2 space-y-1.5">
              {recentAgents.length === 0 ? (
                <div className="rounded-md border border-white/[0.05] bg-white/[0.015] px-3 py-3 text-center font-sans text-[11px] text-fg/35">
                  {loading ? "Loading…" : "No finished agents."}
                </div>
              ) : recentAgents.map((agent) => (
                <RecentAgentRow
                  key={agent.agentId}
                  agent={agent}
                  busy={busyAgentId === agent.agentId}
                  confirmingDelete={confirmDeleteAgentId === agent.agentId}
                  canOpen={Boolean(laneId) && !agent.archived}
                  onArchive={() => void archiveAgent(agent.agentId, Boolean(agent.archived))}
                  onRequestDelete={() => setConfirmDeleteAgentId(
                    confirmDeleteAgentId === agent.agentId ? null : agent.agentId,
                  )}
                  onConfirmDelete={() => void deleteAgent(agent.agentId)}
                  onOpen={() => void openChat(agent.agentId)}
                />
              ))}
            </div>
          </section>

        </div>
      </div>
    </>
  );
});

function RuntimeChip({ runtime }: { runtime: "local" | "cloud" }) {
  const isCloud = runtime === "cloud";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-sans text-[10px] font-medium",
        isCloud
          ? "border-violet-300/30 text-violet-100/85"
          : "border-white/[0.10] text-fg/55",
      )}
      style={isCloud ? { background: "rgba(167,139,250,0.10)" } : undefined}
      title={isCloud ? "This chat sends to Cursor Cloud by default" : "This chat runs locally by default"}
    >
      {runtime}
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-sans text-[10px] font-semibold uppercase text-fg/45">{children}</span>
  );
}

function ActiveRunRow({
  agent,
  run,
  pinned = false,
  busy,
  expanded,
  onToggleExpand,
  onCancel,
}: {
  agent: CursorCloudAgentSummary;
  run: CursorCloudRunSummary;
  pinned?: boolean;
  busy: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onCancel: () => void;
}) {
  const status = (run.status || agent.status || "running").toLowerCase();
  const age = formatAge(agent.lastModified ?? agent.createdAt);
  const gitInfo = isRecord(run.git) ? run.git : null;
  const branch = gitInfo && typeof gitInfo.branch === "string" ? gitInfo.branch : null;
  const prUrl = gitInfo && typeof gitInfo.prUrl === "string" ? gitInfo.prUrl : null;
  return (
    <div
      className={cn(
        "rounded-md border bg-white/[0.02] transition-colors hover:bg-white/[0.035]",
        pinned ? "border-violet-300/22" : "border-white/[0.06]",
      )}
      style={pinned ? { boxShadow: "inset 0 0 0 1px rgba(167,139,250,0.10)" } : undefined}
    >
      <button
        type="button"
        onClick={onToggleExpand}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        aria-expanded={expanded}
      >
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ background: CURSOR_VIOLET }} />
          <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: CURSOR_VIOLET }} />
        </span>
        <span className="min-w-0 flex-1 truncate font-sans text-[12px] font-medium text-fg/82">
          {agent.name || shortAgentId(agent.agentId)}
        </span>
        <StatusPill status={status} />
      </button>
      <div className="flex items-center gap-2 px-3 pb-2 font-mono text-[10px] text-fg/35">
        {run.modelId ? <span className="text-fg/55">{run.modelId}</span> : null}
        {agent.repos?.[0] ? <span className="truncate">{repoLabel(agent.repos[0])}</span> : null}
        {age ? <span>· {age}</span> : null}
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="ml-auto inline-flex h-6 items-center gap-1 rounded-md border border-red-400/20 bg-red-500/[0.06] px-1.5 font-sans text-[10px] font-medium text-red-200/85 transition-colors hover:bg-red-500/[0.10] disabled:opacity-40"
          title="Stop run"
          aria-label="Stop cloud run"
        >
          <Stop size={10} weight="fill" />
          Stop
        </button>
      </div>
      {expanded ? (
        <div className="border-t border-white/[0.05] px-3 py-2 space-y-1 font-mono text-[10px] text-fg/45">
          <div><span className="text-fg/30">agent</span> {shortAgentId(agent.agentId)}</div>
          <div><span className="text-fg/30">run</span> {run.runId.length > 16 ? run.runId.slice(0, 12) + "…" : run.runId}</div>
          {branch ? <div><span className="text-fg/30">branch</span> {branch}</div> : null}
          {agent.summary ? <div className="text-fg/55">{agent.summary}</div> : null}
          <div className="flex items-center gap-3 pt-1">
            {agent.webUrl ? (
              <button
                type="button"
                onClick={() => openExternalUrl(agent.webUrl)}
                className="inline-flex items-center gap-1 text-fg/45 hover:text-fg/80"
              >
                <ArrowSquareOut size={9} weight="bold" />
                Open in Cursor
              </button>
            ) : null}
            {prUrl ? (
              <button
                type="button"
                onClick={() => openExternalUrl(prUrl)}
                className="inline-flex items-center gap-1 text-violet-200/65 hover:text-violet-100"
              >
                PR
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ActiveAgentRow({
  agent,
}: {
  agent: CursorCloudAgentSummary;
}) {
  return (
    <div className="rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: CURSOR_VIOLET }} />
        <span className="min-w-0 flex-1 truncate font-sans text-[12px] font-medium text-fg/82">
          {agent.name || shortAgentId(agent.agentId)}
        </span>
        <StatusPill status={agent.status ?? "running"} />
      </div>
      {agent.repos?.[0] ? (
        <div className="mt-1 truncate font-mono text-[10px] text-fg/35">
          {repoLabel(agent.repos[0])}
        </div>
      ) : null}
    </div>
  );
}

function RecentAgentRow({
  agent,
  busy,
  confirmingDelete,
  canOpen,
  onArchive,
  onRequestDelete,
  onConfirmDelete,
  onOpen,
}: {
  agent: CursorCloudAgentSummary;
  busy: boolean;
  confirmingDelete: boolean;
  canOpen: boolean;
  onArchive: () => void;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
  onOpen: () => void;
}) {
  const status = agent.archived ? "archived" : (agent.status ?? "finished");
  const age = formatAge(agent.lastModified ?? agent.createdAt);
  const repoUrl = agent.repos?.[0] ?? null;
  return (
    <div className="group rounded-lg border border-white/[0.06] bg-white/[0.015] px-3 py-2.5 transition-colors hover:border-violet-300/20 hover:bg-white/[0.03]">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 truncate font-sans text-[12.5px] font-semibold tracking-tight text-fg/85">
              {agent.name || shortAgentId(agent.agentId)}
            </span>
            <StatusPill status={status} />
            {age ? <span className="font-mono text-[10px] text-fg/35">{age}</span> : null}
          </div>
          {repoUrl ? (
            <div className="truncate font-mono text-[10.5px] text-fg/45">{repoLabel(repoUrl)}</div>
          ) : null}
          {agent.summary && agent.summary !== agent.name ? (
            <div className="truncate font-sans text-[11px] leading-snug text-fg/55">{agent.summary}</div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {canOpen ? (
            <SmartTooltip content={{ label: "Open cloud chat in ADE", description: "Open this Cursor Cloud agent as a chat in this ADE lane. Replies still run in cloud." }}>
              <button
                type="button"
                onClick={onOpen}
                disabled={busy}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-violet-300/25 bg-violet-500/[0.10] px-2 font-sans text-[11px] font-semibold text-violet-100/90 transition-colors hover:border-violet-300/40 hover:bg-violet-500/[0.18] disabled:opacity-40"
                aria-label="Open cloud chat in ADE"
              >
                <ArrowSquareIn size={10} weight="bold" />
                Open
              </button>
            </SmartTooltip>
          ) : null}
          {agent.webUrl ? (
            <SmartTooltip content={{ label: "Open in Cursor", description: "View this agent on cursor.com." }}>
              <button
                type="button"
                onClick={() => openExternalUrl(agent.webUrl)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/[0.06] text-fg/45 transition-colors hover:border-white/[0.16] hover:text-fg/85"
                aria-label="Open in Cursor"
              >
                <ArrowSquareOut size={10} weight="bold" />
              </button>
            </SmartTooltip>
          ) : null}
          <SmartTooltip content={{ label: agent.archived ? "Unarchive" : "Archive", description: agent.archived ? "Move this agent back into the active list." : "Hide this agent from the list. Conversation stays readable." }}>
            <button
              type="button"
              onClick={onArchive}
              disabled={busy}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/[0.06] text-fg/45 transition-colors hover:border-white/[0.16] hover:text-fg/85 disabled:opacity-40"
              aria-label={agent.archived ? "Unarchive cloud agent" : "Archive cloud agent"}
            >
              <Archive size={10} weight="bold" />
            </button>
          </SmartTooltip>
          <SmartTooltip content={{ label: confirmingDelete ? "Confirm delete" : "Delete", description: "Permanently delete this cloud agent." }}>
            <button
              type="button"
              onClick={confirmingDelete ? onConfirmDelete : onRequestDelete}
              disabled={busy}
              className={cn(
                "inline-flex h-7 items-center justify-center rounded-md border transition-colors disabled:opacity-40",
                confirmingDelete
                  ? "border-red-400/35 bg-red-500/[0.12] px-2 text-red-200/95 hover:bg-red-500/[0.18]"
                  : "w-7 border-white/[0.06] text-fg/40 hover:border-red-500/30 hover:text-red-300/85",
              )}
              aria-label={confirmingDelete ? "Confirm delete cloud agent" : "Delete cloud agent"}
            >
              {confirmingDelete ? (
                <span className="font-sans text-[10px] font-bold">Delete?</span>
              ) : (
                <Trash size={10} weight="bold" />
              )}
            </button>
          </SmartTooltip>
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  // Mirrors the shared `Chip` primitive (font-mono / uppercase / tracking) but
  // accepts a tone palette. Status pills are the one place font-mono is
  // intentional in this panel.
  const tone = statusToneClass(status);
  const label = status.toLowerCase();
  return (
    <span className={cn(
      "inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[1px]",
      tone,
    )}>
      {label}
    </span>
  );
}
