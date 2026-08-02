import type { PrChecksStatus, PrEventPayload } from "../../../shared/types";

type PrNotificationEvent = Extract<PrEventPayload, { type: "pr-notification" }>;

export type PrToastTone = "danger" | "warning" | "success" | "info";

function compactLabel(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length ? trimmed : null;
}

/**
 * ADE-135: `not_run` means nothing verified the head commit. The only
 * checks-derived success tone is `merge_ready`, so that is the one that must
 * never go green on an unverified commit.
 *
 * Defence in depth, deliberately: `prPollingService.isMergeReady` already
 * requires `checksStatus === "passing"`, so today this branch cannot fire.
 * It exists so that relaxing that upstream predicate cannot silently
 * reintroduce a green "ready to merge" toast on an unverified commit — do not
 * read its tests as coverage of a live path — a green toast is exactly the signal
 * a human (or a `/ship` loop) reads as "the suite is fine". It drops to `info`
 * rather than `danger`: absence is a finding, not a failure. The lifecycle
 * kinds (opened / reopened / merged) say nothing about CI and keep their tone.
 */
export function getPrToastTone(
  kind: PrNotificationEvent["kind"],
  checksStatus?: PrChecksStatus | null,
): PrToastTone {
  if (kind === "checks_failing" || kind === "changes_requested") return "danger";
  if (kind === "review_requested") return "warning";
  if (kind === "merge_ready") return checksStatus === "not_run" ? "info" : "success";
  if (kind === "merged" || kind === "opened" || kind === "reopened") return "success";
  return "info";
}

export function getPrToastHeadline(event: PrNotificationEvent): string {
  return compactLabel(event.prTitle) ?? compactLabel(event.title) ?? `Pull request #${event.prNumber}`;
}

export function getPrToastSummary(event: PrNotificationEvent): string {
  const message = compactLabel(event.message) ?? "Pull request status changed.";
  // The merge-ready copy reads as an all-clear. When nothing verified the head
  // commit, say so in the same breath rather than letting the reader infer a
  // green suite from a toast that never mentioned CI.
  if (event.kind === "merge_ready" && event.checksStatus === "not_run") {
    return `${message} No CI has run on this commit.`;
  }
  return message;
}

export function getPrToastMeta(event: PrNotificationEvent, laneName: string | null): string[] {
  const repoLabel = compactLabel([event.repoOwner, event.repoName].filter(Boolean).join("/"));
  const branchLabel = compactLabel(
    event.headBranch && event.baseBranch
      ? `${event.headBranch} -> ${event.baseBranch}`
      : event.headBranch || event.baseBranch,
  );
  const items = [
    compactLabel(laneName),
    branchLabel,
    repoLabel,
  ].filter((value): value is string => Boolean(value));
  return [...new Set(items)];
}
