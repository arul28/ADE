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

import { usageLimitTextIdentity } from "./usageLimitResumePresentation";

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
  const identity = usageLimitTextIdentity(
    `${typeof errorInfo === "string" ? errorInfo : ""} ${event.message ?? ""}`,
  );
  return identity.includes("usagelimit") || identity.includes("ratelimit");
}

/**
 * Host-zone clock WITH a zone label ("7:31 PM ET").
 *
 * Transcript notices are written once, on the host, and then read by every
 * client in every zone — so the notice has to name the zone it is quoting.
 * The pill and the sheet do the opposite: they format `fireAt` in the viewer's
 * zone, which is why they use `formatUsageLimitClock`
 * (shared/usageLimitResumePresentation.ts) and not this.
 */
export function formatAutoResumeHostClock(fireAtMs: number): string {
  const date = new Date(fireAtMs);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(date);
  } catch {
    return date.toLocaleTimeString();
  }
}

/**
 * The one "auto-resume is armed" sentence. The host writes it into the chat as
 * a system notice; every client renders it verbatim. Shared so the notice and
 * the resume state can never disagree about what was scheduled or when.
 */
export function autoResumeScheduledMessage(fireAtMs: number): string {
  return `Resumes at ${formatAutoResumeHostClock(fireAtMs)}`;
}

export const AUTO_RESUME_ARMED_NOTICE_DETAIL =
  'ADE sends "continue" when the usage limit lifts.';
export const AUTO_RESUME_FIRED_NOTICE_MESSAGE = "Resumed after usage limit";
export const AUTO_RESUME_PAUSED_NOTICE_MESSAGE = "Paused after 2 tries";
export const AUTO_RESUME_PAUSED_NOTICE_DETAIL =
  "The limit did not lift at the published reset. Turn auto-resume back on to try at the next reset.";

/**
 * `armed` becomes `resuming` the moment the row is due: the scheduler will not
 * push a prompt into a live turn, so a due row can sit waiting for the turn
 * boundary for as long as that turn runs. Derived at read time rather than
 * stored, so no client has to wait for a state event to stop counting down.
 */
export function resolveUsageLimitResumeState<
  T extends { state: string; fireAt: string | null },
>(resume: T | null | undefined, nowMs: number = Date.now()): T | null {
  if (!resume) return null;
  if (resume.state !== "armed" || !resume.fireAt) return resume;
  const fireAt = Date.parse(resume.fireAt);
  if (!Number.isFinite(fireAt) || fireAt > nowMs) return resume;
  return { ...resume, state: "resuming" };
}

/**
 * The deprecated `usageLimitParkedUntil` mirror. Old iOS builds read it and
 * nothing else; new clients read `usageLimitResume`. Only the two states that
 * actually have a pending resume publish an instant here.
 */
export function usageLimitParkedUntilMirror(
  resume: { state: string; fireAt: string | null } | null | undefined,
): string | null {
  if (!resume) return null;
  if (resume.state !== "armed" && resume.state !== "resuming") return null;
  return resume.fireAt;
}

/** Default on; explicit `false` is the per-chat opt-out. */
export function sessionAutoContinueAtUsageLimit(
  session: { autoContinueAtUsageLimit?: boolean | null } | null | undefined,
): boolean {
  return session?.autoContinueAtUsageLimit !== false;
}

/**
 * Metadata keys only the HOST may set on a chat message.
 *
 * Both change what the dispatch commit points do rather than describing the
 * message: `scheduledWake` marks a turn the durable scheduler fired, and
 * `usageLimitResume: "manual"` marks the continue prompt Resume now sends. Each
 * one exempts its message from the auto-resume cancel sweep, which is correct
 * exactly once — for the host path that owns the row and has already dealt with
 * it — and wrong for anything that merely inherits or supplies the key: a
 * replayed turn, or a caller passing metadata through an action or IPC. The
 * cost of getting it wrong is an armed row that survives real user activity and
 * later fires an unattended prompt into the chat.
 */
export const HOST_ONLY_CHAT_METADATA_KEYS = ["scheduledWake", "usageLimitResume"] as const;

/**
 * Copies `metadata` without the host-only keys. Returns `undefined` when there
 * is nothing left to send, so call sites can spread the result without
 * inventing an empty metadata object for a message that had none.
 */
export function stripHostOnlyChatMetadata<T extends Record<string, unknown>>(
  metadata: T | null | undefined,
): Partial<T> | undefined {
  if (!metadata) return undefined;
  const stripped: Record<string, unknown> = {};
  let kept = 0;
  for (const [key, value] of Object.entries(metadata)) {
    if ((HOST_ONLY_CHAT_METADATA_KEYS as readonly string[]).includes(key)) continue;
    stripped[key] = value;
    kept += 1;
  }
  return kept > 0 ? stripped as Partial<T> : undefined;
}
