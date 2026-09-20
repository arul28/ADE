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
  | "chat";

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
  | "pending_input_dismissed";

export type FeatureAnalyticsOutcome =
  | "completed"
  | "enabled"
  | "disabled"
  | "success"
  | "nothing_to_reset"
  | "no_credit"
  | "already_redeemed"
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

export function captureProviderAccountAnalytics(args: {
  analytics: FeatureAnalytics | null | undefined;
  surface: ProductAnalyticsSurface;
  action: Extract<FeatureAnalyticsAction, "account_created" | "account_removed" | "default_selected" | "balance_changed" | "auto_start_changed">;
  outcome: Extract<FeatureAnalyticsOutcome, "completed" | "enabled" | "disabled">;
  provider: unknown;
}): void {
  captureFeatureUsedAnalytics({ ...args, feature: "provider_accounts" });
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

export function captureResetCreditAnalytics(args: {
  analytics: FeatureAnalytics | null | undefined;
  surface: ProductAnalyticsSurface;
  outcome: Extract<FeatureAnalyticsOutcome, "completed" | "nothing_to_reset" | "no_credit" | "already_redeemed" | "failed">;
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
