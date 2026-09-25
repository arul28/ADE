import type { ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowsOut,
  Camera,
  Check,
  Crosshair,
  Cube,
  DeviceMobile,
  DotsThree,
  GameController,
  House,
  Lock,
  Microphone,
  PictureInPicture,
  Power,
  Record,
  SlidersHorizontal,
  SpeakerHigh,
  SpeakerLow,
  SquaresFour,
  Stop,
} from "@phosphor-icons/react";
import type { AppleDeviceOrientation, AppleHardwareButtonName } from "../../../shared/types/iosSimulator";
import {
  APPLE_ORIENTATION_CHOICES,
  appleOrientationIconDegrees,
  appleOrientationLabel,
} from "./appleDeviceState";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import { PaneTooltip } from "../ui/PaneTooltip";
import {
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_LABEL_CLASS,
  MENU_SEPARATOR_CLASS,
} from "../ui/paneMenuTokens";

/** Below this the rail keeps Home, Tools and More, and nothing else. */
export const APPLE_RAIL_COMPACT_WIDTH = 360;

export type AppleDeviceRailProps = {
  /** Container width in px, for the 360px collapse. */
  containerWidth: number;
  deviceName: string;
  deviceRuntime: string | null;
  /** False while the input socket is down: every device control is refused. */
  inputConnected: boolean;
  mode: "flat" | "3d";
  canUse3d: boolean;
  /** Why 3D is unavailable, when it is. */
  threeDisabledReason: string | null;
  toolsOpen: boolean;
  /** §A4: Inspect is a rail toggle now, not a drawer switch. */
  inspecting: boolean;
  /** §A5: Record is a rail toggle now, with a red active state. */
  recording: boolean;
  screenshotPending: boolean;
  /** §V2: what the orientation control shows, and which item it checks. */
  orientation: AppleDeviceOrientation;
  /** A rotation is in flight and the device has not confirmed it yet. */
  orientationPending?: boolean;
  onHome: () => void;
  /**
   * Press one of the device's physical buttons (lock, volume, Siri, app
   * switcher). `shake` is deliberately absent: this Xcode's `simctl` and the
   * helper cannot press it, so the service refuses it, and a control that can
   * only fail is worse than no control.
   */
  onHardwareButton: (name: AppleHardwareButtonName) => void;
  /** §V2: rotate TO a named orientation. The blind cycle is gone. */
  onOrientation: (orientation: AppleDeviceOrientation) => void;
  onScreenshot: () => void;
  onToggleTools: () => void;
  onToggleInspect: () => void;
  /** §A2: ONE button. It switches to the other view and shows which is on. */
  onMode: (mode: "flat" | "3d") => void;
  onResetView: () => void;
  onToggleRecording: () => void;
  onFloat: () => void;
  onSwitchDevice: () => void;
  onPowerOff: () => void;
  /**
   * The tool's own chrome, drawn in the pill above More.
   *
   * A4 puts Float and Maximize in the TOOL's header/rail rather than in the
   * tools tab strip, and the Apple pane's header IS this pill. A slot rather
   * than named props because what goes in it is the shared
   * `WorkToolPreviewControls` every screen tool mounts, not something this
   * rail should know the shape of.
   */
  extraControls?: ReactNode;
};

/**
 * The device's controls, in one pill on the right edge of the picture.
 *
 * Round 4 §A5 fixes the order and the contents: Home, Hardware buttons,
 * Rotate, Inspect, Screenshot, Record, View, Tools, More. Appearance and Text
 * size are GONE from here — they were duplicated in the drawer, which is where
 * device settings live; Inspect and Record came the other way, out of the
 * drawer, because they act on the picture rather than on the device's settings.
 *
 * `Shake` — which the service refuses with `APPLE_BUTTON_UNSUPPORTED` — still
 * does not exist as a control at all, because a button that can only fail is
 * worse than no button. Lock, volume, Siri and the app switcher do work and
 * live in the one Hardware buttons menu.
 */
