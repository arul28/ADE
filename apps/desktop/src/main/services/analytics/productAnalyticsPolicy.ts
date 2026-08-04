import { isMeaningfulUsageAction } from "../usage/usageStatsStore";
import { AUTO_UPDATE_INSTALL_ABORT_REASONS } from "../../../shared/types";
import type {
  ProductAnalyticsCapture,
  ProductAnalyticsEventName,
  ProductAnalyticsPropertyValue,
} from "../../../shared/types/productAnalytics";

export const DEFAULT_DAILY_BUDGET = 200;
export const DEDUPE_CACHE_LIMIT = 1_000;
export const DEFAULT_DEDUPE_WINDOW_MS = 30_000;
export const MAX_HISTORICAL_EVENT_AGE_MS = 31 * 24 * 60 * 60 * 1_000;
export const PROCESS_INGRESS_LIMIT_PER_MINUTE = 120;
export const MAX_LOCAL_IDENTIFIER_LENGTH = 512;

export const INTERNAL_ONLY_EVENTS = new Set<ProductAnalyticsEventName>([
  "ade_app_installed", "ade_activated",
  "ade_work_session_started", "ade_work_session_completed", "ade_daily_usage_summary", "ade_analytics_budget",
  "ade_update_install_aborted", "ade_update_quit_escalated", "ade_update_install_did_not_land",
  "ade_update_auto_applied",
  "ade_update_auto_apply_cancelled",
  "ade_brain_recovered", "ade_publish_failing", "ade_relay_suppressed",
  "ade_account_session_unreadable",
  "ade_tool_fetched",
]);

export const EVENT_DAILY_BUDGETS: Record<ProductAnalyticsEventName, number> = {
  ade_app_installed: 1,
  ade_app_opened: 12,
  ade_activated: 1,
  ade_screen_viewed: 80,
  ade_project_opened: 20,
  ade_feature_used: 140,
  ade_work_session_started: 40,
  ade_work_session_completed: 40,
  ade_error: 20,
  ade_daily_usage_summary: 60,
  ade_analytics_budget: 2,
  ade_update_install_aborted: 20,
  ade_update_quit_escalated: 10,
  ade_update_install_did_not_land: 10,
  ade_update_auto_applied: 10,
  ade_update_auto_apply_cancelled: 10,
  ade_update_prompted: 10,
  ade_brain_recovered: 10,
  ade_publish_failing: 10,
  ade_relay_suppressed: 10,
  ade_account_session_unreadable: 10,
  // Three pinned tools, plus headroom for a retry apiece after a flaky network.
  ade_tool_fetched: 12,
};

export const EVENT_MINUTE_BUDGETS: Record<ProductAnalyticsEventName, number> = {
  ade_app_installed: 1,
  ade_app_opened: 3,
  ade_activated: 1,
  ade_screen_viewed: 12,
  ade_project_opened: 6,
  ade_feature_used: 30,
  ade_work_session_started: 10,
  ade_work_session_completed: 10,
  ade_error: 6,
  ade_daily_usage_summary: 60,
  ade_analytics_budget: 2,
  ade_update_install_aborted: 6,
  ade_update_quit_escalated: 3,
  ade_update_install_did_not_land: 3,
  ade_update_auto_applied: 3,
  ade_update_auto_apply_cancelled: 3,
  ade_update_prompted: 3,
  ade_brain_recovered: 3,
  ade_publish_failing: 3,
  ade_relay_suppressed: 3,
  ade_account_session_unreadable: 3,
  ade_tool_fetched: 3,
};

const STRING_PROPERTIES = new Set([
  "screen", "feature", "action", "outcome", "app_version", "runtime_mode", "provider", "model_family",
  "duration_bucket", "error_kind", "route_kind", "connection_state", "drop_reason", "source", "mode",
  "entry_point", "release_channel", "summary_kind", "reason", "last_command", "leg", "code",
  "escalation_reason", "install_source", "trigger", "from_version", "to_version", "user_action",
  "tool_error_kind",
]);
const NUMBER_PROPERTIES = new Set([
  "sent_count", "dropped_count", "interaction_count", "session_count", "chat_session_count",
  "terminal_session_count", "active_lane_count", "lanes_created", "lanes_archived", "commits_created",
  "push_operations", "pr_landings", "files_changed", "artifacts_captured", "automation_runs", "worker_runs",
  "active_days", "current_streak_days", "token_count", "input_token_count", "output_token_count", "call_count",
  "duration_ms", "provider_count", "model_count", "error_count", "bytes_freed", "files_compressed", "blocked_ms",
  "failing_minutes", "attempt",
  "time_since_install_seconds",
]);
const BOOLEAN_PROPERTIES = new Set([
  "recoverable", "paired", "cached_data", "is_packaged", "native_staging_completed",
]);

