import React, { useId } from "react";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";

/**
 * The settings control vocabulary. Before this file, ADE shipped four separate
 * toggle implementations (one in `settingsSectionUi.tsx`, a local one inside
 * `LaneBehaviorSection`, raw checkboxes, and ad-hoc segmented buttons), so two
 * adjacent rows could disagree about what "on" looks like.
 *
 * Every control here is uncontrolled-free and instant: there is no draft state
 * and no Save button anywhere in settings. `onChange` persists immediately and
 * the caller shows a `SavedFlash`.
 */

export function SettingsToggle({
  checked,
  onChange,
  id,
  disabled = false,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  id?: string;
  disabled?: boolean;
  /** Accessible name when the control isn't adjacent to a visible label. */
  label?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        position: "relative",
        width: 36,
        height: 20,
        borderRadius: 10,
        border: "none",
        background: checked ? COLORS.accent : COLORS.outlineBorder,
        cursor: disabled ? "not-allowed" : "pointer",
        padding: 0,
        flexShrink: 0,
        opacity: disabled ? 0.5 : 1,
        transition: "background 150ms ease",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: checked ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: 8,
          background: checked ? "var(--color-bg)" : COLORS.textMuted,
          transition: "left 150ms ease",
        }}
      />
    </button>
  );
}

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  /** Optional second line — keep it to a few words or the control gets tall. */
  hint?: string;
};

export function SettingsSegmented<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
}: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const hasHints = options.some((option) => !!option.hint);
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      style={{
        display: "inline-flex",
        padding: 2,
        gap: 2,
        background: COLORS.recessedBg,
        border: `1px solid ${COLORS.borderMuted}`,
        borderRadius: 9,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => { if (!active) onChange(option.value); }}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              justifyContent: "center",
              gap: 1,
              minHeight: hasHints ? 40 : 26,
              padding: hasHints ? "5px 12px" : "0 12px",
              fontFamily: SANS_FONT,
              fontSize: 12,
              fontWeight: active ? 600 : 500,
              color: active ? COLORS.textPrimary : COLORS.textMuted,
              background: active ? "color-mix(in srgb, var(--color-accent) 16%, transparent)" : "transparent",
              border: active
                ? "1px solid color-mix(in srgb, var(--color-accent) 40%, transparent)"
                : "1px solid transparent",
              borderRadius: 7,
              cursor: disabled ? "not-allowed" : "pointer",
              transition: "background 120ms ease, color 120ms ease",
              whiteSpace: "nowrap",
            }}
          >
            <span>{option.label}</span>
            {option.hint ? (
              <span style={{ fontSize: 10, fontWeight: 400, color: COLORS.textDim }}>{option.hint}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A number field that always shows its real value.
 *
 * Storage's rule inputs used to render an empty box with a placeholder ("No
 * limit", "Never", "Disabled"), so an unset value and a value you couldn't
 * read looked the same. Here the sentinel is rendered as text beside the
 * field, and clearing the field means "use the sentinel".
 */
export function SettingsNumber({
  value,
  onChange,
  id,
  min = 0,
  max,
  step = 1,
  suffix,
  /** Shown when the value equals `sentinelValue` — e.g. "No limit". */
  sentinelLabel,
  sentinelValue = 0,
  disabled = false,
  ariaLabel,
}: {
  value: number;
  onChange: (value: number) => void;
  id?: string;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  sentinelLabel?: string;
  sentinelValue?: number;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const atSentinel = sentinelLabel != null && value === sentinelValue;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        aria-label={ariaLabel}
        value={String(value)}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => {
          const raw = event.target.value.trim();
          if (raw === "") {
            onChange(sentinelValue);
            return;
          }
          const next = Number(raw);
          if (!Number.isFinite(next)) return;
          const clampedLow = Math.max(min, next);
          onChange(max == null ? clampedLow : Math.min(max, clampedLow));
        }}
        style={{
          width: 72,
          height: 30,
          padding: "0 8px",
          fontFamily: SANS_FONT,
          fontSize: 12,
          color: COLORS.textPrimary,
          background: COLORS.recessedBg,
          border: `1px solid ${COLORS.outlineBorder}`,
          borderRadius: 8,
          textAlign: "right",
        }}
      />
      {atSentinel ? (
        <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim }}>{sentinelLabel}</span>
      ) : suffix ? (
        <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>{suffix}</span>
      ) : null}
    </span>
  );
}

export function SettingsSelect<T extends string>({
  value,
  options,
  onChange,
  id,
  disabled = false,
  ariaLabel,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  id?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as T)}
      style={{
        height: 30,
        minWidth: 128,
        padding: "0 8px",
        fontFamily: SANS_FONT,
        fontSize: 12,
        color: COLORS.textPrimary,
        background: COLORS.recessedBg,
        border: `1px solid ${COLORS.outlineBorder}`,
        borderRadius: 8,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );
}

export function SettingsSlider({
  value,
  onChange,
  min,
  max,
  step = 1,
  id,
  ariaLabel,
  valueLabel,
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  id?: string;
  ariaLabel?: string;
  valueLabel?: string;
}) {
  const fallbackId = useId();
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10, minWidth: 200 }}>
      <input
        id={id ?? fallbackId}
        type="range"
        aria-label={ariaLabel}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ flex: 1, accentColor: "var(--color-accent)" }}
      />
      {valueLabel ? (
        <span
          style={{
            fontFamily: SANS_FONT,
            fontSize: 11,
            color: COLORS.textMuted,
            minWidth: 38,
            textAlign: "right",
          }}
        >
          {valueLabel}
        </span>
      ) : null}
    </span>
  );
}
