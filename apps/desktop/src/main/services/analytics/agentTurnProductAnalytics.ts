import type { AgentChatTurnSettledEvent } from "../chat/agentChatService";
import type { ProductAnalyticsService } from "./productAnalyticsService";

type AgentTurnAnalytics = Pick<ProductAnalyticsService, "captureInternal">;

/**
 * One coarse adoption fact when a send's composer @-mentions were expanded
 * into pointer blocks. Identity only — no mention targets, titles, previews,
 * or counts. The installation-wide dedupe key plus a one-hour minimum interval
 * bounds this to at most 24 accepted events per UTC day, inside the existing
 * `ade_feature_used` and shared ceilings.
 */
export function captureChatMentionsExpandedAnalytics(args: {
  analytics: AgentTurnAnalytics;
  projectId: string;
  sessionId: string | null;
}): void {
  args.analytics.captureInternal({
    event: "ade_feature_used",
    surface: "api",
    projectId: args.projectId,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    dedupeKey: "chat_mention_expanded",
    minimumIntervalMs: 60 * 60_000,
    properties: {
      feature: "chat",
      action: "mention_expanded",
      outcome: "completed",
      source: "runtime",
    },
  });
}

export function captureAgentTurnSettledAnalytics(args: {
  analytics: AgentTurnAnalytics;
  projectId: string;
  event: AgentChatTurnSettledEvent;
}): void {
  const { analytics, projectId, event } = args;
  const feature = event.sessionSurface === "automation" ? "automations" : "chat";
  const outcome = event.status === "completed"
    ? "completed"
    : event.status === "interrupted"
      ? "cancelled"
      : "failure";

  analytics.captureInternal({
    event: "ade_work_session_completed",
    surface: "api",
    projectId,
    sessionId: event.sessionId,
    dedupeKey: `session-first-turn-settled:${event.sessionId}`,
    minimumIntervalMs: 31 * 24 * 60 * 60_000,
    properties: {
      feature,
      outcome,
      provider: event.provider,
      source: "runtime",
    },
  });

  if (event.status === "completed") {
    analytics.captureInternal({
      event: "ade_app_installed",
      surface: "api",
      properties: {
        install_source: "unknown",
      },
    });
    analytics.captureInternal({
      event: "ade_activated",
      surface: "api",
      projectId,
      sessionId: event.sessionId,
      properties: {
        trigger: "work_session_completed",
      },
    });
  }

  if (event.status !== "failed") return;
  analytics.captureInternal({
    event: "ade_error",
    surface: "api",
    projectId,
    sessionId: event.sessionId,
    dedupeKey: `turn-failed:${event.sessionId}:${event.turnId}`,
    minimumIntervalMs: 24 * 60 * 60_000,
    properties: {
      feature,
      error_kind: "other",
      outcome: "failure",
      recoverable: true,
      source: "runtime",
    },
  });
}
