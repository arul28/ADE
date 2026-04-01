import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "../../ui/Button";
import { TerminalView } from "../../terminals/TerminalView";
import { PostResolutionActions } from "./PostResolutionActions";
import { UnifiedModelSelector } from "../UnifiedModelSelector";
import { getDefaultModelDescriptor, MODEL_REGISTRY, getModelById, type ModelDescriptor } from "../../../../shared/modelRegistry";
import type {
  AiDetectedAuth,
  AiConfig,
  ExternalConflictResolverProvider,
  PrepareResolverSessionResult,
  ResolverSessionScenario,
  ConflictExternalResolverRunSummary,
  ConflictResolverPostActionState,
} from "../../../../shared/types";

type ResolverModalPhase = "configure" | "preparing" | "running" | "done";
type DoneStatus = "completed" | "failed" | "cancelled";
type AiPermissionMode = "read_only" | "guarded_edit" | "full_edit";

type PostResolutionBehavior = {
  autoCommit: boolean;
  autoPush: boolean;
  commitMessage: string;
};

function buildResolverCommand(
  provider: ExternalConflictResolverProvider,
  opts: {
    promptFilePath: string;
    permissionMode: AiPermissionMode;
    model?: string;
    reasoningEffort?: string | null;
  }
): string {
  const q = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  const promptArg = `"$(cat ${q(opts.promptFilePath)})"`;

  if (provider === "claude") {
    const parts: string[] = ["claude"];
    if (opts.permissionMode === "full_edit") {
      parts.push("--dangerously-skip-permissions");
    } else if (opts.permissionMode === "guarded_edit") {
      parts.push("--permission-mode", "acceptEdits");
    } else {
      parts.push("--permission-mode", "manual");
    }
    if (opts.model) {
      parts.push("--model", opts.model);
    }
    parts.push(promptArg);
    return parts.join(" ");
  }

  // Codex
  const parts: string[] = ["codex"];
  if (opts.permissionMode === "full_edit") {
    parts.push("--full-auto");
  } else if (opts.permissionMode === "guarded_edit") {
    parts.push("--ask-for-approval", "on-failure", "--sandbox", "workspace-write");
  } else {
    parts.push("--ask-for-approval", "untrusted", "--sandbox", "read-only");
  }
  if (opts.model) {
    parts.push("--model", opts.model);
  }
  parts.push(promptArg);
  return parts.join(" ");
}

function resolveRegistryModelId(value: string | null | undefined): string | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized.length) return null;
  const match = MODEL_REGISTRY.find(
    (model) =>
      model.id.toLowerCase() === normalized
      || model.shortId.toLowerCase() === normalized
      || model.sdkModelId.toLowerCase() === normalized
  );
  return match?.id ?? null;
}

function resolveCliRegistryModelId(provider: "codex" | "claude" | "cursor", value: string | null | undefined): string | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized.length) return null;
  const family = provider === "codex" ? "openai" : provider === "cursor" ? "cursor" : "anthropic";
  const match = MODEL_REGISTRY.find(
    (model) =>
      model.isCliWrapped
      && model.family === family
      && (
        model.id.toLowerCase() === normalized
        || model.shortId.toLowerCase() === normalized
        || model.sdkModelId.toLowerCase() === normalized
      )
  );
  return match?.id ?? null;
}

function hasConfiguredNonCliAuth(model: ModelDescriptor, detectedAuth: AiDetectedAuth[]): boolean {
  return model.authTypes.some((authType) => {
    if (authType === "api-key") {
      return detectedAuth.some((auth) => auth.type === "api-key" && auth.provider === model.family);
    }
    if (authType === "openrouter") {
      return detectedAuth.some((auth) => auth.type === "openrouter");
    }
    if (authType === "local") {
      if (model.family === "ollama" || model.family === "lmstudio" || model.family === "vllm") {
        return detectedAuth.some((auth) => auth.type === "local" && auth.provider === model.family);
      }
      return detectedAuth.some((auth) => auth.type === "local");
    }
    return false;
  });
}

