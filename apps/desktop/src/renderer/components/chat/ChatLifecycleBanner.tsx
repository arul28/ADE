import { CheckCircle, Moon } from "@phosphor-icons/react";

import { canonicalInputFromSummary, sessionCanonicalUiState } from "../../lib/terminalAttention";
import { isSessionSnoozed, snoozeWakeDescription } from "../../lib/sessionSnooze";
import { useSessionLifecycleSnapshot } from "../work/SessionLifecycleChips";
import { unsettleSession, wakeSessionNow } from "../terminals/sessionLifecycleActions";
import { cn } from "../ui/cn";

/**
 * "This chat is parked" notice, pinned directly above the composer.
 *
 * The header already carries ambient settled/snoozed CHIPS
 * (`SessionLifecycleChips`) — a 10px marker you have to already be looking at.
 * This is the other half: when you are typing, your eyes are at the bottom of
 * the pane, and the one fact that matters is that this thread is currently out
 * of the way and what sending will do about it. The chip identifies the state;
 * this explains the consequence. Both read from the same derived helpers
 * (`sessionCanonicalUiState` + `isSessionSnoozed`) so they cannot disagree.
 *
 * Colour follows the shared status vocabulary in
 * `shared/sessionStatusPresentation.ts`: emerald for settled ("finished
 * cleanly"), neutral for snoozed (a VISIBILITY OVERLAY, not a lifecycle state —
 * it is `tone: "neutral"` there for exactly this reason). Amber is spent
 * entirely on "your move" and appears in neither variant.
 *
 * Layout note: the composer sits at the bottom of a column, so this banner
 * grows upward into the transcript rather than pushing the composer down, and
 * it renders `null` — not a reserved-height placeholder — when neither state
 * applies. Nothing under it moves when it appears.
 */

const CARD_BASE_CLASS =
  "mb-1.5 flex items-start gap-2.5 rounded-[calc(var(--chat-radius-card)-8px)] border px-3 py-2.5";
const ICON_TILE_CLASS =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border";
const BUTTON_BASE_CLASS =
  "inline-flex shrink-0 items-center rounded-md border px-2.5 py-1 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-semibold transition-colors disabled:pointer-events-none disabled:opacity-40";

type LifecycleVariant = "settled" | "snoozed";

const VARIANT_CHROME: Record<LifecycleVariant, {
  card: string;
  iconTile: string;
  title: string;
  button: string;
  // Phosphor's own component type, borrowed from an existing icon (the idiom
  // ChatContinuityRecoveryCard uses) — `ComponentType<…>` does not match its
  // ForwardRef/propTypes shape.
  icon: typeof CheckCircle;
}> = {
  // Emerald = "finished cleanly, you have not looked yet" — the same hue the
  // sidebar spends on Done, so a settled chat reads as an outcome, not a warning.
  settled: {
    card: "border-emerald-400/16 bg-emerald-400/[0.05]",
    iconTile: "border-emerald-400/18 bg-emerald-400/[0.08] text-emerald-200",
    title: "text-emerald-50/90",
    // focus-visible mirrors hover exactly: keyboard users never see hover, and
    // this button is the only way out of the state the banner describes.
    button:
      "border-emerald-300/22 bg-emerald-400/[0.07] text-emerald-50/80 hover:border-emerald-200/38 hover:bg-emerald-400/[0.13] focus-visible:border-emerald-200/38 focus-visible:bg-emerald-400/[0.13]",
    icon: CheckCircle,
  },
  // Neutral on purpose: snooze hides a row, it does not change what the row IS.
  // Giving it a hue would claim a lifecycle change that never happened.
  snoozed: {
    card: "border-white/[0.09] bg-white/[0.028]",
    iconTile: "border-white/[0.10] bg-white/[0.05] text-muted-fg/80",
    title: "text-fg/85",
    button:
      "border-white/[0.10] bg-white/[0.035] text-fg/70 hover:border-white/[0.2] hover:bg-white/[0.07] hover:text-fg/90 focus-visible:border-white/[0.2] focus-visible:bg-white/[0.07] focus-visible:text-fg/90",
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
function snoozeLine(snoozedUntil: string | null | undefined, nowMs?: number): string {
  const when = snoozeWakeDescription(snoozedUntil, nowMs);
  const until = !when || when === "now" ? "it wakes" : when;
  return `Hidden from the sidebar until ${until}. Snooze only hides the row — this chat keeps running.`;
}

export function ChatLifecycleBanner({
  sessionId,
  className,
}: {
  sessionId: string | null | undefined;
  className?: string;
}) {
  const session = useSessionLifecycleSnapshot(sessionId);
  if (!session) return null;

  const snoozed = isSessionSnoozed(session);
  const settled = sessionCanonicalUiState(canonicalInputFromSummary(session)).phase === "settled";
  if (!snoozed && !settled) return null;

  // Snooze outranks the phase, matching the overlay precedence in
  // `sessionStatusPresentation`. (That module's `needs_you` carve-out is
  // deliberately not mirrored: a raised hand already owns the composer itself
  // via the pending-input card, so it cannot be buried by this banner.)
  const variant: LifecycleVariant = snoozed ? "snoozed" : "settled";
  const chrome = VARIANT_CHROME[variant];
  const Icon = chrome.icon;

  const title = snoozed ? "This chat is snoozed" : "This chat is settled";
  const line = snoozed
    ? snoozeLine(session.snoozedUntil)
    // Truthful for ADE, not borrowed copy: `sessionCanonicalState` clears
    // `settledAt` at the write site on real activity (user turn start / PTY
    // output), so sending is literally what un-settles it.
    : "Sending a message clears the settle and moves this chat back to Active in the sidebar.";
  const actionLabel = snoozed ? "Wake now" : "Un-settle";

  return (
    <div
      data-testid="chat-lifecycle-banner"
      data-lifecycle-variant={variant}
      className={cn(CARD_BASE_CLASS, chrome.card, className)}
    >
      <div className={cn(ICON_TILE_CLASS, chrome.iconTile)}>
        <Icon size={13} weight="fill" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "font-sans text-[length:calc(var(--chat-font-size)*12/14)] font-semibold",
            chrome.title,
          )}
        >
          {title}
        </div>
        <div className="mt-1 text-[length:calc(var(--chat-font-size)*11/14)] leading-relaxed text-fg/60">
          {line}
        </div>
      </div>
      <button
        type="button"
        data-testid={snoozed ? "chat-lifecycle-wake" : "chat-lifecycle-unsettle"}
        className={cn(BUTTON_BASE_CLASS, chrome.button)}
        onClick={() => {
          // Both route through the shared Work-tab lifecycle actions rather than
          // calling `window.ade.sessions` directly, so this banner, the header
          // chip and the sidebar row menu perform the identical write (pin-aware
          // single-session call) and report failures the same way.
          void (snoozed ? wakeSessionNow(session) : unsettleSession(session));
        }}
      >
        {actionLabel}
      </button>
    </div>
  );
}
