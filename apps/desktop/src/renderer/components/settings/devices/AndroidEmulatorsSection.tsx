import React from "react";
import { AndroidLogo } from "@phosphor-icons/react";
import type { AndroidAvd } from "../../../../shared/types/androidEmulator";
import { formatStorageBytes, pluralCount } from "../../../../shared/formatting";
import { confirmDialog } from "../../ui/dialog";
import { showToast } from "../../app/toast/toastStore";
import { useSettingsMachineScope } from "../SettingsMachineScope";
import { captureDevToolsCleanup } from "./devToolsAnalytics";
import { DevToolRow, DevToolsListSection, ListSkeleton, PartError, RowAction, SizeCell } from "./devToolsList";
import { useDevToolsStorage } from "./useDevToolsStorage";

/**
 * Settings › Android devices › Emulators: every emulator (AVD) on the picked
 * machine with what it takes on disk, biggest first, and a delete for each one
 * that is not running. The Android pane's own storage list does the same for
 * one lane; this is the machine's whole list, from Settings.
 */

// The AVD list carries no platform; 1024-based sizes match the Android tools' own.
const formatAvd = (value: number) => formatStorageBytes(value, undefined);

export function AndroidEmulatorsSection() {
  const scope = useSettingsMachineScope();
  const storage = useDevToolsStorage({ pin: scope.pin, apple: false, android: true });
  const { data, loading, error } = storage.emulators;
  const [busy, setBusy] = React.useState<string | null>(null);
  const avds = data ?? [];
  const total = avds.reduce((sum, avd) => sum + (avd.sizeBytes ?? 0), 0);
  const running = avds.filter((avd) => avd.running).length;

  const remove = async (avd: AndroidAvd) => {
    const label = avd.displayName || avd.name;
    const size = avd.sizeBytes != null ? formatAvd(avd.sizeBytes) : null;
    const ok = await confirmDialog({
      title: `Delete ${label}?`,
      message: `Its apps and data go with it${size ? `, and ${size} comes back` : ""}. You can make a new one from a lane's Android pane.`,
      confirmLabel: size ? `Delete · free ${size}` : "Delete",
      destructive: true,
    });
    if (!ok) return;
    setBusy(avd.name);
    try {
      const result = await window.ade.androidEmulator.deleteDevice({ avdName: avd.name }, scope.pin);
      captureDevToolsCleanup("emulator_deleted", result.deleted ? "completed" : "failed", avd.sizeBytes);
      showToast({
        id: "android-settings-avd-delete",
        tone: result.deleted ? "success" : "warning",
        title: result.deleted ? `Deleted ${label}` : `${label} was not deleted`,
      });
    } catch (err) {
      captureDevToolsCleanup("emulator_deleted", "failed");
      showToast({ id: "android-settings-avd-delete", tone: "error", title: `Couldn't delete ${label}`, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
      storage.refreshAndroid();
    }
  };

  return (
    <DevToolsListSection
      group="Android devices"
      anchor="android-emulators"
      title="Emulators"
      count={data ? avds.length : null}
      hint={avds.length && total ? `${formatAvd(total)} on ${scope.isThisMachine ? "this computer" : scope.machineName}. Biggest first.` : "Every emulator on this machine and what it keeps on disk."}
    >
      {error && !data ? <PartError id="android-settings-avds" title="Couldn't read the emulators" error={error} onRetry={storage.refreshAndroid} /> : null}
      {loading && !data ? <ListSkeleton rows={2} /> : null}
      {data && avds.length === 0 ? <div className="ade-dev-empty">No emulators yet. A lane's Android pane makes one.</div> : null}
      {avds.length > 0 ? (
        <ul className="ade-dev-list" aria-label="Emulators">
          {avds.map((avd) => {
            const label = avd.displayName || avd.name;
            return (
              <DevToolRow
                key={avd.name}
                glyph={<AndroidLogo size={16} />}
                title={label}
                chips={avd.running ? <span className="ade-dev-chip" data-tone="ok">Running</span> : null}
                sub={<>{avd.apiLevel ? `Android API ${avd.apiLevel}` : null}<span className="ade-dev-owner" data-owner={avd.adeCreated ? "ade-kept" : "yours"}>{avd.adeCreated ? "Made by ADE" : "Yours"}</span></>}
                size={<SizeCell value={avd.sizeBytes} format={formatAvd} />}
                action={<RowAction label="Delete" ariaLabel={`Delete ${label}`} busy={busy === avd.name} disabled={busy != null} blockedWhy={avd.running ? "It is running. Stop it first." : null} onClick={() => void remove(avd)} />}
              />
            );
          })}
        </ul>
      ) : null}
      {running ? <div className="ade-dev-note">{pluralCount(running, "emulator is", "emulators are")} running and can't be deleted until stopped.</div> : null}
    </DevToolsListSection>
  );
}
