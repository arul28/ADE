import type {
  IosSimulatorAccessibilityOption,
  IosSimulatorAppearance,
  IosSimulatorContentSize,
} from "../../../../../shared/types/iosSimulator";
import { cn } from "../../../ui/cn";
import { DrawerMenu, Row, Section, SwitchRow, type DrawerMenuOption } from "../drawerPrimitives";
import type { AppleDrawerContext } from "../drawerContext";

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
 * §8.2 — Appearance, Text size, and the five accessibility switches.
 *
 * "Show Borders" is iOS's Button Shapes flag (`button-shapes`), written to the
 * same accessibility preference domain as the other switches. A switch whose
 * value the device did not report renders disabled, never hidden.
 */
export function SimulatorSection({ ctx }: { ctx: AppleDrawerContext }) {
  const { scope, pinRef, actions } = ctx;
  const settings = actions.settings;
  const disabled = actions.disabled;
  const appearance = settings?.appearance;
  const appearanceKnown = appearance === "light" || appearance === "dark";
  const contentSize = settings?.contentSize;
  const textSize = APPLE_DRAWER_TEXT_SIZES.some((size) => size.value === contentSize)
    ? (contentSize as IosSimulatorContentSize)
    : null;

  const setAppearance = (value: IosSimulatorAppearance) => {
    if (value === appearance) return;
    void actions.act(() => window.ade.iosSimulator.setAppearance({ ...scope, appearance: value }, pinRef.current));
  };

  return (
    <Section title="Simulator" testId="apple-drawer-simulator">
      <Row label="Appearance">
        <div role="group" aria-label="Appearance" className="inline-flex overflow-hidden rounded-[6px] border border-border">
          {(["light", "dark"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={appearance === value}
              disabled={disabled || appearance === "unsupported"}
              onClick={() => setAppearance(value)}
              className={cn(
                "h-6 px-2 text-[11px] font-medium disabled:pointer-events-none disabled:opacity-40",
                appearance === value ? "bg-white/[0.1] text-fg" : "text-muted-fg hover:bg-white/[0.05] hover:text-fg",
                value === "dark" && "border-l border-border",
              )}
            >
              {value === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
      </Row>
      <Row label="Text size">
        <DrawerMenu
          ariaLabel="Text size"
          value={textSize}
          placeholder={contentSize && contentSize !== "unknown" ? contentSize : "Unknown"}
          options={APPLE_DRAWER_TEXT_SIZES}
          disabled={disabled || !appearanceKnown && !settings}
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
    </Section>
  );
}
