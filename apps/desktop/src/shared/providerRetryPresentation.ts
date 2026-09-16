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
const LEGACY_AUTH_FAILURE_PATTERN = /authentication|authenticate|auth(?:[_\s-]+(?:failed|failure|error|required))|invalid\s+(?:api\s+)?key|invalid\s+credentials|unauthori[sz]ed|\b401\b/i;

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

/**
 * Same-turn steers join the live backoff; they are not a new chronological
 * segment. Queued, inline, and in-turn Codex accept/process rows keep the
 * current retry visible until a real turn-starting user message arrives.
 */
export function isSameTurnProviderRetrySteer(event: AgentChatEvent): boolean {
  if (event.type !== "user_message") return false;
  switch (event.deliveryState) {
    case "queued":
    case "inline":
    case "accepted":
    case "processed":
    case "unprocessed":
      return true;
    case "delivered":
    case "failed":
    case undefined:
      return false;
    default: {
      const _exhaustive: never = event.deliveryState;
      void _exhaustive;
      return false;
    }
  }
}

/**
 * A terminal event or a primary user message starts the next chronological
 * turn segment. Retry replay may inspect untagged legacy events within the
 * current segment, but must not carry one across that boundary from an older
 * turn.
 */
export function isProviderRetryTurnBoundary(event: AgentChatEvent): boolean {
  return event.type === "done"
    || (event.type === "status" && event.turnStatus !== "started")
    || (event.type === "user_message" && !isSameTurnProviderRetrySteer(event));
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
  const status = event.status?.trim() ?? "";
  const detail = typeof event.detail === "string" ? event.detail : "";
  if (event.noticeKind === "auth" || LEGACY_AUTH_FAILURE_PATTERN.test(`${status} ${message} ${detail}`)) return false;
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
