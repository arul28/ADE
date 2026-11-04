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
import { Button } from "../ui/Button";
import { PaneTooltip } from "../ui/PaneTooltip";
import {
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_LABEL_CLASS,
  MENU_SEPARATOR_CLASS,
} from "../ui/paneMenuTokens";

/** Below this the rail keeps the navigation keys and More, and nothing else (Apple's 360px rule). */
export const ANDROID_RAIL_COMPACT_WIDTH = 360;

/** The rail's width (`w-14`), which the stage keeps the screen clear of. */
export const ANDROID_RAIL_WIDTH = 56;

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
  const compact = containerWidth < ANDROID_RAIL_COMPACT_WIDTH;
  const keysDisabled = !inputConnected;
  return (
    <aside
      aria-label="Device controls"
      data-android-rail={compact ? "compact" : "full"}
      className="pointer-events-none absolute inset-y-0 right-0 z-10 flex w-14 flex-col items-center justify-center py-3 pr-2"
    >
      <div
        className={cn(
          "pointer-events-auto flex shrink-0 flex-col items-center gap-1 overflow-y-auto",
          "rounded-full border border-border bg-surface p-1 shadow-md",
          "[scrollbar-width:none]",
        )}
      >
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
      </div>
    </aside>
  );
}

function RailDivider() {
  return <div aria-hidden="true" className="my-1 h-px w-5 shrink-0 bg-border" />;
}

/** The Apple rail's button: the shared `Button` trimmed to a 28px circle. */
const RAIL_BUTTON_CLASS = cn(
  "h-7 w-7 shrink-0 gap-0 rounded-full p-0",
  "text-muted-fg hover:bg-fg/[0.07] hover:text-fg",
  "disabled:cursor-not-allowed disabled:opacity-40",
);

function RailButton({
  label,
  description,
  disabled,
  onClick,
  children,
}: {
  label: string;
  description?: string | null;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <PaneTooltip label={description ?? label} side="left">
      <Button
        variant="ghost"
        size="sm"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={RAIL_BUTTON_CLASS}
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
