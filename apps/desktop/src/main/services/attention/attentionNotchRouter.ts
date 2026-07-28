import type {
  AppNavigationRequest,
  AttentionAction,
  AttentionItem,
  AttentionNotchSettings,
  AttentionSnapshot,
  OpenProjectBinding,
} from "../../../shared/types";
import type { AttentionNotchOutput } from "./attentionNotchHelper";

const MAX_NOTCH_ITEMS = 256;
const MAX_NOTCH_ACTIONS = 12;
const MAX_SNAPSHOT_BYTES = 512 * 1024;
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

export type AttentionNotchResolvedOutput =
  | {
      kind: "navigate";
      item: AttentionItem;
      request: AppNavigationRequest;
      fallbackAction: AttentionAction | null;
    }
  | {
      kind: "acknowledge";
      item: AttentionItem;
      mode: "seen" | "dismiss";
    }
  | {
      kind: "ignore";
      reason:
        | "non_interactive_output"
        | "unknown_item"
        | "stale_destination"
        | "unknown_action";
    };

export function attentionRemoteBindingMatches(
  item: AttentionItem,
  binding: Extract<OpenProjectBinding, { kind: "remote" }>,
  targetId: string | null,
  requiresExactMachine: boolean,
): boolean {
  if (binding.projectId !== item.project.projectId) return false;
  if (requiresExactMachine) {
    return Boolean(targetId && binding.targetId === targetId);
  }
  return targetId
    ? binding.targetId === targetId
    : binding.rootPath === item.project.rootPath;
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
    value.contractVersion !== 1
    || !isNonEmptyString(value.id, 512)
    || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 0
    || !isNonEmptyString(value.fingerprint, 1_024)
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
    || value.actions.length > MAX_NOTCH_ACTIONS
    || !value.actions.every(isAttentionAction)
    || !isNonEmptyString(value.occurredAt, 128)
    || !isNonEmptyString(value.updatedAt, 128)
    || !isNullableString(value.seenAt, 128)
    || !isNullableString(value.dismissedAt, 128)
    || !isNullableString(value.expiresAt, 128)
  ) {
    return false;
  }
  return true;
}

export function parseAttentionNotchSnapshot(input: unknown): AttentionSnapshot | null {
  if (!isRecord(input)) return null;
  try {
    if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_SNAPSHOT_BYTES) return null;
  } catch {
    return null;
  }
  if (
    input.contractVersion !== 1
    || !isNullableString(input.streamId, 512)
    || !Number.isSafeInteger(input.revision)
    || Number(input.revision) < 0
    || !isNonEmptyString(input.generatedAt, 128)
    || !Array.isArray(input.items)
    || input.items.length > MAX_NOTCH_ITEMS
    || !input.items.every(isAttentionItem)
  ) {
    return null;
  }
  return input as AttentionSnapshot;
}

export function parseAttentionNotchSettings(input: unknown): AttentionNotchSettings | null {
  if (!isRecord(input)) return null;
  if (
    typeof input.enabled !== "boolean"
    || typeof input.hideDetails !== "boolean"
    || typeof input.celebrationsEnabled !== "boolean"
    || typeof input.soundsEnabled !== "boolean"
    || (
      input.preferredDisplayId != null
      && (!Number.isSafeInteger(input.preferredDisplayId) || Number(input.preferredDisplayId) < 0)
    )
  ) {
    return null;
  }
  return {
    enabled: input.enabled,
    preferredDisplayId: input.preferredDisplayId == null
      ? null
      : Number(input.preferredDisplayId),
    hideDetails: input.hideDetails,
    celebrationsEnabled: input.celebrationsEnabled,
    soundsEnabled: input.soundsEnabled,
  };
}

function sameDestination(
  left: AttentionItem["destination"],
  right: AttentionItem["destination"],
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "session" && right.kind === "session") {
    return (
      left.sessionId === right.sessionId
      && (left.itemId ?? null) === (right.itemId ?? null)
      && (left.eventId ?? null) === (right.eventId ?? null)
    );
  }
  if (left.kind !== "pull_request" || right.kind !== "pull_request") return false;
  return (
    (left.prId ?? null) === (right.prId ?? null)
    && (left.repoOwner ?? null) === (right.repoOwner ?? null)
    && (left.repoName ?? null) === (right.repoName ?? null)
    && left.number === right.number
    && left.tab === right.tab
    && (left.eventId ?? null) === (right.eventId ?? null)
  );
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
      source: "attention-notch",
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
    source: "attention-notch",
  };
}

export function resolveAttentionNotchOutput(
  output: AttentionNotchOutput,
  snapshot: AttentionSnapshot | null,
): AttentionNotchResolvedOutput {
  if (output.type !== "open" && output.type !== "action") {
    return { kind: "ignore", reason: "non_interactive_output" };
  }
  const item = snapshot?.items.find((candidate) => candidate.id === output.itemId);
  if (!item) return { kind: "ignore", reason: "unknown_item" };
  if (!sameDestination(item.destination, output.destination)) {
    return { kind: "ignore", reason: "stale_destination" };
  }
  if (output.type === "open") {
    return {
      kind: "navigate",
      item,
      request: attentionItemNavigationRequest(item),
      fallbackAction: null,
    };
  }

  const action = item.actions.find(
    (candidate) =>
      candidate.id === output.action.id
      && candidate.kind === output.action.kind,
  );
  if (!action) return { kind: "ignore", reason: "unknown_action" };
  if (action.kind === "mark_seen" || action.kind === "dismiss") {
    return {
      kind: "acknowledge",
      item,
      mode: action.kind === "dismiss" ? "dismiss" : "seen",
    };
  }
  return {
    kind: "navigate",
    item,
    request: attentionItemNavigationRequest(item),
    fallbackAction: action.kind === "open" ? null : action,
  };
}
