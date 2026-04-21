/**
 * Pure, side-effect-free mapping from ADE domain events to APNs envelopes.
 * The event bus is the only caller; keep this file easy to reason about in
 * isolation so mapping logic can be unit-tested without mocks.
 *
 * We intentionally only produce the APNs "shape" — payload body + push type +
 * priority + interruption-level. The bus decides which device(s) to target
 * and which kind of token (alert vs activity-update) to attach.
 */

import type { AgentChatEventEnvelope } from "../../../shared/types/chat";
import type { PrNotificationKind, PrSummary } from "../../../shared/types/prs";
import type { ApnsPriority, ApnsPushType } from "./apnsService";

export type NotificationInterruptionLevel = "active" | "time-sensitive" | "passive" | "critical";

export type NotificationCategory =
  | "CHAT_AWAITING_INPUT"
  | "CHAT_FAILED"
  | "CHAT_COMPLETED"
  | "CTO_SUBAGENT_STARTED"
  | "CTO_SUBAGENT_FINISHED"
  | "CTO_MISSION_PHASE"
  | "PR_CI_FAILING"
  | "PR_REVIEW_REQUESTED"
  | "PR_CHANGES_REQUESTED"
  | "PR_MERGE_READY"
  | "SYSTEM_PROVIDER_OUTAGE"
  | "SYSTEM_AUTH_RATE_LIMIT"
  | "SYSTEM_HOOK_FAILURE";

export type IosNotificationCategory =
  | "CHAT_AWAITING_INPUT"
  | "CHAT_FAILED"
  | "CHAT_TURN_COMPLETED"
  | "CTO_SUBAGENT_STARTED"
  | "CTO_SUBAGENT_FINISHED"
  | "CTO_MISSION_PHASE"
  | "PR_CI_FAILING"
  | "PR_REVIEW_REQUESTED"
  | "PR_CHANGES_REQUESTED"
  | "PR_MERGE_READY"
  | "SYSTEM_ALERT";

/**
 * The user-facing copy + APNs-shape hints. The bus completes this into a
 * full `ApnsEnvelope` by attaching a device token and topic.
 */
export type MappedNotification = {
  category: NotificationCategory;
  /** Category id registered by the iOS app. Defaults to `category` when omitted. */
  iosCategory?: IosNotificationCategory;
  /** Buckets above map to one of four high-level families in prefs. */
  family: "chat" | "cto" | "pr" | "system";
  title: string;
  body: string;
  pushType: ApnsPushType;
  priority: ApnsPriority;
  interruptionLevel: NotificationInterruptionLevel;
  /** APNs collapse-id for de-dup; e.g. `pr:#412:checks_failing`. */
  collapseId?: string;
  /** Deep link consumed by the iOS app when the banner is tapped. */
  deepLink?: string;
  /** Extra fields merged into the `aps.alert`-adjacent payload by the bus. */
  metadata?: Record<string, string | number | boolean | null>;
  /**
   * Indicates this mapped event should NOT generate a user-visible alert,
   * only a silent push (pushType: "background") — e.g. turn_completed when
   * the user wants stats without interruption. Bus may still skip based
   * on prefs.
   */
  silent?: boolean;
};

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function previewForChatEvent(event: AgentChatEventEnvelope["event"]): string {
  if (event.type === "text" && typeof event.text === "string") return truncate(event.text, 140);
  if (event.type === "reasoning" && typeof event.text === "string") return truncate(event.text, 140);
  if (event.type === "error") return truncate(event.message, 140);
  if (event.type === "system_notice") return truncate(event.message, 140);
  return "";
}

/**
 * Map one chat-event envelope into zero or more user-facing notifications.
 * Returns an empty array for events that should never surface as a push.
 */
