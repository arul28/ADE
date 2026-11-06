import { useCallback, useEffect, useRef, useState } from "react";
import { GIB } from "../../../shared/appleDeviceSettings";
import {
  ANDROID_RECORDINGS_WARN_GIB_MAX,
  ANDROID_RECORDINGS_WARN_GIB_MIN,
  ANDROID_REMOTE_BITRATE_KBPS_MAX,
  ANDROID_REMOTE_BITRATE_KBPS_MIN,
  DEFAULT_ANDROID_MACHINE_PREFERENCES,
  type AndroidEmulatorStatus,
} from "../../../shared/types/androidEmulator";
import { useAppStore } from "../../state/appStore";
import { AndroidSetupCard } from "../android/AndroidSetupCard";
import { describeAndroidError, type AndroidErrorDescription } from "../android/androidDeviceState";
import { useAndroidMachinePreferences } from "../android/useAndroidMachinePreferences";
import { Spinner } from "../ui/Spinner";
import { Banner } from "../ui/notice";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import {
  AndroidPhoneArt,
  BitrateControl,
  FeatureCard,
  KeyBadgesArt,
  OverlayCard,
  StorageMeter,
  TapRingsArt,
} from "./deviceSettingsCards";
import { ModernSection } from "./primitives";

/** Whole GiB for the warning field, clamped to the field's range. */
function warnGib(bytes: number): number {
  return Math.max(ANDROID_RECORDINGS_WARN_GIB_MIN, Math.min(ANDROID_RECORDINGS_WARN_GIB_MAX, Math.round(bytes / GIB)));
}

/**
 * Settings › Android devices, in the language of Settings › Apple devices
 * (the shared `ade-as-*` cards in `deviceSettingsCards.tsx`).
 *
 * The page follows `?machine=` like Providers, because almost everything on
 * it belongs to the machine that runs the emulator:
 *
 * - The SDK, its licences and the Android CLI (`getStatus`, the setup card).
 * - The recording overlays, automatic recording, the remote bitrate cap and
 *   the storage warning (`getMachinePreferences` / `setMachinePreferences`).
 *
 * Every one of those calls carries the scope's pin. Only "Realistic body" is
 * this window's own: it is how the Android pane draws a device here, kept per
 * computer like Apple's (`androidDevice` in the app store).
 */
export function AndroidDevicesSection() {
  const scope = useSettingsMachineScope();
  const machineLabel = scope.isThisMachine ? "this computer" : scope.machineName;
  const machine = useAndroidMachinePreferences(scope.pin, {
    machineName: scope.isThisMachine ? null : scope.machineName,
  });
  const androidDevice = useAppStore((s) => s.androidDevice);
  const setAndroidDevicePreferences = useAppStore((s) => s.setAndroidDevicePreferences);

  const prefs = machine.preferences ?? DEFAULT_ANDROID_MACHINE_PREFERENCES;
  // Nothing to write to until the machine answered with its own values.
  const machineDisabled = machine.preferences == null;

  return (
    <div className="ade-as">
      <AndroidSdkSection />

      <ModernSection
        group="Android Development"
        anchor="android-realistic-body"
        title="Android Development"
        hint="How emulators look in the Android pane on this computer."
      >
        <FeatureCard
          on={androidDevice.realisticBody}
          art={<AndroidPhoneArt realistic={androidDevice.realisticBody} />}
          title="Realistic body"
          hint="Show the device body in 3D view. Off draws the bare screen."
          toggleLabel="Realistic body"
          onChange={(realisticBody) => setAndroidDevicePreferences({ realisticBody })}
        />
      </ModernSection>

      {machine.unsupported ? (
        <Banner
          layout="inline"
          model={{
            id: "android-machine-preferences-unsupported",
            tone: "info",
            title: "The settings below are not available in this window",
            detail: "Open Settings in the ADE desktop app to change Android recording and streaming.",
          }}
        />
      ) : machine.error && !machine.preferences ? (
        <Banner
          layout="inline"
          model={{
            id: "android-machine-preferences-error",
            tone: "warning",
            title: `Could not read the Android settings of ${machineLabel}`,
            detail: machine.error.sentence,
            error: machine.error.detail ?? undefined,
            actions: [{ label: "Retry", onClick: machine.refresh }],
          }}
        />
      ) : null}

      <ModernSection
        group="Recording overlays"
        title="Recording overlays"
        hint="Drawn into saved recordings only. The live view stays clean."
      >
        <div className="ade-as-grid2">
          <OverlayCard
            anchor="android-tap-rings"
            toggleId="android-tap-rings-control"
            title="Tap rings"
            hint="A ring where each tap lands."
            checked={prefs.tapRings}
            disabled={machineDisabled}
            onChange={(tapRings) => machine.update({ tapRings })}
            art={<TapRingsArt />}
          />
          <OverlayCard
            anchor="android-typed-badges"
            toggleId="android-typed-badges-control"
            title="Typed-text badges"
            hint="What was typed. Never for password fields."
            checked={prefs.keyBadges}
            disabled={machineDisabled}
            onChange={(keyBadges) => machine.update({ keyBadges })}
            art={<KeyBadgesArt />}
          />
        </div>
      </ModernSection>

      <ModernSection
        group="Automatic recording"
        anchor="android-auto-record"
        title="Record agent input"
        hint="An agent's taps and typing start a recording that is filed as proof when it stops."
      >
        <FeatureCard
          on={prefs.autoRecordAgentInput}
          title="Record agent input"
          hint={
            <>
              Off: agents record only when they ask (record-start). One lane can turn it off with ade android auto-record off,
              one command with --no-record. Your own input never starts a recording.
            </>
          }
          toggleLabel="Record agent input"
          disabled={machineDisabled}
          onChange={(autoRecordAgentInput) => machine.update({ autoRecordAgentInput })}
        />
      </ModernSection>

      <ModernSection
        group="Remote streaming"
        anchor="android-remote-bitrate"
        title="Remote viewer bitrate cap"
        hint={`For the web client, the phone, and other computers. Viewers on ${machineLabel} are never capped.`}
      >
        <BitrateControl
          value={prefs.remoteBitrateKbpsCap}
          min={ANDROID_REMOTE_BITRATE_KBPS_MIN}
          max={ANDROID_REMOTE_BITRATE_KBPS_MAX}
          commitOnBlur
          disabled={machineDisabled}
          onChange={(remoteBitrateKbpsCap) => machine.update({ remoteBitrateKbpsCap })}
        />
      </ModernSection>

      <ModernSection
        group="Recordings storage"
        anchor="android-recordings-warn"
        title="Recordings storage warning"
        hint="Diagnostics warns past this size. ADE never deletes recordings."
      >
        <StorageMeter
          usedBytes={machine.recordingsBytes}
          warnBytes={prefs.recordingsWarnBytes}
          warnGib={warnGib(prefs.recordingsWarnBytes)}
          minGib={ANDROID_RECORDINGS_WARN_GIB_MIN}
          maxGib={ANDROID_RECORDINGS_WARN_GIB_MAX}
          commitOnBlur
          disabled={machineDisabled}
          onChangeGib={(gib) => machine.update({ recordingsWarnBytes: gib * GIB })}
          eyebrow={scope.isThisMachine ? "This project" : `This project on ${scope.machineName}`}
          meterLabel="Android recordings against the warning size"
          emptyText={machine.loading ? "Counting…" : "Open a project to see its recordings."}
        />
      </ModernSection>
    </div>
  );
}

