import type {
  MissionRunView,
  MissionRunViewProgressItem,
  MissionRunViewSeverity,
} from "../../../shared/types";
import { replaceInternalToolNames } from "../chat/toolPresentation";
import { looksLikeLowSignalNoise } from "./missionHelpers";

export type MissionStateNarrative = {
  at: string | null;
  title: string;
  detail: string;
  severity: MissionRunViewSeverity;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function titleize(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((token) => `${token.charAt(0).toUpperCase()}${token.slice(1).toLowerCase()}`)
    .join(" ")
    .trim();
}

function sanitizeMissionFeedText(value: string): string {
  return normalizeWhitespace(replaceInternalToolNames(value));
}

function isDismissiveSteerMessage(value: string): boolean {
  return /^(acknowledged\.?|dismissed by user\b.*proceed without action\.?)$/i.test(value.trim());
}

function buildMissionFeedSignature(item: MissionRunViewProgressItem): string {
  return [
    item.kind,
    item.stepKey ?? "",
    item.attemptId ?? "",
    sanitizeMissionFeedText(item.title).toLowerCase(),
    sanitizeMissionFeedText(item.detail).toLowerCase(),
  ].join("::");
}

function isHumanizedToolOnlyText(value: string): boolean {
  const normalized = sanitizeMissionFeedText(value).toLowerCase();
  if (!normalized.length) return true;
  return /^(browser|canvas|docs|linear|parallel|posthog|sentry|shadcn\/ui|web|workspace)(?: [a-z0-9]+){0,4}$/.test(normalized);
}

function isGenericInternalActivityText(value: string): boolean {
  const normalized = sanitizeMissionFeedText(value).toLowerCase();
  if (!normalized.length) return true;
  if (/^(tool (call|result)|calling tool|reading|searching|listing|inspecting|fetching|opening|loading|thinking|worker update|worker result)$/.test(normalized)) {
    return true;
  }
  if (/^(reading|searching|listing|inspecting|fetching|opening|loading|calling tool)\b/.test(normalized)) {
    return true;
  }
  if (isHumanizedToolOnlyText(normalized)) return true;
  return false;
}

function shouldDisplayMissionFeedItem(item: MissionRunViewProgressItem): boolean {
  if (item.audience && item.audience !== "mission_feed") return false;
  const title = sanitizeMissionFeedText(item.title);
  const detail = sanitizeMissionFeedText(item.detail);
  const normalizedTitle = title.toLowerCase();
  const normalizedDetail = detail.toLowerCase();

  if (!title.length && !detail.length) return false;
  if (normalizedTitle === "run created" || normalizedTitle === "run activated") return false;
  if (
    normalizedTitle === "mission update"
    && (
      normalizedDetail.includes("status changed to")
      || normalizedDetail.includes("in_progress")
      || normalizedDetail.includes("start_run")
      || normalizedDetail.includes("activate_run")
    )
  ) {
    return false;
  }
  if (isDismissiveSteerMessage(title) || isDismissiveSteerMessage(detail)) return false;
  if (item.kind === "user" && isDismissiveSteerMessage(detail || title)) return false;
  if (looksLikeLowSignalNoise(title) && (!detail.length || looksLikeLowSignalNoise(detail))) return false;

  if (item.severity === "info" && item.kind !== "user" && item.kind !== "intervention") {
    if (isGenericInternalActivityText(title) && (!detail.length || isGenericInternalActivityText(detail) || looksLikeLowSignalNoise(detail))) {
      return false;
    }
    if (title.toLowerCase() === "worker update" && /(reported progress|reported status|status changed|progress update)/.test(detail.toLowerCase())) {
      return false;
    }
  }

  return true;
}

function sanitizeMissionFeedItem(item: MissionRunViewProgressItem): MissionRunViewProgressItem {
  return {
    ...item,
    title: sanitizeMissionFeedText(item.title),
    detail: sanitizeMissionFeedText(item.detail),
  };
}

function pickNarrativeTimestamp(runView: MissionRunView): string | null {
  return (
    runView.haltReason?.createdAt
    ?? runView.lastMeaningfulProgress?.at
    ?? runView.lifecycle.completedAt
    ?? runView.coordinator.updatedAt
    ?? runView.lifecycle.startedAt
    ?? null
  );
}

function summarizeLatestProgress(progress: MissionRunViewProgressItem | null): string | null {
  if (!progress) return null;
  const title = sanitizeMissionFeedText(progress.title);
  const detail = sanitizeMissionFeedText(progress.detail);
  if (!title.length && !detail.length) return null;
  if (detail.length && detail.toLowerCase() !== title.toLowerCase()) {
    return `${title}: ${detail}`;
  }
  return title || detail;
}

export function prepareMissionFeedItems(progressLog: MissionRunViewProgressItem[]): MissionRunViewProgressItem[] {
  const chronological = [...progressLog].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const prepared = chronological
    .map(sanitizeMissionFeedItem)
    .filter(shouldDisplayMissionFeedItem);

  return prepared.filter(
    (item, index, items) => index === 0 || buildMissionFeedSignature(item) !== buildMissionFeedSignature(items[index - 1]!),
  );
}

export function buildMissionStateNarrative(runView: MissionRunView | null): MissionStateNarrative | null {
  if (!runView) return null;

  const phaseLabel = sanitizeMissionFeedText(runView.active.phaseName ?? titleize(runView.active.phaseKey ?? ""));
  const stepLabel = sanitizeMissionFeedText(runView.active.stepTitle ?? "");
  const latestProgress = summarizeLatestProgress(runView.lastMeaningfulProgress);
  const lifecycleSummary = sanitizeMissionFeedText(runView.lifecycle.summary);

  let title = "Mission update";
  let detail = lifecycleSummary;
  let severity: MissionRunViewSeverity = "info";

  switch (runView.lifecycle.displayStatus) {
    case "running":
      title = phaseLabel.length ? `${phaseLabel} in progress` : "Mission running";
      detail = stepLabel.length ? `Working on ${stepLabel}.` : lifecycleSummary;
      break;
    case "starting":
      title = "Mission starting";
      detail = lifecycleSummary || "Preparing mission runtime and coordinator.";
      break;
    case "blocked":
      title = sanitizeMissionFeedText(runView.haltReason?.title ?? "Mission blocked");
      detail = sanitizeMissionFeedText(runView.haltReason?.detail ?? lifecycleSummary);
      severity = runView.haltReason?.severity ?? "warning";
      break;
    case "paused":
      title = sanitizeMissionFeedText(runView.haltReason?.title ?? "Mission paused");
      detail = sanitizeMissionFeedText(runView.haltReason?.detail ?? lifecycleSummary);
      severity = runView.haltReason?.severity ?? "warning";
      break;
    case "completed":
      title = "Mission completed";
      detail = lifecycleSummary || "The run finished successfully.";
      severity = "success";
      break;
    case "failed":
      title = sanitizeMissionFeedText(runView.haltReason?.title ?? "Mission failed");
      detail = sanitizeMissionFeedText(runView.haltReason?.detail ?? lifecycleSummary);
      severity = runView.haltReason?.severity ?? "error";
      break;
    case "canceled":
      title = "Mission canceled";
      detail = lifecycleSummary || "The run was canceled.";
      severity = "warning";
      break;
    case "not_started":
      title = "Mission ready";
      detail = lifecycleSummary || "Start a run to begin execution.";
      break;
  }

  if (latestProgress && !detail.toLowerCase().includes(latestProgress.toLowerCase()) && latestProgress.toLowerCase() !== title.toLowerCase()) {
    detail = detail.length ? `${detail} Latest: ${latestProgress}` : latestProgress;
  }

  return {
    at: pickNarrativeTimestamp(runView),
    title,
    detail,
    severity,
  };
}
