import React from "react";
import { WarningCircle } from "@phosphor-icons/react";
import { formatBytes } from "../../lib/format";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { SettingsCard, SettingsNumber, SettingsToggle } from "./primitives";
import "./AppleDevicesSection.css";

/*
 * The visual blocks Settings › Apple devices and Settings › Android devices
 * share (the `ade-as-*` card language): the feature card with a drawing, the
 * overlay cards, the bitrate quality strip, the storage meter and the
 * Diagnostics recordings warning. They only
 * present: each page owns where its values live and how they are written.
 */

/* ── Feature card (a drawing, a title and hint, a switch) ────────────── */

export function FeatureCard({
  on,
  art,
  title,
  hint,
  toggleLabel,
  onChange,
  disabled,
}: {
  on: boolean;
  art?: React.ReactNode;
  title: string;
  hint: React.ReactNode;
  toggleLabel: string;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="ade-as-feature" data-on={on} data-art={art ? "true" : undefined}>
      {art ? <div className="ade-as-feature-art" aria-hidden>{art}</div> : null}
      <div className="ade-as-feature-text">
        <div className="ade-ap-rowtitle">{title}</div>
        <div className="ade-ap-rowhint">{hint}</div>
      </div>
      <SettingsToggle label={toggleLabel} checked={on} disabled={disabled} onChange={onChange} />
    </div>
  );
}

/* ── Device frame drawings ──────────────────────────────────────────── */

/** An iPhone: rounded body, Dynamic Island, buttons on both sides. */
export function PhoneArt({ realistic }: { realistic: boolean }) {
  return (
    <div className="ade-as-phone" data-realistic={realistic}>
      <div className="ade-as-phone-screen">
        <span className="ade-as-phone-island" />
        <span className="ade-as-line" style={{ width: "62%" }} />
        <span className="ade-as-line" style={{ width: "44%" }} />
        <span className="ade-as-phone-tile" />
        <span className="ade-as-phone-tile" style={{ opacity: 0.6 }} />
      </div>
    </div>
  );
}

/** An Android phone: squarer corners, a punch-hole camera, power and volume on the right edge. */
export function AndroidPhoneArt({ realistic }: { realistic: boolean }) {
  return (
    <div className="ade-as-phone" data-platform="android" data-realistic={realistic}>
      <div className="ade-as-phone-screen">
        <span className="ade-as-phone-punch" />
        <span className="ade-as-line" style={{ width: "58%" }} />
        <span className="ade-as-line" style={{ width: "40%" }} />
        <span className="ade-as-phone-tile" />
        <span className="ade-as-phone-tile" style={{ opacity: 0.6 }} />
        <span className="ade-as-phone-navbar" />
      </div>
    </div>
  );
}

/* ── Recording overlays ─────────────────────────────────────────────── */

export function OverlayCard({
  anchor,
  toggleId,
  title,
  hint,
  checked,
  onChange,
  art,
  disabled,
}: {
  anchor: string;
  toggleId: string;
  title: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  art: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className="ade-as-card" id={anchor} data-settings-anchor={anchor} data-on={checked}>
      <div className="ade-as-card-art" aria-hidden>
        <div className="ade-as-screen">{art}</div>
      </div>
      <div className="ade-as-card-foot">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="ade-ap-rowtitle">{title}</div>
          <div className="ade-ap-rowhint">{hint}</div>
        </div>
        <SettingsToggle id={toggleId} label={title} checked={checked} disabled={disabled} onChange={onChange} />
      </div>
    </div>
  );
}

export function TapRingsArt() {
  return (
    <>
      <span className="ade-as-line" style={{ width: "50%" }} />
      <span className="ade-as-line" style={{ width: "34%" }} />
      <span className="ade-as-button">
        Continue
        <span className="ade-as-overlay ade-as-tap" />
      </span>
    </>
  );
}

export function KeyBadgesArt() {
  return (
    <>
      <span className="ade-as-field">hello@ade.dev</span>
      <span className="ade-as-field ade-as-field-secret">••••••••</span>
      <span className="ade-as-overlay ade-as-badge">hello@ade.dev</span>
    </>
  );
}

/* ── Remote streaming ───────────────────────────────────────────────── */

const BITRATE_PRESETS: { label: string; kbps: number; bars: number }[] = [
  { label: "Light", kbps: 800, bars: 1 },
  { label: "Balanced", kbps: 2500, bars: 2 },
  { label: "Sharp", kbps: 6000, bars: 3 },
  { label: "Max", kbps: 12000, bars: 4 },
];

/** Megabytes a viewer pulls per minute at a given cap. */
function mbPerMinute(kbps: number): string {
  const mb = (kbps * 60) / 8 / 1000;
  return mb >= 10 ? Math.round(mb).toString() : mb.toFixed(1);
}

