/**
 * Segmented control for the usage surfaces.
 *
 * `settings/primitives/SettingsControls.tsx` exports a `SettingsSegmented` with
 * the same signature, but its body is inline-styled against the `COLORS` object
 * — the styling split this redesign removed. Rather than drag that back onto the
 * Usage page, the control lives here in theme classes.
 *
 * The *look* is deliberately borrowed from it, though: the same accent-tinted
 * fill and accent border on the chosen segment, on the same recessed track. An
 * earlier pass used `bg-muted` for the active segment, which on the dark theme
 * is a two-step lightness change — you genuinely could not tell what was
 * selected. Selection is not the place to invent a new vocabulary.
 */
import { cn } from "../ui/cn";
import {
  USAGE_SEGMENT_ITEM_ACTIVE_CLASS,
  USAGE_SEGMENT_ITEM_CLASS,
  USAGE_SEGMENT_ITEM_IDLE_CLASS,
  USAGE_SEGMENT_TRACK_CLASS,
  USAGE_TEXT,
} from "./usageDesign";

export function UsageSegmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className={USAGE_SEGMENT_TRACK_CLASS}>
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              USAGE_TEXT.micro,
              USAGE_SEGMENT_ITEM_CLASS,
              active ? USAGE_SEGMENT_ITEM_ACTIVE_CLASS : USAGE_SEGMENT_ITEM_IDLE_CLASS,
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
