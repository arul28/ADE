import { useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import { Key, Lock, WindowsLogo, Warning } from "@phosphor-icons/react";

import {
  macDesktopErrorCode,
  windowsDesktopOperationFailureText,
  type WindowsDesktopOperationFailureKind,
} from "./macDesktopErrorText";
import { confirmDialog } from "../ui/dialog";
import {
  WINDOWS_DESKTOP_SHARED_CONSENT_MESSAGE,
  windowsDesktopPrivateUnavailableMessage,
  type MacDesktopDriverHealth,
  type WindowsDesktopStatus,
} from "../../../shared/types/macDesktop";
import { windowsDesktopOperationFor } from "./useMacDesktopStatus";
import { MAC_DESKTOP_SECONDARY_BUTTON, MacDesktopStateCard } from "./MacDesktopStateCard";
import { WORK_TOOL_PRIMARY_BUTTON } from "../terminals/workToolChrome";

/**
 * The Windows Desktop pane's no-picture states: setup, password, sign-in in
 * progress, a failed step, held, locked, unavailable and ready.
 *
 * Everything that has to survive leaving the chat comes from the HOST, not from
 * this card: `windowsDesktop.operation` says a setup, a password save or a
 * private start is running (and since when), `phase` says where the Windows
 * sign-in stands, and `lastOperation` says how the last one ended. A card that
 * was closed mid-sign-in and opened again shows the same progress and the same
 * clock, never an empty state and never a second request.
 *
 * `Use main desktop` asks for consent first (`confirmDialog`), except from the
 * held card: there the button itself is the trusted client's consent, and the
 * card says what it means before it is pressed. The service refuses a shared create without the
 * consent field regardless.
 */

type Busy = WindowsDesktopOperationFailureKind;

type Failure = {
  kind: Busy;
  raw: string;
  /** Epoch ms. A newer outcome from the host replaces it. */
  at: number;
  /** For the host's record: its `endedAt`, the key a dismissal is stored under. */
  hostKey?: string;
};

/** A host failure older than this is history, not something to act on. */
const HOST_FAILURE_TTL_MS = 10 * 60_000;

/** Dismissed host outcomes, by `endedAt`, so a reopened pane does not repeat them. */
const dismissedHostOutcomes = new Set<string>();

function hostFailureFor(windows: WindowsDesktopStatus, laneId: string): Failure | null {
  const last = windows.lastOperation ?? null;
  if (!last || last.outcome !== "failed") return null;
  if (last.laneId !== null && last.laneId !== laneId) return null;
  if (dismissedHostOutcomes.has(last.endedAt)) return null;
  const at = Date.parse(last.endedAt);
  if (!Number.isFinite(at) || Date.now() - at > HOST_FAILURE_TTL_MS) return null;
  return { kind: last.kind, raw: last.error ?? "", at, hostKey: last.endedAt };
}

const TASKBAR_HINT = "If you don't see it, it may be behind other windows — check the taskbar.";

/** The in-progress card's words, from what is running and where its sign-in stands. */
function progressCopy(args: {
  kind: Busy;
  phase: WindowsDesktopStatus["phase"];
  signInWaiting: boolean;
  passwordSaved: boolean;
  driverRestarting: boolean;
}): { title: string; detail: string } {
  const { kind, phase, signInWaiting, passwordSaved, driverRestarting } = args;
  if (driverRestarting) {
    return {
      title: "The desktop helper is restarting…",
      detail: "It stopped responding during this step. ADE will say what happened when it is back.",
    };
  }
  switch (kind) {
    case "setup":
      return {
        title: "Approve setup on the Windows PC",
        detail: `Choose Yes in the Windows admin prompt on that PC. ${TASKBAR_HINT} You only do this once.`,
      };
    case "forget_password":
      return { title: "Forgetting the saved password…", detail: "Removing the password saved for ADE on that PC." };
    case "shared":
      return { title: "Opening your main desktop…", detail: "The agent will work on your own Windows desktop." };
    default:
      break;
  }
  // Password save, private start and takeover all go through Windows' own
  // sign-in, so they share its phases.
  const promptOpen = phase === "prompt_open" || signInWaiting;
  if (promptOpen) {
    return {
      title: "Waiting for your password",
      detail: `A Windows sign-in window opened on that PC. ${TASKBAR_HINT} Use your Windows password, not your PIN.`,
    };
  }
  if (phase === "verifying") {
    return kind === "save_password"
      ? { title: "Checking your password…", detail: "Windows is signing in once to make sure it works. Nothing is saved until it does." }
      : { title: "Signing in…", detail: "Windows is signing in to your private screen." };
  }
  if (phase === "starting") {
    return { title: "Starting your private screen…", detail: "Signed in. Connecting the screen to ADE." };
  }
  if (phase === "cleaning_up") {
    return {
      title: "Finishing up…",
      detail: kind === "save_password"
        ? "Signing out the check session on that PC."
        : "Signing out a session on that PC.",
    };
  }
  // An older driver reports no phase: say what this step usually waits on.
  if (kind === "save_password" || !passwordSaved) {
    return {
      title: "Waiting for your password",
      detail: `A Windows sign-in window opens on that PC. ${TASKBAR_HINT} Use your Windows password, not your PIN.`,
    };
  }
  return {
    title: "Starting your private screen…",
    detail: "Signing in with your saved password. Your screen appears here when it is ready.",
  };
}

export function WindowsDesktopStateCard({
  laneId,
  laneName,
  sessionId = null,
  windows,
  driver = null,
  onChanged,
  runtimePin,
  starting = false,
  startError = null,
  onDismissStartError,
}: {
  laneId: string;
  laneName: string | null | undefined;
  /** The chat the pane is attached to, for attribution of the seat it starts. */
  sessionId?: string | null;
  windows: WindowsDesktopStatus;
  /** The helper's health, to say "restarting" rather than wait in silence. */
  driver?: MacDesktopDriverHealth | null;
  runtimePin?: OpenProjectBinding | null;
  /** The pane's own start is running. */
  starting?: boolean;
  /** The pane's own start failed with this text. */
  startError?: string | null;
  onDismissStartError?: () => void;
  /** Re-read the status after an action. */
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<{ kind: Busy; at: number } | null>(null);
  const [localFailure, setLocalFailure] = useState<Failure | null>(null);
  const [, setDismissTick] = useState(0);

  const api = window.ade.macDesktop;
  const holderLane = windows.heldByLaneName?.trim();
  const holderName = holderLane ? `Lane ${holderLane}` : "Another lane";
  const heldByOther = Boolean(windows.heldByLaneId && windows.heldByLaneId !== laneId);
  const hostOperation = windowsDesktopOperationFor(windows, laneId);
  const errorOptions = { laneId, laneName, passwordSaved: windows.passwordSaved };

  /**
   * Run one step. Refused while the host is already running one: the card is
   * showing that step's progress, and a second request would only come back
   * as a refusal.
   */
  const run = async (kind: Busy, action: () => Promise<unknown>, then?: () => Promise<unknown>): Promise<void> => {
    if (busy || hostOperation) return;
    setBusy({ kind, at: Date.now() });
    setLocalFailure(null);
    onDismissStartError?.();
    let failedKind: Busy = kind;
    try {
      await action();
      if (then) {
        // The person's intent was to start: carry on without another click.
        failedKind = "start_private";
        setBusy({ kind: "start_private", at: Date.now() });
        await then();
      }
    } catch (caught) {
      setLocalFailure({
        kind: failedKind,
        raw: caught instanceof Error ? caught.message : String(caught),
        at: Date.now(),
      });
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  /** What each step asks the host to do: the buttons and Try again both run these. */
  const ACTIONS: Record<Busy, () => Promise<unknown>> = {
    setup: () => api.setupWindows({ allowPrompt: true }, runtimePin),
    save_password: () => api.setupWindows({ allowPrompt: true, savePassword: true }, runtimePin),
    forget_password: () => api.setupWindows({ allowPrompt: true, forgetPassword: true }, runtimePin),
    start_private: () => api.start({ laneId, seatMode: "private", chatSessionId: sessionId }, runtimePin),
    takeover: () => api.takeoverWindows({ laneId, chatSessionId: sessionId }, runtimePin),
    shared: () => api.useSharedDesktop({ laneId, chatSessionId: sessionId }, runtimePin),
  };
  const runStep = (kind: Busy) => void run(kind, ACTIONS[kind]);
  /** Save the password, then start the private screen without another click. */
  const saveAndStart = () => void run("save_password", ACTIONS.save_password, ACTIONS.start_private);
  const openSharedDesktop = () => runStep("shared");
  /** `Use main desktop` from a card that has not already said what it means. */
  const askThenOpenSharedDesktop = () => void (async () => {
    const confirmed = await confirmDialog({
      title: "Use your main desktop?",
      message: WINDOWS_DESKTOP_SHARED_CONSENT_MESSAGE,
      confirmLabel: "Use main desktop",
    });
    if (confirmed) openSharedDesktop();
  })();

  // In progress: this card's own request, the pane's start, or one the host is
  // running for this lane (started before the pane was last closed).
  const signInWaiting = windows.signInWaiting === true;
  const progressKind: Busy | null = busy?.kind
    ?? hostOperation?.kind
    ?? (starting || windows.state === "signing_in" || signInWaiting ? "start_private" : null);
  if (progressKind) {
    const hostSince = hostOperation ? Date.parse(hostOperation.startedAt) : NaN;
    const since = Number.isFinite(hostSince) ? hostSince : busy?.at ?? null;
    const copy = progressCopy({
      kind: progressKind,
      phase: windows.phase ?? null,
      signInWaiting,
      passwordSaved: windows.passwordSaved,
      driverRestarting: driver?.state === "starting" && Boolean(busy || hostOperation),
    });
    return (
      <MacDesktopStateCard
        // Keyed so the clock restarts with a new step, not with every phase.
        key={`${progressKind}:${since ?? "local"}`}
        testId="windows-desktop-waiting"
        tone="busy"
        icon={progressKind === "save_password" || progressKind === "forget_password" ? Key : WindowsLogo}
        title={copy.title}
        detail={copy.detail}
        since={since}
      />
    );
  }

  // The newest failure wins: this card's own, the pane's start, or the host's
  // record of a step that ended while the pane was closed.
  const hostFailure = hostFailureFor(windows, laneId);
  const paneFailure: Failure | null = startError ? { kind: "start_private", raw: startError, at: 0 } : null;
  const failure = [localFailure, hostFailure, paneFailure]
    .filter((entry): entry is Failure => entry !== null)
    .sort((a, b) => b.at - a.at)[0] ?? null;
  if (failure) {
    const text = windowsDesktopOperationFailureText(failure.kind, failure.raw, errorOptions);
    const dismiss = () => {
      if (failure.hostKey) dismissedHostOutcomes.add(failure.hostKey);
      setLocalFailure(null);
      if (failure === paneFailure) onDismissStartError?.();
      setDismissTick((tick) => tick + 1);
      onChanged();
    };
    // A saved password Windows rejected has been forgotten: the fix is a new one.
    const needsNewPassword = failure.kind !== "save_password" && !windows.passwordSaved
      && macDesktopErrorCode(failure.raw) === "WINDOWS_DESKTOP_WRONG_PASSWORD";
    const retry = (): void => {
      if (failure.hostKey) dismissedHostOutcomes.add(failure.hostKey);
      if (needsNewPassword) saveAndStart();
      else runStep(failure.kind);
    };
    return (
      <MacDesktopStateCard
        testId="windows-desktop-error"
        tone="error"
        icon={Warning}
        title={text.title}
        detail={text.detail}
        actions={(
          <>
            <button
              type="button"
              data-testid="windows-desktop-error-retry"
              className={WORK_TOOL_PRIMARY_BUTTON}
              onClick={retry}
            >
              {needsNewPassword ? "Enter Windows password" : "Try again"}
            </button>
            <button
              type="button"
              data-testid="windows-desktop-error-dismiss"
              className={MAC_DESKTOP_SECONDARY_BUTTON}
              onClick={dismiss}
            >
              Back
            </button>
          </>
        )}
      />
    );
  }

  if (driver && (driver.state === "crash_loop" || driver.state === "protocol_error" || driver.state === "missing")) {
    return (
      <MacDesktopStateCard
        testId="windows-desktop-driver"
        tone="error"
        icon={Warning}
        title={driver.title || "The desktop helper isn't running"}
        detail={driver.message || "ADE could not start its Windows desktop helper."}
        actions={(
          <button
            type="button"
            data-testid="windows-desktop-driver-check"
            className={MAC_DESKTOP_SECONDARY_BUTTON}
            onClick={onChanged}
          >
            Check again
          </button>
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
        detail="Unlock it to continue. The agent picks up where it left off once the PC is unlocked."
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
        detail="This PC has one private screen. Take it over (their screen signs out), or let this lane's agent use your main desktop — it takes over the window you are using while it acts."
        actions={(
          <>
            <button
              type="button"
              data-testid="windows-desktop-held-shared"
              className={WORK_TOOL_PRIMARY_BUTTON}
              // One click: from the held card the press is the consent, and
              // the sentence above says what it means.
              onClick={openSharedDesktop}
            >
              <WindowsLogo size={14} />
              Use main desktop
            </button>
            <button
              type="button"
              data-testid="windows-desktop-take-over"
              className={MAC_DESKTOP_SECONDARY_BUTTON}
              onClick={() => void (async () => {
                const confirmed = await confirmDialog({
                  title: `Take the private screen from ${holderLane ? `lane ${holderLane}` : "the other lane"}?`,
                  message: "Their screen signs out and its apps close. Nothing carries over.",
                  confirmLabel: "Take over",
                });
                if (confirmed) runStep("takeover");
              })()}
            >
              Take over
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
        detail="One-time setup on this PC: approve a Windows admin prompt, then save your Windows password. Agents then get their own screen, and yours stays yours."
        actions={(
          <>
            <button
              type="button"
              data-testid="windows-desktop-setup-run"
              className={WORK_TOOL_PRIMARY_BUTTON}
              onClick={() => runStep("setup")}
            >
              Set up private screens
            </button>
            <button
              type="button"
              data-testid="windows-desktop-setup-shared"
              className={MAC_DESKTOP_SECONDARY_BUTTON}
              onClick={askThenOpenSharedDesktop}
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
        title="The private Windows screen is unavailable"
        detail={windowsDesktopPrivateUnavailableMessage(windows.privateUnavailableReason ?? windows.state)}
        actions={(
          <>
            <button
              type="button"
              data-testid="windows-desktop-unavailable-shared"
              className={WORK_TOOL_PRIMARY_BUTTON}
              onClick={askThenOpenSharedDesktop}
            >
              Use main desktop
            </button>
            <button
              type="button"
              data-testid="windows-desktop-unavailable-check"
              className={MAC_DESKTOP_SECONDARY_BUTTON}
              onClick={onChanged}
            >
              Check again
            </button>
          </>
        )}
      />
    );
  }

  if (!windows.passwordSaved) {
    return (
      <MacDesktopStateCard
        testId="windows-desktop-off"
        tone="idle"
        icon={Key}
        title="Save your Windows password"
        detail="ADE signs in to your private screen with it. It stays in Windows Credential Manager on that PC. Use your password, not your PIN."
        actions={(
          <>
            <button
              type="button"
              data-testid="windows-desktop-save-and-start"
              className={WORK_TOOL_PRIMARY_BUTTON}
              onClick={saveAndStart}
            >
              Save password and start
            </button>
            <button
              type="button"
              data-testid="windows-desktop-start"
              className={MAC_DESKTOP_SECONDARY_BUTTON}
              title="Windows asks for your password each time"
              onClick={() => runStep("start_private")}
            >
              Start without saving
            </button>
            <button
              type="button"
              data-testid="windows-desktop-shared"
              className={MAC_DESKTOP_SECONDARY_BUTTON}
              onClick={askThenOpenSharedDesktop}
            >
              Use main desktop
            </button>
          </>
        )}
      />
    );
  }

  // Ready: the password is saved and the private screen is free.
  return (
    <MacDesktopStateCard
      testId="windows-desktop-off"
      tone="idle"
      icon={WindowsLogo}
      title="Your private screen is ready"
      detail="Start it to give this lane's agents their own Windows desktop. Your own screen stays yours."
      actions={(
        <>
          <button
            type="button"
            data-testid="windows-desktop-start"
            className={WORK_TOOL_PRIMARY_BUTTON}
            onClick={() => runStep("start_private")}
          >
            <WindowsLogo size={14} />
            Start private screen
          </button>
          <button
            type="button"
            data-testid="windows-desktop-shared"
            className={MAC_DESKTOP_SECONDARY_BUTTON}
            onClick={askThenOpenSharedDesktop}
          >
            Use main desktop
          </button>
        </>
      )}
      footer={(
        <button
          type="button"
          data-testid="windows-desktop-forget-password"
          className="font-sans text-xs text-muted-fg underline-offset-2 hover:text-fg hover:underline"
          onClick={() => runStep("forget_password")}
        >
          Forget saved password
        </button>
      )}
    />
  );
}
