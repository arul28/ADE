/**
 * The browser pane's chrome row: nav glyphs, a borderless address field, and
 * the right cluster it sheds as it narrows.
 *
 * One 40px row, drawn the way Cursor, Arc and Zen draw theirs — ghost glyphs
 * over the pane's own background, an address that is text until you touch it,
 * and state carried by icon colour rather than by chips. The ⋯ menu arrives as
 * `overflow` so the row stays about the row, and the load bar is pinned to the
 * row's own bottom edge because that is the edge the page starts at.
 */
import type { FormEvent, KeyboardEvent, MouseEvent, MutableRefObject, ReactNode } from "react";
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  ArrowSquareOut,
  ArrowUp,
  Camera,
  CursorClick,
  DeviceMobile,
  LockSimple,
  LockSimpleOpen,
  Monitor,
  Selection,
  Stop,
} from "@phosphor-icons/react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { AnimatePresence, motion } from "motion/react";
import type { BuiltInBrowserRecordingStatus } from "../../../../shared/types/builtInBrowser";
import { recordingPillLabel } from "./browserToolbarLabels";
import type { TabTunnelEntry } from "../browserRemoteTunnels";
import type { BrowserUrlDisplay, BrowserUrlLockKind } from "../../../lib/browserUrl";
import { cn } from "../../ui/cn";
import {
  CHROME_FIELD_NO_HALO,
  CHROME_GHOST,
  CHROME_GHOST_ON,
  CHROME_GHOST_REC,
  CHROME_ICON_SIZE,
  CHROME_ROW_CLASS,
  CHROME_STATE_DOT,
  MENU_CONTENT_CLASS,
  TOOLBAR_FOCUS,
  TOOLBAR_MOTION,
  type BrowserChromeShared,
} from "./browserChrome";

/** How the load bar behaves, decided by the panel and drawn here. */
export type BrowserProgressPhase = "idle" | "loading" | "finishing";

/**
 * The omnibox, as one value.
 *
 * The row used to take thirteen separate props for this field, three of them
 * raw `setState` setters — so the child wrote the parent's state directly and
 * the rule "blur restores the current URL when the box is empty" lived in the
 * child while every other sequencing rule lived in the parent. Now the row
 * reports intent (`onChange`, `onEndEdit`) and the panel decides what that
 * means.
 */
export type BrowserUrlFieldProps = {
  inputRef: MutableRefObject<HTMLInputElement | null>;
  /** What is in the box right now. */
  value: string;
  /** The page the tab is actually on, which is not always what is typed. */
  currentUrl: string;
  lockKind: BrowserUrlLockKind;
  /** Set when this tab's loopback URL is served over a forward. */
  tunnel: TabTunnelEntry | null;
  /** Host/rest split for the read-mode overlay; null when there is nothing to split. */
  display: BrowserUrlDisplay | null;
  /** Draw the host-emphasised overlay instead of the raw text. */
  showOverlay: boolean;
  /** The field has focus, so it shows the full URL and its own ring. */
  editing: boolean;
  onChange: (value: string) => void;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onSubmit: (event?: FormEvent<HTMLFormElement>) => void;
  /** The field lost focus: stop editing, and restore whatever the parent decides. */
  onEndEdit: () => void;
};

export type BrowserToolbarRowProps = {
  rowRef: MutableRefObject<HTMLDivElement | null>;
  /** Everything this row and the ⋮ menu both need, built once by the panel. */
  shared: BrowserChromeShared;
  urlField: BrowserUrlFieldProps;
  hasTab: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onStop: () => void;
  recording: BuiltInBrowserRecordingStatus | null;
  recordingClock: number;
  onStopRecording: () => void;
  deviceMenuOpen: boolean;
  onDeviceMenuOpenChange: (open: boolean) => void;
  hasCaptureBase: boolean;
  onCameraClick: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Open the loaded page in the system browser. */
  onOpenExternal: () => void;
  /** How the page load is going; drawn as a 2px bar on this row's bottom edge. */
  progressPhase: BrowserProgressPhase;
  reduceMotion: boolean;
  /** The ⋯ menu, rendered as this row's last child. */
  overflow: ReactNode;
};

