import { useCallback, useEffect, useRef, useState } from "react";
import type { AndroidEmulatorStatus } from "../../../shared/types/androidEmulator";
import { AndroidSetupCard } from "../android/AndroidSetupCard";
import { describeAndroidError, type AndroidErrorDescription } from "../android/androidDeviceState";
import { Spinner } from "../ui/Spinner";
import { Banner } from "../ui/notice";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import { ModernSection } from "./primitives";

/**
 * Settings › Android devices: the setup card of the Android pane, for the
 * picked machine. The SDK, its licences and the Android CLI belong to one
 * machine, so this page follows `?machine=` like Providers and can set up a
 * Windows box from a Mac window. Every call carries the scope's pin.
 */
export function AndroidDevicesSection() {
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
