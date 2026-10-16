/**
 * Segmented control for the usage surfaces, drawn with the surface kit's
 * `.kit-seg` so the Usage page, the top-bar popover and the welcome screen all
 * share one control.
 *
 * Radio semantics (`radiogroup` / `radio` / `aria-checked`) are the default:
 * these pick one of a set — a scope, a range, a metric — which is what a radio
 * group is, and it is the vocabulary `SettingsSegmented` already speaks, so
 * assistive tech hears the same thing on every settings page.
 *
 * `labelCase="mono"` is the devl-style uppercase mono toggle used for short
 * tokens (7d, 30d, All); `"sentence"` keeps words such as "This machine"
 * readable.
 */
import { cn } from "../ui/cn";

export function UsageSegmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  labelCase = "mono",
  className,
}: {
  options: ReadonlyArray<{ value: T; label: string; title?: string }>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  labelCase?: "mono" | "sentence";
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn("kit-seg", className)}
      data-case={labelCase === "sentence" ? "sentence" : undefined}
    >
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.title}
            onClick={() => {
              if (!active) onChange(option.value);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
