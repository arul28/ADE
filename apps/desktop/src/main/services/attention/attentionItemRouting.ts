import type {
  AppNavigationRequest,
  AttentionItem,
  OpenProjectBinding,
} from "../../../shared/types";
import { ATTENTION_CONTRACT_VERSION } from "../../../shared/types/attention";
import { remoteProjectRootPathsMatch } from "./remoteProjectIdentity";

const MAX_ATTENTION_ACTIONS = 12;

const ATTENTION_PHASES = new Set([
  "starting",
  "running",
  "needs_you",
  "blocked",
  "failed",
  "completed",
  "stale",
  "checks_failing",
  "review_requested",
  "changes_requested",
  "merge_ready",
  "open",
  "merged",
  "closed",
]);
const ATTENTION_EVENTS = new Set([
  "agent_running",
  "agent_needs_you",
  "agent_failed",
  "agent_completed",
  "pr_checks_failing",
  "pr_review_requested",
  "pr_changes_requested",
  "pr_merge_ready",
  "pr_merged",
  "pr_opened",
  "pr_closed",
]);

/**
 * Does an open remote window already show this project?
 *
 * The one predicate every remote-window lookup uses — a deeplink's ownership,
 * an Activity item, and the runtime's own catalog all reduce to the same
 * `{projectId, rootPath}` pair.
 *
 * A remote binding carries the runtime's registry project id while an Activity
 * item carries the publishing machine's `ade.db` uuid, so an id comparison
 * alone never matches a window that IS already showing this project — and
 * every click would open yet another window. `rootPath` is the identity both
 * sides share; see `remoteProjectIdentity.ts`.
 *
 * `targetId` is the machine the caller means. Pass it whenever the machine is
 * known — a canonical foreign-machine identity must never match a window bound
 * to a different host. `null` means "machine unknown", which only ever accepts
 * a root-path match: an id that came from another machine's id space is not
 * evidence about which host a window is bound to.
 */
export function remoteBindingMatchesProject(
  binding: Extract<OpenProjectBinding, { kind: "remote" }>,
  project: { projectId?: string | null; rootPath?: string | null },
  targetId: string | null,
): boolean {
  const rootMatches = remoteProjectRootPathsMatch(binding.rootPath, project.rootPath);
  const projectMatches =
    (Boolean(project.projectId) && binding.projectId === project.projectId)
    || rootMatches;
  if (!projectMatches) return false;
  return targetId ? binding.targetId === targetId : rootMatches;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, maxLength = 4_096): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isNullableString(value: unknown, maxLength = 4_096): boolean {
  return value == null || (typeof value === "string" && value.length <= maxLength);
}

function isAttentionDestination(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "session") {
    return (
      isNonEmptyString(value.sessionId)
      && isNullableString(value.itemId)
      && isNullableString(value.eventId)
    );
  }
  return (
    value.kind === "pull_request"
    && Number.isSafeInteger(value.number)
    && Number(value.number) > 0
    && (value.tab === "overview"
      || value.tab === "activity"
      || value.tab === "checks"
      || value.tab === "files")
    && isNullableString(value.prId)
    && isNullableString(value.repoOwner, 256)
    && isNullableString(value.repoName, 256)
    && isNullableString(value.eventId)
  );
}

function isAttentionAction(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id, 512)
    && (
      value.kind === "approve"
      || value.kind === "deny"
      || value.kind === "answer"
      || value.kind === "restart"
      || value.kind === "rerun_checks"
      || value.kind === "mark_seen"
      || value.kind === "dismiss"
      || value.kind === "open"
    )
    && isNonEmptyString(value.label, 256)
    && (value.destructive == null || typeof value.destructive === "boolean")
    && (
      value.payload == null
      || (
        isRecord(value.payload)
        && Object.keys(value.payload).length <= 32
        && Object.values(value.payload).every(
          (entry) =>
            entry == null
            || typeof entry === "string"
            || typeof entry === "number"
            || typeof entry === "boolean",
        )
      )
    )
  );
}

