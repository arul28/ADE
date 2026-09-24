import React, { useMemo, useState } from "react";
import {
  ArrowSquareOut,
  CaretRight,
  CheckCircle,
  CircleDashed,
  GitMerge,
  GitPullRequest,
  Warning,
  XCircle,
} from "@phosphor-icons/react";
import type { PrPipelineState } from "../../../../shared/types";
import { relativeWhen } from "../../../lib/format";
import { StateIcon, fmtMs } from "../../prs/detail/prChecksVisuals";
import { cn } from "../../ui/cn";
import { COLORS, MONO_FONT } from "../laneDesignTokens";
import type { LaneHistoryPr } from "./laneHistoryModel";
import {
  isLivePr,
  prMergeFact,
  prReviewFact,
  summarizePrChecks,
  type PrCheckRow,
  type PrFact,
  type PrFactTone,
} from "./laneOverviewModel";
import type { LanePrDetail } from "./useLaneOverviewData";
import { MERGED_COLOR, OVERVIEW_ROW, OVERVIEW_ROW_HOVER, OVERVIEW_TIME, OverviewSection, SmallButton } from "./sectionUi";

function stateLook(state: LaneHistoryPr["state"]): { label: string; color: string } {
  if (state === "open") return { label: "Open", color: COLORS.success };
  if (state === "draft") return { label: "Draft", color: COLORS.textMuted };
  if (state === "merged") return { label: "Merged", color: MERGED_COLOR };
  return { label: "Closed", color: COLORS.danger };
}

/** The PR's state as the PR detail view shows it: a small tinted tag with GitHub's glyph. */
function StatePill({ state }: { state: LaneHistoryPr["state"] }) {
  const look = stateLook(state);
  const Glyph = state === "merged" ? GitMerge : GitPullRequest;
  return (
    <span
      className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full pl-1.5 pr-2 text-[11.5px] font-medium leading-none"
      style={{
        color: look.color,
        background: `color-mix(in srgb, ${look.color} 13%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${look.color} 26%, transparent)`,
      }}
      data-testid="lane-pr-state"
    >
      <Glyph size={12} weight="bold" aria-hidden />
      {look.label}
    </span>
  );
}

function DiffStat({ additions, deletions }: { additions: number | null | undefined; deletions: number | null | undefined }) {
  if (additions == null || deletions == null || (additions === 0 && deletions === 0)) return null;
  return (
    <span className="shrink-0 text-[11.5px] tabular-nums" style={{ fontFamily: MONO_FONT }}>
      <span style={{ color: COLORS.success }}>+{additions}</span>
      <span className="ml-1.5" style={{ color: COLORS.danger }}>−{deletions}</span>
    </span>
  );
}

const FACT_COLOR: Record<PrFactTone, string> = {
  success: COLORS.checkPass,
  danger: COLORS.danger,
  warning: COLORS.warning,
  muted: COLORS.textMuted,
};

function FactIcon({ tone, merge = false }: { tone: PrFactTone; merge?: boolean }) {
  const style = { color: FACT_COLOR[tone], flexShrink: 0 } as const;
  // "Ready to merge" reads better as the merge glyph than as one more tick.
  if (merge && tone === "success") return <GitMerge size={14} weight="bold" style={{ ...style, color: COLORS.success }} aria-hidden />;
  if (tone === "success") return <CheckCircle size={13} weight="fill" style={style} aria-hidden />;
  if (tone === "danger") return <XCircle size={13} weight="fill" style={style} aria-hidden />;
  if (tone === "warning") return <Warning size={13} weight="fill" style={style} aria-hidden />;
  return <CircleDashed size={13} weight="bold" style={style} aria-hidden />;
}

/** A line under the PR title: an icon and a short sentence. */
function FactRow({ icon, children, testId }: { icon: React.ReactNode; children: React.ReactNode; testId?: string }) {
  return (
    <div className={cn(OVERVIEW_ROW, "h-8 text-[12.5px]")} data-testid={testId}>
      <span className="flex w-4 shrink-0 justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-fg/85">{children}</span>
    </div>
  );
}

function stateWord(state: PrPipelineState): string {
  if (state === "failed") return "Failed";
  if (state === "running") return "Running";
  if (state === "queued") return "Queued";
  if (state === "skipped") return "Skipped";
  if (state === "passed") return "Passed";
  return "Unknown";
}

