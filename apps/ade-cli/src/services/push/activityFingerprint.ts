import { createHash } from "node:crypto";
import {
  sanitizeAttentionPreview,
  type AttentionItem,
} from "../../../../desktop/src/shared/types/attention";

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

/**
 * Remove high-frequency progress copy that does not change what an Activity
 * row means. The sanitized preview remains part of the content identity; only
 * elapsed durations and token/file counters are normalized away.
 */
export function normalizeActivityPreview(value: string): string {
  return sanitizeAttentionPreview(value)
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|m|h)\b/gi, "")
    .replace(/\b\d[\d,]*(?:\.\d+)?(?=\s+(?:tokens?|files?)\b)/gi, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/** What the Activity row looks like, excluding timestamps and ack state. */
export function activityContentFingerprint(item: AttentionItem): string {
  return sha256({
    id: item.id,
    kind: item.kind,
    eventKind: item.eventKind,
    phase: item.phase,
    activityTier: item.activityTier ?? null,
    laneId: item.laneId ?? null,
    laneName: item.laneName ?? null,
    provider: item.provider ?? null,
    model: item.model ?? null,
    title: item.title,
    projectId: item.project.projectId,
    projectName: item.project.name,
    destination: item.destination,
    actions: item.actions.map((action) => `${action.id}:${action.kind}`),
    planProgress: item.planProgress ?? null,
    normalizedPreview: normalizeActivityPreview(item.preview),
  });
}

/** Stable identity of the alert, deliberately independent of copy and time. */
export function activityAlertFingerprint(item: AttentionItem): string {
  if (item.kind === "pull_request" && item.destination.kind === "pull_request") {
    return sha256({
      id: item.id,
      eventKind: item.eventKind,
      phase: item.phase,
      number: item.destination.number,
    });
  }
  return sha256({
    id: item.id,
    eventKind: item.eventKind,
    phase: item.phase,
    itemId: item.destination.kind === "session"
      ? item.destination.itemId ?? ""
      : "",
  });
}

/** Cheap publisher-side change detector, including acknowledgment changes. */
export function activityPublishFingerprint(item: AttentionItem): string {
  return [
    item.contentFingerprint ?? activityContentFingerprint(item),
    item.alertFingerprint ?? activityAlertFingerprint(item),
    item.seenAt ?? "",
    item.dismissedAt ?? "",
  ].join("\u0000");
}

/** Populate the split fingerprints while preserving the legacy field. */
export function withActivityFingerprints(item: AttentionItem): AttentionItem {
  const contentFingerprint = activityContentFingerprint(item);
  const alertFingerprint = activityAlertFingerprint(item);
  return {
    ...item,
    fingerprint: contentFingerprint,
    contentFingerprint,
    alertFingerprint,
  };
}
