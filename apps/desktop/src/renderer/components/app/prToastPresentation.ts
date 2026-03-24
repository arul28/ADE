import type { PrEventPayload } from "../../../shared/types";

type PrNotificationEvent = Extract<PrEventPayload, { type: "pr-notification" }>;

export type PrToastTone = "danger" | "warning" | "success" | "info";

function compactLabel(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length ? trimmed : null;
}

export function getPrToastTone(kind: PrNotificationEvent["kind"]): PrToastTone {
  if (kind === "checks_failing" || kind === "changes_requested") return "danger";
  if (kind === "review_requested") return "warning";
  if (kind === "merge_ready") return "success";
  return "info";
}

export function getPrToastHeadline(event: PrNotificationEvent): string {
  return compactLabel(event.prTitle) ?? compactLabel(event.title) ?? `Pull request #${event.prNumber}`;
}

export function getPrToastSummary(event: PrNotificationEvent): string {
  return compactLabel(event.message) ?? "Pull request status changed.";
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
