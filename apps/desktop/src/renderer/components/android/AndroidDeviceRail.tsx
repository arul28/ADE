import type { ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowArcLeft,
  Camera,
  Circle,
  DeviceMobile,
  DotsThree,
  Power,
  SpeakerHigh,
  SpeakerLow,
  Square,
} from "@phosphor-icons/react";
import type { AndroidHardwareKey } from "../../../shared/types/androidEmulator";
import { cn } from "../ui/cn";
import { DEVICE_RAIL_COMPACT_WIDTH, DeviceRail, RailButton, RailDivider, RailMenu } from "../device/DeviceRail";
import {
  MENU_ITEM_CLASS,
  MENU_LABEL_CLASS,
  MENU_SEPARATOR_CLASS,
} from "../ui/paneMenuTokens";

export type AndroidDeviceRailProps = {
  containerWidth: number;
  deviceName: string;
  /** `Medium Phone · API 36`, for the More menu's label. */
  deviceSpec: string | null;
  /** False while the picture is not live: every device control is refused. */
  inputConnected: boolean;
  screenshotPending: boolean;
  onKey: (key: AndroidHardwareKey) => void;
  /** Toggles portrait and landscape; absent shows the button disabled. */
  onRotate?: (() => void) | undefined;
  onScreenshot: () => void;
  /** Absent when the lane's device is not this pane's to change. */
  onSwitchDevice?: (() => void) | undefined;
  onPowerOff: () => void;
  /** The shared preview / maximize controls every screen tool carries. */
  extraControls?: ReactNode;
};

/**
 * The emulator's controls, in one pill on the right edge of the picture: the
 * Apple rail's place, size and classes, so moving between the two tools is
 * easy (plan §5).
 *
 * Order: Back, Home, Recents, a divider, then Power ▾ (Power, Volume up,
 * Volume down), Rotate, Screenshot, More. P0 has no Inspect, Record, 3D or
 * Tools drawer; they slot in above More in the Apple order when they land.
 */
export function AndroidDeviceRail({
  containerWidth,
  deviceName,
  deviceSpec,
  inputConnected,
  screenshotPending,
  onKey,
  onRotate,
  onScreenshot,
  onSwitchDevice,
  onPowerOff,
  extraControls,
}: AndroidDeviceRailProps) {
  // Below the compact width the rail keeps the navigation keys and More, and nothing else.
  const compact = containerWidth < DEVICE_RAIL_COMPACT_WIDTH;
  const keysDisabled = !inputConnected;
  return (
    <DeviceRail railAttribute="data-android-rail" compact={compact}>
      <RailButton label="Back" description="Back (Esc)" disabled={keysDisabled} onClick={() => onKey("back")}>
        <ArrowArcLeft size={16} />
      </RailButton>
      <RailButton label="Home" disabled={keysDisabled} onClick={() => onKey("home")}>
        <Circle size={16} />
      </RailButton>
      <RailButton label="Recents" disabled={keysDisabled} onClick={() => onKey("recents")}>
        <Square size={15} />
      </RailButton>

      <RailDivider />

      <RailMenu label="Power and volume" disabled={keysDisabled} icon={<Power size={16} />}>
        <div className={MENU_LABEL_CLASS}>Hardware buttons</div>
        <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={() => onKey("power")}>
          <Power size={14} />
          Power
        </DropdownMenu.Item>
        <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={() => onKey("volume_up")}>
          <SpeakerHigh size={14} />
          Volume up
        </DropdownMenu.Item>
        <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={() => onKey("volume_down")}>
          <SpeakerLow size={14} />
          Volume down
        </DropdownMenu.Item>
      </RailMenu>
      {compact ? null : (
        <>
          <RailButton
            label="Rotate"
            description="Portrait or landscape. The home screen stays portrait; apps that allow rotation turn."
            disabled={keysDisabled || !onRotate}
            onClick={() => onRotate?.()}
          >
            <DeviceMobile size={16} style={{ transform: "rotate(90deg)" }} />
          </RailButton>
          <RailButton
            label={screenshotPending ? "Capturing screenshot" : "Save screenshot"}
            disabled={keysDisabled || screenshotPending}
            onClick={onScreenshot}
          >
            <Camera size={16} />
          </RailButton>
        </>
      )}

      <RailDivider />

      {extraControls}

      <RailMenu label="More device actions" icon={<DotsThree size={16} weight="bold" />}>
        <div className={MENU_LABEL_CLASS}>{deviceSpec ? `${deviceName} · ${deviceSpec}` : deviceName}</div>
        {onSwitchDevice ? (
          <>
            <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onSwitchDevice}>
              <DeviceMobile size={14} />
              Switch device…
            </DropdownMenu.Item>
            <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
          </>
        ) : null}
        {compact ? (
          <>
            {/* A short pane drops these two from the rail; they live here instead. */}
            <DropdownMenu.Item className={MENU_ITEM_CLASS} disabled={keysDisabled || !onRotate} onSelect={() => onRotate?.()}>
              <DeviceMobile size={14} style={{ transform: "rotate(90deg)" }} />
              Rotate
            </DropdownMenu.Item>
            <DropdownMenu.Item className={MENU_ITEM_CLASS} disabled={keysDisabled || screenshotPending} onSelect={onScreenshot}>
              <Camera size={14} />
              Save screenshot
            </DropdownMenu.Item>
            <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
          </>
        ) : null}
        <DropdownMenu.Item className={cn(MENU_ITEM_CLASS, "text-[var(--color-error)]")} onSelect={onPowerOff}>
          <Power size={14} />
          Power off
        </DropdownMenu.Item>
      </RailMenu>
    </DeviceRail>
  );
}
