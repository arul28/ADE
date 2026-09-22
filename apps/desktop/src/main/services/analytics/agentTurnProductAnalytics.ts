import type { AgentChatTurnSettledEvent, ChatHandoffReplayOutcome } from "../chat/agentChatService";
import type { ChatAutoResumeAnalyticsProperties } from "../chat/chatAutoResumeCoordinator";
import type { ProductAnalyticsService } from "./productAnalyticsService";

type AgentTurnAnalytics = Pick<ProductAnalyticsService, "captureInternal">;

export function captureSessionMetadataRegeneratedAnalytics(args: {
  analytics: AgentTurnAnalytics;
  projectId: string;
  event: { sessionId: string; outcome: "completed" | "partial" | "failed" };
}): void {
  args.analytics.captureInternal({
    event: "ade_feature_used",
    surface: "api",
    projectId: args.projectId,
    sessionId: args.event.sessionId,
    properties: {
      feature: "chat",
      action: "metadata_regenerated",
      outcome: args.event.outcome,
      source: "runtime",
    },
  });
}

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

/**
 * One coarse fact for what became of a handoff's transcript replay.
 *
 * The product question is whether a cross-provider handoff actually carries the
 * conversation: whole (`fit`), in part (`truncated`), not at all (`refused`),
 * or only after ADE re-sent it with less history (`retried` / `gave_up`).
 * `provider` is the existing coarse target-provider key — never a model name,
 * a turn count, a share, or any transcript. Deduped per chat and outcome with a
 * one-hour minimum interval, so a chat that overflows repeatedly reports the
 * shape of the failure once an hour rather than once a message.
 */
export function captureChatHandoffReplayAnalytics(args: {
  analytics: AgentTurnAnalytics;
  projectId: string;
  event: {
    sessionId: string;
    outcome: ChatHandoffReplayOutcome;
    provider: string;
  };
}): void {
  args.analytics.captureInternal({
    event: "ade_feature_used",
    surface: "api",
    projectId: args.projectId,
    sessionId: args.event.sessionId,
    dedupeKey: `chat_handoff_replay:${args.event.sessionId}:${args.event.outcome}`,
    minimumIntervalMs: 60 * 60_000,
    properties: {
      feature: "chat",
      action: "handoff_replay",
      outcome: args.event.outcome,
      provider: args.event.provider,
      source: "runtime",
    },
  });
}

/**
 * One coarse fact per auto-resume transition, so the product question — does
 * auto-resume actually rescue a chat a usage limit stopped? — can be answered
 * from `armed` versus `resumed` versus `paused`.
 *
 * No project or session id, deliberately: unlike the turn-settled events this
 * file's other producers emit, nothing here is scoped to a chat or a repo, and
 * the arm cap already bounds the volume without a per-session dedupe key. The
 * coordinator hands over the whole closed property set, so this function cannot
 * widen it.
 */
export function captureChatAutoResumeAnalytics(args: {
  analytics: AgentTurnAnalytics;
  properties: ChatAutoResumeAnalyticsProperties;
}): void {
  args.analytics.captureInternal({
    event: "ade_feature_used",
    surface: "api",
    properties: { feature: "work", ...args.properties },
  });
}

/**
 * One coarse fact when this client's Claude hooks were ignored because
 * another client already configured the joined session. Identity only —
 * no hook names, payloads, or transcripts. Dedupe per session with a
 * one-hour minimum interval.
 */
export function captureClaudeHooksIgnoredAnalytics(args: {
  analytics: AgentTurnAnalytics;
  projectId: string;
  event: { sessionId: string };
}): void {
  args.analytics.captureInternal({
    event: "ade_feature_used",
    surface: "api",
    projectId: args.projectId,
    sessionId: args.event.sessionId,
    dedupeKey: `chat_hooks_ignored:${args.event.sessionId}`,
    minimumIntervalMs: 60 * 60_000,
    properties: {
      feature: "chat",
      action: "hooks_ignored",
      outcome: "failed",
      provider: "claude",
      source: "runtime",
    },
  });
}

/**
 * One coarse fact when the CLI reports it did not apply every plugin a query
 * carried. The plugins are ADE's agent-skill roots, so a miss means the
 * session silently lacks them. Identity only — no plugin names, paths, or
 * counts. Dedupe per session with a one-hour minimum interval, the same shape
 * as the hooks-ignored fact it sits beside.
 */
export function captureClaudePluginsIgnoredAnalytics(args: {
  analytics: AgentTurnAnalytics;
  projectId: string;
  event: { sessionId: string };
}): void {
  args.analytics.captureInternal({
    event: "ade_feature_used",
    surface: "api",
    projectId: args.projectId,
    sessionId: args.event.sessionId,
    dedupeKey: `chat_plugins_ignored:${args.event.sessionId}`,
    minimumIntervalMs: 60 * 60_000,
    properties: {
      feature: "chat",
      action: "plugins_ignored",
      outcome: "failed",
      provider: "claude",
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
