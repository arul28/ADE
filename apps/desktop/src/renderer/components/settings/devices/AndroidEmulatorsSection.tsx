import React from "react";
import { AndroidLogo, CircleNotch } from "@phosphor-icons/react";
import type { AndroidAvd } from "../../../../shared/types/androidEmulator";
import { formatStorageBytes, pluralCount } from "../../../../shared/formatting";
import { confirmDialog } from "../../ui/dialog";
import { Banner } from "../../ui/notice";
import { showToast } from "../../app/toast/toastStore";
import { useSettingsMachineScope } from "../SettingsMachineScope";
import { ModernSection } from "../primitives";
import { useDevToolsStorage } from "./useDevToolsStorage";
import "./devTools.css";

/**
 * Settings › Android devices › Emulators: every emulator (AVD) on the picked
 * machine with what it takes on disk, biggest first, and a delete for each one
 * that is not running. The Android pane's own storage list does the same for
 * one lane; this is the machine's whole list, from Settings.
 */
export function AndroidEmulatorsSection() {
  const scope = useSettingsMachineScope();
  const storage = useDevToolsStorage({ pin: scope.pin, apple: false, android: true });
  const { data, loading, error } = storage.emulators;
  const [busy, setBusy] = React.useState<string | null>(null);
  // The emulator list carries no platform; 1024-based sizes match the Android tools' own.
  const bytes = (value: number) => formatStorageBytes(value, undefined);
  const avds = data ?? [];
  const total = avds.reduce((sum, avd) => sum + (avd.sizeBytes ?? 0), 0);

  const remove = async (avd: AndroidAvd) => {
    const label = avd.displayName || avd.name;
    const size = avd.sizeBytes != null ? bytes(avd.sizeBytes) : null;
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
      showToast({
        id: "android-settings-avd-delete",
        tone: result.deleted ? "success" : "warning",
        title: result.deleted ? `Deleted ${label}` : `${label} was not deleted`,
      });
    } catch (err) {
      showToast({ id: "android-settings-avd-delete", tone: "error", title: `Couldn't delete ${label}`, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
      storage.refreshAndroid();
    }
  };

  return (
    <ModernSection
      group="Android devices"
      anchor="android-emulators"
      title={data ? `Emulators · ${avds.length}` : "Emulators"}
      hint={avds.length && total ? `${bytes(total)} on ${scope.isThisMachine ? "this computer" : scope.machineName}. Biggest first.` : "Every emulator on this machine and what it keeps on disk."}
    >
      {error && !data ? (
        <Banner layout="inline" model={{ id: "android-settings-avds", tone: "warning", title: "Couldn't read the emulators", detail: error, actions: [{ label: "Try again", onClick: storage.refreshAndroid }] }} />
      ) : null}
      {loading && !data ? (
        <div className="ade-dev-list" aria-busy="true">
          {[0, 1].map((index) => <div key={index} className="ade-dev-row"><span className="ade-dev-shimmer" /></div>)}
        </div>
      ) : null}
      {data && avds.length === 0 ? <div className="ade-dev-empty">No emulators yet. A lane's Android pane makes one.</div> : null}
      {avds.length > 0 ? (
        <ul className="ade-dev-list" aria-label="Emulators">
          {avds.map((avd) => {
            const label = avd.displayName || avd.name;
            return (
              <li key={avd.name} className="ade-dev-row">
                <span className="ade-dev-row-glyph" aria-hidden><AndroidLogo size={16} /></span>
                <span className="ade-dev-row-text">
                  <span className="ade-dev-row-title">
                    {label}
                    {avd.running ? <span className="ade-dev-chip" data-tone="ok">Running</span> : null}
                  </span>
                  <span className="ade-dev-row-sub">
                    {[avd.apiLevel ? `Android API ${avd.apiLevel}` : null].filter(Boolean).join("")}
                    <span className="ade-dev-owner" data-owner={avd.adeCreated ? "ade-kept" : "yours"}>{avd.adeCreated ? "Made by ADE" : "Yours"}</span>
                  </span>
                </span>
                <span className="ade-dev-size" data-pending={avd.sizeBytes == null || undefined}>{avd.sizeBytes != null ? bytes(avd.sizeBytes) : "—"}</span>
                <button
                  type="button"
                  className="ade-modern-btn"
                  data-size="sm"
                  data-variant="ghost"
                  disabled={busy != null || avd.running != null}
                  title={avd.running ? "It is running. Stop it first." : `Delete ${label}`}
                  aria-label={`Delete ${label}`}
                  onClick={() => void remove(avd)}
                >
                  {busy === avd.name ? <CircleNotch size={12} className="animate-spin" /> : null}
                  Delete
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {avds.some((avd) => avd.running) ? <div className="ade-dev-note">{pluralCount(avds.filter((avd) => avd.running).length, "emulator is", "emulators are")} running and can't be deleted until stopped.</div> : null}
    </ModernSection>
  );
}
