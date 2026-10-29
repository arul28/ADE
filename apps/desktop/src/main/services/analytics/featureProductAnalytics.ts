import { isClaudePromptCacheTtl } from "../../../shared/claudePromptCache";
import type {
  ProductAnalyticsCapture,
  ProductAnalyticsPropertyValue,
  ProductAnalyticsSurface,
} from "../../../shared/types/productAnalytics";
export type FeatureAnalytics = {
  captureInternal(input: ProductAnalyticsCapture): unknown;
};

const FEATURE_EVENT = "ade_feature_used" as const;
const FEATURE_DEDUPE_INTERVAL_MS = 60 * 60_000;

export type FeatureAnalyticsName =
  | "provider_accounts"
  | "api_credentials"
  | "presets"
  | "proxy"
  | "usage"
  | "chat"
  | "work"
  | "automations"
  | "attention"
  | "home"
  | "mcp_servers"
  | "ade_mcp";

export type FeatureAnalyticsAction =
  | "account_created"
  | "account_removed"
  | "account_signed_out"
  | "default_selected"
  | "balance_changed"
  | "auto_start_changed"
  | "subagent_cache_changed"
  | "main_cache_changed"
  | "extra_usage_stop_changed"
  | "credential_stored"
  | "credential_removed"
  | "preset_created"
  | "preset_deleted"
  | "sign_in"
  | "start"
  | "stop"
  | "reset_credit_consumed"
  | "model_price_changed"
  | "model_mapping_changed"
  | "pending_input_dismissed"
  | "account_switched"
  | "new_lane_launch"
  | "voice_conversation_started"
  | "session_continue_chat"
  | "session_copy_chat"
  | "session_continue_cli"
  | "session_copy_cli"
  | "webhook_url_created"
  | "safe_test_started"
  | "live_test_started"
  | "secret_requested"
  | "notification_sent"
  | "music_connected"
  | "spotify_connected"
  | "server_toggled"
  | "app_connected"
  | "token_created"
  | "connection_removed";

export type FeatureAnalyticsOutcome =
  | "completed"
  | "enabled"
  | "disabled"
  | "success"
  | "nothing_to_reset"
  | "no_credit"
  | "already_redeemed"
  | "cancelled"
  | "failed"
  | "kept"
  | "skipped_budget";

/**
 * Convert provider-shaped input to the existing closed provider-family set.
 * The input is used only for this mapping; it is never put in a payload.
 */
export function coarseProviderFamily(value: unknown): string {
  if (typeof value !== "string") return "other";
  switch (value.trim().toLowerCase()) {
    case "codex":
      return "codex";
    case "openai":
      return "openai";
    case "claude":
    case "anthropic":
      return "claude";
    case "cursor":
      return "cursor";
    case "droid":
      return "droid";
    case "opencode":
      return "opencode";
    case "pi":
      return "pi";
    case "muse":
      return "muse";
    case "gemini":
    case "google":
      return "gemini";
    case "lmstudio":
      return "lmstudio";
    case "local":
    case "ollama":
      return "local";
    default:
      return "other";
  }
}

export function captureFeatureUsedAnalytics(args: {
  analytics: FeatureAnalytics | null | undefined;
  surface: ProductAnalyticsSurface;
  feature: FeatureAnalyticsName;
  action: FeatureAnalyticsAction;
  outcome: FeatureAnalyticsOutcome;
  provider?: unknown;
  sessionId?: string | null;
}): void {
  if (!args.analytics) return;
  const provider = args.provider === undefined ? undefined : coarseProviderFamily(args.provider);
  const sessionId = args.sessionId?.trim() || undefined;
  const properties: Record<string, ProductAnalyticsPropertyValue> = {
    feature: args.feature,
    action: args.action,
    outcome: args.outcome,
    ...(provider ? { provider } : {}),
  };
  const dedupeProvider = provider ? `:${provider}` : "";
  args.analytics.captureInternal({
    event: FEATURE_EVENT,
    surface: args.surface,
    ...(sessionId ? { sessionId } : {}),
    dedupeKey: `feature:${args.feature}:${args.action}:${args.outcome}${dedupeProvider}${sessionId ? `:${sessionId}` : ""}`,
    minimumIntervalMs: FEATURE_DEDUPE_INTERVAL_MS,
    properties,
  } satisfies ProductAnalyticsCapture);
}

type ProviderAccountAnalyticsAction = Extract<
  FeatureAnalyticsAction,
  | "account_created"
  | "account_removed"
  | "account_signed_out"
  | "default_selected"
  | "balance_changed"
  | "auto_start_changed"
  | "subagent_cache_changed"
  | "extra_usage_stop_changed"
  | "main_cache_changed"
>;

type ProviderAccountAnalyticsOutcome = Extract<
  FeatureAnalyticsOutcome,
  "completed" | "enabled" | "disabled"
>;

