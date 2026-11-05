import { useState } from "react";
import { cn } from "../../ui/cn";
import {
  DRAWER_INPUT,
  DRAWER_PRIMARY_BUTTON,
  DrawerMenu,
  DrawerSegmented,
  Row,
  Subhead,
  SwitchRow,
} from "../../ui/drawerPrimitives";
import { DEVICE_LOCATION_PRESETS, type DeviceLocationPresetLabel } from "../../device/locationPresets";
import { deviceSettingSetter } from "./AndroidDeviceSection";
import type { AndroidDrawerContext } from "./androidDrawerState";

/*
 * The **Emulator** group: what the emulator pretends about the world around
 * the phone (plan §5: location, battery, network, appearance; fold comes in
 * P3). The quick chips over the stage (P2) are shortcuts to these controls.
 */

const BATTERY_LEVELS = ["100", "80", "50", "20", "5"] as const;
type BatteryLevel = (typeof BATTERY_LEVELS)[number];

export function AndroidEmulatorSection({ ctx }: { ctx: AndroidDrawerContext }) {
  const { laneId, pinRef, actions } = ctx;
  const settings = actions.settings;
  const disabled = actions.disabled;
  const set = deviceSettingSetter(ctx);
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  // The emulator cannot report a location it was given, so the card shows the last one it took.
  const [placed, setPlaced] = useState<{ latitude: number; longitude: number } | null>(null);
  const parsed = { latitude: Number(latitude), longitude: Number(longitude) };
  const valid = latitude.trim() !== "" && longitude.trim() !== ""
    && Number.isFinite(parsed.latitude) && Number.isFinite(parsed.longitude)
    && Math.abs(parsed.latitude) <= 90 && Math.abs(parsed.longitude) <= 180;
  const setLocation = (lat: number, lon: number) =>
    actions.act(() => window.ade.androidEmulator.setLocation({ laneId, latitude: lat, longitude: lon }, pinRef.current))
      .then((accepted) => {
        if (accepted) setPlaced({ latitude: lat, longitude: lon });
        return accepted;
      });
  const level = settings?.battery.level ?? null;
  const network = settings?.network;

  return (
    <>
      <Row label="Appearance">
        <DrawerSegmented<"light" | "dark">
          ariaLabel="Appearance"
          value={settings?.appearance ?? null}
          options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]}
          disabled={disabled}
          onChange={(appearance) => {
            void actions.act(() => window.ade.androidEmulator.setAppearance({ laneId, appearance }, pinRef.current));
          }}
        />
      </Row>

      <Subhead label="Location" />
      <div className="flex min-h-7 items-center gap-1.5">
        <input
          className={cn(DRAWER_INPUT, "font-mono")}
          placeholder="Latitude"
          aria-label="Latitude"
          inputMode="decimal"
          value={latitude}
          disabled={disabled}
          onChange={(event) => setLatitude(event.target.value)}
        />
        <input
          className={cn(DRAWER_INPUT, "font-mono")}
          placeholder="Longitude"
          aria-label="Longitude"
          inputMode="decimal"
          value={longitude}
          disabled={disabled}
          onChange={(event) => setLongitude(event.target.value)}
        />
      </div>
      <div className="flex min-h-7 flex-wrap items-center gap-1.5">
        <DrawerMenu<DeviceLocationPresetLabel>
          ariaLabel="Preset"
          value={null}
          placeholder="Preset…"
          options={DEVICE_LOCATION_PRESETS.map((preset) => ({ value: preset.label, label: preset.label }))}
          disabled={disabled}
          onChange={(label) => {
            const preset = DEVICE_LOCATION_PRESETS.find((candidate) => candidate.label === label);
            if (!preset) return;
            setLatitude(String(preset.latitude));
            setLongitude(String(preset.longitude));
            void setLocation(preset.latitude, preset.longitude);
          }}
        />
        <button
          type="button"
          className={DRAWER_PRIMARY_BUTTON}
          disabled={disabled || !valid}
          onClick={() => { void setLocation(parsed.latitude, parsed.longitude); }}
        >
          Set
        </button>
        {placed ? (
          <span className="ml-auto font-mono text-[11px] text-muted-fg" data-testid="android-drawer-location-current">
            {placed.latitude.toFixed(3)}, {placed.longitude.toFixed(3)}
          </span>
        ) : null}
      </div>

      <Subhead label="Battery" />
      <Row label="Level">
        <DrawerMenu<BatteryLevel>
          ariaLabel="Battery level"
          value={BATTERY_LEVELS.find((candidate) => Number(candidate) === level) ?? null}
          placeholder={level === null ? "Unknown" : `${level}%`}
          options={BATTERY_LEVELS.map((value) => ({ value, label: `${value}%` }))}
          disabled={disabled}
          onChange={(value) => { void set({ kind: "battery", level: Number(value) }); }}
        />
      </Row>
      <SwitchRow
        label="Charging"
        checked={settings?.battery.charging ?? undefined}
        disabled={disabled}
        onChange={(charging) => { void set({ kind: "battery", charging }); }}
      />

      <Subhead label="Network" />
      <SwitchRow
        label="Airplane mode"
        checked={network?.airplane ?? undefined}
        disabled={disabled}
        onChange={(on) => { void set({ kind: "airplane", on }); }}
      />
      <SwitchRow
        label="Wi-Fi"
        checked={network?.wifi ?? undefined}
        disabled={disabled}
        onChange={(on) => { void set({ kind: "wifi", on }); }}
      />
      <SwitchRow
        label="Mobile data"
        checked={network?.mobileData ?? undefined}
        disabled={disabled}
        onChange={(on) => { void set({ kind: "mobile-data", on }); }}
      />
    </>
  );
}
