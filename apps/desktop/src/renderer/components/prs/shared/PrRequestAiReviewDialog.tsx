import { memo, useCallback, useState } from "react";
import { ArrowRight, GitBranch, Lock, Play, Sparkle } from "@phosphor-icons/react";

import { getDefaultModelDescriptor } from "../../../../shared/modelRegistry";
import type { LaneSummary, PrWithConflicts } from "../../../../shared/types";
import { LaneDialogShell } from "../../lanes/LaneDialogShell";
import { ReviewLaunchModelControls } from "../../shared/ReviewLaunchModelControls";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { startReviewRun } from "../../review/reviewApi";
import { branchNameFromRef } from "./laneBranchTargets";

const DEFAULT_MODEL_ID = getDefaultModelDescriptor("codex")?.id ?? "openai/gpt-5.4";
const DEFAULT_REASONING = "medium";

const SCOPE_INSET = "rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/45";

function ScopeNode({
  label,
  caption,
  emphasized = false,
}: {
  label: string;
  caption: string;
  emphasized?: boolean;
}) {
  return (
    <div
      className={cn(
        "min-w-0 flex-1 rounded-lg border px-3 py-2.5",
        emphasized
          ? "border-sky-400/25 bg-sky-500/[0.08] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
          : "border-white/[0.08] bg-[var(--color-bg)]/35",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <GitBranch
          size={12}
          weight="bold"
          className={emphasized ? "shrink-0 text-sky-400" : "shrink-0 text-[#8FA1B8]"}
        />
        <span className="truncate font-mono text-[11px] font-semibold text-[#F5FAFF]">{label}</span>
      </div>
      <div className="mt-0.5 truncate text-[10px] text-[#94A3B8]">{caption}</div>
    </div>
  );
}

function PrReviewScopeVisual({
  pr,
  lane,
  headBranch,
  baseBranch,
}: {
  pr: PrWithConflicts;
  lane: LaneSummary | null;
  headBranch: string;
  baseBranch: string;
}) {
  const laneLabel = lane?.name ?? "Linked lane";

  return (
    <div className={cn(SCOPE_INSET, "overflow-hidden p-0")}>
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-3 py-2.5">
        <div className="min-w-0">
          <div className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">Review scope</div>
          <div className="mt-0.5 truncate text-[13px] font-semibold text-[#F5FAFF]">
            PR #{pr.githubPrNumber}
            {pr.title ? `: ${pr.title}` : ""}
          </div>
        </div>
        <div
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-white/[0.08] bg-[var(--color-bg)]/50 px-2 py-1 text-[10px] text-[#94A3B8]"
          title="Lane and compare target are fixed for this PR"
        >
          <Lock size={11} weight="bold" />
          <span className="max-w-[120px] truncate">{laneLabel}</span>
        </div>
      </div>

      <div className="p-3">
        <div className="flex items-stretch gap-2">
          <ScopeNode label={headBranch} caption={`${laneLabel} · PR head`} emphasized />
          <div className="flex shrink-0 flex-col items-center justify-center gap-1 px-0.5 pt-3">
            <div className="flex items-center gap-0.5">
              <div className="h-px w-3 bg-white/[0.08]" />
              <ArrowRight size={12} weight="bold" className="text-sky-400" />
              <div className="h-px w-3 bg-white/[0.08]" />
            </div>
            <span className="font-mono text-[8px] font-bold tracking-[0.14em] text-sky-400/75">review</span>
          </div>
          <ScopeNode label={`origin/${baseBranch}`} caption="Base branch" />
        </div>

        <div className="mt-3 text-sm font-semibold text-[#F5FAFF]">
          Compare lane changes against {baseBranch}
        </div>
        <div className="mt-1 text-[11px] leading-relaxed text-[#C5D2E6]">
          ADE reviews the full PR diff from this lane&apos;s head branch against <span className="font-mono text-[#E2E8F0]">origin/{baseBranch}</span>.
          Strong findings are posted back to this pull request as GitHub review comments from your account.
        </div>
      </div>
    </div>
  );
}

export type PrRequestAiReviewDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pr: PrWithConflicts;
  lane: LaneSummary | null;
};

export const PrRequestAiReviewDialog = memo(function PrRequestAiReviewDialog({
  open,
  onOpenChange,
  pr,
  lane,
}: PrRequestAiReviewDialogProps) {
  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID);
  const [reasoningEffort, setReasoningEffort] = useState(DEFAULT_REASONING);
  const [codexFastMode, setCodexFastMode] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const baseBranch = pr.baseBranch || "main";
  const headBranch = branchNameFromRef(pr.headBranch) ?? pr.headBranch ?? "head";
  const canLaunch = Boolean(pr.laneId && pr.id && lane);

  const handleLaunch = useCallback(async () => {
    if (!pr.laneId || !lane) {
      setError("This PR is not linked to a lane.");
      return;
    }
    setLaunching(true);
    setError(null);
    try {
      const result = await startReviewRun({
        target: { mode: "pr", laneId: pr.laneId, prId: pr.id },
        config: {
          compareAgainst: { kind: "default_branch" },
          selectionMode: "full_diff",
          dirtyOnly: false,
          modelId: modelId.trim(),
          reasoningEffort: reasoningEffort.trim() || null,
          codexFastMode,
          publishBehavior: "auto_publish",
        },
      });
      if (!result.runId) {
        setError("Review launch did not return a run id.");
        return;
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLaunching(false);
    }
  }, [codexFastMode, lane, modelId, onOpenChange, pr.id, pr.laneId, reasoningEffort]);

  return (
    <LaneDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Request AI review"
      description="Run a read-only review on this PR's lane and post findings to GitHub as review comments."
      icon={Sparkle}
      busy={launching}
      widthClassName="w-[min(760px,calc(100vw-1rem))]"
    >
      <div className="grid gap-4">
        {error ? (
          <div className="rounded-lg border border-red-400/20 bg-red-500/[0.08] px-3 py-2 text-[12px] text-red-100">
            {error}
          </div>
        ) : null}

        <PrReviewScopeVisual pr={pr} lane={lane} headBranch={headBranch} baseBranch={baseBranch} />

        <div className="grid gap-1.5">
          <span className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">Model and reasoning</span>
          <ReviewLaunchModelControls
            modelId={modelId}
            reasoningEffort={reasoningEffort}
            codexFastMode={codexFastMode}
            onModelChange={setModelId}
            onReasoningEffortChange={setReasoningEffort}
            onCodexFastModeChange={setCodexFastMode}
            disabled={launching}
          />
        </div>

        <div className="rounded-xl border border-sky-400/15 bg-sky-500/[0.06] px-3 py-2.5 text-[12px] leading-relaxed text-[#C5D2E6]">
          The review runs in the background. Full run details appear in the Review tab. Inline comments and a summary review are posted on this PR when findings clear the publication threshold.
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-2 border-t border-white/[0.06] pt-4">
        <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)} disabled={launching}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" onClick={() => void handleLaunch()} disabled={launching || !canLaunch}>
          <Play size={12} weight="bold" />
          {launching ? "Launching…" : "Start review"}
        </Button>
      </div>
    </LaneDialogShell>
  );
});

export default PrRequestAiReviewDialog;
