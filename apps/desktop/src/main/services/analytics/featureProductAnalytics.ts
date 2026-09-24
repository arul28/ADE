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
  | "work";

export type FeatureAnalyticsAction =
  | "account_created"
  | "account_removed"
  | "default_selected"
  | "balance_changed"
  | "auto_start_changed"
  | "credential_stored"
  | "credential_removed"
  | "preset_created"
  | "preset_deleted"
  | "sign_in"
  | "start"
  | "stop"
  | "reset_credit_consumed"
  | "pending_input_dismissed"
  | "new_lane_launch"
  | "session_continue_chat"
  | "session_copy_chat"
  | "session_continue_cli"
  | "session_copy_cli";

export type FeatureAnalyticsOutcome =
  | "completed"
  | "enabled"
  | "disabled"
  | "success"
  | "nothing_to_reset"
  | "no_credit"
  | "already_redeemed"
  | "cancelled"
  | "failed";

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
}): void {
  if (!args.analytics) return;
  const provider = args.provider === undefined ? undefined : coarseProviderFamily(args.provider);
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
    dedupeKey: `feature:${args.feature}:${args.action}:${args.outcome}${dedupeProvider}`,
    minimumIntervalMs: FEATURE_DEDUPE_INTERVAL_MS,
    properties,
  } satisfies ProductAnalyticsCapture);
}

type ProviderAccountAnalyticsAction = Extract<
  FeatureAnalyticsAction,
  "account_created" | "account_removed" | "default_selected" | "balance_changed" | "auto_start_changed"
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
}): void {
  captureFeatureUsedAnalytics({
    ...args,
    feature: "usage",
    action: "reset_credit_consumed",
    provider: "codex",
  });
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
 * One external-session import (Import dialog, TUI, or phone) finished: which
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
