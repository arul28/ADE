import { CheckCircle, Moon } from "@phosphor-icons/react";

import type { OpenProjectBinding, TerminalSessionSummary } from "../../../shared/types";
import { canonicalInputFromSummary, sessionCanonicalUiState } from "../../lib/terminalAttention";
import { isSessionSnoozed, snoozeWakeDescription } from "../../lib/sessionSnooze";
import { useSessionLifecycleSnapshot } from "../work/SessionLifecycleChips";
import { unsettleSession, wakeSessionNow } from "../terminals/sessionLifecycleActions";
import { cn } from "../ui/cn";
import { noticeTone, type NoticeTone } from "../ui/notice";
import { NOTICE_FLOAT_SURFACE } from "../ui/notice/noticeTones";

/**
 * Compact lifecycle pill that floats over the transcript above the composer.
 * This is a status pill, not a banner: its type scales with the chat font, so
 * it keeps its own size logic and paints only its colours from the shared
 * notice tones.
 */
const PILL_BASE_CLASS =
  "pointer-events-auto inline-flex min-w-0 max-w-[calc(100%-1.5rem)] items-center gap-1.5 rounded-full border px-2.5 py-1 font-sans backdrop-blur-xl";
// Hover and keyboard focus share one fill (keyboard users never see hover),
// read from the tone's soft-hover token the pill sets on itself.
const BUTTON_BASE_CLASS =
  "ml-0.5 inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[length:calc(var(--chat-font-size)*9.5/14)] font-medium transition-colors hover:bg-[var(--lifecycle-pill-hover)] hover:text-fg focus-visible:bg-[var(--lifecycle-pill-hover)] focus-visible:text-fg disabled:pointer-events-none disabled:opacity-40";

type LifecycleVariant = "settled" | "snoozed";

const VARIANT_CHROME: Record<LifecycleVariant, {
  tone: NoticeTone;
  // Phosphor's own component type, borrowed from an existing icon (the idiom
  // ChatContinuityRecoveryCard uses) — `ComponentType<…>` does not match its
  // ForwardRef/propTypes shape.
  icon: typeof CheckCircle;
}> = {
  // Success = "finished cleanly, you have not looked yet" — the same hue the
  // sidebar spends on Done, so a settled chat reads as an outcome, not a warning.
  settled: { tone: "success", icon: CheckCircle },
  // Neutral on purpose: snooze hides a row, it does not change what the row IS.
  // Giving it a hue would claim a lifecycle change that never happened.
  snoozed: { tone: "neutral", icon: Moon },
};

/**
 * "Hidden until <when>" line for a snoozed chat. The return ticket is the whole
 * story of a snoozed row, so the deadline goes in the sentence rather than a
 * bare "Snoozed".
 *
 * `snoozeWakeDescription` returns `"now"` for a lapsed deadline; that is
 * unreachable here (an expired snooze is no longer `isSessionSnoozed`) but
 * "until now" would be nonsense if a render ever straddled the deadline, so it
 * falls back with the null case.
 */
function snoozeDetail(snoozedUntil: string | null | undefined, nowMs?: number): string {
  const when = snoozeWakeDescription(snoozedUntil, nowMs);
  const until = !when || when === "now" ? "it wakes" : when;
  return `Hidden until ${until}`;
}

/** Keep the pane's notice-slot decision in lockstep with the banner itself. */
export function shouldRenderChatLifecycleBanner(session: TerminalSessionSummary | null): boolean {
  if (!session) return false;
  return isSessionSnoozed(session)
    || sessionCanonicalUiState(canonicalInputFromSummary(session)).phase === "settled";
}

export function ChatLifecycleBanner({
  sessionId,
  className,
  runtimePin = null,
}: {
  sessionId: string | null | undefined;
  className?: string;
  runtimePin?: OpenProjectBinding | null;
}) {
  const session = useSessionLifecycleSnapshot(sessionId);
  if (!session || !shouldRenderChatLifecycleBanner(session)) return null;

  const snoozed = isSessionSnoozed(session);

  // Snooze outranks the phase, matching the overlay precedence in
  // `sessionStatusPresentation`. (That module's `needs_you` carve-out is
  // deliberately not mirrored: a raised hand already owns the composer itself
  // via the pending-input card, so it cannot be buried by this banner.)
  const variant: LifecycleVariant = snoozed ? "snoozed" : "settled";
  const chrome = VARIANT_CHROME[variant];
  const Icon = chrome.icon;
  const tokens = noticeTone(chrome.tone);

  const title = snoozed ? "Snoozed" : "Settled";
  const detail = snoozed
    ? snoozeDetail(session.snoozedUntil)
    : "Sending reopens this chat";
  const actionLabel = snoozed ? "Wake now" : "Un-settle";

  return (
    <div
      data-testid="chat-lifecycle-banner"
      data-lifecycle-variant={variant}
      data-notice-tone={chrome.tone}
      className={cn(PILL_BASE_CLASS, className)}
      style={{
        ...NOTICE_FLOAT_SURFACE,
        borderColor: tokens.edge,
        ["--lifecycle-pill-hover" as string]: tokens.softHover,
      }}
    >
      <Icon size={12} weight="fill" aria-hidden className="shrink-0" style={{ color: tokens.color }} />
      <span
        className="shrink-0 text-[length:calc(var(--chat-font-size)*10.5/14)] font-semibold"
        style={{ color: tokens.text }}
      >
        {title}
      </span>
      <span aria-hidden className="shrink-0 text-[10px] text-muted-fg">·</span>
      <span className="min-w-0 truncate text-[length:calc(var(--chat-font-size)*10/14)] text-muted-fg">
        {detail}
      </span>
      <button
        type="button"
        data-testid={snoozed ? "chat-lifecycle-wake" : "chat-lifecycle-unsettle"}
        className={BUTTON_BASE_CLASS}
        style={{ color: tokens.text }}
        onClick={() => {
          // Both route through the shared Work-tab lifecycle actions rather than
          // calling `window.ade.sessions` directly, so this pill, the snooze
          // header chip, and the sidebar menu use the same write and failure path.
          void (snoozed ? wakeSessionNow(session, runtimePin) : unsettleSession(session, runtimePin));
        }}
      >
        {actionLabel}
      </button>
    </div>
  );
}
