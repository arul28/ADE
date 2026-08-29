import { CheckCircle, Moon } from "@phosphor-icons/react";

import type { OpenProjectBinding, TerminalSessionSummary } from "../../../shared/types";
import { canonicalInputFromSummary, sessionCanonicalUiState } from "../../lib/terminalAttention";
import { isSessionSnoozed, snoozeWakeDescription } from "../../lib/sessionSnooze";
import { useSessionLifecycleSnapshot } from "../work/SessionLifecycleChips";
import { unsettleSession, wakeSessionNow } from "../terminals/sessionLifecycleActions";
import { cn } from "../ui/cn";

/** Compact lifecycle pill that floats over the transcript above the composer. */
const PILL_BASE_CLASS =
  "pointer-events-auto inline-flex min-w-0 max-w-[calc(100%-1.5rem)] items-center gap-1.5 rounded-full border px-2.5 py-1 font-sans shadow-[0_10px_28px_rgba(0,0,0,0.28)] backdrop-blur-xl";
const BUTTON_BASE_CLASS =
  "ml-0.5 inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[length:calc(var(--chat-font-size)*9.5/14)] font-medium transition-colors disabled:pointer-events-none disabled:opacity-40";

type LifecycleVariant = "settled" | "snoozed";

const VARIANT_CHROME: Record<LifecycleVariant, {
  pill: string;
  iconClass: string;
  title: string;
  detail: string;
  button: string;
  // Phosphor's own component type, borrowed from an existing icon (the idiom
  // ChatContinuityRecoveryCard uses) — `ComponentType<…>` does not match its
  // ForwardRef/propTypes shape.
  icon: typeof CheckCircle;
}> = {
  // Emerald = "finished cleanly, you have not looked yet" — the same hue the
  // sidebar spends on Done, so a settled chat reads as an outcome, not a warning.
  settled: {
    pill: "border-emerald-300/18 bg-[#101b18]/92",
    iconClass: "text-emerald-300/85",
    title: "text-emerald-50/90",
    detail: "text-emerald-50/55",
    // focus-visible mirrors hover exactly: keyboard users never see hover, and
    // the action offers an explicit way out alongside sending a new turn.
    button:
      "text-emerald-100/70 hover:bg-emerald-300/[0.10] hover:text-emerald-50 focus-visible:bg-emerald-300/[0.10] focus-visible:text-emerald-50",
    icon: CheckCircle,
  },
  // Neutral on purpose: snooze hides a row, it does not change what the row IS.
  // Giving it a hue would claim a lifecycle change that never happened.
  snoozed: {
    pill: "border-white/[0.10] bg-[#17161c]/92",
    iconClass: "text-muted-fg/75",
    title: "text-fg/85",
    detail: "text-fg/50",
    button:
      "text-fg/65 hover:bg-white/[0.07] hover:text-fg/90 focus-visible:bg-white/[0.07] focus-visible:text-fg/90",
    icon: Moon,
  },
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

  const title = snoozed ? "Snoozed" : "Settled";
  const detail = snoozed
    ? snoozeDetail(session.snoozedUntil)
    : "Sending reopens this chat";
  const actionLabel = snoozed ? "Wake now" : "Un-settle";

  return (
    <div
      data-testid="chat-lifecycle-banner"
      data-lifecycle-variant={variant}
      className={cn(PILL_BASE_CLASS, chrome.pill, className)}
    >
      <Icon size={12} weight="fill" aria-hidden className={cn("shrink-0", chrome.iconClass)} />
      <span className={cn("shrink-0 text-[length:calc(var(--chat-font-size)*10.5/14)] font-semibold", chrome.title)}>
        {title}
      </span>
      <span aria-hidden className={cn("shrink-0 text-[10px]", chrome.detail)}>·</span>
      <span className={cn("min-w-0 truncate text-[length:calc(var(--chat-font-size)*10/14)]", chrome.detail)}>
        {detail}
      </span>
      <button
        type="button"
        data-testid={snoozed ? "chat-lifecycle-wake" : "chat-lifecycle-unsettle"}
        className={cn(BUTTON_BASE_CLASS, chrome.button)}
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