// Actions emitted only by daemon services (not user-mutation ledger rows) that
// are still meaningful product facts. Kept here rather than in the usage-stats
// MEANINGFUL_ACTIONS set because they never correspond to a persisted mutation.
const ANALYTICS_ONLY_ACTIONS = new Set([
  "maintenance_run",
  "header_opened",
  "preferences_changed",
  "brain_repair",
]);

const EVENT_PROPERTY_KEYS: Record<ProductAnalyticsEventName, ReadonlySet<string>> = {
  ade_app_installed: new Set(["install_source"]),
  ade_app_opened: new Set([
    "entry_point", "source", "release_channel", "mode", "connection_state", "paired", "cached_data", "is_packaged",
  ]),
  ade_activated: new Set(["trigger", "time_since_install_seconds"]),
  ade_screen_viewed: new Set(["screen", "route_kind", "source", "mode"]),
  ade_project_opened: new Set(["route_kind", "source", "mode", "connection_state"]),
  ade_feature_used: new Set([
    "feature", "action", "outcome", "source", "mode", "provider", "model_family", "duration_bucket", "connection_state",
    "bytes_freed", "files_compressed",
  ]),
  ade_work_session_started: new Set(["feature", "action", "outcome", "source", "mode", "provider"]),
  ade_work_session_completed: new Set([
    "feature", "action", "outcome", "source", "mode", "duration_bucket", "provider",
  ]),
  ade_error: new Set(["feature", "action", "error_kind", "outcome", "recoverable", "source"]),
  ade_daily_usage_summary: new Set([
    "summary_kind", "provider", "model_family", "interaction_count", "session_count", "chat_session_count",
    "terminal_session_count", "active_lane_count", "lanes_created", "lanes_archived", "commits_created",
    "push_operations", "pr_landings", "files_changed", "artifacts_captured", "automation_runs", "worker_runs",
    "active_days", "current_streak_days", "token_count", "input_token_count", "output_token_count", "call_count",
    "duration_ms", "provider_count", "model_count", "error_count",
  ]),
  ade_analytics_budget: new Set(["sent_count", "dropped_count", "drop_reason"]),
  ade_update_install_aborted: new Set(["reason"]),
  ade_update_quit_escalated: new Set(["blocked_ms", "escalation_reason", "native_staging_completed"]),
  ade_update_install_did_not_land: new Set(["attempt"]),
  ade_update_auto_applied: new Set(),
  ade_update_auto_apply_cancelled: new Set(),
  ade_update_prompted: new Set(["from_version", "to_version", "user_action"]),
  ade_brain_recovered: new Set(["blocked_ms", "last_command"]),
  ade_publish_failing: new Set(["failing_minutes", "leg", "code"]),
  ade_relay_suppressed: new Set(["attempt", "code"]),
  ade_account_session_unreadable: new Set(["code"]),
  // `provider` already enumerates codex/claude/opencode, so the tool identity
  // reuses it rather than adding a parallel key.
  ade_tool_fetched: new Set(["provider", "outcome", "duration_bucket", "tool_error_kind"]),
};