/**
 * Provider-account analytics is captured per entry point rather than inside the
 * store: the store lives in the CLI package and cannot reach the desktop
 * analytics sink. The two entry points are the desktop UI's own IPC handlers
 * (surface "desktop") and the ADE actions domain (surface "api"); neither runs
 * through the other, so there is no double capture. Each binds its own surface
 * once here and then captures with a three-argument call, which is why the two
 * call sites cannot drift apart. It is the only feature with a surface-bound
 * factory because it is the only one captured from two entry points with
 * distinct surfaces; every other wrapper below has a single surface per call
 * and takes it as a plain argument.
 */
export function providerAccountAnalyticsCapture(
  analytics: FeatureAnalytics | null | undefined,
  surface: ProductAnalyticsSurface,
): (
  action: ProviderAccountAnalyticsAction,
  outcome: ProviderAccountAnalyticsOutcome,
  provider: unknown,
) => void {
  return (action, outcome, provider) => {
    captureFeatureUsedAnalytics({
      analytics,
      surface,
      feature: "provider_accounts",
      action,
      outcome,
      provider,
    });
  };
}

export function captureApiCredentialAnalytics(args: {
  analytics: FeatureAnalytics | null | undefined;
  surface: ProductAnalyticsSurface;
  action: Extract<FeatureAnalyticsAction, "credential_stored" | "credential_removed">;
  provider: unknown;
}): void {
  captureFeatureUsedAnalytics({
    ...args,
    feature: "api_credentials",
    outcome: "completed",
  });
}

export function capturePresetAnalytics(args: {
  analytics: FeatureAnalytics | null | undefined;
  surface: ProductAnalyticsSurface;
  action: Extract<FeatureAnalyticsAction, "preset_created" | "preset_deleted">;
  provider: unknown;
}): void {
  captureFeatureUsedAnalytics({
    ...args,
    feature: "presets",
    outcome: "completed",
  });
}

/** The outcomes a reset-credit spend can report, named for its callers. */
export type ResetCreditAnalyticsOutcome = Extract<
  FeatureAnalyticsOutcome,
  "completed" | "nothing_to_reset" | "no_credit" | "already_redeemed" | "failed"
>;

export function captureResetCreditAnalytics(args: {
  analytics: FeatureAnalytics | null | undefined;
  surface: ProductAnalyticsSurface;
  outcome: ResetCreditAnalyticsOutcome;
  /** The provider whose credit was spent; omitted when no account was named. */
  provider?: "claude" | "codex";
}): void {
  captureFeatureUsedAnalytics({
    ...args,
    feature: "usage",
    action: "reset_credit_consumed",
  });
}

/**
 * A price the user set (`enabled`) or cleared back to automatic (`disabled`)
 * on the Usage page, or a "Map to" added or removed. Never the model id or
 * the rates.
 */
export function captureModelPriceAnalytics(args: {
  analytics: FeatureAnalytics | null | undefined;
  surface: ProductAnalyticsSurface;
  action: Extract<FeatureAnalyticsAction, "model_price_changed" | "model_mapping_changed">;
  outcome: Extract<FeatureAnalyticsOutcome, "enabled" | "disabled">;
}): void {
  captureFeatureUsedAnalytics({ ...args, feature: "usage" });
}

export function capturePendingInputDismissedAnalytics(args: {
  analytics: FeatureAnalytics | null | undefined;
  surface: ProductAnalyticsSurface;
  provider: unknown;
}): void {
  captureFeatureUsedAnalytics({
    ...args,
    feature: "chat",
    action: "pending_input_dismissed",
    outcome: "completed",
  });
}

/**
 * How a browser sign-in to an MCP server ended. Never the server's name, its
 * URL, the authorization server, or the token.
 */
export function captureMcpServerSignInAnalytics(args: {
  analytics: FeatureAnalytics | null | undefined;
  surface: ProductAnalyticsSurface;
  outcome: Extract<FeatureAnalyticsOutcome, "completed" | "cancelled" | "failed">;
}): void {
  captureFeatureUsedAnalytics({ ...args, feature: "mcp_servers", action: "sign_in" });
}

/** A private webhook URL was made (with or without its automation). */
export function captureWebhookUrlCreatedAnalytics(args: {
  analytics: FeatureAnalytics | null | undefined;
  surface: ProductAnalyticsSurface;
}): void {
  captureFeatureUsedAnalytics({ ...args, feature: "automations", action: "webhook_url_created", outcome: "completed" });
}

/**
 * A person started a safe or live test of an automation, or it failed to
 * start. Never the rule, its steps, the event, or the lanes it made.
 */
export function captureAutomationTestAnalytics(args: {
  analytics: FeatureAnalytics | null | undefined;
  surface: ProductAnalyticsSurface;
  mode: "safe" | "live";
  outcome: Extract<FeatureAnalyticsOutcome, "completed" | "failed">;
}): void {
  captureFeatureUsedAnalytics({
    analytics: args.analytics,
    surface: args.surface,
    feature: "automations",
    action: args.mode === "live" ? "live_test_started" : "safe_test_started",
    outcome: args.outcome,
  });
}

/**
 * How a private secret card an agent raised ended. Never the secret's name,
 * its value, the reason, or the chat.
 */
