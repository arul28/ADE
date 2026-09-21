import React from "react";
import {
  APPLE_REMOTE_BITRATE_KBPS_MAX,
  APPLE_REMOTE_BITRATE_KBPS_MIN,
  warnBytesFromGib,
  warnGibFromBytes,
} from "../../../shared/appleDeviceSettings";
import { useAppStore } from "../../state/appStore";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import {
  SettingsCard,
  SettingsGroup,
  SettingsNumber,
  SettingsToggle,
} from "./primitives";

/**
 * Presentation choices for Apple simulators and previews.
 *
 * Account-scoped, same as the rest of Appearance: they follow the signed-in
 * account rather than this machine, and the hosted web client can set them.
 */
export function AppleDevicesSection() {
  const appleDevice = useAppStore((s) => s.appleDevice);
  const setAppleDevicePreferences = useAppStore((s) => s.setAppleDevicePreferences);

  return (
    <SettingsGroup title="Apple devices">
      <SettingsCard
        anchor="apple-realistic-body"
        title="Realistic body"
        description="Show the real device body in 3D view. Off draws a plain body."
        control={
          <SettingsToggle
            label="Realistic body"
            checked={appleDevice.realisticBody}
            onChange={(realisticBody) => setAppleDevicePreferences({ realisticBody })}
          />
        }
      />

      <SettingsCard
        anchor="apple-tap-rings"
        title="Recording overlays"
        description="Drawn into saved recordings only. The live view stays clean."
        stacked
      >
        <OverlayRow
          id="apple-tap-rings-control"
          label="Tap rings"
          description="A ring where each tap lands."
          checked={appleDevice.recordingTapRings}
          onChange={(recordingTapRings) => setAppleDevicePreferences({ recordingTapRings })}
        />
        <div id="apple-typed-badges" data-settings-anchor="apple-typed-badges">
          <OverlayRow
            id="apple-typed-badges-control"
            label="Typed-text badges"
            description="Show what was typed. Password fields are never shown."
            checked={appleDevice.recordingKeyBadges}
            onChange={(recordingKeyBadges) => setAppleDevicePreferences({ recordingKeyBadges })}
          />
        </div>
      </SettingsCard>

      <SettingsCard
        anchor="apple-remote-bitrate"
        title="Remote viewer bitrate cap"
        description="Applies to the web client, the phone, and a desktop bound to another Mac. A viewer on this machine is never capped."
        control={
          <SettingsNumber
            ariaLabel="Remote viewer bitrate cap"
            value={appleDevice.remoteBitrateKbpsCap}
            min={APPLE_REMOTE_BITRATE_KBPS_MIN}
            max={APPLE_REMOTE_BITRATE_KBPS_MAX}
            suffix="kbit/s"
            onChange={(remoteBitrateKbpsCap) => setAppleDevicePreferences({ remoteBitrateKbpsCap })}
          />
        }
      />

      <SettingsCard
        anchor="apple-recordings-warn"
        title="Recordings storage warning"
        description="Diagnostics warns when Apple recordings pass this size. ADE never deletes them."
        control={
          <SettingsNumber
            ariaLabel="Recordings storage warning"
            value={warnGibFromBytes(appleDevice.recordingsWarnBytes)}
            min={1}
            max={100}
            suffix="GiB"
            onChange={(gib) => setAppleDevicePreferences({
              recordingsWarnBytes: warnBytesFromGib(gib),
            })}
          />
        }
      />
    </SettingsGroup>
  );
}

function OverlayRow({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        padding: "8px 0",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: SANS_FONT, fontSize: 13, fontWeight: 550, color: COLORS.textPrimary }}>
          {label}
        </div>
        <div style={{ marginTop: 2, fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>
          {description}
        </div>
      </div>
      <SettingsToggle id={id} label={label} checked={checked} onChange={onChange} />
    </div>
  );
}