export function AppleDeviceRail({
  containerWidth,
  deviceName,
  deviceRuntime,
  inputConnected,
  mode,
  canUse3d,
  threeDisabledReason,
  toolsOpen,
  inspecting,
  recording,
  screenshotPending,
  orientation,
  orientationPending = false,
  onHome,
  onHardwareButton,
  onOrientation,
  onScreenshot,
  onToggleTools,
  onToggleInspect,
  onMode,
  onResetView,
  onToggleRecording,
  onFloat,
  onSwitchDevice,
  onPowerOff,
  extraControls,
}: AppleDeviceRailProps) {
  const compact = containerWidth < APPLE_RAIL_COMPACT_WIDTH;
  const hardwareDisabled = !inputConnected;
  const threeD = mode === "3d";
  const viewDisabled = !canUse3d && !threeD;
  const viewDescription = viewDisabled
    ? threeDisabledReason ?? "3D view is unavailable"
    : threeD
      ? "Switch to flat view"
      : "Switch to 3D view";

  return (
    <aside
      aria-label="Device controls"
      data-apple-rail={compact ? "compact" : "full"}
      className="pointer-events-none absolute inset-y-0 right-0 z-10 flex w-14 flex-col items-center justify-center py-3 pr-2"
    >
      <div
        /*
         * §B3: an OPAQUE pill. Round 2 used `bg-bg/80` with a backdrop blur,
         * which over a live device is twelve icons read through a frosted
         * smear of whatever the app happens to be showing — the blur changed
         * every frame, so the icons flickered.
         */
        className={cn(
          "pointer-events-auto flex shrink-0 flex-col items-center gap-1 overflow-y-auto",
          "rounded-full border border-border bg-surface p-1 shadow-md",
          "[scrollbar-width:none]",
        )}
      >
        <RailButton label="Home" disabled={hardwareDisabled} onClick={onHome}>
          <House size={16} />
        </RailButton>
        {/*
          * The rest of the device's physical buttons. They live in one menu
          * rather than five more rail icons: the rail is 28px circles and the
          * lock/volume/Siri/app-switcher keys are occasional, so a labelled
          * list keeps the rail legible. `shake` is not here — the helper cannot
          * press it and the service refuses it.
          */}
        <RailMenu
          label="Hardware buttons"
          disabled={hardwareDisabled}
          icon={<GameController size={16} />}
        >
          <div className={MENU_LABEL_CLASS}>Hardware buttons</div>
          <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={() => onHardwareButton("lock")}>
            <Lock size={14} />
            Lock
          </DropdownMenu.Item>
          <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={() => onHardwareButton("volume-up")}>
            <SpeakerHigh size={14} />
            Volume up
          </DropdownMenu.Item>
          <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={() => onHardwareButton("volume-down")}>
            <SpeakerLow size={14} />
            Volume down
          </DropdownMenu.Item>
          <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={() => onHardwareButton("siri")}>
            <Microphone size={14} />
            Siri
          </DropdownMenu.Item>
          <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={() => onHardwareButton("app-switcher")}>
            <SquaresFour size={14} />
            App switcher
          </DropdownMenu.Item>
        </RailMenu>
        {/*
          * §V2: the orientation control, which SHOWS the orientation.
          *
          * It survives the 360px collapse, unlike the "Rotate device" button it
          * replaces: the owner's complaint was that the control could not be
          * found, and a control that disappears in a narrow pane is one more
          * way not to find it. Its glyph turns with the device, its name says
          * the orientation out loud, and its menu names all four.
          */}
        <RailMenu
          label={orientationPending
            ? "Rotating device"
            : `Orientation: ${appleOrientationLabel(orientation)}`}
          disabled={hardwareDisabled || orientationPending}
          icon={(
            <DeviceMobile
              size={16}
              style={{ transform: `rotate(${appleOrientationIconDegrees(orientation)}deg)` }}
            />
          )}
        >
          <div className={MENU_LABEL_CLASS}>Orientation</div>
          {APPLE_ORIENTATION_CHOICES.map((choice) => (
            <DropdownMenu.Item
              key={choice}
              className={MENU_ITEM_CLASS}
              aria-checked={choice === orientation}
              onSelect={() => onOrientation(choice)}
            >
              {choice === orientation
                ? <Check size={14} weight="bold" />
                : <span className="w-[14px]" aria-hidden="true" />}
              {appleOrientationLabel(choice)}
            </DropdownMenu.Item>
          ))}
        </RailMenu>

        <RailDivider />

        {compact ? null : (
          <>
            <RailButton
              label="Inspect elements"
              description={inspecting ? "Stop inspecting" : "Inspect elements"}
              pressed={inspecting}
              onClick={onToggleInspect}
            >
              <Crosshair size={16} />
            </RailButton>
            <RailButton
              label={screenshotPending ? "Capturing screenshot" : "Save screenshot"}
              disabled={screenshotPending}
              onClick={onScreenshot}
            >
              <Camera size={16} />
            </RailButton>
            <RailButton
              label={recording ? "Stop recording" : "Record"}
              pressed={recording}
              /* The one control that is allowed a colour: a recording that is
                 running has to be legible at a glance, from across the room. */
              className={recording
                ? "bg-[color-mix(in_srgb,var(--color-error)_22%,transparent)] text-[var(--color-error)] hover:text-[var(--color-error)]"
                : undefined}
              onClick={onToggleRecording}
            >
              {recording ? <Stop size={16} weight="fill" /> : <Record size={16} />}
            </RailButton>
            <RailButton
              /* §A2: ONE toggle. The label says which view is on, the tooltip
                 says what the click does — or why it cannot. */
              label={threeD ? "View: 3D" : "View: Flat"}
              description={viewDescription}
              pressed={threeD}
              disabled={viewDisabled}
              onClick={() => onMode(threeD ? "flat" : "3d")}
            >
              {threeD ? <Cube size={16} /> : <DeviceMobile size={16} />}
            </RailButton>
          </>
        )}

        <RailDivider />

        <RailButton label="Device tools" pressed={toolsOpen} onClick={onToggleTools}>
          <SlidersHorizontal size={16} />
        </RailButton>

        {extraControls}

        <RailMenu label="More device actions" icon={<DotsThree size={16} weight="bold" />}>
          <div className={MENU_LABEL_CLASS}>
            {deviceRuntime ? `${deviceName} · ${deviceRuntime}` : deviceName}
          </div>
          {threeD ? (
            <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onResetView}>
              <ArrowsOut size={14} />
              Reset view
            </DropdownMenu.Item>
          ) : null}
          <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onFloat}>
            <PictureInPicture size={14} />
            Float over chat
          </DropdownMenu.Item>
          <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onSwitchDevice}>
            <DeviceMobile size={14} />
            Switch device…
          </DropdownMenu.Item>
          <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
          <DropdownMenu.Item
            className={cn(MENU_ITEM_CLASS, "text-[var(--color-error)]")}
            onSelect={onPowerOff}
          >
            <Power size={14} />
            Power off
          </DropdownMenu.Item>
        </RailMenu>
      </div>
    </aside>
  );
}

