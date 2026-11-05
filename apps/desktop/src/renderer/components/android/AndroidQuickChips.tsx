import { useEffect, useState, type MutableRefObject, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Airplane,
  BatteryCharging,
  BatteryFull,
  BatteryLow,
  BatteryMedium,
  BatteryWarning,
  Check,
  MapPin,
  Moon,
  SlidersHorizontal,
  Sun,
  WifiHigh,
  WifiSlash,
} from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { AndroidDeviceSetting, AndroidDeviceSettings } from "../../../shared/types/androidEmulator";
import { DEVICE_BATTERY_LEVELS, DEVICE_LOCATION_PRESETS } from "../device/locationPresets";
import { cn } from "../ui/cn";
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS, MENU_LABEL_CLASS, MENU_SEPARATOR_CLASS } from "../ui/paneMenuTokens";
import { showToast } from "../app/toast/toastStore";
import { describeAndroidError } from "./androidDeviceState";
import { useAndroidDrawerActions } from "./drawer/androidDrawerState";

/**
 * The quick chips over the stage (plan §5): location, battery, network and
 * dark mode. They are shortcuts to the same controls as the Tools drawer's
 * Emulator group, with the same calls and the same settings read, and a
 * "More in Tools" row that opens the drawer there.
 *
 * One settings read when the picture goes live (the drawer's own read, only
 * while the chips show) and one after each change; nothing polls.
 */

const CHIP_CLASS = cn(
  "inline-flex h-6 items-center gap-1 rounded-full border border-border/70 bg-surface/85 px-2",
  "font-sans text-[11px] text-fg/80 shadow-sm backdrop-blur-sm transition-colors",
  "hover:bg-fg/[0.07] hover:text-fg disabled:pointer-events-none disabled:opacity-50",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-accent)]",
);

function BatteryIcon({ level, charging }: { level: number | null; charging: boolean | null }) {
  if (charging) return <BatteryCharging size={13} />;
  if (level === null) return <BatteryMedium size={13} />;
  if (level <= 10) return <BatteryWarning size={13} />;
  if (level <= 30) return <BatteryLow size={13} />;
  if (level <= 70) return <BatteryMedium size={13} />;
  return <BatteryFull size={13} />;
}

function networkLabel(network: AndroidDeviceSettings["network"] | null): { icon: ReactNode; text: string } {
  if (network?.airplane) return { icon: <Airplane size={13} />, text: "Airplane" };
  if (network?.wifi === false && network?.mobileData === false) return { icon: <WifiSlash size={13} />, text: "Offline" };
  if (network?.wifi === false) return { icon: <WifiSlash size={13} />, text: "No Wi-Fi" };
  return { icon: <WifiHigh size={13} />, text: "Online" };
}