function isAttentionItem(value: unknown): value is AttentionItem {
  if (!isRecord(value)) return false;
  if (
    value.contractVersion !== ATTENTION_CONTRACT_VERSION
    || !isNonEmptyString(value.id, 512)
    || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 0
    || !isNonEmptyString(value.fingerprint, 1_024)
    || (
      value.activityTier !== undefined
      && value.activityTier !== "signal"
      && value.activityTier !== "ambient"
      && value.activityTier !== "idle"
    )
    || (value.contentFingerprint !== undefined && !isNonEmptyString(value.contentFingerprint, 1_024))
    || (value.alertFingerprint !== undefined && !isNonEmptyString(value.alertFingerprint, 1_024))
    || (value.kind !== "agent" && value.kind !== "pull_request")
    || typeof value.eventKind !== "string"
    || !ATTENTION_EVENTS.has(value.eventKind)
    || typeof value.phase !== "string"
    || !ATTENTION_PHASES.has(value.phase)
    || !isRecord(value.machine)
    || !isNonEmptyString(value.machine.machineKey, 512)
    || (
      value.machine.accountMachineKey != null
      && (
        !isNonEmptyString(value.machine.accountMachineKey, 64)
        || !/^[a-f0-9]{32,64}$/i.test(value.machine.accountMachineKey)
      )
    )
    || !isNullableString(value.machine.deviceId, 256)
    || !isNonEmptyString(value.machine.name, 512)
    || typeof value.machine.online !== "boolean"
    || !isNullableString(value.machine.lastSeenAt, 128)
    || !isRecord(value.project)
    || !isNonEmptyString(value.project.projectId, 512)
    || !isNonEmptyString(value.project.name, 512)
    || !isNullableString(value.project.rootPath)
    || !isNullableString(value.laneId, 512)
    || !isNullableString(value.laneName, 512)
    || !isNullableString(value.provider, 256)
    || !isNullableString(value.model, 512)
    || !isNonEmptyString(value.title, 1_024)
    || !isNonEmptyString(value.preview, 4_096)
    || !isNonEmptyString(value.privacyPreview, 1_024)
    || !isNullableString(value.detail, 8_192)
    || (
      value.recentActivity != null
      && (
        !Array.isArray(value.recentActivity)
        || value.recentActivity.length > 16
        || !value.recentActivity.every((entry) => isNonEmptyString(entry, 1_024))
      )
    )
    || (
      value.planProgress != null
      && (
        !isRecord(value.planProgress)
        || !Number.isSafeInteger(value.planProgress.completed)
        || Number(value.planProgress.completed) < 0
        || !Number.isSafeInteger(value.planProgress.total)
        || Number(value.planProgress.total) < 0
        || Number(value.planProgress.completed) > Number(value.planProgress.total)
        || !isNullableString(value.planProgress.current, 1_024)
      )
    )
    || !isAttentionDestination(value.destination)
    || (value.kind === "agent" && (value.destination as { kind?: unknown }).kind !== "session")
    || (
      value.kind === "pull_request"
      && (value.destination as { kind?: unknown }).kind !== "pull_request"
    )
    || !Array.isArray(value.actions)
    || value.actions.length > MAX_ATTENTION_ACTIONS
    || !value.actions.every(isAttentionAction)
    || !isNonEmptyString(value.occurredAt, 128)
    || !isNonEmptyString(value.updatedAt, 128)
    || !isNullableString(value.statusSince, 128)
    || !isNullableString(value.seenAt, 128)
    || !isNullableString(value.dismissedAt, 128)
    || !isNullableString(value.expiresAt, 128)
  ) {
    return false;
  }
  return true;
}

/**
 * Validate one Activity item handed over IPC before main acts on it.
 *
 * The renderer is not trusted to send a well-formed item: a malformed one is
 * refused rather than clamped, so a drifted window cannot open a destination
 * the item never named.
 */
export function parseAttentionItem(input: unknown): AttentionItem | null {
  return isAttentionItem(input) ? input : null;
}

export function attentionItemNavigationRequest(item: AttentionItem): AppNavigationRequest {
  if (item.destination.kind === "session") {
    return {
      target: {
        kind: "work",
        sessionId: item.destination.sessionId,
        laneId: item.laneId ?? null,
        envelope: null,
        event: null,
        offset: null,
      },
      source: "attention",
    };
  }

  return {
    target: {
      kind: "pr",
      prId: item.destination.prId ?? null,
      prNumber: item.destination.number,
      laneId: item.laneId ?? null,
      repoOwner: item.destination.repoOwner ?? null,
      repoName: item.destination.repoName ?? null,
      detailTab: item.destination.tab === "activity"
        ? "overview"
        : item.destination.tab,
    },
    source: "attention",
  };
}
