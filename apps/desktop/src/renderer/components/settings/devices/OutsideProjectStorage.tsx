import React from "react";
import { AndroidLogo, DeviceMobile, Hammer, Stack } from "@phosphor-icons/react";
import { pluralCount } from "../../../../shared/formatting";
import { isMacRuntimeTarget } from "../../../lib/platform";
import { useSettingsMachineScope } from "../SettingsMachineScope";
import { useSettingsMachines } from "../machines/settingsMachinesContext";
import { ModernSection } from "../primitives";
import { useStorageBytes } from "../storage/useStorageBytes";
import { DevToolsSpaceBar, readyTotal, type SpaceSegment } from "./DevToolsSpaceBar";
import { DevToolRow, PartError, SizeCell, useDevToolHues } from "./devToolsList";
import { devToolsSizes, useDevToolsStorage, type DevToolsPartSize } from "./useDevToolsStorage";

/**
 * Disk space › Space, last: what developer tools keep on the same
 * machine outside any project (Xcode build data, simulators, runtimes,
 * Android emulators), so "what is using my disk" has one answer. Each row
 * opens the page that cleans it up, on the same machine.
 *
 * Opening the view reads the lists only, which is cheap. Sizes mean walking
 * tens of GB of folders, so they are measured when the person asks
 * (Measure sizes), never every time Space opens. Apple rows are for a Mac.
 */

type Row = {
  key: string;
  icon: React.ReactNode;
  title: string;
  hue: string;
  /** How many there are; null while the list loads. */
  count: number | null;
  noun: [string, string];
  size: DevToolsPartSize;
  error: string | null;
  open: () => void;
};

export function OutsideProjectStorage() {
  const scope = useSettingsMachineScope();
  const { openMachine } = useSettingsMachines();
  const { platform, bytes } = useStorageBytes();
  const hues = useDevToolHues();
  // The snapshot names the measured machine's OS; an older brain does not, and then only this computer's own is known.
  const mac = platform ? platform === "darwin" : scope.isThisMachine && isMacRuntimeTarget();
  const [measured, setMeasured] = React.useState(false);
  const storage = useDevToolsStorage({ pin: scope.pin, apple: mac, android: true, measure: measured });
  const sizes = devToolsSizes(storage, measured);
  const where = scope.isThisMachine ? "this computer" : scope.machineName;
  const openApple = () => openMachine(scope.machineId, "apple");

  const rows: Row[] = [
    ...(mac ? [
      { key: "build", icon: <Hammer size={16} />, title: "Xcode build data", hue: hues.buildData, count: storage.buildData.data?.entries.length ?? null, noun: ["folder", "folders"] as [string, string], size: sizes.buildData, error: storage.buildData.error, open: openApple },
      { key: "simulators", icon: <DeviceMobile size={16} />, title: "iOS simulators", hue: hues.simulators, count: storage.simulators.data?.length ?? null, noun: ["simulator", "simulators"] as [string, string], size: sizes.simulators, error: storage.simulators.error, open: openApple },
      { key: "runtimes", icon: <Stack size={16} />, title: "Simulator runtimes", hue: hues.runtimes, count: storage.runtimes.data ? storage.runtimes.data.runtimes.length + (storage.runtimes.data.leftovers?.length ?? 0) : null, noun: ["runtime", "runtimes"] as [string, string], size: sizes.runtimes, error: storage.runtimes.error, open: openApple },
    ] : []),
    { key: "emulators", icon: <AndroidLogo size={16} />, title: "Android emulators", hue: hues.emulators, count: storage.emulators.data?.length ?? null, noun: ["emulator", "emulators"], size: sizes.emulators, error: storage.emulators.error, open: () => openMachine(scope.machineId, "android") },
  ];
  if (!scope.target) return null;
  // Nothing installed at all: one quiet line, not four empty rows.
  const nothing = rows.every((row) => row.count === 0 && !row.error);
  const segments: SpaceSegment[] = rows.map((row) => ({ key: row.key, label: row.title, size: row.size, hue: row.hue }));
  const total = readyTotal(segments);
  const failed = rows.filter((row) => row.error);

  return (
    <ModernSection
      group="Storage"
      anchor="storage-dev-tools"
      title="Outside this project"
      hint={`What developer tools keep on ${where}. Each opens the page that cleans it up.`}
      actions={!measured && !nothing ? (
        <button type="button" className="ade-modern-btn" data-size="sm" onClick={() => setMeasured(true)}>Measure sizes</button>
      ) : measured ? (
        <button type="button" className="ade-modern-btn" data-size="sm" data-variant="ghost" onClick={storage.refresh}>Measure again</button>
      ) : undefined}
    >
      {failed.length > 0 ? (
        <PartError
          id="storage-dev-tools-read"
          title={`Couldn't read ${failed.map((row) => row.title.toLowerCase()).join(", ")}`}
          error={failed[0]!.error!}
          onRetry={storage.refresh}
        />
      ) : null}
      {nothing ? (
        <div className="ade-dev-empty">No simulators, emulators or Xcode build data on {where}.</div>
      ) : (
        <div className="ade-dev-card">
          {measured ? (
            <DevToolsSpaceBar
              format={bytes}
              segments={segments}
              headline={total != null
                ? <>Developer tools use <strong>{bytes(total)}</strong> on {where}</>
                : segments.some((segment) => segment.size.state === "measuring")
                  ? <>Measuring developer tools on {where}…</>
                  : <>Some sizes on {where} couldn't be read.</>}
            />
          ) : null}
          <ul className="ade-dev-list ade-dev-list-flat" data-first={!measured || undefined} aria-label="Developer tools">
            {rows.map((row) => (
              <DevToolRow
                key={row.key}
                glyph={row.icon}
                title={row.title}
                sub={row.error ? "Couldn't read" : row.count == null ? "Checking…" : pluralCount(row.count, row.noun[0], row.noun[1])}
                size={row.size.state === "unmeasured"
                  ? <span className="ade-dev-size" data-pending="true">—</span>
                  : row.size.state === "failed"
                    ? <span className="ade-dev-size" data-pending="true">Couldn't measure</span>
                    : <SizeCell value={row.size.bytes} measuring={row.size.state === "measuring"} format={bytes} />}
                action={(
                  <button type="button" className="ade-modern-btn" data-size="sm" data-variant="ghost" onClick={row.open} aria-label={`Clean up ${row.title}`}>
                    Clean up
                  </button>
                )}
              />
            ))}
          </ul>
        </div>
      )}
    </ModernSection>
  );
}
