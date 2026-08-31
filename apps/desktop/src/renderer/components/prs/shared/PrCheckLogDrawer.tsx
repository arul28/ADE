import React from "react";
import {
  ArrowSquareOut,
  ArrowsClockwise,
  Copy,
  GithubLogo,
  Sparkle,
} from "@phosphor-icons/react";

import type { PrCheckLogExcerpt, PrWorkflowGraphNode } from "../../../../shared/types";
import { buildCheckDetailPlan, type CheckStepRow } from "../detail/prChecksModel";
import { COLORS, MONO_FONT, RADII, SANS_FONT } from "../../lanes/laneDesignTokens";
import { STATE_COLOR, StateIcon, fmtMs, tint } from "../detail/prChecksVisuals";

/*
 * Status vocabulary comes from `prChecksVisuals` — the one status vocabulary for
 * the CI / Checks surface. This file used to carry its own copy, and the copies
 * had drifted: `passed` was `COLORS.success` here and `COLORS.checkPass` there,
 * so the same green job was two different greens depending on whether you were
 * looking at the graph or the drawer that opens over it.
 */

function SmallButton({
  onClick,
  children,
  tone = "neutral",
  disabled = false,
  testId,
  title,
}: {
  onClick?: () => void;
  children: React.ReactNode;
  tone?: "neutral" | "warn";
  disabled?: boolean;
  testId?: string;
  title?: string;
}) {
  const color = tone === "warn" ? COLORS.warning : COLORS.textSecondary;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid={testId}
      className="inline-flex h-[26px] shrink-0 items-center gap-1.5 px-2.5 text-[11px] font-medium"
      style={{
        borderRadius: RADII.sm,
        fontFamily: SANS_FONT,
        color,
        background: COLORS.cardBg,
        border: `1px solid ${tone === "warn" ? tint(COLORS.warning, 38) : COLORS.outlineBorder}`,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {children}
    </button>
  );
}

/** One step row: number, name, outcome word, own duration. */
const StepRow = React.memo(function StepRow({ step }: { step: CheckStepRow }) {
  const tone = STATE_COLOR[step.state];
  const duration = fmtMs(step.durationMs);
  return (
    <li
      data-testid="pr-checks-step-row"
      data-step-state={step.state}
      className="flex items-baseline gap-2 px-3 py-[3px]"
    >
      <span
        className="w-[18px] shrink-0 text-right text-[10px] tabular-nums"
        style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}
      >
        {step.number}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-[11.5px]"
        style={{ color: COLORS.textSecondary, fontFamily: SANS_FONT }}
        title={step.name}
      >
        {step.name}
      </span>
      <span
        className="shrink-0 text-[10.5px]"
        style={{ color: tone, fontFamily: SANS_FONT }}
      >
        {step.outcomeLabel}
      </span>
      <span
        className="w-[52px] shrink-0 text-right text-[10.5px] tabular-nums"
        style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}
      >
        {duration ?? "—"}
      </span>
    </li>
  );
});

export type PrCheckLogDrawerState = {
  node: PrWorkflowGraphNode;
  jobId: number | null;
};

/**
 * What one CI job did, shown for the state it is actually in.
 *
 * This drawer used to say "Fetching the failing step's output…" and "tail of
 * the failing step" for every job it opened, including green ones — and the
 * service behind it, given no failing step to look for, returned the tail of
 * whatever log section happened to come last. On a passed job that is the
 * `Post Run actions/checkout` cleanup group, so a user who clicked something
 * green was told it failed and shown `git version 2.43.0`.
 *
 * The fix is in two halves. The service no longer downloads a log for a job
 * that did not fail, and this component renders from `drawer.node` — whose
 * steps and timings arrived with the checks poll the tab was already running —
 * so a passed, running, or queued job costs no GitHub call at all.
 */
