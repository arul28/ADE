import React from "react";
import { Sparkle, Wrench, MagicWand } from "@phosphor-icons/react";
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

type ConflictPolicyDraft = {
  changeTarget: "target" | "source" | "ai_decides";
  postResolution: "unstaged" | "staged" | "commit";
  prBehavior: "do_nothing" | "open_pr" | "add_to_existing";
  autonomy: "propose_only" | "auto_apply";
  autoApplyThreshold: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
  const [policyDraft, setPolicyDraft] = React.useState<ConflictPolicyDraft | null>(null);
  const [policySaving, setPolicySaving] = React.useState(false);
  const [policyError, setPolicyError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void window.ade.projectConfig
      .get()
      .then((snapshot) => {
        if (cancelled) return;
        const effectiveAi = isRecord(snapshot.effective.ai) ? snapshot.effective.ai : {};
        const conflict = isRecord(effectiveAi.conflictResolution)
          ? (effectiveAi.conflictResolution as Record<string, unknown>)
          : {};
        setPolicyDraft({
          changeTarget:
            conflict.changeTarget === "target" || conflict.changeTarget === "source" || conflict.changeTarget === "ai_decides"
              ? (conflict.changeTarget as ConflictPolicyDraft["changeTarget"])
              : "ai_decides",
          postResolution:
            conflict.postResolution === "unstaged" || conflict.postResolution === "staged" || conflict.postResolution === "commit"
              ? (conflict.postResolution as ConflictPolicyDraft["postResolution"])
              : "staged",
          prBehavior:
            conflict.prBehavior === "do_nothing" || conflict.prBehavior === "open_pr" || conflict.prBehavior === "add_to_existing"
              ? (conflict.prBehavior as ConflictPolicyDraft["prBehavior"])
              : "do_nothing",
          autonomy:
            conflict.autonomy === "propose_only" || conflict.autonomy === "auto_apply"
              ? (conflict.autonomy as ConflictPolicyDraft["autonomy"])
              : "propose_only",
          autoApplyThreshold:
            typeof conflict.autoApplyThreshold === "number" && Number.isFinite(conflict.autoApplyThreshold)
              ? String(conflict.autoApplyThreshold)
              : "0.85"
        });
      })
      .catch(() => {
        if (cancelled) return;
        setPolicyDraft({
          changeTarget: "ai_decides",
          postResolution: "staged",
          prBehavior: "do_nothing",
          autonomy: "propose_only",
          autoApplyThreshold: "0.85"
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

      {/* 0. Policy controls (persisted to ai.conflict_resolution) */}
      <div className="rounded border border-border bg-card/30 p-3 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-medium text-fg">AI Resolution Policy</div>
          <Button
            size="sm"
            variant="outline"
            disabled={!policyDraft || policySaving}
            onClick={() => {
              if (!policyDraft) return;
              setPolicySaving(true);
              setPolicyError(null);
              void window.ade.projectConfig
                .get()
                .then((snapshot) => {
                  const localAi = isRecord(snapshot.local.ai) ? snapshot.local.ai : {};
                  const threshold = Number(policyDraft.autoApplyThreshold);
                  const nextAi = {
                    ...localAi,
                    conflictResolution: {
                      changeTarget: policyDraft.changeTarget,
                      postResolution: policyDraft.postResolution,
                      prBehavior: policyDraft.prBehavior,
                      autonomy: policyDraft.autonomy,
                      ...(Number.isFinite(threshold) ? { autoApplyThreshold: Math.max(0, Math.min(1, threshold)) } : {})
                    }
                  };
                  return window.ade.projectConfig.save({
                    shared: snapshot.shared,
                    local: {
                      ...snapshot.local,
                      ai: nextAi
                    }
                  });
                })
                .catch((err) => {
                  setPolicyError(err instanceof Error ? err.message : String(err));
                })
                .finally(() => setPolicySaving(false));
            }}
          >
            {policySaving ? "Saving..." : "Save Policy"}
          </Button>
        </div>

        {policyDraft ? (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <div>
              <div className="mb-1 text-xs text-muted-fg">Where to apply changes</div>
              <select
                className="h-8 w-full rounded border border-border bg-card/70 px-2 text-xs"
                value={policyDraft.changeTarget}
                onChange={(e) =>
                  setPolicyDraft((prev) =>
                    prev ? { ...prev, changeTarget: e.target.value as ConflictPolicyDraft["changeTarget"] } : prev
                  )
                }
              >
                <option value="target">Target branch</option>
                <option value="source">Source branch</option>
                <option value="ai_decides">AI decides</option>
              </select>
            </div>

            <div>
              <div className="mb-1 text-xs text-muted-fg">Post-resolution action</div>
              <select
                className="h-8 w-full rounded border border-border bg-card/70 px-2 text-xs"
                value={policyDraft.postResolution}
                onChange={(e) =>
                  setPolicyDraft((prev) =>
                    prev ? { ...prev, postResolution: e.target.value as ConflictPolicyDraft["postResolution"] } : prev
                  )
                }
              >
                <option value="unstaged">Apply unstaged</option>
                <option value="staged">Stage changes</option>
                <option value="commit">Commit changes</option>
              </select>
            </div>

            <div>
              <div className="mb-1 text-xs text-muted-fg">PR behavior</div>
              <select
                className="h-8 w-full rounded border border-border bg-card/70 px-2 text-xs"
                value={policyDraft.prBehavior}
                onChange={(e) =>
                  setPolicyDraft((prev) =>
                    prev ? { ...prev, prBehavior: e.target.value as ConflictPolicyDraft["prBehavior"] } : prev
                  )
                }
              >
                <option value="do_nothing">Do nothing</option>
                <option value="open_pr">Open PR if missing</option>
                <option value="add_to_existing">Add to existing PR</option>
              </select>
            </div>

            <div>
              <div className="mb-1 text-xs text-muted-fg">AI autonomy</div>
              <select
                className="h-8 w-full rounded border border-border bg-card/70 px-2 text-xs"
                value={policyDraft.autonomy}
                onChange={(e) =>
                  setPolicyDraft((prev) =>
                    prev ? { ...prev, autonomy: e.target.value as ConflictPolicyDraft["autonomy"] } : prev
                  )
                }
              >
                <option value="propose_only">Propose only</option>
                <option value="auto_apply">Auto-apply above threshold</option>
              </select>
            </div>

            {policyDraft.autonomy === "auto_apply" ? (
              <div className="md:col-span-2">
                <div className="mb-1 text-xs text-muted-fg">Confidence threshold (0-1)</div>
                <input
                  className="h-8 w-full rounded border border-border bg-card/70 px-2 text-xs"
                  value={policyDraft.autoApplyThreshold}
                  onChange={(e) =>
                    setPolicyDraft((prev) => (prev ? { ...prev, autoApplyThreshold: e.target.value } : prev))
                  }
                />
              </div>
            ) : null}
          </div>
        ) : null}

        {policyError ? <div className="text-xs text-red-500">{policyError}</div> : null}
      </div>

      {/* 1. Worktree Selection + ADE AI Suggestion */}
      <div className="rounded shadow-card bg-card/30 p-3 space-y-3">
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
                <div className="mt-0.5 truncate text-[11px] text-muted-fg">{lane?.name ?? "—"}</div>
              </button>
            );
          })}
        </div>

        {/* ADE AI suggestion */}
        {resolverTargetSuggestionLoading && (
          <div className="flex items-center gap-2 text-xs text-muted-fg">
            <Spinner className="h-3 w-3" />
            ADE AI is analyzing...
          </div>
        )}
        {resolverTargetSuggestion && !resolverTargetSuggestionLoading && (
          <div className="rounded-lg bg-accent/5 border border-accent/20 px-3 py-2 text-xs">
            <div className="flex items-center gap-1.5 font-medium text-accent">
              <MagicWand size={12} />
              ADE AI suggests: Work in {resolverTargetSuggestion.suggestion}
            </div>
            <div className="mt-1 text-muted-fg">{resolverTargetSuggestion.reason}</div>
          </div>
        )}
      </div>

      {/* 2. Active git conflict — continue/abort */}
      {gitConflict?.inProgress && gitConflict.kind && (
        <div className="rounded border border-red-500/30 bg-red-500/5 p-3 space-y-2">
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
          <Wrench size={14} className="text-muted-fg" />
          Manual Resolution
        </div>
        <GitCommandPreview commands={manualCommands} />
      </div>

      {/* 4. AI Resolution */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs font-medium text-fg">
          <Sparkle size={14} className="text-accent" />
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
            <div className="text-[11px] font-medium text-muted-fg uppercase tracking-wide">
              Proposals ({proposals.length})
            </div>
            {proposals.map((p) => (
              <div
                key={p.id}
                className="rounded-lg border border-border bg-card/50 p-2 text-xs"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-fg">{p.status}</span>
                  <span className="text-[11px] text-muted-fg">{new Date(p.createdAt).toLocaleString()}</span>
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
