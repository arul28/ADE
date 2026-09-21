import { useState } from "react";
import { cn } from "../../../ui/cn";
import { DRAWER_BUTTON, DRAWER_GHOST_BUTTON, DRAWER_INPUT, DrawerMenu, Section } from "../drawerPrimitives";
import type { AppleDrawerContext } from "../drawerContext";

export const APPLE_LOCATION_PRESETS = [
  { label: "San Francisco", latitude: 37.7749, longitude: -122.4194 },
  { label: "New York", latitude: 40.7128, longitude: -74.006 },
  { label: "London", latitude: 51.5074, longitude: -0.1278 },
  { label: "Tokyo", latitude: 35.6762, longitude: 139.6503 },
  { label: "Sydney", latitude: -33.8688, longitude: 151.2093 },
] as const;

type PresetLabel = (typeof APPLE_LOCATION_PRESETS)[number]["label"];

/** §8.5 — Latitude / Longitude, Preset, Set, Clear. */
export function LocationSection({ ctx }: { ctx: AppleDrawerContext }) {
  const { scope, pinRef, actions } = ctx;
  const disabled = actions.disabled;
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const parsed = { latitude: Number(latitude), longitude: Number(longitude) };
  const valid = latitude.trim() !== "" && longitude.trim() !== ""
    && Number.isFinite(parsed.latitude) && Number.isFinite(parsed.longitude)
    && Math.abs(parsed.latitude) <= 90 && Math.abs(parsed.longitude) <= 180;
  const set = (lat: number, lon: number) =>
    actions.act(() => window.ade.iosSimulator.setLocation({ ...scope, latitude: lat, longitude: lon }, pinRef.current));
  const current = actions.settings?.location ?? null;
  return (
    <Section title="Location" testId="apple-drawer-location">
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
            void set(preset.latitude, preset.longitude);
          }}
        />
        <button type="button" className={DRAWER_BUTTON} disabled={disabled || !valid} onClick={() => { void set(parsed.latitude, parsed.longitude); }}>
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
    </Section>
  );
}
