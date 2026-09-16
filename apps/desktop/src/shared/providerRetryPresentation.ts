import type { AgentChatEvent } from "./types/chat";
import { providerDisplayName } from "./pendingInputLabels";

/** Causes that can safely be described as an automatic provider retry. */
export type ProviderRetryCause =
  | "network"
  | "timeout"
  | "rate_limit"
  | "overloaded"
  | "transport"
  | "server"
  | "unknown";

export type ProviderRetryActivityOptions = {
  provider: string;
  attempt?: number | null;
  maxAttempts?: number | null;
  retryDelayMs?: number | null;
  cause?: ProviderRetryCause;
  phase?: "retrying" | "reconnecting";
};

export type ProviderRetryActivityEvent = Extract<AgentChatEvent, { type: "activity" }> & {
  providerRetry: true;
};

const TRANSPORT_FALLBACK_PATTERN = /(?:fall(?:ing)?\s+back|fallback).*(?:web\s*socket|websocket).*(?:https?|transport)|(?:web\s*socket|websocket).*(?:https?|transport).*(?:fallback|tim(?:e|ed)\s*out|timeout)/i;
const LEGACY_PROVIDER_HEALTH_RETRY_PATTERN = /^(?:codex|opencode)\s+hit a provider error and is retrying automatically\b/i;

/**
 * Provider SDKs use different names for the same transient failure. Keep the
 * classification deliberately conservative: it only changes the inline verb
 * and never turns an unrecognised terminal error into a retry.
 */
export function classifyProviderRetryCause(
  message: string,
  status?: number | null,
): ProviderRetryCause {
  const text = message.trim().toLowerCase();
  if (TRANSPORT_FALLBACK_PATTERN.test(message) || /web\s*socket|websocket|transport|socket/.test(text)) {
    return "transport";
  }
  if (status === 429 || /rate[_ -]?limit|too many requests|\b429\b/.test(text)) return "rate_limit";
  if (status === 529 || /overloaded|over capacity|capacity exceeded/.test(text)) return "overloaded";
  if (/timeout|timed out|deadline exceeded/.test(text)) return "timeout";
  if (/econn|enotfound|dns|network|connection reset|connection refused|fetch failed|unreachable/.test(text)) {
    return "network";
  }
  if (status != null && status >= 500 && status <= 599) return "server";
  if (/server error|service unavailable|upstream failure|internal server error/.test(text)) return "server";
  return "unknown";
}

function positiveNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function retryDelayLabel(retryDelayMs: number | null | undefined): string | null {
  const delay = positiveNumber(retryDelayMs);
  if (delay == null) return null;
  return `retrying in ${Math.max(1, Math.round(delay / 1_000))}s`;
}

/**
 * The one-line copy used by every provider adapter. It intentionally omits
 * raw provider text, HTTP codes, and request ids; those belong in diagnostics
 * and a terminal error, not in a row that changes every few seconds.
 */
export function formatProviderRetryActivityDetail(options: ProviderRetryActivityOptions): string {
  const cause = options.cause ?? "unknown";
  const reconnecting = options.phase === "reconnecting"
    || cause === "network"
    || cause === "timeout"
    || cause === "transport";
  const verb = reconnecting ? "Reconnecting to" : "Retrying";
  const parts = [`${verb} ${providerDisplayName(options.provider)}`];
  const attempt = positiveNumber(options.attempt);
  const maxAttempts = positiveNumber(options.maxAttempts);
  if (attempt != null) {
    parts.push(maxAttempts != null ? `attempt ${attempt} of ${maxAttempts}` : `attempt ${attempt}`);
  }
  const delay = retryDelayLabel(options.retryDelayMs);
  if (delay) parts.push(delay);
  return parts.join(" · ");
}

/**
 * Guard for host-generated provider retry activity. The marker is intentional:
 * activity detail is free-form provider/tool text and must not be treated as
 * lifecycle state just because it starts with an English retry verb.
 */
export function isProviderRetryActivityEvent(event: unknown): event is ProviderRetryActivityEvent {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  const candidate = event as Record<string, unknown>;
  return candidate.type === "activity" && candidate.providerRetry === true;
}

function providerFromRetryText(message: string): string {
  const lower = message.toLowerCase();
  for (const provider of ["claude", "codex", "opencode", "cursor", "droid", "pi", "qwen", "kimi", "grok", "copilot"]) {
    if (lower.includes(provider)) return provider;
  }
  return "provider";
}

function retryAttemptFromText(message: string): { attempt: number | null; maxAttempts: number | null } {
  const match = message.match(/\bretry\s+(\d+)(?:\s*\/\s*(\d+))?|\battempt\s+(\d+)/i);
  if (!match) return { attempt: null, maxAttempts: null };
  return {
    attempt: Number(match[1] ?? match[3]),
    maxAttempts: match[2] ? Number(match[2]) : null,
  };
}

function retryDelayFromDetail(detail: unknown): number | null {
  if (typeof detail !== "string") return null;
  const match = detail.match(/retrying\s+in\s+(\d+(?:\.\d+)?)s/i);
  return match ? Number(match[1]) * 1_000 : null;
}

export type LegacyProviderRetryNotice = Extract<AgentChatEvent, { type: "system_notice" }>;

/**
 * Identifies retry notices written by older ADE/provider paths. This is used
 * during replay as well as for the live stream, so upgrading a chat does not
 * leave the old retry cards stacked above the new inline indicator.
 */
export function isLegacyProviderRetryNotice(event: LegacyProviderRetryNotice): boolean {
  const message = event.message.trim();
  if (message.toLowerCase().startsWith("claude api retry")) return true;
  if (event.noticeKind === "provider_health" && LEGACY_PROVIDER_HEALTH_RETRY_PATTERN.test(message)) return true;
  return event.noticeKind === "warning" && TRANSPORT_FALLBACK_PATTERN.test(message);
}

/** Turn an old persisted retry notice into the same compact live copy. */
export function formatLegacyProviderRetryActivityDetail(event: LegacyProviderRetryNotice): string {
  const { attempt, maxAttempts } = retryAttemptFromText(event.message);
  const cause = classifyProviderRetryCause(
    `${event.message} ${typeof event.detail === "string" ? event.detail : ""}`,
    null,
  );
  return formatProviderRetryActivityDetail({
    provider: providerFromRetryText(event.message),
    attempt,
    maxAttempts,
    retryDelayMs: retryDelayFromDetail(event.detail),
    cause,
  });
}
