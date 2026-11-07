import { useState } from "react";
import { cn } from "../ui/cn";
import { DRAWER_GHOST_BUTTON, DRAWER_INPUT, DRAWER_PRIMARY_BUTTON, DrawerMenu } from "../ui/drawerPrimitives";
import { DEVICE_LOCATION_PRESETS, type DeviceLocationPresetLabel } from "./locationPresets";

type Point = { latitude: number; longitude: number };

/**
 * A drawer's Location rows: latitude and longitude, a preset menu that sets a
 * city at once, **Set**, an optional **Clear**, and the point the device
 * holds now. The caller's `onSet` runs the command through the drawer's `act`.
 */
export function DeviceLocationRows({
  tool,
  disabled,
  current,
  onSet,
  onClear,
}: {
  /** Prefixes the current-point test id. */
  tool: "apple" | "android";
  disabled: boolean;
  /** The point the device holds, as far as ADE knows. */
  current: Point | null;
  onSet: (point: Point) => void;
  /** Absent hides **Clear**. Android's Clear moves the GPS back to the emulator's default point. */
  onClear?: (() => void) | undefined;
}) {
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const parsed = { latitude: Number(latitude), longitude: Number(longitude) };
  const valid = latitude.trim() !== "" && longitude.trim() !== ""
    && Number.isFinite(parsed.latitude) && Number.isFinite(parsed.longitude)
    && Math.abs(parsed.latitude) <= 90 && Math.abs(parsed.longitude) <= 180;

  return (
    <>
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
            onSet({ latitude: preset.latitude, longitude: preset.longitude });
          }}
        />
        <button
          type="button"
          className={DRAWER_PRIMARY_BUTTON}
          disabled={disabled || !valid}
          onClick={() => onSet(parsed)}
        >
          Set
        </button>
        {onClear ? (
          <button
            type="button"
            className={DRAWER_GHOST_BUTTON}
            disabled={disabled}
            onClick={() => {
              setLatitude("");
              setLongitude("");
              onClear();
            }}
          >
            Clear
          </button>
        ) : null}
        {current ? (
          <span className="ml-auto font-mono text-[11px] text-muted-fg" data-testid={`${tool}-drawer-location-current`}>
            {current.latitude.toFixed(3)}, {current.longitude.toFixed(3)}
          </span>
        ) : null}
      </div>
    </>
  );
}
