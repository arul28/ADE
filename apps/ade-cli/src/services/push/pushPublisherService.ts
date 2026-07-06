import path from "node:path";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import type { AgentChatEventEnvelope, AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import type { PtyExitEvent } from "../../../../desktop/src/shared/types/sessions";
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
  PushRelayAlertItem,
  PushRelayClient,
  PushRelayLiveActivityItem,
} from "./pushRelayClient";

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
const DETAIL_MAX_CHARS = 160;
/** Fixed lock-screen copy for failed runs — never leak error text to the widget. */
const FAILED_DETAIL = "Run failed";

const RUNNING_TTL_MS = 2 * 60 * 60 * 1000; // 2h for running/starting
const WAITING_TTL_MS = 24 * 60 * 60 * 1000; // 24h for waiting_for_*
const DEFAULT_FLUSH_DEBOUNCE_MS = 2_000;
const DEFAULT_PROMPT_FLUSH_MS = 150;
const PUBLISH_RETRY_MS = 30_000;
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
  metaResolved: boolean;
};

/** The OSC 133-derived terminal state pushed by ptyService.onSessionRuntimeSignal. */
export type PushCliRuntimeSignal = {
  laneId: string;
  sessionId: string;
  runtimeState: string;
};

export type PushPrNotification = {
  kind: PrNotificationKind;
  prNumber: number;
  prTitle: string | null;
  laneId: string | null;
};

type PendingAlert = {
  sessionId: string | null;
  dedupeKey: string;
  /** Rendered at flush time so run title/lane/agent reflect resolved metadata. */
  render: () => { title: string; body: string | null };
  deepLink?: string | null;
  threadId?: string | null;
  phase: "running" | "waiting" | "terminal";
  interruptionLevel?: "passive" | "active" | "time-sensitive" | null;
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
  /**
   * Resolves a tracked terminal session for CLI-run metadata. Returning a
   * record with a `chatSessionId` (a chat-attached shell) or null (unknown /
   * infra row) drops the run — the chat run already represents that work.
   */
  resolveCliSession?: (sessionId: string) => {
    title: string | null;
    toolType?: string | null;
    chatSessionId?: string | null;
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
} {
  const activeCount = runs.filter((run) => isActivePhase(run.phase)).length;
  const ordered = [...runs].sort((left, right) => right.lastActiveAt - left.lastActiveAt).slice(0, AGENT_RUNS_MAX);
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
  };
}

/** Waiting runs are what the app icon badge counts — agents blocked on the user. */
export function countAwaitingAttentionRuns(runs: AgentRunState[]): number {
  return runs.filter(
    (run) => run.phase === "waiting_for_approval" || run.phase === "waiting_for_input",
  ).length;
}

function readOutcomeCount(result: Record<string, unknown> | null | undefined, key: string): number {
  const value = Number(result?.[key]);
  return Number.isFinite(value) ? value : 0;
}

type RelayLiveActivityOutcome = { delivered: boolean; suppressed: boolean; skipped: boolean };

type RelayAlertOutcome = { deviceId: string; delivered: boolean; suppressed: boolean };

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
    .filter((entry) => entry.kind === "liveactivity")
    .map((entry) => ({
      delivered: entry.delivered === true,
      suppressed: entry.suppressed === true,
      skipped: typeof entry.skipped === "string" && entry.skipped.length > 0,
    }));
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

