/**
 * Auto-resume after a provider usage limit resets.
 *
 * When a turn fails at a provider usage/rate limit AND the provider told us
 * when the limit resets, ADE arms one durable scheduled-work row per chat that
 * asks the agent to continue the interrupted task. The row is an ordinary
 * scheduled-work record — it survives brain restarts, shows up in Chat info,
 * and is cancellable through the normal `chat.cancelScheduledWork` path.
 *
 * Shared between the main process (which arms and cancels the row) and the
 * renderer (which recognises the row so a user schedule is never mistaken for
 * an ADE-created one).
 */

/** Tag written to the scheduled-work record so cancel-on-activity is scoped. */
export const AUTO_RESUME_SCHEDULED_WORK_SOURCE = "auto_resume_limit";

/**
 * Providers report the reset instant with minute granularity at best, and a
 * request issued exactly at the boundary is still rejected often enough to
 * matter. Wait out a short buffer instead of burning the resume on a 429.
 */
export const AUTO_RESUME_BUFFER_MS = 90_000;

export const AUTO_RESUME_PROMPT =
  "The provider usage limit has reset. Continue the interrupted task from where it stopped; do not restart work that already completed.";

export const AUTO_RESUME_REASON = "Auto-resume after usage limit reset";

const AUTO_RESUME_ID_PREFIX = "auto-resume:";

/**
 * Deterministic per-chat id. Dedupe is structural: a repeat failure upserts the
 * same row instead of stacking a second resume.
 */
export function autoResumeScheduleId(sessionId: string): string {
  return `${AUTO_RESUME_ID_PREFIX}${sessionId}`;
}

/**
 * Recognises ADE-created auto-resume rows. The tag is authoritative; the id
 * prefix is the fallback for rows persisted before the tag existed.
 */
export function isAutoResumeScheduledWork(
  schedule: { id?: string | null; source?: string | null } | null | undefined,
): boolean {
  if (!schedule) return false;
  if (schedule.source === AUTO_RESUME_SCHEDULED_WORK_SOURCE) return true;
  return typeof schedule.id === "string" && schedule.id.startsWith(AUTO_RESUME_ID_PREFIX);
}

/**
 * Both status vocabularies for one scheduled-work row.
 *
 * The host record (`ChatScheduledWorkStatus`) spells the finished state `done`;
 * the client item (`AgentChatScheduledWorkItem`, and the wider
 * `AgentChatScheduledWorkStatus`) spells it `completed`. Nothing translates
 * between them at the boundary, so the shared predicate below has to accept
 * both rather than silently disagreeing on which rows are still pending.
 */
type AutoResumeScheduledWorkStatus =
  | "scheduled"
  | "paused"
  | "running"
  | "fired"
  | "missed"
  | "done"
  | "completed"
  | "cancelled"
  | "failed"
  | "stopped";

type AutoResumeScheduledWorkLike = {
  id?: string | null;
  source?: string | null;
  status?: AutoResumeScheduledWorkStatus | null;
};

/**
 * An ADE-created auto-resume row that has not finished or been cancelled — the
 * one the main process sweeps on user activity and the one the renderer offers
 * a Cancel for. Shared so the two surfaces cannot drift.
 */
export function isPendingAutoResumeScheduledWork(
  schedule: AutoResumeScheduledWorkLike | null | undefined,
): boolean {
  if (!isAutoResumeScheduledWork(schedule)) return false;
  const status = schedule?.status;
  return status !== "done" && status !== "completed" && status !== "cancelled";
}

/**
 * Fire time for a known reset instant, or `null` when there is nothing useful
 * to arm — an unknown reset, or one whose buffered fire time already passed
 * (the limit is already back, so the manual retry affordance is the right
 * answer and a schedule would fire immediately for no reason).
 */
export function autoResumeFireAtMs(
  resetsAtMs: number | null | undefined,
  nowMs: number,
): number | null {
  if (typeof resetsAtMs !== "number" || !Number.isFinite(resetsAtMs) || resetsAtMs <= 0) return null;
  const fireAt = resetsAtMs + AUTO_RESUME_BUFFER_MS;
  return fireAt > nowMs ? fireAt : null;
}

/**
 * Whether a chat `error` event is a provider usage/rate limit.
 *
 * Two shapes exist in the wild: the structured `errorInfo.category` the host
 * classifiers produce, and the opaque provider string Codex forwards as
 * `codexErrorInfo` (which spells its usage limit "usageLimitReached", not
 * "usageLimitExceeded"). This is the single predicate: the host arms the
 * schedule from it and the renderer's `classifyProviderFailure` delegates its
 * `rate_limit` branch to it, so the card, the anchor, and the schedule can
 * never disagree about what counts as a usage limit.
 */
export function isUsageLimitChatError(event: {
  message?: string | null;
  errorInfo?:
    | string
    | { category?: string | null }
    | null;
}): boolean {
  const errorInfo = event.errorInfo;
  if (errorInfo && typeof errorInfo === "object" && errorInfo.category === "rate_limit") return true;
  const identity = `${typeof errorInfo === "string" ? errorInfo : ""} ${event.message ?? ""}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return identity.includes("usagelimit") || identity.includes("ratelimit");
}

/** Local-time label used in the failure notice and the recovery card. */
export function formatAutoResumeTime(fireAtMs: number): string {
  const date = new Date(fireAtMs);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      month: "short",
      day: "numeric",
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

/**
 * The one "auto-resume is armed" sentence. The host writes it into the chat as
 * a system notice; the renderer's recovery card shows it live next to Cancel.
 * Shared so the two can never disagree about what was scheduled or when.
 */
export function autoResumeScheduledMessage(fireAtMs: number): string {
  return `Auto-resume scheduled for ${formatAutoResumeTime(fireAtMs)}`;
}
