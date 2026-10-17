import React, { useEffect, useState } from "react";
import {
  APPLE_RECORDINGS_WARN_GIB_MAX,
  APPLE_RECORDINGS_WARN_GIB_MIN,
  APPLE_REMOTE_BITRATE_KBPS_MAX,
  APPLE_REMOTE_BITRATE_KBPS_MIN,
  warnBytesFromGib,
  warnGibFromBytes,
} from "../../../shared/appleDeviceSettings";
import { useAppStore } from "../../state/appStore";
import { formatBytes } from "../../lib/format";
import { readAppleRecordingsTotalBytes } from "./appleRecordingsFootprint";
import { ModernSection, SettingsNumber, SettingsToggle } from "./primitives";
import "./AppleDevicesSection.css";

/**
 * Presentation choices for Apple simulators and previews.
 *
 * Titled "Apple Development" because that is the tool's one name (round 3
 * §B1) — the card, the tab, the palette, the docs and the CLI all say it.
 *
 * Drawn in the Settings › Appearance language: each choice is a short heading
 * over a visual block. The device frame and both recording overlays are cards
 * whose little drawing follows the switch; the streaming cap is a quality strip
 * with the exact kbit/s beside it; the storage warning is a meter of what this
 * project's recordings use against the warning size.
 *
 * The page only presents. It reads and writes through `appleDevice` /
 * `setAppleDevicePreferences`, so where those values live is the store's call.
 */
export function AppleDevicesSection() {
  const appleDevice = useAppStore((s) => s.appleDevice);
  const setAppleDevicePreferences = useAppStore((s) => s.setAppleDevicePreferences);

  return (
    <div className="ade-as">
      <ModernSection
        group="Apple Development"
        anchor="apple-realistic-body"
        title="Apple Development"
        hint="How simulators and previews look in the Apple column."
      >
        <div className="ade-as-feature" data-on={appleDevice.realisticBody}>
          <div className="ade-as-feature-art" aria-hidden>
            <PhoneArt realistic={appleDevice.realisticBody} />
          </div>
          <div className="ade-as-feature-text">
            <div className="ade-ap-rowtitle">Realistic body</div>
            <div className="ade-ap-rowhint">
              Show the real device body in 3D view. Off draws the bare screen.
            </div>
          </div>
          <SettingsToggle
            label="Realistic body"
            checked={appleDevice.realisticBody}
            onChange={(realisticBody) => setAppleDevicePreferences({ realisticBody })}
          />
        </div>
      </ModernSection>

      <ModernSection
        group="Recording overlays"
        title="Recording overlays"
        hint="Drawn into saved recordings only. The live view stays clean."
      >
        <div className="ade-as-grid2">
          <OverlayCard
            anchor="apple-tap-rings"
            toggleId="apple-tap-rings-control"
            title="Tap rings"
            hint="A ring where each tap lands."
            checked={appleDevice.recordingTapRings}
            onChange={(recordingTapRings) => setAppleDevicePreferences({ recordingTapRings })}
            art={<TapRingsArt />}
          />
          <OverlayCard
            anchor="apple-typed-badges"
            toggleId="apple-typed-badges-control"
            title="Typed-text badges"
            hint="What was typed. Never for password fields."
            checked={appleDevice.recordingKeyBadges}
            onChange={(recordingKeyBadges) => setAppleDevicePreferences({ recordingKeyBadges })}
            art={<KeyBadgesArt />}
          />
        </div>
      </ModernSection>

      <ModernSection
        group="Remote streaming"
        anchor="apple-remote-bitrate"
        title="Remote viewer bitrate cap"
        hint="For the web client, the phone, and other Macs. Viewers on this Mac are never capped."
      >
        <BitrateControl
          value={appleDevice.remoteBitrateKbpsCap}
          onChange={(remoteBitrateKbpsCap) => setAppleDevicePreferences({ remoteBitrateKbpsCap })}
        />
      </ModernSection>

      <ModernSection
        group="Recordings storage"
        anchor="apple-recordings-warn"
        title="Recordings storage warning"
        hint="Diagnostics warns past this size. ADE never deletes recordings."
      >
        <StorageControl
          warnBytes={appleDevice.recordingsWarnBytes}
          onChangeGib={(gib) => setAppleDevicePreferences({ recordingsWarnBytes: warnBytesFromGib(gib) })}
        />
      </ModernSection>
    </div>
  );
}

/* ── Device frame ───────────────────────────────────────────────────── */

function PhoneArt({ realistic }: { realistic: boolean }) {
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

/* ── Recording overlays ─────────────────────────────────────────────── */

function OverlayCard({
  anchor,
  toggleId,
  title,
  hint,
  checked,
  onChange,
  art,
}: {
  anchor: string;
  toggleId: string;
  title: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  art: React.ReactNode;
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
        <SettingsToggle id={toggleId} label={title} checked={checked} onChange={onChange} />
      </div>
    </div>
  );
}

function TapRingsArt() {
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

function KeyBadgesArt() {
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

function BitrateControl({ value, onChange }: { value: number; onChange: (next: number) => void }) {
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
          min={APPLE_REMOTE_BITRATE_KBPS_MIN}
          max={APPLE_REMOTE_BITRATE_KBPS_MAX}
          step={100}
          suffix="kbit/s"
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

function StorageControl({ warnBytes, onChangeGib }: { warnBytes: number; onChangeGib: (gib: number) => void }) {
  const projectRoot = useAppStore((s) => s.project?.rootPath ?? null);
  const [usedBytes, setUsedBytes] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!projectRoot) {
      setUsedBytes(null);
      return;
    }
    void readAppleRecordingsTotalBytes(projectRoot).then((bytes) => {
      if (!cancelled) setUsedBytes(bytes);
    });
    return () => {
      cancelled = true;
    };
  }, [projectRoot]);

  const ratio = usedBytes != null && warnBytes > 0 ? usedBytes / warnBytes : 0;
  const level = ratio >= 1 ? "crit" : ratio >= 0.8 ? "warn" : undefined;

  return (
    <div className="ade-as-panel">
      <div className="ade-as-panel-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="ade-as-storage-line">
            <span className="kit-eyebrow">This project</span>
            {usedBytes != null ? (
              <span className="ade-as-storage-num">
                <span className="kit-num" style={{ color: "var(--color-fg)" }}>{formatBytes(usedBytes)}</span>
                <span className="kit-num"> / {formatBytes(warnBytes)}</span>
              </span>
            ) : (
              <span className="ade-ap-rowhint" style={{ marginTop: 0 }}>Open a project to see its recordings.</span>
            )}
            {level === "crit" ? <span className="kit-tag" data-tone="warn">Over</span> : null}
          </div>
          <div
            className="kit-meter ade-as-meter"
            data-level={level}
            role="meter"
            aria-label="Apple recordings against the warning size"
            aria-valuemin={0}
            aria-valuemax={warnBytes}
            aria-valuenow={usedBytes ?? 0}
          >
            <span style={{ width: `${Math.min(100, Math.max(usedBytes ? 1 : 0, ratio * 100))}%` }} />
          </div>
        </div>
        <SettingsNumber
          ariaLabel="Recordings storage warning"
          value={warnGibFromBytes(warnBytes)}
          min={APPLE_RECORDINGS_WARN_GIB_MIN}
          max={APPLE_RECORDINGS_WARN_GIB_MAX}
          suffix="GiB"
          onChange={onChangeGib}
        />
      </div>
    </div>
  );
}
