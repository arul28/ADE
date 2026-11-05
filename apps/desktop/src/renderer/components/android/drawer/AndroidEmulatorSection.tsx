import { useState } from "react";
import {
  DrawerMenu,
  DrawerSegmented,
  Row,
  Subhead,
  SwitchRow,
} from "../../ui/drawerPrimitives";
import { DeviceLocationRows } from "../../device/DeviceLocationRows";
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
  // The emulator cannot report a location it was given, so the card shows the last one it took.
  const [placed, setPlaced] = useState<{ latitude: number; longitude: number } | null>(null);
  const setLocation = (point: { latitude: number; longitude: number }) => {
    void actions.act(() => window.ade.androidEmulator.setLocation({ laneId, ...point }, pinRef.current))
      .then((accepted) => { if (accepted) setPlaced(point); });
  };
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
      <DeviceLocationRows tool="android" disabled={disabled} current={placed} onSet={setLocation} />

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
