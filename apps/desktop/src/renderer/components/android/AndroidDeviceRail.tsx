import type { ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Aperture,
  ArrowArcLeft,
  ArrowsOut,
  Camera,
  Check,
  Circle,
  Crosshair,
  Cube,
  DeviceMobile,
  DotsThree,
  Palette,
  Power,
  Record,
  SlidersHorizontal,
  SpeakerHigh,
  SpeakerLow,
  Square,
  Stop,
} from "@phosphor-icons/react";
import type { AndroidCatalogColor } from "../../../shared/androidDeviceCatalog";
import type { AndroidHardwareKey } from "../../../shared/types/androidEmulator";
import { cn } from "../ui/cn";
import { DEVICE_RAIL_COMPACT_WIDTH, DeviceRail, RailButton, RailDivider, RailMenu } from "../device/DeviceRail";
import {
  MENU_CONTENT_CLASS,
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
  /* P1 look. Each is absent where it does not apply. */
  /** The view that shows: the 3D body or the flat picture. */
  mode?: "flat" | "3d";
  onMode?: ((mode: "flat" | "3d") => void) | undefined;
  /** Why 3D cannot be turned on, when it cannot. */
  threeDisabledReason?: string | null;
  onRender?: (() => void) | undefined;
  rendering?: boolean;
  onResetView?: (() => void) | undefined;
  /** The body colours of the device's catalog entry; absent for a device made from a bare profile. */
  colors?: readonly AndroidCatalogColor[] | undefined;
  colorId?: string | null;
  onColor?: ((colorId: string) => void) | undefined;
  /* P1 tools. Each is absent where it does not apply (another person's device). */
  inspecting?: boolean;
  onToggleInspect?: (() => void) | undefined;
  recording?: boolean;
  recordingBusy?: boolean;
  onToggleRecording?: (() => void) | undefined;
  toolsOpen?: boolean;
  onToggleTools?: (() => void) | undefined;
};

/**
 * The emulator's controls, in one pill on the right edge of the picture: the
 * Apple rail's place, size and classes, so moving between the two tools is
 * easy (plan §5).
 *
 * Order: Back, Home, Recents, a divider, then Power ▾ (Power, Volume up,
 * Volume down), Rotate, Inspect, Screenshot, Render, Record, 3D/Flat, a
 * divider, Tools, More: the Apple order.
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
  mode = "flat",
  onMode,
  threeDisabledReason = null,
  onRender,
  rendering = false,
  onResetView,
  colors,
  colorId = null,
  onColor,
  inspecting = false,
  onToggleInspect,
  recording = false,
  recordingBusy = false,
  onToggleRecording,
  toolsOpen = false,
  onToggleTools,
}: AndroidDeviceRailProps) {
  const threeD = mode === "3d";
  const viewDisabled = Boolean(threeDisabledReason) && !threeD;
  const viewDescription = viewDisabled
    ? threeDisabledReason ?? "3D view is unavailable"
    : threeD
      ? "Switch to flat view"
      : "Switch to 3D view";
  // Below the compact width the rail keeps the navigation keys and More, and nothing else.
  const compact = containerWidth < DEVICE_RAIL_COMPACT_WIDTH;
  const keysDisabled = !inputConnected;
  return (
    <DeviceRail tool="android" compact={compact}>
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
          {onToggleInspect ? (
            <RailButton
              label="Inspect elements"
              description={inspecting ? "Stop inspecting" : "Inspect elements"}
              pressed={inspecting}
              disabled={keysDisabled && !inspecting}
              onClick={onToggleInspect}
            >
              <Crosshair size={16} />
            </RailButton>
          ) : null}
          <RailButton
            label={screenshotPending ? "Capturing screenshot" : "Save screenshot"}
            disabled={keysDisabled || screenshotPending}
            onClick={onScreenshot}
          >
            <Camera size={16} />
          </RailButton>
          {onRender ? (
            <RailButton
              label={rendering ? "Rendering" : "Render the device in 3D"}
              disabled={rendering || keysDisabled}
              onClick={onRender}
            >
              <Aperture size={16} />
            </RailButton>
          ) : null}
          {onToggleRecording ? (
            <RailButton
              label={recording ? "Stop recording" : "Record"}
              pressed={recording}
              // The one control allowed a colour: a running recording must read at a glance.
              className={recording
                ? "bg-[color-mix(in_srgb,var(--color-error)_22%,transparent)] text-[var(--color-error)] hover:text-[var(--color-error)]"
                : undefined}
              disabled={recordingBusy || (keysDisabled && !recording)}
              onClick={onToggleRecording}
            >
              {recording ? <Stop size={16} weight="fill" /> : <Record size={16} />}
            </RailButton>
          ) : null}
          {onMode ? (
            <RailButton
              // One toggle: the label says which view is on, the tooltip what a click does.
              label={threeD ? "View: 3D" : "View: Flat"}
              description={viewDescription}
              pressed={threeD}
              disabled={viewDisabled}
              onClick={() => onMode(threeD ? "flat" : "3d")}
            >
              {threeD ? <Cube size={16} /> : <DeviceMobile size={16} />}
            </RailButton>
          ) : null}
        </>
      )}
      <RailDivider />

      {onToggleTools ? (
        <RailButton label="Device tools" pressed={toolsOpen} onClick={onToggleTools}>
          <SlidersHorizontal size={16} />
        </RailButton>
      ) : null}

      {extraControls}

      <RailMenu label="More device actions" icon={<DotsThree size={16} weight="bold" />}>
        <div className={MENU_LABEL_CLASS}>{deviceSpec ? `${deviceName} · ${deviceSpec}` : deviceName}</div>
        {threeD && onResetView ? (
          <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onResetView}>
            <ArrowsOut size={14} />
            Reset view
          </DropdownMenu.Item>
        ) : null}
        {colors && colors.length > 1 && onColor ? (
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className={MENU_ITEM_CLASS} data-android-color-menu="">
              <Palette size={14} />
              Body colour
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent className={MENU_CONTENT_CLASS} sideOffset={6}>
                {colors.map((color) => (
                  <DropdownMenu.Item
                    key={color.id}
                    className={MENU_ITEM_CLASS}
                    data-android-color={color.id}
                    onSelect={() => onColor(color.id)}
                  >
                    <span
                      aria-hidden="true"
                      className="size-3 shrink-0 rounded-full ring-1 ring-inset ring-fg/20"
                      style={{ backgroundColor: color.body }}
                    />
                    <span className="min-w-0 flex-1">{color.name}</span>
                    {(colorId ?? colors[0]?.id) === color.id ? <Check size={12} /> : null}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
        ) : null}
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
            {onRender ? (
              <DropdownMenu.Item className={MENU_ITEM_CLASS} disabled={keysDisabled || rendering} onSelect={onRender}>
                <Aperture size={14} />
                Render in 3D…
              </DropdownMenu.Item>
            ) : null}
            {onMode ? (
              <DropdownMenu.Item className={MENU_ITEM_CLASS} disabled={viewDisabled} onSelect={() => onMode(threeD ? "flat" : "3d")}>
                {threeD ? <DeviceMobile size={14} /> : <Cube size={14} />}
                {threeD ? "Flat view" : "3D view"}
              </DropdownMenu.Item>
            ) : null}
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
