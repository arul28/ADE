import type {
  AppNavigationRequest,
  AttentionAction,
  AttentionEventKind,
  AttentionItem,
  AttentionNotchSettings,
  AttentionNotchToast,
  AttentionNotchToastTreatment,
  AttentionSnapshot,
  AttentionTone,
  OpenProjectBinding,
} from "../../../shared/types";
import {
  ATTENTION_CONTRACT_VERSION,
  ATTENTION_NOTCH_TOAST_MAX_DURATION_MS,
  ATTENTION_NOTCH_TOAST_MIN_DURATION_MS,
  ATTENTION_NOTCH_TOAST_TREATMENTS,
  ATTENTION_TONES,
  normalizeAttentionNotchRevealMode,
} from "../../../shared/types/attention";
import type { AttentionNotchOutput } from "./attentionNotchHelper";
import { remoteProjectRootPathsMatch } from "./remoteProjectIdentity";

// The write cap must stay under the helper's own read cap, or a snapshot the
// router happily accepts is silently dropped on the far side of the pipe.
const MAX_NOTCH_ITEMS = 64;
const MAX_NOTCH_ACTIONS = 12;
const MAX_SNAPSHOT_BYTES = 192 * 1024;
const MAX_TOAST_TITLE_LENGTH = 256;
const MAX_TOAST_SUBTITLE_LENGTH = 512;
const MAX_TOAST_ITEM_ID_LENGTH = 512;
export const ATTENTION_NOTCH_TOAST_DEDUPE_MS = 5_000;
const TOAST_TREATMENTS = new Set<string>(ATTENTION_NOTCH_TOAST_TREATMENTS);
const TONES = new Set<string>(ATTENTION_TONES);
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
 * Several renderer windows observe the same account store. Keep that useful
 * redundancy for snapshots, but allow only one native toast for the same event
 * during a short cross-window arbitration window.
 */
export function createAttentionNotchToastDeduper(
  now: () => number = Date.now,
  windowMs = ATTENTION_NOTCH_TOAST_DEDUPE_MS,
): (toast: AttentionNotchToast) => boolean {
  const forwardedAtByKey = new Map<string, number>();
  return (toast) => {
    const at = now();
    for (const [key, forwardedAt] of forwardedAtByKey) {
      if (at - forwardedAt >= windowMs) forwardedAtByKey.delete(key);
    }
    const key = JSON.stringify([toast.itemId ?? toast.title, toast.eventKind]);
    if (forwardedAtByKey.has(key)) return false;
    forwardedAtByKey.set(key, at);
    return true;
  };
}

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
    || value.actions.length > MAX_NOTCH_ACTIONS
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

const ATTENTION_COUNT_KEYS = [
  "needsYou",
  "working",
  "done",
  "total",
  "machinesOnline",
  "machinesTotal",
] as const;

/**
 * The two state groups the counts block gained after the notch strip moved to
 * five groups. They must NEVER join `ATTENTION_COUNT_KEYS`: a failed count
 * fails `isAttentionCounts`, which drops the ENTIRE snapshot, so requiring them
 * would blank the notch for any machine mid-rollout that still omits them.
 */
const OPTIONAL_ATTENTION_COUNT_KEYS = ["failed", "planning"] as const;

function isCountValue(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isAttentionCounts(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return ATTENTION_COUNT_KEYS.every((key) => isCountValue(value[key]))
    // Optional-if-present: absent is the rollout case and must parse, but a
    // present value still has to be a real count. A bad one is rejected rather
    // than silently dropped — the counts block is what the strip's "N failed"
    // reads from, and a machine sending junk there should show as a parse
    // failure in the logs, not as a quietly wrong number.
    && OPTIONAL_ATTENTION_COUNT_KEYS.every((key) =>
      value[key] === undefined || isCountValue(value[key]));
}

export function parseAttentionNotchSnapshot(input: unknown): AttentionSnapshot | null {
  if (!isRecord(input)) return null;
  try {
    if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_SNAPSHOT_BYTES) return null;
  } catch {
    return null;
  }
  if (
    input.contractVersion !== ATTENTION_CONTRACT_VERSION
    || !isNullableString(input.streamId, 512)
    || !Number.isSafeInteger(input.revision)
    || Number(input.revision) < 0
    || !isNonEmptyString(input.generatedAt, 128)
    || !Array.isArray(input.items)
    || input.items.length > MAX_NOTCH_ITEMS
    || !input.items.every(isAttentionItem)
    || (input.itemsTruncated !== undefined && typeof input.itemsTruncated !== "boolean")
    || (input.counts !== undefined && input.counts !== null && !isAttentionCounts(input.counts))
  ) {
    return null;
  }
  return input as AttentionSnapshot;
}

