import React from "react";
import { AndroidLogo, DeviceMobile, Hammer, Stack } from "@phosphor-icons/react";
import { pluralCount } from "../../../../shared/formatting";
import { isMacRuntimeTarget } from "../../../lib/platform";
import { useSettingsMachineScope } from "../SettingsMachineScope";
import { useSettingsMachines } from "../machines/settingsMachinesContext";
import { ModernSection } from "../primitives";
import { useStorageBytes } from "../storage/useStorageBytes";
import { DEV_TOOL_HUES } from "./AppleToolsSection";
import { DevToolsSpaceBar } from "./DevToolsSpaceBar";
import { devToolsTotals, useDevToolsStorage } from "./useDevToolsStorage";
import "./devTools.css";

/**
 * Storage & cleanup › Space, last: what developer tools keep on the same
 * machine outside any project (Xcode build data, simulators, runtimes,
 * Android emulators), so "what is using my disk" has one answer. Each row
 * opens the page that cleans it up, on the same machine.
 *
 * Reads the machine the page's project copy is on (its pin), only while this
 * view is open. Apple rows appear for a Mac only.
 */
export function OutsideProjectStorage() {
  const scope = useSettingsMachineScope();
  const { openMachine } = useSettingsMachines();
  const { platform, bytes } = useStorageBytes();
  // The snapshot names the measured machine's OS; an older brain does not, and then only this computer's own is known.
  const mac = platform ? platform === "darwin" : scope.isThisMachine && isMacRuntimeTarget();
  const storage = useDevToolsStorage({ pin: scope.pin, apple: mac, android: true });
  const totals = devToolsTotals(storage);
  const where = scope.isThisMachine ? "this computer" : scope.machineName;

  const rows = [
    ...(mac ? [
      {
        key: "build",
        icon: <Hammer size={16} />,
        title: "Xcode build data",
        count: storage.buildData.data ? pluralCount(storage.buildData.data.entries.length, "folder") : null,
        bytes: totals.buildData,
        loading: storage.buildData.loading,
        open: () => openMachine(scope.machineId, "apple"),
      },
      {
        key: "simulators",
        icon: <DeviceMobile size={16} />,
        title: "iOS simulators",
        count: storage.simulators.data ? pluralCount(storage.simulators.data.length, "simulator") : null,
        bytes: totals.simulators,
        loading: storage.simulators.loading || storage.simulators.measuring,
        open: () => openMachine(scope.machineId, "apple"),
      },
      {
        key: "runtimes",
        icon: <Stack size={16} />,
        title: "Simulator runtimes",
        count: storage.runtimes.data ? pluralCount(storage.runtimes.data.runtimes.length, "runtime") : null,
        bytes: totals.runtimes,
        loading: storage.runtimes.loading,
        open: () => openMachine(scope.machineId, "apple"),
      },
    ] : []),
    {
      key: "emulators",
      icon: <AndroidLogo size={16} />,
      title: "Android emulators",
      count: storage.emulators.data ? pluralCount(storage.emulators.data.length, "emulator") : null,
      bytes: totals.emulators,
      loading: storage.emulators.loading,
      open: () => openMachine(scope.machineId, "android"),
    },
  ];
  // Nothing installed at all: one quiet line, not four zero rows.
  const nothing = rows.every((row) => !row.loading && row.count != null && row.count.startsWith("0 "));
  if (!scope.target) return null;

  return (
    <ModernSection
      group="Storage"
      anchor="storage-dev-tools"
      title="Outside this project"
      hint={`What developer tools keep on ${where}. Each opens the page that cleans it up.`}
    >
      {nothing ? (
        <div className="ade-dev-empty">No simulators, emulators or Xcode build data on {where}.</div>
      ) : (
        <div className="ade-dev-card">
          <DevToolsSpaceBar
            format={bytes}
            headline={rows.every((row) => row.bytes != null)
              ? <>Developer tools use <strong>{bytes(rows.reduce((sum, row) => sum + (row.bytes ?? 0), 0))}</strong> on {where}</>
              : <>Measuring developer tools on {where}…</>}
            segments={rows.map((row) => ({
              key: row.key,
              label: row.title,
              bytes: row.bytes,
              measuring: row.loading,
              hue: row.key === "build" ? DEV_TOOL_HUES.buildData : row.key === "simulators" ? DEV_TOOL_HUES.simulators : row.key === "runtimes" ? DEV_TOOL_HUES.runtimes : DEV_TOOL_HUES.emulators,
            }))}
          />
          <ul className="ade-dev-list ade-dev-list-flat" aria-label="Developer tools">
            {rows.map((row) => (
              <li key={row.key} className="ade-dev-row" data-clickable="true">
                <span className="ade-dev-row-glyph" aria-hidden>{row.icon}</span>
                <span className="ade-dev-row-text">
                  <span className="ade-dev-row-title">{row.title}</span>
                  <span className="ade-dev-row-sub">{row.count ?? "Checking…"}</span>
                </span>
                <span className="ade-dev-size" data-pending={row.bytes == null || undefined}>{row.bytes != null ? bytes(row.bytes) : row.loading ? "Measuring…" : "—"}</span>
                <button type="button" className="ade-modern-btn" data-size="sm" data-variant="ghost" onClick={row.open} aria-label={`Clean up ${row.title}`}>
                  Clean up
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ModernSection>
  );
}
