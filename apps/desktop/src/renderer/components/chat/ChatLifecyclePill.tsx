import { CheckCircle, Moon } from "@phosphor-icons/react";

import type { OpenProjectBinding, TerminalSessionSummary } from "../../../shared/types";
import { canonicalInputFromSummary, sessionCanonicalUiState } from "../../lib/terminalAttention";
import { isSessionSnoozed, snoozeWakeDescription } from "../../lib/sessionSnooze";
import { useSessionLifecycleSnapshot } from "../work/SessionLifecycleChips";
import { unsettleSession, wakeSessionNow } from "../terminals/sessionLifecycleActions";
import { cn } from "../ui/cn";
import { noticeTone, type NoticeTone } from "../ui/notice";
import { COMPOSER_STATUS_CHIP_ACTION_CLASS, COMPOSER_STATUS_CHIP_CLASS } from "./ChatComposerStatusStrip";

/**
 * Settled / snoozed status as a chip in the composer status strip. Settled
 * shows only its title and action; what sending does lives in the tooltip.
 * Snoozed keeps its deadline, which is the whole story of a snoozed row.
 */
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

/** Keep the pane's notice-slot decision in lockstep with the pill itself. */
export function shouldRenderChatLifecyclePill(session: TerminalSessionSummary | null): boolean {
  if (!session) return false;
  return isSessionSnoozed(session)
    || sessionCanonicalUiState(canonicalInputFromSummary(session)).phase === "settled";
}

export function ChatLifecyclePill({
  sessionId,
  className,
  runtimePin = null,
}: {
  sessionId: string | null | undefined;
  className?: string;
  runtimePin?: OpenProjectBinding | null;
}) {
  const session = useSessionLifecycleSnapshot(sessionId);
  if (!session || !shouldRenderChatLifecyclePill(session)) return null;

  const snoozed = isSessionSnoozed(session);

  // Snooze outranks the phase, matching the overlay precedence in
  // `sessionStatusPresentation`. (That module's `needs_you` carve-out is
  // deliberately not mirrored: a raised hand already owns the composer itself
  // via the pending-input card, so it cannot be buried by this pill.)
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
      title={detail}
      className={cn(COMPOSER_STATUS_CHIP_CLASS, className)}
    >
      <Icon size={11} weight="fill" aria-hidden className="shrink-0" style={{ color: tokens.color }} />
      <span className="shrink-0 font-medium" style={{ color: tokens.text }}>{title}</span>
      {snoozed ? <span className="min-w-0 truncate text-fg/45">{detail}</span> : null}
      <button
        type="button"
        data-testid={snoozed ? "chat-lifecycle-wake" : "chat-lifecycle-unsettle"}
        className={COMPOSER_STATUS_CHIP_ACTION_CLASS}
        title={snoozed ? undefined : "Sending a message also reopens this chat"}
        onClick={() => {
          // Both route through the shared Work-tab lifecycle actions rather than
          // calling `window.ade.sessions` directly, so this chip, the snooze
          // header chip, and the sidebar menu use the same write and failure path.
          void (snoozed ? wakeSessionNow(session, runtimePin) : unsettleSession(session, runtimePin));
        }}
      >
        {actionLabel}
      </button>
    </div>
  );
}