function Chip({
  label,
  icon,
  text,
  disabled,
  children,
  testId,
}: {
  label: string;
  icon: ReactNode;
  text?: string | null;
  disabled: boolean;
  children: ReactNode;
  testId: string;
}) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <button type="button" aria-label={label} title={label} className={CHIP_CLASS} data-android-chip={testId}>
          {icon}
          {text ? <span className="tabular-nums">{text}</span> : null}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={MENU_CONTENT_CLASS} side="bottom" align="start" sideOffset={6}>
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function AndroidQuickChips({
  laneId,
  pinRef,
  visible,
  onOpenTools,
}: {
  laneId: string;
  pinRef: MutableRefObject<OpenProjectBinding | null>;
  /** The chips show over a live picture; nothing is read otherwise. */
  visible: boolean;
  /** Opens the Tools drawer at its Emulator group. */
  onOpenTools: () => void;
}) {
  const actions = useAndroidDrawerActions({ laneId, pinRef, visible });
  const settings = actions.settings;
  const disabled = actions.disabled;
  // The emulator cannot report a location it was given; the chip shows the last one it took.
  const [placed, setPlaced] = useState<string | null>(null);
  // A refused change says so once, the way the drawer's own strip would.
  const { error, clearError } = actions;
  useEffect(() => {
    if (error == null) return;
    showToast({ tone: "error", title: "The emulator did not take the change", message: describeAndroidError(error).sentence });
    clearError();
  }, [clearError, error]);
  if (!visible) return null;

  const set = (setting: AndroidDeviceSetting) =>
    actions.actWithSettings(() => window.ade.androidEmulator.setDeviceSetting({ laneId, setting }, pinRef.current));
  const appearance = settings?.appearance ?? null;
  const battery = settings?.battery ?? { level: null, charging: null };
  const network = settings?.network ?? null;
  const net = networkLabel(network);
  const moreInTools = (
    <>
      <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
      <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onOpenTools}>
        <SlidersHorizontal size={14} />
        More in Tools
      </DropdownMenu.Item>
    </>
  );

  return (
    <div className="pointer-events-auto flex flex-wrap items-center gap-1" data-android-quick-chips="">
      <Chip label="Location" icon={<MapPin size={13} />} text={placed} disabled={disabled} testId="location">
        <div className={MENU_LABEL_CLASS}>Set the device's location</div>
        {DEVICE_LOCATION_PRESETS.map((preset) => (
          <DropdownMenu.Item
            key={preset.label}
            className={MENU_ITEM_CLASS}
            onSelect={() => {
              void actions.act(() => window.ade.androidEmulator.setLocation(
                { laneId, latitude: preset.latitude, longitude: preset.longitude },
                pinRef.current,
              )).then((accepted) => { if (accepted) setPlaced(preset.label); });
            }}
          >
            <span className="min-w-0 flex-1">{preset.label}</span>
            {placed === preset.label ? <Check size={12} /> : null}
          </DropdownMenu.Item>
        ))}
        {moreInTools}
      </Chip>

      <Chip
        label="Battery"
        icon={<BatteryIcon level={battery.level} charging={battery.charging} />}
        text={battery.level === null ? null : `${battery.level}%`}
        disabled={disabled}
        testId="battery"
      >
        <div className={MENU_LABEL_CLASS}>Battery level</div>
        {DEVICE_BATTERY_LEVELS.map((level) => (
          <DropdownMenu.Item key={level} className={MENU_ITEM_CLASS} onSelect={() => { void set({ kind: "battery", level }); }}>
            <span className="min-w-0 flex-1 tabular-nums">{level}%</span>
            {battery.level === level ? <Check size={12} /> : null}
          </DropdownMenu.Item>
        ))}
        <DropdownMenu.CheckboxItem
          className={MENU_ITEM_CLASS}
          checked={battery.charging === true}
          onCheckedChange={(charging) => { void set({ kind: "battery", charging }); }}
        >
          <span className="min-w-0 flex-1">Charging</span>
          {battery.charging ? <Check size={12} /> : null}
        </DropdownMenu.CheckboxItem>
        {moreInTools}
      </Chip>

      <Chip label="Network" icon={net.icon} text={net.text} disabled={disabled} testId="network">
        <div className={MENU_LABEL_CLASS}>Network</div>
        {([
          ["wifi", "Wi-Fi", network?.wifi],
          ["mobile-data", "Mobile data", network?.mobileData],
          ["airplane", "Airplane mode", network?.airplane],
        ] as const).map(([kind, label, on]) => (
          <DropdownMenu.CheckboxItem
            key={kind}
            className={MENU_ITEM_CLASS}
            checked={on === true}
            onCheckedChange={(next) => { void set({ kind, on: next }); }}
          >
            <span className="min-w-0 flex-1">{label}</span>
            {on ? <Check size={12} /> : null}
          </DropdownMenu.CheckboxItem>
        ))}
        {moreInTools}
      </Chip>

      <button
        type="button"
        className={CHIP_CLASS}
        disabled={disabled || appearance === null}
        aria-label={appearance === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        title={appearance === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        aria-pressed={appearance === "dark"}
        data-android-chip="appearance"
        onClick={() => {
          const next = appearance === "dark" ? "light" : "dark";
          void actions.act(() => window.ade.androidEmulator.setAppearance({ laneId, appearance: next }, pinRef.current));
        }}
      >
        {appearance === "dark" ? <Moon size={13} weight="fill" /> : <Sun size={13} />}
      </button>
    </div>
  );
}