function RailDivider() {
  return <div aria-hidden="true" className="my-1 h-px w-5 shrink-0 bg-border" />;
}

/**
 * Every rail control is the shared `Button` (§B6) trimmed to a 28px circle:
 * same focus ring, same disabled rule, same press feedback as every other
 * button in ADE. The size and the radius are the only things overridden.
 */
const RAIL_BUTTON_CLASS = cn(
  "h-7 w-7 shrink-0 gap-0 rounded-full p-0",
  "text-muted-fg hover:bg-white/[0.07] hover:text-fg",
  "disabled:cursor-not-allowed disabled:opacity-40",
);

function RailButton({
  label,
  description,
  disabled,
  pressed,
  className,
  onClick,
  children,
}: {
  label: string;
  description?: string | null;
  disabled?: boolean;
  pressed?: boolean;
  className?: string | undefined;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <PaneTooltip label={description ?? label} side="left">
      <Button
        variant="ghost"
        size="sm"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        className={cn(RAIL_BUTTON_CLASS, pressed && "bg-secondary text-fg", className)}
      >
        {children}
      </Button>
    </PaneTooltip>
  );
}

function RailMenu({
  label,
  icon,
  disabled,
  children,
}: {
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenu.Root>
      <PaneTooltip label={label} side="left">
        <DropdownMenu.Trigger asChild>
          <Button variant="ghost" size="sm" aria-label={label} disabled={disabled} className={RAIL_BUTTON_CLASS}>
            {icon}
          </Button>
        </DropdownMenu.Trigger>
      </PaneTooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={MENU_CONTENT_CLASS} side="left" align="center" sideOffset={6}>
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