/**
 * A toast is an event, not state: a malformed one is dropped rather than
 * clamped, so a drifted renderer cannot quietly pin the surface open.
 */
export function parseAttentionNotchToast(input: unknown): AttentionNotchToast | null {
  if (!isRecord(input)) return null;
  if (
    typeof input.eventKind !== "string"
    || !ATTENTION_EVENTS.has(input.eventKind)
    || typeof input.treatment !== "string"
    || !TOAST_TREATMENTS.has(input.treatment)
    || !isNonEmptyString(input.title, MAX_TOAST_TITLE_LENGTH)
    || !isNullableString(input.subtitle, MAX_TOAST_SUBTITLE_LENGTH)
    || !isNullableString(input.itemId, MAX_TOAST_ITEM_ID_LENGTH)
    || (input.tone != null && (typeof input.tone !== "string" || !TONES.has(input.tone)))
    || (
      input.durationMs != null
      && (
        !Number.isSafeInteger(input.durationMs)
        || Number(input.durationMs) < ATTENTION_NOTCH_TOAST_MIN_DURATION_MS
        || Number(input.durationMs) > ATTENTION_NOTCH_TOAST_MAX_DURATION_MS
      )
    )
  ) {
    return null;
  }
  return {
    itemId: input.itemId == null ? null : String(input.itemId),
    eventKind: input.eventKind as AttentionEventKind,
    treatment: input.treatment as AttentionNotchToastTreatment,
    title: input.title,
    subtitle: input.subtitle == null ? null : String(input.subtitle),
    tone: input.tone == null ? null : (input.tone as AttentionTone),
    durationMs: input.durationMs == null ? null : Number(input.durationMs),
  };
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
    // Presentation keys are optional so a renderer from before they existed
    // still lands. `revealMode` is normalized rather than validated against the
    // current vocabulary: a renderer that persisted a retired value must not
    // have its ENTIRE settings message rejected, and must not silently lose a
    // strip it had pinned. Only a non-string is malformed here.
    || (input.revealMode !== undefined && typeof input.revealMode !== "string")
    || (
      input.expandedPanelEnabled !== undefined
      && typeof input.expandedPanelEnabled !== "boolean"
    )
  ) {
    return null;
  }
  return {
    enabled: input.enabled,
    // Legacy `minimal`/`click` map to `always`, so an upgrade keeps the strip
    // the user pinned instead of dropping them into the hover mode.
    revealMode: normalizeAttentionNotchRevealMode(input.revealMode),
    expandedPanelEnabled: input.expandedPanelEnabled !== false,
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

/**
 * The chrome outputs (Activity Center, Settings) a notch click asks for.
 *
 * `activatesApp` is always true and is deliberately part of the contract: the
 * notch is a separate helper process, so dispatching a navigation without
 * activating ADE lands it in a window behind whatever the user is looking at —
 * which is exactly why the gear and the header read as dead.
 */
export function attentionNotchAppNavigation(
  output: AttentionNotchOutput,
): { request: AppNavigationRequest; activatesApp: true } | null {
  if (output.type === "open_center") {
    return {
      request: {
        target: { kind: "route", route: "/attention" },
        source: "attention-notch",
      },
      activatesApp: true,
    };
  }
  if (output.type === "open_settings") {
    return {
      request: {
        target: { kind: "settings", tab: "activity", anchor: null },
        source: "attention-notch",
      },
      activatesApp: true,
    };
  }
  return null;
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
