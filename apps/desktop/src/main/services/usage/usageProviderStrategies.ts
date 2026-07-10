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

export type UsageProviderPollResult = {
  windows: UsageWindow[];
  source?: UsageProviderSource;
  errors: string[];
  errorKind?: UsageProviderErrorKind;
  retryAfterMs?: number;
  extraUsage?: ExtraUsage | null;
  dailyUsage7d?: number[];
  providerMessages?: UsageProviderMessage[];
};

/**
 * Boundary between the quota scheduler and provider-specific auth/fallback
 * behavior. Historical ledger scanners intentionally do not implement this
 * interface: quota refresh must remain independent from corpus size.
 */
export type UsageProviderStrategy = {
  provider: Extract<UsageProvider, "claude" | "codex">;
  poll(context: UsageProviderPollContext): Promise<UsageProviderPollResult>;
};