function CheckRow({ check }: { check: PrCheckRow }) {
  const duration = check.state === "passed" || check.state === "failed" ? fmtMs(check.durationMs) : null;
  const content = (
    <>
      <span className="flex w-4 shrink-0 justify-center"><StateIcon state={check.state} size={13} /></span>
      <span className="min-w-0 flex-1 truncate text-fg/85">{check.name}</span>
      {check.url ? <ArrowSquareOut size={11} className="shrink-0 text-muted-fg/60 opacity-0 transition-opacity group-hover:opacity-100" /> : null}
      <span
        className="w-14 shrink-0 text-right text-[11.5px] tabular-nums"
        style={{ color: check.state === "failed" ? COLORS.danger : check.state === "running" || check.state === "queued" ? COLORS.warning : COLORS.textMuted }}
      >
        {duration ?? stateWord(check.state)}
      </span>
    </>
  );
  if (!check.url) {
    return <div className={cn(OVERVIEW_ROW, "h-8 text-[12.5px]")} data-testid="lane-pr-check">{content}</div>;
  }
  const url = check.url;
  return (
    <button
      type="button"
      className={cn(OVERVIEW_ROW, OVERVIEW_ROW_HOVER, "group h-8 text-[12.5px]")}
      title={`Open ${check.name} on GitHub`}
      onClick={() => { void window.ade?.app?.openExternal?.(url)?.catch?.(() => {}); }}
      data-testid="lane-pr-check"
    >
      {content}
    </button>
  );
}

