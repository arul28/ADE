import { useState } from "react";
import { Desktop, Lock, Monitor, Warning } from "@phosphor-icons/react";

import { confirmDialog } from "../ui/dialog";
import {
  WINDOWS_DESKTOP_SHARED_CONSENT_MESSAGE,
  windowsDesktopPrivateUnavailableMessage,
  type WindowsDesktopStatus,
} from "../../../shared/types/macDesktop";
import { MAC_DESKTOP_SECONDARY_BUTTON, MacDesktopStateCard } from "./MacDesktopStateCard";
import { WORK_TOOL_PRIMARY_BUTTON } from "../terminals/workToolChrome";

/**
 * The Windows Desktop pane's no-picture states: setup, held, locked, shared.
 *
 * The Mac pane is a screen with a display or one of its own states (off,
 * permissions, starting). Windows adds four host states that have no Mac
 * equivalent, and they all resolve to a short card with one or two buttons —
 * the design rule the owner set for this feature. Everything the card needs
 * comes from `status.windowsDesktop`; it drives the service through the same
 * `window.ade.macDesktop` namespace the pane already uses.
 *
 * The card never starts a shared seat by itself: `Use main desktop` shows the
 * consent sentence first, and the create carries `sharedDesktopConsent: true`
 * only after the person presses the second button. That is the policy boundary
 * in the UI; the service refuses a shared create without the field regardless.
 */
