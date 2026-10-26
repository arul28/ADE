/**
 * Client-side presentation for the host-computed usage-limit resume state.
 *
 * `AgentChatUsageLimitResume` (shared/types/chat.ts) is the ONE fact every
 * client renders this feature from; this module is the ONE place that turns it
 * into words. Pure and clock-injectable — no React, no IPC, no `Date.now()`
 * hidden inside a formatter — so the pill, the popover, and their tests all
 * read the same strings for the same instant.
 *
 * Time zone: `fireAt`/`resetAt` are formatted in the VIEWER's zone with
 * `Intl.DateTimeFormat`. The host's own zone-labelled string is
 * `providerDetail`, which is shown verbatim behind the details toggle and never
 * reformatted here — reformatting it would silently relabel a zone.
 */

import type {
  AgentChatProvider,
  AgentChatUsageLimitAlternateAccount,
  AgentChatUsageLimitResume,
  AgentChatUsageLimitResumeState,
} from "./types/chat";
import { PROVIDER_DISPLAY_NAME } from "./providers";

const VALID_USAGE_LIMIT_RESUME_STATES: ReadonlySet<string> = new Set<AgentChatUsageLimitResumeState>([
  "armed",
  "resuming",
  "paused",
  "opted_out",
  "no_reset",
]);

/**
 * Parses an untrusted `usageLimitResume` — a persisted session record, a sync
 * payload, a CLI JSON blob — into the shared shape, or `null`.
 *
 * Strict on purpose. Its PRESENCE is load-bearing: the host's heal pass treats
 * a surviving row as the record that a STRUCTURED limit was detected, so a
 * value that does not carry a recognised state and a provider is discarded
 * whole rather than partially trusted.
 *
 * Pure and dependency-free so the host, the CLI, and the clients all read the
 * same bytes the same way instead of each writing their own near-miss.
 */
export function parseUsageLimitResume(value: unknown): AgentChatUsageLimitResume | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const state = typeof record.state === "string" ? record.state.trim() : "";
  if (!VALID_USAGE_LIMIT_RESUME_STATES.has(state)) return null;
  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  if (!provider) return null;
  const isoOrNull = (candidate: unknown): string | null => {
    if (typeof candidate !== "string") return null;
    const trimmed = candidate.trim();
    return trimmed && Number.isFinite(Date.parse(trimmed)) ? trimmed : null;
  };
  const trimmedOrNull = (candidate: unknown): string | null => {
    if (typeof candidate !== "string") return null;
    const trimmed = candidate.trim();
    return trimmed ? trimmed : null;
  };
  const attempts = typeof record.attempts === "number" && Number.isFinite(record.attempts)
    ? Math.max(0, Math.trunc(record.attempts))
    : 0;
  const alternateAccount = parseUsageLimitAlternateAccount(record.alternateAccount);
  return {
    state: state as AgentChatUsageLimitResumeState,
    provider: provider as AgentChatProvider,
    fireAt: isoOrNull(record.fireAt),
    resetAt: isoOrNull(record.resetAt),
    scheduleId: trimmedOrNull(record.scheduleId),
    attempts,
    providerDetail: trimmedOrNull(record.providerDetail),
    turnId: trimmedOrNull(record.turnId),
    updatedAt: isoOrNull(record.updatedAt) ?? new Date(0).toISOString(),
    ...(alternateAccount ? { alternateAccount } : {}),
  };
}

/**
 * A bad alternate is dropped, not the whole resume. The countdown is still
 * true when the account offer is missing or malformed.
 */
function parseUsageLimitAlternateAccount(value: unknown): AgentChatUsageLimitAlternateAccount | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const instanceId = typeof record.instanceId === "string" ? record.instanceId.trim() : "";
  const label = typeof record.label === "string" ? record.label.trim() : "";
  if (!instanceId || !label) return null;
  return { instanceId, label };
}

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  droid: "Droid",
  opencode: "OpenCode",
  pi: "Pi",
  muse: PROVIDER_DISPLAY_NAME.muse,
  qwen: "Qwen",
  kimi: "Kimi",
  grok: "Grok",
  copilot: "Copilot",
};

/**
 * Display name for the popover title (`Claude usage limit`).
 *
 * Takes a plain `string`, not `AgentChatProvider`: the CLI and sync payloads
 * carry provider ids that were never narrowed, and the unknown branch below
 * already title-cases them. A narrower parameter only bought callers a cast.
 */
