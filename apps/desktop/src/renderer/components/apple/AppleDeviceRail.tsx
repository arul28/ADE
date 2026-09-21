import type { ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowsOut,
  ArrowsClockwise,
  Camera,
  Cube,
  DeviceMobile,
  DotsThree,
  House,
  Moon,
  PictureInPicture,
  Power,
  Record,
  SlidersHorizontal,
  Stop,
  Sun,
  TextAa,
} from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { PaneTooltip } from "../ui/PaneTooltip";
import {
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_LABEL_CLASS,
  MENU_SEPARATOR_CLASS,
} from "../ui/paneMenuTokens";
import { APPLE_TEXT_SIZES, type AppleDeviceControls } from "./useAppleDeviceControls";

/** Below this the rail keeps Home, Tools and More, and nothing else. */
export const APPLE_RAIL_COMPACT_WIDTH = 360;

export type AppleDeviceRailProps = {
  /** Container width in px, for the 360px collapse. */
  containerWidth: number;
  deviceName: string;
  deviceRuntime: string | null;
  controls: AppleDeviceControls;
  /** False while the input socket is down: every device control is refused. */
  inputConnected: boolean;
  mode: "flat" | "3d";
  canUse3d: boolean;
  /** Why 3D is unavailable, when it is. */
  threeDisabledReason: string | null;
  toolsOpen: boolean;
  recording: boolean;
  screenshotPending: boolean;
  onHome: () => void;
  onRotate: () => void;
  onScreenshot: () => void;
  onToggleTools: () => void;
  onMode: (mode: "flat" | "3d") => void;
  onResetView: () => void;
  onToggleRecording: () => void;
  onFloat: () => void;
  onSwitchDevice: () => void;
  onPowerOff: () => void;
};

/**
 * The device's controls, in one pill on the right edge of the picture.
 *
 * Round 1 stacked twelve unlabelled icons down the column with a second strip
 * of word-buttons at the bottom, two of which did nothing. Everything here has
 * a name and a tooltip, the destructive action is last inside a menu, and
 * `Shake` — which the service refuses with `APPLE_BUTTON_UNSUPPORTED` — does
 * not exist as a control at all, because a button that can only fail is worse
 * than no button.
 */
export function AppleDeviceRail({
  containerWidth,
  deviceName,
  deviceRuntime,
  controls,
  inputConnected,
  mode,
  canUse3d,
  threeDisabledReason,
  toolsOpen,
  recording,
  screenshotPending,
  onHome,
  onRotate,
  onScreenshot,
  onToggleTools,
  onMode,
  onResetView,
  onToggleRecording,
  onFloat,
  onSwitchDevice,
  onPowerOff,
}: AppleDeviceRailProps) {
  const compact = containerWidth < APPLE_RAIL_COMPACT_WIDTH;
  const appearance = controls.settings?.appearance;
  const nextAppearance = appearance === "dark" ? "light" : "dark";
  const textSize = controls.settings?.contentSize;
  const hardwareDisabled = !inputConnected;

  return (
    <aside
      aria-label="Device controls"
      data-apple-rail={compact ? "compact" : "full"}
      className="pointer-events-none absolute inset-y-0 right-0 z-10 flex w-14 flex-col items-center justify-center py-3 pr-2"
    >
      <div
        className={cn(
          "pointer-events-auto flex shrink-0 flex-col items-center gap-1 overflow-y-auto",
          "rounded-full border border-border bg-bg/80 p-1 shadow-sm backdrop-blur-md",
          "[scrollbar-width:none]",
        )}
      >
        <RailButton label="Home" disabled={hardwareDisabled} onClick={onHome}>
          <House size={16} />
        </RailButton>
        {compact ? null : (
          <RailButton label="Rotate device" disabled={hardwareDisabled} onClick={onRotate}>
            <ArrowsClockwise size={16} />
          </RailButton>
        )}

        <RailDivider />

        {compact ? null : (
          <>
            <RailButton
              label={`Switch device to ${nextAppearance} mode`}
              disabled={controls.disabled || !appearance || appearance === "unsupported"}
              onClick={() => void controls.act({ type: "setAppearance", value: nextAppearance })}
            >
              {appearance === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </RailButton>
            <RailMenu
              label="Device text size"
              disabled={controls.disabled || !textSize}
              icon={<TextAa size={16} />}
            >
              <div className={MENU_LABEL_CLASS}>Text size</div>
              {APPLE_TEXT_SIZES.map((entry) => (
                <DropdownMenu.Item
                  key={entry.value}
                  className={MENU_ITEM_CLASS}
                  onSelect={() => void controls.act({ type: "setTextSize", value: entry.value })}
                >
                  <span className="flex-1">{entry.label}</span>
                  {textSize === entry.value ? <span aria-hidden="true">✓</span> : null}
                </DropdownMenu.Item>
              ))}
            </RailMenu>
          </>
        )}

        <RailButton label="Device tools" pressed={toolsOpen} onClick={onToggleTools}>
          <SlidersHorizontal size={16} />
        </RailButton>

        {compact ? null : (
          <RailButton
            label={screenshotPending ? "Capturing screenshot" : "Save screenshot"}
            disabled={screenshotPending}
            onClick={onScreenshot}
          >
            <Camera size={16} />
          </RailButton>
        )}

        <RailMenu label="More device actions" icon={<DotsThree size={16} weight="bold" />}>
          <div className={MENU_LABEL_CLASS}>
            {deviceRuntime ? `${deviceName} · ${deviceRuntime}` : deviceName}
          </div>
          <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onToggleRecording}>
            {recording ? <Stop size={14} /> : <Record size={14} />}
            {recording ? "Stop recording" : "Record"}
          </DropdownMenu.Item>
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

        {compact ? null : (
          <>
            <RailDivider />
            <RailButton
              label="3D view"
              pressed={mode === "3d"}
              disabled={!canUse3d}
              description={canUse3d ? null : threeDisabledReason}
              onClick={() => onMode("3d")}
            >
              <Cube size={16} />
            </RailButton>
            <RailButton label="Flat view" pressed={mode === "flat"} onClick={() => onMode("flat")}>
              <DeviceMobile size={16} />
            </RailButton>
            {mode === "3d" ? (
              <RailButton label="Reset view" onClick={onResetView}>
                <ArrowsOut size={16} />
              </RailButton>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}

function RailDivider() {
  return <div aria-hidden="true" className="my-1 h-px w-5 shrink-0 bg-border" />;
}

const RAIL_BUTTON_CLASS = cn(
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
  "text-muted-fg transition-colors hover:bg-white/[0.07] hover:text-fg",
  "disabled:cursor-not-allowed disabled:opacity-40",
);

function RailButton({
  label,
  description,
  disabled,
  pressed,
  onClick,
  children,
}: {
  label: string;
  description?: string | null;
  disabled?: boolean;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <PaneTooltip label={description ?? label} side="left">
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        className={cn(RAIL_BUTTON_CLASS, pressed && "bg-secondary text-fg")}
      >
        {children}
      </button>
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
          <button type="button" aria-label={label} disabled={disabled} className={RAIL_BUTTON_CLASS}>
            {icon}
          </button>
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