function deriveConfiguredCliModelIdsFromStatus(status: {
  availableProviders: { codex: boolean; claude: boolean; cursor: boolean };
  models: { codex: Array<{ id: string }>; claude: Array<{ id: string }>; cursor: Array<{ id: string }> };
  detectedAuth?: AiDetectedAuth[];
}): string[] {
  const available = new Set<string>();
  const defaultClaudeModelId = getDefaultModelDescriptor("claude")?.id ?? "anthropic/claude-sonnet-4-6";
  const defaultCodexModelId = getDefaultModelDescriptor("codex")?.id ?? "openai/gpt-5.4-codex";

  if (status.availableProviders.codex) {
    for (const model of status.models.codex ?? []) {
      const resolved = resolveCliRegistryModelId("codex", model.id);
      if (resolved) available.add(resolved);
    }
  }

  if (status.availableProviders.claude) {
    for (const model of status.models.claude ?? []) {
      const resolved = resolveCliRegistryModelId("claude", model.id);
      if (resolved) available.add(resolved);
    }
  }

  // Cursor models are excluded: the resolver terminal only supports Claude CLI and Codex CLI;
  // cursor/* IDs would be misclassified by inferProviderFromModel and cannot be launched here.

  const detectedAuth = status.detectedAuth ?? [];
  if (detectedAuth.length) {
    for (const model of MODEL_REGISTRY) {
      if (model.deprecated || model.isCliWrapped) continue;
      if (!hasConfiguredNonCliAuth(model, detectedAuth)) continue;
      // Resolver modal is currently terminal-based; map non-CLI configured models to closest CLI family defaults.
      if (model.family === "anthropic") available.add(defaultClaudeModelId);
      if (model.family === "openai") available.add(defaultCodexModelId);
    }
  }

  return MODEL_REGISTRY
    .filter((model) => model.isCliWrapped && !model.deprecated && available.has(model.id))
    .map((model) => model.id);
}

function inferProviderFromModel(modelId: string): ExternalConflictResolverProvider {
  const descriptor = getModelById(modelId);
  return descriptor?.family === "anthropic" ? "claude" : "codex";
}