/**
 * The setup card of the Android pane, for the picked machine. The SDK, its
 * licences and the Android CLI belong to one machine, so this can set up a
 * Windows box from a Mac window. Every call carries the scope's pin.
 */
function AndroidSdkSection() {
  const scope = useSettingsMachineScope();
  const pinRef = useRef(scope.pin);
  pinRef.current = scope.pin;
  const pinKey = scope.pin?.key ?? null;
  const api = window.ade?.androidEmulator ?? null;
  const [status, setStatus] = useState<AndroidEmulatorStatus | null>(null);
  const [error, setError] = useState<AndroidErrorDescription | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const readSeq = useRef(0);

  const read = useCallback(async () => {
    if (!api) return;
    const seq = ++readSeq.current;
    setRefreshing(true);
    try {
      const next = await api.getStatus({}, pinRef.current);
      if (seq !== readSeq.current) return;
      setStatus(next);
      setError(null);
    } catch (caught) {
      if (seq === readSeq.current) setError(describeAndroidError(caught));
    } finally {
      if (seq === readSeq.current) setRefreshing(false);
    }
  }, [api]);

  useEffect(() => {
    setStatus(null);
    void read();
  }, [read, pinKey]);

  useEffect(() => {
    if (!api) return;
    return api.onEvent((event) => {
      if (event.type === "android.sdk.changed") void read();
    }, pinRef.current);
  }, [api, pinKey, read]);

  const machineName = scope.isThisMachine ? null : scope.machineName;
  return (
    <ModernSection
      group="Android devices"
      anchor="android-sdk"
      title="Android SDK"
      hint={`What the emulator needs on ${scope.isThisMachine ? "this computer" : scope.machineName}. ADE installs it from Google's SDK repository.`}
    >
      {!api ? (
        <p className="font-sans text-xs text-muted-fg">Android devices are not available in this window.</p>
      ) : error && !status ? (
        <Banner
          layout="inline"
          model={{
            id: "android-settings-status",
            tone: "warning",
            title: "Could not read the Android SDK",
            detail: error.sentence,
            error: error.detail ?? undefined,
            actions: [{ label: "Retry", onClick: () => void read() }],
          }}
        />
      ) : !status ? (
        <span className="text-muted-fg" aria-label="Checking"><Spinner /></span>
      ) : (
        <AndroidSetupCard
          sdk={status.sdk}
          pin={scope.pin}
          machineName={machineName}
          remoteMachine={!scope.isThisMachine}
          refreshing={refreshing}
          onRefresh={() => void read()}
          variant="settings"
        />
      )}
    </ModernSection>
  );
}
