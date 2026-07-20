import type {
  ExtraUsage,
  UsageProvider,
  UsageProviderErrorKind,
  UsageProviderMessage,
  UsageProviderSource,
  UsageWindow,
} from "../../../shared/types";

export type UsageRefreshReason = "automatic" | "remote" | "user";

export type UsageProviderPollContext = {
  reason: UsageRefreshReason;
};

export type FreshUsageProviderPollResult = {
  disposition?: "fresh";
  windows: UsageWindow[];
  /** Provider-level Codex spend control state, not tied to an individual quota window. */
  spendControlReached?: boolean;
  source?: UsageProviderSource;
  errors: string[];
  errorKind?: UsageProviderErrorKind;
  retryAfterMs?: number;
  extraUsage?: ExtraUsage | null;
  dailyUsage7d?: number[];
  providerMessages?: UsageProviderMessage[];
};

type PreserveUsageProviderPollResult = {
  /** The non-interactive caller could not authoritatively check this provider. */
  disposition: "preserve_previous";
  windows: [];
  errors: [];
  source?: UsageProviderSource;
  spendControlReached?: never;
  errorKind?: never;
  retryAfterMs?: never;
  extraUsage?: never;
  dailyUsage7d?: never;
  providerMessages?: never;
};

export type UsageProviderPollResult =
  | FreshUsageProviderPollResult
  | PreserveUsageProviderPollResult;

/**
 * Boundary between the quota scheduler and provider-specific auth/fallback
 * behavior. Historical ledger scanners intentionally do not implement this
 * interface: quota refresh must remain independent from corpus size.
 */
export type UsageProviderStrategy = {
  provider: Extract<UsageProvider, "claude" | "codex">;
  poll(context: UsageProviderPollContext): Promise<UsageProviderPollResult>;
};
