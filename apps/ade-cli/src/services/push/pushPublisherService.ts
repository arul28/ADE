import path from "node:path";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import type { AgentChatEventEnvelope, AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import {
  ATTENTION_CONTRACT_VERSION,
  DEFAULT_ATTENTION_PREFERENCES,
  sanitizeAttentionPreview,
  sortAttentionItems,
  type AttentionEventKind,
  type AttentionItem,
  type AttentionPhase,
  type AttentionPreferences,
  type AttentionPresence,
  type AttentionSnapshot,
  type AttentionTombstone,
} from "../../../../desktop/src/shared/types/attention";
import type {
  SyncRosterChatStatus,
  SyncRosterProject,
} from "../../../../desktop/src/shared/types/sync";
import type { PtyExitEvent, TerminalSessionStatus } from "../../../../desktop/src/shared/types/sessions";
import { canonicalSessionState } from "../../../../desktop/src/shared/sessionCanonicalState";
import type { PrNotificationKind } from "../../../../desktop/src/shared/types/prs";
import type {
  PushDeviceRegistration,
  PushDeliveryStatus,
  PushLiveActivityTokenReport,
  PushNotificationPrefs,
  PushQuietHours,
} from "../../../../desktop/src/shared/types/push";
import type { PushRegistrationStore } from "./pushRegistrationStore";
import type {
  ActivityPublishResult,
  PushRelayAlertItem,
  PushRelayClient,
  PushRelayLiveActivityItem,
} from "./pushRelayClient";
import { PushRelayRequestError } from "./pushRelayClient";
import {
  activityPublishFingerprint,
  withActivityFingerprints,
} from "./activityFingerprint";

export const AGENT_RUNS_ACTIVITY_ID = "agent-runs";
export const AGENT_RUNS_ATTRIBUTES_TYPE = "ADEAgentRunsAttributes";
export const AGENT_RUNS_DEDUPE_KEY = "la:agent-runs";
/**
 * Machine-level push identity/registration file. Also the key of the shared
 * publisher singleton — bootstrap (create) and the daemon shutdown path (peek)
 * must resolve the identical path or the shutdown Live-Activity end silently
 * misses the instance.
 */
export function resolvePushRelayStateFile(secretsDir: string): string {
  return path.join(secretsDir, "push-relay.json");
}
/** UNNotificationCategory id iOS binds Approve/Deny actions to. */
export const APPROVAL_NOTIFICATION_CATEGORY = "ADE_APPROVAL";
const SHUTDOWN_PUBLISH_TIMEOUT_MS = 2_500;
const AGENT_RUNS_MAX = 3;
const PR_LIVE_ACTIVITY_MAX = 2;
const DETAIL_MAX_CHARS = 160;
/** Fixed lock-screen copy for failed runs — never leak error text to the widget. */
const FAILED_DETAIL = "Run failed";

/**
 * Does a tracked CLI exit code describe a user-chosen stop rather than a
 * failure? Derived, not re-invented: `ptyService.statusFromExit` maps 130
 * (SIGINT / Ctrl-C) and 143 (SIGTERM / the Stop button) to the `disposed`
 * terminal status, and `canonicalSessionState()` projects `disposed` to the
 * `stopped` phase — which `sessionStatusPresentation.ts` renders neutral,
 * explicitly not an alarm. This function asks the canonical module the same
 * question rather than pattern-matching exit codes at the notification layer.
 *
 * The exit-code → status step is the one bit that must be mirrored: it lives in
 * `apps/desktop/src/main/services/pty/ptyService.ts` (`statusFromExit`), which
 * is Electron-main code this package cannot import. Keep the two in lockstep.
 */
function isUserStoppedExit(exitCode: number | null | undefined): boolean {
  if (exitCode == null) return false;
  const status: TerminalSessionStatus = exitCode === 0
    ? "completed"
    : exitCode === 130 || exitCode === 143
      ? "disposed"
      : "failed";
  return canonicalSessionState({ status, exitCode }).phase === "stopped";
}

const RUNNING_TTL_MS = 2 * 60 * 60 * 1000; // 2h for running/starting
const WAITING_TTL_MS = 24 * 60 * 60 * 1000; // 24h for waiting_for_*
const PR_LIVE_ACTIVITY_TTL_MS = 45 * 60 * 1000; // keep recent PR status visible, then age it out
const ATTENTION_RECENT_TTL_MS = 24 * 60 * 60 * 1000;
export const ACTIVITY_ROSTER_MAX_ITEMS_PER_MACHINE = 300;
export const ACTIVITY_ROSTER_MIN_ITEMS_PER_MACHINE = 100;
export const ACTIVITY_PUBLISH_PAGE_ITEMS = 48;
export const ACTIVITY_RECONCILE_INTERVAL_MS = 30 * 60_000;
const ACTIVITY_ROSTER_CACHE_MS = 10_000;
const LEGACY_ATTENTION_PUBLISH_MAX_ITEMS = 64;
const DEFAULT_FLUSH_DEBOUNCE_MS = 2_000;
const DEFAULT_PROMPT_FLUSH_MS = 150;
const PUBLISH_RETRY_MS = 30_000;
const ATTENTION_HEARTBEAT_MS = 30_000;
const APNS_HEALTH_CACHE_MS = 24 * 60 * 60 * 1000;

export type AgentRunPhase =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "stale";

export type AgentRunState = {
  sessionId: string;
  /** Which attached project scope produced this run (for metadata resolution). */
  scopeKey: string;
  /** Chat runs come from agentChatService events; cli runs from PTY signals. */
  kind: "chat" | "cli";
  title: string | null;
  lane: string | null;
  model: string | null;
  agent: string | null;
  phase: AgentRunPhase;
  detail: string | null;
  /** Pending approval item id while phase is waiting_for_approval. */
  itemId: string | null;
  startedAt: number;
  lastActiveAt: number;
  /** Immutable while `phase` is unchanged. */
  statusSinceAt: number;
  metaResolved: boolean;
};

/** The OSC 133-derived terminal state pushed by ptyService.onSessionRuntimeSignal. */
export type PushCliRuntimeSignal = {
  laneId: string;
  sessionId: string;
  runtimeState: string;
};

export type PushSessionAttentionRequest = {
  sessionId: string;
  kind: "chat" | "cli";
  title: string;
  message: string;
  laneId?: string | null;
};

export type PushPrNotification = {
  kind: PrNotificationKind;
  prId?: string | null;
  prNumber: number;
  prTitle: string | null;
  laneId: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
};

export type PrLiveActivityState = {
  id: string;
  scopeKey: string;
  prId: string | null;
  prNumber: number;
  title: string;
  phase: PrNotificationKind;
  lane: string | null;
  repoOwner: string | null;
  repoName: string | null;
  updatedAt: number;
  statusSinceAt: number;
};

type PendingAlert = {
  sessionId: string | null;
  dedupeKey: string;
  /** Restricts a retry to phones whose prior delivery did not land. */
  targetDeviceIds?: string[];
  /** Rendered at flush time so run title/lane/agent reflect resolved metadata. */
  render: () => { title: string; body: string | null };
  deepLink?: string | null;
  threadId?: string | null;
  phase: "running" | "waiting" | "terminal";
  interruptionLevel?: "passive" | "active" | "time-sensitive" | null;
  /** Keeps same-copy lifecycle events publishable without disabling queue coalescing. */
  fingerprintSalt?: string | number | null;
  /** Approval item id — rides the payload so iOS can act without opening the app. */
  itemId?: string | null;
  /** UNNotificationCategory identifier binding actionable buttons on iOS. */
  category?: string | null;
};

type PushAgentChatService = {
  subscribeToEvents: (cb: (event: AgentChatEventEnvelope) => void) => () => void;
  getSessionSummary: (sessionId: string) => Promise<AgentChatSessionSummary | null>;
};

type PushPtyService = {
  onExit: (listener: (event: PtyExitEvent & { laneId: string }) => void) => () => void;
};

export type PushPublisherDeps = {
  logger: Logger;
  store: PushRegistrationStore;
  relayClient: PushRelayClient;
  machineName: string;
  getAccountMachineIdentity?: () => {
    machineKey: string;
    deviceId?: string | null;
  } | null;
  getAccountOwnerId?: () => string | null;
  activityRosterProvider?: {
    buildSnapshot(): Promise<SyncRosterProject[]>;
  } | null;
  /** Test seams. */
  now?: () => number;
  flushDebounceMs?: number;
  promptFlushMs?: number;
};

/**
 * Per-project signal sources. In the multi-project daemon every opened project
 * attaches its own chat/pty/PR streams to the single machine-level publisher, so
 * the aggregate "agent-runs" Live Activity merges runs across all projects
 * instead of each project clobbering the phone's one shared activity.
 */
export type PushPublisherSources = {
  agentChatService?: PushAgentChatService | null;
  ptyService?: PushPtyService | null;
  /** Injected bridge over prPollingService's `pr-notification` events. */
  subscribePrNotifications?: (cb: (event: PushPrNotification) => void) => () => void;
  resolveLaneName?: (laneId: string) => string | null | undefined;
  projectName?: string;
  projectRoot?: string;
  /**
   * Resolves a tracked terminal session for CLI-run metadata. Returning a
   * record with a `chatSessionId` (a chat-attached shell) or null (unknown /
   * infra row) drops the run — the chat run already represents that work.
   */
  resolveCliSession?: (sessionId: string) => {
    title: string | null;
    toolType?: string | null;
    chatSessionId?: string | null;
    status?: string | null;
    runtimeState?: string | null;
    settledAt?: string | null;
    settleOverride?: "settled" | "active" | null;
  } | null;
};

const ACTIVE_PHASES: ReadonlySet<AgentRunPhase> = new Set<AgentRunPhase>([
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
]);

function isActivePhase(phase: AgentRunPhase): boolean {
  return ACTIVE_PHASES.has(phase);
}

function isTerminalPhase(phase: AgentRunPhase): boolean {
  return !isActivePhase(phase);
}

/** Parse "HH:MM" (24h) into minutes-since-midnight, or null when malformed. */
export function parseHhMm(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function minutesInTimezone(nowMs: number, timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(nowMs));
    const hourRaw = parts.find((part) => part.type === "hour")?.value;
    const minuteRaw = parts.find((part) => part.type === "minute")?.value;
    if (hourRaw == null || minuteRaw == null) return null;
    // Some ICU builds render midnight as "24"; normalize to 0.
    const hour = Number(hourRaw) % 24;
    const minute = Number(minuteRaw);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

/**
 * Whether `nowMs` falls inside the quiet-hours window, evaluated in the
 * window's own IANA timezone. Windows may span midnight (start > end).
 */
export function isWithinQuietHours(quietHours: PushQuietHours | null | undefined, nowMs: number): boolean {
  if (!quietHours) return false;
  const start = parseHhMm(quietHours.start ?? "");
  const end = parseHhMm(quietHours.end ?? "");
  if (start == null || end == null || start === end) return false;
  const nowMinutes = minutesInTimezone(nowMs, quietHours.timezone);
  if (nowMinutes == null) return false; // unknown timezone → don't suppress
  if (start < end) return nowMinutes >= start && nowMinutes < end;
  // Window spans midnight, e.g. 22:00 → 07:00.
  return nowMinutes >= start || nowMinutes < end;
}

/**
 * Server-side alert gate for a device: honors the master switch, per-session
 * mutes, and quiet hours. Live Activity delivery uses a separate, quiet-hours-
 * exempt gate (see `shouldDeliverLiveActivityForPrefs`).
 */
export function shouldDeliverAlertForPrefs(
  prefs: PushNotificationPrefs,
  sessionId: string | null,
  nowMs: number,
): boolean {
  if (!prefs.enabled) return false;
  if (sessionId && (prefs.mutedSessionIds ?? []).includes(sessionId)) return false;
  if (isWithinQuietHours(prefs.quietHours, nowMs)) return false;
  return true;
}

export function shouldDeliverLiveActivityForPrefs(prefs: PushNotificationPrefs): boolean {
  return prefs.liveActivitiesEnabled !== false;
}

function capDetail(detail: string | null | undefined): string | null {
  if (!detail) return null;
  const trimmed = detail.trim();
  if (!trimmed) return null;
  return trimmed.length > DETAIL_MAX_CHARS ? trimmed.slice(0, DETAIL_MAX_CHARS) : trimmed;
}

/**
 * Build the aggregate `ADEAgentRunsAttributes` contentState. Runs are capped at
 * 3, most-recently-active first; `detail` is capped and redacted to "Run failed"
 * for failed runs so no error text reaches the lock screen.
 */
export function buildAgentRunsContentState(
  runs: AgentRunState[],
  nowMs: number,
  prs: PrLiveActivityState[] = [],
): {
  updatedAt: number;
  activeCount: number;
  runs: Array<{
    id: string;
    title: string;
    phase: AgentRunPhase;
    model: string | null;
    lane: string | null;
    detail: string | null;
    itemId?: string;
  }>;
  prs: Array<{
    id: string;
    prNumber: number;
    title: string;
    phase: PrNotificationKind;
    lane: string | null;
    repoOwner: string | null;
    repoName: string | null;
    updatedAt: number;
  }>;
} {
  const activeCount = runs.filter((run) => isActivePhase(run.phase)).length;
  const ordered = [...runs].sort((left, right) => right.lastActiveAt - left.lastActiveAt).slice(0, AGENT_RUNS_MAX);
  const orderedPrs = [...prs].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, PR_LIVE_ACTIVITY_MAX);
  return {
    updatedAt: Math.floor(nowMs / 1000),
    activeCount,
    runs: ordered.map((run) => ({
      id: run.sessionId,
      title: run.title?.trim() || "Agent run",
      phase: run.phase,
      model: run.model ?? null,
      lane: run.lane ?? null,
      detail: run.phase === "failed" ? FAILED_DETAIL : capDetail(run.detail),
      // Additive optional field (older widgets ignore it): lets the lock
      // screen render Approve/Deny intents against the pending item.
      ...(run.phase === "waiting_for_approval" && run.itemId ? { itemId: run.itemId } : {}),
    })),
    prs: orderedPrs.map((pr) => ({
      id: pr.id,
      prNumber: pr.prNumber,
      title: pr.title,
      phase: pr.phase,
      lane: pr.lane,
      repoOwner: pr.repoOwner,
      repoName: pr.repoName,
      updatedAt: Math.floor(pr.updatedAt / 1000),
    })),
  };
}

/**
 * Waiting runs are what the app icon badge counts — agents blocked on the
 * user. CLI runs are excluded: a CLI at its prompt reports waiting_for_input
 * as its normal resting state (mirroring the no-alert rule for CLI prompts),
 * so counting it would pin the badge non-zero forever.
 */
export function countAwaitingAttentionRuns(runs: AgentRunState[]): number {
  return runs.filter(
    (run) =>
      run.kind !== "cli"
      && (run.phase === "waiting_for_approval" || run.phase === "waiting_for_input"),
  ).length;
}

function readOutcomeCount(result: Record<string, unknown> | null | undefined, key: string): number {
  const value = Number(result?.[key]);
  return Number.isFinite(value) ? value : 0;
}

type RelayLiveActivityOutcome = {
  deviceId: string;
  delivered: boolean;
  suppressed: boolean;
  skipped: boolean;
};

type RelayAlertOutcome = { deviceId: string; delivered: boolean; suppressed: boolean };

type AlertDeliveryAttempt = {
  alert: PendingAlert | null;
  deviceId: string;
  fingerprint: string | null;
};

/**
 * The relay's per-target `outcomes[]` entries filtered to alert items, keyed
 * by device. Null when the relay response has no outcomes array (legacy/mock
 * shape) — callers treat that as "no per-device verdicts", not "nothing landed".
 */
function readAlertOutcomes(result: Record<string, unknown> | null | undefined): RelayAlertOutcome[] | null {
  const raw = result?.outcomes;
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    .filter((entry) => entry.kind === "alert" && typeof entry.deviceId === "string")
    .map((entry) => ({
      deviceId: entry.deviceId as string,
      delivered: entry.delivered === true,
      suppressed: entry.suppressed === true,
    }));
}

/** The relay's per-target `outcomes[]` entries filtered to the Live Activity item. */
function readLiveActivityOutcomes(result: Record<string, unknown> | null | undefined): RelayLiveActivityOutcome[] | null {
  const raw = result?.outcomes;
  // No outcomes array at all = legacy/mock relay response shape; callers treat
  // that as "no per-item verdicts available" rather than "nothing landed".
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    .filter((entry) => entry.kind === "liveactivity" && typeof entry.deviceId === "string")
    .map((entry) => ({
      deviceId: entry.deviceId as string,
      delivered: entry.delivered === true,
      suppressed: entry.suppressed === true,
      skipped: typeof entry.skipped === "string" && entry.skipped.length > 0,
    }));
}

function deviceScopedAlertDedupeKey(dedupeKey: string, deviceId: string): string {
  return `alert-device:${deviceId.length}:${deviceId}:${dedupeKey}`;
}

function providerDisplayName(provider: string | null | undefined): string | null {
  if (!provider) return null;
  switch (provider) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "droid":
      return "Droid";
    case "opencode":
      return "OpenCode";
    case "gemini":
      return "Gemini";
    default:
      return provider.charAt(0).toUpperCase() + provider.slice(1);
  }
}

