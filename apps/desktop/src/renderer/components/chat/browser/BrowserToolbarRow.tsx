/**
 * The browser pane's toolbar row: nav group, omnibox, and the buttons the row
 * sheds as it narrows.
 *
 * Its own file because what this row shows is decided entirely by the
 * `browserToolbarLayout` it is handed, and that contract is much easier to read
 * against one component than against a slab in the middle of the panel. The ⋮
 * menu arrives as `overflow` so the row stays about the row.
 */
import type { FormEvent, KeyboardEvent, MouseEvent, MutableRefObject, ReactNode } from "react";
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  Camera,
  CaretDown,
  CursorClick,
  DeviceMobile,
  ImageSquare,
  LockSimple,
  LockSimpleOpen,
  Monitor,
  Play,
  Selection,
  SpinnerGap,
  Stop,
} from "@phosphor-icons/react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { BuiltInBrowserRecordingStatus } from "../../../../shared/types/builtInBrowser";
import { recordingPillLabel } from "../browserToolbarLabels";
import type { TabTunnelEntry } from "../browserRemoteTunnels";
import type { BrowserUrlDisplay, BrowserUrlLockKind } from "../../../lib/browserUrl";
import { cn } from "../../ui/cn";
import {
  MENU_CONTENT_CLASS,
  TOOLBAR_CONTROL,
  TOOLBAR_FOCUS,
  TOOLBAR_IDLE,
  TOOLBAR_MOTION,
  TOOLBAR_ON,
  type BrowserChromeShared,
} from "./browserChrome";

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
  /** The ⋮ menu, rendered as this row's last child. */
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
  overflow,
}: BrowserToolbarRowProps) {
  const {
    toolbar,
    busy,
    apiAvailable,
    inspecting,
    onInspectToggle,
    emulation,
    deviceLabel,
    deviceMenuItems,
    selection,
  } = shared;
  return (
    <div
      ref={rowRef}
      data-testid="browser-toolbar-row"
      className="flex h-9 min-w-0 shrink-0 select-none items-center gap-1 overflow-hidden border-b border-white/[0.08] bg-white/[0.02] px-1.5"
    >
      <div className="inline-flex h-7 shrink-0 items-center overflow-hidden rounded-[7px] border border-white/[0.08] bg-black/25">
        <button
          type="button"
          disabled={Boolean(busy) || !apiAvailable || !hasTab || !canGoBack}
          onClick={onBack}
          className={cn("inline-flex h-full w-7 items-center justify-center text-fg/65 hover:bg-white/[0.06] hover:text-fg/85 disabled:opacity-35", TOOLBAR_MOTION, TOOLBAR_FOCUS)}
          title="Go back"
          aria-label="Go back"
        >
          {busy === "back" ? <SpinnerGap size={13} className="animate-spin" /> : <ArrowLeft size={13} />}
        </button>
        {toolbar.showForward ? (
          <button
            type="button"
            disabled={Boolean(busy) || !apiAvailable || !hasTab || !canGoForward}
            onClick={onForward}
            className={cn("inline-flex h-full w-7 items-center justify-center border-l border-white/[0.06] text-fg/65 hover:bg-white/[0.06] hover:text-fg/85 disabled:opacity-35", TOOLBAR_MOTION, TOOLBAR_FOCUS)}
            title="Go forward"
            aria-label="Go forward"
          >
            {busy === "forward" ? <SpinnerGap size={13} className="animate-spin" /> : <ArrowRight size={13} />}
          </button>
        ) : null}
        <button
          type="button"
          disabled={Boolean(busy) || !apiAvailable || !hasTab}
          onClick={loading ? onStop : onReload}
          className={cn("inline-flex h-full w-7 items-center justify-center border-l border-white/[0.06] text-fg/65 hover:bg-white/[0.06] hover:text-fg/85 disabled:opacity-35", TOOLBAR_MOTION, TOOLBAR_FOCUS)}
          title={loading ? "Stop loading" : "Reload"}
          aria-label={loading ? "Stop loading" : "Reload"}
        >
          {busy === "reload" || busy === "stop" ? (
            <SpinnerGap size={13} className="animate-spin" />
          ) : loading ? (
            <Stop size={13} weight="fill" />
          ) : (
            <ArrowClockwise size={13} />
          )}
        </button>
      </div>

      <form
        onSubmit={urlField.onSubmit}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 bg-black/25 pl-2",
          TOOLBAR_CONTROL,
          "border-white/[0.08] focus-within:border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)]",
        )}
      >
        {urlField.lockKind === "none" ? null : urlField.lockKind === "secure" ? (
          <LockSimple
            size={11}
            weight="fill"
            aria-label="Secure connection"
            className="shrink-0 text-emerald-300/70"
          />
        ) : (
          <LockSimpleOpen
            size={11}
            aria-label="Not a secure connection"
            className="shrink-0 text-amber-300/70"
          />
        )}
        {urlField.tunnel ? (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-[4px] border border-sky-400/25 bg-sky-500/12 px-1 text-[9.5px] font-medium text-sky-100/85"
            title={`Tunneled to port ${urlField.tunnel.tunnel.remotePort} on ${urlField.tunnel.tunnel.machineLabel}`}
          >
            {urlField.tunnel.tunnel.machineLabel}
          </span>
        ) : null}
        <span className="relative flex h-full min-w-0 flex-1 items-center">
          <input
            ref={urlField.inputRef}
            value={urlField.value}
            onChange={(event) => urlField.onChange(event.target.value)}
            onFocus={urlField.onFocus}
            onKeyDown={urlField.onKeyDown}
            onBlur={urlField.onEndEdit}
            placeholder="Search or enter address"
            aria-label="ADE browser URL"
            // Always `flex: 1 1 0` with no intrinsic floor: the field is the
            // one control on this row that is allowed to take what is left,
            // and the row above has already made sure that is enough.
            className={cn(
              "h-full w-0 min-w-0 flex-1 basis-0 truncate bg-transparent pr-2 text-[11px] outline-none placeholder:text-muted-fg/40",
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
              className="pointer-events-none absolute inset-y-0 left-0 right-2 flex items-center overflow-hidden whitespace-nowrap text-[11px] leading-none"
            >
              <span className="shrink-0 text-fg/90">{urlField.display.host}</span>
              {urlField.display.rest ? (
                <span className="min-w-0 truncate text-muted-fg/55">{urlField.display.rest}</span>
              ) : null}
            </span>
          ) : null}
        </span>
        {/*
          The submit affordance is a hint, never the mechanism: Enter has
          always opened what is typed. So it shrinks to a bare ▶ in a narrow
          pane and steps out of the way entirely while the field is focused,
          where it would otherwise be eating the width of the thing the
          person is typing into.
        */}
        {toolbar.openAffordance === "none" ? null : (
          <button
            type="submit"
            data-testid="browser-url-submit"
            disabled={Boolean(busy) || !apiAvailable || !urlField.value.trim()}
            className={cn(
              "inline-flex h-full shrink-0 items-center justify-center gap-1 rounded-r-[6px] border-l border-white/[0.06] text-fg/75 hover:bg-white/[0.06]",
              toolbar.openAffordance === "label" ? "px-1.5 text-[10px] font-medium" : "w-7",
              TOOLBAR_MOTION,
              TOOLBAR_FOCUS,
            )}
            aria-label="Open URL"
          >
            {busy === "navigate" ? <SpinnerGap size={12} className="animate-spin" /> : <Play size={12} weight="fill" />}
            {toolbar.openAffordance === "label" ? "Open" : null}
          </button>
        )}
      </form>

      {recording ? (
        <button
          type="button"
          onClick={onStopRecording}
          disabled={busy === "recording"}
          title="Stop recording"
          aria-label={`Stop recording · ${recordingPillLabel(recording, recordingClock) ?? ""}`}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 px-2 font-mono text-[10px] font-medium",
            TOOLBAR_CONTROL,
            "border-rose-400/30 bg-rose-500/14 text-rose-100/90 hover:bg-rose-500/22",
            TOOLBAR_MOTION,
            TOOLBAR_FOCUS,
          )}
        >
          <span
            aria-hidden="true"
            className="h-[6px] w-[6px] rounded-full bg-rose-400 [animation:ade-status-pulse_1.6s_steps(1)_infinite] motion-reduce:animate-none"
          />
          {`REC ${recordingPillLabel(recording, recordingClock) ?? ""}`}
        </button>
      ) : null}

      {toolbar.showDevice ? (
        <DropdownMenu.Root open={deviceMenuOpen} onOpenChange={onDeviceMenuOpenChange}>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              disabled={!apiAvailable || !hasTab}
              aria-label={`Browser device preset — ${deviceLabel}`}
              className={cn(
                "inline-flex shrink-0 items-center gap-1 font-medium",
                toolbar.showLabels ? "px-2" : "w-7 justify-center",
                TOOLBAR_CONTROL,
                emulation ? TOOLBAR_ON : TOOLBAR_IDLE,
                TOOLBAR_MOTION,
                TOOLBAR_FOCUS,
              )}
            >
              {emulation?.mobile ? <DeviceMobile size={12} /> : <Monitor size={12} />}
              {toolbar.showLabels ? (
                <>
                  <span className="max-w-[104px] truncate">{deviceLabel}</span>
                  <CaretDown size={9} className="shrink-0 opacity-60" />
                </>
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

      {toolbar.showCamera ? (
        <button
          type="button"
          disabled={Boolean(busy) || !apiAvailable || !hasTab}
          onClick={onCameraClick}
          className={cn(
            "inline-flex w-7 shrink-0 items-center justify-center",
            TOOLBAR_CONTROL,
            hasCaptureBase || recording ? TOOLBAR_ON : TOOLBAR_IDLE,
            TOOLBAR_MOTION,
            TOOLBAR_FOCUS,
          )}
          title="Screenshot · Shift-click to record"
          aria-label={hasCaptureBase ? "Cancel screenshot" : "Screenshot · Shift-click to record"}
        >
          {busy === "screenshot" || busy === "recording" ? (
            <SpinnerGap size={13} className="animate-spin" />
          ) : hasCaptureBase ? (
            <ImageSquare size={13} />
          ) : (
            <Camera size={13} />
          )}
        </button>
      ) : null}

      {toolbar.showInspect ? (
        <button
          type="button"
          disabled={Boolean(busy) || !apiAvailable || !hasTab}
          onClick={onInspectToggle}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 font-medium",
            toolbar.showLabels ? "px-2" : "w-7 justify-center",
            TOOLBAR_CONTROL,
            inspecting ? TOOLBAR_ON : TOOLBAR_IDLE,
            TOOLBAR_MOTION,
            TOOLBAR_FOCUS,
          )}
          title={inspecting ? "Stop selecting elements" : "Select an element in the ADE browser"}
          aria-label={inspecting ? "Stop selecting elements" : "Select an element in the ADE browser"}
        >
          {busy === "inspect-on" || busy === "inspect-off" ? <SpinnerGap size={12} className="animate-spin" /> : <CursorClick size={12} />}
          {toolbar.showLabels ? (inspecting ? "Inspecting" : "Inspect") : null}
        </button>
      ) : null}

      {selection.has && toolbar.showAttach ? (
        <button
          type="button"
          disabled={Boolean(busy) || !apiAvailable || !selection.canAdd}
          onClick={selection.onAttach}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 px-2 font-medium",
            TOOLBAR_CONTROL,
            TOOLBAR_IDLE,
            TOOLBAR_MOTION,
            TOOLBAR_FOCUS,
          )}
          title="Insert the selected browser element as context"
        >
          {busy === "select" ? <SpinnerGap size={12} className="animate-spin" /> : <Selection size={12} />}
          Attach
        </button>
      ) : null}

      {overflow}
    </div>
  );
}
