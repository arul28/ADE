import type {
  AndroidDeviceSetting,
  AndroidDisplaySize,
  AndroidTextSize,
} from "../../../../shared/types/androidEmulator";
import { DrawerMenu, Row, Subhead, SwitchRow, type DrawerMenuOption } from "../../ui/drawerPrimitives";
import type { AndroidDrawerContext } from "./androidDrawerState";

/*
 * The **Device** group: how the screen looks to the app. Text and display
 * size are the two accessibility sizes a person tests against; the three
 * switches are the developer options an Android developer turns on most.
 */

export const ANDROID_TEXT_SIZES: readonly DrawerMenuOption<AndroidTextSize>[] = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
  { value: "largest", label: "Largest" },
];

export const ANDROID_DISPLAY_SIZES: readonly DrawerMenuOption<AndroidDisplaySize>[] = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
  { value: "larger", label: "Larger" },
];

/** Sends one setting through the drawer's serialized `act`. */
export function deviceSettingSetter(ctx: AndroidDrawerContext) {
  const { laneId, pinRef, actions } = ctx;
  return (setting: AndroidDeviceSetting) =>
    actions.act(() => window.ade.androidEmulator.setDeviceSetting({ laneId, setting }, pinRef.current));
}

export function AndroidDeviceSection({ ctx }: { ctx: AndroidDrawerContext }) {
  const settings = ctx.actions.settings;
  const disabled = ctx.actions.disabled;
  const set = deviceSettingSetter(ctx);
  const fontScale = settings?.fontScale;
  const density = settings?.density;

  return (
    <>
      <Row label="Text size">
        <DrawerMenu
          ariaLabel="Text size"
          value={settings?.textSize ?? null}
          placeholder={fontScale != null ? `${fontScale}×` : "Unknown"}
          options={ANDROID_TEXT_SIZES}
          disabled={disabled}
          onChange={(value) => { void set({ kind: "text-size", value }); }}
        />
      </Row>
      <Row label="Display size">
        <DrawerMenu
          ariaLabel="Display size"
          value={settings?.displaySize ?? null}
          placeholder={density?.override ? `${density.override} dpi` : "Unknown"}
          options={ANDROID_DISPLAY_SIZES}
          disabled={disabled || !density?.physical}
          onChange={(value) => { void set({ kind: "display-size", value }); }}
        />
      </Row>
      <Subhead label="Developer options" />
      <SwitchRow
        label="Animations off"
        checked={settings?.animationsOff ?? undefined}
        disabled={disabled}
        onChange={(off) => { void set({ kind: "animations", off }); }}
      />
      <SwitchRow
        label="Show taps"
        checked={settings?.showTaps ?? undefined}
        disabled={disabled}
        onChange={(on) => { void set({ kind: "show-taps", on }); }}
      />
      <SwitchRow
        label="Show layout bounds"
        checked={settings?.layoutBounds ?? undefined}
        disabled={disabled}
        onChange={(on) => { void set({ kind: "layout-bounds", on }); }}
      />
    </>
  );
}
