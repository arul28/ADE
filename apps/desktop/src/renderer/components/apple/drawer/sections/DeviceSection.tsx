import { useState } from "react";
import type {
  IosSimulatorAccessibilityOption,
  IosSimulatorAppearance,
  IosSimulatorContentSize,
} from "../../../../../shared/types/iosSimulator";
import { cn } from "../../../ui/cn";
import {
  DRAWER_BUTTON,
  DRAWER_GHOST_BUTTON,
  DRAWER_INPUT,
  DRAWER_PRIMARY_BUTTON,
  DrawerMenu,
  DrawerSegmented,
  Row,
  Subhead,
  SwitchRow,
  type DrawerMenuOption,
} from "../drawerPrimitives";
import type { AppleDrawerContext } from "../drawerContext";

/**
 * §B1's **Device** group: everything that is true of the simulator itself
 * rather than of whatever app happens to be running on it — Appearance, Text
 * size, the accessibility switches, Location and the status bar.
 *
 * Round 3 had these as three separate sections (Simulator, Location, and no
 * status bar at all) stacked among six others. They are one question — "what
 * is this device pretending to be?" — and they are now one card.
 */

/** The four sizes a person recognises, mapped onto `simctl`'s content-size names. */
export const APPLE_DRAWER_TEXT_SIZES: readonly DrawerMenuOption<IosSimulatorContentSize>[] = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Default" },
  { value: "large", label: "Large" },
  { value: "extra-large", label: "Extra large" },
];

const SWITCHES: ReadonlyArray<{ option: IosSimulatorAccessibilityOption; label: string }> = [
  { option: "reduce-motion", label: "Reduce Motion" },
  { option: "increase-contrast", label: "Increase Contrast" },
  { option: "reduce-transparency", label: "Reduce Transparency" },
  { option: "button-shapes", label: "Show Borders" },
  { option: "voice-over", label: "VoiceOver" },
];

export const APPLE_LOCATION_PRESETS = [
  { label: "San Francisco", latitude: 37.7749, longitude: -122.4194 },
  { label: "New York", latitude: 40.7128, longitude: -74.006 },
  { label: "London", latitude: 51.5074, longitude: -0.1278 },
  { label: "Tokyo", latitude: 35.6762, longitude: 139.6503 },
  { label: "Sydney", latitude: -33.8688, longitude: 151.2093 },
] as const;

type PresetLabel = (typeof APPLE_LOCATION_PRESETS)[number]["label"];

/**
 * Apple's own screenshot status bar: 9:41, full bars, a charged battery.
 *
 * One button rather than six fields. The fields exist on the service
 * (`setStatusBar` takes time, network, bars and battery), but the reason a
 * person overrides the status bar is to take a picture of the app, and this is
 * the value every App Store screenshot in the world uses.
 */
export const APPLE_STATUS_BAR_DEMO = {
  time: "9:41",
  dataNetwork: "wifi",
  wifiBars: 3,
  cellularBars: 4,
  batteryState: "charged",
  batteryLevel: 100,
} as const;

export function DeviceSection({ ctx }: { ctx: AppleDrawerContext }) {
  const { scope, pinRef, actions } = ctx;
  const settings = actions.settings;
  const disabled = actions.disabled;
  const appearance = settings?.appearance;
  const contentSize = settings?.contentSize;
  const textSize = APPLE_DRAWER_TEXT_SIZES.some((size) => size.value === contentSize)
    ? (contentSize as IosSimulatorContentSize)
    : null;
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const parsed = { latitude: Number(latitude), longitude: Number(longitude) };
  const valid = latitude.trim() !== "" && longitude.trim() !== ""
    && Number.isFinite(parsed.latitude) && Number.isFinite(parsed.longitude)
    && Math.abs(parsed.latitude) <= 90 && Math.abs(parsed.longitude) <= 180;
  const setLocation = (lat: number, lon: number) =>
    actions.act(() => window.ade.iosSimulator.setLocation({ ...scope, latitude: lat, longitude: lon }, pinRef.current));
  const current = settings?.location ?? null;
  const overridden = settings?.statusBarOverridden === true;

  return (
    <>
      <Row label="Appearance">
        <DrawerSegmented<IosSimulatorAppearance>
          ariaLabel="Appearance"
          value={appearance === "light" || appearance === "dark" ? appearance : null}
          options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]}
          disabled={disabled || appearance === "unsupported"}
          onChange={(value) => {
            void actions.act(() => window.ade.iosSimulator.setAppearance({ ...scope, appearance: value }, pinRef.current));
          }}
        />
      </Row>
      <Row label="Text size">
        <DrawerMenu
          ariaLabel="Text size"
          value={textSize}
          placeholder={contentSize && contentSize !== "unknown" ? contentSize : "Unknown"}
          options={APPLE_DRAWER_TEXT_SIZES}
          disabled={disabled}
          onChange={(value) => {
            void actions.act(() => window.ade.iosSimulator.setContentSize({ ...scope, contentSize: value }, pinRef.current));
          }}
        />
      </Row>
      {SWITCHES.map(({ option, label }) => {
        const reported = settings?.accessibility?.[option];
        const checked = reported === null || reported === undefined ? undefined : reported;
        return (
          <SwitchRow
            key={label}
            label={label}
            checked={checked}
            disabled={disabled}
            onChange={(enabled) => {
              void actions.act(() => window.ade.iosSimulator.setAccessibilityOption({ ...scope, option, enabled }, pinRef.current));
            }}
          />
        );
      })}

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
        <DrawerMenu<PresetLabel>
          ariaLabel="Preset"
          value={null}
          placeholder="Preset…"
          options={APPLE_LOCATION_PRESETS.map((preset) => ({ value: preset.label, label: preset.label }))}
          disabled={disabled}
          onChange={(label) => {
            const preset = APPLE_LOCATION_PRESETS.find((candidate) => candidate.label === label);
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
        <button
          type="button"
          className={DRAWER_GHOST_BUTTON}
          disabled={disabled}
          onClick={() => {
            setLatitude("");
            setLongitude("");
            void actions.act(() => window.ade.iosSimulator.clearLocation({ ...scope }, pinRef.current));
          }}
        >
          Clear
        </button>
        {current ? (
          <span className="ml-auto font-mono text-[11px] text-muted-fg" data-testid="apple-drawer-location-current">
            {current.latitude.toFixed(3)}, {current.longitude.toFixed(3)}
          </span>
        ) : null}
      </div>

      <Subhead label="Status bar" />
      <Row label={overridden ? "Overridden" : "Device's own"}>
        <button
          type="button"
          className={DRAWER_BUTTON}
          disabled={disabled}
          onClick={() => {
            void actions.act(() => window.ade.iosSimulator.setStatusBar(
              { ...scope, ...APPLE_STATUS_BAR_DEMO },
              pinRef.current,
            ));
          }}
        >
          9:41
        </button>
        <button
          type="button"
          // Named for a screen reader, because the Location rows above have
          // their own Clear and "Clear" twice in one card says nothing.
          aria-label="Clear status bar"
          className={DRAWER_GHOST_BUTTON}
          disabled={disabled || !overridden}
          onClick={() => {
            void actions.act(() => window.ade.iosSimulator.clearStatusBar({ ...scope }, pinRef.current));
          }}
        >
          Clear
        </button>
      </Row>
    </>
  );
}