function agentAttentionPhase(phase: AgentRunPhase): AttentionPhase {
  if (phase === "waiting_for_approval" || phase === "waiting_for_input") return "needs_you";
  return phase;
}

function rosterAttentionPhase(status: SyncRosterChatStatus): AttentionPhase {
  switch (status) {
    case "awaiting":
      return "needs_you";
    case "failed":
      return "failed";
    case "running":
      return "running";
    case "idle":
      return "stale";
    case "ended":
      return "completed";
  }
}

function rosterActivityTier(status: SyncRosterChatStatus): "ambient" | "idle" {
  return status === "idle" || status === "ended" ? "idle" : "ambient";
}

function prActivityTier(phase: AttentionPhase): "signal" | "ambient" {
  return phase === "checks_failing"
    || phase === "changes_requested"
    || phase === "review_requested"
    || phase === "merge_ready"
    ? "signal"
    : "ambient";
}

function validTimestampMs(
  value: string | null | undefined,
  fallback: number,
): number {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function agentAttentionEventKind(phase: AgentRunPhase): AttentionEventKind {
  if (phase === "waiting_for_approval" || phase === "waiting_for_input") return "agent_needs_you";
  if (phase === "failed") return "agent_failed";
  if (phase === "completed") return "agent_completed";
  return "agent_running";
}

function prAttentionState(kind: PrNotificationKind): {
  phase: AttentionPhase;
  eventKind: AttentionEventKind;
  tab: "overview" | "activity" | "checks";
} {
  switch (kind) {
    case "checks_failing":
      return { phase: "checks_failing", eventKind: "pr_checks_failing", tab: "checks" };
    case "review_requested":
      return { phase: "review_requested", eventKind: "pr_review_requested", tab: "activity" };
    case "changes_requested":
      return { phase: "changes_requested", eventKind: "pr_changes_requested", tab: "activity" };
    case "merge_ready":
      return { phase: "merge_ready", eventKind: "pr_merge_ready", tab: "overview" };
    case "merged":
      return { phase: "merged", eventKind: "pr_merged", tab: "overview" };
    case "closed":
      return { phase: "closed", eventKind: "pr_closed", tab: "overview" };
    case "opened":
    case "reopened":
      return { phase: "open", eventKind: "pr_opened", tab: "overview" };
  }
}

export function createPushPublisherService(deps: PushPublisherDeps) {
  const now = deps.now ?? (() => Date.now());
  const flushDebounceMs = deps.flushDebounceMs ?? DEFAULT_FLUSH_DEBOUNCE_MS;
  const promptFlushMs = deps.promptFlushMs ?? DEFAULT_PROMPT_FLUSH_MS;

  const runs = new Map<string, AgentRunState>();
  const recentRuns = new Map<string, AgentRunState>();
  const prActivities = new Map<string, PrLiveActivityState>();
  const lastMachineSnapshotItems = new Map<string, AttentionItem>();
  let lastMachineSnapshotAccountOwnerId: string | null | undefined;
  let pendingAlerts: PendingAlert[] = [];
  const lastAlertFingerprintByKey = new Map<string, Map<string, string>>();
  const lastPublishedFingerprintById = new Map<string, string>();
  const initialAccountOwnerId = deps.getAccountOwnerId?.()?.trim() || null;
  const persistedPublishedRevisions =
    deps.store.getLastPublishedActivityRevisions?.() ?? null;
  const lastPublishedRevisionById = new Map<string, number>(
    Object.entries(persistedPublishedRevisions?.revisions ?? {}),
  );
  const lastOverflowRevisionById = new Map<string, number>();
  let activityProtocol = deps.store.getActivityProtocol?.() ?? null;
  let activityRosterProvider = deps.activityRosterProvider ?? null;
  let rosterCache: { at: number; projects: SyncRosterProject[] } | null = null;
  let rosterEpoch = 0;
  let reconcilePending = true;
  let lastReconcileAt = 0;
  let lastActivityAccountOwnerId: string | null | undefined =
    persistedPublishedRevisions?.accountOwnerId ?? initialAccountOwnerId;
  let activityRosterCap = ACTIVITY_ROSTER_MAX_ITEMS_PER_MACHINE;
  let lastLegacyAttentionFingerprint: string | null = null;
  let lastAttentionPublishedAt = 0;
  /** Last Live Activity content confirmed per phone. Absence means start. */
  const liveActivityFingerprintByDevice = new Map<string, string>();
  /**
   * Invalidates in-flight commits after an explicit token clear/unregister.
   * Keep the epoch even after deleting state so a stale publish cannot
   * resurrect the cleared phone when its relay response arrives.
   */
  const liveActivityEpochByDevice = new Map<string, number>();
  /**
   * Last app-icon badge count delivered per device (absent = never sent).
   * Per-device because a flush can legitimately exclude some devices (quiet
   * hours, alert-covered subsets) — a global scalar would mark their stale
   * badge as already-synced and skip them until the next count change.
   */
  const lastSentBadgeByDevice = new Map<string, number>();

  let flushTimer: NodeJS.Timeout | null = null;
  let prExpiryTimer: NodeJS.Timeout | null = null;
  let attentionHeartbeatTimer: NodeJS.Timeout | null = null;
  let flushFireAt = 0;
  let flushing = false;
  let scheduledFlushIncludesActivity = false;
  let finalAttentionSnapshotPending = false;
  let finalAttentionSnapshotQueued = false;
  let disposed = false;
  let warmed = false;

  type AttachedScope = {
    agentChatService?: PushAgentChatService | null;
    resolveLaneName?: (laneId: string) => string | null | undefined;
    resolveCliSession?: PushPublisherSources["resolveCliSession"];
    projectName: string;
    projectRoot: string | null;
    unsubscribes: Array<() => void>;
  };
  const scopes = new Map<string, AttachedScope>();

  let apnsConfiguredCache: { value: boolean | null; at: number } | null = null;

  const logWarn = (message: string, error: unknown): void => {
    deps.logger.warn(message, { error: error instanceof Error ? error.message : String(error) });
  };

  const persistLastPublishedRevisions = (): void => {
    deps.store.setLastPublishedActivityRevisions?.({
      accountOwnerId: lastActivityAccountOwnerId ?? null,
      revisions: Object.fromEntries(lastPublishedRevisionById),
    });
  };

  const isGated = (): boolean => {
    if (!deps.store.hasRegisteredDevices()) return true;
    if (!deps.store.getStatusSnapshot().enabled) return true;
    return false;
  };

  const ensureRun = (sessionId: string, scopeKey: string, kind: "chat" | "cli" = "chat"): AgentRunState => {
    let run = runs.get(sessionId);
    if (!run) {
      const ts = now();
      run = {
        sessionId,
        scopeKey,
        kind,
        title: null,
        lane: null,
        model: null,
        agent: null,
        phase: "starting",
        detail: null,
        itemId: null,
        startedAt: ts,
        lastActiveAt: ts,
        statusSinceAt: ts,
        metaResolved: false,
      };
      runs.set(sessionId, run);
    }
    recentRuns.delete(sessionId);
    return run;
  };

  const markRunUpdated = (run: AgentRunState): void => {
    run.lastActiveAt = Math.max(now(), run.lastActiveAt + 1);
  };

  const setRunPhase = (run: AgentRunState, phase: AgentRunPhase): void => {
    if (run.phase === phase) return;
    run.phase = phase;
    run.statusSinceAt = run.lastActiveAt;
  };

  const runSubject = (run: AgentRunState): string => run.agent?.trim() || run.title?.trim() || "Agent";

  const laneTitleLine = (run: AgentRunState): string => {
    const parts = [run.lane?.trim(), run.title?.trim()].filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join(" · ") : run.title?.trim() || "Agent run";
  };

  const loadActivityRoster = async (nowMs: number): Promise<SyncRosterProject[]> => {
    if (!activityRosterProvider) return [];
    if (rosterCache && nowMs - rosterCache.at < ACTIVITY_ROSTER_CACHE_MS) {
      return rosterCache.projects;
    }
    try {
      const projects = await activityRosterProvider.buildSnapshot();
      rosterCache = { at: nowMs, projects };
      return projects;
    } catch (error) {
      logWarn("attention.activity_roster_build_failed", error);
      const projects = rosterCache?.projects ?? [];
      rosterCache = { at: nowMs, projects };
      return projects;
    }
  };

  const buildAttentionItems = async (
    nowMs: number,
    includeRoster: boolean,
  ): Promise<AttentionItem[]> => {
    const { machineKey } = deps.store.getOrCreateIdentity();
    const accountMachineIdentity = deps.getAccountMachineIdentity?.() ?? null;
    const nowIso = new Date(nowMs).toISOString();
    const machine = {
      machineKey,
      accountMachineKey: accountMachineIdentity?.machineKey ?? null,
      deviceId: accountMachineIdentity?.deviceId ?? null,
      name: deps.machineName,
      online: true,
      lastSeenAt: nowIso,
    };
    const attentionRuns = new Map<string, AgentRunState>([
      ...recentRuns,
      ...runs,
    ]);
    const runItems = [...attentionRuns.values()].map((run): AttentionItem => {
      const scope = scopes.get(run.scopeKey);
      const phase = agentAttentionPhase(run.phase);
      const eventKind = agentAttentionEventKind(run.phase);
      const subject = runSubject(run);
      const preview = sanitizeAttentionPreview(
        run.detail?.trim() || laneTitleLine(run),
      );
      const expiresAt = new Date(
        run.lastActiveAt
          + (
            run.phase === "running" || run.phase === "starting" || run.phase === "stale"
              ? RUNNING_TTL_MS
              : ATTENTION_RECENT_TTL_MS
          ),
      ).toISOString();
      const actions: AttentionItem["actions"] = [
        { id: "open", kind: "open", label: "Open" },
      ];
      if (run.phase === "waiting_for_approval" && run.itemId) {
        actions.unshift(
          {
            id: "approve",
            kind: "approve",
            label: "Approve",
            payload: { sessionId: run.sessionId, itemId: run.itemId },
          },
          {
            id: "deny",
            kind: "deny",
            label: "Deny",
            destructive: true,
            payload: { sessionId: run.sessionId, itemId: run.itemId },
          },
        );
      } else if (run.phase === "waiting_for_input") {
        actions.unshift({
          id: "answer",
          kind: "answer",
          label: "Answer",
          payload: { sessionId: run.sessionId },
        });
      }
      const item: AttentionItem = {
        contractVersion: ATTENTION_CONTRACT_VERSION,
        id: `agent:${machineKey}:${run.sessionId}`,
        revision: run.lastActiveAt,
        fingerprint: "",
        activityTier: phase === "needs_you" || phase === "failed" ? "signal" : "ambient",
        kind: "agent",
        eventKind,
        phase,
        machine,
        project: {
          projectId: run.scopeKey,
          name: scope?.projectName ?? "ADE project",
          rootPath: scope?.projectRoot ?? null,
        },
        laneId: null,
        laneName: run.lane,
        provider: run.agent,
        model: run.model,
        title: phase === "needs_you"
          ? `${subject} needs you`
          : phase === "failed"
            ? `${subject} failed`
            : phase === "completed"
              // "Done", not "finished": the shared status vocabulary in
              // apps/desktop/src/shared/sessionStatusPresentation.ts labels the
              // ready/idle tier "Done" on every surface, and a push title that
              // disagrees with the row the user taps through to is a bug.
              ? `${subject} is done`
              : `${subject} is working`,
        preview,
        privacyPreview: phase === "needs_you"
          ? "An ADE agent needs your input."
          : phase === "failed"
            ? "An ADE agent run failed."
            : phase === "completed"
              ? "An ADE agent is done."
              : "An ADE agent is working.",
        detail: run.detail ? sanitizeAttentionPreview(run.detail, 1_000) : null,
        recentActivity: run.detail ? [sanitizeAttentionPreview(run.detail)] : [],
        planProgress: null,
        destination: {
          kind: "session",
          sessionId: run.sessionId,
          itemId: run.itemId,
        },
        actions,
        occurredAt: new Date(run.startedAt).toISOString(),
        updatedAt: new Date(run.lastActiveAt).toISOString(),
        statusSince: new Date(run.statusSinceAt).toISOString(),
        seenAt: null,
        dismissedAt: null,
        expiresAt,
      };
      return withActivityFingerprints(item);
    });

    const rosterItems = includeRoster
      ? (await loadActivityRoster(nowMs)).flatMap((project): AttentionItem[] => {
        const laneNames = new Map(project.lanes.map((lane) => [lane.id, lane.name]));
        return project.chats.map((chat): AttentionItem => {
          const phase = rosterAttentionPhase(chat.status);
          const activityTier = rosterActivityTier(chat.status);
          const revision = validTimestampMs(chat.lastActivityAt, nowMs);
          const activityAt = new Date(revision).toISOString();
          const provider = providerDisplayName(chat.provider ?? chat.toolType);
          const subject = provider ?? chat.title?.trim() ?? "Agent";
          const preview = sanitizeAttentionPreview(
            chat.attentionMessage?.trim()
              || chat.statusNote?.trim()
              || chat.preview?.trim()
              || chat.title?.trim()
              || laneNames.get(chat.laneId)
              || "ADE session",
          );
          const actions: AttentionItem["actions"] = [
            { id: "open", kind: "open", label: "Open" },
          ];
          if (phase === "needs_you") {
            actions.unshift({
              id: "answer",
              kind: "answer",
              label: "Answer",
              payload: { sessionId: chat.id },
            });
          }
          return withActivityFingerprints({
            contractVersion: ATTENTION_CONTRACT_VERSION,
            id: `agent:${machineKey}:${chat.id}`,
            revision,
            fingerprint: "",
            activityTier,
            kind: "agent",
            eventKind: phase === "needs_you"
              ? "agent_needs_you"
              : phase === "failed"
                ? "agent_failed"
                : phase === "completed"
                  ? "agent_completed"
                  : "agent_running",
            phase,
            machine,
            project: {
              projectId: project.projectId,
              name: project.displayName,
              rootPath: project.rootPath ?? null,
            },
            laneId: chat.laneId,
            laneName: laneNames.get(chat.laneId) ?? null,
            provider,
            model: chat.model ?? null,
            title: phase === "needs_you"
              ? `${subject} needs you`
              : phase === "failed"
                ? `${subject} failed`
                : phase === "completed"
                  ? `${subject} is done`
                  : phase === "stale"
                    ? `${subject} is idle`
                    : `${subject} is working`,
            preview,
            privacyPreview: phase === "needs_you"
              ? "An ADE agent needs your input."
              : phase === "failed"
                ? "An ADE agent run failed."
                : phase === "completed"
                  ? "An ADE agent is done."
                  : phase === "stale"
                    ? "An ADE agent session is idle."
                    : "An ADE agent is working.",
            detail: chat.statusNote ? sanitizeAttentionPreview(chat.statusNote, 1_000) : null,
            recentActivity: [],
            planProgress: null,
            destination: {
              kind: "session",
              sessionId: chat.id,
              itemId: null,
            },
            actions,
            occurredAt: activityAt,
            updatedAt: activityAt,
            statusSince: activityAt,
            seenAt: null,
            dismissedAt: null,
            expiresAt: activityTier === "idle"
              ? null
              : new Date(revision + (phase === "running" ? RUNNING_TTL_MS : ATTENTION_RECENT_TTL_MS)).toISOString(),
          });
        });
      })
      : [];

    const prItems = [...prActivities.values()].map((pr): AttentionItem => {
      const scopeKey = pr.scopeKey;
      const scope = scopes.get(scopeKey);
      const mapped = prAttentionState(pr.phase);
      const title = prNotificationCopy({
        kind: pr.phase,
        prNumber: pr.prNumber,
        prTitle: pr.title,
        laneId: null,
      }).title;
      const actions: AttentionItem["actions"] = [
        { id: "open", kind: "open", label: "Open pull request" },
      ];
      if (pr.phase === "checks_failing" && pr.prId) {
        actions.unshift({
          id: "rerun_checks",
          kind: "rerun_checks",
          label: "Rerun checks",
          payload: { prId: pr.prId, prNumber: pr.prNumber },
        });
      }
      const item: AttentionItem = {
        contractVersion: ATTENTION_CONTRACT_VERSION,
        id: `pull-request:${machineKey}:${pr.id}`,
        revision: pr.updatedAt,
        fingerprint: "",
        activityTier: prActivityTier(mapped.phase),
        kind: "pull_request",
        eventKind: mapped.eventKind,
        phase: mapped.phase,
        machine,
        project: {
          projectId: scopeKey,
          name: scope?.projectName ?? "ADE project",
          rootPath: scope?.projectRoot ?? null,
        },
        laneId: null,
        laneName: pr.lane,
        provider: "GitHub",
        model: null,
        title,
        preview: sanitizeAttentionPreview(pr.title),
        privacyPreview: `Pull request #${pr.prNumber} changed state.`,
        detail: null,
        recentActivity: [],
        planProgress: null,
        destination: {
          kind: "pull_request",
          prId: pr.prId,
          repoOwner: pr.repoOwner,
          repoName: pr.repoName,
          number: pr.prNumber,
          tab: mapped.tab,
        },
        actions,
        occurredAt: new Date(pr.updatedAt).toISOString(),
        updatedAt: new Date(pr.updatedAt).toISOString(),
        statusSince: new Date(pr.statusSinceAt).toISOString(),
        seenAt: null,
        dismissedAt: null,
        expiresAt: new Date(pr.updatedAt + ATTENTION_RECENT_TTL_MS).toISOString(),
      };
      return withActivityFingerprints(item);
    });

    const agentItems = new Map<string, AttentionItem>();
    for (const item of rosterItems) agentItems.set(item.id, item);
    // Live state is authoritative on the shared terminal_sessions.id/sessionId
    // namespace and therefore wins every collision with a roster row.
    for (const item of runItems) agentItems.set(item.id, item);
    const accountOwnerId = deps.getAccountOwnerId?.()?.trim() || null;
    const remoteRevisionById = new Map(
      (deps.store.listRemoteAttentionAcknowledgments?.(accountOwnerId) ?? [])
        .map((acknowledgment) => [acknowledgment.itemId, acknowledgment.sourceRevision]),
    );
    return [...agentItems.values(), ...prItems].map((item) => {
      const revision = Math.max(
        item.revision,
        lastPublishedRevisionById.get(item.id) ?? 0,
        remoteRevisionById.get(item.id) ?? 0,
      );
      return revision === item.revision ? item : { ...item, revision };
    });
  };

  const mergeMachineAcknowledgments = (items: AttentionItem[]): AttentionItem[] => {
    const accountOwnerId = deps.getAccountOwnerId?.()?.trim() || null;
    const remoteById = new Map(
      (deps.store.listRemoteAttentionAcknowledgments?.(accountOwnerId) ?? [])
        .map((acknowledgment) => [acknowledgment.itemId, acknowledgment]),
    );
    return items.map((item) => {
      const local = deps.store.getAttentionAcknowledgment?.(item.id, accountOwnerId);
      const remote = remoteById.get(item.id);
      let seenAt = item.seenAt;
      let dismissedAt = item.dismissedAt;
      if (
        local
        && local.accountOwnerId === accountOwnerId
        && local.sourceRevision >= item.revision
      ) {
        seenAt = local.seenAt;
        dismissedAt = local.dismissedAt;
      }
      // The relay is canonical for account acknowledgments. A revision-current
      // remote value replaces the local projection, including explicit nulls.
      if (
        remote
        && remote.accountOwnerId === accountOwnerId
        && remote.sourceRevision >= item.revision
      ) {
        seenAt = remote.seenAt;
        dismissedAt = remote.dismissedAt;
      }
      return withActivityFingerprints({
        ...item,
        seenAt,
        dismissedAt,
        ...(dismissedAt ? { activityTier: "ambient" as const } : {}),
      });
    });
  };

  const reconcileMachineAcknowledgments = async (
    currentItems: readonly AttentionItem[],
  ): Promise<void> => {
    if (typeof deps.relayClient.acknowledgeAttention !== "function") return;
    const currentById = new Map(currentItems.map((item) => [item.id, item]));
    const accountOwnerId = deps.getAccountOwnerId?.()?.trim() || null;
    const pending = (deps.store.listPendingAttentionAcknowledgments?.() ?? [])
      .filter((acknowledgment) => {
        const current = currentById.get(acknowledgment.itemId);
        return Boolean(
          current
          && acknowledgment.accountOwnerId === accountOwnerId,
        );
      });
    for (let offset = 0; offset < pending.length; offset += 64) {
      const batch = pending.slice(offset, offset + 64);
      // Preserve each timestamp pair exactly. Acknowledgments made at different
      // times cannot be collapsed into one relay mutation without lying about
      // when the user reviewed or dismissed the item.
      const groups = new Map<string, typeof batch>();
      for (const acknowledgment of batch) {
        const key = `${acknowledgment.seenAt}\u0000${acknowledgment.dismissedAt ?? ""}`;
        const group = groups.get(key) ?? [];
        group.push(acknowledgment);
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        if ((deps.getAccountOwnerId?.()?.trim() || null) !== accountOwnerId) {
          return;
        }
        try {
          const result = await deps.relayClient.acknowledgeAttention({
            itemIds: group.map((acknowledgment) => acknowledgment.itemId),
            sourceRevisions: Object.fromEntries(
              group.map((acknowledgment) => [
                acknowledgment.itemId,
                currentById.get(acknowledgment.itemId)!.revision,
              ]),
            ),
            seenAt: group[0]!.seenAt,
            ...(group[0]!.dismissedAt
              ? { dismissedAt: group[0]!.dismissedAt }
              : {}),
            expectedAccountOwnerId: accountOwnerId,
          });
          if (result) {
            const applied = new Set(result.applied);
            deps.store.markAttentionAcknowledgmentsSynced?.(
              group
                .filter((acknowledgment) => applied.has(acknowledgment.itemId))
                .map((acknowledgment) => ({
                  itemId: acknowledgment.itemId,
                  accountOwnerId: acknowledgment.accountOwnerId,
                  updatedAt: acknowledgment.updatedAt,
                })),
            );
          }
        } catch (error) {
          logWarn("attention.machine_ack_reconcile_failed", error);
        }
      }
    }
  };

  const enqueueAlert = (alert: PendingAlert): void => {
    pendingAlerts = pendingAlerts.filter((existing) => existing.dedupeKey !== alert.dedupeKey);
    pendingAlerts.push(alert);
  };

  const clearAlertDedupe = (dedupeKey: string): void => {
    lastAlertFingerprintByKey.delete(dedupeKey);
  };

  const scheduleFlush = (immediate: boolean, activityChanged = true): void => {
    if (disposed) return;
    if (activityChanged) scheduledFlushIncludesActivity = true;
    const delay = immediate ? promptFlushMs : flushDebounceMs;
    const fireAt = now() + delay;
    // Keep the earliest scheduled flush — a prompt (immediate) is never pushed
    // out by a later debounced event, and a burst still fires within `delay`.
    if (flushTimer && flushFireAt > 0 && flushFireAt <= fireAt) return;
    if (flushTimer) clearTimeout(flushTimer);
    flushFireAt = fireAt;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushFireAt = 0;
      const presenceOnly = !scheduledFlushIncludesActivity;
      scheduledFlushIncludesActivity = false;
      void runFlush(presenceOnly);
    }, delay);
  };

  const pruneRuns = (nowMs: number): void => {
    for (const [sessionId, run] of runs) {
      const age = nowMs - run.lastActiveAt;
      if (
        (run.phase === "running" || run.phase === "starting" || run.phase === "stale")
        && age > RUNNING_TTL_MS
      ) {
        runs.delete(sessionId);
      } else if (
        (run.phase === "waiting_for_approval" || run.phase === "waiting_for_input")
        && age > WAITING_TTL_MS
      ) {
        runs.delete(sessionId);
      } else if (isTerminalPhase(run.phase) && age > ATTENTION_RECENT_TTL_MS) {
        runs.delete(sessionId);
      }
    }
    for (const [sessionId, run] of recentRuns) {
      if (nowMs - run.lastActiveAt > ATTENTION_RECENT_TTL_MS) {
        recentRuns.delete(sessionId);
      }
    }
  };

  const prunePrActivities = (nowMs: number): void => {
    for (const [id, pr] of prActivities) {
      if (nowMs - pr.updatedAt > ATTENTION_RECENT_TTL_MS) {
        prActivities.delete(id);
      }
    }
  };

  const dropTerminalRuns = (): void => {
    for (const [sessionId, run] of runs) {
      if (!isTerminalPhase(run.phase)) continue;
      recentRuns.set(sessionId, { ...run });
      runs.delete(sessionId);
    }
  };

  const schedulePrActivityExpiry = (nowMs: number): void => {
    if (prExpiryTimer) {
      clearTimeout(prExpiryTimer);
      prExpiryTimer = null;
    }
    let nextExpiryMs = Number.POSITIVE_INFINITY;
    for (const pr of prActivities.values()) {
      const expiryMs = pr.updatedAt + PR_LIVE_ACTIVITY_TTL_MS;
      if (expiryMs > nowMs) nextExpiryMs = Math.min(nextExpiryMs, expiryMs);
    }
    if (!Number.isFinite(nextExpiryMs)) return;
    const delayMs = Math.max(250, nextExpiryMs - nowMs + 250);
    prExpiryTimer = setTimeout(() => {
      prExpiryTimer = null;
      scheduleFlush(true);
    }, delayMs);
  };

  const resolveMissingMeta = async (): Promise<void> => {
    for (const run of runs.values()) {
      if (run.metaResolved) continue;
      // Resolve against the scope that produced the run — each project has its
      // own chat service and lane-name resolver.
      const scope = scopes.get(run.scopeKey);
      if (run.kind === "cli") {
        const record = scope?.resolveCliSession?.(run.sessionId) ?? null;
        // Unknown session or a chat-attached shell: the chat run (or nothing)
        // represents this work — a duplicate CLI row would double-count it.
        if (!record || record.chatSessionId) {
          runs.delete(run.sessionId);
          continue;
        }
        const atRest = record.status !== "running" || record.runtimeState === "idle";
        if (
          atRest
          && (
            record.settleOverride === "settled"
            || (record.settleOverride !== "active" && record.settledAt)
          )
        ) {
          setRunPhase(run, "completed");
          recentRuns.set(run.sessionId, { ...run });
          runs.delete(run.sessionId);
          continue;
        }
        run.title = record.title?.trim() || run.title || null;
        run.agent = providerDisplayName(record.toolType) ?? run.agent ?? "CLI";
        run.metaResolved = true;
        continue;
      }
      const chat = scope?.agentChatService;
      if (!chat) continue;
      try {
        const summary = await chat.getSessionSummary(run.sessionId);
        if (summary) {
          // Identity/CTO sessions are not user-facing agent runs — drop them.
          if (summary.identityKey) {
            runs.delete(run.sessionId);
            continue;
          }
          run.title = summary.title?.trim() || run.title || null;
          run.model = summary.model ?? run.model ?? null;
          run.agent = providerDisplayName(summary.provider) ?? run.agent;
          const laneName = scope?.resolveLaneName?.(summary.laneId);
          run.lane = laneName ?? run.lane ?? (summary.laneId || null);
        }
        run.metaResolved = true;
      } catch {
        // Leave unresolved; retried on the next flush.
      }
    }
  };

  const planLiveActivity = (
    deviceIds: string[],
    nowMs: number,
  ): {
    items: PushRelayLiveActivityItem[];
    commit: (landedDeviceIds?: ReadonlySet<string>) => void;
  } | null => {
    if (deviceIds.length === 0) return null;
    prunePrActivities(nowMs);
    schedulePrActivityExpiry(nowMs);
    const recentPrActivities = [...prActivities.values()]
      .filter((pr) => nowMs - pr.updatedAt <= PR_LIVE_ACTIVITY_TTL_MS);
    if (recentPrActivities.length > 0) dropTerminalRuns();
    const allRuns = [...runs.values()];
    const allPrActivities = recentPrActivities;
    const contentState = buildAgentRunsContentState(allRuns, nowMs, allPrActivities);
    const activeCount = contentState.activeCount;
    const prActivityCount = allPrActivities.length;
    // Stale rows (quiet CLIs) don't count as active but must not END the
    // activity either — a 12s-quiet CLI that resumes output would otherwise
    // churn end→push-to-start cycles. Only an all-completed/failed (or empty)
    // roster ends the aggregate.
    const dormantCount = allRuns.filter((run) => run.phase === "stale").length;

    const fingerprint = JSON.stringify({ ...contentState, updatedAt: 0 });
    const hasLiveContent = activeCount > 0 || prActivityCount > 0;
    const shouldEnd = !hasLiveContent && dormantCount === 0;
    const deviceIdsByEvent: Record<"start" | "update" | "end", string[]> = {
      start: [],
      update: [],
      end: [],
    };
    for (const deviceId of deviceIds) {
      const deliveredFingerprint = liveActivityFingerprintByDevice.get(deviceId);
      if (hasLiveContent) {
        if (deliveredFingerprint == null) deviceIdsByEvent.start.push(deviceId);
        else if (deliveredFingerprint !== fingerprint) deviceIdsByEvent.update.push(deviceId);
      } else if (shouldEnd) {
        if (deliveredFingerprint != null) deviceIdsByEvent.end.push(deviceId);
      } else if (deliveredFingerprint != null && deliveredFingerprint !== fingerprint) {
        // A quiet CLI is stale, not terminal. Existing activities receive the
        // stale row, but a newly registered phone must not start stale-only UI.
        deviceIdsByEvent.update.push(deviceId);
      }
    }
    if (
      deviceIdsByEvent.start.length === 0
      && deviceIdsByEvent.update.length === 0
      && deviceIdsByEvent.end.length === 0
    ) return null;

    const anyWaiting = allRuns.some(
      (run) => run.phase === "waiting_for_approval" || run.phase === "waiting_for_input",
    ) || allPrActivities.some((pr) =>
      pr.phase === "checks_failing"
      || pr.phase === "changes_requested"
      || pr.phase === "review_requested"
      || pr.phase === "merge_ready");
    const phase: "running" | "waiting" | "terminal" = anyWaiting
      ? "waiting"
      : (activeCount > 0 || prActivityCount > 0)
        ? "running"
        : "terminal";

    const mostRecent = allRuns.sort((left, right) => right.lastActiveAt - left.lastActiveAt)[0];
    const mostRecentPr = allPrActivities.sort((left, right) => right.updatedAt - left.updatedAt)[0];
    const startAlert = {
      title: activeCount > 0
        // "is working" matches the attention-item title built above and the
        // shared `running` label in sessionStatusPresentation.ts.
        ? (activeCount === 1 && mostRecent ? `${runSubject(mostRecent)} is working` : `${activeCount} agent runs active`)
        : (prActivityCount === 1 && mostRecentPr ? `PR #${mostRecentPr.prNumber} updated` : `${prActivityCount} pull requests updated`),
      body: activeCount > 0 ? (mostRecent ? laneTitleLine(mostRecent) : null) : mostRecentPr?.title ?? null,
    };
    const items = (["start", "update", "end"] as const)
      .filter((event) => deviceIdsByEvent[event].length > 0)
      .map((event): PushRelayLiveActivityItem => ({
        deviceIds: deviceIdsByEvent[event],
        event,
        activityId: AGENT_RUNS_ACTIVITY_ID,
        contentState,
        dedupeKey: AGENT_RUNS_DEDUPE_KEY,
        phase,
        ...(event === "start"
          ? {
            attributesType: AGENT_RUNS_ATTRIBUTES_TYPE,
            attributes: { machineName: deps.machineName },
            alert: startAlert,
          }
          : {}),
        ...(event === "end"
          ? { dismissalDate: Math.floor(nowMs / 1000) + 300 }
          : {}),
      }));
    const plannedEpochByDevice = new Map(
      deviceIds.map((deviceId) => [
        deviceId,
        liveActivityEpochByDevice.get(deviceId) ?? 0,
      ]),
    );
    const commit = (landedDeviceIds?: ReadonlySet<string>): void => {
      const landed = landedDeviceIds ?? new Set(
        items.flatMap((item) => item.deviceIds ?? []),
      );
      for (const item of items) {
        for (const deviceId of item.deviceIds ?? []) {
          if (
            !landed.has(deviceId)
            || (liveActivityEpochByDevice.get(deviceId) ?? 0) !== plannedEpochByDevice.get(deviceId)
          ) {
            continue;
          }
          if (item.event === "end") {
            liveActivityFingerprintByDevice.delete(deviceId);
          } else {
            liveActivityFingerprintByDevice.set(deviceId, fingerprint);
          }
        }
      }
      if (shouldEnd && liveActivityFingerprintByDevice.size === 0) {
        dropTerminalRuns();
      }
    };

    return { items, commit };
  };

  type ActivityPublishResponse = {
    protocol: number;
    result: ActivityPublishResult;
    capShrunk: boolean;
  };

  const recordActivityPublishResponse = (
    result: ActivityPublishResult,
    nowMs: number,
    allowCapShrink = true,
  ): ActivityPublishResponse => {
    const protocol = Number.isSafeInteger(result.protocol) && Number(result.protocol) >= 2
      ? Number(result.protocol)
      : 1;
    if (activityProtocol !== protocol) {
      activityProtocol = protocol;
      deps.store.setActivityProtocol?.(protocol);
    }
    const accountOwnerId = deps.getAccountOwnerId?.()?.trim() || null;
    const acknowledgments = result.acks ?? [];
    if (acknowledgments.length > 0) {
      deps.store.recordRemoteAttentionAcknowledgments?.({
        accountOwnerId,
        acknowledgments,
        updatedAt: new Date(nowMs).toISOString(),
      });
    }
    const previousCap = activityRosterCap;
    if (allowCapShrink && protocol >= 2 && result.itemsTruncated === true) {
      activityRosterCap = Math.max(
        ACTIVITY_ROSTER_MIN_ITEMS_PER_MACHINE,
        Math.floor(activityRosterCap * 0.9),
      );
      reconcilePending = true;
    }
    lastAttentionPublishedAt = nowMs;
    return {
      protocol,
      result,
      capShrunk: activityRosterCap < previousCap,
    };
  };

  const selectActivityRoster = (items: AttentionItem[]): {
    selected: AttentionItem[];
    overflow: AttentionItem[];
  } => {
    const ordered = sortAttentionItems(items);
    const foreground = ordered.filter((item) => item.activityTier !== "idle");
    const idle = ordered
      .filter((item) => item.activityTier === "idle")
      .sort((left, right) => {
        const time = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
        return Number.isFinite(time) && time !== 0 ? time : left.id.localeCompare(right.id);
      });
    const all = [...foreground, ...idle];
    return {
      selected: all.slice(0, activityRosterCap),
      overflow: all.slice(activityRosterCap),
    };
  };

  const activityTombstone = (
    id: string,
    sourceRevision: number,
    nowMs: number,
  ): AttentionTombstone => ({
    id,
    revision: Math.max(nowMs, sourceRevision + 1),
    deletedAt: new Date(nowMs).toISOString(),
  });

  const publishLegacyAttention = async (
    nowMs: number,
    force: boolean,
  ): Promise<"published" | "unchanged" | "unavailable" | "protocol2"> => {
    const items = mergeMachineAcknowledgments(
      sortAttentionItems(await buildAttentionItems(nowMs, false))
        .slice(0, LEGACY_ATTENTION_PUBLISH_MAX_ITEMS),
    );
    const fingerprint = JSON.stringify(
      items.map((item) => [item.id, activityPublishFingerprint(item)]),
    );
    if (
      !force
      && fingerprint === lastLegacyAttentionFingerprint
      && nowMs - lastAttentionPublishedAt < ATTENTION_HEARTBEAT_MS
    ) {
      await reconcileMachineAcknowledgments(items);
      return "unchanged";
    }
    const result = await deps.relayClient.publishAttention?.({
      machineName: deps.machineName,
      fullSnapshot: true,
      items,
    });
    if (!result) return "unavailable";
    const response = recordActivityPublishResponse(result, nowMs, false);
    for (const item of items) {
      lastPublishedRevisionById.set(item.id, item.revision);
    }
    persistLastPublishedRevisions();
    lastLegacyAttentionFingerprint = fingerprint;
    await reconcileMachineAcknowledgments(items);
    if (response.protocol >= 2) {
      reconcilePending = true;
      return "protocol2";
    }
    reconcilePending = false;
    return result.unchanged === true || result.suppressed === true
      ? "unchanged"
      : "published";
  };

  const publishProtocol2Reconcile = async (
    nowMs: number,
    items: AttentionItem[],
    overflow: AttentionItem[],
  ): Promise<"published" | "unchanged" | "unavailable" | "legacy"> => {
    rosterEpoch = deps.store.nextActivityRosterEpoch?.() ?? rosterEpoch + 1;
    const tombstones = overflow.map((item) =>
      activityTombstone(item.id, item.revision, nowMs));
    const itemPages: AttentionItem[][] = [];
    const tombstonePages: AttentionTombstone[][] = [];
    for (let offset = 0; offset < items.length; offset += ACTIVITY_PUBLISH_PAGE_ITEMS) {
      itemPages.push(items.slice(offset, offset + ACTIVITY_PUBLISH_PAGE_ITEMS));
    }
    for (let offset = 0; offset < tombstones.length; offset += ACTIVITY_PUBLISH_PAGE_ITEMS) {
      tombstonePages.push(tombstones.slice(offset, offset + ACTIVITY_PUBLISH_PAGE_ITEMS));
    }
    const pageCount = Math.max(1, itemPages.length, tombstonePages.length);
    let capShrunk = false;
    let unchanged = true;
    for (let page = 0; page < pageCount; page += 1) {
      const result = await deps.relayClient.publishAttention!({
        machineName: deps.machineName,
        mode: "reconcile",
        rosterEpoch,
        page,
        final: page === pageCount - 1,
        items: itemPages[page] ?? [],
        tombstones: tombstonePages[page] ?? [],
      });
      if (!result) return "unavailable";
      const response = recordActivityPublishResponse(result, nowMs, page === 0);
      if (response.protocol < 2) return "legacy";
      for (const item of itemPages[page] ?? []) {
        lastPublishedRevisionById.set(item.id, item.revision);
      }
      persistLastPublishedRevisions();
      capShrunk = capShrunk || response.capShrunk;
      unchanged = unchanged && (result.unchanged === true || result.suppressed === true);
    }
    lastPublishedFingerprintById.clear();
    lastPublishedRevisionById.clear();
    lastOverflowRevisionById.clear();
    for (const item of items) {
      lastPublishedFingerprintById.set(item.id, activityPublishFingerprint(item));
      lastPublishedRevisionById.set(item.id, item.revision);
    }
    for (const item of overflow) {
      lastOverflowRevisionById.set(item.id, item.revision);
    }
    persistLastPublishedRevisions();
    lastReconcileAt = nowMs;
    reconcilePending = capShrunk;
    await reconcileMachineAcknowledgments(items);
    return unchanged ? "unchanged" : "published";
  };

  const publishProtocol2Delta = async (
    nowMs: number,
    items: AttentionItem[],
    overflow: AttentionItem[],
    presenceOnly: boolean,
  ): Promise<"published" | "unchanged" | "unavailable" | "legacy"> => {
    const selectedIds = new Set(items.map((item) => item.id));
    const overflowById = new Map(overflow.map((item) => [item.id, item]));
    const changed = items.filter((item) =>
      lastPublishedFingerprintById.get(item.id) !== activityPublishFingerprint(item));
    const droppedTombstones = [...lastPublishedFingerprintById.keys()]
      .filter((id) => !selectedIds.has(id))
      .map((id) => activityTombstone(
        id,
        lastPublishedRevisionById.get(id) ?? 0,
        nowMs,
      ));
    const overflowTombstones = overflow
      .filter((item) => lastOverflowRevisionById.get(item.id) !== item.revision)
      .map((item) => activityTombstone(
        item.id,
        Math.max(item.revision, lastPublishedRevisionById.get(item.id) ?? 0),
        nowMs,
      ));
    const tombstones = [...new Map(
      [...droppedTombstones, ...overflowTombstones]
        .map((tombstone) => [tombstone.id, tombstone]),
    ).values()];
    if (changed.length === 0 && tombstones.length === 0) {
      if (!presenceOnly && nowMs - lastAttentionPublishedAt < ATTENTION_HEARTBEAT_MS) {
        await reconcileMachineAcknowledgments(items);
        return "unchanged";
      }
      const result = await deps.relayClient.publishAttention!({
        machineName: deps.machineName,
        mode: "presence",
        rosterEpoch,
        items: [],
        tombstones: [],
      });
      if (!result) return "unavailable";
      const response = recordActivityPublishResponse(result, nowMs);
      return response.protocol >= 2 ? "unchanged" : "legacy";
    }

    // A normal delta is bounded by the machine cap, but a burst can still
    // exceed one wire page. Page explicit deltas too; unlike reconcile, no
    // page/final fields are needed because every page is independently safe.
    const pageCount = Math.max(
      Math.ceil(changed.length / ACTIVITY_PUBLISH_PAGE_ITEMS),
      Math.ceil(tombstones.length / ACTIVITY_PUBLISH_PAGE_ITEMS),
    );
    let unchanged = true;
    for (let page = 0; page < pageCount; page += 1) {
      const pageItems = changed.slice(
        page * ACTIVITY_PUBLISH_PAGE_ITEMS,
        (page + 1) * ACTIVITY_PUBLISH_PAGE_ITEMS,
      );
      const pageTombstones = tombstones.slice(
        page * ACTIVITY_PUBLISH_PAGE_ITEMS,
        (page + 1) * ACTIVITY_PUBLISH_PAGE_ITEMS,
      );
      const result = await deps.relayClient.publishAttention!({
        machineName: deps.machineName,
        mode: "delta",
        rosterEpoch,
        items: pageItems,
        tombstones: pageTombstones,
      });
      if (!result) return "unavailable";
      const response = recordActivityPublishResponse(result, nowMs, page === 0);
      if (response.protocol < 2) return "legacy";
      unchanged = unchanged && (result.unchanged === true || result.suppressed === true);
      for (const item of pageItems) {
        lastPublishedFingerprintById.set(item.id, activityPublishFingerprint(item));
        lastPublishedRevisionById.set(item.id, item.revision);
        lastOverflowRevisionById.delete(item.id);
      }
      for (const tombstone of pageTombstones) {
        lastPublishedFingerprintById.delete(tombstone.id);
        lastPublishedRevisionById.delete(tombstone.id);
        const overflowItem = overflowById.get(tombstone.id);
        if (overflowItem) lastOverflowRevisionById.set(tombstone.id, overflowItem.revision);
        else lastOverflowRevisionById.delete(tombstone.id);
      }
      persistLastPublishedRevisions();
    }
    await reconcileMachineAcknowledgments(items);
    return unchanged ? "unchanged" : "published";
  };

  const publishActivity = async (
    nowMs: number,
    presenceOnly: boolean,
  ): Promise<"published" | "unchanged" | "unavailable"> => {
    if (typeof deps.relayClient.publishAttention !== "function") return "unavailable";
    const accountOwnerId = deps.getAccountOwnerId?.()?.trim() || null;
    if (!accountOwnerId) return "unavailable";
    if (lastActivityAccountOwnerId !== accountOwnerId) {
      lastPublishedFingerprintById.clear();
      lastPublishedRevisionById.clear();
      lastOverflowRevisionById.clear();
      lastActivityAccountOwnerId = accountOwnerId;
      persistLastPublishedRevisions();
      reconcilePending = true;
    }
    if (lastReconcileAt > 0 && nowMs - lastReconcileAt >= ACTIVITY_RECONCILE_INTERVAL_MS) {
      reconcilePending = true;
    }

    try {
      if (activityProtocol == null || activityProtocol < 2) {
        const legacy = await publishLegacyAttention(nowMs, activityProtocol == null || reconcilePending);
        if (legacy !== "protocol2") return legacy;
      }

      // A pure presence heartbeat must never touch the all-project disk roster.
      if (presenceOnly && !reconcilePending) {
        const result = await deps.relayClient.publishAttention({
          machineName: deps.machineName,
          mode: "presence",
          rosterEpoch,
          items: [],
          tombstones: [],
        });
        if (!result) return "unavailable";
        const response = recordActivityPublishResponse(result, nowMs);
        if (response.protocol >= 2) return "unchanged";
        return await publishLegacyAttention(nowMs, true) === "published"
          ? "published"
          : "unchanged";
      }

      const built = mergeMachineAcknowledgments(await buildAttentionItems(nowMs, true));
      const { selected, overflow } = selectActivityRoster(built);
      const protocolResult = reconcilePending
        ? await publishProtocol2Reconcile(nowMs, selected, overflow)
        : await publishProtocol2Delta(nowMs, selected, overflow, presenceOnly);
      if (protocolResult === "unavailable") {
        reconcilePending = true;
        return "unavailable";
      }
      if (protocolResult !== "legacy") return protocolResult;
      lastPublishedFingerprintById.clear();
      lastPublishedRevisionById.clear();
      lastOverflowRevisionById.clear();
      persistLastPublishedRevisions();
      reconcilePending = true;
      return await publishLegacyAttention(nowMs, true) === "published"
        ? "published"
        : "unchanged";
    } catch (error) {
      reconcilePending = true;
      if (
        error instanceof PushRelayRequestError
        && error.status >= 400
        && error.status < 500
      ) {
        activityProtocol = null;
        deps.store.setActivityProtocol?.(null);
      }
      logWarn("attention.publish_failed", error);
      scheduleRetry();
      return "unavailable";
    }
  };

  const flush = async (presenceOnly = false): Promise<void> => {
    const nowMs = now();
    pruneRuns(nowMs);
    prunePrActivities(nowMs);
    await resolveMissingMeta();
    const attentionPublishResult = await publishActivity(nowMs, presenceOnly);
    const accountAttentionPublished = attentionPublishResult === "published";
    const accountAttentionAvailable = attentionPublishResult !== "unavailable";
    if (isGated()) {
      pendingAlerts = [];
      return;
    }

    const devices = deps.store.listDevices();
    const consumedAlerts = pendingAlerts;
    pendingAlerts = [];

    const badgeCount = countAwaitingAttentionRuns([...runs.values()]);

    const alertItems: PushRelayAlertItem[] = [];
    const alertAttempts: AlertDeliveryAttempt[] = [];
    for (const alert of accountAttentionPublished ? [] : consumedAlerts) {
      const retryTargets = alert.targetDeviceIds ? new Set(alert.targetDeviceIds) : null;
      const eligibleDevices = devices.filter(
        (device) =>
          Boolean(device.apnsToken)
          && (!retryTargets || retryTargets.has(device.deviceId))
          && shouldDeliverAlertForPrefs(device.prefs, alert.sessionId, nowMs),
      );
      if (eligibleDevices.length === 0) continue;
      const copy = alert.render();
      // itemId is part of the fingerprint: a new approval with identical
      // rendered copy must still publish, or the phone's Approve/Deny action
      // keeps targeting the previous (already-resolved) item.
      const fingerprint = JSON.stringify({
        title: copy.title,
        body: copy.body,
        deepLink: alert.deepLink ?? null,
        phase: alert.phase,
        itemId: alert.itemId ?? null,
        category: alert.category ?? null,
        salt: alert.fingerprintSalt ?? null,
      });
      for (const device of eligibleDevices) {
        if (lastAlertFingerprintByKey.get(alert.dedupeKey)?.get(device.deviceId) === fingerprint) {
          continue;
        }
        alertItems.push({
          deviceIds: [device.deviceId],
          title: copy.title,
          body: copy.body,
          deepLink: alert.deepLink ?? null,
          threadId: alert.threadId ?? null,
          dedupeKey: deviceScopedAlertDedupeKey(alert.dedupeKey, device.deviceId),
          phase: alert.phase,
          interruptionLevel: alert.interruptionLevel ?? null,
          sessionId: alert.sessionId ?? null,
          itemId: alert.itemId ?? null,
          category: alert.category ?? null,
          badge: badgeCount,
        });
        alertAttempts.push({
          alert,
          deviceId: device.deviceId,
          fingerprint,
        });
      }
    }

    // The badge must also track *drops* (an approval answered on the Mac), which
    // produce no alert — and devices whose alert was muted still need the new
    // count. A silent badge-only item targets every alert-enabled device NOT
    // already covered by an alert in this flush; the relay's content-hash
    // suppression absorbs unchanged resends. Quiet hours block it too — the
    // setting promises "no pushes on a schedule", and a stale badge self-heals
    // on the next foreground (which clears it) or the first post-window flush.
    const alertCoveredDeviceIds = new Set(alertItems.flatMap((item) => item.deviceIds ?? []));
    const badgeSyncDeviceIds = devices
      .filter((device) =>
        Boolean(device.apnsToken)
        && device.prefs.enabled
        && !isWithinQuietHours(device.prefs.quietHours, nowMs)
        && !alertCoveredDeviceIds.has(device.deviceId)
        && lastSentBadgeByDevice.get(device.deviceId) !== badgeCount)
      .map((device) => device.deviceId);
    if (badgeSyncDeviceIds.length > 0) {
      // No relay dedupeKey here: the relay's suppression hash ignores
      // deviceIds, so a shared key would suppress the same count for a device
      // that never received it (fresh registration, quiet hours just ended).
      // The per-device map above is the only dedupe this item needs.
      for (const deviceId of badgeSyncDeviceIds) {
        alertItems.push({
          deviceIds: [deviceId],
          title: "",
          sound: null,
          phase: "terminal",
          badge: badgeCount,
        });
        alertAttempts.push({ alert: null, deviceId, fingerprint: null });
      }
    }

    const liveActivityDeviceIds = devices
      .filter((device) => Boolean(device.pushToStartToken) && shouldDeliverLiveActivityForPrefs(device.prefs))
      .map((device) => device.deviceId);
    // Once account Attention has accepted this machine's snapshot, it owns the
    // Live Activity even when this flush is unchanged or relay-suppressed.
    // Queued alerts still fall back above unless the account publish actually
    // emitted the changed snapshot.
    const laPlan = accountAttentionAvailable
      ? null
      : planLiveActivity(liveActivityDeviceIds, nowMs);

    if (alertItems.length === 0 && !laPlan) return;

    const payload: { notifications?: PushRelayAlertItem[]; liveActivity?: PushRelayLiveActivityItem[] } = {};
    if (alertItems.length > 0) payload.notifications = alertItems;
    if (laPlan) payload.liveActivity = laPlan.items;

    try {
      const result = await deps.relayClient.publish(payload);
      // The relay answers HTTP 200 even when every APNs send failed — it reports
      // per-target `delivered`/`failed` counts in the body. An all-failed publish
      // (nothing delivered, at least one hard failure) is transient, so re-queue
      // and retry instead of committing dedupe/Live-Activity state, which would
      // drop the content and locally suppress the identical resend.
      const delivered = readOutcomeCount(result, "delivered");
      const suppressed = readOutcomeCount(result, "suppressed");
      const failed = readOutcomeCount(result, "failed");
      const alertOutcomes = readAlertOutcomes(result);
      if (alertOutcomes == null && delivered === 0 && suppressed === 0 && failed > 0) {
        pendingAlerts = [...consumedAlerts, ...pendingAlerts];
        deps.store.recordPublishResult({ at: new Date().toISOString(), error: `relay delivered 0 of ${failed} targets` });
        logWarn("push.publish_undelivered", new Error(`0 of ${failed} targets delivered`));
        scheduleRetry();
        return;
      }
      const alertVerdicts = alertOutcomes == null
        ? null
        : alertAttempts.map((attempt, index) => {
          const outcome = alertOutcomes[index];
          return outcome?.deviceId === attempt.deviceId ? outcome : null;
        });
      const failedAlertCount = alertVerdicts?.filter(
        (outcome) => !outcome?.delivered && !outcome?.suppressed,
      ).length ?? 0;
      if (failedAlertCount > 0) {
        // Retain only failed phone targets. Each successful/suppressed
        // alert-device pair commits independently below, and its phone-scoped
        // relay key cannot suppress the failed phone's retry.
        const retryByKey = new Map<string, { alert: PendingAlert; deviceIds: string[] }>();
        for (const [index, outcome] of alertVerdicts?.entries() ?? []) {
          const attempt = alertAttempts[index];
          if (outcome?.delivered || outcome?.suppressed || !attempt.alert) continue;
          const existing = retryByKey.get(attempt.alert.dedupeKey);
          if (existing) existing.deviceIds.push(attempt.deviceId);
          else retryByKey.set(attempt.alert.dedupeKey, {
            alert: attempt.alert,
            deviceIds: [attempt.deviceId],
          });
        }
        const newerPendingKeys = new Set(pendingAlerts.map((alert) => alert.dedupeKey));
        const retryAlerts = [...retryByKey.values()]
          .filter(({ alert }) => !newerPendingKeys.has(alert.dedupeKey))
          .map(({ alert, deviceIds }) => ({ ...alert, targetDeviceIds: deviceIds }));
        pendingAlerts = [...retryAlerts, ...pendingAlerts];
        logWarn(
          "push.publish_undelivered",
          new Error(`${failedAlertCount} alert target${failedAlertCount === 1 ? "" : "s"} failed`),
        );
        scheduleRetry();
      }
      for (const [index, attempt] of alertAttempts.entries()) {
        const outcome = alertVerdicts?.[index];
        if (
          attempt.alert
          && attempt.fingerprint
          && (alertVerdicts == null || outcome?.delivered || outcome?.suppressed)
        ) {
          const byDevice = lastAlertFingerprintByKey.get(attempt.alert.dedupeKey) ?? new Map<string, string>();
          byDevice.set(attempt.deviceId, attempt.fingerprint);
          lastAlertFingerprintByKey.set(attempt.alert.dedupeKey, byDevice);
        }
      }
      // Every alert item (including the badge-only sync) carries this flush's
      // badge count. Commit it per device from the relay's outcomes: a device
      // whose send failed transiently must stay unsynced so the next flush
      // retries its badge. Suppressed counts as synced (identical content was
      // already delivered); a legacy/mock response without outcomes commits
      // all targeted devices, mirroring the Live Activity commit rule.
      for (const [index, attempt] of alertAttempts.entries()) {
        const outcome = alertVerdicts?.[index];
        if (alertVerdicts == null || outcome?.delivered || outcome?.suppressed) {
          lastSentBadgeByDevice.set(attempt.deviceId, badgeCount);
        }
      }
      let hardLiveActivityFailureCount = 0;
      if (laPlan) {
        // Commit each phone only if its own Live Activity target landed. A
        // mixed publish can report delivered>0 from alerts or other phones;
        // those successes must not advance a failed target's fingerprint.
        const laOutcomes = readLiveActivityOutcomes(result);
        // ZERO liveactivity outcomes in a real outcomes array means the relay
        // had no APNs target (e.g. an update/end before the phone reported its
        // per-activity token) — nothing landed, so committing would dedupe the
        // new state and strand the Lock Screen on stale content. A missing
        // outcomes array (legacy relay / tests) keeps the commit.
        const landedDeviceIds = laOutcomes == null
          ? null
          : new Set(
            laOutcomes
              .filter((outcome) => outcome.delivered || outcome.suppressed)
              .map((outcome) => outcome.deviceId),
          );
        const landed = landedDeviceIds == null || landedDeviceIds.size > 0;
        hardLiveActivityFailureCount = laOutcomes?.filter(
          (outcome) => !outcome.delivered && !outcome.suppressed && !outcome.skipped,
        ).length ?? 0;
        if (landed) {
          laPlan.commit(landedDeviceIds ?? undefined);
        }
        if (hardLiveActivityFailureCount > 0) {
          // Hard failure (not merely a missing push-to-start token) — retry the
          // affected devices. Per-device fingerprints keep successful phones
          // committed while failed start/update/end targets remain eligible.
          // An all-skipped or target-less LA is left for the next event-driven
          // flush (token arrival pokes one).
          scheduleRetry();
          logWarn(
            "push.publish_undelivered",
            new Error(
              `${hardLiveActivityFailureCount} Live Activity target${hardLiveActivityFailureCount === 1 ? "" : "s"} failed`,
            ),
          );
        }
      }
      const failureMessages = [
        ...(failedAlertCount > 0
          ? [`relay failed ${failedAlertCount} alert target${failedAlertCount === 1 ? "" : "s"}`]
          : []),
        ...(hardLiveActivityFailureCount > 0
          ? [`relay failed ${hardLiveActivityFailureCount} Live Activity target${hardLiveActivityFailureCount === 1 ? "" : "s"}`]
          : []),
      ];
      if (failureMessages.length === 0) {
        deps.store.recordPublishResult({ at: new Date().toISOString() });
      } else {
        deps.store.recordPublishResult({
          at: new Date().toISOString(),
          error: failureMessages.join("; "),
        });
      }
    } catch (error) {
      // Re-queue the alerts we attempted so a transient relay failure retries;
      // the relay's dedupeKey suppression makes a resend idempotent.
      pendingAlerts = [...consumedAlerts, ...pendingAlerts];
      deps.store.recordPublishResult({ at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
      logWarn("push.publish_failed", error);
      scheduleRetry();
    }
  };

  const scheduleRetry = (): void => {
    // With no attached scope there is no active work loop to retry. The final
    // detach snapshot is deliberately one-shot/nonblocking; a later attach or
    // heartbeat will naturally reconcile if that best-effort publish failed.
    if (disposed || scopes.size === 0) return;
    const fireAt = now() + PUBLISH_RETRY_MS;
    if (flushTimer && flushFireAt > 0 && flushFireAt <= fireAt) return;
    if (flushTimer) clearTimeout(flushTimer);
    flushFireAt = fireAt;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushFireAt = 0;
      void runFlush(false);
    }, PUBLISH_RETRY_MS);
  };

  const runFlush = async (presenceOnly = false): Promise<void> => {
    if (disposed) return;
    if (flushing) {
      if (scopes.size > 0) scheduleFlush(false, !presenceOnly);
      return;
    }
    flushing = true;
    try {
      await flush(presenceOnly);
    } catch (error) {
      logWarn("push.flush_failed", error);
    } finally {
      flushing = false;
      if (finalAttentionSnapshotPending) scheduleFinalAttentionSnapshot();
    }
  };

  const scheduleFinalAttentionSnapshot = (): void => {
    if (disposed || !finalAttentionSnapshotPending || finalAttentionSnapshotQueued) return;
    finalAttentionSnapshotQueued = true;
    queueMicrotask(() => {
      finalAttentionSnapshotQueued = false;
      if (disposed || !finalAttentionSnapshotPending) return;
      // An in-flight flush observes the already-pruned aggregate. Let it
      // complete, then the finally block above schedules this final pass only
      // if another authoritative snapshot is still needed.
      if (flushing) return;
      finalAttentionSnapshotPending = false;
      void runFlush(false);
    });
  };

  const onChatEvent = (scopeKey: string, envelope: AgentChatEventEnvelope): void => {
    const sessionId = envelope.sessionId;
    if (!sessionId) return;
    const event = envelope.event;
    let immediate = false;

    if (event.type === "done" && event.status !== "failed") {
      // Completion of a session that we may never have tracked (no prior event).
      const run = runs.get(sessionId);
      if (!run) return;
    }

    const run = ensureRun(sessionId, scopeKey);
    markRunUpdated(run);

    switch (event.type) {
      case "approval_request": {
        setRunPhase(run, "waiting_for_approval");
        run.detail = event.description ?? run.detail;
        run.itemId = event.itemId || null;
        enqueueAlert({
          sessionId,
          dedupeKey: `alert:${sessionId}:approval`,
          render: () => ({ title: `${runSubject(run)} needs you`, body: laneTitleLine(run) }),
          deepLink: `ade://session/${sessionId}`,
          threadId: sessionId,
          phase: "waiting",
          interruptionLevel: "time-sensitive",
          itemId: event.itemId || null,
          category: APPROVAL_NOTIFICATION_CATEGORY,
        });
        immediate = true;
        break;
      }
      case "structured_question": {
        setRunPhase(run, "waiting_for_input");
        run.detail = event.question ?? run.detail;
        enqueueAlert({
          sessionId,
          dedupeKey: `alert:${sessionId}:question`,
          render: () => ({ title: `${runSubject(run)} needs you`, body: laneTitleLine(run) }),
          deepLink: `ade://session/${sessionId}`,
          threadId: sessionId,
          phase: "waiting",
          interruptionLevel: "time-sensitive",
        });
        immediate = true;
        break;
      }
      case "pending_input_resolved": {
        if (run.phase === "waiting_for_approval" || run.phase === "waiting_for_input") {
          setRunPhase(run, "running");
        }
        run.itemId = null;
        // Allow a later prompt in the same session to alert again.
        clearAlertDedupe(`alert:${sessionId}:approval`);
        clearAlertDedupe(`alert:${sessionId}:question`);
        break;
      }
      case "status": {
        if (event.turnStatus !== "started") run.itemId = null;
        if (event.turnStatus === "started") {
          if (isTerminalPhase(run.phase)) setRunPhase(run, "running");
        } else if (event.turnStatus === "failed") {
          setRunPhase(run, "failed");
          enqueueFailedAlert(run);
        } else if (event.turnStatus === "completed" || event.turnStatus === "interrupted") {
          setRunPhase(run, "completed");
        }
        break;
      }
      case "done": {
        if (event.status === "failed") {
          setRunPhase(run, "failed");
          if (!run.model && event.model) run.model = event.model;
          enqueueFailedAlert(run);
        } else {
          setRunPhase(run, "completed");
        }
        break;
      }
      default: {
        if (!isTerminalPhase(run.phase) && run.phase === "starting") {
          setRunPhase(run, "running");
        }
        break;
      }
    }
    if (isTerminalPhase(run.phase)) {
      recentRuns.set(sessionId, { ...run });
    }

    scheduleFlush(immediate);
  };

  const enqueueFailedAlert = (run: AgentRunState): void => {
    enqueueAlert({
      sessionId: run.sessionId,
      dedupeKey: `alert:${run.sessionId}:failed`,
      // Body deliberately omits error text (redacted like the lock screen).
      render: () => ({ title: `${runSubject(run)} run failed`, body: laneTitleLine(run) }),
      deepLink: `ade://session/${run.sessionId}`,
      threadId: run.sessionId,
      phase: "terminal",
      interruptionLevel: "active",
    });
  };

  /**
   * Terminal runtime state for tracked CLI sessions. Prompt/marker inference
   * must never raise attention: only an explicit `ade chat ask` or a
   * provider-structured pending input may publish `waiting_for_input`.
   */
  const onCliRuntimeSignal = (scopeKey: string, signal: PushCliRuntimeSignal): void => {
    if (disposed || !signal.sessionId) return;
    const existing = runs.get(signal.sessionId);
    const session = scopes.get(scopeKey)?.resolveCliSession?.(signal.sessionId) ?? null;
    const atRest = session?.status !== "running" || signal.runtimeState === "idle";
    if (
      atRest
      && (
        session?.settleOverride === "settled"
        || (session?.settleOverride !== "active" && Boolean(session?.settledAt))
      )
    ) {
      if (existing) {
        existing.itemId = null;
        markRunUpdated(existing);
        setRunPhase(existing, "completed");
        recentRuns.set(signal.sessionId, { ...existing });
        runs.delete(signal.sessionId);
        pendingAlerts = pendingAlerts.filter(
          (alert) =>
            alert.dedupeKey !== `alert:${signal.sessionId}:approval`
            && alert.dedupeKey !== `alert:${signal.sessionId}:question`,
        );
        clearAlertDedupe(`alert:${signal.sessionId}:approval`);
        clearAlertDedupe(`alert:${signal.sessionId}:question`);
        scheduleFlush(true);
      }
      return;
    }
    // Exit/kill phases are owned by onPtyExit (which knows the exit code).
    if (signal.runtimeState === "exited" || signal.runtimeState === "killed") return;
    // Explicit/provider-structured attention owns this phase until the
    // lifecycle event that resolves it. PTY heartbeats are observational and
    // must not erase a real request.
    if (existing?.phase === "waiting_for_input" || existing?.phase === "waiting_for_approval") return;
    // `idle` = no output for 12s with no OSC prompt marker — we can't prove
    // the CLI is working OR at a prompt, so publish it as `stale` (dimmed,
    // not counted active) instead of overstating it as a live running row.
    const phase: AgentRunPhase = signal.runtimeState === "waiting-input" || signal.runtimeState === "idle"
        ? "stale"
        : "running";
    // Signals re-fire on a ~10s heartbeat; only a phase change is worth a
    // Live Activity update (the run row shows phase, not output).
    if (existing && existing.kind === "cli" && existing.phase === phase) {
      // A `stale` row must keep its `lastActiveAt` frozen at the moment it went
      // stale so `pruneRuns` can retire it RUNNING_TTL_MS later. Refreshing it
      // on every idle heartbeat (idle = no output, not real activity) would
      // reset that 2h clock and hold the stale Live Activity open forever.
      if (phase !== "stale") markRunUpdated(existing);
      return;
    }
    // A chat run with the same session id would mean a chat-owned shell that
    // resolveCliSession failed to filter — never downgrade a chat run.
    if (existing && existing.kind === "chat") return;
    const run = ensureRun(signal.sessionId, scopeKey, "cli");
    markRunUpdated(run);
    setRunPhase(run, phase);
    if (!run.lane) {
      run.lane = scopes.get(scopeKey)?.resolveLaneName?.(signal.laneId) ?? signal.laneId ?? null;
    }
    scheduleFlush(false);
  };

  const onPtyExit = (scopeKey: string, event: PtyExitEvent & { laneId: string }): void => {
    // A user-chosen stop is neither a successful completion nor a failure.
    // The Live Activity wire format has no stopped phase, so retire the row
    // instead of lying with either terminal state.
    if (isUserStoppedExit(event.exitCode)) {
      runs.delete(event.sessionId);
      recentRuns.delete(event.sessionId);
      scheduleFlush(false);
      return;
    }
    // A tracked CLI run in the aggregate reaches its terminal phase here — the
    // runtime signal stream never reports exit codes.
    const run = runs.get(event.sessionId);
    if (run && run.kind === "cli") {
      markRunUpdated(run);
      setRunPhase(run, event.exitCode == null || event.exitCode === 0 ? "completed" : "failed");
      recentRuns.set(run.sessionId, { ...run });
      scheduleFlush(false);
    }
    // Only surface non-clean exits of tracked CLI sessions — and only ones the
    // user did not cause. A SIGINT/SIGTERM exit is `stopped`, not `failed`: the
    // user pressed Ctrl-C or Stop, so they already know, and pushing an alert
    // about an outcome they chose is exactly what teaches people to ignore
    // alerts. Genuine non-zero failures still notify.
    if (event.exitCode == null || event.exitCode === 0) return;
    const resolveLaneName = scopes.get(scopeKey)?.resolveLaneName;
    const lane = resolveLaneName?.(event.laneId) ?? event.laneId ?? null;
    const body = lane ? `${lane} · exited with code ${event.exitCode}` : `Exited with code ${event.exitCode}`;
    enqueueAlert({
      sessionId: event.sessionId,
      dedupeKey: `alert:${event.sessionId}:cli_ended`,
      render: () => ({ title: "CLI session ended", body }),
      deepLink: `ade://session/${event.sessionId}`,
      threadId: event.sessionId,
      phase: "terminal",
      interruptionLevel: "active",
    });
    scheduleFlush(false);
  };

  const prNotificationCopy = (notification: PushPrNotification): { title: string; body: string; interruptionLevel: PendingAlert["interruptionLevel"] } => {
    const fallbackTitle = notification.prTitle?.trim() || `Pull request #${notification.prNumber}`;
    switch (notification.kind) {
      case "opened":
        return { title: `PR #${notification.prNumber} opened`, body: fallbackTitle, interruptionLevel: "passive" };
      case "reopened":
        return { title: `PR #${notification.prNumber} reopened`, body: fallbackTitle, interruptionLevel: "passive" };
      case "closed":
        return { title: `PR #${notification.prNumber} closed`, body: fallbackTitle, interruptionLevel: "passive" };
      case "merged":
        return { title: `PR #${notification.prNumber} merged`, body: fallbackTitle, interruptionLevel: "active" };
      case "merge_ready":
        return { title: `PR #${notification.prNumber} is ready to merge`, body: notification.prTitle ?? "Required checks passed and it has approval.", interruptionLevel: "active" };
      case "checks_failing":
        return { title: `PR #${notification.prNumber} checks are failing`, body: notification.prTitle ?? "One or more required checks failed.", interruptionLevel: "active" };
      case "changes_requested":
        return { title: `Changes requested on PR #${notification.prNumber}`, body: fallbackTitle, interruptionLevel: "active" };
      case "review_requested":
        return { title: `Review requested on PR #${notification.prNumber}`, body: fallbackTitle, interruptionLevel: "active" };
    }
  };

  const prActivityId = (scopeKey: string, notification: PushPrNotification): string => {
    const owner = notification.repoOwner?.trim().toLowerCase();
    const repo = notification.repoName?.trim().toLowerCase();
    const repoScope = owner && repo
      ? `repo:${encodeURIComponent(owner)}:${encodeURIComponent(repo)}`
      : "number";
    return `pr:${scopeKey}:${repoScope}:${notification.prNumber}`;
  };
  const prDeepLink = (notification: PushPrNotification): string => {
    const owner = notification.repoOwner?.trim();
    const repo = notification.repoName?.trim();
    if (owner && repo) {
      return `ade://pr/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${notification.prNumber}`;
    }
    return `ade://pr/${notification.prNumber}`;
  };
  const removePrActivitiesForScope = (scopeKey: string): boolean => {
    const prefix = `pr:${scopeKey}:`;
    let removed = false;
    for (const id of prActivities.keys()) {
      if (id.startsWith(prefix)) {
        prActivities.delete(id);
        removed = true;
      }
    }
    return removed;
  };

  const onPrNotification = (
    scopeKey: string,
    notification: PushPrNotification,
    resolveLaneName?: (laneId: string) => string | null | undefined,
  ): void => {
    const lane = notification.laneId
      ? (resolveLaneName?.(notification.laneId) ?? notification.laneId)
      : null;
    const activityId = prActivityId(scopeKey, notification);
    const existingActivity = prActivities.get(activityId);
    const eventStamp = Math.max(
      now(),
      (existingActivity?.updatedAt ?? -1) + 1,
    );
    prActivities.set(activityId, {
      id: activityId,
      scopeKey,
      prId: notification.prId?.trim() || null,
      prNumber: notification.prNumber,
      title: notification.prTitle?.trim() || `Pull request #${notification.prNumber}`,
      phase: notification.kind,
      lane,
      repoOwner: notification.repoOwner?.trim() || null,
      repoName: notification.repoName?.trim() || null,
      updatedAt: eventStamp,
      statusSinceAt: existingActivity?.phase === notification.kind
        ? existingActivity.statusSinceAt
        : eventStamp,
    });
    schedulePrActivityExpiry(eventStamp);

    const copy = prNotificationCopy(notification);
    enqueueAlert({
      sessionId: null,
      dedupeKey: `alert:${activityId}:${notification.kind}`,
      render: () => ({ title: copy.title, body: copy.body }),
      deepLink: prDeepLink(notification),
      threadId: activityId,
      phase: copy.interruptionLevel === "passive" ? "terminal" : "waiting",
      interruptionLevel: copy.interruptionLevel,
      fingerprintSalt: eventStamp,
    });
    scheduleFlush(false);
  };

  const relayApnsConfigured = async (): Promise<boolean | null> => {
    const nowMs = now();
    if (apnsConfiguredCache && nowMs - apnsConfiguredCache.at < APNS_HEALTH_CACHE_MS) {
      return apnsConfiguredCache.value;
    }
    try {
      const health = await deps.relayClient.health();
      apnsConfiguredCache = { value: health.apnsConfigured, at: nowMs };
      deps.store.recordRelayContact(new Date().toISOString());
      return health.apnsConfigured;
    } catch (error) {
      logWarn("push.health_failed", error);
      // Don't poison the cache for the full 24h TTL on a transient failure —
      // clear it so the next status read re-checks instead of reporting a stale
      // `null` for a day after the relay recovers.
      apnsConfiguredCache = null;
      return null;
    }
  };

  const buildDeliveryStatus = async (deviceId: string | null): Promise<PushDeliveryStatus> => {
    const snapshot = deps.store.getStatusSnapshot();
    const device = deviceId ? deps.store.getDevice(deviceId) : null;
    return {
      publisherEnabled: snapshot.enabled,
      relayUrl: deps.relayClient.baseUrl,
      relayApnsConfigured: await relayApnsConfigured(),
      deviceRegistered: Boolean(device && (device.apnsToken || device.pushToStartToken)),
      registeredDeviceCount: snapshot.registeredDeviceCount,
      lastPublishAt: snapshot.lastPublishAt,
      lastPublishError: snapshot.lastPublishError,
      lastRelayContactAt: snapshot.lastRelayContactAt,
    };
  };

  const detachScope = (scopeKey: string): void => {
    const scope = scopes.get(scopeKey);
    if (!scope) return;
    for (const unsubscribe of scope.unsubscribes.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // ignore listener teardown failures
      }
    }
    scopes.delete(scopeKey);
    // A closed project stops contributing to the aggregate Live Activity.
    let removedContribution = false;
    for (const [sessionId, run] of runs) {
      if (run.scopeKey === scopeKey) {
        runs.delete(sessionId);
        removedContribution = true;
      }
    }
    for (const [sessionId, run] of recentRuns) {
      if (run.scopeKey === scopeKey) {
        recentRuns.delete(sessionId);
        removedContribution = true;
      }
    }
    const removedPrActivities = removePrActivitiesForScope(scopeKey);
    removedContribution = removedContribution || removedPrActivities;
    if (scopes.size === 0) {
      if (removedContribution && !disposed) {
        finalAttentionSnapshotPending = true;
      }
      // Nothing attached — stop the flush loop so no timer lingers. The shared
      // instance stays memoized and resumes when a project re-attaches.
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      flushFireAt = 0;
      if (prExpiryTimer) clearTimeout(prExpiryTimer);
      prExpiryTimer = null;
      if (attentionHeartbeatTimer) clearInterval(attentionHeartbeatTimer);
      attentionHeartbeatTimer = null;
      prActivities.clear();
      pendingAlerts = [];
      scheduleFinalAttentionSnapshot();
    } else if (removedContribution) {
      scheduleFlush(false);
    }
  };

  const dispose = (): void => {
    disposed = true;
    for (const scopeKey of [...scopes.keys()]) detachScope(scopeKey);
    if (flushTimer) clearTimeout(flushTimer);
    if (prExpiryTimer) clearTimeout(prExpiryTimer);
    if (attentionHeartbeatTimer) clearInterval(attentionHeartbeatTimer);
    flushTimer = null;
    prExpiryTimer = null;
    attentionHeartbeatTimer = null;
  };

  return {
    /** Warm the APNs-configured cache. Idempotent; safe to call per scope. */
    async start(): Promise<void> {
      if (disposed || warmed) return;
      warmed = true;
      void relayApnsConfigured().catch(() => {});
      reconcilePending = true;
      scheduleFlush(true);
    },

    setActivityRosterProvider(
      provider: PushPublisherDeps["activityRosterProvider"],
    ): void {
      if (activityRosterProvider === provider) return;
      activityRosterProvider = provider ?? null;
      rosterCache = null;
      reconcilePending = true;
      if (warmed && scopes.size > 0) scheduleFlush(true);
    },

    /**
     * Wire one project scope's signal sources into the shared publisher. Returns
     * a detach function; the aggregate merges runs across all attached scopes.
     */
    attachSources(scopeKey: string, sources: PushPublisherSources): () => void {
      if (disposed) return () => {};
      // Replace any prior attachment for this scope (idempotent re-attach).
      detachScope(scopeKey);
      const scopeUnsubscribes: Array<() => void> = [];
      if (sources.agentChatService) {
        scopeUnsubscribes.push(sources.agentChatService.subscribeToEvents((env) => onChatEvent(scopeKey, env)));
      }
      if (sources.ptyService) {
        scopeUnsubscribes.push(sources.ptyService.onExit((event) => onPtyExit(scopeKey, event)));
      }
      if (sources.subscribePrNotifications) {
        scopeUnsubscribes.push(sources.subscribePrNotifications((notification) => {
          onPrNotification(scopeKey, notification, sources.resolveLaneName);
        }));
      }
      scopes.set(scopeKey, {
        agentChatService: sources.agentChatService ?? null,
        resolveLaneName: sources.resolveLaneName,
        resolveCliSession: sources.resolveCliSession,
        projectName: sources.projectName?.trim() || "ADE project",
        projectRoot: sources.projectRoot?.trim() || null,
        unsubscribes: scopeUnsubscribes,
      });
      if (!attentionHeartbeatTimer) {
        attentionHeartbeatTimer = setInterval(
          () => scheduleFlush(false, false),
          ATTENTION_HEARTBEAT_MS,
        );
        attentionHeartbeatTimer.unref?.();
      }
      return () => detachScope(scopeKey);
    },

    /**
     * Entry point for ptyService's onSessionRuntimeSignal callback (a
     * create-time hook, not a subscription — bootstrap forwards it here).
     */
    handleCliRuntimeSignal(scopeKey: string, signal: PushCliRuntimeSignal): void {
      onCliRuntimeSignal(scopeKey, signal);
    },

    handleSessionAttentionRequested(
      scopeKey: string,
      request: PushSessionAttentionRequest,
    ): void {
      if (disposed || !request.sessionId) return;
      const run = ensureRun(request.sessionId, scopeKey, request.kind);
      run.title = request.title.trim() || "ADE session";
      run.lane = request.laneId
        ? scopes.get(scopeKey)?.resolveLaneName?.(request.laneId) ?? request.laneId
        : run.lane;
      run.detail = request.message;
      markRunUpdated(run);
      setRunPhase(run, "waiting_for_input");
      run.metaResolved = true;
      // An explicit ask supersedes any pending approval on the same session:
      // clear the stale approval item + its queued alert/dedupe so the next
      // flush can't pair obsolete approval state with the new question.
      run.itemId = null;
      pendingAlerts = pendingAlerts.filter(
        (existing) => existing.dedupeKey !== `alert:${request.sessionId}:approval`,
      );
      clearAlertDedupe(`alert:${request.sessionId}:approval`);
      clearAlertDedupe(`alert:${request.sessionId}:question`);
      enqueueAlert({
        sessionId: request.sessionId,
        dedupeKey: `alert:${request.sessionId}:question`,
        render: () => ({ title: `${runSubject(run)} needs you`, body: request.message }),
        deepLink: `ade://session/${request.sessionId}`,
        threadId: request.sessionId,
        phase: "waiting",
        interruptionLevel: "time-sensitive",
      });
      scheduleFlush(true);
    },

    handleSessionAttentionResolved(scopeKey: string | null, sessionId: string): void {
      if (disposed || !sessionId) return;
      const run = runs.get(sessionId);
      if (!run || (scopeKey != null && run.scopeKey !== scopeKey)) return;
      if (run.phase !== "waiting_for_input" && run.phase !== "waiting_for_approval") return;
      run.itemId = null;
      markRunUpdated(run);
      setRunPhase(run, "running");
      pendingAlerts = pendingAlerts.filter(
        (alert) =>
          alert.dedupeKey !== `alert:${sessionId}:approval`
          && alert.dedupeKey !== `alert:${sessionId}:question`,
      );
      clearAlertDedupe(`alert:${sessionId}:approval`);
      clearAlertDedupe(`alert:${sessionId}:question`);
      scheduleFlush(true);
    },

    handleSessionSettled(scopeKey: string | null, sessionId: string): void {
      if (disposed || !sessionId) return;
      const run = runs.get(sessionId);
      if (!run || (scopeKey != null && run.scopeKey !== scopeKey)) return;
      run.itemId = null;
      markRunUpdated(run);
      setRunPhase(run, "completed");
      recentRuns.set(sessionId, { ...run });
      runs.delete(sessionId);
      pendingAlerts = pendingAlerts.filter(
        (alert) =>
          alert.dedupeKey !== `alert:${sessionId}:approval`
          && alert.dedupeKey !== `alert:${sessionId}:question`,
      );
      clearAlertDedupe(`alert:${sessionId}:approval`);
      clearAlertDedupe(`alert:${sessionId}:question`);
      scheduleFlush(true);
    },

    /** Force a flush soon (e.g. right after a device registers). */
    poke(): void {
      scheduleFlush(true);
    },

    async handleDeviceRegistered(registration: PushDeviceRegistration): Promise<PushDeliveryStatus> {
      await deps.relayClient.claim();
      await deps.relayClient.registerDevice(registration);
      deps.store.upsertDevice(registration);
      if (registration.clearPushToStartToken) {
        liveActivityEpochByDevice.set(
          registration.deviceId,
          (liveActivityEpochByDevice.get(registration.deviceId) ?? 0) + 1,
        );
        liveActivityFingerprintByDevice.delete(registration.deviceId);
      }
      deps.store.recordRelayContact(new Date().toISOString());
      // A freshly registered device should pick up any live run immediately.
      this.poke();
      return buildDeliveryStatus(registration.deviceId);
    },

    async handleLiveActivityToken(report: PushLiveActivityTokenReport): Promise<void> {
      await deps.relayClient.claim();
      await deps.relayClient.reportLiveActivityToken({
        deviceId: report.deviceId,
        activityId: report.activityId,
        token: report.token ?? "",
      });
      deps.store.recordRelayContact(new Date().toISOString());
      // An update/end published before this token arrived had no APNs target
      // and was left uncommitted — resend now so the activity catches up.
      if (report.token) this.poke();
    },

    async handleUnregister(deviceId: string): Promise<void> {
      try {
        await deps.relayClient.unregisterDevice(deviceId);
      } catch (error) {
        logWarn("push.unregister_failed", error);
      }
      deps.store.removeDevice(deviceId);
      liveActivityEpochByDevice.set(
        deviceId,
        (liveActivityEpochByDevice.get(deviceId) ?? 0) + 1,
      );
      liveActivityFingerprintByDevice.delete(deviceId);
      lastSentBadgeByDevice.delete(deviceId);
    },

    setPrefs(deviceId: string, prefs: PushNotificationPrefs): boolean {
      return deps.store.setPrefs(deviceId, prefs) != null;
    },

    setEnabled(enabled: boolean): void {
      deps.store.setEnabled(enabled);
    },

    getDeliveryStatus(deviceId: string | null): Promise<PushDeliveryStatus> {
      return buildDeliveryStatus(deviceId);
    },

    async getAttentionSnapshot(
      since = 0,
      streamId?: string | null,
    ): Promise<AttentionSnapshot> {
      const snapshot = await deps.relayClient.getAttentionSnapshot?.(since, streamId);
      return snapshot ?? {
        contractVersion: ATTENTION_CONTRACT_VERSION,
        streamId: null,
        revision: 0,
        generatedAt: new Date(now()).toISOString(),
        items: [],
        tombstones: [],
      };
    },

    async getMachineAttentionSnapshot(): Promise<AttentionSnapshot> {
      const nowMs = now();
      const { machineKey } = deps.store.getOrCreateIdentity();
      const built = mergeMachineAcknowledgments(
        await buildAttentionItems(nowMs, activityProtocol != null && activityProtocol >= 2),
      );
      const items = selectActivityRoster(built).selected;
      const accountMachineIdentity = deps.getAccountMachineIdentity?.() ?? null;
      const accountOwnerId = deps.getAccountOwnerId?.()?.trim() || null;
      const machine = items[0]?.machine ?? {
        machineKey,
        accountMachineKey: accountMachineIdentity?.machineKey ?? null,
        deviceId: accountMachineIdentity?.deviceId ?? null,
        name: deps.machineName,
        online: true,
        lastSeenAt: new Date(nowMs).toISOString(),
      };
      lastMachineSnapshotItems.clear();
      for (const item of items) lastMachineSnapshotItems.set(item.id, item);
      lastMachineSnapshotAccountOwnerId = accountOwnerId;
      return {
        contractVersion: ATTENTION_CONTRACT_VERSION,
        scope: "machine",
        accountOwnerId,
        streamId: `machine:${machineKey}`,
        revision: items.reduce(
          (revision, item) => Math.max(revision, item.revision),
          0,
        ),
        generatedAt: new Date(nowMs).toISOString(),
        machines: [machine],
        items,
        tombstones: [],
      };
    },

    async acknowledgeAttention(args: {
      itemIds: string[];
      seenAt?: string;
      dismissedAt?: string | null;
    }): Promise<void> {
      await deps.relayClient.acknowledgeAttention?.(args);
    },

    async acknowledgeMachineAttention(args: {
      itemIds: string[];
      sourceRevisions: Record<string, number>;
      expectedAccountOwnerId: string | null;
      seenAt?: string;
      dismissedAt?: string | null;
    }): Promise<void> {
      const currentAccountOwnerId = deps.getAccountOwnerId?.()?.trim() || null;
      const expectedAccountOwnerId = args.expectedAccountOwnerId?.trim() || null;
      if (expectedAccountOwnerId !== currentAccountOwnerId) {
        throw new Error(
          "The ADE account changed after this machine Activity snapshot loaded. Refresh and try again.",
        );
      }
      if (lastMachineSnapshotAccountOwnerId !== currentAccountOwnerId) {
        throw new Error(
          "Refresh machine Activity after changing ADE accounts, then try again.",
        );
      }
      const items = args.itemIds.flatMap((itemId) => {
        const item = lastMachineSnapshotItems.get(itemId);
        return item ? [item] : [];
      });
      if (items.length !== args.itemIds.length) {
        throw new Error(
          "This machine can only acknowledge items from its latest Activity snapshot. Refresh and try again.",
        );
      }
      const staleItem = items.find((item) =>
        args.sourceRevisions[item.id] !== item.revision);
      if (staleItem) {
        throw new Error(
          "This Activity item changed after it loaded. Refresh before acknowledging the newer state.",
        );
      }
      const updatedAt = new Date(now()).toISOString();
      const seenAt = args.seenAt?.trim() || updatedAt;
      if (Number.isNaN(Date.parse(seenAt))) {
        throw new Error("Activity seenAt must be an ISO timestamp.");
      }
      if (
        typeof args.dismissedAt === "string"
        && Number.isNaN(Date.parse(args.dismissedAt))
      ) {
        throw new Error("Activity dismissedAt must be an ISO timestamp.");
      }
      deps.store.recordAttentionAcknowledgments?.({
        items: items.map((item) => ({ id: item.id, revision: item.revision })),
        accountOwnerId: currentAccountOwnerId,
        seenAt,
        ...(args.dismissedAt === null || typeof args.dismissedAt === "string"
          ? { dismissedAt: args.dismissedAt }
          : {}),
        updatedAt,
      });
      // Reconcile only after the normal Attention publish path has made the
      // source revision available to the account relay. An immediate ack can
      // succeed against zero rows and falsely clear the durable pending state.
      scheduleFlush(true);
    },

    async reportAttentionPresence(presence: AttentionPresence): Promise<void> {
      await deps.relayClient.reportAttentionPresence?.(presence);
    },

    async getAttentionPreferences(accountOwnerId: string): Promise<AttentionPreferences> {
      return await deps.relayClient.getAttentionPreferences?.(accountOwnerId)
        ?? DEFAULT_ATTENTION_PREFERENCES;
    },

    async putAttentionPreferences(
      accountOwnerId: string,
      preferences: AttentionPreferences,
    ): Promise<void> {
      await deps.relayClient.putAttentionPreferences?.(accountOwnerId, preferences);
    },

    dispose,

    /**
     * Daemon-exit path: best-effort `end` for the aggregate Live Activity so
     * dead agents don't linger on the lock screen until the stale-date dim.
     * Bounded by a short timeout — shutdown must never hang on the relay —
     * and only sent when a start was actually committed. Ends with dispose().
     */
    async shutdown(): Promise<void> {
      // Stop any scheduled flush first so a timer-driven publish can't race
      // the shutdown `end`.
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      flushFireAt = 0;
      if (!disposed && liveActivityFingerprintByDevice.size > 0 && !isGated()) {
        try {
          const nowMs = now();
          const deviceIds = deps.store.listDevices()
            .filter((device) =>
              liveActivityFingerprintByDevice.has(device.deviceId)
              && Boolean(device.pushToStartToken)
              && shouldDeliverLiveActivityForPrefs(device.prefs))
            .map((device) => device.deviceId);
          if (deviceIds.length > 0) {
            // Mark still-active runs stale — the machine is gone, not the agent done.
            const finalRuns = [...runs.values()].map((run) =>
              isActivePhase(run.phase) ? { ...run, phase: "stale" as const } : run,
            );
            const item: PushRelayLiveActivityItem = {
              deviceIds,
              event: "end",
              activityId: AGENT_RUNS_ACTIVITY_ID,
              contentState: buildAgentRunsContentState(finalRuns, nowMs),
              dedupeKey: AGENT_RUNS_DEDUPE_KEY,
              phase: "terminal",
              dismissalDate: Math.floor(nowMs / 1000) + 60,
            };
            let timeout: NodeJS.Timeout | null = null;
            // Keep a handle so a publish that loses the race can't surface as
            // an unhandled rejection after shutdown returns.
            const publishPromise = deps.relayClient.publish({ liveActivity: [item] });
            publishPromise.catch(() => {});
            try {
              await Promise.race([
                publishPromise,
                new Promise<never>((_, reject) => {
                  timeout = setTimeout(() => reject(new Error("shutdown publish timed out")), SHUTDOWN_PUBLISH_TIMEOUT_MS);
                }),
              ]);
            } finally {
              if (timeout) clearTimeout(timeout);
            }
          }
        } catch (error) {
          logWarn("push.shutdown_end_failed", error);
        }
      }
      dispose();
    },

    // Exposed for tests / diagnostics.
    _debug: {
      runs,
      getPendingAlerts: () => pendingAlerts,
      onChatEvent,
      onPtyExit,
      onPrNotification,
      flushNow: () => flush(),
    },
  };
}

export type PushPublisherService = ReturnType<typeof createPushPublisherService>;

const sharedPublishers = new Map<string, PushPublisherService>();

/**
 * Machine-level singleton keyed by the push-identity file path. Every project
 * scope in the multi-project daemon shares one publisher — and thus one relay
 * identity and one aggregate "agent-runs" Live Activity — so a run in project B
 * can't clobber or end the phone's activity for project A. Per-project signals
 * are wired in per scope via `attachSources`.
 */
export function getSharedPushPublisherService(
  key: string,
  makeDeps: () => PushPublisherDeps,
): PushPublisherService {
  let existing = sharedPublishers.get(key);
  if (!existing) {
    existing = createPushPublisherService(makeDeps());
    sharedPublishers.set(key, existing);
  }
  return existing;
}

/**
 * Read-only lookup for shutdown paths: returns the shared publisher only if a
 * project scope already created it — never mints one just to dispose it.
 */
export function peekSharedPushPublisherService(key: string): PushPublisherService | undefined {
  return sharedPublishers.get(key);
}