const SLUG_VALUE = /^[a-z0-9][a-z0-9._+-]*$/i;
const SAFE_STRING_VALUES: Partial<Record<string, ReadonlySet<string>>> = {
  screen: new Set([
    "project", "hub", "lanes", "files", "work", "graph", "prs", "review", "history", "automations",
    "cto", "settings", "chats", "onboarding", "other", "terminal_control", "drawer_lanes", "drawer_chats",
    "details", "details_model_picker", "details_help", "details_status", "details_list", "details_details",
    "details_context_usage", "details_diff", "details_chat_info", "details_external_session_browser",
    "details_usage", "details_form", "details_lane_details", "add_chat", "multi_chat_grid", "chat",
  ]),
  feature: new Set([
    "chat", "cli", "work", "lanes", "files", "git", "orchestration", "prs",
    "automations", "command_palette", "storage_doctor", "attention", "updates", "connections",
  ]),
  outcome: new Set([
    "success", "started", "completed", "failure", "timeout", "opened", "cancelled", "approved", "denied",
    "partial", "failed", "idle_only", "immediate",
  ]),
  provider: new Set(["codex", "openai", "claude", "cursor", "droid", "opencode", "gemini", "local", "other"]),
  model_family: new Set([
    "gpt_5", "openai_reasoning", "claude_sonnet", "claude_opus", "claude_haiku", "cursor", "gemini",
    "grok", "local", "other",
  ]),
  duration_bucket: new Set(["under_10s", "under_1m", "under_5m", "under_30m", "under_2h", "over_2h"]),
  route_kind: new Set(["desktop", "web"]),
  connection_state: new Set(["connected", "disconnected", "pairing", "direct", "relay", "error"]),
  drop_reason: new Set([
    "none", "invalid_event", "invalid_surface", "duplicate", "rate_limited", "daily_budget", "transport_error",
  ]),
  source: new Set([
    "mutation", "runtime", "renderer_route", "renderer_project", "renderer_startup", "ipc", "ade_code",
  ]),
  mode: new Set(["direct", "relay", "local", "remote", "manual", "automatic", "attached", "embedded"]),
  entry_point: new Set([
    "project_file", "environment", "app_icon", "machine_runtime", "project_runtime", "hosted_web_client",
    "local", "remote",
  ]),
  release_channel: new Set(["stable", "beta", "development", "unknown"]),
  summary_kind: new Set(["overall", "client", "provider", "model"]),
  reason: new Set(AUTO_UPDATE_INSTALL_ABORT_REASONS),
  escalation_reason: new Set(["hard_deadline", "post_staging"]),
  install_source: new Set(["direct_download", "homebrew", "development", "unknown"]),
  trigger: new Set(["work_session_completed"]),
  user_action: new Set(["accepted", "deferred", "dismissed"]),
  // ToolErrorKind from apps/ade-cli/src/services/tools/errors.ts. This is a
  // closed, code-authored vocabulary with no user data in it, which is why it
  // gets an exact allowlist instead of going through `error_kind`'s coarsening
  // -- that would flatten integrity, disk-space and extract into "other" and
  // lose the only signal worth collecting here.
  tool_error_kind: new Set([
    "manifest", "unsupported-target", "network", "integrity", "disk-space", "extract",
    "lock-timeout", "filesystem", "not-installed",
  ]),
};

export function safeProductAnalyticsString(value: ProductAnalyticsPropertyValue): string | null {
  if (typeof value !== "string" || value.length > 256) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed && trimmed.length <= 80 && SLUG_VALUE.test(trimmed) ? trimmed : null;
}

function coarseErrorKind(value: ProductAnalyticsPropertyValue): string | null {
  if (typeof value !== "string" || value.length > 256) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("timeout")) return "timeout";
  if (normalized.includes("abort") || normalized.includes("cancel")) return "cancelled";
  if (normalized.includes("permission") || normalized.includes("auth")) return "permission";
  if (["network", "socket", "fetch", "connect"].some((part) => normalized.includes(part))) return "network";
  if (normalized.includes("typeerror")) return "type_error";
  if (normalized.includes("rangeerror")) return "range_error";
  if (normalized.includes("syntaxerror")) return "syntax_error";
  return "other";
}

function safeStringProperty(key: string, value: ProductAnalyticsPropertyValue): string | null {
  if (key === "action") {
    if (typeof value !== "string" || value.length > 256) return null;
    const raw = value.trim();
    return raw === "open" || isMeaningfulUsageAction(raw) || ANALYTICS_ONLY_ACTIONS.has(raw) ? raw : null;
  }
  if (key === "error_kind") return coarseErrorKind(value);
  const safe = safeProductAnalyticsString(value);
  if (!safe) return null;
  const allowlist = SAFE_STRING_VALUES[key];
  return !allowlist || allowlist.has(safe) ? safe : null;
}

export function sanitizeProductAnalyticsProperties(
  event: ProductAnalyticsEventName,
  properties: ProductAnalyticsCapture["properties"],
): Record<string, string | number | boolean> {
  const sanitized: Record<string, string | number | boolean> = {};
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return sanitized;
  let visited = 0;
  for (const key in properties) {
    if (!Object.prototype.hasOwnProperty.call(properties, key)) continue;
    if ((visited += 1) > 32) break;
    if (!EVENT_PROPERTY_KEYS[event].has(key)) continue;
    const value = properties[key];
    if (STRING_PROPERTIES.has(key)) {
      const safe = safeStringProperty(key, value);
      if (safe != null) sanitized[key] = safe;
    } else if (NUMBER_PROPERTIES.has(key) && typeof value === "number" && Number.isFinite(value)) {
      sanitized[key] = Math.max(0, Math.min(1_000_000_000_000, Math.round(value)));
    } else if (BOOLEAN_PROPERTIES.has(key) && typeof value === "boolean") {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
