import { cn } from "../../ui/cn";
import { inputCls } from "../designTokens";

/** Whole minutes, or undefined for an empty / non-positive entry. */
function parseMinutes(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = Math.floor(Number(trimmed));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** A compact minutes field: empty means "use the placeholder meaning". */
export function MinutesInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  max,
}: {
  value: number | undefined;
  onChange: (next: number | undefined) => void;
  placeholder: string;
  ariaLabel: string;
  max?: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        min={1}
        max={max}
        step={1}
        inputMode="numeric"
        aria-label={ariaLabel}
        className={cn(inputCls, "w-24 tabular-nums")}
        value={value != null ? String(value) : ""}
        onChange={(e) => {
          const next = parseMinutes(e.target.value);
          onChange(next != null && max != null ? Math.min(max, next) : next);
        }}
        placeholder={placeholder}
      />
      <span className="text-[11px] text-muted-fg/70">min</span>
    </div>
  );
}
