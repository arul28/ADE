import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "../../ui/Button";
import { TerminalView } from "../../terminals/TerminalView";
import { ProviderSelector } from "../shared/ProviderSelector";
import { PostResolutionActions } from "../shared/PostResolutionActions";
import type {
  ExternalConflictResolverProvider,
  PrepareResolverSessionResult,
  ResolverSessionScenario,
  ConflictExternalResolverRunSummary,
} from "../../../../shared/types";

type ResolverModalPhase = "configure" | "preparing" | "running" | "done";
type DoneStatus = "completed" | "failed" | "cancelled";

// Claude permission modes
type ClaudePermissionMode = "bypass" | "acceptEdits" | "manual";
// Codex approval modes
type CodexApprovalMode = "fullAuto" | "autoEdit" | "suggest" | "manual";

type PostResolutionBehavior = {
  autoCommit: boolean;
  autoPush: boolean;
  commitMessage: string;
};

function buildResolverCommand(
  provider: ExternalConflictResolverProvider,
  opts: {
    promptFilePath: string;
    claudePermission: ClaudePermissionMode;
    codexApproval: CodexApprovalMode;
  }
): string {
  const q = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  const promptArg = `"$(cat ${q(opts.promptFilePath)})"`;

  if (provider === "claude") {
    const parts: string[] = ["claude"];
    if (opts.claudePermission === "bypass") {
      parts.push("--dangerously-skip-permissions");
    } else if (opts.claudePermission === "acceptEdits") {
      parts.push("--permission-mode", "acceptEdits");
    }
    parts.push(promptArg);
    return parts.join(" ");
  }

  // Codex
  const parts: string[] = ["codex"];
  if (opts.codexApproval === "fullAuto") {
    parts.push("--full-auto");
  } else if (opts.codexApproval === "autoEdit") {
    parts.push("--ask-for-approval", "on-failure", "--sandbox", "workspace-write");
  } else if (opts.codexApproval === "suggest") {
    parts.push("--ask-for-approval", "untrusted", "--sandbox", "workspace-write");
  }
  parts.push(promptArg);
  return parts.join(" ");
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
  scenario: ResolverSessionScenario;
}): Promise<{ result: PrepareResolverSessionResult | null; error: string | null }> {
  try {
    const result = await window.ade.conflicts.prepareResolverSession(args);
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
  const [provider, setProvider] = React.useState<ExternalConflictResolverProvider>("claude");
  const [claudePermission, setClaudePermission] = React.useState<ClaudePermissionMode>("bypass");
  const [codexApproval, setCodexApproval] = React.useState<CodexApprovalMode>("fullAuto");
  const [postResolution, setPostResolution] = React.useState<PostResolutionBehavior>(() => ({
    autoCommit: postResolutionDefaults?.autoCommit === true,
    autoPush: postResolutionDefaults?.autoPush === true,
    commitMessage: (postResolutionDefaults?.commitMessage ?? "Resolve conflicts via AI").trim() || "Resolve conflicts via AI",
  }));

  // Running state
  const [prepResult, setPrepResult] = React.useState<PrepareResolverSessionResult | null>(null);
  const [ptyId, setPtyId] = React.useState<string | null>(null);
  const [sessionId, setSessionId] = React.useState<string | null>(null);

  // Done state
  const [doneStatus, setDoneStatus] = React.useState<DoneStatus | null>(null);
  const [exitCode, setExitCode] = React.useState<number | null>(null);
  const [modifiedFiles, setModifiedFiles] = React.useState<string[]>([]);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [postActionBusy, setPostActionBusy] = React.useState(false);
  const [postActionInfo, setPostActionInfo] = React.useState<string | null>(null);
  const [postActionError, setPostActionError] = React.useState<string | null>(null);

  const ptyIdRef = React.useRef<string | null>(null);

  const runPostResolutionActions = React.useCallback(
    async (laneId: string): Promise<{ autoCommitted: boolean; autoPushed: boolean; error: string | null }> => {
      if (!postResolution.autoCommit) {
        return { autoCommitted: false, autoPushed: false, error: null };
      }

      setPostActionBusy(true);
      setPostActionInfo(null);
      setPostActionError(null);
      try {
        const message = postResolution.commitMessage.trim() || "Resolve conflicts via AI";
        await window.ade.git.commit({ laneId, message });
        let info = "Committed resolved changes.";
        if (postResolution.autoPush) {
          await window.ade.git.push({ laneId });
          info = "Committed and pushed resolved changes.";
        }
        setPostActionInfo(info);
        return { autoCommitted: true, autoPushed: postResolution.autoPush, error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setPostActionError(message);
        return { autoCommitted: false, autoPushed: false, error: message };
      } finally {
        setPostActionBusy(false);
      }
    },
    [postResolution.autoCommit, postResolution.autoPush, postResolution.commitMessage]
  );

  // Reset state when modal closes
  React.useEffect(() => {
    if (open) return;
    const id = setTimeout(() => {
      setPhase("configure");
      setPrepResult(null);
      setPtyId(null);
      setSessionId(null);
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
    }, 200);
    return () => clearTimeout(id);
  }, [open, postResolutionDefaults]);

  // Listen for PTY exit
  React.useEffect(() => {
    if (!ptyId) return;
    const unsub = window.ade.pty.onExit((ev) => {
      if (ev.ptyId !== ptyId) return;
      const code = ev.exitCode ?? -1;
      setExitCode(code);

      if (prepResult) {
        finalizeResolverSessionDirect({ runId: prepResult.runId, exitCode: code }).then(async ({ summary, error }) => {
          const status: DoneStatus = code === 0 ? "completed" : "failed";
          setDoneStatus(status);

          if (summary?.summary) {
            setModifiedFiles(summary.summary.split("\n").map((line) => line.trim()).filter(Boolean));
          }
          if (error) {
            setErrorMsg(error);
          }

          const laneIdForPost = prepResult.cwdLaneId ?? null;
          let autoCommitted = false;
          let autoPushed = false;
          let postError: string | null = null;
          if (status === "completed" && laneIdForPost) {
            const post = await runPostResolutionActions(laneIdForPost);
            autoCommitted = post.autoCommitted;
            autoPushed = post.autoPushed;
            postError = post.error;
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
  }, [ptyId, prepResult, onCompleted, runPostResolutionActions]);

  // Run handler
  const handleRun = async () => {
    if (!targetLaneId) return;

    setPhase("preparing");
    setErrorMsg(null);
    setPostActionInfo(null);
    setPostActionError(null);

    const sources = sourceLaneIds ?? (sourceLaneId ? [sourceLaneId] : []);
    const scenarioToUse = scenario ?? (sources.length > 1 ? "sequential-merge" : "single-merge");
    const { result, error } = await prepareResolverSessionDirect({
      provider,
      targetLaneId,
      sourceLaneIds: sources,
      scenario: scenarioToUse,
    });

    if (!result) {
      if (error) setErrorMsg(error);
      setPhase("configure");
      return;
    }

    setPrepResult(result);

    try {
      const effectiveCwd = cwdLaneId ?? result.cwdLaneId;
      const pty = await window.ade.pty.create({
        laneId: effectiveCwd,
        cwd: result.cwdWorktreePath,
        cols: 100,
        rows: 30,
        title: `Resolve Conflicts (${provider})`,
        tracked: false,
        toolType: provider,
      });
      setPtyId(pty.ptyId);
      setSessionId(pty.sessionId);
      ptyIdRef.current = pty.ptyId;
      setPhase("running");

      const cmd = buildResolverCommand(provider, {
        promptFilePath: result.promptFilePath,
        claudePermission,
        codexApproval,
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
    await disposePty();
    setDoneStatus("cancelled");
    setPhase("done");
    onCompleted?.({ status: "cancelled", laneId: prepResult?.cwdLaneId ?? null, autoCommitted: false, autoPushed: false, error: null });
  };

  // Close handler with warning
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      if (phase === "running") {
        const shouldClose = window.confirm(
          "Resolution is still running. Closing will kill the process. Continue?"
        );
        if (!shouldClose) return;
        void disposePty().then(() => onOpenChange(false));
        return;
      }
      void disposePty();
    }
    onOpenChange(next);
  };

  const canRun = !!targetLaneId && (!!sourceLaneId || (sourceLaneIds && sourceLaneIds.length > 0));

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
            {phase === "preparing" && "Preparing session — gathering pack context..."}
            {phase === "running" && "Running — watch the terminal output below."}
            {phase === "done" && "Resolution finished."}
          </Dialog.Description>

          {/* Configure phase */}
          {phase === "configure" && (
            <div className="mt-4 space-y-4">
              <ProviderSelector
                provider={provider}
                onProviderChange={setProvider}
                claudePermissionMode={claudePermission}
                onClaudePermissionModeChange={(m) => setClaudePermission(m as ClaudePermissionMode)}
                codexApprovalMode={codexApproval}
                onCodexApprovalModeChange={(m) => setCodexApproval(m as CodexApprovalMode)}
              />

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
              <span className="text-sm text-muted-fg">Gathering pack context and writing prompt...</span>
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
                onRoutToLane={
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
