/**
 * The launch form.
 *
 * Two compiled sources merge here, because they were always the same form:
 * `ReviewPage.tsx`'s `launchFormContent` + `handleLaunch` (the lane, the target
 * mode, the compare target, the commit range, the scope diagram, the model
 * controls) and `PrRequestAiReviewDialog.tsx` (214) (the same form with the lane
 * and the compare target LOCKED, and `publishBehavior: "auto_publish"`). The
 * compiled pair were two components that built the same `{target, config}` and
 * drifted; the `pr` arm here is a mode of one form.
 *
 * It draws in two places and the difference is one prop:
 *
 * - inside the runs browser's own modal, where `onCancel` draws a Cancel beside
 *   Start — the compiled "Launch review" dialog;
 * - as the `launch` webview surface, an anchored popover the PR toolbar button
 *   and the command palette open, where there is no Cancel because the host's
 *   own popover chrome dismisses it.
 *
 * The lane, model and reasoning fields go through the HOST pickers
 * (`ui.pickLane`, `ui.pickModel`, `ui.pickReasoningEffort`) rather than through
 * re-implemented comboboxes — see `ReviewLaunchModelControls`. A host with none
 * of them falls back to a native select over the launch context's own lanes,
 * which is what the compiled page drew anyway.
 */

import React from "react";
import { CaretDown, Lock, Play } from "@phosphor-icons/react";
import { Button, Chip, cn } from "@ade-dev/ui";

import { startRun as startRunAction } from "../host/actions";
import { hostPickers, pickLane, pickerRectFromClick } from "../host/ui";
import {
  buildTargetConfig,
  describeLaunchCommit,
  formatRelativeTime,
  formatTime,
  getCommitIndex,
  isCommitRangeOrdered,
  isLaunchDraftComplete,
  branchDisplayName,
  laneDisplayName,
  launchValidationMessage,
  orderLaunchCommits,
} from "../lib/reviewFormat";
import type {
  PageReviewLaunchContext,
  PageReviewLaunchLane,
  ReviewLaunchCommit,
  ReviewLaunchDraft,
  ReviewTargetMode,
} from "../types";
import { ReviewLaunchModelControls } from "./ReviewLaunchModelControls";
import {
  REVIEW_INPUT,
  REVIEW_INPUT_FOCUS,
  REVIEW_INSET_SURFACE,
  REVIEW_TOGGLE_ACTIVE,
  ReviewLaunchScopeVisual,
} from "./ReviewShell";

/**
 * The compiled defaults, as literals.
 *
 * `ReviewPage.tsx` and `PrRequestAiReviewDialog.tsx` both read
 * `getDefaultModelDescriptor("codex")` out of the app's model registry, which a
 * guest cannot import. These are the same two values that registry answers, and
 * they are the same two `plugins/ade-review/launch.js` uses — the page and the
 * panel must default a launch identically or a reader gets a different review
 * depending on which client they started it from.
 */
const DEFAULT_MODEL_ID = "openai/gpt-5.6-sol";
const DEFAULT_REASONING_EFFORT = "low";

/**
 * The pull request the host opened this form at.
 *
 * Every field is one the host's own `pr` subject carries (`PluginPrContext`:
 * `id`, `laneId`, `number`, `title`, `branch`) — nothing here is derived and
 * nothing is invented. `branch` is the PR's HEAD ref, which is what the scope
 * diagram draws against the base; both it and `title` are null on a host that
 * sent a thinner subject, and the diagram falls back rather than guessing.
 */
export type ReviewLaunchPrContext = {
  prId: string;
  laneId: string | null;
  number: number | null;
  title: string | null;
  branch: string | null;
};