export function usageLimitResumeProviderLabel(provider: string | null | undefined): string {
  const key = (provider ?? "").trim();
  if (!key) return "Provider";
  return PROVIDER_LABELS[key.toLowerCase()] ?? `${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

/** Clock-only label in the viewer's zone (`7:31 PM`). Empty for an unusable instant. */
export function formatUsageLimitClock(atMs: number | null): string {
  if (atMs == null || !Number.isFinite(atMs)) return "";
  const date = new Date(atMs);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  } catch {
    return date.toLocaleTimeString();
  }
}

/**
 * How long until the resume fires — `3 min`, `2 hr 5 min`, `4 min 30 s`, `59 s`.
 *
 * Second-level granularity under five minutes, because that is exactly the
 * window the pill re-renders every second in — a label that only counts whole
 * minutes would tick nine times without changing a character. Above five
 * minutes it degrades to whole minutes, then to hours: a two-hour wait does not
 * become more actionable for knowing the seconds.
 *
 * Spelled-out, spaced units on purpose: this is the contract wording and it is
 * the same phrasing iOS renders (`workUsageLimitRelativePhrase`), so a chat
 * read on the phone and on the desktop never disagrees about how long is left.
 * Seconds round UP, matching iOS — a wait that still has 200ms in it reads as
 * `1 s`, never as an already-elapsed `0 s`.
 */
export function formatUsageLimitCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds} s`;
  if (totalSeconds < 300) {
    const minutes = Math.floor(totalSeconds / 60);
    const rest = totalSeconds % 60;
    return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
  }
  if (totalSeconds < 3_600) return `${Math.ceil(totalSeconds / 60)} min`;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  return minutes ? `${hours} hr ${minutes} min` : `${hours} hr`;
}

/** Below this the countdown ticks every second; above it, every minute. */
const USAGE_LIMIT_SECOND_TICK_WINDOW_MS = 5 * 60_000;

export type UsageLimitResumePillModel = {
  state: AgentChatUsageLimitResumeState;
  /** Label segments, already ordered. The pill joins them with `·`. */
  segments: string[];
  /**
   * The trailing segment that names what the popover offers (`Turn on`,
   * `Retry`, `Try at 9:30 PM`). Already included in {@link segments}; carried
   * separately so the pill can give it the affordance treatment.
   */
  actionHint: string | null;
  /** `segments.join(" · ")` — the whole one-line label. */
  label: string;
  ariaLabel: string;
  /**
   * Milliseconds until this label could read differently, or null when it is
   * static. Drives the pill's single interval — a static state arms none.
   */
  refreshMs: number | null;
};

