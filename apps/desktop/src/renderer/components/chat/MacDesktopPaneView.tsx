import { memo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowSquareIn,
  ArrowsInSimple,
  ArrowsOutSimple,
  Camera,
  Cursor,
  Monitor,
  Plus,
  Power,
  Record,
  Stop,
  WarningCircle,
} from "@phosphor-icons/react";
import { macDesktopNotParkedSentence } from "./macDesktopActivityText";
import type { MacDesktopWindow } from "../../../shared/types/macDesktop";
import { cn } from "../ui/cn";
import { RecordingPill, RecordingSavedRow } from "../shared/RecordingReceipt";
import {
  WORK_TOOL_CHROME_CHIP,
  WORK_TOOL_CHROME_ROW,
  WORK_TOOL_PRIMARY_BUTTON,
  WORK_TOOL_SECTION_LABEL_TEXT,
  WorkToolChromeButton,
  WorkToolEmptyLine,
} from "../terminals/workToolChrome";
import { WorkToolPreviewControls } from "../terminals/workToolPreviewControls";
import { H264VideoCanvas } from "./H264VideoCanvas";
import { MacDesktopAgentCursor } from "./MacDesktopAgentCursor";
import { MacDesktopPermissionCard } from "./MacDesktopPermissionCard";
import { MAC_DESKTOP_SECONDARY_BUTTON, MacDesktopStateCard } from "./MacDesktopStateCard";
import { MAC_DESKTOP_NOT_ANSWERING } from "./macDesktopStatusStore";
import { MacDesktopStatusStrip, type MacDesktopStripMessage } from "./MacDesktopStatusStrip";
import { MacDesktopClaimPicker } from "./MacDesktopClaimPicker";
import {
  MAC_DESKTOP_LIST_ROW,
  MAC_DESKTOP_LIST_TITLE,
  MacDesktopAppIcon,
  MacDesktopMinimizedBadge,
  MacDesktopRowAction,
} from "./macDesktopWindowList";
import { macDesktopErrorText } from "./macDesktopErrorText";
import {
  macDesktopPresentAction,
  macDesktopRelativeTime,
  macDesktopStatusPill,
  macDesktopStatusSegments,
  macDesktopStripControls,
  macDesktopWindowTitle,
} from "./macDesktopStrip";
import { displayFrameToViewRect } from "./macDesktopGeometry";
import {
  type MacDesktopChromeScope,
  type MacDesktopPanelController,
} from "./useMacDesktopPanelController";
import { MacDesktopFullscreenView } from "./MacDesktopFullscreenView";

const MAC_DESKTOP_FULLSCREEN_MARGIN = 16;

/**
 * One parked window, as a row in the Apps section.
 *
 * A row and not a card: the first version drew a 28px initials tile ("GB") next
 * to the app's name printed twice, over two lines, inside a bordered box — a
 * 44px card per window in a 240px column, for a list whose whole job is to name
 * three windows. It is the app's own list row now, the same one the pane's Apps
 * list and the Add app picker use, so both lists look like one list.
 *
 * The app's name leads and the window's own title follows, muted: the app is
 * what a person recognises, the title is what tells its windows apart. No
 * ownership words — a window is either on this desktop (listed) or it is not.
 *
 * Memoised per window: a frame arriving or the pane resizing re-renders the
 * panel several times a second, and nothing on this row changes on any of them.
 */
type MacDesktopWindowCardProps = {
  window: MacDesktopWindow;
  selected: boolean;
  /** Resolved PNG for this app. The window row may not carry one of its own. */
  iconPng: string | null;
  onSelect: (windowId: number) => void;
  onRelease: (windowId: number) => void;
};

const MacDesktopWindowCard = memo(function MacDesktopWindowCard({
  window: entry,
  selected,
  iconPng,
  onSelect,
  onRelease,
}: MacDesktopWindowCardProps) {
  const title = macDesktopWindowTitle(entry);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      data-testid="mac-desktop-window-card"
      data-window-id={entry.id}
      onClick={() => onSelect(entry.id)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect(entry.id);
      }}
      title={title}
      className={cn(
        // A card, not a row: the list wraps left to right, so each one is a
        // fixed rectangle and the wrap point is the pane's width rather than
        // one window per line down the whole panel.
        "group flex h-8 w-[196px] shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] px-1.5 text-left",
        "border border-border/50 bg-surface transition-colors duration-[120ms] ease-out",
        "cursor-default",
        selected
          ? "bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_55%,transparent)]"
          : "hover:bg-white/[0.05]",
      )}
    >
      <MacDesktopAppIcon iconPng={iconPng ?? entry.iconPng} appName={entry.appName} />
      {/* The window's own title is the card's tooltip: it is what tells two
          windows of one app apart, and it does not fit on the face. */}
      <span className={cn(MAC_DESKTOP_LIST_TITLE, "text-[11.5px]")}>{entry.appName}</span>
      {entry.minimized ? <MacDesktopMinimizedBadge /> : null}
      <MacDesktopRowAction
        label="Release"
        testId="mac-desktop-window-release"
        title={`Send “${title}” back to your main screen`}
        onClick={() => onRelease(entry.id)}
      />
    </div>
  );
});