export function WindowsDesktopStateCard({
  laneId,
  laneName,
  windows,
  onChanged,
}: {
  laneId: string;
  laneName: string | null | undefined;
  windows: WindowsDesktopStatus;
  /** Re-read the status after an action. */
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showingConsent, setShowingConsent] = useState(false);

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (caught) {
      // Surface the refusal. A status re-read alone cannot show it when the
      // host state did not change, so the card keeps the sentence itself.
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const api = window.ade.macDesktop;
  const holderName = windows.heldByLaneName?.trim() || "Another lane";
  const heldByOther = Boolean(windows.heldByLaneId && windows.heldByLaneId !== laneId);

  if (error) {
    return (
      <MacDesktopStateCard
        testId="windows-desktop-error"
        tone="error"
        icon={Warning}
        title="Windows Desktop couldn't do that"
        detail={error}
        actions={(
          <button
            type="button"
            data-testid="windows-desktop-error-dismiss"
            className={MAC_DESKTOP_SECONDARY_BUTTON}
            onClick={() => {
              setError(null);
              onChanged();
            }}
          >
            Check again
          </button>
        )}
      />
    );
  }

  if (showingConsent) {
    return (
      <MacDesktopStateCard
        testId="windows-desktop-shared-consent"
        tone="idle"
        icon={Warning}
        title="Use your main desktop?"
        detail={WINDOWS_DESKTOP_SHARED_CONSENT_MESSAGE}
        actions={(
          <>
            <button
              type="button"
              data-testid="windows-desktop-consent-accept"
              className={WORK_TOOL_PRIMARY_BUTTON}
              disabled={busy}
              onClick={() => void run(() => api.useSharedDesktop({ laneId }))}
            >
              <Monitor size={14} />
              Use main desktop
            </button>
            <button
              type="button"
              data-testid="windows-desktop-consent-decline"
              className={MAC_DESKTOP_SECONDARY_BUTTON}
              disabled={busy}
              onClick={() => setShowingConsent(false)}
            >
              No
            </button>
          </>
        )}
      />
    );
  }

  if (windows.state === "locked") {
    return (
      <MacDesktopStateCard
        testId="windows-desktop-locked"
        tone="idle"
        icon={Lock}
        title="This PC is locked"
        detail="Unlock it to continue. ADE keeps working when the screen is back."
        actions={(
          <button
            type="button"
            data-testid="windows-desktop-locked-check"
            className={MAC_DESKTOP_SECONDARY_BUTTON}
            onClick={onChanged}
          >
            Check again
          </button>
        )}
      />
    );
  }

  if (heldByOther) {
    return (
      <MacDesktopStateCard
        testId="windows-desktop-held"
        tone="idle"
        icon={Monitor}
        title={`${holderName} is using the private screen`}
        detail="Take over starts a clean screen for this lane."
        actions={(
          <>
            <button
              type="button"
              data-testid="windows-desktop-take-over"
              className={WORK_TOOL_PRIMARY_BUTTON}
              disabled={busy}
              onClick={() => void (async () => {
                const confirmed = await confirmDialog({
                  title: `Take the private screen from ${holderName}?`,
                  message: "Their screen is signed out and cleared. Nothing carries over.",
                  confirmLabel: "Take over",
                });
                if (!confirmed) return;
                await run(() => api.takeoverWindows({ laneId }));
              })()}
            >
              Take over
            </button>
            <button
              type="button"
              data-testid="windows-desktop-held-shared"
              className={MAC_DESKTOP_SECONDARY_BUTTON}
              disabled={busy}
              onClick={() => setShowingConsent(true)}
            >
              Use main desktop
            </button>
          </>
        )}
      />
    );
  }

  if (windows.state === "setup_required") {
    return (
      <MacDesktopStateCard
        testId="windows-desktop-setup"
        tone="idle"
        icon={Desktop}
        title="Set up private screens"
        detail="One admin prompt enables private sessions and Remote Desktop. ADE connects to it on this PC."
        actions={(
          <>
            <button
              type="button"
              data-testid="windows-desktop-setup-run"
              className={WORK_TOOL_PRIMARY_BUTTON}
              disabled={busy}
              onClick={() => void run(() => api.setupWindows({ allowPrompt: true }))}
            >
              Set up
            </button>
            <button
              type="button"
              data-testid="windows-desktop-setup-shared"
              className={MAC_DESKTOP_SECONDARY_BUTTON}
              disabled={busy}
              onClick={() => setShowingConsent(true)}
            >
              Use main desktop
            </button>
          </>
        )}
      />
    );
  }

  if (windows.state === "not_console_session" || windows.state === "unavailable") {
    return (
      <MacDesktopStateCard
        testId="windows-desktop-unavailable"
        tone="error"
        icon={Warning}
        title="Private Windows screen is unavailable"
        detail={windowsDesktopPrivateUnavailableMessage(windows.privateUnavailableReason ?? windows.state)}
        actions={(
          <button
            type="button"
            data-testid="windows-desktop-unavailable-shared"
            className={MAC_DESKTOP_SECONDARY_BUTTON}
            disabled={busy}
            onClick={() => setShowingConsent(true)}
          >
            Use main desktop
          </button>
        )}
      />
    );
  }

  // Ready, or holding a shared seat with nothing live: offer the private screen.
  return (
    <MacDesktopStateCard
      testId="windows-desktop-off"
      tone="idle"
      icon={Monitor}
      title={laneName ? `Windows Desktop · ${laneName}` : "Windows Desktop is off"}
      detail={windows.passwordSaved ? "A private Windows screen for this lane’s apps. Your saved password is kept on this PC." : "Save your Windows password once to start private screens without returning to this PC for each sign-in."}
      actions={(
        <>
          <button
            type="button"
            data-testid="windows-desktop-start"
            className={WORK_TOOL_PRIMARY_BUTTON}
            disabled={busy}
            onClick={() => void run(() => api.start({ laneId, seatMode: "private" }))}
          >
            <Monitor size={14} />
            Start private screen
          </button>
          <button
            type="button"
            className={MAC_DESKTOP_SECONDARY_BUTTON}
            disabled={busy}
            onClick={() => void run(() => api.setupWindows({ allowPrompt: true, ...(windows.passwordSaved ? { forgetPassword: true } : { savePassword: true }) }))}
          >
            {windows.passwordSaved ? "Forget saved password" : "Save Windows password"}
          </button>
          <button
            type="button"
            data-testid="windows-desktop-shared"
            className={MAC_DESKTOP_SECONDARY_BUTTON}
            disabled={busy}
            onClick={() => setShowingConsent(true)}
          >
            Use main desktop
          </button>
        </>
      )}
    />
  );
}
