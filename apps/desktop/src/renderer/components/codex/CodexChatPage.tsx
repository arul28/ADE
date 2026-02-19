import React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Loader2,
  LogIn,
  LogOut,
  Play,
  RefreshCw,
  ShieldAlert,
  Square,
  StopCircle
} from "lucide-react";
import type {
  CodexAccountState,
  CodexApprovalDecision,
  CodexConnectionState,
  CodexModel,
  CodexPendingApprovalRequest,
  CodexReasoningEffort,
  CodexRateLimitSnapshot,
  CodexRateLimits,
  CodexThread,
  CodexThreadItem,
  CodexTurn
} from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import {
  codexChatReducer,
  createInitialCodexChatState,
  getActiveTurnId,
  getApprovalForItem,
  getApprovalsForTurn,
  getOrderedTurns,
  type CodexChatItem,
  type CodexChatTurn
} from "../../state/codexChatState";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";

function nowIso(): string {
  return new Date().toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function shortId(value: string | null | undefined): string {
  const raw = (value ?? "").trim();
  if (!raw.length) return "";
  if (raw.length <= 10) return raw;
  return `${raw.slice(0, 6)}…${raw.slice(-4)}`;
}

function formatUnixSeconds(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return new Date(value * 1000).toLocaleString();
}

function formatRateLimit(snapshot: CodexRateLimitSnapshot | null | undefined): string {
  if (!snapshot?.primary) return "n/a";
  const used = `${snapshot.primary.usedPercent.toFixed(1)}%`;
  if (!snapshot.primary.resetsAt) return used;
  return `${used}, resets ${formatUnixSeconds(snapshot.primary.resetsAt)}`;
}

function itemTextFallback(item: CodexChatItem): string {
  if (item.text.trim().length > 0) return item.text;
  if (item.aggregatedOutput?.trim().length) return item.aggregatedOutput;
  return "";
}

function renderItemBody(item: CodexChatItem): React.ReactNode {
  const record = item.raw;

  if (item.type === "userMessage" || item.type === "agentMessage" || item.type === "plan" || item.type === "reasoning") {
    const body = itemTextFallback(item);
    return body ? (
      <pre className="whitespace-pre-wrap break-words rounded-md bg-[--color-surface-recessed] px-3 py-2 text-xs leading-relaxed text-fg/85">
        {body}
      </pre>
    ) : (
      <div className="text-xs text-muted-fg">No text payload.</div>
    );
  }

  if (item.type === "commandExecution") {
    const exitCode = typeof record.exitCode === "number" ? record.exitCode : null;
    const durationMs = typeof record.durationMs === "number" ? record.durationMs : null;
    return (
      <div className="space-y-2">
        <div className="rounded-md bg-[--color-surface-recessed] px-3 py-2">
          {item.command ? <div className="font-mono text-xs text-fg">{item.command}</div> : null}
          {item.cwd ? <div className="mt-1 text-[11px] text-muted-fg">cwd: {item.cwd}</div> : null}
        </div>
        {item.aggregatedOutput ? (
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/85 px-3 py-2 text-[11px] leading-relaxed text-emerald-200">
            {item.aggregatedOutput}
          </pre>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-fg">
          {item.status ? <Chip>{item.status}</Chip> : null}
          {exitCode != null ? <Chip>exit {exitCode}</Chip> : null}
          {durationMs != null ? <Chip>{durationMs} ms</Chip> : null}
        </div>
      </div>
    );
  }

  if (item.type === "fileChange") {
    const changes = Array.isArray(record.changes) ? record.changes : [];
    return (
      <div className="space-y-2">
        <div className="text-xs text-muted-fg">{changes.length} file change(s)</div>
        {changes.length > 0 ? (
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[--color-surface-recessed] px-3 py-2 text-[11px] leading-relaxed text-fg/85">
            {JSON.stringify(changes, null, 2)}
          </pre>
        ) : null}
        {item.text.trim().length ? (
          <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[--color-surface-recessed] px-3 py-2 text-[11px] leading-relaxed text-fg/85">
            {item.text}
          </pre>
        ) : null}
      </div>
    );
  }

  if (item.type === "mcpToolCall") {
    const tool = asString(record.tool) ?? "tool";
    const server = asString(record.server) ?? "server";
    return (
      <div className="space-y-2">
        <div className="text-xs text-muted-fg">
          {server}/{tool}
        </div>
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[--color-surface-recessed] px-3 py-2 text-[11px] leading-relaxed text-fg/85">
          {JSON.stringify(record, null, 2)}
        </pre>
      </div>
    );
  }

  return (
    <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[--color-surface-recessed] px-3 py-2 text-[11px] leading-relaxed text-fg/85">
      {JSON.stringify(record, null, 2)}
    </pre>
  );
}

function isTurnTerminalStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized === "completed" || normalized === "failed" || normalized === "cancelled" || normalized === "canceled";
}

function isThreadNotMaterializedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();
  return normalized.includes("is not materialized yet") || normalized.includes("includeturns is unavailable before first user message");
}

function isThreadMissingRolloutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();
  return normalized.includes("no rollout found for thread id") || normalized.includes("missing rollout path");
}

