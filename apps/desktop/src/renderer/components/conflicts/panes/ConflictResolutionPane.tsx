import React from "react";
import { Sparkles, Wrench, Wand2 } from "lucide-react";
import { useAppStore } from "../../../state/appStore";
import { useConflictsState, useConflictsDispatch } from "../state/ConflictsContext";
import {
  fetchResolverTargetSuggestion,
  continueGitOperation,
  prepareAndSendProposal,
  fetchProposals,
} from "../state/conflictsActions";
import { GitCommandPreview } from "../shared/GitCommandPreview";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { ResolverTerminalModal } from "../modals/ResolverTerminalModal";
import { AbortDialog } from "../modals/AbortDialog";

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

export function ConflictResolutionPane() {
  const lanes = useAppStore((s) => s.lanes);
  const dispatch = useConflictsDispatch();
  const {
    selectedLaneId,
    gitConflict,
    continueBusy,
    continueError,
    resolverModalOpen,
    resolverWorktreeChoice,
    resolverTargetSuggestion,
    resolverTargetSuggestionLoading,
    resolverCwdLaneId,
    proposalPeerLaneId,
    proposals,
    proposalBusy,
    proposalError,
  } = useConflictsState();

  const selectedLane = React.useMemo(() => lanes.find((l) => l.id === selectedLaneId) ?? null, [lanes, selectedLaneId]);
  const primaryLane = React.useMemo(() => lanes.find((l) => l.laneType === "primary") ?? null, [lanes]);
  const targetLaneId = proposalPeerLaneId ?? selectedLane?.parentLaneId ?? primaryLane?.id ?? null;
  const targetLane = React.useMemo(() => lanes.find((l) => l.id === targetLaneId) ?? null, [lanes, targetLaneId]);

  // Fetch ADE AI suggestion when source/target pair changes
  React.useEffect(() => {
    if (!selectedLaneId || !targetLaneId || selectedLaneId === targetLaneId) return;
    fetchResolverTargetSuggestion(dispatch, selectedLaneId, targetLaneId);
  }, [selectedLaneId, targetLaneId, dispatch]);

  // Fetch proposals for selected lane
  React.useEffect(() => {
    if (!selectedLaneId) return;
    fetchProposals(dispatch, selectedLaneId);
  }, [selectedLaneId, dispatch]);

  // Compute the effective CWD lane based on worktree choice
  const effectiveCwdLaneId = resolverWorktreeChoice === "source" ? selectedLaneId : targetLaneId;

  // Build manual git commands
  const manualCommands = React.useMemo(() => {
    if (!selectedLane || !targetLane) return [];
    const cwdLane = resolverWorktreeChoice === "source" ? selectedLane : targetLane;
    const otherBranch = resolverWorktreeChoice === "source" ? targetLane.branchRef : selectedLane.branchRef;
    return [
      `cd ${cwdLane.worktreePath ?? `<${cwdLane.name}-worktree>`}`,
      `git merge origin/${otherBranch} --no-commit`,
      "# resolve conflicts...",
      "git add . && git commit",
    ];
  }, [selectedLane, targetLane, resolverWorktreeChoice]);

  if (!selectedLane) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-fg">
        Select a lane to see resolution options
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-3 space-y-4">
      <div className="text-xs font-semibold text-fg uppercase tracking-wide">Resolution</div>

      {/* 1. Worktree Selection + ADE AI Suggestion */}
      <div className="rounded-xl shadow-card bg-card/30 p-3 space-y-3">
        <div className="text-xs font-medium text-fg">Worktree to resolve in</div>
        <div className="flex gap-2">
          {(["target", "source"] as const).map((choice) => {
            const lane = choice === "target" ? targetLane : selectedLane;
            return (
              <button
                key={choice}
                onClick={() => dispatch({ type: "SET_RESOLVER_WORKTREE_CHOICE", choice })}
                className={cn(
                  "flex-1 rounded-lg border px-3 py-2 text-left text-xs transition-colors",
                  resolverWorktreeChoice === choice
                    ? "border-accent bg-accent/10 ring-1 ring-accent/30"
                    : "border-border bg-card/50 hover:bg-card/70"
                )}
              >
                <div className="font-medium text-fg">Work in {choice === "target" ? "target" : "source"}</div>
                <div className="mt-0.5 truncate text-[10px] text-muted-fg">{lane?.name ?? "—"}</div>
              </button>
            );
          })}
        </div>

        {/* ADE AI suggestion */}
        {resolverTargetSuggestionLoading && (
          <div className="flex items-center gap-2 text-[11px] text-muted-fg">
            <Spinner className="h-3 w-3" />
            ADE AI is analyzing...
          </div>
        )}
        {resolverTargetSuggestion && !resolverTargetSuggestionLoading && (
          <div className="rounded-lg bg-accent/5 border border-accent/20 px-3 py-2 text-[11px]">
            <div className="flex items-center gap-1.5 font-medium text-accent">
              <Wand2 className="h-3 w-3" />
              ADE AI suggests: Work in {resolverTargetSuggestion.suggestion}
            </div>
            <div className="mt-1 text-muted-fg">{resolverTargetSuggestion.reason}</div>
          </div>
        )}
      </div>

      {/* 2. Active git conflict — continue/abort */}
      {gitConflict?.inProgress && gitConflict.kind && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-3 space-y-2">
          <div className="text-xs font-semibold text-red-600">
            Active {gitConflict.kind} — {gitConflict.conflictedFiles.length} conflicted files
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={continueBusy}
              onClick={() => void continueGitOperation(dispatch, selectedLaneId!, gitConflict.kind!)}
            >
              {continueBusy ? "Continuing..." : `Continue ${gitConflict.kind}`}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => dispatch({ type: "SET_ABORT_OPEN", open: true })}
            >
              Abort
            </Button>
          </div>
          {continueError && (
            <div className="text-xs text-red-600">{continueError}</div>
          )}
          <AbortDialog laneId={selectedLaneId!} kind={gitConflict.kind!} />
        </div>
      )}

      {/* 3. Manual Resolution */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs font-medium text-fg">
          <Wrench className="h-3.5 w-3.5 text-muted-fg" />
          Manual Resolution
        </div>
        <GitCommandPreview commands={manualCommands} />
      </div>

      {/* 4. AI Resolution */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs font-medium text-fg">
          <Sparkles className="h-3.5 w-3.5 text-accent" />
          AI Resolution
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="primary"
            onClick={() => dispatch({ type: "SET_RESOLVER_MODAL_OPEN", open: true })}
          >
            Resolve with AI
          </Button>
        </div>

        {/* Proposals list */}
        {proposals.length > 0 && (
          <div className="space-y-1">
            <div className="text-[10px] font-medium text-muted-fg uppercase tracking-wide">
              Proposals ({proposals.length})
            </div>
            {proposals.map((p) => (
              <div
                key={p.id}
                className="rounded-lg border border-border bg-card/50 p-2 text-xs"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-fg">{p.status}</span>
                  <span className="text-[10px] text-muted-fg">{new Date(p.createdAt).toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Resolver Terminal Modal */}
      <ResolverTerminalModal
        open={resolverModalOpen}
        onOpenChange={(open) => dispatch({ type: "SET_RESOLVER_MODAL_OPEN", open })}
        sourceLaneId={selectedLaneId}
        targetLaneId={targetLaneId}
        cwdLaneId={effectiveCwdLaneId}
        onCompleted={() => {
          dispatch({ type: "RESET_RESOLVER_STATE" });
        }}
      />
    </div>
  );
}