export function BrowserToolbarRow({
  rowRef,
  shared,
  urlField,
  hasTab,
  canGoBack,
  canGoForward,
  loading,
  onBack,
  onForward,
  onReload,
  onStop,
  recording,
  recordingClock,
  onStopRecording,
  deviceMenuOpen,
  onDeviceMenuOpenChange,
  hasCaptureBase,
  onCameraClick,
  onOpenExternal,
  progressPhase,
  reduceMotion,
  overflow,
}: BrowserToolbarRowProps) {
  const {
    toolbar,
    busy,
    apiAvailable,
    canAttachContext,
    inspecting,
    onInspectToggle,
    emulation,
    deviceLabel,
    deviceMenuItems,
    selection,
  } = shared;
  // The camera does two jobs: a click captures a region for the chat, a
  // Shift-click records. Without a chat to capture INTO only the recording is
  // left, so the button becomes what it can still do rather than a control
  // whose primary click always fails.
  const recordOnly = !canAttachContext;
  const recordingLabel = recording ? recordingPillLabel(recording, recordingClock) : null;
  const navDisabled = Boolean(busy) || !apiAvailable || !hasTab;
  // The arrow is a hint that Enter works, never the mechanism — so it exists
  // only while there is something typed to submit, and disappears the moment
  // the field goes back to being a label for where you are.
  const showSubmitArrow = urlField.editing && urlField.value.trim().length > 0;
  return (
    <div
      ref={rowRef}
      data-testid="browser-toolbar-row"
      className={cn(
        "relative flex min-w-0 shrink-0 select-none items-center gap-0.5 overflow-hidden px-2",
        CHROME_ROW_CLASS,
      )}
    >
      {/* Nav: three glyphs at a 2px gap, no group box, no dividers. */}
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          disabled={navDisabled || !canGoBack}
          onClick={onBack}
          className={cn(CHROME_GHOST, TOOLBAR_MOTION, TOOLBAR_FOCUS)}
          title="Go back"
          aria-label="Go back"
        >
          <ArrowLeft size={CHROME_ICON_SIZE} />
        </button>
        {toolbar.showForward ? (
          <button
            type="button"
            disabled={navDisabled || !canGoForward}
            onClick={onForward}
            className={cn(CHROME_GHOST, TOOLBAR_MOTION, TOOLBAR_FOCUS)}
            title="Go forward"
            aria-label="Go forward"
          >
            <ArrowRight size={CHROME_ICON_SIZE} />
          </button>
        ) : null}
        <button
          type="button"
          disabled={navDisabled}
          onClick={loading ? onStop : onReload}
          className={cn(CHROME_GHOST, TOOLBAR_MOTION, TOOLBAR_FOCUS)}
          title={loading ? "Stop loading" : "Reload"}
          aria-label={loading ? "Stop loading" : "Reload"}
        >
          {loading ? <Stop size={CHROME_ICON_SIZE} weight="fill" /> : <ArrowClockwise size={CHROME_ICON_SIZE} />}
        </button>
      </div>

      {/*
        The address, borderless at rest.

        None of Cursor, Arc or Zen renders a bordered input here: the URL is
        the page's name, and a box around it is chrome that earns nothing. The
        ring appears only on focus, which is the moment it becomes a field.
      */}
      <form
        onSubmit={urlField.onSubmit}
        className={cn(
          "group/address flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-[7px] px-2",
          "transition-shadow duration-[120ms] ease-out",
          "focus-within:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_38%,transparent)]",
        )}
      >
        {urlField.tunnel ? (
          <span
            className={cn(
              "inline-flex h-5 shrink-0 items-center rounded-full bg-white/[0.06] px-1.5",
              "text-[10px] font-medium text-fg/70",
            )}
            title={`Tunneled to port ${urlField.tunnel.tunnel.remotePort} on ${urlField.tunnel.tunnel.machineLabel}`}
          >
            {urlField.tunnel.tunnel.machineLabel}
          </span>
        ) : null}
        {urlField.lockKind === "none" ? null : urlField.lockKind === "secure" ? (
          <LockSimple
            size={12}
            weight="fill"
            aria-label="Secure connection"
            className="shrink-0 text-muted-fg/55"
          />
        ) : (
          <LockSimpleOpen
            size={12}
            aria-label="Not a secure connection"
            className="shrink-0 text-amber-300/70"
          />
        )}
        <span className="relative flex h-full min-w-0 flex-1 items-center">
          <input
            ref={urlField.inputRef}
            value={urlField.value}
            onChange={(event) => urlField.onChange(event.target.value)}
            onFocus={urlField.onFocus}
            onKeyDown={urlField.onKeyDown}
            onBlur={urlField.onEndEdit}
            placeholder="Search or enter URL"
            aria-label="ADE browser URL"
            // Always `flex: 1 1 0` with no intrinsic floor: the field is the
            // one control on this row that is allowed to take what is left,
            // and the row above has already made sure that is enough.
            className={cn(
              "h-full w-0 min-w-0 flex-1 basis-0 truncate bg-transparent text-[12px] outline-none placeholder:text-muted-fg/45",
              CHROME_FIELD_NO_HALO,
              urlField.showOverlay ? "text-transparent caret-fg/80" : "text-fg/85",
            )}
          />
          {/*
            Arc/Zen reading order: the host is what answers "where am I?",
            the path is detail. The real input stays underneath so selection,
            typing and the caret behave exactly as before.
          */}
          {urlField.showOverlay && urlField.display ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 left-0 right-0 flex items-center overflow-hidden whitespace-nowrap text-[12px] leading-none"
            >
              <span className="shrink-0 text-fg/90">{urlField.display.host}</span>
              {urlField.display.rest ? (
                <span className="min-w-0 truncate text-muted-fg/55">{urlField.display.rest}</span>
              ) : null}
            </span>
          ) : null}
        </span>
        {showSubmitArrow ? (
          <button
            type="submit"
            data-testid="browser-url-submit"
            disabled={Boolean(busy) || !apiAvailable}
            className={cn(
              "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
              "bg-white/[0.08] text-fg/75 hover:bg-white/[0.14] hover:text-fg",
              TOOLBAR_MOTION,
              TOOLBAR_FOCUS,
            )}
            title="Open this address"
            aria-label="Open URL"
          >
            <ArrowUp size={11} weight="bold" />
          </button>
        ) : null}
      </form>

      {toolbar.showDevice ? (
        <DropdownMenu.Root open={deviceMenuOpen} onOpenChange={onDeviceMenuOpenChange}>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              disabled={!apiAvailable || !hasTab}
              title={`Device — ${deviceLabel}`}
              aria-label={`Browser device preset — ${deviceLabel}`}
              className={cn(
                "relative",
                CHROME_GHOST,
                emulation ? CHROME_GHOST_ON : null,
                TOOLBAR_MOTION,
                TOOLBAR_FOCUS,
              )}
            >
              {emulation?.mobile ? <DeviceMobile size={CHROME_ICON_SIZE} /> : <Monitor size={CHROME_ICON_SIZE} />}
              {/* The preset is a dot, not a name: the name is in the tooltip. */}
              {emulation ? (
                <span
                  aria-hidden="true"
                  data-testid="browser-device-active-dot"
                  className={cn(CHROME_STATE_DOT, "bg-[var(--color-accent)]")}
                />
              ) : null}
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              collisionPadding={8}
              className={MENU_CONTENT_CLASS}
            >
              {deviceMenuItems}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : null}

      {toolbar.showInspect ? (
        <button
          type="button"
          disabled={Boolean(busy) || !apiAvailable || !hasTab}
          onClick={onInspectToggle}
          className={cn(
            CHROME_GHOST,
            inspecting ? CHROME_GHOST_ON : null,
            TOOLBAR_MOTION,
            TOOLBAR_FOCUS,
          )}
          title={inspecting ? "Stop selecting elements" : "Select an element in the ADE browser"}
          aria-label={inspecting ? "Stop selecting elements" : "Select an element in the ADE browser"}
        >
          <CursorClick size={CHROME_ICON_SIZE} />
        </button>
      ) : null}

      {selection.has && toolbar.showAttach ? (
        <button
          type="button"
          disabled={Boolean(busy) || !apiAvailable}
          onClick={selection.onAttach}
          className={cn(CHROME_GHOST, TOOLBAR_MOTION, TOOLBAR_FOCUS)}
          title="Insert the selected browser element as context"
          aria-label="Attach the selected browser element"
        >
          <Selection size={CHROME_ICON_SIZE} />
        </button>
      ) : null}

      {/*
        One camera, three states. Idle it screenshots (Shift to record), armed
        it cancels the crop, recording it stops — and says so in red with a
        pulsing dot rather than in a REC pill that cost the row 96px.
      */}
      {toolbar.showCamera || recording ? (
        <button
          type="button"
          disabled={recording ? busy === "recording" : (Boolean(busy) || !apiAvailable || !hasTab)}
          onClick={recording ? onStopRecording : onCameraClick}
          className={cn(
            "relative",
            CHROME_GHOST,
            recording ? CHROME_GHOST_REC : hasCaptureBase ? CHROME_GHOST_ON : null,
            TOOLBAR_MOTION,
            TOOLBAR_FOCUS,
          )}
          title={recording
            ? "Stop recording"
            : recordOnly ? "Record the browser" : "Screenshot · Shift-click to record"}
          aria-label={recording
            ? `Stop recording · ${recordingLabel ?? ""}`
            : recordOnly
              ? "Record the browser"
              : hasCaptureBase ? "Cancel screenshot" : "Screenshot · Shift-click to record"}
        >
          <Camera size={CHROME_ICON_SIZE} weight={recording ? "fill" : "regular"} />
          {recording ? (
            <span
              aria-hidden="true"
              data-testid="browser-recording-dot"
              className={cn(
                CHROME_STATE_DOT,
                "bg-rose-400 [animation:ade-status-pulse_1.6s_steps(1)_infinite] motion-reduce:animate-none",
              )}
            />
          ) : null}
        </button>
      ) : null}

      {toolbar.showPopOut ? (
        <button
          type="button"
          disabled={!apiAvailable || !urlField.currentUrl}
          onClick={onOpenExternal}
          className={cn(CHROME_GHOST, TOOLBAR_MOTION, TOOLBAR_FOCUS)}
          title="Open this page in the system browser"
          aria-label="Open this page in the system browser"
        >
          <ArrowSquareOut size={CHROME_ICON_SIZE} />
        </button>
      ) : null}

      {overflow}

      {/*
        Determinate-feeling progress on the row's own bottom edge: it races
        out, waits at 90%, then fades on did-finish-load. A page that is still
        loading should look like progress, not like a spinner that might mean
        anything — so there is no spinner anywhere on this row.
      */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] overflow-hidden" aria-hidden="true">
        <AnimatePresence initial={false}>
          {progressPhase === "idle" ? null : (
            <motion.div
              key="ade-browser-progress"
              data-testid="browser-load-progress"
              className="h-full w-full origin-left bg-[var(--color-accent)]"
              initial={reduceMotion ? { scaleX: 1, opacity: 1 } : { scaleX: 0.04, opacity: 1 }}
              animate={progressPhase === "loading"
                ? { scaleX: reduceMotion ? 1 : 0.9, opacity: 1 }
                : { scaleX: 1, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={progressPhase === "loading"
                ? { duration: reduceMotion ? 0 : 5.3, ease: [0.1, 0.5, 0.2, 1] }
                : { scaleX: { duration: 0.12 }, opacity: { duration: 0.2, delay: 0.12 } }}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
