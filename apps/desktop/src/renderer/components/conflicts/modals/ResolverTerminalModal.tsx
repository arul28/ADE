import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "../../ui/Button";
import { TerminalView } from "../../terminals/TerminalView";
import { ProviderSelector } from "../shared/ProviderSelector";
import { PostResolutionActions } from "../shared/PostResolutionActions";
import { useConflictsDispatch, useConflictsState } from "../state/ConflictsContext";
import { prepareResolverSession, finalizeResolverSession } from "../state/conflictsActions";
import type {
  ExternalConflictResolverProvider,
  PrepareResolverSessionResult,
  ResolverSessionScenario,
} from "../../../../shared/types";

type ResolverModalPhase = "configure" | "preparing" | "running" | "done";
type DoneStatus = "completed" | "failed" | "cancelled";

// Claude permission modes
type ClaudePermissionMode = "bypass" | "acceptEdits" | "manual";
// Codex approval modes
type CodexApprovalMode = "fullAuto" | "autoEdit" | "suggest" | "manual";

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

export function ResolverTerminalModal({
  open,
  onOpenChange,
  sourceLaneId,
  targetLaneId,
  sourceLaneIds,
  cwdLaneId,
  scenario,
  onCompleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceLaneId: string | null;
  targetLaneId: string | null;
  sourceLaneIds?: string[];
  cwdLaneId?: string | null;
  scenario?: ResolverSessionScenario;
  onCompleted?: () => void;
}) {
  const dispatch = useConflictsDispatch();
  const { resolverModalPhase: ctxPhase } = useConflictsState();

  // Local state
  const [phase, setPhase] = React.useState<ResolverModalPhase>("configure");
  const [provider, setProvider] = React.useState<ExternalConflictResolverProvider>("claude");
  const [claudePermission, setClaudePermission] = React.useState<ClaudePermissionMode>("bypass");
  const [codexApproval, setCodexApproval] = React.useState<CodexApprovalMode>("fullAuto");

  // Running state
  const [prepResult, setPrepResult] = React.useState<PrepareResolverSessionResult | null>(null);
  const [ptyId, setPtyId] = React.useState<string | null>(null);
  const [sessionId, setSessionId] = React.useState<string | null>(null);

  // Done state
  const [doneStatus, setDoneStatus] = React.useState<DoneStatus | null>(null);
  const [exitCode, setExitCode] = React.useState<number | null>(null);
  const [modifiedFiles, setModifiedFiles] = React.useState<string[]>([]);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  const ptyIdRef = React.useRef<string | null>(null);

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
      ptyIdRef.current = null;
    }, 200);
    return () => clearTimeout(id);
  }, [open]);

  // Listen for PTY exit
  React.useEffect(() => {
    if (!ptyId) return;
    const unsub = window.ade.pty.onExit((ev) => {
      if (ev.ptyId !== ptyId) return;
      const code = ev.exitCode ?? -1;
      setExitCode(code);

      if (prepResult) {
        // Finalize the session
        finalizeResolverSession(dispatch, prepResult.runId, code).then((summary) => {
          if (summary) {
            const status: DoneStatus = code === 0 ? "completed" : "failed";
            setDoneStatus(status);
            if (summary.patchPath) {
              // Parse modified files from summary
              setModifiedFiles(summary.summary?.split("\n").filter(Boolean) ?? []);
            }
          } else {
            setDoneStatus("failed");
          }
          setPhase("done");
          dispatch({ type: "SET_RESOLVER_MODAL_PHASE", phase: "done" });
        });
      } else {
        setDoneStatus(code === 0 ? "completed" : "failed");
        setPhase("done");
      }
    });
    return unsub;
  }, [ptyId, prepResult, dispatch]);

  // Run handler
  const handleRun = async () => {
    if (!targetLaneId) return;

    setPhase("preparing");
    setErrorMsg(null);

    const sources = sourceLaneIds ?? (sourceLaneId ? [sourceLaneId] : []);
    const result = await prepareResolverSession(dispatch, {
      provider,
      targetLaneId,
      sourceLaneIds: sources,
      scenario: scenario ?? (sources.length > 1 ? "sequential-merge" : "single-merge"),
    });

    if (!result) {
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
      dispatch({ type: "SET_RESOLVER_MODAL_PHASE", phase: "running" });

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
          className={`fixed left-1/2 top-[4%] z-50 -translate-x-1/2 rounded-2xl bg-card/95 p-4 shadow-float backdrop-blur-xl focus:outline-none max-h-[92vh] overflow-y-auto ${
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
                        onCompleted?.();
                      }
                    : undefined
                }
                onCommitAndOpenPr={
                  doneStatus === "completed"
                    ? () => {
                        onOpenChange(false);
                        onCompleted?.();
                      }
                    : undefined
                }
              />

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