/** Failing and running checks get a row each; passing ones fold into one line. */
function ChecksBlock({ pr, detail }: { pr: LaneHistoryPr; detail: LanePrDetail | null }) {
  const [showPassed, setShowPassed] = useState(false);
  const summary = useMemo(() => summarizePrChecks(detail?.checks ?? []), [detail?.checks]);

  if (summary.total === 0) {
    // No check list yet: fall back to the PR list's rollup.
    if (pr.checksStatus === "failing") return <FactRow icon={<FactIcon tone="danger" />}>Checks failing</FactRow>;
    if (pr.checksStatus === "pending") return <FactRow icon={<StateIcon state="running" size={13} />}>Checks running</FactRow>;
    if (pr.checksStatus === "passing") return <FactRow icon={<FactIcon tone="success" />}>Checks passed</FactRow>;
    if (detail) return <FactRow icon={<FactIcon tone="muted" />}>No checks</FactRow>;
    return null;
  }

  const quietLabel = summary.attention.length === 0
    ? `${summary.passed === summary.total ? "All " : ""}${summary.total} check${summary.total === 1 ? "" : "s"} passed`
    : `${summary.quiet.length} other check${summary.quiet.length === 1 ? "" : "s"} passed`;

  return (
    <div className="flex min-w-0 flex-col" data-testid="lane-pr-checks">
      {summary.attention.map((check) => <CheckRow key={`${check.name}:${check.state}`} check={check} />)}
      {summary.quiet.length > 0 ? (
        <>
          <button
            type="button"
            className={cn(OVERVIEW_ROW, OVERVIEW_ROW_HOVER, "h-8 text-[12.5px]")}
            onClick={() => setShowPassed((value) => !value)}
            aria-expanded={showPassed}
            data-testid="lane-pr-checks-passed"
          >
            <span className="flex w-4 shrink-0 justify-center"><FactIcon tone="success" /></span>
            <span className="min-w-0 flex-1 truncate text-fg/85">{quietLabel}</span>
            <CaretRight size={11} className={cn("shrink-0 text-muted-fg/60 transition-transform duration-150", showPassed && "rotate-90")} />
          </button>
          {showPassed ? (
            <div className="flex min-w-0 flex-col pl-6">
              {summary.quiet.map((check) => <CheckRow key={`${check.name}:${check.state}`} check={check} />)}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function CompactPrRow({ pr, onOpen }: { pr: LaneHistoryPr; onOpen: (pr: LaneHistoryPr) => void }) {
  const look = stateLook(pr.state);
  const when = pr.state === "merged" ? pr.mergedAt ?? pr.updatedAt : pr.updatedAt;
  return (
    <button
      type="button"
      className={cn(OVERVIEW_ROW, OVERVIEW_ROW_HOVER, "h-8 text-[12.5px]")}
      title={pr.title}
      onClick={() => onOpen(pr)}
      data-testid="lane-pr-earlier-row"
    >
      <span className="flex w-4 shrink-0 justify-center">
        {pr.state === "merged"
          ? <GitMerge size={13} weight="bold" style={{ color: look.color }} />
          : <GitPullRequest size={13} weight="bold" style={{ color: look.color }} />}
      </span>
      <span className="shrink-0 tabular-nums text-muted-fg" style={{ fontFamily: MONO_FONT, fontSize: 11.5 }}>#{pr.number}</span>
      <span className="min-w-0 flex-1 truncate text-fg/85">{pr.title}</span>
      <span className="shrink-0 text-[11.5px]" style={{ color: look.color }}>{look.label}</span>
      <span className={OVERVIEW_TIME}>{when ? relativeWhen(when) : ""}</span>
    </button>
  );
}

function factNode(fact: PrFact | null, testId: string, merge = false): React.ReactNode {
  if (!fact) return null;
  return <FactRow icon={<FactIcon tone={fact.tone} merge={merge} />} testId={testId}>{fact.text}</FactRow>;
}

/**
 * The lane's pull request: the open one in full (checks, review, merge state),
 * and earlier ones folded behind one disclosure.
 */
export function LanePrSection({
  current,
  earlier,
  detail,
  baseLabel,
  onOpenPr,
}: {
  current: LaneHistoryPr;
  earlier: LaneHistoryPr[];
  /** Status, checks and reviews of `current` when it is open. */
  detail: LanePrDetail | null;
  baseLabel: string;
  onOpenPr: (pr: LaneHistoryPr) => void;
}) {
  const [showEarlier, setShowEarlier] = useState(false);
  const live = isLivePr(current);
  const isDraft = current.state === "draft";
  const checks = detail?.checks ?? [];
  const checksFailing = checks.length > 0
    ? summarizePrChecks(checks).failed > 0
    : current.checksStatus === "failing";
  const review = live
    ? prReviewFact({ reviews: detail?.reviews ?? [], reviewStatus: detail?.status?.reviewStatus ?? current.reviewStatus, isDraft })
    : null;
  const merge = live
    ? prMergeFact({
      status: detail?.status ?? null,
      mergeConflicts: current.mergeConflicts,
      baseLabel,
      isDraft,
      checksFailing,
      approved: review?.tone === "success",
    })
    : null;
  const when = current.state === "merged" ? current.mergedAt ?? current.updatedAt : current.updatedAt;
  const readyToMerge = merge?.tone === "success";

  return (
    <OverviewSection
      title={live ? "Pull request" : "Pull requests"}
      testId="lane-pr-section"
      collapseKey="pr"
      action={readyToMerge ? (
        // Merging happens in the PRs tab, so the one action says so.
        <SmallButton onClick={() => onOpenPr(current)} testId="lane-pr-open" tone="success" title="Open this PR in the PRs tab to merge it">
          <GitMerge size={12} weight="bold" aria-hidden />
          Merge in PRs
        </SmallButton>
      ) : (
        <SmallButton onClick={() => onOpenPr(current)} testId="lane-pr-open">
          Open in PRs
        </SmallButton>
      )}
    >
      <button
        type="button"
        className={cn(OVERVIEW_ROW, OVERVIEW_ROW_HOVER, "h-9")}
        onClick={() => onOpenPr(current)}
        title={current.title}
        data-testid="lane-pr-current"
      >
        <StatePill state={current.state} />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="min-w-0 truncate text-[13px] font-medium text-fg">{current.title}</span>
          <span className="shrink-0 tabular-nums text-muted-fg/70" style={{ fontFamily: MONO_FONT, fontSize: 12 }}>#{current.number}</span>
        </span>
        <DiffStat additions={current.additions} deletions={current.deletions} />
        <span className={OVERVIEW_TIME}>{when ? relativeWhen(when) : ""}</span>
      </button>
      {live ? (
        <div className="mt-1 flex min-w-0 flex-col">
          <ChecksBlock pr={current} detail={detail} />
          {factNode(review, "lane-pr-review")}
          {factNode(merge, "lane-pr-merge", true)}
        </div>
      ) : null}
      {earlier.length > 0 ? (
        <div className="mt-1 flex min-w-0 flex-col">
          <button
            type="button"
            className={cn(OVERVIEW_ROW, OVERVIEW_ROW_HOVER, "h-8 text-[12.5px] text-muted-fg")}
            onClick={() => setShowEarlier((value) => !value)}
            aria-expanded={showEarlier}
            data-testid="lane-pr-earlier-toggle"
          >
            <span className="flex w-4 shrink-0 justify-center">
              <CaretRight size={11} className={cn("transition-transform duration-150", showEarlier && "rotate-90")} />
            </span>
            {earlier.length} earlier pull request{earlier.length === 1 ? "" : "s"}
          </button>
          {showEarlier ? earlier.map((pr) => <CompactPrRow key={pr.key} pr={pr} onOpen={onOpenPr} />) : null}
        </div>
      ) : null}
    </OverviewSection>
  );
}
