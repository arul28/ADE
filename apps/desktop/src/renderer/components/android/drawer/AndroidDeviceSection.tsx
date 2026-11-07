import {
  ANDROID_ACCESSIBILITY_LABELS,
  ANDROID_ACCESSIBILITY_OPTIONS,
  ANDROID_DISPLAY_SIZES,
  ANDROID_TEXT_SIZES,
  type AndroidDeviceSetting,
} from "../../../../shared/types/androidEmulator";
import { DRAWER_BUTTON, DRAWER_GHOST_BUTTON, DrawerMenu, Row, Subhead, SwitchRow } from "../../ui/drawerPrimitives";
import type { AndroidDrawerContext } from "./androidDrawerState";

/*
 * The **Device** group: how the screen looks to the app. Text and display
 * size are the two accessibility sizes a person tests against; the three
 * switches are the developer options an Android developer turns on most.
 */

/** Sends one setting through the drawer's serialized `act`. */
export function deviceSettingSetter(ctx: AndroidDrawerContext) {
  const { laneId, pinRef, actions } = ctx;
  return (setting: AndroidDeviceSetting) =>
    actions.actWithSettings(() => window.ade.androidEmulator.setDeviceSetting({ laneId, setting }, pinRef.current));
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

      <Subhead label="Accessibility" />
      {ANDROID_ACCESSIBILITY_OPTIONS.map((option) => {
        const reported = settings?.accessibility?.[option];
        // Null: this image does not have it (TalkBack on most Google APIs images).
        const missing = reported === null;
        return (
          <SwitchRow
            key={option}
            label={missing ? `${ANDROID_ACCESSIBILITY_LABELS[option]} (not on this image)` : ANDROID_ACCESSIBILITY_LABELS[option]}
            checked={reported ?? undefined}
            disabled={disabled || missing || settings?.accessibility === undefined}
            onChange={(on) => { void set({ kind: "accessibility", option, on }); }}
          />
        );
      })}

      <Subhead label="Status bar" />
      <Row label={settings?.statusBarOverridden ? "Overridden" : "Device's own"}>
        <button
          type="button"
          className={DRAWER_BUTTON}
          disabled={disabled}
          onClick={() => {
            // No fields: the service fills in Apple's screenshot status bar
            // (9:41, full Wi-Fi, a full battery that is not charging).
            void ctx.actions.act(() => window.ade.androidEmulator.setStatusBar({ laneId: ctx.laneId }, ctx.pinRef.current));
          }}
        >
          9:41
        </button>
        <button
          type="button"
          // Named for a screen reader: the Location rows have their own Clear.
          aria-label="Clear status bar"
          className={DRAWER_GHOST_BUTTON}
          disabled={disabled || !settings?.statusBarOverridden}
          onClick={() => {
            void ctx.actions.act(() => window.ade.androidEmulator.clearStatusBar({ laneId: ctx.laneId }, ctx.pinRef.current));
          }}
        >
          Clear
        </button>
      </Row>
    </>
  );
}