function formatEffortLabel(effort: CodexReasoningEffort): string {
  if (effort === "xhigh") return "Extra High";
  if (effort === "none") return "None";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

type ThreadAction = "idle" | "starting" | "resuming";

export function CodexChatPage({
  embedded = false,
  laneIdOverride = null,
  onCloseEmbedded
}: {
  embedded?: boolean;
  laneIdOverride?: string | null;
  onCloseEmbedded?: () => void;
} = {}) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const lanes = useAppStore((s) => s.lanes);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const selectLane = useAppStore((s) => s.selectLane);

  const laneFromParams = embedded ? "" : (searchParams.get("laneId") ?? "").trim();
  const threadFromParams = embedded ? "" : (searchParams.get("threadId") ?? "").trim();
  const normalizedLaneOverride = (laneIdOverride ?? "").trim();

  const laneId = React.useMemo(() => {
    if (normalizedLaneOverride && lanes.some((lane) => lane.id === normalizedLaneOverride)) return normalizedLaneOverride;
    if (laneFromParams && lanes.some((lane) => lane.id === laneFromParams)) return laneFromParams;
    if (selectedLaneId && lanes.some((lane) => lane.id === selectedLaneId)) return selectedLaneId;
    return lanes[0]?.id ?? null;
  }, [laneFromParams, normalizedLaneOverride, selectedLaneId, lanes]);

  const laneName = React.useMemo(() => lanes.find((lane) => lane.id === laneId)?.name ?? "", [lanes, laneId]);

  const [connectionState, setConnectionState] = React.useState<CodexConnectionState | null>(null);
  const [accountState, setAccountState] = React.useState<CodexAccountState | null>(null);
  const [rateLimits, setRateLimits] = React.useState<CodexRateLimits | null>(null);
  const [models, setModels] = React.useState<CodexModel[]>([]);
  const [selectedModel, setSelectedModel] = React.useState<string>("");
  const [selectedEffort, setSelectedEffort] = React.useState<CodexReasoningEffort>("high");
  const [threadList, setThreadList] = React.useState<CodexThread[]>([]);
  const [laneBinding, setLaneBinding] = React.useState<{ defaultThreadId: string | null; recentThreadIds: string[] } | null>(null);

  const [pageBusy, setPageBusy] = React.useState(false);
  const [threadAction, setThreadAction] = React.useState<ThreadAction>("idle");
  const [sendBusy, setSendBusy] = React.useState(false);
  const [interruptBusy, setInterruptBusy] = React.useState(false);
  const [loginBusy, setLoginBusy] = React.useState(false);
  const [loginPendingId, setLoginPendingId] = React.useState<string | null>(null);
  const [showAdvancedAuth, setShowAdvancedAuth] = React.useState(false);
  const [apiKeyInput, setApiKeyInput] = React.useState("");
  const [approvalBusyById, setApprovalBusyById] = React.useState<Record<string, boolean>>({});

  const [composer, setComposer] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const [chatState, dispatch] = React.useReducer(codexChatReducer, undefined, () => createInitialCodexChatState(nowIso()));

  const turns = React.useMemo(() => getOrderedTurns(chatState), [chatState]);
  const activeTurnId = React.useMemo(() => getActiveTurnId(chatState), [chatState]);

  const syncRoute = React.useCallback(
    (nextLaneId: string, nextThreadId: string | null, replace = false) => {
      if (embedded) return;
      const next = new URLSearchParams();
      next.set("laneId", nextLaneId);
      if (nextThreadId) next.set("threadId", nextThreadId);
      const qs = next.toString();
      navigate(qs.length ? `/codex?${qs}` : "/codex", { replace });
    },
    [embedded, navigate]
  );

  const refreshConnection = React.useCallback(async () => {
    const state = await window.ade.codex.getConnectionState();
    setConnectionState(state);
    return state;
  }, []);

  const refreshAccount = React.useCallback(async (refreshToken = false) => {
    const account = await window.ade.codex.accountRead({ refreshToken });
    setAccountState(account);
    return account;
  }, []);

  const refreshRateLimits = React.useCallback(async () => {
    try {
      const limits = await window.ade.codex.accountRateLimitsRead();
      setRateLimits(limits);
      return limits;
    } catch {
      setRateLimits(null);
      return null;
    }
  }, []);

  const refreshModels = React.useCallback(async () => {
    const result = await window.ade.codex.modelList({ limit: 100 });
    setModels(result.data);
    const defaultModel = result.data.find((row) => row.isDefault) ?? result.data[0] ?? null;
    setSelectedModel((current) => (current ? current : defaultModel?.model ?? current));
    if (defaultModel?.defaultReasoningEffort) {
      setSelectedEffort(defaultModel.defaultReasoningEffort);
    }
    return result.data;
  }, []);

  const refreshThreadList = React.useCallback(async () => {
    const result = await window.ade.codex.threadList({ limit: 100, sortKey: "updated_at" });
    setThreadList(result.data);
    return result.data;
  }, []);

  const refreshLaneBinding = React.useCallback(async (targetLaneId: string) => {
    const binding = await window.ade.codex.getLaneBinding(targetLaneId);
    setLaneBinding({ defaultThreadId: binding.defaultThreadId, recentThreadIds: binding.recentThreadIds });
    return binding;
  }, []);

  const loadApprovals = React.useCallback(async (threadId: string) => {
    const requests = await window.ade.codex.listPendingApprovals({ threadId });
    dispatch({ type: "approvals-loaded", requests, at: nowIso() });
  }, []);

  const hydrateThread = React.useCallback(
    async (thread: CodexThread, targetLaneId: string, replaceRoute = true) => {
      dispatch({ type: "hydrate-thread", thread, at: nowIso() });
      await refreshLaneBinding(targetLaneId);
      await loadApprovals(thread.id);
      syncRoute(targetLaneId, thread.id, replaceRoute);
    },
    [loadApprovals, refreshLaneBinding, syncRoute]
  );

  const startThread = React.useCallback(async () => {
    if (!laneId) throw new Error("No lane selected.");
    setThreadAction("starting");
    setError(null);
    try {
      const thread = await window.ade.codex.threadStart({
        laneId,
        model: selectedModel || null,
        approvalPolicy: "on-request",
        sandbox: "workspace-write"
      });
      await hydrateThread(thread, laneId, false);
      await refreshThreadList();
      return thread;
    } finally {
      setThreadAction("idle");
    }
  }, [hydrateThread, laneId, refreshThreadList, selectedModel]);

  const resumeThread = React.useCallback(
    async (threadId: string, replaceRoute = false) => {
      if (!laneId) throw new Error("No lane selected.");
      const normalizedThreadId = threadId.trim();
      if (!normalizedThreadId.length) throw new Error("Thread id is required.");

      setThreadAction("resuming");
      setError(null);
      try {
        const thread = await window.ade.codex.threadResume({
          laneId,
          threadId: normalizedThreadId,
          model: selectedModel || null,
          approvalPolicy: "on-request",
          sandbox: "workspace-write"
        });
        await hydrateThread(thread, laneId, replaceRoute);
        await refreshThreadList();
        return thread;
      } catch (resumeError) {
        const resumeMessage = resumeError instanceof Error ? resumeError.message : String(resumeError);

        if (isThreadMissingRolloutError(resumeError)) {
          await window.ade.codex.setLaneDefaultThread({ laneId, threadId: null });
          const fresh = await startThread();
          setError(`Saved thread could not be resumed (${resumeMessage}). Started a new lane thread.`);
          return fresh;
        }

        const includeTurns = !isThreadNotMaterializedError(resumeError);
        const fallback = await window.ade.codex.threadRead({ threadId: normalizedThreadId, includeTurns });
        await hydrateThread(fallback, laneId, replaceRoute);
        setError(
          `thread/resume failed, loaded snapshot via thread/read (${includeTurns ? "with turns" : "without turns"}): ${resumeMessage}`
        );
        return fallback;
      } finally {
        setThreadAction("idle");
      }
    },
    [hydrateThread, laneId, refreshThreadList, selectedModel, startThread]
  );

  const ensureThread = React.useCallback(async (): Promise<CodexThread> => {
    const current = chatState.threadId;
    if (current) {
      const existing = threadList.find((thread) => thread.id === current);
      if (existing) return existing;
      return {
        id: current,
        preview: chatState.preview ?? "",
        modelProvider: "openai",
        createdAt: 0,
        updatedAt: 0,
        path: null,
        cwd: "",
        cliVersion: "",
        source: "app-server",
        gitInfo: null,
        turns: []
      };
    }
    return await startThread();
  }, [chatState.preview, chatState.threadId, startThread, threadList]);

  const submitPrompt = React.useCallback(async () => {
    const prompt = composer.trim();
    if (!prompt.length || sendBusy) return;
    if (!laneId) {
      setError("Select a lane before sending a prompt.");
      return;
    }

    setSendBusy(true);
    setError(null);
    try {
      const thread = await ensureThread();
      const turn = await window.ade.codex.turnStart({
        threadId: thread.id,
        laneId,
        prompt,
        model: selectedModel || null,
        effort: selectedEffort,
        approvalPolicy: "on-request"
      });

      dispatch({
        type: "notification",
        method: "turn/started",
        params: { threadId: thread.id, turn },
        receivedAt: nowIso()
      });

      setComposer("");
      await refreshLaneBinding(laneId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSendBusy(false);
    }
  }, [composer, ensureThread, laneId, refreshLaneBinding, selectedEffort, selectedModel, sendBusy]);

  const interruptTurn = React.useCallback(async () => {
    if (!chatState.threadId || !activeTurnId || interruptBusy) return;
    setInterruptBusy(true);
    try {
      await window.ade.codex.turnInterrupt({ threadId: chatState.threadId, turnId: activeTurnId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInterruptBusy(false);
    }
  }, [activeTurnId, chatState.threadId, interruptBusy]);

  const respondApproval = React.useCallback(
    async (requestId: string, decision: CodexApprovalDecision) => {
      setApprovalBusyById((prev) => ({ ...prev, [requestId]: true }));
      try {
        await window.ade.codex.respondApproval({ requestId, decision });
        dispatch({ type: "approval-removed", requestId, at: nowIso() });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setApprovalBusyById((prev) => {
          const next = { ...prev };
          delete next[requestId];
          return next;
        });
      }
    },
    []
  );

  const startChatGptLogin = React.useCallback(async () => {
    if (loginBusy) return;
    setLoginBusy(true);
    setError(null);
    try {
      const result = await window.ade.codex.accountLoginStart({ type: "chatgpt" });
      if (result.type === "chatgpt") {
        setLoginPendingId(result.loginId);
      }
      await refreshAccount();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoginBusy(false);
    }
  }, [loginBusy, refreshAccount]);

  const cancelLogin = React.useCallback(async () => {
    if (!loginPendingId) return;
    try {
      await window.ade.codex.accountLoginCancel(loginPendingId);
      setLoginPendingId(null);
      await refreshAccount();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [loginPendingId, refreshAccount]);

  const logout = React.useCallback(async () => {
    try {
      await window.ade.codex.accountLogout();
      setLoginPendingId(null);
      await refreshAccount();
      await refreshRateLimits();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [refreshAccount, refreshRateLimits]);

  const loginWithApiKey = React.useCallback(async () => {
    const apiKey = apiKeyInput.trim();
    if (!apiKey.length || loginBusy) return;
    setLoginBusy(true);
    setError(null);
    try {
      await window.ade.codex.accountLoginStart({ type: "apiKey", apiKey, openInBrowser: false });
      setApiKeyInput("");
      setShowAdvancedAuth(false);
      await refreshAccount();
      await refreshRateLimits();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoginBusy(false);
    }
  }, [apiKeyInput, loginBusy, refreshAccount, refreshRateLimits]);

  React.useEffect(() => {
    const unsubscribe = window.ade.codex.onEvent((event) => {
      if (event.type === "connection") {
        setConnectionState(event.state);
        return;
      }

      if (event.type === "server-request") {
        dispatch({ type: "approval-added", request: event.request, at: event.receivedAt });
        return;
      }

      if (event.type === "server-request-resolved") {
        dispatch({ type: "approval-removed", requestId: event.requestId, at: event.at });
        return;
      }

      if (event.type === "transport-error") {
        setError(event.message);
        return;
      }

      if (event.type !== "notification") return;

      dispatch({
        type: "notification",
        method: event.method,
        params: event.params,
        receivedAt: event.receivedAt
      });

      if (event.method === "account/updated") {
        void refreshAccount();
      }
      if (event.method === "account/rateLimits/updated") {
        void refreshRateLimits();
      }
      if (event.method === "account/login/completed") {
        const params = asRecord(event.params);
        const success = params?.success === true;
        const loginId = asString(params?.loginId);
        const failureMessage = asString(params?.error);
        if (!success && failureMessage) {
          setError(`Login failed: ${failureMessage}`);
        }
        if (loginPendingId && (!loginId || loginPendingId === loginId)) {
          setLoginPendingId(null);
        }
        void refreshAccount(true);
        void refreshRateLimits();
      }
    });

    return () => {
      try {
        unsubscribe();
      } catch {
        // ignore
      }
    };
  }, [loginPendingId, refreshAccount, refreshRateLimits]);

  React.useEffect(() => {
    if (laneId) {
      selectLane(laneId);
    }
  }, [laneId, selectLane]);

  React.useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setPageBusy(true);
      setError(null);
      dispatch({ type: "reset", threadId: null, at: nowIso() });

      try {
        const [connection, account] = await Promise.all([
          refreshConnection(),
          refreshAccount(),
          refreshRateLimits(),
          refreshModels()
        ]);
        if (cancelled) return;

        setConnectionState(connection);
        setAccountState(account);

        await refreshThreadList();

        if (!laneId) return;
        const binding = await refreshLaneBinding(laneId);
        if (cancelled) return;

        const preferredThreadId = threadFromParams || binding.defaultThreadId;
        if (preferredThreadId) {
          try {
            const thread = await window.ade.codex.threadResume({
              laneId,
              threadId: preferredThreadId,
              model: null,
              approvalPolicy: "on-request",
              sandbox: "workspace-write"
            });
            await hydrateThread(thread, laneId, true);
          } catch (resumeError) {
            const resumeMessage = resumeError instanceof Error ? resumeError.message : String(resumeError);
            if (isThreadMissingRolloutError(resumeError)) {
              await window.ade.codex.setLaneDefaultThread({ laneId, threadId: null });
              const fresh = await window.ade.codex.threadStart({
                laneId,
                model: selectedModel || null,
                approvalPolicy: "on-request",
                sandbox: "workspace-write"
              });
              await hydrateThread(fresh, laneId, true);
              setError(`Saved thread could not be resumed (${resumeMessage}). Started a new lane thread.`);
            } else {
              const includeTurns = !isThreadNotMaterializedError(resumeError);
              const fallback = await window.ade.codex.threadRead({ threadId: preferredThreadId, includeTurns });
              await hydrateThread(fallback, laneId, true);
              setError(
                `thread/resume failed, loaded snapshot via thread/read (${includeTurns ? "with turns" : "without turns"}): ${resumeMessage}`
              );
            }
          }
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setPageBusy(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [embedded, hydrateThread, laneId, refreshAccount, refreshConnection, refreshLaneBinding, refreshModels, refreshRateLimits, refreshThreadList, selectedModel, threadFromParams]);

  const accountLabel = React.useMemo(() => {
    if (!accountState?.account) return "Signed out";
    if (accountState.account.type === "apiKey") return "API key";
    return `${accountState.account.email} (${accountState.account.planType})`;
  }, [accountState]);

  const currentThread = React.useMemo(
    () => threadList.find((thread) => thread.id === chatState.threadId) ?? null,
    [chatState.threadId, threadList]
  );

  const selectedModelRecord = React.useMemo(
    () => models.find((row) => row.model === selectedModel) ?? models.find((row) => row.isDefault) ?? models[0] ?? null,
    [models, selectedModel]
  );

  const availableEfforts = React.useMemo(() => {
    const supported =
      selectedModelRecord?.supportedReasoningEfforts
        ?.map((row) => row.reasoningEffort)
        .filter((row): row is CodexReasoningEffort => Boolean(row)) ?? [];
    if (supported.length) return Array.from(new Set(supported));
    return ["none", "minimal", "low", "medium", "high", "xhigh"] as CodexReasoningEffort[];
  }, [selectedModelRecord]);

  React.useEffect(() => {
    if (!availableEfforts.length) return;
    setSelectedEffort((current) => {
      if (availableEfforts.includes(current)) return current;
      if (selectedModelRecord?.defaultReasoningEffort && availableEfforts.includes(selectedModelRecord.defaultReasoningEffort)) {
        return selectedModelRecord.defaultReasoningEffort;
      }
      return availableEfforts[availableEfforts.length - 1] ?? "high";
    });
  }, [availableEfforts, selectedModelRecord?.defaultReasoningEffort]);

  const recentThreadIds = laneBinding?.recentThreadIds ?? [];

  const connectionVariantClass =
    connectionState?.status === "ready"
      ? "text-emerald-700 bg-emerald-500/15"
      : connectionState?.status === "missing-binary" || connectionState?.status === "error"
        ? "text-red-700 bg-red-500/15"
        : "text-amber-700 bg-amber-500/15";

  return (
    <div className={`flex h-full min-w-0 flex-col ${embedded ? "bg-card/50" : "bg-bg"}`}>
      <div className="border-b border-border/20 bg-gradient-to-b from-surface/80 to-transparent px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          {embedded && onCloseEmbedded ? (
            <Button variant="ghost" size="sm" onClick={onCloseEmbedded} title="Back">
              <ArrowLeft className="h-3.5 w-3.5" />
              Back
            </Button>
          ) : null}
          <div className="text-sm font-semibold text-fg">Codex Chat</div>
          {!embedded ? (
            <select
              className="h-8 min-w-[180px] rounded-lg border border-border/40 bg-card/80 px-2 text-xs"
              value={laneId ?? ""}
              onChange={(event) => {
                const nextLaneId = event.target.value;
                if (!nextLaneId) return;
                syncRoute(nextLaneId, null, false);
              }}
            >
              {lanes.map((lane) => (
                <option key={lane.id} value={lane.id}>
                  {lane.name}
                </option>
              ))}
            </select>
          ) : (
            <Chip>{laneName || "No lane"}</Chip>
          )}
          <Chip className={connectionVariantClass}>connection: {connectionState?.status ?? "unknown"}</Chip>
          <Chip>{accountLabel}</Chip>
          <div className="ml-auto flex items-center gap-2">
            {loginPendingId ? (
              <Button variant="outline" size="sm" onClick={() => void cancelLogin()}>
                <StopCircle className="h-3.5 w-3.5" />
                Cancel Login
              </Button>
            ) : !accountState?.account ? (
              <Button variant="outline" size="sm" disabled={loginBusy} onClick={() => void startChatGptLogin()}>
                {loginBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LogIn className="h-3.5 w-3.5" />}
                Sign In
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => void logout()}>
                <LogOut className="h-3.5 w-3.5" />
                Sign Out
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={!chatState.threadId || !activeTurnId || interruptBusy}
              onClick={() => void interruptTurn()}
              title="Interrupt current turn"
            >
              <Square className="h-3.5 w-3.5" />
              Interrupt
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void window.ade.codex
                  .retryConnection()
                  .then((state) => setConnectionState(state))
                  .catch((err) => setError(err instanceof Error ? err.message : String(err)));
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-fg">
          <span>lane: {laneName || "n/a"}</span>
          <span>thread: {shortId(chatState.threadId) || "none"}</span>
          {selectedModelRecord ? <span>model: {selectedModelRecord.displayName || selectedModelRecord.model}</span> : null}
          <span>effort: {formatEffortLabel(selectedEffort)}</span>
          {currentThread?.updatedAt ? <span>updated: {formatUnixSeconds(currentThread.updatedAt)}</span> : null}
          {rateLimits?.rateLimits ? <span>rate limit: {formatRateLimit(rateLimits.rateLimits)}</span> : null}
          {rateLimits?.rateLimits?.planType ? <span>plan: {rateLimits.rateLimits.planType}</span> : null}
        </div>
        {!accountState?.account ? (
          <div className="mt-2">
            <button
              type="button"
              className="text-[11px] text-muted-fg underline underline-offset-2 hover:text-fg"
              onClick={() => setShowAdvancedAuth((prev) => !prev)}
            >
              {showAdvancedAuth ? "Hide API key login" : "Use API key (advanced)"}
            </button>
            {showAdvancedAuth ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <input
                  type="password"
                  value={apiKeyInput}
                  onChange={(event) => setApiKeyInput(event.target.value)}
                  placeholder="sk-..."
                  className="h-8 min-w-[260px] rounded-lg border border-border/40 bg-card/80 px-2 text-xs"
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!apiKeyInput.trim().length || loginBusy}
                  onClick={() => {
                    void loginWithApiKey();
                  }}
                >
                  Login with API key
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {connectionState?.status === "missing-binary" ? (
        <div className="mx-3 mt-2 rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-2 text-xs text-red-800">
          <div className="flex items-center gap-2 font-medium">
            <ShieldAlert className="h-4 w-4" />
            Codex CLI not found
          </div>
          <div className="mt-1 text-red-700">Install Codex CLI and retry. Example: <code>npm i -g @openai/codex</code></div>
        </div>
      ) : null}

      {connectionState?.status === "error" && connectionState.detail ? (
        <div className="mx-3 mt-2 rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-2 text-xs text-red-800">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" />
            App-server error
          </div>
          <div className="mt-1 text-red-700">{connectionState.detail}</div>
        </div>
      ) : null}

      <div className="border-b border-border/20 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!laneId || threadAction !== "idle"}
            onClick={() => {
              void startThread().catch((err) => setError(err instanceof Error ? err.message : String(err)));
            }}
          >
            {threadAction === "starting" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            New Thread
          </Button>

          <Button
            size="sm"
            variant="outline"
            disabled={!laneId || !laneBinding?.defaultThreadId || threadAction !== "idle"}
            onClick={() => {
              if (!laneBinding?.defaultThreadId) return;
              void resumeThread(laneBinding.defaultThreadId).catch((err) =>
                setError(err instanceof Error ? err.message : String(err))
              );
            }}
          >
            {threadAction === "resuming" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Resume Lane Thread
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void refreshThreadList().catch((err) => setError(err instanceof Error ? err.message : String(err)));
            }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh Threads
          </Button>

          <select
            className="h-8 min-w-[260px] rounded-lg border border-border/40 bg-card/80 px-2 text-xs"
            value={chatState.threadId ?? ""}
            onChange={(event) => {
              const nextThreadId = event.target.value;
              if (!nextThreadId) return;
              void resumeThread(nextThreadId).catch((err) => setError(err instanceof Error ? err.message : String(err)));
            }}
          >
            <option value="">Select thread…</option>
            {threadList.map((thread) => (
              <option key={thread.id} value={thread.id}>
                {shortId(thread.id)} · {thread.preview || "(no preview)"}
              </option>
            ))}
          </select>

          <select
            className="h-8 min-w-[190px] rounded-lg border border-border/40 bg-card/80 px-2 text-xs"
            value={selectedModel}
            onChange={(event) => setSelectedModel(event.target.value)}
          >
            {models.length === 0 ? <option value="">Default model</option> : null}
            {models.map((model) => (
              <option key={model.id} value={model.model}>
                {model.displayName || model.model}
              </option>
            ))}
          </select>

          <select
            className="h-8 min-w-[150px] rounded-lg border border-border/40 bg-card/80 px-2 text-xs"
            value={selectedEffort}
            onChange={(event) => setSelectedEffort(event.target.value as CodexReasoningEffort)}
            title="Reasoning effort"
          >
            {availableEfforts.map((effort) => (
              <option key={effort} value={effort}>
                Effort: {formatEffortLabel(effort)}
              </option>
            ))}
          </select>
        </div>

        {recentThreadIds.length ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-muted-fg">Recent:</span>
            {recentThreadIds.slice(0, 8).map((threadId) => (
              <button
                key={threadId}
                type="button"
                className="rounded-md border border-border/30 bg-card/70 px-2 py-1 text-[11px] text-fg/80 hover:bg-card"
                onClick={() => {
                  void resumeThread(threadId).catch((err) => setError(err instanceof Error ? err.message : String(err)));
                }}
              >
                {shortId(threadId)}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
        {!laneId ? (
          <EmptyState title="No lane selected" description="Select a lane to start Codex chat." />
        ) : pageBusy ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-fg">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading Codex chat…
          </div>
        ) : !chatState.threadId ? (
          <EmptyState
            title="No active thread"
            description="Start a new thread or resume a recent lane thread."
          />
        ) : turns.length === 0 ? (
          <EmptyState
            title="Thread loaded"
            description="Send a prompt to start a turn in this lane-bound thread."
          />
        ) : (
          <div className="space-y-3">
            {turns.map((turn) => {
              const approvalsForTurn = getApprovalsForTurn(chatState, turn.id);
              return (
                <TurnCard
                  key={turn.id}
                  turn={turn}
                  approvalsForTurn={approvalsForTurn}
                  getApprovalForItem={(itemId) => getApprovalForItem(chatState, itemId)}
                  approvalBusyById={approvalBusyById}
                  onDecision={respondApproval}
                />
              );
            })}
          </div>
        )}
      </div>

      <div className="border-t border-border/20 px-3 py-2">
        <textarea
          className="min-h-[88px] w-full rounded-lg border border-border/40 bg-card/70 px-3 py-2 text-sm outline-none focus:border-accent/50"
          placeholder={accountState?.account ? "Ask Codex…" : "Sign in first, then ask Codex…"}
          value={composer}
          disabled={!accountState?.account || sendBusy || !laneId}
          onChange={(event) => setComposer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
              event.preventDefault();
              void submitPrompt();
            }
          }}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <div className="text-[11px] text-muted-fg">Enter to send · Shift+Enter for newline</div>
          {activeTurnId && !isTurnTerminalStatus(chatState.turnsById[activeTurnId]?.status ?? "") ? (
            <Chip>active turn: {shortId(activeTurnId)}</Chip>
          ) : null}
          <div className="ml-auto">
            <Button
              size="sm"
              variant="primary"
              disabled={!composer.trim().length || sendBusy || !accountState?.account || !laneId}
              onClick={() => {
                void submitPrompt();
              }}
            >
              {sendBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Send
            </Button>
          </div>
        </div>
        {error ? (
          <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-xs text-red-700">{error}</div>
        ) : null}
      </div>
    </div>
  );
}

function TurnCard({
  turn,
  approvalsForTurn,
  getApprovalForItem,
  approvalBusyById,
  onDecision
}: {
  turn: CodexChatTurn;
  approvalsForTurn: CodexPendingApprovalRequest[];
  getApprovalForItem: (itemId: string) => CodexPendingApprovalRequest | null;
  approvalBusyById: Record<string, boolean>;
  onDecision: (requestId: string, decision: CodexApprovalDecision) => Promise<void>;
}) {
  const orphanApprovals = approvalsForTurn.filter(
    (request) => !turn.itemOrder.includes(request.itemId)
  );

  return (
    <div className="rounded-xl border border-border/25 bg-card/60 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="text-xs font-semibold text-fg">Turn {shortId(turn.id)}</div>
        <Chip>{turn.status}</Chip>
        {turn.error ? <Chip className="bg-red-500/20 text-red-700">{turn.error}</Chip> : null}
        {turn.startedAt ? <span className="text-[11px] text-muted-fg">started {new Date(turn.startedAt).toLocaleTimeString()}</span> : null}
      </div>

      {turn.plan.length || turn.planExplanation ? (
        <div className="mb-2 rounded-md border border-border/20 bg-[--color-surface-recessed] px-3 py-2">
          <div className="text-[11px] font-semibold text-muted-fg">Plan</div>
          {turn.planExplanation ? <div className="mt-1 text-xs text-fg/80">{turn.planExplanation}</div> : null}
          {turn.plan.length ? (
            <div className="mt-1 space-y-1">
              {turn.plan.map((step, index) => (
                <div key={`${step.step}-${index}`} className="flex items-center gap-2 text-xs text-fg/80">
                  <Chip className="text-[10px]">{step.status}</Chip>
                  <span>{step.step}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {turn.diff ? (
        <div className="mb-2">
          <div className="mb-1 text-[11px] font-semibold text-muted-fg">Turn Diff</div>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[--color-surface-recessed] px-3 py-2 text-[11px] leading-relaxed text-fg/85">
            {turn.diff}
          </pre>
        </div>
      ) : null}

      <div className="space-y-2">
        {turn.itemOrder.map((itemId) => {
          const item = turn.itemsById[itemId];
          if (!item) return null;
          const approval = getApprovalForItem(item.id);
          return (
            <div key={item.id} className="rounded-md border border-border/20 bg-bg/40 px-2.5 py-2">
              <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px]">
                <div className="font-medium text-fg/90">{item.type}</div>
                {item.status ? <Chip>{item.status}</Chip> : null}
                <span className="text-muted-fg">{shortId(item.id)}</span>
              </div>
              {renderItemBody(item)}
              {approval ? (
                <ApprovalCard
                  request={approval}
                  busy={Boolean(approvalBusyById[approval.requestId])}
                  onDecision={onDecision}
                />
              ) : null}
            </div>
          );
        })}

        {orphanApprovals.length
          ? orphanApprovals.map((request) => (
              <ApprovalCard
                key={request.requestId}
                request={request}
                busy={Boolean(approvalBusyById[request.requestId])}
                onDecision={onDecision}
              />
            ))
          : null}
      </div>
    </div>
  );
}

function ApprovalCard({
  request,
  busy,
  onDecision
}: {
  request: CodexPendingApprovalRequest;
  busy: boolean;
  onDecision: (requestId: string, decision: CodexApprovalDecision) => Promise<void>;
}) {
  return (
    <div className="mt-2 rounded-md border border-amber-500/35 bg-amber-500/10 px-3 py-2">
      <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-amber-800">
        <ShieldAlert className="h-3.5 w-3.5" />
        Approval required
      </div>
      <div className="space-y-0.5 text-[11px] text-amber-900">
        <div>type: {request.method}</div>
        {request.reason ? <div>reason: {request.reason}</div> : null}
        {request.command ? <div className="font-mono">command: {request.command}</div> : null}
        {request.cwd ? <div>cwd: {request.cwd}</div> : null}
        {request.grantRoot ? <div>grant root: {request.grantRoot}</div> : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void onDecision(request.requestId, "accept")}>
          <Check className="h-3.5 w-3.5" />
          Accept
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void onDecision(request.requestId, "acceptForSession")}>
          Accept For Session
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void onDecision(request.requestId, "decline")}>
          Decline
        </Button>
      </div>
    </div>
  );
}