export function captureSecretRequestedAnalytics(args: {
  analytics: FeatureAnalytics | null | undefined;
  surface: ProductAnalyticsSurface;
  outcome: Extract<FeatureAnalyticsOutcome, "completed" | "kept" | "cancelled" | "failed">;
}): void {
  captureFeatureUsedAnalytics({ ...args, feature: "chat", action: "secret_requested", outcome: args.outcome });
}

/** The user moved a chat to another account of its provider. */
export function captureChatAccountSwitchedAnalytics(args: {
  analytics: FeatureAnalytics | null | undefined;
  surface: ProductAnalyticsSurface;
  provider: unknown;
}): void {
  captureFeatureUsedAnalytics({
    ...args,
    feature: "chat",
    action: "account_switched",
    outcome: "completed",
  });
}

/**
 * One brain-owned "chat in a new lane" launch reached an outcome: the agent
 * started (`completed`), the user deleted it during setup (`cancelled`), or a
 * setup stage failed (`failed`). Captured by the launch service's outcome hook,
 * never per progress tick.
 */
export function captureNewLaneLaunchAnalytics(args: {
  analytics: FeatureAnalytics | null | undefined;
  surface: ProductAnalyticsSurface;
  outcome: Extract<FeatureAnalyticsOutcome, "completed" | "cancelled" | "failed">;
  provider: unknown;
}): void {
  captureFeatureUsedAnalytics({
    ...args,
    feature: "chat",
    action: "new_lane_launch",
  });
}

/**
 * One external-session import (Import dialog or phone) finished: which
 * way it ran, whether it worked, and the coarse provider family. Captured by the
 * external sessions service's outcome hook, never per list or preview.
 */
export function captureSessionImportAnalytics(args: {
  analytics: FeatureAnalytics | null | undefined;
  surface: ProductAnalyticsSurface;
  target: "chat" | "cli";
  mode: "resume" | "fork";
  outcome: Extract<FeatureAnalyticsOutcome, "completed" | "failed">;
  provider: unknown;
}): void {
  const verb = args.mode === "resume" ? "continue" : "copy";
  captureFeatureUsedAnalytics({
    analytics: args.analytics,
    surface: args.surface,
    feature: "work",
    action: `session_${verb}_${args.target}` as const,
    outcome: args.outcome,
    provider: args.provider,
  });
}

/**
 * What became of one custom notification: `completed` when the relay took it
 * for at least one phone and no delivery failed (a phone that stayed quiet by
 * its own settings is not a failure), `skipped_budget` when the account's
 * hourly cap refused it, `failed` otherwise, including an account with no
 * phone. Never the title, body, link, or phones.
 */
export function captureNotificationSentAnalytics(args: {
  analytics: FeatureAnalytics | null | undefined;
  surface: ProductAnalyticsSurface;
  outcome: Extract<FeatureAnalyticsOutcome, "completed" | "skipped_budget" | "failed">;
}): void {
  captureFeatureUsedAnalytics({ ...args, feature: "attention", action: "notification_sent" });
}

/**
 * Report which account settings one settings patch changed. Both boundaries
 * that accept the patch (desktop IPC and the runtime action) call this, so
 * they cannot report different things. The two Claude settings belong to an
 * account, so they count only when the patch names one.
 */
export function captureProviderAccountSettingsChange(
  capture: ReturnType<typeof providerAccountAnalyticsCapture>,
  args: { settings: Readonly<Record<string, unknown>>; provider: unknown; instanceId: string | undefined },
): void {
  const { settings, provider, instanceId } = args;
  if (typeof settings.smartBalance === "boolean") {
    capture("balance_changed", settings.smartBalance ? "enabled" : "disabled", provider);
  }
  if (typeof settings.autoStartWindows === "boolean") {
    capture("auto_start_changed", settings.autoStartWindows ? "enabled" : "disabled", provider);
  }
  if (!instanceId || provider !== "claude") return;
  if (Object.hasOwn(settings, "subagentPromptCacheTtl")) {
    capture("subagent_cache_changed", settings.subagentPromptCacheTtl === "1h" ? "enabled" : "disabled", provider);
  }
  if (Object.hasOwn(settings, "mainPromptCacheTtl")) {
    capture("main_cache_changed", isClaudePromptCacheTtl(settings.mainPromptCacheTtl) ? "enabled" : "disabled", provider);
  }
  if (Object.hasOwn(settings, "onExtraUsage")) {
    capture("extra_usage_stop_changed", settings.onExtraUsage === "stop" ? "enabled" : "disabled", provider);
  }
}

/**
 * A decision about ADE MCP on this computer: switched on or off, an app
 * connected, a token made, a connection removed. Recorded by the brain once
 * the change is stored; nothing about the app, the token or its access.
 */
export function captureAdeMcpAnalytics(args: {
  analytics: FeatureAnalytics | null | undefined;
  surface: ProductAnalyticsSurface;
  action: "server_toggled" | "app_connected" | "token_created" | "connection_removed";
  outcome: Extract<FeatureAnalyticsOutcome, "completed" | "enabled" | "disabled">;
}): void {
  captureFeatureUsedAnalytics({ ...args, feature: "ade_mcp" });
}
