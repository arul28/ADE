import React from "react";
import { DeviceMobile, HandTap, Keyboard, WifiHigh, HardDrives } from "@phosphor-icons/react";
import {
  APPLE_REMOTE_BITRATE_KBPS_MAX,
  APPLE_REMOTE_BITRATE_KBPS_MIN,
  warnBytesFromGib,
  warnGibFromBytes,
} from "../../../shared/appleDeviceSettings";
import { useAppStore } from "../../state/appStore";
import {
  SettingsNumber,
  SettingsPanel,
  SettingsRow,
  SettingsSection,
  SettingsToggle,
} from "./primitives";

/**
 * Presentation choices for Apple simulators and previews.
 *
 * Titled "Apple Development" because that is the tool's one name (round 3
 * §B1) — the card, the tab, the palette, the docs and the CLI all say it.
 *
 * Account-scoped: they follow the signed-in account, and the hosted web client
 * can set them. Unlike Appearance they are not per computer, because the host
 * reads the remote streaming cap from the account store.
 */
export function AppleDevicesSection() {
  const appleDevice = useAppStore((s) => s.appleDevice);
  const setAppleDevicePreferences = useAppStore((s) => s.setAppleDevicePreferences);

  return (
    <SettingsSection title="Apple Development">
      <SettingsPanel>
        <SettingsRow
          anchor="apple-realistic-body"
          icon={<DeviceMobile size={15} weight="duotone" />}
          tone="slate"
          title="Realistic body"
          description="Show the real device body in 3D view."
          control={
            <SettingsToggle
              label="Realistic body"
              checked={appleDevice.realisticBody}
              onChange={(realisticBody) => setAppleDevicePreferences({ realisticBody })}
            />
          }
        />
        <SettingsRow
          anchor="apple-tap-rings"
          icon={<HandTap size={15} weight="duotone" />}
          tone="pink"
          title="Tap rings"
          description="Drawn where each tap lands, in saved recordings only."
          control={
            <SettingsToggle
              id="apple-tap-rings-control"
              label="Tap rings"
              checked={appleDevice.recordingTapRings}
              onChange={(recordingTapRings) => setAppleDevicePreferences({ recordingTapRings })}
            />
          }
        />
        <SettingsRow
          anchor="apple-typed-badges"
          icon={<Keyboard size={15} weight="duotone" />}
          tone="violet"
          title="Typed-text badges"
          description="Show typed text in saved recordings. Never for password fields."
          control={
            <SettingsToggle
              id="apple-typed-badges-control"
              label="Typed-text badges"
              checked={appleDevice.recordingKeyBadges}
              onChange={(recordingKeyBadges) => setAppleDevicePreferences({ recordingKeyBadges })}
            />
          }
        />
        <SettingsRow
          anchor="apple-remote-bitrate"
          icon={<WifiHigh size={15} weight="duotone" />}
          tone="blue"
          title="Remote viewer bitrate cap"
          description="For the web client, the phone, and other Macs. Viewers on this Mac are never capped."
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
        <SettingsRow
          anchor="apple-recordings-warn"
          icon={<HardDrives size={15} weight="duotone" />}
          tone="amber"
          title="Recordings storage warning"
          description="Diagnostics warns past this size. ADE never deletes recordings."
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
      </SettingsPanel>
    </SettingsSection>
  );
}