export function createPushPublisherService(deps: PushPublisherDeps) {
  const now = deps.now ?? (() => Date.now());
  const flushDebounceMs = deps.flushDebounceMs ?? DEFAULT_FLUSH_DEBOUNCE_MS;
  const promptFlushMs = deps.promptFlushMs ?? DEFAULT_PROMPT_FLUSH_MS;

  const runs = new Map<string, AgentRunState>();
  let pendingAlerts: PendingAlert[] = [];
  const lastAlertFingerprintByKey = new Map<string, string>();
  let lastLiveActivityFingerprint: string | null = null;
  let liveActivityStarted = false;
  /**
   * Last app-icon badge count delivered per device (absent = never sent).
   * Per-device because a flush can legitimately exclude some devices (quiet
   * hours, alert-covered subsets) — a global scalar would mark their stale
   * badge as already-synced and skip them until the next count change.
   */
  const lastSentBadgeByDevice = new Map<string, number>();

  let flushTimer: NodeJS.Timeout | null = null;
  let flushFireAt = 0;
  let flushing = false;
  let disposed = false;
  let warmed = false;

  type AttachedScope = {
    agentChatService?: PushAgentChatService | null;
    resolveLaneName?: (laneId: string) => string | null | undefined;
    resolveCliSession?: PushPublisherSources["resolveCliSession"];
    unsubscribes: Array<() => void>;
  };
  const scopes = new Map<string, AttachedScope>();

  let apnsConfiguredCache: { value: boolean | null; at: number } | null = null;

  const logWarn = (message: string, error: unknown): void => {
    deps.logger.warn(message, { error: error instanceof Error ? error.message : String(error) });
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
        metaResolved: false,
      };
      runs.set(sessionId, run);
    }
    return run;
  };

  const runSubject = (run: AgentRunState): string => run.agent?.trim() || run.title?.trim() || "Agent";

  const laneTitleLine = (run: AgentRunState): string => {
    const parts = [run.lane?.trim(), run.title?.trim()].filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join(" · ") : run.title?.trim() || "Agent run";
  };

  const enqueueAlert = (alert: PendingAlert): void => {
    pendingAlerts = pendingAlerts.filter((existing) => existing.dedupeKey !== alert.dedupeKey);
    pendingAlerts.push(alert);
  };

  const clearAlertDedupe = (dedupeKey: string): void => {
    lastAlertFingerprintByKey.delete(dedupeKey);
  };

  const scheduleFlush = (immediate: boolean): void => {
    if (disposed) return;
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
      void runFlush();
    }, delay);
  };

  const pruneRuns = (nowMs: number): void => {
    for (const [sessionId, run] of runs) {
      const age = nowMs - run.lastActiveAt;
      if ((run.phase === "running" || run.phase === "starting") && age > RUNNING_TTL_MS) {
        runs.delete(sessionId);
      } else if (
        (run.phase === "waiting_for_approval" || run.phase === "waiting_for_input")
        && age > WAITING_TTL_MS
      ) {
        runs.delete(sessionId);
      }
    }
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
  ): { item: PushRelayLiveActivityItem; commit: () => void } | null => {
    if (deviceIds.length === 0) return null;
    const allRuns = [...runs.values()];
    const contentState = buildAgentRunsContentState(allRuns, nowMs);
    const activeCount = contentState.activeCount;

    let event: "start" | "update" | "end";
    if (activeCount > 0 && !liveActivityStarted) event = "start";
    else if (activeCount === 0 && liveActivityStarted) event = "end";
    else if (activeCount === 0 && !liveActivityStarted) return null; // nothing live to report
    else event = "update";

    const fingerprint = JSON.stringify({ ...contentState, updatedAt: 0 });
    if (event === "update" && fingerprint === lastLiveActivityFingerprint) return null;

    const anyWaiting = allRuns.some(
      (run) => run.phase === "waiting_for_approval" || run.phase === "waiting_for_input",
    );
    const phase: "running" | "waiting" | "terminal" = anyWaiting
      ? "waiting"
      : activeCount > 0
        ? "running"
        : "terminal";

    const item: PushRelayLiveActivityItem = {
      deviceIds,
      event,
      activityId: AGENT_RUNS_ACTIVITY_ID,
      contentState,
      dedupeKey: AGENT_RUNS_DEDUPE_KEY,
      phase,
    };

    if (event === "start") {
      item.attributesType = AGENT_RUNS_ATTRIBUTES_TYPE;
      item.attributes = { machineName: deps.machineName };
      const mostRecent = allRuns.sort((left, right) => right.lastActiveAt - left.lastActiveAt)[0];
      item.alert = {
        title: activeCount === 1 && mostRecent ? `${runSubject(mostRecent)} is running` : `${activeCount} agent runs active`,
        body: mostRecent ? laneTitleLine(mostRecent) : null,
      };
    }
    if (event === "end") {
      item.dismissalDate = Math.floor(nowMs / 1000) + 300;
    }

    const commit = (): void => {
      lastLiveActivityFingerprint = fingerprint;
      if (event === "start") liveActivityStarted = true;
      if (event === "end") {
        liveActivityStarted = false;
        lastLiveActivityFingerprint = null;
        // Once the aggregate ends, drop terminal rows so the next run starts fresh.
        for (const [sessionId, run] of runs) {
          if (isTerminalPhase(run.phase)) runs.delete(sessionId);
        }
      }
    };

    return { item, commit };
  };

  const flush = async (): Promise<void> => {
    const nowMs = now();
    if (isGated()) {
      pendingAlerts = [];
      return;
    }
    pruneRuns(nowMs);
    await resolveMissingMeta();

    const devices = deps.store.listDevices();
    const consumedAlerts = pendingAlerts;
    pendingAlerts = [];

    const badgeCount = countAwaitingAttentionRuns([...runs.values()]);

    const alertItems: PushRelayAlertItem[] = [];
    const alertCommits: Array<[string, string]> = [];
    for (const alert of consumedAlerts) {
      const eligibleIds = devices
        .filter((device) => Boolean(device.apnsToken) && shouldDeliverAlertForPrefs(device.prefs, alert.sessionId, nowMs))
        .map((device) => device.deviceId);
      if (eligibleIds.length === 0) continue;
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
      });
      if (lastAlertFingerprintByKey.get(alert.dedupeKey) === fingerprint) continue;
      alertCommits.push([alert.dedupeKey, fingerprint]);
      alertItems.push({
        deviceIds: eligibleIds,
        title: copy.title,
        body: copy.body,
        deepLink: alert.deepLink ?? null,
        threadId: alert.threadId ?? null,
        dedupeKey: alert.dedupeKey,
        phase: alert.phase,
        interruptionLevel: alert.interruptionLevel ?? null,
        sessionId: alert.sessionId ?? null,
        itemId: alert.itemId ?? null,
        category: alert.category ?? null,
        badge: badgeCount,
      });
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
      alertItems.push({
        deviceIds: badgeSyncDeviceIds,
        title: "",
        sound: null,
        phase: "terminal",
        badge: badgeCount,
      });
    }

    const liveActivityDeviceIds = devices
      .filter((device) => Boolean(device.pushToStartToken) && shouldDeliverLiveActivityForPrefs(device.prefs))
      .map((device) => device.deviceId);
    const laPlan = planLiveActivity(liveActivityDeviceIds, nowMs);

    if (alertItems.length === 0 && !laPlan) return;

    const payload: { notifications?: PushRelayAlertItem[]; liveActivity?: PushRelayLiveActivityItem[] } = {};
    if (alertItems.length > 0) payload.notifications = alertItems;
    if (laPlan) payload.liveActivity = [laPlan.item];

    try {
      const result = await deps.relayClient.publish(payload);
      // The relay answers HTTP 200 even when every APNs send failed — it reports
      // per-target `delivered`/`failed` counts in the body. An all-failed publish
      // (nothing delivered, at least one hard failure) is transient, so re-queue
      // and retry instead of committing dedupe/Live-Activity state, which would
      // drop the content and locally suppress the identical resend.
      const delivered = readOutcomeCount(result, "delivered");
      const failed = readOutcomeCount(result, "failed");
      if (delivered === 0 && failed > 0) {
        pendingAlerts = [...consumedAlerts, ...pendingAlerts];
        deps.store.recordPublishResult({ at: new Date().toISOString(), error: `relay delivered 0 of ${failed} targets` });
        logWarn("push.publish_undelivered", new Error(`0 of ${failed} targets delivered`));
        scheduleRetry();
        return;
      }
      for (const [key, fingerprint] of alertCommits) lastAlertFingerprintByKey.set(key, fingerprint);
      // Every alert item (including the badge-only sync) carries this flush's
      // badge count. Commit it per device from the relay's outcomes: a device
      // whose send failed transiently must stay unsynced so the next flush
      // retries its badge. Suppressed counts as synced (identical content was
      // already delivered); a legacy/mock response without outcomes commits
      // all targeted devices, mirroring the Live Activity commit rule.
      const alertOutcomes = readAlertOutcomes(result);
      if (alertOutcomes == null) {
        for (const item of alertItems) {
          for (const deviceId of item.deviceIds ?? []) {
            lastSentBadgeByDevice.set(deviceId, badgeCount);
          }
        }
      } else {
        for (const outcome of alertOutcomes) {
          if (outcome.delivered || outcome.suppressed) {
            lastSentBadgeByDevice.set(outcome.deviceId, badgeCount);
          }
        }
      }
      if (laPlan) {
        // Commit the Live Activity plan only if its own targets landed. A mixed
        // publish can report delivered>0 from the alert while the LA push-to-start
        // failed; committing then would flip `liveActivityStarted` and the phone
        // would never get the start (later flushes send updates instead).
        const laOutcomes = readLiveActivityOutcomes(result);
        // ZERO liveactivity outcomes in a real outcomes array means the relay
        // had no APNs target (e.g. an update/end before the phone reported its
        // per-activity token) — nothing landed, so committing would dedupe the
        // new state and strand the Lock Screen on stale content. A missing
        // outcomes array (legacy relay / tests) keeps the commit.
        const landed = laOutcomes == null || laOutcomes.some((o) => o.delivered || o.suppressed);
        if (landed) {
          laPlan.commit();
        } else if (laOutcomes.some((o) => !o.delivered && !o.suppressed && !o.skipped)) {
          // Hard failure (not merely a missing push-to-start token) — retry the
          // start; an all-skipped or target-less LA is left for the next
          // event-driven flush (token arrival pokes one).
          scheduleRetry();
        }
      }
      deps.store.recordPublishResult({ at: new Date().toISOString() });
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
    if (disposed) return;
    const fireAt = now() + PUBLISH_RETRY_MS;
    if (flushTimer && flushFireAt > 0 && flushFireAt <= fireAt) return;
    if (flushTimer) clearTimeout(flushTimer);
    flushFireAt = fireAt;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushFireAt = 0;
      void runFlush();
    }, PUBLISH_RETRY_MS);
  };

  const runFlush = async (): Promise<void> => {
    if (disposed) return;
    if (flushing) {
      scheduleFlush(false);
      return;
    }
    flushing = true;
    try {
      await flush();
    } catch (error) {
      logWarn("push.flush_failed", error);
    } finally {
      flushing = false;
    }
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
    run.lastActiveAt = now();

    switch (event.type) {
      case "approval_request": {
        run.phase = "waiting_for_approval";
        run.detail = event.description ?? run.detail;
        run.itemId = event.itemId || null;
        enqueueAlert({
          sessionId,
          dedupeKey: `alert:${sessionId}:approval`,
          render: () => ({ title: `${runSubject(run)} needs your approval`, body: laneTitleLine(run) }),
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
        run.phase = "waiting_for_input";
        run.detail = event.question ?? run.detail;
        enqueueAlert({
          sessionId,
          dedupeKey: `alert:${sessionId}:question`,
          render: () => ({ title: `${runSubject(run)} has a question`, body: laneTitleLine(run) }),
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
          run.phase = "running";
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
          if (isTerminalPhase(run.phase)) run.phase = "running";
        } else if (event.turnStatus === "failed") {
          run.phase = "failed";
          enqueueFailedAlert(run);
        } else if (event.turnStatus === "completed" || event.turnStatus === "interrupted") {
          run.phase = "completed";
        }
        break;
      }
      case "done": {
        if (event.status === "failed") {
          run.phase = "failed";
          if (!run.model && event.model) run.model = event.model;
          enqueueFailedAlert(run);
        } else {
          run.phase = "completed";
        }
        break;
      }
      default: {
        if (!isTerminalPhase(run.phase) && run.phase === "starting") {
          run.phase = "running";
        }
        break;
      }
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
   * OSC 133-derived terminal state for tracked CLI sessions. Feeds the Live
   * Activity only — no alert pushes: a CLI agent returns to its prompt
   * (waiting-input) after EVERY turn, so alerting on it would ping the user
   * once per turn. Failure alerts stay with onPtyExit's non-zero-exit path.
   */
  const onCliRuntimeSignal = (scopeKey: string, signal: PushCliRuntimeSignal): void => {
    if (disposed || !signal.sessionId) return;
    const existing = runs.get(signal.sessionId);
    // Exit/kill phases are owned by onPtyExit (which knows the exit code).
    if (signal.runtimeState === "exited" || signal.runtimeState === "killed") return;
    const phase: AgentRunPhase = signal.runtimeState === "waiting-input" ? "waiting_for_input" : "running";
    // Signals re-fire on a ~10s heartbeat; only a phase change is worth a
    // Live Activity update (the run row shows phase, not output).
    if (existing && existing.kind === "cli" && existing.phase === phase) {
      existing.lastActiveAt = now();
      return;
    }
    // A chat run with the same session id would mean a chat-owned shell that
    // resolveCliSession failed to filter — never downgrade a chat run.
    if (existing && existing.kind === "chat") return;
    const run = ensureRun(signal.sessionId, scopeKey, "cli");
    run.lastActiveAt = now();
    run.phase = phase;
    if (!run.lane) {
      run.lane = scopes.get(scopeKey)?.resolveLaneName?.(signal.laneId) ?? signal.laneId ?? null;
    }
    scheduleFlush(false);
  };

  const onPtyExit = (scopeKey: string, event: PtyExitEvent & { laneId: string }): void => {
    // A tracked CLI run in the aggregate reaches its terminal phase here — the
    // runtime signal stream never reports exit codes.
    const run = runs.get(event.sessionId);
    if (run && run.kind === "cli") {
      run.phase = event.exitCode == null || event.exitCode === 0 ? "completed" : "failed";
      run.lastActiveAt = now();
      scheduleFlush(false);
    }
    // Keep it simple: only surface non-clean exits of tracked CLI sessions.
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

  const onPrNotification = (notification: PushPrNotification): void => {
    if (notification.kind === "merge_ready") {
      enqueueAlert({
        sessionId: null,
        dedupeKey: `alert:pr:${notification.prNumber}:merge_ready`,
        render: () => ({
          title: `PR #${notification.prNumber} is ready to merge`,
          body: notification.prTitle ?? "Required checks passed and it has approval.",
        }),
        deepLink: `ade://pr/${notification.prNumber}`,
        threadId: `pr-${notification.prNumber}`,
        phase: "terminal",
        interruptionLevel: "active",
      });
      scheduleFlush(false);
    } else if (notification.kind === "checks_failing") {
      enqueueAlert({
        sessionId: null,
        dedupeKey: `alert:pr:${notification.prNumber}:checks_failing`,
        render: () => ({
          title: `PR #${notification.prNumber} checks are failing`,
          body: notification.prTitle ?? "One or more required checks failed.",
        }),
        deepLink: `ade://pr/${notification.prNumber}`,
        threadId: `pr-${notification.prNumber}`,
        phase: "terminal",
        interruptionLevel: "active",
      });
      scheduleFlush(false);
    }
    // review_requested / changes_requested are intentionally not pushed.
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
    for (const [sessionId, run] of runs) {
      if (run.scopeKey === scopeKey) runs.delete(sessionId);
    }
    if (scopes.size === 0) {
      // Nothing attached — stop the flush loop so no timer lingers. The shared
      // instance stays memoized and resumes when a project re-attaches.
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      flushFireAt = 0;
      pendingAlerts = [];
    }
  };

  const dispose = (): void => {
    disposed = true;
    for (const scopeKey of [...scopes.keys()]) detachScope(scopeKey);
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
  };

  return {
    /** Warm the APNs-configured cache. Idempotent; safe to call per scope. */
    async start(): Promise<void> {
      if (disposed || warmed) return;
      warmed = true;
      void relayApnsConfigured().catch(() => {});
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
        scopeUnsubscribes.push(sources.subscribePrNotifications(onPrNotification));
      }
      scopes.set(scopeKey, {
        agentChatService: sources.agentChatService ?? null,
        resolveLaneName: sources.resolveLaneName,
        resolveCliSession: sources.resolveCliSession,
        unsubscribes: scopeUnsubscribes,
      });
      return () => detachScope(scopeKey);
    },

    /**
     * Entry point for ptyService's onSessionRuntimeSignal callback (a
     * create-time hook, not a subscription — bootstrap forwards it here).
     */
    handleCliRuntimeSignal(scopeKey: string, signal: PushCliRuntimeSignal): void {
      onCliRuntimeSignal(scopeKey, signal);
    },

    /** Force a flush soon (e.g. right after a device registers). */
    poke(): void {
      scheduleFlush(true);
    },

    async handleDeviceRegistered(registration: PushDeviceRegistration): Promise<PushDeliveryStatus> {
      await deps.relayClient.claim();
      await deps.relayClient.registerDevice(registration);
      deps.store.upsertDevice(registration);
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
      if (!disposed && liveActivityStarted && !isGated()) {
        try {
          const nowMs = now();
          const deviceIds = deps.store.listDevices()
            .filter((device) => Boolean(device.pushToStartToken) && shouldDeliverLiveActivityForPrefs(device.prefs))
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