export function mapChatEvent(envelope: AgentChatEventEnvelope): MappedNotification[] {
  const { event, sessionId } = envelope;
  const deepLink = `ade://session/${sessionId}`;
  // Attach sessionId to every chat-derived mapping so the iOS NotificationService
  // extension can set a per-session `threadIdentifier` and so the AppDelegate
  // action handler can resolve the session for Approve/Deny/Reply actions.
  const sessionMeta = { sessionId };

  switch (event.type) {
    case "approval_request": {
      return [
        {
          category: "CHAT_AWAITING_INPUT",
          family: "chat",
          title: "Awaiting approval",
          body: truncate(event.description || "Agent is waiting on your approval.", 178),
          pushType: "alert",
          priority: 10,
          interruptionLevel: "time-sensitive",
          collapseId: `chat:${sessionId}:approval`,
          deepLink,
          metadata: { ...sessionMeta, itemId: event.itemId, kind: event.kind },
        },
      ];
    }
    case "error": {
      return [
        {
          category: "CHAT_FAILED",
          family: "chat",
          title: "Chat error",
          body: truncate(event.message, 178),
          pushType: "alert",
          priority: 10,
          interruptionLevel: "active",
          collapseId: `chat:${sessionId}:error`,
          deepLink,
          metadata: sessionMeta,
        },
      ];
    }
    case "done": {
      if (event.status === "failed") {
        return [
          {
            category: "CHAT_FAILED",
            family: "chat",
            title: "Chat failed",
            body: truncate(
              previewForChatEvent(event) || `A chat turn failed in session ${sessionId}.`,
              178,
            ),
            pushType: "alert",
            priority: 10,
            interruptionLevel: "active",
            collapseId: `chat:${sessionId}:done-failed`,
            deepLink,
            metadata: sessionMeta,
          },
        ];
      }
      if (event.status === "completed") {
        return [
          {
            category: "CHAT_COMPLETED",
            iosCategory: "CHAT_TURN_COMPLETED",
            family: "chat",
            title: "Chat completed",
            body: truncate("The assistant finished replying.", 178),
            pushType: "alert",
            priority: 5,
            interruptionLevel: "passive",
            collapseId: `chat:${sessionId}:done`,
            deepLink,
            metadata: sessionMeta,
          },
        ];
      }
      return [];
    }
    case "status": {
      if (event.turnStatus === "completed") {
        return [
          {
            category: "CHAT_COMPLETED",
            iosCategory: "CHAT_TURN_COMPLETED",
            family: "chat",
            title: "Chat completed",
            body: truncate(event.message ?? "The assistant finished replying.", 178),
            pushType: "alert",
            priority: 5,
            interruptionLevel: "passive",
            collapseId: `chat:${sessionId}:status-completed`,
            deepLink,
            metadata: sessionMeta,
          },
        ];
      }
      if (event.turnStatus === "failed") {
        return [
          {
            category: "CHAT_FAILED",
            family: "chat",
            title: "Chat failed",
            body: truncate(event.message ?? "A chat turn failed.", 178),
            pushType: "alert",
            priority: 10,
            interruptionLevel: "active",
            collapseId: `chat:${sessionId}:status-failed`,
            deepLink,
            metadata: sessionMeta,
          },
        ];
      }
      return [];
    }
    case "system_notice": {
      const family = "system" as const;
      const base = {
        family,
        pushType: "alert" as ApnsPushType,
        priority: 5 as ApnsPriority,
        interruptionLevel: "active" as NotificationInterruptionLevel,
        deepLink,
        body: truncate(event.message, 178),
        collapseId: `system:${sessionId}:${event.noticeKind}`,
        metadata: sessionMeta,
      };
      if (event.noticeKind === "provider_health") {
        return [{ ...base, category: "SYSTEM_PROVIDER_OUTAGE", iosCategory: "SYSTEM_ALERT", title: "Provider issue" }];
      }
      if (event.noticeKind === "auth" || event.noticeKind === "rate_limit") {
        return [{ ...base, category: "SYSTEM_AUTH_RATE_LIMIT", iosCategory: "SYSTEM_ALERT", title: "Authentication required" }];
      }
      if (event.noticeKind === "hook") {
        return [{ ...base, category: "SYSTEM_HOOK_FAILURE", iosCategory: "SYSTEM_ALERT", title: "Hook failed" }];
      }
      return [];
    }
    case "subagent_started": {
      return [
        {
          category: "CTO_SUBAGENT_STARTED",
          iosCategory: "CTO_SUBAGENT_STARTED",
          family: "cto",
          title: "Sub-agent started",
          body: truncate(event.description || `Sub-agent ${event.taskId} started.`, 178),
          pushType: "alert",
          priority: 5,
          interruptionLevel: "passive",
          collapseId: `cto:${sessionId}:${event.taskId}:start`,
          deepLink,
          metadata: sessionMeta,
        },
      ];
    }
    case "subagent_result": {
      return [
        {
          category: "CTO_SUBAGENT_FINISHED",
          family: "cto",
          title: event.status === "failed" ? "Sub-agent failed" : "Sub-agent finished",
          body: truncate(event.summary || `Sub-agent ${event.taskId} ${event.status}.`, 178),
          pushType: "alert",
          priority: event.status === "failed" ? 10 : 5,
          interruptionLevel: event.status === "failed" ? "active" : "passive",
          collapseId: `cto:${sessionId}:${event.taskId}:result`,
          deepLink,
          metadata: sessionMeta,
        },
      ];
    }
    case "delegation_state": {
      return [
        {
          category: "CTO_MISSION_PHASE",
          family: "cto",
          title: "Mission phase changed",
          body: truncate(event.message ?? "Mission phase advanced.", 178),
          pushType: "alert",
          priority: 5,
          interruptionLevel: "passive",
          collapseId: `mission:${sessionId}:phase`,
          deepLink,
          metadata: sessionMeta,
        },
      ];
    }
    default:
      return [];
  }
}