export function PrCheckLogDrawer({
  drawer,
  excerpt,
  loading,
  error,
  elapsedLabel,
  onCopy,
  copied,
  onRerunJob,
  onFixInChat,
  onClose,
  onLoadLogExcerpt,
}: {
  drawer: PrCheckLogDrawerState;
  excerpt: PrCheckLogExcerpt | null;
  loading: boolean;
  error: string | null;
  elapsedLabel: string | null;
  onCopy: () => void;
  copied: boolean;
  onRerunJob: (() => void) | undefined;
  onFixInChat: (() => void) | undefined;
  onClose: () => void;
  /**
   * Fetch the log for a job that did not fail. Optional: when it is absent the
   * drawer offers the full log on GitHub instead and never asks for one itself.
   */
  onLoadLogExcerpt?: () => void;
}) {
  const plan = React.useMemo(
    () => buildCheckDetailPlan(drawer.node, excerpt),
    [drawer.node, excerpt],
  );
  const failed = plan.state === "failed";
  const tone = STATE_COLOR[plan.state];

  const fullLogUrl = excerpt?.htmlUrl ?? drawer.node.detailsUrl ?? null;
  const openFullLog = React.useCallback(() => {
    if (fullLogUrl) void window.ade.app.openExternal(fullLogUrl);
  }, [fullLogUrl]);
  const openDetails = React.useCallback(() => {
    if (drawer.node.detailsUrl) void window.ade.app.openExternal(drawer.node.detailsUrl);
  }, [drawer.node.detailsUrl]);

  // "We could not read this" is a different fact from "there is nothing to
  // read". It is worth surfacing where it is the only thing we have — the log
  // pane of a failed job, or a job with no steps to show — and worth staying
  // quiet about when the step breakdown already answers the question.
  const readFailure = error
    ?? (excerpt?.logStatus === "unavailable" ? excerpt.logUnavailableReason ?? null : null);

  // A failed job always shows its log body. A passed job shows one too once the
  // user asks for it with "Load log excerpt" — without this the button
  // downloaded a whole log that the drawer then had no branch to render, so the
  // click looked like it did nothing at all.
  const hasLogLines = (excerpt?.lines.length ?? 0) > 0;
  // A read that came back empty-handed is still an answer. Without this the
  // drawer was byte-identical before and after a failed "Load log excerpt" —
  // "we tried and couldn't" was indistinguishable from "you never asked".
  const explicitReadFailed = !failed && Boolean(readFailure);
  const showLogBody = failed || hasLogLines || explicitReadFailed;

  const footerNote = failed
    ? excerpt?.logScope === "whole-log"
      ? "tail of the whole job log · GitHub didn't mark a failing step"
      : "tail of the failing step · fetched on open"
    : explicitReadFailed
      ? "step times from this run · ADE couldn't read the log"
      : plan.state === "running" || plan.state === "queued"
        ? "live step state · the job log isn't complete yet"
        : "step times from this run · no log fetched";

  return (
    <section
      data-testid="pr-checks-log-drawer"
      data-job-id={drawer.jobId ?? undefined}
      data-job-state={plan.state}
      className="mt-2 overflow-hidden"
      style={{
        borderRadius: RADII.sm,
        border: `1px solid ${tint(tone, 30)}`,
        background: "transparent",
      }}
    >
      <div
        className="flex items-center gap-2 px-3 py-2.5"
        style={{ borderBottom: `1px solid ${COLORS.borderMuted}`, background: tint(tone, 6) }}
      >
        {/* The canonical glyph: it carries the aria-label and the running
            spinner that the drawer's local icon map did not. */}
        <StateIcon state={plan.state} size={13} />
        <span className="text-[12px] font-semibold" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
          {drawer.node.displayName}
        </span>
        <span
          className="shrink-0 text-[11px] font-medium"
          style={{ color: tone, fontFamily: SANS_FONT }}
          data-testid="pr-checks-drawer-outcome"
        >
          {plan.outcomeLabel}
        </span>
        {elapsedLabel ? (
          <span className="min-w-0 truncate text-[10px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
            {elapsedLabel}
          </span>
        ) : null}
        <span className="flex-1" />
        {onRerunJob ? (
          <SmallButton tone="warn" onClick={onRerunJob} testId="pr-checks-drawer-rerun-job">
            <ArrowsClockwise size={12} /> Re-run this job
          </SmallButton>
        ) : null}
        {drawer.node.detailsUrl ? (
          <SmallButton onClick={openDetails}>
            <GithubLogo size={12} /> GitHub
          </SmallButton>
        ) : null}
        <SmallButton onClick={onClose} testId="pr-checks-drawer-close" title="Close log">✕</SmallButton>
      </div>

      <div
        className="px-3 py-2 text-[11.5px]"
        style={{ color: COLORS.textSecondary, fontFamily: SANS_FONT, borderBottom: `1px solid ${COLORS.borderMuted}` }}
        data-testid="pr-checks-drawer-summary"
      >
        {plan.summary}
      </div>

      {failed && excerpt?.headline ? (
        <div
          className="px-3 py-2 text-[11.5px]"
          style={{ color: COLORS.danger, fontFamily: MONO_FONT, borderBottom: `1px solid ${COLORS.borderMuted}` }}
          data-testid="pr-checks-log-headline"
        >
          {excerpt.headline}
        </div>
      ) : null}

      {failed ? (
        <pre
          className="m-0 max-h-[220px] overflow-auto whitespace-pre-wrap px-3 py-2.5 text-[11px] leading-[1.55]"
          style={{ color: COLORS.textSecondary, fontFamily: MONO_FONT, background: COLORS.recessedBg }}
          data-testid="pr-checks-log-body"
        >
          {loading
            ? "Fetching the failing step's output…"
            : readFailure
              ? readFailure
              : excerpt && excerpt.lines.length > 0
                ? excerpt.lines.join("\n")
                : "GitHub returned no output for this job's failing step."}
        </pre>
      ) : plan.steps.length > 0 ? (
        <ul
          className="m-0 max-h-[220px] list-none overflow-auto py-1.5"
          style={{ background: COLORS.recessedBg }}
          data-testid="pr-checks-step-breakdown"
        >
          {plan.steps.map((step) => <StepRow key={`${step.number}-${step.name}`} step={step} />)}
        </ul>
      ) : (
        <div
          className="px-3 py-2.5 text-[11px]"
          style={{ color: COLORS.textDim, fontFamily: SANS_FONT, background: COLORS.recessedBg }}
          data-testid="pr-checks-step-breakdown"
        >
          {/* A read failure has its own pane below, so this states only the
              fact this block is about. */}
          GitHub didn't report any steps for this job.
        </div>
      )}

      {/* The log a passed job's "Load log excerpt" fetched. It sits *below* the
          step breakdown rather than replacing it: the steps are why the user
          opened the drawer, and the log is the extra they asked for. */}
      {showLogBody && !failed ? (
        <pre
          className="m-0 max-h-[220px] overflow-auto whitespace-pre-wrap px-3 py-2.5 text-[11px] leading-[1.55]"
          style={{
            color: COLORS.textSecondary,
            fontFamily: MONO_FONT,
            background: COLORS.recessedBg,
            borderTop: `1px solid ${COLORS.borderMuted}`,
          }}
          data-testid="pr-checks-log-body"
        >
          {hasLogLines ? excerpt!.lines.join("\n") : readFailure}
        </pre>
      ) : null}

      <div className="flex items-center gap-[7px] px-3 py-2" style={{ borderTop: `1px solid ${COLORS.borderMuted}` }}>
        <SmallButton onClick={onCopy} disabled={!excerpt} testId="pr-checks-drawer-copy">
          <Copy size={12} /> {copied ? "Copied" : failed ? "Copy excerpt" : "Copy details"}
        </SmallButton>
        <SmallButton
          onClick={fullLogUrl ? openFullLog : undefined}
          disabled={!fullLogUrl}
          testId="pr-checks-drawer-full-log"
        >
          <ArrowSquareOut size={12} /> Full log on GitHub
        </SmallButton>
        {failed ? (
          <SmallButton onClick={onFixInChat} disabled={!onFixInChat} testId="pr-checks-drawer-fix-in-chat">
            <Sparkle size={12} /> Fix in chat
          </SmallButton>
        ) : onLoadLogExcerpt && plan.state !== "queued" ? (
          <SmallButton
            onClick={onLoadLogExcerpt}
            disabled={loading}
            testId="pr-checks-drawer-load-log"
            title="Download this job's log from GitHub"
          >
            <ArrowsClockwise size={12} /> {loading ? "Loading log…" : "Load log excerpt"}
          </SmallButton>
        ) : null}
        <span
          className="ml-auto text-[10.5px]"
          style={{ color: COLORS.textDim, fontFamily: SANS_FONT }}
          data-testid="pr-checks-drawer-note"
        >
          {plan.stepsTotalMs != null && !failed
            ? `${footerNote} · ${fmtMs(plan.stepsTotalMs)} in steps`
            : footerNote}
        </span>
      </div>
    </section>
  );
}