function Spinner({ className }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className ?? "h-4 w-4"}`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

async function prepareResolverSessionDirect(args: {
  provider: ExternalConflictResolverProvider;
  targetLaneId: string;
  sourceLaneIds: string[];
  cwdLaneId?: string;
  scenario: ResolverSessionScenario;
  model?: string;
  reasoningEffort?: string | null;
  permissionMode?: AiPermissionMode;
  originSurface?: "mission" | "integration" | "rebase" | "queue" | "graph" | "manual";
}): Promise<{ result: PrepareResolverSessionResult | null; error: string | null }> {
  try {
    const result = await window.ade.conflicts.prepareResolverSession({
      provider: args.provider,
      targetLaneId: args.targetLaneId,
      sourceLaneIds: args.sourceLaneIds,
      cwdLaneId: args.cwdLaneId,
      scenario: args.scenario,
      model: args.model,
      reasoningEffort: args.reasoningEffort ?? null,
      permissionMode: args.permissionMode === "read_only"
        ? "read_only"
        : args.permissionMode === "full_edit"
          ? "full_edit"
          : "guarded_edit",
      originSurface: args.originSurface ?? "manual",
    });
    if (result.status === "blocked") {
      const reason = result.contextGaps.length
        ? result.contextGaps.map((gap) => gap.message).join(", ")
        : "missing context";
      return { result: null, error: `Blocked: ${reason}` };
    }
    return { result, error: null };
  } catch (error) {
    return { result: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function finalizeResolverSessionDirect(args: {
  runId: string;
  exitCode: number;
  postActions?: Partial<ConflictResolverPostActionState> | null;
}): Promise<{ summary: ConflictExternalResolverRunSummary | null; error: string | null }> {
  try {
    const summary = await window.ade.conflicts.finalizeResolverSession(args);
    return { summary, error: null };
  } catch (error) {
    return { summary: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export function ResolverTerminalModal({
  open,
  onOpenChange,
  sourceLaneId,
  targetLaneId,
  sourceLaneIds,
  cwdLaneId,
  scenario,
  postResolutionDefaults,
  initialModel,
  initialReasoningEffort,
  availableModelIds: availableModelIdsProp,
  onModelChange,
  sourceTab,
  onStarted,
  onBackgroundSession,
  onCompleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceLaneId: string | null;
  targetLaneId: string | null;
  sourceLaneIds?: string[];
  cwdLaneId?: string | null;
  scenario?: ResolverSessionScenario;
  postResolutionDefaults?: Partial<PostResolutionBehavior>;
  initialModel?: string;
  initialReasoningEffort?: string | null;
  availableModelIds?: string[];
  onModelChange?: (model: string, reasoningEffort: string | null) => void;
  sourceTab?: "rebase" | "normal" | "integration" | "queue" | "graph" | "mission";
  onStarted?: (result: {
    ptyId: string;
    sessionId: string;
    provider: ExternalConflictResolverProvider;
    startedAt: string;
  }) => void;
  onBackgroundSession?: (session: {
    ptyId: string;
    sessionId: string;
    provider: ExternalConflictResolverProvider;
    startedAt: string;
  }) => void;
  onCompleted?: (result?: {
    status: DoneStatus;
    laneId: string | null;
    autoCommitted: boolean;
    autoPushed: boolean;
    error: string | null;
  }) => void;
}) {
  // Local state
  const [phase, setPhase] = React.useState<ResolverModalPhase>("configure");
  const [resolverModel, setResolverModel] = React.useState(initialModel ?? "");
  const [resolverReasoningEffort, setResolverReasoningEffort] = React.useState<string | null>(initialReasoningEffort ?? "medium");
  const [availableModelIds, setAvailableModelIds] = React.useState<string[]>(availableModelIdsProp ?? []);
  const provider: ExternalConflictResolverProvider = inferProviderFromModel(resolverModel);
  const [permissionMode, setPermissionMode] = React.useState<AiPermissionMode>("guarded_edit");
  const [anticipatedRepoPath, setAnticipatedRepoPath] = React.useState<string | null>(null);
  const [keptRunningInBackground, setKeptRunningInBackground] = React.useState(false);
  const selectedModelDescriptor = getModelById(resolverModel);
  const reasoningTiers = selectedModelDescriptor?.reasoningTiers ?? [];
  const effectiveAvailableModelIds = availableModelIdsProp?.length ? availableModelIdsProp : availableModelIds;
  const [postResolution, setPostResolution] = React.useState<PostResolutionBehavior>(() => ({
    autoCommit: postResolutionDefaults?.autoCommit === true,
    autoPush: postResolutionDefaults?.autoPush === true,
    commitMessage: (postResolutionDefaults?.commitMessage ?? "Resolve conflicts via AI").trim() || "Resolve conflicts via AI",
  }));

  // Running state
  const [prepResult, setPrepResult] = React.useState<PrepareResolverSessionResult | null>(null);
  const [ptyId, setPtyId] = React.useState<string | null>(null);
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [runStartedAt, setRunStartedAt] = React.useState<string | null>(null);

  // Done state
  const [doneStatus, setDoneStatus] = React.useState<DoneStatus | null>(null);
  const [, setExitCode] = React.useState<number | null>(null);
  const [modifiedFiles, setModifiedFiles] = React.useState<string[]>([]);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [postActionBusy, setPostActionBusy] = React.useState(false);
  const [postActionInfo, setPostActionInfo] = React.useState<string | null>(null);
  const [postActionError, setPostActionError] = React.useState<string | null>(null);

  const ptyIdRef = React.useRef<string | null>(null);
  const prepResultRef = React.useRef<PrepareResolverSessionResult | null>(null);
  const cancelRequestedRef = React.useRef(false);

  // Keep prepResultRef in sync so the exit handler always reads the latest value
  React.useEffect(() => { prepResultRef.current = prepResult; }, [prepResult]);

  // Load persisted model override on mount
  React.useEffect(() => {
    void (async () => {
      try {
        const [s, snapshot, laneRows] = await Promise.all([
          window.ade.ai.getStatus(),
          window.ade.projectConfig.get(),
          window.ade.lanes.list({ includeStatus: false }).catch(() => []),
        ]);
        const configuredCliModelIds = deriveConfiguredCliModelIdsFromStatus(s);
        setAvailableModelIds(configuredCliModelIds);
        const effectiveAiRaw = snapshot.effective?.ai;
        const effectiveAi = effectiveAiRaw && typeof effectiveAiRaw === "object" ? (effectiveAiRaw as AiConfig) : null;
        const persisted = effectiveAi?.featureModelOverrides?.conflict_proposals;
        const resolvedPersisted = resolveRegistryModelId(persisted);
        const fallback = configuredCliModelIds.includes(resolvedPersisted ?? "")
          ? (resolvedPersisted ?? "")
          : (configuredCliModelIds[0] ?? "");
        if (!initialModel) {
          setResolverModel(fallback);
        }
        const anticipatedLaneId = (cwdLaneId ?? sourceLaneId ?? targetLaneId ?? "").trim();
        if (anticipatedLaneId) {
          const lane = Array.isArray(laneRows) ? laneRows.find((entry) => entry.id === anticipatedLaneId) : null;
          setAnticipatedRepoPath(typeof lane?.worktreePath === "string" ? lane.worktreePath : null);
        }
      } catch {
        // ignore — model picker will default to empty
      }
    })();
  }, [cwdLaneId, initialModel, sourceLaneId, targetLaneId]);

  React.useEffect(() => {
    if (!initialModel) return;
    setResolverModel(initialModel);
  }, [initialModel]);

  React.useEffect(() => {
    if (initialReasoningEffort === undefined) return;
    setResolverReasoningEffort(initialReasoningEffort ?? null);
  }, [initialReasoningEffort]);

  React.useEffect(() => {
    if (!effectiveAvailableModelIds.length) return;
    if (resolverModel && effectiveAvailableModelIds.includes(resolverModel)) return;
    const fallback = initialModel && effectiveAvailableModelIds.includes(initialModel)
      ? initialModel
      : (effectiveAvailableModelIds[0] ?? "");
    setResolverModel(fallback);
    onModelChange?.(fallback, resolverReasoningEffort);
  }, [effectiveAvailableModelIds, initialModel, onModelChange, resolverModel, resolverReasoningEffort]);

  React.useEffect(() => {
    if (!reasoningTiers.length) {
      if (resolverReasoningEffort !== null) {
        setResolverReasoningEffort(null);
        onModelChange?.(resolverModel, null);
      }
      return;
    }
    if (resolverReasoningEffort && reasoningTiers.includes(resolverReasoningEffort)) return;
    const preferred = initialReasoningEffort && reasoningTiers.includes(initialReasoningEffort)
      ? initialReasoningEffort
      : (reasoningTiers.includes("medium") ? "medium" : (reasoningTiers[0] ?? null));
    setResolverReasoningEffort(preferred);
    onModelChange?.(resolverModel, preferred);
  }, [initialReasoningEffort, onModelChange, reasoningTiers, resolverModel, resolverReasoningEffort]);

  React.useEffect(() => {
    if (open && keptRunningInBackground) {
      setKeptRunningInBackground(false);
    }
  }, [keptRunningInBackground, open]);

  const runPostResolutionActions = React.useCallback(
    async (laneId: string): Promise<{ autoCommitted: boolean; autoPushed: boolean; error: string | null; postActions: Partial<ConflictResolverPostActionState> | null }> => {
      if (!postResolution.autoCommit) {
        return {
          autoCommitted: false,
          autoPushed: false,
          error: null,
          postActions: {
            autoCommit: false,
            autoPush: false,
            commitMessage: null,
            committedAt: null,
            commitSha: null,
            pushAt: null,
            pushSucceeded: null,
            error: null,
          }
        };
      }

      setPostActionBusy(true);
      setPostActionInfo(null);
      setPostActionError(null);
      try {
        const message = postResolution.commitMessage.trim() || "Resolve conflicts via AI";
        const commitResult = await window.ade.git.commit({ laneId, message });
        const committedAt = new Date().toISOString();
        let info = "Committed resolved changes.";
        let pushAt: string | null = null;
        let pushSucceeded: boolean | null = null;
        if (postResolution.autoPush) {
          await window.ade.git.push({ laneId });
          pushAt = new Date().toISOString();
          pushSucceeded = true;
          info = "Committed and pushed resolved changes.";
        }
        setPostActionInfo(info);
        return {
          autoCommitted: true,
          autoPushed: postResolution.autoPush,
          error: null,
          postActions: {
            autoCommit: true,
            autoPush: postResolution.autoPush,
            commitMessage: message,
            committedAt,
            commitSha: commitResult.postHeadSha,
            pushAt,
            pushSucceeded,
            error: null,
          }
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setPostActionError(message);
        return {
          autoCommitted: false,
          autoPushed: false,
          error: message,
          postActions: {
            autoCommit: postResolution.autoCommit,
            autoPush: postResolution.autoPush,
            commitMessage: postResolution.commitMessage.trim() || "Resolve conflicts via AI",
            committedAt: null,
            commitSha: null,
            pushAt: null,
            pushSucceeded: false,
            error: message,
          }
        };
      } finally {
        setPostActionBusy(false);
      }
    },
    [postResolution.autoCommit, postResolution.autoPush, postResolution.commitMessage]
  );

  // Reset state when modal closes or lane props change while open
  React.useEffect(() => {
    if (open) return;
    if (keptRunningInBackground) return;
    const id = setTimeout(() => {
      setPhase("configure");
      setPrepResult(null);
      setPtyId(null);
      setSessionId(null);
      setRunStartedAt(null);
      setDoneStatus(null);
      setExitCode(null);
      setModifiedFiles([]);
      setErrorMsg(null);
      setPostResolution({
        autoCommit: postResolutionDefaults?.autoCommit === true,
        autoPush: postResolutionDefaults?.autoPush === true,
        commitMessage: (postResolutionDefaults?.commitMessage ?? "Resolve conflicts via AI").trim() || "Resolve conflicts via AI",
      });
      setPostActionBusy(false);
      setPostActionInfo(null);
      setPostActionError(null);
      ptyIdRef.current = null;
      cancelRequestedRef.current = false;
      setKeptRunningInBackground(false);
    }, 200);
    return () => clearTimeout(id);
  }, [keptRunningInBackground, open, postResolutionDefaults, sourceLaneId, targetLaneId]);

  // Listen for PTY exit
  React.useEffect(() => {
    if (!ptyId) return;
    const unsub = window.ade.pty.onExit(async (ev) => {
      if (ev.ptyId !== ptyId) return;
      const code = ev.exitCode ?? -1;
      setExitCode(code);
      if (cancelRequestedRef.current) {
        cancelRequestedRef.current = false;
        return;
      }

      const currentPrepResult = prepResultRef.current;
      if (currentPrepResult) {
        const laneIdForPost = currentPrepResult.cwdLaneId ?? null;
        let autoCommitted = false;
        let autoPushed = false;
        let postError: string | null = null;
        let postActions: Partial<ConflictResolverPostActionState> | null = null;
        if (code === 0 && laneIdForPost) {
          const post = await runPostResolutionActions(laneIdForPost);
          autoCommitted = post.autoCommitted;
          autoPushed = post.autoPushed;
          postError = post.error;
          postActions = post.postActions;
        }

        finalizeResolverSessionDirect({ runId: currentPrepResult.runId, exitCode: code, postActions }).then(({ summary, error }) => {
          const status: DoneStatus = code === 0 ? "completed" : "failed";
          setDoneStatus(status);

          if (summary?.changedFiles && summary.changedFiles.length > 0) {
            setModifiedFiles(summary.changedFiles);
          }
          if (error) {
            setErrorMsg(error);
          }

          setPhase("done");
          onCompleted?.({
            status,
            laneId: laneIdForPost,
            autoCommitted,
            autoPushed,
            error: postError ?? error ?? null
          });
        });
      } else {
        const status: DoneStatus = code === 0 ? "completed" : "failed";
        setDoneStatus(status);
        setPhase("done");
        onCompleted?.({ status, laneId: null, autoCommitted: false, autoPushed: false, error: null });
      }
    });
    return unsub;
  }, [ptyId, onCompleted, runPostResolutionActions]);

  // Run handler
  const handleRun = async () => {
    if (!targetLaneId) return;
    if (!resolverModel) {
      setErrorMsg("Select a configured model before starting.");
      return;
    }

    setPhase("preparing");
    setErrorMsg(null);
    setPostActionInfo(null);
    setPostActionError(null);
    setKeptRunningInBackground(false);
    cancelRequestedRef.current = false;

    const sources = sourceLaneIds ?? (sourceLaneId ? [sourceLaneId] : []);
    const scenarioToUse = scenario ?? (sources.length > 1 ? "sequential-merge" : "single-merge");
    const { result, error } = await prepareResolverSessionDirect({
      provider,
      targetLaneId,
      sourceLaneIds: sources,
      cwdLaneId: cwdLaneId ?? undefined,
      scenario: scenarioToUse,
      model: resolverModel || undefined,
      reasoningEffort: resolverReasoningEffort,
      permissionMode,
      originSurface:
        sourceTab === "integration" ? "integration" :
        sourceTab === "rebase" ? "rebase" :
        sourceTab === "queue" ? "queue" :
        sourceTab === "graph" ? "graph" :
        sourceTab === "mission" ? "mission" :
        "manual",
    });

    if (!result) {
      if (error) setErrorMsg(error);
      setPhase("configure");
      return;
    }

    setPrepResult(result);

    try {
      const pty = await window.ade.pty.create({
        laneId: result.cwdLaneId,
        cwd: result.cwdWorktreePath,
        cols: 100,
        rows: 30,
        title: `Resolve Conflicts (${provider})`,
        tracked: false,
        toolType: provider,
      });
      setPtyId(pty.ptyId);
      setSessionId(pty.sessionId);
      setRunStartedAt(new Date().toISOString());
      ptyIdRef.current = pty.ptyId;
      setPhase("running");

      const cmd = buildResolverCommand(provider, {
        promptFilePath: result.promptFilePath,
        permissionMode,
        model: resolverModel || undefined,
        reasoningEffort: resolverReasoningEffort,
      });
      await window.ade.conflicts.attachResolverSession({
        runId: result.runId,
        ptyId: pty.ptyId,
        sessionId: pty.sessionId,
        command: [cmd],
      });
      onStarted?.({
        ptyId: pty.ptyId,
        sessionId: pty.sessionId,
        provider,
        startedAt: new Date().toISOString(),
      });
      await window.ade.pty.write({ ptyId: pty.ptyId, data: cmd + "\r" });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setDoneStatus("failed");
      setPhase("done");
    }
  };

  // Cancel / dispose PTY
  const disposePty = async () => {
    if (ptyIdRef.current) {
      try {
        await window.ade.pty.dispose({ ptyId: ptyIdRef.current });
      } catch { /* ignore */ }
    }
  };

  const handleCancel = async () => {
    cancelRequestedRef.current = true;
    await disposePty();
    if (prepResult?.runId) {
      try {
        await window.ade.conflicts.cancelResolverSession({ runId: prepResult.runId, reason: "Canceled from resolver modal." });
      } catch {
        // ignore cancellation persistence failures
      }
    }
    setDoneStatus("cancelled");
    setPhase("done");
    onCompleted?.({ status: "cancelled", laneId: prepResult?.cwdLaneId ?? null, autoCommitted: false, autoPushed: false, error: null });
  };

  // Close handler with warning
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      if (phase === "running") {
        const keepRunning = window.confirm(
          "Resolution is still running.\nPress OK to keep it running in the background.\nPress Cancel to stop it now."
        );
        if (keepRunning) {
          if (ptyId && sessionId) {
            onBackgroundSession?.({
              ptyId,
              sessionId,
              provider,
              startedAt: runStartedAt ?? new Date().toISOString()
            });
          }
          setKeptRunningInBackground(true);
          onOpenChange(false);
          return;
        }
        void handleCancel().finally(() => onOpenChange(false));
        return;
      }
      void disposePty();
    }
    onOpenChange(next);
  };

  const hasConfiguredModels = effectiveAvailableModelIds.length > 0;
  const modelReady = hasConfiguredModels ? effectiveAvailableModelIds.includes(resolverModel) : Boolean(resolverModel);
  const canRun = !!targetLaneId && (!!sourceLaneId || (sourceLaneIds && sourceLaneIds.length > 0)) && modelReady;

  const permissionDescription = permissionMode === "read_only"
    ? "Read only: AI can inspect files and produce suggestions, but should not apply edits."
    : permissionMode === "guarded_edit"
      ? "Guarded edit: AI can edit files in this repo path and will ask before risky operations."
      : "Full edit: AI can apply edits freely in this repo path. Use only when you trust the prompt and context.";

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          className={`fixed left-1/2 top-[4%] z-50 -translate-x-1/2 rounded bg-card border border-border/40 p-3 shadow-float focus:outline-none max-h-[92vh] overflow-y-auto ${
            phase === "running" || phase === "done"
              ? "w-[min(820px,calc(100vw-24px))]"
              : "w-[min(560px,calc(100vw-24px))]"
          }`}
        >
          <Dialog.Title className="text-sm font-semibold text-fg">
            Resolve Conflicts with AI
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted-fg">
            {phase === "configure" && "Configure an AI CLI to resolve merge conflicts."}
            {phase === "preparing" && "Preparing resolver job — freezing runtime context and writing the effective prompt."}
            {phase === "running" && "Running — watch the terminal output below."}
            {phase === "done" && "Resolution finished."}
          </Dialog.Description>

          {/* Configure phase */}
          {phase === "configure" && (
            <div className="mt-4 space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-fg">Model</label>
                <UnifiedModelSelector
                  value={resolverModel}
                  availableModelIds={effectiveAvailableModelIds}
                  showReasoning
                  reasoningEffort={resolverReasoningEffort}
                  onReasoningEffortChange={(effort) => {
                    setResolverReasoningEffort(effort);
                    onModelChange?.(resolverModel, effort);
                  }}
                  onChange={(modelId) => {
                    setResolverModel(modelId);
                    onModelChange?.(modelId, resolverReasoningEffort);
                    void window.ade.ai.updateConfig({
                      featureModelOverrides: { conflict_proposals: modelId } as AiConfig["featureModelOverrides"],
                    });
                  }}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-fg">Permission mode</label>
                <select
                  value={permissionMode}
                  onChange={(e) => setPermissionMode(e.target.value as AiPermissionMode)}
                  className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-fg focus:border-accent focus:outline-none"
                >
                  <option value="read_only">Read only</option>
                  <option value="guarded_edit">Guarded edit</option>
                  <option value="full_edit">Full edit</option>
                </select>
                <div>
                  <div className="mt-2 text-[11px] text-muted-fg">{permissionDescription}</div>
                  <div className="mt-1 text-[11px] text-muted-fg">
                    Repo path scope: <span className="font-mono text-fg/80">{anticipatedRepoPath ?? "determined at run start"}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-muted-fg">
                    Source tab: <span className="font-mono text-fg/80">{sourceTab ?? "integration"}</span> · Provider: <span className="font-mono text-fg/80">{provider}</span>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-border/50 bg-card/40 p-3 space-y-2">
                <div className="text-xs font-medium text-fg">After Resolution</div>
                <label className="flex items-center gap-2 text-xs text-muted-fg">
                  <input
                    type="checkbox"
                    checked={postResolution.autoCommit}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setPostResolution((prev) => ({
                        ...prev,
                        autoCommit: checked,
                        autoPush: checked ? prev.autoPush : false
                      }));
                    }}
                  />
                  Auto-commit resolved changes
                </label>
                {postResolution.autoCommit ? (
                  <>
                    <label className="block text-xs text-muted-fg">
                      Commit message
                      <input
                        type="text"
                        value={postResolution.commitMessage}
                        onChange={(event) =>
                          setPostResolution((prev) => ({ ...prev, commitMessage: event.target.value }))
                        }
                        className="mt-1 h-8 w-full rounded border border-border/40 bg-card px-2 text-xs text-fg outline-none focus:ring-1 focus:ring-accent/30"
                      />
                    </label>
                    <label className="flex items-center gap-2 text-xs text-muted-fg">
                      <input
                        type="checkbox"
                        checked={postResolution.autoPush}
                        onChange={(event) =>
                          setPostResolution((prev) => ({ ...prev, autoPush: event.target.checked }))
                        }
                      />
                      Auto-push after commit
                    </label>
                  </>
                ) : null}
              </div>

              {/* Warnings */}
              {errorMsg && (
                <div className="rounded border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-700">
                  {errorMsg}
                </div>
              )}
              {effectiveAvailableModelIds.length === 0 ? (
                <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                  No configured resolver models are available. Configure a CLI-backed model in settings first.
                </div>
              ) : null}

              <div className="flex justify-end gap-2 pt-2">
                <Dialog.Close asChild>
                  <Button size="sm" variant="outline">Cancel</Button>
                </Dialog.Close>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!canRun}
                  onClick={() => void handleRun()}
                >
                  Run
                </Button>
              </div>
            </div>
          )}

          {/* Preparing phase */}
          {phase === "preparing" && (
            <div className="mt-4 flex items-center gap-3 py-8">
              <Spinner className="h-5 w-5 text-accent" />
              <span className="text-sm text-muted-fg">Freezing context and writing resolver instructions...</span>
            </div>
          )}

          {/* Running phase */}
          {phase === "running" && ptyId && sessionId && (
            <div className="mt-3">
              {prepResult?.warnings && prepResult.warnings.length > 0 && (
                <div className="mb-2 rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700">
                  {prepResult.warnings.map((w, i) => (
                    <div key={i}>{w}</div>
                  ))}
                </div>
              )}
              <div className="h-[480px] w-full overflow-hidden rounded-lg border border-border">
                <TerminalView ptyId={ptyId} sessionId={sessionId} />
              </div>
              <div className="mt-3 flex justify-end">
                <Button size="sm" variant="outline" onClick={() => void handleCancel()}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Done phase */}
          {phase === "done" && (
            <div className="mt-3 space-y-3">
              <PostResolutionActions
                status={doneStatus ?? undefined}
                modifiedFiles={modifiedFiles.length > 0 ? modifiedFiles : undefined}
                laneId={prepResult?.cwdLaneId ?? null}
                onRouteToLane={
                  prepResult?.cwdLaneId
                    ? () => {
                        onOpenChange(false);
                        onCompleted?.({
                          status: doneStatus ?? "completed",
                          laneId: prepResult?.cwdLaneId ?? null,
                          autoCommitted: postResolution.autoCommit,
                          autoPushed: postResolution.autoCommit && postResolution.autoPush,
                          error: postActionError
                        });
                      }
                    : undefined
                }
                onCommitAndOpenPr={
                  doneStatus === "completed"
                    ? () => {
                        onOpenChange(false);
                        onCompleted?.({
                          status: doneStatus,
                          laneId: prepResult?.cwdLaneId ?? null,
                          autoCommitted: postResolution.autoCommit,
                          autoPushed: postResolution.autoCommit && postResolution.autoPush,
                          error: postActionError
                        });
                      }
                    : undefined
                }
              />

              {postActionBusy ? (
                <div className="rounded border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-accent">
                  Applying post-resolution actions...
                </div>
              ) : null}
              {postActionInfo ? (
                <div className="rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
                  {postActionInfo}
                </div>
              ) : null}
              {postActionError ? (
                <div className="rounded border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-700">
                  Post-action failed: {postActionError}
                </div>
              ) : null}

              {errorMsg && (
                <div className="rounded border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-700">
                  {errorMsg}
                </div>
              )}

              {/* Show terminal output in smaller view */}
              {ptyId && sessionId && (
                <div className="h-[300px] w-full overflow-hidden rounded-lg border border-border">
                  <TerminalView ptyId={ptyId} sessionId={sessionId} />
                </div>
              )}

              <div className="flex justify-end">
                <Dialog.Close asChild>
                  <Button size="sm" variant="outline">Close</Button>
                </Dialog.Close>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