export function BitrateControl({
  value,
  onChange,
  min,
  max,
  commitOnBlur,
  disabled,
}: {
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  /** Write once on blur or Enter, not per keystroke (a write that goes to a runtime). */
  commitOnBlur?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="ade-as-panel">
      <div className="ade-as-panel-head">
        <div style={{ minWidth: 0 }}>
          <div className="ade-as-stat">
            <span className="kit-stat">{value.toLocaleString()}</span>
            <span className="kit-eyebrow">kbit/s</span>
          </div>
          <div className="ade-ap-rowhint">
            About <span className="kit-num">{mbPerMinute(value)}</span> MB a minute per remote viewer.
          </div>
        </div>
        <SettingsNumber
          ariaLabel="Remote viewer bitrate cap"
          value={value}
          min={min}
          max={max}
          step={100}
          suffix="kbit/s"
          commitOnBlur={commitOnBlur}
          disabled={disabled}
          onChange={onChange}
        />
      </div>
      <div className="ade-as-presets" role="radiogroup" aria-label="Remote viewer quality">
        {BITRATE_PRESETS.map((preset) => {
          const active = preset.kbps === value;
          return (
            <button
              key={preset.kbps}
              type="button"
              role="radio"
              aria-checked={active}
              className="ade-as-preset"
              data-active={active}
              disabled={disabled}
              onClick={() => onChange(preset.kbps)}
            >
              <span className="ade-as-bars" aria-hidden>
                {[1, 2, 3, 4].map((bar) => (
                  <i key={bar} data-on={bar <= preset.bars} style={{ height: 3 + bar * 2.5 }} />
                ))}
              </span>
              <span className="ade-as-preset-label">{preset.label}</span>
              <span className="kit-num ade-as-preset-kbps">{preset.kbps.toLocaleString()}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── Recordings storage ─────────────────────────────────────────────── */

export function StorageMeter({
  usedBytes,
  warnBytes,
  warnGib,
  minGib,
  maxGib,
  onChangeGib,
  meterLabel,
  eyebrow = "This project",
  emptyText,
  commitOnBlur,
  disabled,
}: {
  /** Null when the size is not known (no project, or the machine cannot count it). */
  usedBytes: number | null;
  warnBytes: number;
  warnGib: number;
  minGib: number;
  maxGib: number;
  onChangeGib: (gib: number) => void;
  meterLabel: string;
  eyebrow?: string;
  emptyText: string;
  commitOnBlur?: boolean;
  disabled?: boolean;
}) {
  const ratio = usedBytes != null && warnBytes > 0 ? usedBytes / warnBytes : 0;
  const level = ratio >= 1 ? "crit" : ratio >= 0.8 ? "warn" : undefined;
  return (
    <div className="ade-as-panel">
      <div className="ade-as-panel-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="ade-as-storage-line">
            <span className="kit-eyebrow">{eyebrow}</span>
            {usedBytes != null ? (
              <span className="ade-as-storage-num">
                <span className="kit-num" style={{ color: "var(--color-fg)" }}>{formatBytes(usedBytes)}</span>
                <span className="kit-num"> / {formatBytes(warnBytes)}</span>
              </span>
            ) : (
              <span className="ade-ap-rowhint" style={{ marginTop: 0 }}>{emptyText}</span>
            )}
            {level === "crit" ? <span className="kit-tag" data-tone="warn">Over</span> : null}
          </div>
          <div
            className="kit-meter ade-as-meter"
            data-level={level}
            role="meter"
            aria-label={meterLabel}
            aria-valuemin={0}
            aria-valuemax={warnBytes}
            aria-valuenow={usedBytes ?? 0}
          >
            <span style={{ width: `${Math.min(100, Math.max(usedBytes ? 1 : 0, ratio * 100))}%` }} />
          </div>
        </div>
        <SettingsNumber
          ariaLabel="Recordings storage warning"
          value={warnGib}
          min={minGib}
          max={maxGib}
          suffix="GiB"
          commitOnBlur={commitOnBlur}
          disabled={disabled}
          onChange={onChangeGib}
        />
      </div>
    </div>
  );
}

/* ── Recordings warning (Diagnostics) ────────────────────────────────── */

/**
 * The read-only Diagnostics row for recordings over the warning size. It
 * renders nothing while the total is at or under the size, or the size is 0.
 * No delete action: ADE never deletes recordings.
 */
export function RecordingsWarningCard({
  anchor,
  title,
  totalBytes,
  warnBytes,
}: {
  anchor: string;
  title: string;
  totalBytes: number;
  warnBytes: number;
}) {
  if (warnBytes <= 0 || !(totalBytes > warnBytes)) return null;
  return (
    <SettingsCard
      anchor={anchor}
      title={title}
      description={`Using ${formatBytes(totalBytes)}, over the ${formatBytes(warnBytes)} warning size. ADE does not delete recordings.`}
      control={
        <span
          role="status"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontFamily: SANS_FONT,
            fontSize: 12,
            fontWeight: 600,
            color: COLORS.warning,
          }}
        >
          <WarningCircle size={14} weight="fill" />
          {formatBytes(totalBytes)}
        </span>
      }
    />
  );
}