export type ReviewLaunchFormProps = {
  launchContext: PageReviewLaunchContext | null;
  loading?: boolean;
  /** The lane the surrounding surface is looking at, when there is one. */
  initialLaneId?: string | null;
  /** Non-null when the PR toolbar button opened this. Locks lane and mode. */
  pr?: ReviewLaunchPrContext | null;
  onStarted: (runId: string) => void;
  /** Drawn only when given — the modal has a Cancel, the popover does not. */
  onCancel?: () => void;
  /**
   * Told whenever a launch starts or ends.
   *
   * The form disables its own controls while a launch is in flight, but the
   * chrome AROUND it is not the form's to disable: a dialog can still be closed
   * with Escape, with the backdrop or with its own X, and a reader who did that
   * mid-launch would be left with a run they cannot see and no sign it started.
   * `LaneDialogShell` already gates its close path on a `busy` prop; this is how
   * the shell learns what to put in it.
   */
  onBusyChange?: (busy: boolean) => void;
};

function CommitSelectField({
  label,
  helper,
  value,
  options,
  selectedCommit,
  disabled,
  tooFewCommits,
  onChange,
}: {
  label: string;
  helper: string;
  value: string;
  options: ReviewLaunchCommit[];
  selectedCommit: ReviewLaunchCommit | null;
  disabled: boolean;
  /** Why the field is empty, as opposed to why it is disabled. */
  tooFewCommits: boolean;
  onChange: (sha: string) => void;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">{label}</span>
      <div className="relative">
        <select
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          className={cn(
            "h-10 w-full appearance-none rounded-xl border border-white/[0.08] bg-[var(--color-muted)]/55 px-3 pr-8 text-sm text-[#F5FAFF] outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-60",
            REVIEW_INPUT_FOCUS,
          )}
        >
          <option value="">{tooFewCommits ? "Not enough commits" : `Choose ${label.toLowerCase()}...`}</option>
          {options.map((commit) => (
            <option key={commit.sha} value={commit.sha}>
              {describeLaunchCommit(commit)}
            </option>
          ))}
        </select>
        <CaretDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#8FA1B8]" />
      </div>
      <div className="text-[11px] text-[#94A3B8]">{helper}</div>
      {selectedCommit ? (
        <div className={cn(REVIEW_INSET_SURFACE, "p-3")}>
          <div className="flex flex-wrap items-center gap-2">
            <Chip className="text-[9px]">{selectedCommit.shortSha}</Chip>
            <Chip className="text-[9px]">{formatRelativeTime(selectedCommit.authoredAt)}</Chip>
            <Chip className="text-[9px]">{selectedCommit.pushed ? "Remote" : "Local only"}</Chip>
          </div>
          <div className="mt-2 text-xs font-medium text-[#F5FAFF]">{selectedCommit.subject || "No subject"}</div>
          <div className="mt-1 text-[11px] text-[#94A3B8]">{formatTime(selectedCommit.authoredAt)}</div>
        </div>
      ) : null}
    </label>
  );
}

