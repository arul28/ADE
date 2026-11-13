import type {
  AgentChatTurnErrorCategory,
  AgentChatTurnSettledEvent,
  ChatHandoffReplayOutcome,
} from "../chat/agentChatService";
import type { AppleDeviceAnalyticsOutcome } from "../../../shared/types/iosSimulator";
import type { AndroidDeviceAnalyticsOutcome } from "../../../shared/types/androidEmulator";
import type { ChatAutoResumeAnalyticsProperties } from "../chat/chatAutoResumeCoordinator";
import type { CrossMachineMoveOutcome } from "../chat/crossMachineHandoffOrchestrator";
import type { MacDesktopAnalyticsProperties } from "../macDesktop/macDesktopService";
import type { ProductAnalyticsService } from "./productAnalyticsService";
import { derivedEventId } from "./analyticsEventId";
import { detectInstallSource } from "./installSource";
import { classifyProviderAccountRefusal } from "../../../shared/providerAccountRefusal";

type AgentTurnAnalytics = Pick<ProductAnalyticsService, "captureInternal">;

/**
 * One fact per mode and outcome per installation an hour. The status line is
 * regenerated after most turns, so without the limit this was a quarter of the
 * events of the installs that reached their daily budget, and pushed out what
 * people did.
 */
export function captureSessionMetadataRegeneratedAnalytics(args: {
  analytics: AgentTurnAnalytics;
  projectId: string;
  event: { sessionId: string; outcome: "completed" | "partial" | "failed"; automatic: boolean };
}): void {
  const mode = args.event.automatic ? "automatic" : "manual";
  args.analytics.captureInternal({
    event: "ade_feature_used",
    surface: "api",
    projectId: args.projectId,
    sessionId: args.event.sessionId,
    dedupeKey: `chat_metadata_regenerated:${mode}:${args.event.outcome}`,
    minimumIntervalMs: 60 * 60_000,
    properties: {
      feature: "chat",
      action: "metadata_regenerated",
      outcome: args.event.outcome,
      mode,
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

/** What became of a side chat step; see `side_chat` in the policy. */
export type ChatSideChatOutcome = "started" | "delivered" | "failed";

/**
 * One coarse fact per side chat step: opened, or a message it sent to its main
 * chat delivered or lost. The product question is whether people use side
 * chats and whether "send this to the agent" works. `provider` is the coarse
 * slug. Deduped per chat and outcome with a ten-minute minimum interval: a
 * side chat is opened once and sends only when the user asks, so realistic
 * volume is a few events per installation per day.
 */
export function captureChatSideChatAnalytics(args: {
  analytics: AgentTurnAnalytics;
  projectId: string;
  event: {
    sessionId: string;
    outcome: ChatSideChatOutcome;
    provider: string;
  };
}): void {
  args.analytics.captureInternal({
    event: "ade_feature_used",
    surface: "api",
    projectId: args.projectId,
    sessionId: args.event.sessionId,
    dedupeKey: `chat_side_chat:${args.event.sessionId}:${args.event.outcome}`,
    minimumIntervalMs: 10 * 60_000,
    properties: {
      feature: "chat",
      action: "side_chat",
      outcome: args.event.outcome,
      provider: args.event.provider,
      source: "runtime",
    },
  });
}

/**
 * One coarse fact per ended context compaction.
 *
 * The product questions are whether compaction works and how often people ask
 * for it: `outcome` is `completed` or `failed`, `mode` is `manual` (the user
 * asked) or `automatic` (the provider or ADE's fallback did it). `compact_first`
 * marks a compaction the user turned on with the "Compact first" pill. Nothing
 * finer crosses the boundary: no token counts, summary, failure text, account,
 * or model. Deduped per chat, action, outcome and mode with a ten-minute
 * minimum interval, so a chat that compacts repeatedly reports once per window.
 */
export function captureChatCompactionAnalytics(args: {
  analytics: AgentTurnAnalytics;
  projectId: string;
  event: {
    sessionId: string;
    action: "compaction" | "compact_first";
    outcome: "completed" | "failed";
    mode: "manual" | "automatic";
    provider: string;
  };
}): void {
  const { sessionId, action, outcome, mode, provider } = args.event;
  args.analytics.captureInternal({
    event: "ade_feature_used",
    surface: "api",
    projectId: args.projectId,
    sessionId,
    dedupeKey: `chat_${action}:${sessionId}:${outcome}:${mode}`,
    minimumIntervalMs: 10 * 60_000,
    properties: {
      feature: "chat",
      action,
      outcome,
      mode,
      provider,
      source: "runtime",
    },
  });
}

/**
 * One coarse fact per terminal state of a move to another machine.
 *
 * The product question is whether moving a chat to another machine works:
 * it continued there, failed, was cancelled (kept here, denied, or dismissed),
 * or ended unknown (the answer was lost). Nothing finer crosses the boundary:
 * no session or handoff id, no machine name, no reason, branch, or capsule
 * content. The handoff id only keys the local dedupe (hashed, never sent), so
 * each move reports each outcome at most once an hour.
 */
export function captureCrossMachineMoveAnalytics(args: {
  analytics: AgentTurnAnalytics;
  projectId: string;
  event: { handoffId: string; outcome: CrossMachineMoveOutcome };
}): void {
  args.analytics.captureInternal({
    event: "ade_feature_used",
    surface: "api",
    projectId: args.projectId,
    dedupeKey: `cross_machine_move:${args.event.handoffId}:${args.event.outcome}`,
    minimumIntervalMs: 60 * 60_000,
    properties: {
      feature: "chat",
      action: "cross_machine_move",
      outcome: args.event.outcome,
      source: "runtime",
    },
  });
}

/**
 * A chat started work on another machine: a command or a simulator there.
 *
 * The product question is whether people use their other machines from a
 * chat. The session and machine only key the local dedupe (hashed, never
 * sent), so each chat counts at most once an hour for each machine.
 */
export function captureRemoteWorkAnalytics(args: {
  analytics: AgentTurnAnalytics;
  projectId: string;
  event: { sessionId: string; machineKey: string };
}): void {
  args.analytics.captureInternal({
    event: "ade_feature_used",
    surface: "api",
    projectId: args.projectId,
    dedupeKey: `remote_work:${args.event.sessionId}:${args.event.machineKey}`,
    minimumIntervalMs: 60 * 60_000,
    properties: {
      feature: "chat",
      action: "remote_work",
      outcome: "started",
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
    // Arming, resuming and pausing all happen with nobody at the keyboard.
    properties: { feature: "work", mode: "automatic", ...args.properties },
  });
}

/** One accepted Mac Desktop fact per outcome per installation per UTC day. */
export const MAC_DESKTOP_ANALYTICS_MIN_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * One coarse fact for the lane's Mac Desktop: a display was created, an agent
 * drove it, or a recording was filed as proof.
 *
 * The service hands over the closed outcome and nothing else, so this function
 * cannot widen the payload. The dedupe key is the outcome alone — no lane, chat,
 * app, path, or window — and the service salts and hashes it locally. Worst
 * case is three accepted events per installation per UTC day, inside the
 * existing `ade_feature_used` limits. No ceiling was raised.
 */
export function captureMacDesktopAnalytics(args: {
  analytics: AgentTurnAnalytics;
  properties: MacDesktopAnalyticsProperties;
}): void {
  const outcome = args.properties.outcome;
  args.analytics.captureInternal({
    event: "ade_feature_used",
    surface: "api",
    dedupeKey: `work_mac_desktop:${outcome}`,
    minimumIntervalMs: MAC_DESKTOP_ANALYTICS_MIN_INTERVAL_MS,
    properties: { feature: "work", action: "mac_desktop", outcome },
  });
}

/**
 * One coarse fact for the Apple panel (`APPLE_DEVICE_ANALYTICS_OUTCOMES`), per
 * outcome per installation per UTC day: the service hands over the closed
 * outcome and nothing else. Worst case six accepted events a day, inside the
 * existing `ade_feature_used` limits. No ceiling was raised.
 */
export function captureAppleDeviceAnalytics(args: {
  analytics: AgentTurnAnalytics;
  outcome: AppleDeviceAnalyticsOutcome;
}): void {
  args.analytics.captureInternal({
    event: "ade_feature_used",
    surface: "api",
    dedupeKey: `work_apple_device:${args.outcome}`,
    minimumIntervalMs: MAC_DESKTOP_ANALYTICS_MIN_INTERVAL_MS,
    properties: { feature: "work", action: "apple_device", outcome: args.outcome },
  });
}

/**
 * One coarse fact for the Android panel (`ANDROID_DEVICE_ANALYTICS_OUTCOMES`),
 * per outcome per installation per UTC day, the same way as the Apple panel.
 * Worst case six accepted events a day. No ceiling was raised.
 */
export function captureAndroidDeviceAnalytics(args: {
  analytics: AgentTurnAnalytics;
  outcome: AndroidDeviceAnalyticsOutcome;
}): void {
  args.analytics.captureInternal({
    event: "ade_feature_used",
    surface: "api",
    dedupeKey: `work_android_device:${args.outcome}`,
    minimumIntervalMs: MAC_DESKTOP_ANALYTICS_MIN_INTERVAL_MS,
    properties: { feature: "work", action: "android_device", outcome: args.outcome },
  });
}

/**
 * Whether an installation lets agents use the user's own browser at all: one
 * coarse fact, a successful `ade browser attach`. Never the browser, the
 * machine, the tab, its URL or title, or the chat.
 */
export type UserBrowserAnalyticsProperties = {
  action: "user_browser";
  outcome: "started";
};

/**
 * The attach fact, deduplicated per UTC day like the Mac Desktop facts, so
 * the worst case is one accepted event per installation per day.
 */
export function captureUserBrowserAnalytics(args: {
  analytics: AgentTurnAnalytics;
  properties: UserBrowserAnalyticsProperties;
}): void {
  args.analytics.captureInternal({
    event: "ade_feature_used",
    surface: "api",
    dedupeKey: "work_user_browser:started",
    minimumIntervalMs: MAC_DESKTOP_ANALYTICS_MIN_INTERVAL_MS,
    properties: { feature: "work", action: "user_browser", outcome: "started" },
  });
}

/**
 * The whole App Control analytics payload: a session started on a lane, an
 * agent drove it, or a recording was filed as proof. Nothing about the lane,
 * the chat, the app, its command or its window can be added without changing
 * the type.
 */
export type AppControlAnalyticsProperties = {
  action: "app_control";
  outcome: "started" | "agent_drove" | "recorded";
};

/**
 * One coarse App Control fact, the Mac Desktop fact's twin: the dedupe key is
 * the outcome alone and the interval is a UTC day, so the worst case is three
 * accepted events per installation per day. Emitted by the brain wiring (the
 * session-started event and the RPC dispatch), never by the service, which
 * holds no analytics handle.
 */
export function captureAppControlAnalytics(args: {
  analytics: AgentTurnAnalytics | null | undefined;
  outcome: AppControlAnalyticsProperties["outcome"];
}): void {
  // Called on the action path: a broken analytics handle must never fail the
  // action it describes.
  try {
    args.analytics?.captureInternal({
      event: "ade_feature_used",
      surface: "api",
      dedupeKey: `work_app_control:${args.outcome}`,
      minimumIntervalMs: MAC_DESKTOP_ANALYTICS_MIN_INTERVAL_MS,
      properties: { feature: "work", action: "app_control", outcome: args.outcome },
    });
  } catch {
    // Dropped: analytics is best-effort.
  }
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

/** A failed turn's `error_kind`: its error's category, in the policy's buckets. */
const TURN_ERROR_KIND: Readonly<Record<AgentChatTurnErrorCategory, TurnFailureKind>> = {
  auth: "permission",
  agent_cli_auth: "permission",
  rate_limit: "rate_limit",
  budget: "budget",
  network: "network",
  busy: "busy",
  agent_cli_missing: "cli_missing",
  unknown: "other",
};

/**
 * The closed set a failed turn's `error_kind` takes (`ade_error`, and
 * `$ai_generation`). The provider classifier's categories, plus six read off
 * the error's own words where the classifier has no category for them: most
 * failed turns were `network` or `other`, which hid the overloaded server and
 * the conversation that outgrew its model behind one bucket.
 */
export const TURN_FAILURE_KINDS = [
  "permission", "rate_limit", "budget", "network", "busy", "cli_missing",
  "timeout", "server_overloaded", "context_too_long", "model_unavailable", "process_exited",
  // The provider is signed in but the plan does not include this (Kimi Code,
  // Cursor Cloud Agents). Read before the category: these refusals also say
  // "authentication required" and carry a 403.
  "plan",
  "other",
] as const;
export type TurnFailureKind = (typeof TURN_FAILURE_KINDS)[number];

/**
 * What an error's own words say, for the errors the classifier files under a
 * catch-all. The first row that matches wins, so a row sits above any row
 * whose words it can also contain.
 */
const TEXT_KINDS: ReadonlyArray<readonly [RegExp, TurnFailureKind]> = [
  // A turn sent while one runs. First: the message can quote the running turn's error.
  [/turn (?:is )?already active|already has an active (?:writer|run)|is still responding/i, "busy"],
  // A conversation or an answer the model could not fit (OpenCode's compaction
  // too). Above the usage limit, whose "limit reached" also matches
  // "context limit reached" and "output token limit reached".
  [/context (?:length|window|limit)|prompt is too long|input is too long|too many (?:input )?tokens|maximum context|context_length_exceeded|exceeds? (?:the )?(?:model'?s? )?(?:maximum )?context|output token limit|compaction (?:summary|produced)|still truncated|max_context|exceeds processor budget/i, "context_too_long"],
  // A plan's usage limit. Codex writes "You’ve hit your usage limit" with a typographic apostrophe.
  [/usage limit|limit (?:has been )?reached|hit your (?:\w+ )?limit/i, "rate_limit"],
  // An account with no money left.
  [/insufficient (?:account )?(?:funds|credits?|balance)|out of credits|payment required|billing/i, "budget"],
  // A model the provider does not serve. Above the overloaded server, which
  // shares "unavailable" and "capacity".
  [/model\b[^\n]{0,60}\b(?:not found|not available|unavailable|does not exist|not supported|unsupported|deprecated|retired)|unknown model|invalid model|model_not_found|no such model|model unavailable|not in the catalog|model is at capacity|hosted outside/i, "model_unavailable"],
  // A local model server that is not running.
  [/connection ?refused|ECONNREFUSED|unable to connect|no models are currently loaded|is the computer able to access/i, "network"],
  [/overloaded|\b(?:500|502|503|529)\b|service unavailable|bad gateway|internal server error|server error|over capacity/i, "server_overloaded"],
  // "Codex app-server exited (code=1, signal=null)", an ACP agent whose pipe closed, a dead SDK worker.
  [/exited with (?:code|signal)|process exited|exited unexpectedly|terminated unexpectedly|was killed|\bSIG(?:KILL|TERM|SEGV|ABRT)\b|crashed|\bexited \((?:code|signal)=|worker exited|ACP connection closed|stdin is not writable|\bEPIPE\b/i, "process_exited"],
  // Cut connections the classifier did not name.
  [/ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network (?:error|request failed)|getaddrinfo/i, "network"],
  // Last: many of the errors above also say that something timed out. ADE's
  // own waits say "did not answer within".
  [/timed? ?out|timeout|deadline exceeded|ETIMEDOUT|did not answer within|did not (?:become ready|respond) in time/i, "timeout"],
];

/**
 * A failed turn's `error_kind`, from the provider classifier's category and the
 * error's message. Pure and content-free on the way out: only one of
 * {@link TURN_FAILURE_KINDS} leaves, never the text it was read from.
 */
export function turnFailureKind(
  category: AgentChatTurnErrorCategory | null | undefined,
  text: string | null | undefined,
): TurnFailureKind {
  const words = text ?? "";
  const refusal = classifyProviderAccountRefusal(words);
  // A plan refusal reads as a sign-in to the classifier (a 403, "authentication
  // required"), but signing in again does not fix it.
  if (refusal === "plan") return "plan";
  const fromCategory = category ? TURN_ERROR_KIND[category] : "other";
  // A category the classifier is sure of (a sign-in, a rate limit) wins; the
  // words only refine its two catch-alls.
  if (fromCategory !== "network" && fromCategory !== "other") return fromCategory;
  // The same sign-in words provider health reads (an invalid token, a 401 in
  // any wording), for turns whose runtime gave no category.
  if (refusal === "auth") return "permission";
  const fromText = TEXT_KINDS.find(([pattern]) => pattern.test(words))?.[1];
  if (fromText) return fromText;
  if (refusal === "model") return "model_unavailable";
  return fromCategory;
}

function failedTurnKind(event: AgentChatTurnSettledEvent): TurnFailureKind {
  return event.errorKind ?? (event.errorCategory ? TURN_ERROR_KIND[event.errorCategory] : "other");
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

  // Every turn, not just the first: PostHog's LLM analytics (cost, tokens,
  // latency and failures per provider and model). A stable id per turn makes a
  // repeated settle notification one event in PostHog.
  analytics.captureInternal({
    event: "$ai_generation",
    surface: "api",
    projectId,
    sessionId: event.sessionId,
    clientEventId: derivedEventId(`ai-generation:${event.sessionId}`, event.turnId),
    aiGeneration: {
      provider: event.provider,
      model: event.model ?? null,
      status: event.status,
      feature,
      inputTokens: event.usage?.inputTokens ?? null,
      outputTokens: event.usage?.outputTokens ?? null,
      cacheReadTokens: event.usage?.cacheReadTokens ?? null,
      cacheCreationTokens: event.usage?.cacheCreationTokens ?? null,
      reasoningTokens: event.usage?.reasoningTokens ?? null,
      costUsd: event.costUsd ?? null,
      durationMs: event.durationMs ?? null,
      errorKind: event.status === "failed" ? failedTurnKind(event) : null,
    },
  });

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
        // The brain can be the first to record the install (a brain-only
        // machine, or a desktop whose own attempt lost the state lock), so it
        // reads its own location rather than reporting "unknown".
        install_source: detectInstallSource({
          isPackaged: true,
          execPath: process.execPath,
          configuredSource: process.env.ADE_INSTALL_SOURCE,
        }),
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
      error_kind: failedTurnKind(event),
      outcome: "failure",
      recoverable: true,
      source: "runtime",
    },
  });
}