function parseInstant(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The instant the pill and the popover both count down to: the fire time when
 * the host scheduled one, else the raw provider reset.
 */
function usageLimitResumeTargetMs(resume: AgentChatUsageLimitResume): number | null {
  return parseInstant(resume.fireAt) ?? parseInstant(resume.resetAt);
}

/**
 * `2 tries` / `1 try` — the pluralised attempt count in the `paused` copy.
 *
 * Exported because the CLI's `paused` line says the same thing as the pill, and
 * a second hand-rolled pluraliser is exactly how the two drift apart.
 */
export function usageLimitResumeAttemptsLabel(attempts: number): string {
  const count = Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 2;
  return `${count} ${count === 1 ? "try" : "tries"}`;
}

/** One-line pill copy per state. Verb-first, sentence case, neutral. */
export function usageLimitResumePill(
  resume: AgentChatUsageLimitResume,
  nowMs: number,
): UsageLimitResumePillModel {
  const targetMs = usageLimitResumeTargetMs(resume);
  const remainingMs = targetMs == null ? null : targetMs - nowMs;
  const build = (
    segments: string[],
    actionHint: string | null,
    refreshMs: number | null,
  ): UsageLimitResumePillModel => {
    const label = segments.join(" · ");
    return {
      state: resume.state,
      segments,
      actionHint,
      label,
      ariaLabel: `${label}. Open usage-limit options.`,
      refreshMs,
    };
  };

  switch (resume.state) {
    case "resuming":
      return build(["Resuming…"], null, null);
    case "paused": {
      const clock = formatUsageLimitClock(targetMs);
      const hint = clock ? `Try at ${clock}` : "Try again";
      return build([`Paused after ${usageLimitResumeAttemptsLabel(resume.attempts)}`, hint], hint, null);
    }
    case "opted_out":
      return build(["Won't auto-resume", "Turn on"], "Turn on", null);
    case "no_reset":
      return build(["Usage limit", "no reset time", "Retry"], "Retry", null);
    case "armed":
    default: {
      if (remainingMs == null) {
        return build(["Resumes when the limit lifts", "usage limit"], null, null);
      }
      // The row is due but the turn boundary has not come round yet. Counting
      // "in -4s" would be the pill lying about a wait that is already over.
      if (remainingMs <= 0) return build(["Resuming…"], null, null);
      return build(
        [`Resumes in ${formatUsageLimitCountdown(remainingMs)}`, "usage limit"],
        null,
        remainingMs < USAGE_LIMIT_SECOND_TICK_WINDOW_MS ? 1_000 : 60_000,
      );
    }
  }
}

/**
 * The usage-limit chip in the composer's status row: "Usage limit reached",
 * one short detail, and at most one toggle. Like the compact-first chip, the
 * same place turns auto-resume off (`Cancel`) and back on (`Resume in 2h`).
 * The provider's own sentence and the exact clock go in the tooltip.
 */
export type UsageLimitChipModel = {
  detail: string | null;
  tooltip: string;
  toggle: { label: string; enable: boolean; title?: string } | null;
  /** Milliseconds until the detail could read differently; null when static. */
  refreshMs: number | null;
};

export function usageLimitChip(resume: AgentChatUsageLimitResume, nowMs: number): UsageLimitChipModel {
  const provider = usageLimitResumeProviderLabel(resume.provider);
  const targetMs = usageLimitResumeTargetMs(resume);
  const remainingMs = targetMs == null ? null : targetMs - nowMs;
  const future = remainingMs != null && remainingMs > 0;
  const countdown = future ? formatUsageLimitCountdown(remainingMs) : null;
  const clock = formatUsageLimitClock(targetMs);
  const refreshMs = future ? (remainingMs < USAGE_LIMIT_SECOND_TICK_WINDOW_MS ? 1_000 : 60_000) : null;
  const withDetail = (text: string) => {
    const detail = resume.providerDetail?.trim();
    return detail ? `${text}\n\n${detail}` : text;
  };

  switch (resume.state) {
    case "resuming":
      return { detail: "resuming…", tooltip: withDetail('ADE is sending "continue" now.'), toggle: null, refreshMs: null };
    case "paused":
      return {
        detail: `paused after ${usageLimitResumeAttemptsLabel(resume.attempts)}`,
        tooltip: withDetail("The limit did not lift at the published reset, so ADE stopped trying."),
        toggle: { label: "Try again", enable: true },
        refreshMs: null,
      };
    case "opted_out":
      return {
        detail: "auto-resume off",
        tooltip: withDetail(clock ? `${provider} resets at ${clock}. ADE won't continue this chat on its own.` : "ADE won't continue this chat on its own."),
        toggle: { label: countdown ? `Resume in ${countdown}` : "Auto-resume", enable: true },
        refreshMs,
      };
    case "no_reset":
      return {
        detail: provider,
        tooltip: withDetail(`${provider} didn't say when the limit resets.`),
        toggle: null,
        refreshMs: null,
      };
    case "armed":
    default:
      if (remainingMs != null && !future) {
        return { detail: "resuming…", tooltip: withDetail('ADE sends "continue" on the next turn boundary.'), toggle: null, refreshMs: null };
      }
      return {
        detail: countdown ? `resumes in ${countdown}` : "resumes when it lifts",
        tooltip: withDetail(clock ? `ADE sends "continue" at ${clock}. Nothing is lost.` : 'ADE sends "continue" as soon as the limit lifts.'),
        toggle: { label: "Cancel", enable: false, title: "Don't auto-resume this chat" },
        refreshMs,
      };
  }
}

/**
 * Work-list row presentation for a live usage limit, or `null` when the limit
 * should not speak for the row at all.
 *
 * Work-list rows show the resume state instead of a red "Failed": a chat that
 * is waiting out a published reset is not broken, and spending the alarm hue on
 * it is what teaches people to ignore red (see `sessionStatusPresentation.ts`).
 * `paused` still holds the row — the chat is stopped on a limit, not on a bug —
 * but it earns the attention tone because it needs a decision.
 *
 * `opted_out` and `no_reset` read `Usage limit` in the attention tone: the chat
 * is stopped on a limit, not broken, and nothing will restart it on its own, so
 * it wants a decision (wait, switch model, or turn auto-resume on).
 */
export function usageLimitResumeRowStatus(
  resume: AgentChatUsageLimitResume | null | undefined,
  nowMs: number,
): { label: string; tone: "neutral" | "attention"; glyph: "waiting" } | null {
  if (!resume) return null;
  switch (resume.state) {
    case "armed":
    case "resuming": {
      // `Resumes 7:31 PM` is a promise about the future, so it may only be made
      // about a future instant. Once the row is due — state `resuming`, or an
      // `armed` row whose fire time has passed while the turn boundary has not
      // come round yet — the clock would be quoting a time already gone, so the
      // row says the neutral, still-true `Resuming`.
      const targetMs = usageLimitResumeTargetMs(resume);
      const due = resume.state === "resuming" || targetMs == null || targetMs <= nowMs;
      const clock = due ? "" : formatUsageLimitClock(targetMs);
      return {
        label: clock ? `Resumes ${clock}` : "Resuming",
        tone: "neutral",
        glyph: "waiting",
      };
    }
    case "paused":
      return { label: "Paused · limit", tone: "attention", glyph: "waiting" };
    case "opted_out":
    case "no_reset":
      return { label: "Usage limit", tone: "attention", glyph: "waiting" };
    default:
      return null;
  }
}

/**
 * Whether a finished turn ended at a usage limit, and should therefore render
 * the quiet `Paused · usage limit` footer instead of the red FAILED line.
 *
 * Two independent proofs, either of which is enough: the SDK's own terminal
 * 429, or the host's live resume state pointing at this exact turn.
 */
export function isUsageLimitTurn(
  done: { turnId?: string | null; terminalReason?: string | null; apiErrorStatus?: number | null },
  resumeTurnId: string | null | undefined,
): boolean {
  if (done.terminalReason === "api_error" && done.apiErrorStatus === 429) return true;
  return Boolean(resumeTurnId && done.turnId && done.turnId === resumeTurnId);
}

/** Footer copy for a turn that ended at a usage limit. */
export function usageLimitTurnFooterLabel(elapsed: string | null): string {
  return elapsed ? `Paused · usage limit · ${elapsed}` : "Paused · usage limit";
}

/**
 * Squashes a failure string down to the form the usage-limit rules match on:
 * lowercase, every non-alphanumeric character removed.
 *
 * Shared so `isUsageLimitFailureText` and `chatAutoResume`'s
 * `isUsageLimitChatError` normalise identically. The two keep DIFFERENT rule
 * sets on purpose — arming auto-resume is a stricter decision than colouring a
 * row — but they must at least agree on what the text says, or `rate-limit`,
 * `rate_limit` and `Rate Limit` start meaning different things in different
 * places.
 */
export function usageLimitTextIdentity(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Does an arbitrary failure string read as a provider usage limit?
 *
 * Deliberately text-based — this is the last resort for surfaces that carry
 * only the strings a runtime handed back, with no structured category.
 *
 * A bare `429` is NOT enough, and that is the whole point of this predicate.
 * The naive substring scan matched `AssertionError at parser.ts:429` and
 * `context overflow: 4290 tokens`, quietly filing ordinary crashes as usage
 * limits. The number only counts when a rate/usage/limit/quota word appears
 * alongside it, which is how every real 429 message actually reads.
 */
export function isUsageLimitFailureText(text: string | null | undefined): boolean {
  if (!text) return false;
  const identity = usageLimitTextIdentity(text);
  if (identity.includes("usagelimit")
    || identity.includes("ratelimit")
    || identity.includes("quotaexceeded")
    || identity.includes("quotaexhausted")
    || identity.includes("outofusage")) {
    return true;
  }
  // The wording a provider's own terminal turn leaves behind: "You've hit your
  // session limit" / "…your weekly limit". Found in the wild as the last
  // assistant text of a turn that stopped at the limit.
  if (identity.includes("hityour") && identity.includes("limit")) return true;
  if (!identity.includes("429")) return false;
  return identity.includes("rate")
    || identity.includes("usage")
    || identity.includes("limit")
    || identity.includes("quota");
}
