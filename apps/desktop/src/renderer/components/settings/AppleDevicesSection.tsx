import { useEffect, useRef, useState } from "react";
import {
  APPLE_RECORDINGS_WARN_GIB_MAX,
  APPLE_RECORDINGS_WARN_GIB_MIN,
  APPLE_REMOTE_BITRATE_KBPS_MAX,
  APPLE_REMOTE_BITRATE_KBPS_MIN,
  warnBytesFromGib,
  warnGibFromBytes,
} from "../../../shared/appleDeviceSettings";
import { useAppStore } from "../../state/appStore";
import { readAppleRecordingsTotalBytes } from "./appleRecordingsFootprint";
import { useThisComputerCopyPin } from "./ProjectCopyScope";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import {
  BitrateControl,
  FeatureCard,
  KeyBadgesArt,
  OverlayCard,
  PhoneArt,
  StorageMeter,
  TapRingsArt,
} from "./deviceSettingsCards";
import { ModernSection } from "./primitives";

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
 * project's recordings use against the warning size. The blocks are shared
 * with Settings › Android devices (`deviceSettingsCards.tsx`).
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
        <FeatureCard
          on={appleDevice.realisticBody}
          art={<PhoneArt realistic={appleDevice.realisticBody} />}
          title="Realistic body"
          hint="Show the real device body in 3D view. Off draws the bare screen."
          toggleLabel="Realistic body"
          onChange={(realisticBody) => setAppleDevicePreferences({ realisticBody })}
        />
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
        group="Automatic recording"
        anchor="apple-auto-record"
        title="Record agent input"
        hint="An agent's taps and typing start a recording that is filed as proof when it stops."
      >
        <FeatureCard
          on={appleDevice.autoRecordAgentInput}
          title="Record agent input"
          hint={
            <>
              Off: agents record only when they ask (record-start). One lane can turn it off with ade apple auto-record off,
              one command with --no-record. Your own input never starts a recording.
            </>
          }
          toggleLabel="Record agent input"
          onChange={(autoRecordAgentInput) => setAppleDevicePreferences({ autoRecordAgentInput })}
        />
      </ModernSection>

      <ModernSection
        group="Remote streaming"
        anchor="apple-remote-bitrate"
        title="Remote viewer bitrate cap"
        hint="For the web client, the phone, and other Macs. Viewers on this Mac are never capped."
      >
        <BitrateControl
          value={appleDevice.remoteBitrateKbpsCap}
          min={APPLE_REMOTE_BITRATE_KBPS_MIN}
          max={APPLE_REMOTE_BITRATE_KBPS_MAX}
          onChange={(remoteBitrateKbpsCap) => setAppleDevicePreferences({ remoteBitrateKbpsCap })}
        />
      </ModernSection>

      <ModernSection
        group="Recordings storage"
        anchor="apple-recordings-warn"
        title="Recordings storage warning"
        hint="Diagnostics warns past this size. ADE never deletes recordings."
      >
        <AppleStorageControl
          warnBytes={appleDevice.recordingsWarnBytes}
          onChangeGib={(gib) => setAppleDevicePreferences({ recordingsWarnBytes: warnBytesFromGib(gib) })}
        />
      </ModernSection>
    </div>
  );
}

function AppleStorageControl({ warnBytes, onChangeGib }: { warnBytes: number; onChangeGib: (gib: number) => void }) {
  const projectRoot = useAppStore((s) => s.project?.rootPath ?? null);
  const [usedBytes, setUsedBytes] = useState<number | null>(null);
  // The page machine's copy, else this computer's copy.
  const machinePin = useSettingsMachineScope().pin;
  const thisComputerCopyPin = useThisComputerCopyPin();
  const pin = machinePin ?? thisComputerCopyPin;
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;

  useEffect(() => {
    let cancelled = false;
    if (!projectRoot) {
      setUsedBytes(null);
      return;
    }
    void readAppleRecordingsTotalBytes(projectRoot, pinRef.current).then((bytes) => {
      if (!cancelled) setUsedBytes(bytes);
    });
    return () => {
      cancelled = true;
    };
  }, [projectRoot, pinKey]);

  return (
    <StorageMeter
      usedBytes={usedBytes}
      warnBytes={warnBytes}
      warnGib={warnGibFromBytes(warnBytes)}
      minGib={APPLE_RECORDINGS_WARN_GIB_MIN}
      maxGib={APPLE_RECORDINGS_WARN_GIB_MAX}
      onChangeGib={onChangeGib}
      meterLabel="Apple recordings against the warning size"
      emptyText="Open a project to see its recordings."
    />
  );
}