export function ReviewLaunchForm({
  launchContext,
  loading = false,
  initialLaneId = null,
  pr = null,
  onStarted,
  onCancel,
  onBusyChange,
}: ReviewLaunchFormProps) {
  const pickers = React.useMemo(() => hostPickers(), []);
  const lanes = React.useMemo<PageReviewLaunchLane[]>(
    () => launchContext?.lanes ?? [],
    [launchContext?.lanes],
  );
  const laneById = React.useMemo(
    () => new Map(lanes.map((lane) => [lane.id, lane])),
    [lanes],
  );

  const [launching, setLaunching] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<ReviewLaunchDraft>(() => ({
    laneId: pr?.laneId ?? initialLaneId ?? "",
    targetMode: pr ? "pr" : "lane_diff",
    compareKind: "default_branch",
    compareLaneId: "",
    baseCommit: "",
    headCommit: "",
    prId: pr?.prId ?? "",
    modelId: DEFAULT_MODEL_ID,
    provider: null,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    fastMode: false,
    publishBehavior: pr ? "auto_publish" : "local_only",
  }));

  const recommendedHydratedRef = React.useRef(false);

  /**
   * The lane the form lands on when the reader has not chosen one.
   *
   * The compiled page's own order: the lane the surface is looking at, then the
   * engine's `defaultLaneId`, then the first lane. A PR press outranks all
   * three, because that lane is the PR's checkout and not a preference.
   */
  React.useEffect(() => {
    if (draft.laneId) return;
    const next = pr?.laneId ?? initialLaneId ?? launchContext?.defaultLaneId ?? lanes[0]?.id ?? "";
    if (next) setDraft((prev) => (prev.laneId ? prev : { ...prev, laneId: next }));
  }, [draft.laneId, initialLaneId, lanes, launchContext?.defaultLaneId, pr?.laneId]);

  /**
   * The engine's recommended model, taken ONCE.
   *
   * The compiled page's `recommendedModelHydratedRef`, unchanged: the
   * recommendation is a starting point, so it may replace the built-in default
   * but must never overwrite a model the reader picked — and it must not come
   * back and overwrite it again on the next context read.
   */
  React.useEffect(() => {
    const recommended = launchContext?.recommendedModelId?.trim();
    if (!recommended || recommendedHydratedRef.current) return;
    recommendedHydratedRef.current = true;
    setDraft((prev) => {
      const current = prev.modelId.trim();
      if (current && current !== DEFAULT_MODEL_ID) return prev;
      if (current === recommended) return prev;
      return { ...prev, modelId: recommended };
    });
  }, [launchContext?.recommendedModelId]);

  const selectedLane = laneById.get(draft.laneId) ?? null;
  const selectedCompareLane = draft.compareKind === "lane" ? laneById.get(draft.compareLaneId) ?? null : null;
  const defaultBranchLabel = launchContext?.defaultBranchName?.trim() || "default branch";
  const selectedLaneBranchLabel = branchDisplayName(selectedLane?.branchRef) ?? laneDisplayName(selectedLane);
  const selectedLaneBaseLabel = branchDisplayName(selectedLane?.baseRef) ?? defaultBranchLabel;
  const selectedLaneIsPrimary = selectedLane?.laneType === "primary";
  const selectedLaneDefaultCompareLabel = selectedLaneIsPrimary
    ? `local origin/${selectedLaneBaseLabel}`
    : `local ${selectedLaneBaseLabel}`;
  const defaultCompareOptionLabel = selectedLaneIsPrimary
    ? `Compare with origin/${selectedLaneBaseLabel}`
    : `Compare with ${selectedLaneBaseLabel}`;

  const laneCommits = React.useMemo(
    () => orderLaunchCommits(launchContext?.recentCommitsByLane?.[draft.laneId] ?? []),
    [launchContext?.recentCommitsByLane, draft.laneId],
  );
  const commitOrder = React.useMemo(
    () => new Map(laneCommits.map((commit, index) => [commit.sha, index])),
    [laneCommits],
  );

  /** The compiled commit-range hydration, unchanged. */
  React.useEffect(() => {
    setDraft((prev) => {
      if (prev.targetMode !== "commit_range") return prev;
      const commits = orderLaunchCommits(launchContext?.recentCommitsByLane?.[prev.laneId] ?? []);
      if (commits.length < 2) {
        if (!prev.baseCommit && !prev.headCommit) return prev;
        return { ...prev, baseCommit: "", headCommit: "" };
      }
      const order = new Map(commits.map((commit, index) => [commit.sha, index]));
      let nextHeadCommit = prev.headCommit;
      let nextBaseCommit = prev.baseCommit;
      if (!nextHeadCommit || !order.has(nextHeadCommit)) nextHeadCommit = commits[0]?.sha ?? "";
      if (!nextBaseCommit || !order.has(nextBaseCommit)) nextBaseCommit = commits[1]?.sha ?? "";
      if (!isCommitRangeOrdered(nextBaseCommit, nextHeadCommit, order)) {
        nextHeadCommit = commits[0]?.sha ?? "";
        nextBaseCommit = commits[1]?.sha ?? "";
      }
      if (nextBaseCommit === prev.baseCommit && nextHeadCommit === prev.headCommit) return prev;
      return { ...prev, baseCommit: nextBaseCommit, headCommit: nextHeadCommit };
    });
  }, [launchContext?.recentCommitsByLane, draft.laneId, draft.targetMode]);

  const selectedBaseCommit = laneCommits.find((commit) => commit.sha === draft.baseCommit) ?? null;
  const selectedHeadCommit = laneCommits.find((commit) => commit.sha === draft.headCommit) ?? null;

  const baseCommitOptions = React.useMemo(() => {
    if (laneCommits.length < 2) return [];
    const headIndex = getCommitIndex(commitOrder, draft.headCommit);
    const candidates = headIndex === null
      ? laneCommits.slice(1)
      : laneCommits.filter((_, index) => index > headIndex);
    return [...candidates].reverse();
  }, [commitOrder, draft.headCommit, laneCommits]);

  const headCommitOptions = React.useMemo(() => {
    if (laneCommits.length < 2) return [];
    const baseIndex = getCommitIndex(commitOrder, draft.baseCommit);
    const candidates = baseIndex === null
      ? laneCommits.slice(0, -1)
      : laneCommits.filter((_, index) => index < baseIndex);
    return [...candidates].reverse();
  }, [commitOrder, draft.baseCommit, laneCommits]);

  const validation = launchValidationMessage(draft, commitOrder);
  const ready = isLaunchDraftComplete(draft) && !validation;

  const update = React.useCallback(
    <K extends keyof ReviewLaunchDraft>(key: K, value: ReviewLaunchDraft[K]) => {
      setDraft((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  /** The compiled `handleCommitSelection`, unchanged. */
  const handleCommitSelection = React.useCallback(
    (kind: "base" | "head", sha: string) => {
      setDraft((prev) => {
        if (prev.targetMode !== "commit_range") return prev;
        let nextBaseCommit = kind === "base" ? sha : prev.baseCommit;
        let nextHeadCommit = kind === "head" ? sha : prev.headCommit;
        const selectedIndex = getCommitIndex(commitOrder, sha);
        if (selectedIndex !== null) {
          if (kind === "base") {
            const currentHeadIndex = getCommitIndex(commitOrder, nextHeadCommit);
            if (currentHeadIndex === null || currentHeadIndex >= selectedIndex) {
              nextHeadCommit = laneCommits[selectedIndex - 1]?.sha ?? "";
            }
          } else {
            const currentBaseIndex = getCommitIndex(commitOrder, nextBaseCommit);
            if (currentBaseIndex === null || currentBaseIndex <= selectedIndex) {
              nextBaseCommit = laneCommits[selectedIndex + 1]?.sha ?? "";
            }
          }
        }
        return { ...prev, baseCommit: nextBaseCommit, headCommit: nextHeadCommit };
      });
    },
    [commitOrder, laneCommits],
  );

  /**
   * Stable, because the controls reconcile against it in an effect.
   *
   * `ReviewLaunchModelControls` clears a fast launch when the chosen model has
   * no fast tier, and that runs in an effect whose deps include this callback.
   * An inline arrow would be a new function every render and the effect would
   * re-run on every keystroke in the form.
   */
  const handleFastModeChange = React.useCallback((value: boolean) => {
    setDraft((prev) => (prev.fastMode === value ? prev : { ...prev, fastMode: value }));
  }, []);

  const handlePickLane = React.useCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
    const choice = await pickLane({
      ...(draft.laneId ? { value: draft.laneId } : {}),
      rect: pickerRectFromClick(event),
    });
    if (!choice?.laneId) return;
    setDraft((prev) => ({ ...prev, laneId: choice.laneId, compareLaneId: "" }));
  }, [draft.laneId]);

  const handleLaunch = React.useCallback(async () => {
    const message = launchValidationMessage(draft, commitOrder);
    if (message) {
      setError(message);
      return;
    }
    setLaunching(true);
    setError(null);
    try {
      const result = await startRunAction(buildTargetConfig(draft));
      // `{ok, message}` and never a throw — see `host/actions.ts`. A refusal is
      // a sentence beside the button the reader just pressed.
      if (!result?.ok || !result.runId) {
        setError(result?.message ?? "Review launch did not return a run id.");
        return;
      }
      onStarted(result.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLaunching(false);
    }
  }, [commitOrder, draft, onStarted]);

  const scopeCopy = React.useMemo(() => {
    const laneLabel = laneDisplayName(selectedLane);
    if (draft.targetMode === "pr") {
      return {
        title: pr?.number ? `PR #${pr.number}` : "Pull request review",
        description: `ADE reviews the full PR diff from ${selectedLaneBranchLabel} against ${selectedLaneDefaultCompareLabel}. Strong findings are posted back to this pull request as GitHub review comments from your account.`,
      };
    }
    if (draft.targetMode === "lane_diff") {
      if (draft.compareKind === "lane") {
        return {
          title: selectedCompareLane
            ? `${laneLabel} against ${laneDisplayName(selectedCompareLane)}`
            : `${laneLabel} against another lane`,
          description: selectedCompareLane
            ? `Review how ${laneLabel} differs from ${laneDisplayName(selectedCompareLane)}.`
            : "Choose the comparison lane to finish the lane-to-lane review setup.",
        };
      }
      return {
        title: selectedLaneIsPrimary
          ? `${laneLabel}: local ${selectedLaneBranchLabel} vs ${selectedLaneDefaultCompareLabel}`
          : `${laneLabel}: branch changes vs ${selectedLaneDefaultCompareLabel}`,
        description: selectedLaneIsPrimary
          ? `Reviews local commits on ${selectedLaneBranchLabel} against ${selectedLaneDefaultCompareLabel}. Fetch or pull first when you want latest remote changes included.`
          : `Reviews changes on ${selectedLaneBranchLabel} since it split from ${selectedLaneDefaultCompareLabel}. Pull or merge remote changes into ${selectedLaneBaseLabel} first when you want them included.`,
      };
    }
    if (draft.targetMode === "commit_range") {
      return {
        title: `${laneLabel}: selected commit range`,
        description: selectedBaseCommit && selectedHeadCommit
          ? `Review commits after ${selectedBaseCommit.shortSha} and up to ${selectedHeadCommit.shortSha}. The earlier base commit is excluded; the later head commit is included.`
          : "Review only a slice of this lane's history. Pick the earlier commit first, then the later commit.",
      };
    }
    return {
      title: `${laneLabel}: uncommitted changes`,
      description:
        "Review the staged, unstaged, and untracked changes currently in this lane. This compares the working tree to the checked-out HEAD commit, not to another lane.",
    };
  }, [
    draft.compareKind,
    draft.targetMode,
    pr?.number,
    selectedBaseCommit,
    selectedCompareLane,
    selectedHeadCommit,
    selectedLane,
    selectedLaneBaseLabel,
    selectedLaneBranchLabel,
    selectedLaneDefaultCompareLabel,
    selectedLaneIsPrimary,
  ]);

  const busy = launching || loading;

  // Only the LAUNCH closes the chrome around the form. A slow context read
  // greys the fields but must not trap the reader in a dialog they opened by
  // mistake.
  React.useEffect(() => {
    onBusyChange?.(launching);
  }, [launching, onBusyChange]);

  return (
    <div className="grid gap-3" data-review-pane="launch">
      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-red-400/20 bg-red-500/[0.08] px-3 py-2 text-[12px] text-red-100"
        >
          {error}
        </div>
      ) : null}

      {/* A degraded launch-context read carries its own sentence rather than
          rejecting, so this is where it lands: beside the field it explains. */}
      {launchContext?.message ? (
        <div className="rounded-lg border border-amber-400/25 bg-amber-400/[0.07] px-3 py-2 text-[12px] text-amber-100">
          {launchContext.message}
        </div>
      ) : null}

      <div className="grid gap-1.5">
        <span className="font-mono text-[11px] font-medium tracking-[0.02em] text-[#8FA1B8]">
          Lane to review
        </span>
        {pr ? (
          <div
            className={cn(REVIEW_INSET_SURFACE, "flex items-center gap-2 px-3 py-2 text-sm text-[#F5FAFF]")}
            title="Lane and compare target are fixed for this PR"
          >
            <Lock size={11} weight="bold" className="shrink-0 text-[#8FA1B8]" />
            <span className="truncate">{laneDisplayName(selectedLane)}</span>
          </div>
        ) : pickers.lane ? (
          <button
            type="button"
            onClick={(event) => void handlePickLane(event)}
            disabled={busy}
            aria-label="Lane to review"
            data-review-picker="lane"
            className={cn(REVIEW_INPUT, "flex items-center justify-between text-left", REVIEW_INPUT_FOCUS)}
          >
            <span className="truncate">{selectedLane ? laneDisplayName(selectedLane) : "Choose a lane"}</span>
            <CaretDown size={14} className="shrink-0 text-[#8FA1B8]" />
          </button>
        ) : (
          <div className="relative">
            <select
              aria-label="Lane to review"
              className={cn(REVIEW_INPUT, REVIEW_INPUT_FOCUS)}
              value={draft.laneId}
              onChange={(event) => update("laneId", event.target.value)}
              disabled={busy}
            >
              <option value="">Choose a lane...</option>
              {lanes.map((lane) => (
                <option key={lane.id} value={lane.id}>
                  {lane.name}
                </option>
              ))}
            </select>
            <CaretDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#8FA1B8]" />
          </div>
        )}
      </div>

      {pr ? null : (
        <div className="grid gap-1.5">
          <span className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">Target mode</span>
          <div className={cn("grid grid-cols-3 gap-1 p-1", REVIEW_INSET_SURFACE)}>
            {(
              [
                ["lane_diff", "Lane diff"],
                ["commit_range", "Commit range"],
                ["working_tree", "Uncommitted changes"],
              ] as Array<[ReviewTargetMode, string]>
            ).map(([mode, label]) => {
              const active = draft.targetMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  data-review-target-mode={mode}
                  disabled={busy}
                  className={cn(
                    "rounded-lg px-2 py-2 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                    active ? REVIEW_TOGGLE_ACTIVE : "text-[#94A3B8] hover:text-[#F5FAFF]",
                  )}
                  onClick={() => update("targetMode", mode)}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {draft.targetMode === "lane_diff" ? (
        <div className={cn("grid gap-2 p-3", REVIEW_INSET_SURFACE)}>
          <div className="grid gap-1.5">
            <span className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">Compare against</span>
            <div className={cn("grid grid-cols-2 gap-1 p-1", REVIEW_INSET_SURFACE)}>
              {(["default_branch", "lane"] as const).map((kind) => {
                const active = draft.compareKind === kind;
                return (
                  <button
                    key={kind}
                    type="button"
                    data-review-compare-kind={kind}
                    disabled={busy}
                    className={cn(
                      "rounded-lg px-2 py-2 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      active ? REVIEW_TOGGLE_ACTIVE : "text-[#94A3B8] hover:text-[#F5FAFF]",
                    )}
                    onClick={() => update("compareKind", kind)}
                  >
                    {kind === "default_branch" ? defaultCompareOptionLabel : "Another lane"}
                  </button>
                );
              })}
            </div>
          </div>
          {draft.compareKind === "lane" ? (
            <label className="grid gap-1.5">
              <span className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">Compare lane</span>
              <div className="relative">
                <select
                  aria-label="Compare lane"
                  className={cn(REVIEW_INPUT, REVIEW_INPUT_FOCUS, "disabled:cursor-not-allowed disabled:opacity-60")}
                  value={draft.compareLaneId}
                  onChange={(event) => update("compareLaneId", event.target.value)}
                  disabled={busy}
                >
                  <option value="">Choose lane...</option>
                  {lanes
                    .filter((lane) => lane.id !== draft.laneId)
                    .map((lane) => (
                      <option key={lane.id} value={lane.id}>
                        {lane.name}
                      </option>
                    ))}
                </select>
                <CaretDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#8FA1B8]" />
              </div>
            </label>
          ) : null}
        </div>
      ) : null}

      <ReviewLaunchScopeVisual
        targetMode={draft.targetMode}
        compareKind={draft.compareKind}
        title={scopeCopy.title}
        description={scopeCopy.description}
        laneName={laneDisplayName(selectedLane)}
        compareLaneName={selectedCompareLane ? laneDisplayName(selectedCompareLane) : null}
        baseRefLabel={selectedLaneDefaultCompareLabel}
        branchRefLabel={selectedLaneBranchLabel}
        baseCommitLabel={selectedBaseCommit?.shortSha ?? null}
        headCommitLabel={selectedHeadCommit?.shortSha ?? null}
        prNumber={pr?.number ?? null}
        prTitle={pr?.title ?? null}
        // The PR's own head ref when the host sent one, and the lane's branch
        // otherwise — that lane IS the PR's checkout. The base is the lane's
        // base ref rather than the "local <base>" label the other modes use: a
        // PR is merged into the remote branch, not into the reader's copy.
        prHeadRefLabel={branchDisplayName(pr?.branch) ?? selectedLaneBranchLabel}
        prBaseRefLabel={selectedLaneBaseLabel}
      />

      {draft.targetMode === "commit_range" ? (
        <div className="grid gap-2 rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3">
          <div className="text-[11px] text-[#C5D2E6]">
            Review only part of this lane&apos;s history. Commit lists are ordered from earlier to later so you can pick
            the start and end of the range without typing raw SHAs.
          </div>
          <div className="grid grid-cols-2 gap-2">
            <CommitSelectField
              label="Earlier commit (base)"
              helper="Start just after this commit. ADE excludes the base commit itself."
              value={draft.baseCommit}
              options={baseCommitOptions}
              selectedCommit={selectedBaseCommit}
              disabled={busy || laneCommits.length < 2}
              // "Not enough commits" is the empty-option's sentence and it is a
              // lie while a launch is in flight, so the two reasons are kept
              // apart rather than folded into `disabled`.
              tooFewCommits={laneCommits.length < 2}
              onChange={(sha) => handleCommitSelection("base", sha)}
            />
            <CommitSelectField
              label="Later commit (head)"
              helper="Stop at this commit. ADE includes the head commit."
              value={draft.headCommit}
              options={headCommitOptions}
              selectedCommit={selectedHeadCommit}
              disabled={busy || laneCommits.length < 2}
              tooFewCommits={laneCommits.length < 2}
              onChange={(sha) => handleCommitSelection("head", sha)}
            />
          </div>
          {draft.laneId && laneCommits.length < 2 ? (
            <div className="text-[11px] text-[#94A3B8]">
              At least two recent commits are needed to review a commit range. Choose a lane with more history.
            </div>
          ) : null}
          {laneCommits.length >= 2 && validation ? (
            <div className="text-[11px] text-amber-200">{validation}</div>
          ) : null}
        </div>
      ) : null}

      {draft.targetMode === "working_tree" ? (
        <div className="grid gap-2 rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3">
          <div className="text-[11px] text-[#C5D2E6]">
            Review the current staged, unstaged, and untracked changes in the selected lane. This mode compares the
            working tree against the lane&apos;s current HEAD commit. It does not compare against another lane.
          </div>
        </div>
      ) : null}

      {draft.targetMode === "pr" ? (
        <div className="rounded-xl border border-sky-400/15 bg-sky-500/[0.06] px-3 py-2.5 text-[12px] leading-relaxed text-[#C5D2E6]">
          The review runs in the background. Full run details appear in Review. Inline comments and a summary review are
          posted on this PR when findings clear the publication threshold.
        </div>
      ) : null}

      <div className="grid gap-1.5">
        <span className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">Model and reasoning</span>
        <ReviewLaunchModelControls
          modelId={draft.modelId}
          reasoningEffort={draft.reasoningEffort}
          fastMode={draft.fastMode}
          onModelChange={(modelId, extras) =>
            setDraft((prev) => ({
              ...prev,
              modelId,
              provider: extras?.provider ?? prev.provider,
              ...(typeof extras?.fastMode === "boolean" ? { fastMode: extras.fastMode } : {}),
            }))}
          onReasoningEffortChange={(value) => update("reasoningEffort", value)}
          onFastModeChange={handleFastModeChange}
          disabled={busy}
        />
        <p className="text-[13px] text-[#C5D2E6]">
          This is read only and the model can only read and inspect files.
        </p>
      </div>

      <div className="mt-1 flex justify-end gap-2 border-t border-white/[0.06] pt-4">
        {onCancel ? (
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="primary"
          onClick={() => void handleLaunch()}
          disabled={busy || !ready}
          data-review-action="start-run"
        >
          <Play size={12} weight="bold" />
          {launching ? "Launching" : "Start review"}
        </Button>
      </div>
    </div>
  );
}