function prHeadline(pr: PrSummary, suffix: string): string {
  const repo = pr.repoOwner && pr.repoName ? `${pr.repoOwner}/${pr.repoName}` : "";
  const numberPart = `#${pr.githubPrNumber}`;
  const base = repo ? `${repo} ${numberPart}` : numberPart;
  return `${base} — ${suffix}`;
}

/**
 * Map a PR state transition into APNs envelopes. The polling service sends
 * the `kind` it already computed; we translate it into user-facing copy.
 */
export function mapPrEvent(args: {
  kind: PrNotificationKind;
  pr: PrSummary;
  titleOverride?: string;
  messageOverride?: string;
}): MappedNotification[] {
  const { kind, pr } = args;
  const deepLink = `ade://pr/${pr.githubPrNumber}`;
  const family = "pr" as const;
  const collapseId = `pr:${pr.id}:${kind}`;

  switch (kind) {
    case "checks_failing":
      return [
        {
          category: "PR_CI_FAILING",
          family,
          title: args.titleOverride ?? prHeadline(pr, "CI failing"),
          body: truncate(
            args.messageOverride ?? `${pr.title ?? "Pull request"} has failing required checks.`,
            178,
          ),
          pushType: "alert",
          priority: 10,
          interruptionLevel: "active",
          collapseId,
          deepLink,
          metadata: { prId: pr.id, prNumber: pr.githubPrNumber, laneId: pr.laneId, githubUrl: pr.githubUrl },
        },
      ];
    case "review_requested":
      return [
        {
          category: "PR_REVIEW_REQUESTED",
          family,
          title: args.titleOverride ?? prHeadline(pr, "review requested"),
          body: truncate(
            args.messageOverride ?? `${pr.title ?? "Pull request"} is waiting for a review.`,
            178,
          ),
          pushType: "alert",
          priority: 5,
          interruptionLevel: "active",
          collapseId,
          deepLink,
          metadata: { prId: pr.id, prNumber: pr.githubPrNumber, laneId: pr.laneId, githubUrl: pr.githubUrl },
        },
      ];
    case "changes_requested":
      return [
        {
          category: "PR_CHANGES_REQUESTED",
          family,
          title: args.titleOverride ?? prHeadline(pr, "changes requested"),
          body: truncate(
            args.messageOverride ?? `Reviewer requested changes on ${pr.title ?? "this PR"}.`,
            178,
          ),
          pushType: "alert",
          priority: 10,
          interruptionLevel: "active",
          collapseId,
          deepLink,
          metadata: { prId: pr.id, prNumber: pr.githubPrNumber, laneId: pr.laneId, githubUrl: pr.githubUrl },
        },
      ];
    case "merge_ready":
      return [
        {
          category: "PR_MERGE_READY",
          family,
          title: args.titleOverride ?? prHeadline(pr, "ready to merge"),
          body: truncate(
            args.messageOverride ?? `${pr.title ?? "Pull request"} is approved and passing.`,
            178,
          ),
          pushType: "alert",
          priority: 5,
          interruptionLevel: "active",
          collapseId,
          deepLink,
          metadata: { prId: pr.id, prNumber: pr.githubPrNumber, laneId: pr.laneId, githubUrl: pr.githubUrl },
        },
      ];
    default:
      return [];
  }
}

