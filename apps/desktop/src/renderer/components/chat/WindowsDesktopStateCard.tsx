import { useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import { Lock, WindowsLogo, Warning } from "@phosphor-icons/react";

import { macDesktopErrorText } from "./macDesktopErrorText";
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
  runtimePin,
  starting = false,
}: {
  laneId: string;
  laneName: string | null | undefined;
  windows: WindowsDesktopStatus;
  runtimePin?: OpenProjectBinding | null;
  starting?: boolean;
  /** Re-read the status after an action. */
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<"setup" | "save" | "forget" | "start" | "takeover" | "shared" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showingConsent, setShowingConsent] = useState(false);

  const run = async (operation: NonNullable<typeof busy>, action: () => Promise<unknown>): Promise<void> => {
    if (busy) return;
    setBusy(operation);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (caught) {
      // Surface the refusal. A status re-read alone cannot show it when the
      // host state did not change, so the card keeps the sentence itself.
      setError(macDesktopErrorText(caught instanceof Error ? caught.message : String(caught), { laneId, laneName }) ?? "Try again.");
    } finally {
      setBusy(null);
    }
  };

  const api = window.ade.macDesktop;
  const holderName = windows.heldByLaneName?.trim() || "Another lane";
  const heldByOther = Boolean(windows.heldByLaneId && windows.heldByLaneId !== laneId);

  const signInWaiting = windows.signInWaiting === true;
  if (busy || starting || windows.state === "signing_in" || signInWaiting) {
    const needsPassword = busy === "save" || signInWaiting ||
      (!windows.passwordSaved && (starting || busy === "start" || windows.state === "signing_in"));
    return (
      <MacDesktopStateCard
        testId="windows-desktop-waiting"
        tone="busy"
        icon={WindowsLogo}
        title={busy === "setup" ? "Approve setup on the Windows PC" : needsPassword ? "Waiting for you on the Windows PC" : busy === "forget" ? "Forgetting saved password…" : busy === "shared" ? "Opening your main desktop…" : "Starting your private screen…"}
        detail={busy === "setup" ? "Choose Yes in the Windows admin prompt. You only need to do this once." : needsPassword ? "Enter your Windows password in the sign-in window on that PC, not your PIN. Close the window to cancel." : busy === "forget" ? "Removing the password saved for ADE." : "Keep this tab open. Your screen will appear when it is ready."}
      />
    );
  }

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
              disabled={busy !== null}
              onClick={() => void run("shared", () => api.useSharedDesktop({ laneId }, runtimePin))}
            >
              <WindowsLogo size={14} />
              Use main desktop
            </button>
            <button
              type="button"
              data-testid="windows-desktop-consent-decline"
              className={MAC_DESKTOP_SECONDARY_BUTTON}
              disabled={busy !== null}
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
        icon={WindowsLogo}
        title={`${holderName} is using the private screen`}
        detail="Take over starts a clean screen for this lane."
        actions={(
          <>
            <button
              type="button"
              data-testid="windows-desktop-take-over"
              className={WORK_TOOL_PRIMARY_BUTTON}
              disabled={busy !== null}
              onClick={() => void (async () => {
                const confirmed = await confirmDialog({
                  title: `Take the private screen from ${holderName}?`,
                  message: "Their screen is signed out and cleared. Nothing carries over.",
                  confirmLabel: "Take over",
                });
                if (!confirmed) return;
                await run("takeover", () => api.takeoverWindows({ laneId }, runtimePin));
              })()}
            >
              Take over
            </button>
            <button
              type="button"
              data-testid="windows-desktop-held-shared"
              className={MAC_DESKTOP_SECONDARY_BUTTON}
              disabled={busy !== null}
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
        icon={WindowsLogo}
        title="Give your agents a private Windows screen"
        detail="One-time setup: approve Windows setup, then save your Windows password. Your agents get a separate screen. You can also let them use your main desktop."
        actions={(
          <>
            <button
              type="button"
              data-testid="windows-desktop-setup-run"
              className={WORK_TOOL_PRIMARY_BUTTON}
              disabled={busy !== null}
              onClick={() => void run("setup", () => api.setupWindows({ allowPrompt: true }, runtimePin))}
            >
              Set up private screens
            </button>
            <button
              type="button"
              data-testid="windows-desktop-setup-shared"
              className={MAC_DESKTOP_SECONDARY_BUTTON}
              disabled={busy !== null}
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
            disabled={busy !== null}
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
      icon={WindowsLogo}
      title={windows.passwordSaved ? "Your private screen is ready" : "Next: save your Windows password"}
      detail={windows.passwordSaved ? "Your agents can use a separate Windows screen. Your password stays saved on that PC." : "Enter it once on the Windows PC so ADE can sign in to private screens for you. Use your password, not your PIN."}
      actions={(
        <>
          {windows.passwordSaved ? <button
            type="button"
            data-testid="windows-desktop-start"
            className={WORK_TOOL_PRIMARY_BUTTON}
            disabled={busy !== null}
            onClick={() => void run("start", () => api.start({ laneId, seatMode: "private" }, runtimePin))}
          >
            <WindowsLogo size={14} />
            Start private screen
          </button> : null}
          <button
            type="button"
            className={windows.passwordSaved ? MAC_DESKTOP_SECONDARY_BUTTON : WORK_TOOL_PRIMARY_BUTTON}
            disabled={busy !== null}
            onClick={() => void run(windows.passwordSaved ? "forget" : "save", () => api.setupWindows({ allowPrompt: true, ...(windows.passwordSaved ? { forgetPassword: true } : { savePassword: true }) }, runtimePin))}
          >
            {windows.passwordSaved ? "Forget saved password" : "Enter Windows password"}
          </button>
          <button
            type="button"
            data-testid="windows-desktop-shared"
            className={MAC_DESKTOP_SECONDARY_BUTTON}
            disabled={busy !== null}
            onClick={() => setShowingConsent(true)}
          >
            Use main desktop
          </button>
        </>
      )}
    />
  );
}
