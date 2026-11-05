import type {
  IosSimulatorAccessibilityOption,
  IosSimulatorAppearance,
  IosSimulatorContentSize,
} from "../../../../../shared/types/iosSimulator";
import {
  DRAWER_BUTTON,
  DRAWER_GHOST_BUTTON,
  DrawerMenu,
  DrawerSegmented,
  Row,
  Subhead,
  SwitchRow,
  type DrawerMenuOption,
} from "../../../ui/drawerPrimitives";
import type { AppleDrawerContext } from "../drawerContext";
import { DeviceLocationRows } from "../../../device/DeviceLocationRows";

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
      <DeviceLocationRows
        tool="apple"
        disabled={disabled}
        current={current}
        onSet={({ latitude, longitude }) => {
          void actions.act(() => window.ade.iosSimulator.setLocation({ ...scope, latitude, longitude }, pinRef.current));
        }}
        onClear={() => { void actions.act(() => window.ade.iosSimulator.clearLocation({ ...scope }, pinRef.current)); }}
      />

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