export type MissionPhaseEvent = {
  missionId: string;
  phase: string;
  message?: string;
};

export function mapMissionEvent(event: MissionPhaseEvent): MappedNotification[] {
  return [
    {
      category: "CTO_MISSION_PHASE",
      family: "cto",
      title: "Mission phase changed",
      body: truncate(event.message ?? `Mission ${event.missionId} entered ${event.phase}.`, 178),
      pushType: "alert",
      priority: 5,
      interruptionLevel: "passive",
      collapseId: `mission:${event.missionId}:phase`,
      deepLink: `ade://mission/${event.missionId}`,
      metadata: { missionId: event.missionId, phase: event.phase },
    },
  ];
}

export type SystemEvent = {
  kind: "provider_outage" | "auth_rate_limit" | "hook_failure";
  title: string;
  message: string;
  deepLink?: string;
};

export function mapSystemEvent(event: SystemEvent): MappedNotification[] {
  const commonBody = truncate(event.message, 178);
  if (event.kind === "provider_outage") {
    return [
      {
        category: "SYSTEM_PROVIDER_OUTAGE",
        iosCategory: "SYSTEM_ALERT",
        family: "system",
        title: event.title,
        body: commonBody,
        pushType: "alert",
        priority: 5,
        interruptionLevel: "active",
        collapseId: "system:provider-outage",
        deepLink: event.deepLink,
      },
    ];
  }
  if (event.kind === "auth_rate_limit") {
    return [
      {
        category: "SYSTEM_AUTH_RATE_LIMIT",
        iosCategory: "SYSTEM_ALERT",
        family: "system",
        title: event.title,
        body: commonBody,
        pushType: "alert",
        priority: 10,
        interruptionLevel: "active",
        collapseId: "system:auth-rate-limit",
        deepLink: event.deepLink,
      },
    ];
  }
  return [
    {
      category: "SYSTEM_HOOK_FAILURE",
      iosCategory: "SYSTEM_ALERT",
      family: "system",
      title: event.title,
      body: commonBody,
      pushType: "alert",
      priority: 5,
      interruptionLevel: "passive",
      collapseId: "system:hook-failure",
      deepLink: event.deepLink,
    },
  ];
}

/**
 * Given a mapped notification, convert it into the JSON payload APNs expects.
 * Extracted so the event bus can call this after picking a device target.
 */
export function buildApnsPayload(mapped: MappedNotification): Record<string, unknown> {
  // `category` MUST be placed inside the `aps` dictionary — Apple's payload key
  // reference requires this so iOS maps it to a registered `UNNotificationCategory`
  // and renders the Approve/Deny/Reply/OpenPr/RetryChecks action buttons.
  // See: developer.apple.com/library/archive/documentation/NetworkingInternet/
  //      Conceptual/RemoteNotificationsPG/PayloadKeyReference.html
  const aps: Record<string, unknown> = {
    alert: mapped.silent ? undefined : { title: mapped.title, body: mapped.body },
    sound: mapped.interruptionLevel === "time-sensitive" ? "default" : undefined,
    "interruption-level": mapped.interruptionLevel,
    "thread-id": mapped.collapseId,
    "content-available": mapped.silent ? 1 : undefined,
    "mutable-content": 1,
    category: mapped.iosCategory ?? mapped.category,
  };
  // APNs rejects explicit `undefined` values; strip them here.
  for (const key of Object.keys(aps)) {
    if (aps[key] === undefined) delete aps[key];
  }
  return {
    aps,
    deepLink: mapped.deepLink ?? null,
    ...mapped.metadata,
  };
}

function parseTimeOfDayMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function zonedMinutes(nowMs: number, timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: timezone,
    }).formatToParts(new Date(nowMs));
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

function isWithinQuietHours(
  quietHours: {
    enabled: boolean;
    start: string;
    end: string;
    timezone: string;
  } | null | undefined,
  nowMs: number,
): boolean {
  if (!quietHours?.enabled) return false;
  const start = parseTimeOfDayMinutes(quietHours.start);
  const end = parseTimeOfDayMinutes(quietHours.end);
  const current = zonedMinutes(nowMs, quietHours.timezone);
  if (start == null || end == null || current == null || start === end) return false;
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

/** Decide whether a mapped notification is allowed by the supplied prefs. */
export function isAllowedByPrefs(
  mapped: MappedNotification,
  prefs: {
    enabled: boolean;
    chat: { awaitingInput: boolean; chatFailed: boolean; turnCompleted: boolean };
    cto: { subagentStarted: boolean; subagentFinished: boolean; missionPhaseChanged: boolean };
    prs: { ciFailing: boolean; reviewRequested: boolean; changesRequested: boolean; mergeReady: boolean };
    system: { providerOutage: boolean; authRateLimit: boolean; hookFailure: boolean };
    muteUntil?: string | null;
    quietHours?: {
      enabled: boolean;
      start: string;
      end: string;
      timezone: string;
    };
    perSessionOverrides?: Record<string, { muted?: boolean; awaitingInputOnly?: boolean }>;
  } | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!prefs || !prefs.enabled) return false;
  if (prefs.muteUntil) {
    const muteMs = Date.parse(prefs.muteUntil);
    if (Number.isFinite(muteMs) && muteMs > nowMs) return false;
  }
  if (isWithinQuietHours(prefs.quietHours, nowMs)) return false;
  const sessionId = typeof mapped.metadata?.sessionId === "string" ? mapped.metadata.sessionId : null;
  const sessionOverride = sessionId ? prefs.perSessionOverrides?.[sessionId] : null;
  if (sessionOverride?.muted) return false;
  if (sessionOverride?.awaitingInputOnly && mapped.category !== "CHAT_AWAITING_INPUT") return false;
  switch (mapped.category) {
    case "CHAT_AWAITING_INPUT":
      return prefs.chat.awaitingInput;
    case "CHAT_FAILED":
      return prefs.chat.chatFailed;
    case "CHAT_COMPLETED":
      return prefs.chat.turnCompleted;
    case "CTO_SUBAGENT_STARTED":
      return prefs.cto.subagentStarted;
    case "CTO_SUBAGENT_FINISHED":
      return prefs.cto.subagentFinished;
    case "CTO_MISSION_PHASE":
      return prefs.cto.missionPhaseChanged;
    case "PR_CI_FAILING":
      return prefs.prs.ciFailing;
    case "PR_REVIEW_REQUESTED":
      return prefs.prs.reviewRequested;
    case "PR_CHANGES_REQUESTED":
      return prefs.prs.changesRequested;
    case "PR_MERGE_READY":
      return prefs.prs.mergeReady;
    case "SYSTEM_PROVIDER_OUTAGE":
      return prefs.system.providerOutage;
    case "SYSTEM_AUTH_RATE_LIMIT":
      return prefs.system.authRateLimit;
    case "SYSTEM_HOOK_FAILURE":
      return prefs.system.hookFailure;
    default:
      return false;
  }
}
