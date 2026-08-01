import React from "react";
import {
  ArrowUUpLeft,
  Check,
} from "@phosphor-icons/react";
import type { OpenProjectBinding, TerminalSessionSummary } from "../../../shared/types";
import type { SessionStatusPresentation } from "../../../shared/sessionStatusPresentation";
import { isChatToolType } from "../../lib/sessions";
import {
  canonicalInputFromSummary,
  sessionCanonicalUiState,
} from "../../lib/terminalAttention";
import { cn } from "../ui/cn";
import { SessionSnoozeControl } from "./SessionSnoozeControl";
import { SessionStatusLabel } from "./SessionStatusLabel";
import {
  settleSession,
  unsettleSession,
} from "./sessionLifecycleActions";

/**
 * The session row's right-hand swap slot: the status label at rest, the row's
 * hover actions in its place on hover/focus, and NO layout shift between the
 * two.
 *
 * The trick (ported from t3code's SidebarV2 row) is that exactly one of the two
 * states is in flow at a time. At rest the label is in flow and the action
 * cluster is absolutely positioned and transparent; on hover they swap — the
 * cluster goes `static` and claims the width, the label goes absolute. Because
 * the slot itself is `ml-auto` + `min-w-8`, the "where" line to its left never
 * reflows when the actions appear.
 *
 * This is also the only place a session's status is rendered as words. Every
 * hue and every glyph comes from `sessionStatusPresentation`, so the sidebar,
 * the attention center and iOS cannot drift into three different ambers.
 */

/**
 * The row action idiom, shared with `SessionSnoozeControl`'s trigger.
 *
 * The hover FILL is the load-bearing part: text that merely brightens reads as
 * text, not as a control you can press. `bg-white/[0.06]` is the same pill the
 * sidebar's own bare buttons and group-header actions use, so a row action and
 * a header action feel like the same kind of thing. Focus-visible gets the same
 * fill for keyboard users, who never see hover at all.
 */
export const SESSION_ACTION_BUTTON_CLASS =
  "inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-muted-fg/70 transition-colors hover:bg-white/[0.06] hover:text-fg focus-visible:bg-white/[0.06] focus-visible:text-fg";

export function SessionStatusSlot({
  session,
  presentation,
  timestampLabel,
  snoozed,
  settled,
  actionsEnabled,
  compact = false,
  runtimePin = null,
}: {
  session: TerminalSessionSummary;
  /** Resolved status, or null for a settled row (which shows its timestamp). */
  presentation: SessionStatusPresentation | null;
  /** Relative time shown when there is no status word to show. */
  timestampLabel: string;
  snoozed: boolean;
  /** Settled rows offer un-settle instead of settle. */
  settled: boolean;
  /** False while the owning lane is being torn down — no action may fire. */
  actionsEnabled: boolean;
  compact?: boolean;
  /** Runtime that owns this session when it differs from the active project. */
  runtimePin?: OpenProjectBinding | null;
}) {
  // While the snooze popover is open the pointer has left the row, so the
  // hover-driven actions would fade out from under the open menu. Pin the slot
  // open for as long as the menu is.
  const [snoozeMenuOpenRaw, setSnoozeMenuOpen] = React.useState(false);
  // Derived, not raw: if the snooze button disappears while its menu is open
  // (the row gets blocked mid-interaction) it unmounts without ever reporting
  // `false`, and a stale `true` would permanently hide the status label.
  const snoozeMenuOpen = snoozeMenuOpenRaw && actionsEnabled;
  React.useEffect(() => {
    if (!actionsEnabled) setSnoozeMenuOpen(false);
  }, [actionsEnabled]);

  const canonicalPhase = sessionCanonicalUiState(canonicalInputFromSummary(session)).phase;
  const elapsedSince = canonicalPhase === "running" && isChatToolType(session.toolType)
    ? session.currentTurnStartedAt ?? session.lastActivityAt ?? session.startedAt
    : session.lastActivityAt ?? session.startedAt;
  const isActivelyRunning = canonicalPhase === "starting"
    || canonicalPhase === "running"
    || canonicalPhase === "stale";
  const canDismissNeedsYou =
    canonicalPhase !== "needs_you"
    || isChatToolType(session.toolType)
    || Boolean(session.attentionRequestedAt);
  const canSettle = settled || (!isActivelyRunning && canDismissNeedsYou);

  return (
    <span
      className="group/status-slot relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs"
      data-session-status-slot=""
    >
      {/* pointer-events-none is load-bearing, not decoration: on hover this
          label becomes `absolute right-0 opacity-0`, which paints it directly
          ON TOP of the now-in-flow action buttons. Without it, the invisible
          label swallows every click aimed at Snooze/Settle. */}
      <span
        data-testid="session-status-label"
        className={cn(
          "pointer-events-none self-center whitespace-nowrap tabular-nums transition-opacity",
          "group-focus-within/status-slot:absolute group-focus-within/status-slot:right-0 group-focus-within/status-slot:opacity-0",
          "group-hover/v2-row:absolute group-hover/v2-row:right-0 group-hover/v2-row:opacity-0",
          snoozeMenuOpen && "absolute right-0 opacity-0",
          compact ? "text-[10px]" : "text-[11px]",
        )}
      >
        <SessionStatusLabel
          presentation={presentation}
          elapsedSince={elapsedSince}
          futureAt={session.nextWakeAt}
          timestampLabel={timestampLabel}
          compact={compact}
        />
      </span>

      {actionsEnabled ? (
        // Going `static` on hover is what makes the swap free: the cluster
        // claims real width exactly when the label gives it up.
        <span
          className={cn(
            "absolute inset-y-0 right-0 flex items-stretch opacity-0 transition-opacity",
            "focus-within:static focus-within:opacity-100",
            "group-hover/v2-row:static group-hover/v2-row:opacity-100",
            snoozeMenuOpen && "static opacity-100",
          )}
        >
          <SessionSnoozeControl
            session={session}
            snoozed={snoozed}
            compact={compact}
            runtimePin={runtimePin}
            onOpenChange={setSnoozeMenuOpen}
          />
          {canSettle ? (
            <button
              type="button"
              aria-label={settled ? "Un-settle session" : "Settle session"}
              title={settled ? "Un-settle session" : "Settle session"}
              data-testid="session-settle-button"
              className={cn(SESSION_ACTION_BUTTON_CLASS, "-mr-1")}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void (settled
                  ? unsettleSession(session, runtimePin)
                  : settleSession(session, runtimePin));
              }}
            >
              {settled ? (
                <ArrowUUpLeft size={13} weight="bold" aria-hidden />
              ) : (
                <Check size={13} weight="bold" aria-hidden />
              )}
              {compact ? null : <span>{settled ? "Un-settle" : "Settle"}</span>}
            </button>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