export function MacDesktopPaneView({ controller }: { controller: MacDesktopPanelController }) {
  const {
    laneId, laneName, sessionId, runtimePin, machineFacts, status, setStatus, statusError, setStatusError, readError,
    unconfirmed, refreshStatus, stopDisplay, stopping, start, starting, gaveUp, cursor, notParked, dismissNotParked,
    appsLeftOpen, dismissAppLeftOpen, pickerOpen, setPickerOpen, claimable, claimableLoading, claimError, expanded,
    setExpanded, paneMaximize, busy, setBusy, checkingPermissions, setCheckingPermissions, captureError, setCaptureError,
    captureNotice, setCaptureNotice, receipt, setReceipt, screenshotPending, viewRect, selectedWindowId, setSelectedWindowId,
    lastObservation, surfaceNode, videoHost, canvasSlot, attachCanvasSlot, attachSurface, errorText, display, lease, windows,
    supported, iHaveControl, parkedWindows, claimAppIcons, missingPermissions, permissionCheck, confirmStop, setConfirmStop,
    connectSlow, setConnectSlow, videoDetailsOpen, setVideoDetailsOpen, laneHostIsLocal, laneNames, live, connecting,
    cursorPoint, contentBox, lastFrame, handoverFrame, returnControl, takeControl, realInput, recording, toggleRecording,
    saveScreenshot, openReceipt, nowTick, recordingRunning, present, refreshClaimable, claimWindow, releaseWindowById,
    selectWindow, openSettingsPane, checkAgain, readAgain, stopNow, SETTINGS_PANE,
  } = controller;
  // Hidden entirely when the host cannot host a display. The tab is hidden too
  // (`workToolAvailability`); this is the case where the tab was already open
  // when the answer arrived.
  if (supported === false) {
    return (
      <WorkToolEmptyLine
        testId="mac-desktop-unsupported"
        title={status?.unsupportedReason ?? "This lane's runtime host cannot host a Mac display."}
      />
    );
  }

  /**
   * Every screen without a picture keeps a slim top row with the per-chat
   * floating-preview toggle, as the Apple tool's rail does. The Off, permission
   * and waiting screens used to return early with no row at all, so the toggle
   * was only reachable once a display was live.
   */
  const idle = (screen: ReactNode) => (
    <div className="relative flex h-full min-h-0 flex-col gap-2" data-testid="mac-desktop-panel">
      <div className={cn(WORK_TOOL_CHROME_ROW, "flex-nowrap justify-end gap-1")} data-testid="mac-desktop-idle-row">
        <WorkToolPreviewControls tool="mac-desktop" chatSessionId={sessionId} showMaximize={false} />
      </div>
      <div className="min-h-0 flex-1">{screen}</div>
    </div>
  );

  // A stop in flight wins over whatever the last status said. The host keeps
  // listing the display until the stop lands, and showing it live meanwhile is
  // the flicker a reopened tab used to have.
  if (stopping) {
    return idle(<MacDesktopStateCard testId="mac-desktop-stopping" tone="busy" title="Stopping Mac Desktop…" />);
  }

  if (!display) {
    /*
      No display: one state at a time, in this order, each on the same card.

        Stopping  a stop is in flight (above, whether or not a display shows)
        Starting  the person pressed Start here
        Checking  the first read has not answered (it times out into the next)
        Not answering  the newest read failed: Try again, or Reset
        Permissions    a grant is off: the permission card
        Failed    a Start that failed: the reason, and Start again
        Off       "Mac Desktop is off" and Start

      Watching never creates a display, and nothing on this list starts one
      except the person's Start. That is the fix for a pane that went from Off
      to Starting on its own: "Check again" used to start a display when the
      grants came back.
    */
    const resetButton = (
      <button
        type="button"
        data-testid="mac-desktop-reset"
        className={MAC_DESKTOP_SECONDARY_BUTTON}
        onClick={() => void stopDisplay()}
      >
        <Power size={14} />
        Reset
      </button>
    );
    if (starting) {
      return idle(
        <MacDesktopStateCard
          testId="mac-desktop-starting"
          tone="busy"
          title="Starting Mac Desktop…"
          detail="Making a private screen for this lane."
        />
      );
    }
    if (status == null || (unconfirmed && readError)) {
      if (!readError) {
        return idle(<MacDesktopStateCard testId="mac-desktop-checking" tone="busy" title="Checking Mac Desktop…" />);
      }
      return idle(
        <MacDesktopStateCard
          testId="mac-desktop-unreachable"
          tone="error"
          title="Can't reach Mac Desktop"
          detail={readError}
          actions={(
            <>
              <button
                type="button"
                data-testid="mac-desktop-read-again"
                className={WORK_TOOL_PRIMARY_BUTTON}
                onClick={() => void readAgain()}
              >
                Try again
              </button>
              {resetButton}
            </>
          )}
        />
      );
    }
    if (missingPermissions.length > 0) {
      return idle(
        <MacDesktopPermissionCard
          variant="page"
          permissions={status.permissions}
          appName={status.responsibleAppName ?? "ADE"}
          signing={status.signing ?? "unknown"}
          hostIsLocal={laneHostIsLocal}
          machineName={machineFacts.machineName}
          checking={checkingPermissions}
          lastCheck={permissionCheck}
          onOpenSettings={(kind) => openSettingsPane(SETTINGS_PANE[kind])}
          onCheckAgain={() => void checkAgain()}
          onStartAnyway={missingPermissions.includes("screenRecording") ? null : () => void start()}
        />
      );
    }
    if (statusError) {
      return idle(
        <MacDesktopStateCard
          testId="mac-desktop-failed"
          tone="error"
          title={gaveUp ? "Mac Desktop did not start" : "Something went wrong"}
          detail={statusError}
          actions={(
            <button
              type="button"
              data-testid="mac-desktop-start"
              className={WORK_TOOL_PRIMARY_BUTTON}
              onClick={() => void start()}
            >
              <Monitor size={14} />
              Start again
            </button>
          )}
        />
      );
    }
    return idle(
      <MacDesktopStateCard
        testId="mac-desktop-off"
        tone="idle"
        title="Mac Desktop is off"
        detail="A private screen for this lane's apps."
        footer={appsLeftOpen.length > 0 ? (
          /* The apps the stop could not quit, in the driver's own sentence.
             Nothing at all when every app quit. */
          <ul className="flex w-full min-w-0 flex-col gap-1.5 text-left" data-testid="mac-desktop-apps-left-open">
            {appsLeftOpen.map((app) => (
              <li
                key={app.pid}
                data-testid="mac-desktop-app-left-open"
                className="flex min-w-0 items-start gap-2 font-sans text-xs leading-5 text-muted-fg"
              >
                <span className="min-w-0 flex-1 break-words">{app.message}</span>
                <button
                  type="button"
                  className="shrink-0 text-muted-fg underline-offset-2 hover:text-fg hover:underline"
                  onClick={() => dismissAppLeftOpen(app.pid)}
                >
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        actions={(
          <button
            type="button"
            data-testid="mac-desktop-start"
            className={WORK_TOOL_PRIMARY_BUTTON}
            onClick={() => void start()}
          >
            <Monitor size={14} />
            Start
          </button>
        )}
      />
    );
  }

  /**
   * The inline permission line for a LIVE display.
   *
   * The denied first screen (no display yet) is the real block above; this is
   * the reminder while a display exists and one grant was revoked mid-session.
   */
  const pill = macDesktopStatusPill({ live: live.status, lease, iHaveControl });
  const statusSegments = macDesktopStatusSegments(pill);
  // The dot's tooltip is the only place the strip still says the state in words:
  // the name/status text that used to lead the row was the confusing part.
  const statusTooltip = [statusSegments.status, statusSegments.detail].filter(Boolean).join(" · ");
  const selectedWindow = parkedWindows.find((entry) => entry.id === selectedWindowId) ?? null;
  /* Where the selected window sits on the picture. A positioned div over the
     canvas, never a second canvas: it moves when the pane resizes and when the
     window moves, and a compositor layer is the whole cost. */
  const selectedRect = selectedWindow
    ? displayFrameToViewRect({ frame: selectedWindow.frame, rect: viewRect, display })
    : null;
  const presentAction = macDesktopPresentAction({
    hostIsLocal: Boolean(status?.hostIsLocal),
    ownedCount: windows.filter((entry) => entry.laneId === laneId).length,
    parkedCount: parkedWindows.length,
  });
  const controls = macDesktopStripControls({
    expanded,
    hostIsLocal: Boolean(status?.hostIsLocal),
    ownedCount: windows.filter((entry) => entry.laneId === laneId).length,
    parkedCount: parkedWindows.length,
  });
  /* ── The chrome row, built once and drawn in two places ───────────────

     The pane's 40px row and full screen's bar carry the SAME controls, which
     is the whole correction: full screen used to carry three of them and then
     fade even those out, so the owner arrived at a picture with no status, no
     Record, no Take over and no way back. Both rows are in the tree at once —
     the pane keeps rendering normally behind the overlay so leaving full
     screen is a z-index change and not a remount — so everything here is
     per-scope, including the testids. */

  /**
   * The one state mark left in the row: a small coloured dot with a tooltip.
   *
   * The strip used to lead with "ADE · <lane> · Live · Idle" in text, which was
   * the bulk of what made the pane read as confusing. The live/idle state is
   * still true and worth a glance, so it stays as a dot; the words move into
   * the tooltip, and the lane name and window count are gone from the strip
   * entirely (the Apps section below states the windows).
   */
  const renderStatusDot = (scope: MacDesktopChromeScope) => (
    <span
      title={statusTooltip}
      aria-label={statusTooltip}
      data-testid={scope === "pane" ? "mac-desktop-live-chip" : "mac-desktop-fs-live-chip"}
      className="inline-flex size-7 shrink-0 items-center justify-center"
    >
      <span
        data-testid={scope === "pane" ? "mac-desktop-live-dot" : "mac-desktop-fs-live-dot"}
        className={cn(
          "size-[7px] shrink-0 rounded-full",
          pill.tone === "live" ? "bg-emerald-400" : pill.tone === "error" ? "bg-rose-400/85" : "bg-amber-400",
        )}
      />
    </span>
  );

  const renderChromeRow = (scope: MacDesktopChromeScope) => {
    const suffix = scope === "pane" ? "" : "-fs";
    return (
      <>
        {renderStatusDot(scope)}

        {/* The per-chat floating-preview toggle, beside the dot at the left.
            At the far right it was the first thing a narrow MacBook pane
            clipped, and the owner could not find it. Maximize is
            `mac-desktop-expand` below, so this adds only the toggle. */}
        <WorkToolPreviewControls
          tool="mac-desktop"
          chatSessionId={sessionId}
          showMaximize={false}
          testIdSuffix={suffix}
        />

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {iHaveControl ? (
            <span
              className="mr-1 flex shrink-0 items-center gap-1.5 whitespace-nowrap px-1 text-[12px] text-amber-200"
              data-testid={`mac-desktop-takeover-banner${suffix}`}
            >
              You have control
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => void returnControl()}
              >
                Return to agent
              </button>
              <span className="text-[10px] text-muted-fg">Esc</span>
            </span>
          ) : null}

          <WorkToolChromeButton
            label={recording?.running ? "Stop recording" : "Record this screen"}
            onClick={() => void toggleRecording()}
            disabled={busy}
            active={recording?.running ?? false}
            testId={`mac-desktop-record${suffix}`}
          >
            {recording?.running ? <Stop size={16} weight="fill" /> : <Record size={16} weight="fill" />}
          </WorkToolChromeButton>

          <WorkToolChromeButton
            label={screenshotPending ? "Saving screenshot…" : "Save screenshot"}
            onClick={() => void saveScreenshot()}
            disabled={screenshotPending}
            testId={`mac-desktop-screenshot${suffix}`}
          >
            <Camera size={16} />
          </WorkToolChromeButton>

          {presentAction ? (
            <WorkToolChromeButton
              label={presentAction.label}
              onClick={() => void present(presentAction.destination)}
              disabled={busy}
              testId={`mac-desktop-present${suffix}`}
            >
              <ArrowSquareIn size={16} />
            </WorkToolChromeButton>
          ) : null}

          {iHaveControl ? null : (
            <WorkToolChromeButton
              label="Take over"
              onClick={() => void takeControl()}
              disabled={busy}
              testId={`mac-desktop-takeover${suffix}`}
            >
              <Cursor size={16} />
            </WorkToolChromeButton>
          )}

          {/* Always here while a display exists: the way out that does not
              depend on the picture, the lease or the video working. */}
          <WorkToolChromeButton
            label="Stop Mac Desktop"
            onClick={() => setConfirmStop(true)}
            disabled={stopping}
            active={confirmStop}
            testId={`mac-desktop-stop${suffix}`}
          >
            <Power size={16} />
          </WorkToolChromeButton>

          {/* The way out, spelled out in full screen and an icon in the pane —
              the one control whose label is a fact about where the row is. */}
          {scope === "fullscreen" ? (
            <button
              type="button"
              data-testid="mac-desktop-expand-fs"
              onClick={() => setExpanded(false)}
              className={cn(
                WORK_TOOL_CHROME_CHIP,
                "ml-1 shrink-0 gap-1.5 whitespace-nowrap px-2 text-fg/90 hover:bg-white/[0.08]",
              )}
            >
              <ArrowsInSimple size={14} />
              {controls.fullscreen.label}
              <span className="text-[10px] text-muted-fg">Esc</span>
            </button>
          ) : (
            <WorkToolChromeButton
              label={paneMaximize?.maximized ? "Restore pane" : controls.fullscreen.label}
              onClick={() => {
                if (paneMaximize) paneMaximize.setMaximized(!paneMaximize.maximized);
                else setExpanded(true);
              }}
              testId="mac-desktop-expand"
            >
              {paneMaximize?.maximized ? <ArrowsInSimple size={16} /> : <ArrowsOutSimple size={16} />}
            </WorkToolChromeButton>
          )}
        </div>
      </>
    );
  };

  /* ── The picture ──────────────────────────────────────────────────────

     One renderer, drawn in the pane and again in the full-screen overlay. The
     canvas itself is in NEITHER: it lives in a detached host node that is moved
     between the two slots, so entering and leaving full screen never unmounts
     the decoder and the stream is not restarted. Everything drawn ON the
     picture — the frame, the window outline, both cursors — is rendered only in
     the copy that is currently on screen, and positioned from that copy's own
     measured rect. */

  const renderPicture = (scope: MacDesktopChromeScope) => {
    const active = scope === (expanded ? "fullscreen" : "pane");
    return (
      <div
        ref={active ? attachSurface : undefined}
        role={iHaveControl && active ? "application" : undefined}
        tabIndex={iHaveControl && active ? 0 : -1}
        data-testid={scope === "pane" ? "mac-desktop-surface" : "mac-desktop-surface-fs"}
        data-control={iHaveControl ? "user" : "agent"}
        /*
          The pane's own surface, not a black box.

          The first version painted `bg-black/60` under a canvas that keeps its
          aspect ratio, so before the first frame the pane was a black
          rectangle, and after it a black letterbox band above and below the
          picture. The surrounding area is the panel's surface colour now and
          the canvas draws the display's aspect ratio on top of it.
        */
        style={scope === "pane"
          ? { aspectRatio: `${display.width} / ${display.height}` }
          : { width: "100%", height: "100%" }}
        className={cn(
          "relative flex items-center justify-center overflow-hidden bg-surface-recessed",
          scope === "pane" ? "w-full max-h-full" : "rounded-[10px] shadow-float",
          // While the user is driving, the pointer they see is the one drawn
          // at the lane's Mac coordinates, not this machine's arrow.
          "cursor-default",
        )}
        title={iHaveControl ? undefined : "Click to take control"}
        /* Pointer, wheel and key handling are native listeners bound to this
           node while it is the active copy — see the effect on `surfaceNode`. */
      >
        {/* Where the decoder's canvas is parked while this copy is the one on
            screen. Empty in the other copy, which is behind an opaque overlay
            or not expanded. */}
        {active && handoverFrame ? (
          <img
            src={handoverFrame}
            alt=""
            aria-hidden="true"
            draggable={false}
            data-testid="mac-desktop-handover-frame"
            className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain"
          />
        ) : null}
        <div ref={active ? attachCanvasSlot : undefined} className="absolute inset-0" />

        {/* Only the wait is painted on the picture here. A stopped or stuck
            video is the overlay card's to say, because it has the Reconnect.
            The handover frame is the picture while the decoder connects. */}
        {active && !handoverFrame && live.status !== "playing" && live.status !== "error" && !connectSlow ? (
          <p
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-4 text-center text-[12px] text-muted-fg"
            data-testid="mac-desktop-surface-status"
          >
            {/* Without a start in flight the display is already up and only the
                video is connecting, as on the Apple pane. */}
            {starting ? "Starting Mac Desktop…" : "Connecting video"}
          </p>
        ) : null}

        {/*
          What the pointer is doing, because a locked pointer is a mode and an
          unexplained mode is a trap: the cursor vanishes, the mouse stops
          reaching the rest of the screen, and nothing says how to get out.
        */}
        {active && iHaveControl && live.status === "playing" ? (
          <span
            className="pointer-events-none absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-white/85 backdrop-blur-sm"
            data-testid={`mac-desktop-pointer-hint-${scope}`}
          >
            Driving this screen
          </span>
        ) : null}

        {/*
          The frame, drawn on the picture rather than around the pane.

          `pointer-events-none` on purpose: this is chrome, and every gesture
          underneath it belongs to the surface, including the ones that land in
          the letterbox and are refused there.
        */}
        {active && contentBox && contentBox.width > 0 ? (
          <span
            aria-hidden
            data-testid="mac-desktop-frame"
            className={cn(
              "pointer-events-none absolute z-[9] rounded-[10px]",
              iHaveControl
                ? "shadow-[inset_0_0_0_2px_rgb(251_191_36_/_0.8)]"
                : "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-border)_70%,transparent)]",
            )}
            style={{
              left: contentBox.offsetX,
              top: contentBox.offsetY,
              width: contentBox.width,
              height: contentBox.height,
            }}
          />
        ) : null}

        {active && selectedRect ? (
          <span
            aria-hidden
            data-testid="mac-desktop-window-outline"
            className="pointer-events-none absolute z-[9] rounded-[4px] shadow-[inset_0_0_0_2px_color-mix(in_srgb,var(--color-accent)_85%,transparent)]"
            style={{
              left: selectedRect.left,
              top: selectedRect.top,
              width: selectedRect.width,
              height: selectedRect.height,
            }}
          />
        ) : null}

        {/* Glides between action points and fades once the agent is idle. */}
        {active ? <MacDesktopAgentCursor point={cursorPoint} /> : null}

      </div>
    );
  };

  /**
   * The pane's one strip, most pressing thing first.
   *
   * A refusal or a note about the capture the person just made leads, because
   * it answers the click they made. A missing grant comes next: it is usually WHY the video or the mouse
   * is not working, so it outranks their symptoms. Real input and a capture
   * both fail while the picture is fine, so neither may write `statusError` —
   * that slot titles the EMPTY state.
   */
  const inputErrorText = realInput.inputError
    ? macDesktopErrorText(realInput.inputError, { laneId, laneName })
    : null;
  const stripMessage = ((): MacDesktopStripMessage | null => {
    // The host did not answer the newest read. Everything below may be out of
    // date, so this outranks every symptom it could be causing.
    if (unconfirmed) {
      return {
        key: `unconfirmed:${readError ?? ""}`,
        tone: "error",
        sentence: "Mac Desktop is not answering. This picture may be out of date.",
        detail: readError === MAC_DESKTOP_NOT_ANSWERING ? null : readError,
        actions: [
          { label: "Try again", onClick: () => void readAgain() },
          { label: "Reset", onClick: () => setConfirmStop(true) },
        ],
        testId: "mac-desktop-unconfirmed",
      };
    }
    if (statusError) {
      return {
        key: `status:${statusError}`,
        tone: "error",
        sentence: statusError,
        onDismiss: () => setStatusError(null),
        testId: "mac-desktop-status-error",
      };
    }
    if (captureError) {
      return {
        key: `capture:${captureError}`,
        tone: "error",
        sentence: captureError,
        onDismiss: () => setCaptureError(null),
        testId: "mac-desktop-capture-error",
      };
    }
    if (captureNotice) {
      return {
        key: `notice:${captureNotice}`,
        tone: "notice",
        sentence: captureNotice,
        onDismiss: () => setCaptureNotice(null),
        testId: "mac-desktop-capture-notice",
      };
    }
    if (inputErrorText) {
      return {
        key: `input:${inputErrorText}`,
        tone: "error",
        sentence: inputErrorText,
        onDismiss: realInput.clearInputError,
        testId: "mac-desktop-input-error",
      };
    }
    // A missing grant is not a strip line any more: it is the permission card
    // under the top row, which names the grant, its path and its one button.
    // The video's own state is not a strip line either: it is drawn on the
    // picture (`renderVideoOverlay`), where the problem is.
    return null;
  })();

  /**
   * The video's trouble, on the picture it is about.
   *
   * This used to be the top strip: a full-width red bar reading "Video
   * stopped." with RECONNECT and DETAILS in red capitals, which the owner
   * called the message up top that did not fit. It is now a small card over
   * the picture, in the Apple pane's tone: one sentence, one Reconnect, and
   * Details as a quiet link that folds the raw reason open.
   *
   * A sibling of the surface, never a child: the surface takes control on any
   * pointer-down, and pressing Reconnect must not also grab the lease.
   */
  const renderVideoOverlay = (scope: MacDesktopChromeScope) => {
    if (scope !== (expanded ? "fullscreen" : "pane")) return null;
    const stopped = live.status === "error";
    if (!stopped && !connectSlow) return null;
    const detail = stopped ? macDesktopErrorText(live.error, { laneId, laneName }) : null;
    const suffix = scope === "pane" ? "" : "-fs";
    return (
      <div className="pointer-events-none absolute inset-0 z-[12] flex items-center justify-center p-3">
        <div
          role="status"
          data-testid={`${stopped ? "mac-desktop-video-stopped" : "mac-desktop-connect-slow"}${suffix}`}
          className="pointer-events-auto flex max-w-[320px] flex-col items-center gap-2 rounded-[12px] border border-border/70 bg-[color-mix(in_srgb,var(--color-surface)_92%,transparent)] px-4 py-3 text-center font-sans shadow-float"
        >
          <p className="text-[13px] font-medium text-fg">
            {stopped ? "Video stopped" : "The picture is not coming through"}
          </p>
          <p className="text-[12px] leading-5 text-muted-fg">
            {stopped ? "Mac Desktop is still running." : "Mac Desktop is up, but no video has arrived yet."}
          </p>
          <div className="flex items-center gap-3">
            {/* A fresh `startStream`, budget included: the automatic retries
                give up after a few tries, and this is the way back after that. */}
            <button type="button" className={cn(WORK_TOOL_PRIMARY_BUTTON, "h-7")} onClick={live.restart}>
              Reconnect
            </button>
            {stopped && detail ? (
              <button
                type="button"
                aria-expanded={videoDetailsOpen}
                className="text-[12px] text-muted-fg underline-offset-2 hover:text-fg hover:underline"
                onClick={() => setVideoDetailsOpen((open) => !open)}
              >
                Details
              </button>
            ) : null}
            {stopped ? null : (
              <button
                type="button"
                className="text-[12px] text-muted-fg underline-offset-2 hover:text-fg hover:underline"
                onClick={() => setConfirmStop(true)}
              >
                Stop
              </button>
            )}
          </div>
          {stopped && detail && videoDetailsOpen ? (
            <p className="max-w-full break-words text-left font-mono text-[11px] leading-4 text-muted-fg">{detail}</p>
          ) : null}
        </div>
      </div>
    );
  };

  /** Missing grants while a display is live: the card, not a strip line. */
  const renderPermissionNotice = () => (missingPermissions.length > 0 && status ? (
    <MacDesktopPermissionCard
      variant="inline"
      permissions={status.permissions}
      appName={status.responsibleAppName ?? "ADE"}
      signing={status.signing ?? "unknown"}
      hostIsLocal={laneHostIsLocal}
      machineName={machineFacts.machineName}
      checking={checkingPermissions}
      lastCheck={permissionCheck}
      onOpenSettings={(kind) => openSettingsPane(SETTINGS_PANE[kind])}
      onCheckAgain={() => void checkAgain()}
    />
  ) : null);

  /**
   * "Stop Mac Desktop?", asked in the pane like the Apple pane asks before it
   * switches devices. Stop quits the apps the lane opened and sends the
   * windows it borrowed back to the main screen.
   */
  const renderStopConfirm = () => (confirmStop ? (
    <div
      role="alertdialog"
      aria-label="Stop Mac Desktop?"
      data-testid="mac-desktop-stop-confirm"
      className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 rounded-[10px] border border-border bg-surface px-3 py-2 font-sans text-[12px] text-fg"
    >
      <span className="min-w-0 flex-1">
        <span className="font-medium">Stop Mac Desktop?</span>
        <span className="text-muted-fg"> Apps it opened quit, even with unsaved work. Windows you moved here go back to your main screen.</span>
      </span>
      <button
        type="button"
        className={cn(MAC_DESKTOP_SECONDARY_BUTTON, "h-7")}
        onClick={() => setConfirmStop(false)}
      >
        Keep running
      </button>
      <button
        type="button"
        data-testid="mac-desktop-stop-confirm-yes"
        className={cn(
          MAC_DESKTOP_SECONDARY_BUTTON,
          "h-7 border-[color-mix(in_srgb,var(--color-error)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-error)_18%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-error)_26%,transparent)]",
        )}
        onClick={stopNow}
      >
        Stop
      </button>
    </div>
  ) : null);

  /**
   * The recording pill and the "Saved to proof" receipt, over the picture.
   *
   * Siblings of the surface, never children: the surface takes control on
   * any pointer-down, and a Stop or an Open must not also grab the lease.
   * Lifted clear of the "Driving this screen" hint while the person drives.
   */
  const renderCaptureOverlay = (scope: MacDesktopChromeScope) => {
    if (scope !== (expanded ? "fullscreen" : "pane")) return null;
    const driving = iHaveControl && live.status === "playing";
    const inset = scope === "fullscreen" ? MAC_DESKTOP_FULLSCREEN_MARGIN + 12 : 12;
    const bottom = inset + (driving ? 32 : 0);
    return (
      <>
        {recording?.running ? (
          <RecordingPill
            marker={{ "data-testid": `mac-desktop-recording-pill${scope === "pane" ? "" : "-fs"}` }}
            elapsedMs={Math.max(0, nowTick - (Date.parse(recording.startedAt ?? "") || nowTick))}
            onStop={() => void toggleRecording()}
            stopDisabled={busy}
            className="z-[11]"
            style={{ bottom }}
          />
        ) : null}
        {receipt ? (
          <RecordingSavedRow
            marker={{ "data-testid": `mac-desktop-saved-receipt${scope === "pane" ? "" : "-fs"}` }}
            durationMs={receipt.durationMs}
            bytes={receipt.bytes}
            onOpen={() => openReceipt(receipt)}
            onDismiss={() => setReceipt(null)}
            style={{ bottom, left: inset, right: inset }}
          />
        ) : null}
      </>
    );
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col gap-2" data-testid="mac-desktop-panel">
      {/* ── Add app, over the whole pane ─────────────────────────────────

          The picker used to be drawn INLINE where the list goes, so it opened
          in a short box under the preview and the thing it was adding to was
          the thing it replaced. It covers the pane instead: opaque, its own
          scroll box, and the preview keeps streaming behind it.

          Inside this panel rather than a window-level modal on purpose — it
          belongs to this lane's desktop, and a second pane in another window
          must not have its picker taken over by this one. */}
      {pickerOpen ? (
        <div
          className="absolute inset-0 z-20 flex min-h-0 flex-col overflow-hidden rounded-[var(--radius-sm)] border border-border bg-surface"
          data-testid="mac-desktop-picker-overlay"
        >
          <MacDesktopClaimPicker
            inline
            laneId={laneId}
            displayId={display?.displayId}
            laneNames={laneNames}
            windows={claimable}
            loading={claimableLoading}
            error={claimError}
            onRefresh={() => void refreshClaimable()}
            onClaim={claimWindow}
            onClose={() => setPickerOpen(false)}
          />
        </div>
      ) : null}

      {/* The decoder, mounted once and never moved in the React tree. Its host
          node is what travels between the pane and the overlay. */}
      {videoHost && live.url
        ? createPortal(
            <H264VideoCanvas
              url={live.url}
              reconnectNonce={live.reconnectNonce}
              onStatus={live.onStatus}
              onDimensions={live.onDimensions}
              onCanvas={live.onCanvas}
              className={live.status === "playing" ? undefined : "opacity-0"}
            />,
            videoHost,
          )
        : null}

      {/* ── Strip ─────────────────────────────────────────────────────────

          One row that holds its line from 600px up: two short text chips on
          the left, icon buttons on the right, and nothing in between that can
          grow. `flex-nowrap` is the guarantee; `min-w-0` + `truncate` on the
          status pill is what it spends when the pane gets narrow. */}
      <div className={cn(WORK_TOOL_CHROME_ROW, "relative flex-nowrap gap-1")}>
        {renderChromeRow("pane")}
      </div>
      {/* ── The one strip ─────────────────────────────────────────────
          A missing grant, a refused action, or a stopped video, one at a
          time and each with the button that fixes it. */}
      <MacDesktopStatusStrip message={stripMessage} suffix="" />
      {renderStopConfirm()}
      {renderPermissionNotice()}

      {/* ── The screen, and the windows on it ───────────────────────────

          Stacked in the tall tools column the pane usually is, side by side
          once it is appreciably wider than tall. The picture is pinned under
          the strip at the display's own aspect ratio in both, which is what
          removed the ~350px of empty pane that used to sit above a vertically
          centred 16:9 image. */}
      <div
        data-testid="mac-desktop-body"
        data-layout="stacked"
        // Always stacked, picture above Apps. The side-by-side mode for wide
        // panes put the list to the RIGHT of the picture, which is not where
        // the owner asked for it and read as a second toolbar.
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto"
      >
        <div className="relative flex w-full min-w-0 shrink-0 flex-col items-stretch">
          {renderPicture("pane")}
          {renderCaptureOverlay("pane")}
          {renderVideoOverlay("pane")}
        </div>

        {/* ── Apps ────────────────────────────────────────────────────────

            The lane's desktop, named in the user's vocabulary: one card per
            window parked here, wrapping left to right, and a trailing button
            that opens the picker over the whole pane. No lease/claim words —
            a window is on this desktop or it is not. */}
        <div
          data-testid="mac-desktop-apps"
          className="flex min-h-0 shrink-0 flex-col gap-0.5"
        >
          <div className="flex h-7 items-center gap-1 px-1" data-testid="mac-desktop-apps-header">
            <span className={WORK_TOOL_SECTION_LABEL_TEXT}>Apps</span>
          </div>

          {/* The cards wrap left to right, and the way to add one is the last
              thing in the same run rather than a button in the heading. With
              nothing here yet it is the only thing in the run, so the empty
              state needs no button of its own. */}
          <div className="flex flex-wrap items-center gap-1.5 px-1" data-testid="mac-desktop-apps-list">
            {parkedWindows.map((entry) => (
              <MacDesktopWindowCard
                key={entry.id}
                window={entry}
                selected={entry.id === selectedWindowId}
                iconPng={claimAppIcons[entry.bundleId ?? entry.appName] ?? entry.iconPng ?? null}
                onSelect={selectWindow}
                onRelease={releaseWindowById}
              />
            ))}
            <button
              type="button"
              data-testid="mac-desktop-add-app"
              onClick={() => setPickerOpen(true)}
              title="Add an app to this desktop"
              className={cn(
                "flex h-8 shrink-0 items-center gap-1 rounded-[var(--radius-sm)] px-2",
                "border border-dashed border-border/70 text-[11.5px] text-muted-fg",
                "transition-colors duration-[120ms] ease-out hover:bg-white/[0.06] hover:text-fg",
              )}
            >
              <Plus size={12} />
              {parkedWindows.length ? <span className="sr-only">Add app</span> : "Add app"}
            </button>
          </div>

        </div>

        {/* ── Activity ────────────────────────────────────────────────
            What happened on this screen that the picture does not show: a
            window that would not move over, and the agent's last look.

            These used to be two differently styled lines, one of them a
            footer pinned under the whole pane, which read as a stray log.
            They are one list now, in the Apps section's row shape: a glyph,
            one truncating line, and a fixed right-hand column. */}
        {notParked.length > 0 || lastObservation ? (
          <div className="flex min-h-0 shrink-0 flex-col gap-0.5" data-testid="mac-desktop-activity">
            <div className="flex h-7 items-center gap-1 px-1">
              <span className={WORK_TOOL_SECTION_LABEL_TEXT}>Activity</span>
            </div>
            <ul className="flex flex-col">
              {notParked.map((entry) => {
                const label = windows.find((candidate) => candidate.id === entry.windowId)?.title?.trim()
                  || `Window ${entry.windowId}`;
                const sentence = macDesktopNotParkedSentence(label, entry.reason);
                return (
                  <li
                    key={entry.windowId}
                    data-testid="mac-desktop-not-parked"
                    className="group flex h-8 min-w-0 items-center gap-2 rounded-[var(--radius-sm)] px-1.5 text-[12px] hover:bg-white/[0.04]"
                  >
                    <WarningCircle size={14} weight="fill" className="shrink-0 text-[var(--color-warning)]" />
                    <span className="min-w-0 flex-1 truncate text-fg/85" title={sentence}>{sentence}</span>
                    <button
                      type="button"
                      className="shrink-0 rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[11px] text-muted-fg transition-colors hover:bg-white/[0.07] hover:text-fg"
                      data-testid="mac-desktop-not-parked-dismiss"
                      onClick={() => dismissNotParked(entry.windowId)}
                    >
                      Dismiss
                    </button>
                  </li>
                );
              })}
              {lastObservation ? (
                <li
                  data-testid="mac-desktop-last-observation"
                  className="flex h-8 min-w-0 items-center gap-2 rounded-[var(--radius-sm)] px-1.5 text-[12px] hover:bg-white/[0.04]"
                >
                  {lastFrame ? (
                    <img
                      src={lastFrame.dataUrl}
                      alt=""
                      aria-hidden
                      className="h-5 w-[34px] shrink-0 rounded-[3px] object-cover opacity-85 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-border)_60%,transparent)]"
                    />
                  ) : (
                    <Cursor size={14} className="shrink-0 text-muted-fg/80" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-fg/85" title={lastObservation.caption ?? undefined}>
                    <span className="text-muted-fg">Agent looked · </span>
                    {lastObservation.caption ?? "this screen"}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-fg">
                    {`${macDesktopRelativeTime(lastObservation.at, Date.now())} · ${lastObservation.elementCount} items`}
                  </span>
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}
      </div>


      <MacDesktopFullscreenView
        controller={controller}
        stripMessage={stripMessage}
        renderChromeRow={renderChromeRow}
        renderStopConfirm={renderStopConfirm}
        renderPermissionNotice={renderPermissionNotice}
        renderPicture={renderPicture}
        renderCaptureOverlay={renderCaptureOverlay}
        renderVideoOverlay={renderVideoOverlay}
      />
    </div>
  );
}
