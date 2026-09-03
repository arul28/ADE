/**
 * One PR, compactly, in the graph inspector.
 *
 * This is a DELIBERATE NARROWING and the one place the page is not the compiled
 * page. The compiled graph opened `PrDetailPane` — the PRs tab's own detail
 * view, 2,000-odd lines of files, threads, checks, timeline and merge box —
 * inside a modal over the canvas, wrapped in an inert `PrsProvider`. Porting it
 * would have meant porting the PRs tab into the graph plugin.
 *
 * What a reader on the graph actually needs from a PR is the verdict and the two
 * verbs: is it green, is it approved, how much conversation is on it — then
 * submit a review, or land it. That is this card. Everything else is one press
 * away in the PRs tab, and "Open in PRs" is that press, as a deeplink.
 *
 * Recorded in PARITY.md.
 */

import React from "react";
import { ArrowSquareOut } from "@phosphor-icons/react";
import { Button, cn } from "@ade-dev/ui";

import type { MergeMethod, PrWithConflicts } from "../lib/types";
import type { PagePrDetail } from "../host/actions";
import { getPrChecksBadge, getPrReviewsBadge, NO_CI_REASON } from "../lib/prVisuals";
import { prChecksLabel, toRelativeTime } from "../lib/graphHelpers";
import { prDeeplink } from "../lib/deeplinks";

const MERGE_METHODS: MergeMethod[] = ["merge", "squash", "rebase"];

function Badge({ label, color, bg, border }: { label: string; color: string; bg: string; border: string }) {
  return (
    <span
      className="inline-flex items-center rounded-md px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wide"
      style={{ color, backgroundColor: bg, border: `1px solid ${border}` }}
    >
      {label}
    </span>
  );
}

export function PrCard({
  pr,
  detail,
  loading,
  busy,
  error,
  mergeMethod,
  onMergeMethodChange,
  onSubmitReview,
  onLand,
  onRefresh,
  onOpenLink,
  onClose,
}: {
  pr: PrWithConflicts;
  detail: PagePrDetail | null;
  loading: boolean;
  busy: string | null;
  error: string | null;
  mergeMethod: MergeMethod;
  onMergeMethodChange: (method: MergeMethod) => void;
  onSubmitReview: (event: "APPROVE" | "REQUEST_CHANGES") => void;
  onLand: () => void;
  onRefresh: () => void;
  onOpenLink: (url: string) => void;
  onClose: () => void;
}): React.ReactElement {
  const status = detail?.status ?? null;
  const checks = detail?.checks ?? [];
  const reviews = detail?.reviews ?? [];
  const comments = detail?.comments ?? [];
  const checksStatus = status?.checksStatus ?? pr.checksStatus;
  const reviewStatus = status?.reviewStatus ?? pr.reviewStatus;
  const pendingChecks = checks.filter((c) => c.status === "queued" || c.status === "in_progress").length;
  const failedChecks = checks.filter((c) => c.conclusion === "failure" || c.conclusion === "timed_out").length;
  const approvals = reviews.filter((r) => r.state === "approved").length;
  const changeRequests = reviews.filter((r) => r.state === "changes_requested").length;
  const open = (status?.state ?? pr.state) === "open" || (status?.state ?? pr.state) === "draft";

  return (
    <div
      data-ade-graph-panel="pr"
      className="fixed inset-0 z-[96] flex items-center justify-center bg-black/45 p-4"
    >
      <div className="w-[min(560px,100%)] rounded-xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl p-4 shadow-float">
        <div className="mb-2 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-fg">PR #{pr.githubPrNumber}</div>
            <div className="mt-0.5 truncate text-xs text-muted-fg" title={pr.title}>
              {pr.title}
            </div>
          </div>
          <button type="button" className="text-muted-fg hover:text-fg" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        {error ? <div className="mb-3 rounded bg-red-900/30 p-2 text-xs text-red-200">{error}</div> : null}

        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs">
          <Badge {...getPrChecksBadge(checksStatus)} />
          <Badge {...getPrReviewsBadge(reviewStatus)} />
          <span className="text-muted-fg">
            checks <span className="text-fg">{prChecksLabel(checksStatus)}</span>
            {pendingChecks > 0 ? ` · ${pendingChecks} running` : ""}
            {failedChecks > 0 ? ` · ${failedChecks} failed` : ""}
          </span>
          <span className="text-muted-fg">
            reviews <span className="text-fg">{reviews.length}</span>
            {approvals > 0 ? ` · ${approvals} approved` : ""}
            {changeRequests > 0 ? ` · ${changeRequests} changes` : ""}
          </span>
          <span className="text-muted-fg">
            comments <span className="text-fg">{comments.length}</span>
          </span>
          {status ? (
            <span className="text-muted-fg">
              mergeable <span className="text-fg">{status.isMergeable ? "yes" : "no"}</span>
              {status.behindBaseBy != null ? (
                <>
                  {" "}· behind <span className="text-fg">{status.behindBaseBy}</span>
                </>
              ) : null}
            </span>
          ) : null}
          {checksStatus === "not_run" ? (
            <span className="w-full text-[11px] text-muted-fg">{status?.checksReason ?? pr.checksReason ?? NO_CI_REASON}</span>
          ) : null}
          <span className="w-full text-[11px] text-muted-fg">
            {loading ? "Loading PR detail…" : `synced ${toRelativeTime(pr.lastSyncedAt)}`}
          </span>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-fg">merge method</span>
          {MERGE_METHODS.map((method) => (
            <button
              key={method}
              type="button"
              className={cn(
                "rounded-xl border px-2 py-1 text-[11px] font-semibold uppercase tracking-wide",
                mergeMethod === method
                  ? "border-accent bg-accent/20 text-accent"
                  : "border-white/[0.08] bg-white/[0.02] text-muted-fg hover:text-fg",
              )}
              onClick={() => onMergeMethodChange(method)}
            >
              {method}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="mr-auto h-7 px-2 text-[11px]"
            onClick={() => onOpenLink(prDeeplink(pr.repoOwner, pr.repoName, pr.githubPrNumber))}
          >
            <ArrowSquareOut size={12} weight="regular" />
            Open in PRs
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={loading} onClick={onRefresh}>
            Refresh
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            disabled={!open || busy !== null}
            onClick={() => onSubmitReview("REQUEST_CHANGES")}
          >
            Request changes
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            disabled={!open || busy !== null}
            onClick={() => onSubmitReview("APPROVE")}
          >
            {busy === "APPROVE" ? "Approving…" : "Approve"}
          </Button>
          <Button
            size="sm"
            variant="primary"
            className="h-7 px-2 text-[11px]"
            disabled={!open || busy !== null}
            onClick={onLand}
          >
            {busy === "merge" ? "Landing…" : "Land"}
          </Button>
        </div>
      </div>
    </div>
  );
}
