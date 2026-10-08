import React from "react";
import {
  ArrowSquareOut,
  Check,
  CheckCircle,
  Clock,
  Copy,
  GithubLogo,
  GitPullRequest,
  MinusCircle,
  Sparkle,
  Stack,
  XCircle,
} from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import type { PrCheck, PrReview, PrStatus, PrSummary } from "../../../shared/types";
import { formatPrBadgeLabel } from "../prs/shared/prFormatters";
import { PrUserAvatar } from "../prs/shared/PrUserAvatar";
import { GitHubStackBadge } from "../prs/shared/GitHubStackBadge";
import { pipelineStateOf } from "../../../shared/prPipelineState";
import { prStateTone } from "../../../shared/prChatScope";
import { NO_CI_REASON } from "../../../shared/prChecksRollup";

/*
 * The chat PR pane's compact PR card (`ChatPrPane`'s pane variant): live
 * status, checks, review, and the open / GitHub / copy actions.
 */

const paneAction =
  "inline-flex w-full items-center gap-2 rounded-lg border border-fg/[0.06] bg-fg/[0.02] px-2.5 py-1.5 text-left text-[12px] font-medium text-fg/65 transition-colors hover:border-fg/[0.10] hover:bg-fg/[0.04] hover:text-fg/85";

/** Human relative age for a sync timestamp. Computed at render (no ticking). */
function relTime(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "live";
  const s = Math.floor(ms / 1000);
  if (s < 10) return "live";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export type RelayState = { configured: boolean; webhookActive: boolean } | null;

/** green = fresh via webhook, amber = stale, grey = webhook not connected. */
function liveDot(pr: PrSummary, relay: RelayState): { dot: string; label: string; title: string } {
  const label = relTime(pr.lastSyncedAt);
  if (relay && !relay.configured) {
    return { dot: "bg-fg/30", label: "polling", title: "Webhook relay not connected — falling back to polling" };
  }
  const ageMs = pr.lastSyncedAt ? Date.now() - new Date(pr.lastSyncedAt).getTime() : Infinity;
  const fresh = Number.isFinite(ageMs) && ageMs < 120_000;
  const via = relay?.webhookActive ? "webhook" : "sync";
  return fresh
    ? { dot: "bg-emerald-400", label, title: `Live via GitHub ${via} · updated ${label} ago` }
    : { dot: "bg-amber-400/70", label, title: `Last ${via} ${label} ago` };
}

type ChecksView = { icon: React.ReactNode; text: string; tone: string; title?: string };

const NOT_RUN_TONE = "text-fg/45";

function notRunView(reason: string | null | undefined): ChecksView {
  return {
    icon: <MinusCircle size={11} weight="fill" />,
    text: "CI not run",
    tone: NOT_RUN_TONE,
    title: reason ?? NO_CI_REASON,
  };
}

function checksView(
  checks: PrCheck[] | null,
  fallback: PrSummary["checksStatus"],
  reason?: string | null,
): ChecksView | null {
  // ADE-135: the rollup knows two things the per-job rows cannot show — which
  // app produced each run, and which required contexts never reported at all.
  // When it says nothing verified this commit, that verdict outranks any count
  // of green rows; PR #988 had three third-party successes and zero CI.
  if (fallback === "not_run") return notRunView(reason);
  if (checks && checks.length > 0) {
    const total = checks.length;
    const failing = checks.filter((check) => pipelineStateOf(check) === "failed").length;
    const running = checks.filter((c) => c.status !== "completed").length;
    const passing = checks.filter((c) => c.conclusion === "success").length;
    if (failing > 0) {
      return { icon: <XCircle size={11} weight="fill" />, text: `${failing}/${total} checks failing`, tone: "text-red-300/85" };
    }
    if (running > 0) {
      return { icon: <Clock size={11} weight="fill" />, text: `${passing}/${total} checks running`, tone: "text-amber-300/80" };
    }
    // Every row settled and not one of them succeeded (all skipped/neutral/
    // cancelled). "0/3 checks" in green read as a pass; it is an absence.
    if (passing === 0) return notRunView(reason);
    return { icon: <CheckCircle size={11} weight="fill" />, text: `${passing}/${total} checks`, tone: "text-emerald-300/80" };
  }
  switch (fallback) {
    case "passing": return { icon: <CheckCircle size={11} weight="fill" />, text: "Checks passing", tone: "text-emerald-300/80" };
    case "failing": return { icon: <XCircle size={11} weight="fill" />, text: "Checks failing", tone: "text-red-300/85" };
    case "pending": return { icon: <Clock size={11} weight="fill" />, text: "Checks running", tone: "text-amber-300/80" };
    default: return null;
  }
}

type ReviewView = { reviewer: string | null; avatarUrl: string | null; text: string; tone: string };

function reviewView(reviews: PrReview[] | null, fallback: PrSummary["reviewStatus"]): ReviewView | null {
  const decisive = reviews
    ?.filter((r) => r.state === "approved" || r.state === "changes_requested")
    .slice(-1)[0];
  if (decisive) {
    return decisive.state === "approved"
      ? { reviewer: decisive.reviewer, avatarUrl: decisive.reviewerAvatarUrl, text: "Approved", tone: "text-emerald-300/80" }
      : { reviewer: decisive.reviewer, avatarUrl: decisive.reviewerAvatarUrl, text: "Changes requested", tone: "text-amber-300/80" };
  }
  switch (fallback) {
    case "approved": return { reviewer: null, avatarUrl: null, text: "Approved", tone: "text-emerald-300/80" };
    case "changes_requested": return { reviewer: null, avatarUrl: null, text: "Changes requested", tone: "text-amber-300/80" };
    case "requested": return { reviewer: null, avatarUrl: null, text: "Review requested", tone: "text-fg/50" };
    default: return null;
  }
}

export function isMergeReady(pr: PrSummary, status: PrStatus | null): boolean {
  if (pr.state !== "open") return false;
  if (!status) return false;
  const approved = status.reviewDecision === "approved" || status.reviewStatus === "approved";
  return (
    status.checksStatus === "passing" &&
    approved &&
    status.isMergeable &&
    !status.mergeConflicts &&
    (status.behindBaseBy ?? 0) === 0
  );
}

export function PrDetails({
  pr,
  checks,
  reviews,
  status,
  relay,
  copied,
  onOpenAde,
  onOpenGitHub,
  onCopy,
}: {
  pr: PrSummary;
  checks: PrCheck[] | null;
  reviews: PrReview[] | null;
  status: PrStatus | null;
  relay: RelayState;
  copied: boolean;
  onOpenAde: () => void;
  onOpenGitHub: () => void;
  onCopy: () => void;
}) {
  const tone = prStateTone(pr.state);
  const live = liveDot(pr, relay);
  // The live status wins over the stored summary when we have it, and its
  // reason must travel with the status it explains.
  const checksStatus = status?.checksStatus ?? pr.checksStatus;
  const checksReason = (status ? status.checksReason : pr.checksReason) ?? null;
  const checksInfo = pr.state === "open" || pr.state === "draft"
    ? checksView(checks, checksStatus, checksReason)
    : null;
  const reviewInfo = reviewView(reviews, pr.reviewStatus);
  const mergeReady = isMergeReady(pr, status);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className={cn("inline-block h-2 w-2 rounded-full", tone.dot)} />
        <span className="text-[11px] font-medium uppercase tracking-wide text-fg/55">{tone.label}</span>
        <span className="font-mono text-[11px] text-fg/45">{formatPrBadgeLabel(pr)}</span>
        <span className="ml-auto inline-flex items-center gap-1.5" title={live.title}>
          <span className={cn("inline-block h-1.5 w-1.5 rounded-full", live.dot)} />
          <span className="text-[10.5px] tabular-nums text-fg/40">{live.label}</span>
        </span>
      </div>

      <h3 className="text-[14px] font-semibold leading-snug text-fg/90">{pr.title}</h3>

      {pr.stack ? (
        <div className="rounded-lg border border-violet-400/15 bg-violet-500/[0.06] px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <GitHubStackBadge stack={pr.stack} />
            <span className="font-mono text-[10px] text-fg/35">base {pr.stack.baseBranch}</span>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-fg/50">
            This pull request belongs to GitHub Stack #{pr.stack.number}. Review rebases and merge the stack on GitHub.
          </p>
        </div>
      ) : mergeReady ? (
        <div className="inline-flex items-center gap-1.5 rounded-md bg-emerald-400/10 px-2 py-1 text-[11px] font-medium text-emerald-300/90">
          <Sparkle size={12} weight="fill" />
          Ready to merge
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg/50">
        {checksInfo ? (
          <span className={cn("inline-flex items-center gap-1", checksInfo.tone)} title={checksInfo.title}>
            {checksInfo.icon}
            {checksInfo.text}
          </span>
        ) : null}
        {pr.additions > 0 || pr.deletions > 0 ? (
          <span className="inline-flex items-center gap-1">
            <span className="text-emerald-400/60">+{pr.additions}</span>
            <span className="text-red-400/60">−{pr.deletions}</span>
          </span>
        ) : null}
      </div>

      {reviewInfo ? (
        <div className={cn("flex items-center gap-1.5 text-[11px]", reviewInfo.tone)}>
          {reviewInfo.reviewer ? (
            <PrUserAvatar user={{ login: reviewInfo.reviewer, avatarUrl: reviewInfo.avatarUrl }} size={16} />
          ) : null}
          <span>{reviewInfo.text}</span>
          {reviewInfo.reviewer ? <span className="text-fg/35">· {reviewInfo.reviewer}</span> : null}
        </div>
      ) : null}

      {typeof pr.behindBaseBy === "number" && pr.behindBaseBy > 0 ? (
        <div className="text-[11px] text-amber-300/70">⚠ {pr.behindBaseBy} behind base</div>
      ) : pr.mergeConflicts ? (
        <div className="text-[11px] text-red-300/75">⚠ Merge conflicts</div>
      ) : null}

      <div className="flex flex-col gap-1.5 pt-1">
        <button type="button" onClick={onOpenAde} className={paneAction}>
          <GitPullRequest size={12} weight="bold" />
          Open in ADE
        </button>
        <button type="button" onClick={onOpenGitHub} className={paneAction}>
          <GithubLogo size={12} weight="bold" />
          Open on GitHub
          <ArrowSquareOut size={10} className="ml-auto opacity-60" />
        </button>
        <button type="button" onClick={onCopy} className={paneAction}>
          {copied ? <Check size={12} weight="bold" /> : <Copy size={12} weight="bold" />}
          {copied ? "Copied link" : "Copy link"}
        </button>
      </div>
    </div>
  );
}
