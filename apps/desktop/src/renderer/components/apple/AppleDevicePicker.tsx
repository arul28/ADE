import { useMemo, useState } from "react";
import { DeviceMobile, DeviceTablet, Plus } from "@phosphor-icons/react";
import type { AppleInstalledSimulator } from "../../../shared/types/iosSimulator";
import { cn } from "../ui/cn";
import {
  appleSimulatorDescription,
  isAppleSimulatorBooted,
  sortAppleSimulators,
} from "./appleDeviceState";

export type AppleDevicePickerProps = {
  installed: readonly AppleInstalledSimulator[];
  /** The udid a start is in flight for, or `"create"` while cloning. */
  pending: string | null;
  /** The project's last used template, when there is one. */
  lastUsedUdid: string | null;
  refreshing: boolean;
  onStart: (udid: string) => void;
  onCreate: (sourceUdid: string) => void;
  onRefresh: () => void;
};

const Spinner = () => (
  <span
    aria-hidden="true"
    className="h-3 w-3 shrink-0 animate-spin rounded-full border border-muted-fg/35 border-t-accent"
  />
);

/**
 * The pane's front door: every simulator this Mac has, and one click each.
 *
 * Round 1 put this behind a modal with a mode switch ("Clone" / "Attach") and
 * shipped rows that attached without booting, so the reward for choosing a
 * device was an empty black column. Start and Open are the same click here —
 * attach, boot, stream — and the only other row is the one that makes a new
 * device. There is no pre-selected row: this is a list you read, not a form
 * that has already decided for you.
 */
export function AppleDevicePicker({
  installed,
  pending,
  lastUsedUdid,
  refreshing,
  onStart,
  onCreate,
  onRefresh,
}: AppleDevicePickerProps) {
  const rows = useMemo(() => sortAppleSimulators(installed), [installed]);
  const templates = useMemo(
    () => [...installed].sort((a, b) => a.name.localeCompare(b.name)),
    [installed],
  );
  const defaultTemplate = useMemo(() => {
    if (lastUsedUdid && templates.some((entry) => entry.udid === lastUsedUdid)) return lastUsedUdid;
    // "Newest iPhone" with no version metadata to sort on: the highest runtime
    // string among the iPhones, which is what `iOS 26.2` compares as anyway.
    const iphones = templates.filter((entry) => entry.family !== "ipad");
    const newest = [...(iphones.length > 0 ? iphones : templates)].sort((a, b) =>
      b.runtime.localeCompare(a.runtime, undefined, { numeric: true }))[0];
    return newest?.udid ?? "";
  }, [lastUsedUdid, templates]);
  const [source, setSource] = useState<string | null>(null);
  const selectedSource = source && templates.some((entry) => entry.udid === source)
    ? source
    : defaultTemplate;

  const busy = pending !== null;

  if (rows.length === 0) {
    return (
      <div className="flex size-full flex-col items-center justify-center gap-3 bg-bg px-5 py-8 text-center">
        <DeviceMobile size={28} className="text-muted-fg/60" />
        <p className="font-sans text-sm font-medium text-fg">No iOS simulators are installed.</p>
        <p className="max-w-xs font-sans text-xs leading-5 text-muted-fg">
          Install one in Xcode → Settings → Components.
        </p>
        <RefreshButton refreshing={refreshing} onRefresh={onRefresh} />
      </div>
    );
  }

  return (
    <div className="size-full overflow-y-auto bg-bg px-5 py-8" data-apple-picker="">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-3">
        <div className="flex items-center gap-2 font-sans text-sm font-medium text-fg">
          <DeviceMobile size={16} className="shrink-0 text-muted-fg" />
          <h3>iOS Simulators</h3>
        </div>

        <div className="flex flex-col divide-y divide-border rounded-xl border border-border overflow-hidden">
          {rows.map((simulator) => {
            const booted = isAppleSimulatorBooted(simulator);
            const verb = booted ? "Open" : "Start";
            const Icon = simulator.family === "ipad" ? DeviceTablet : DeviceMobile;
            return (
              <button
                key={simulator.udid}
                type="button"
                disabled={busy}
                aria-label={`${verb} ${simulator.name}`}
                onClick={() => onStart(simulator.udid)}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors",
                  "hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-50",
                )}
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border">
                  <Icon size={16} className="text-muted-fg" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-sans text-[13px] font-medium leading-5 text-fg">
                    {simulator.name}
                  </span>
                  <span className="font-sans text-[11px] leading-4 text-muted-fg">
                    {appleSimulatorDescription(simulator)}
                  </span>
                </span>
                {pending === simulator.udid ? (
                  <Spinner />
                ) : (
                  <span className="shrink-0 font-sans text-xs text-muted-fg">{verb}</span>
                )}
              </button>
            );
          })}

          <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
            <Plus size={14} className="shrink-0 text-muted-fg" />
            <span className="font-sans text-[13px] leading-5 text-fg">
              New simulator for this lane
            </span>
            <label className="sr-only" htmlFor="apple-picker-source">
              Device to copy
            </label>
            <select
              id="apple-picker-source"
              value={selectedSource}
              disabled={busy}
              onChange={(event) => setSource(event.target.value)}
              className={cn(
                "ml-auto h-7 max-w-[15rem] rounded-md border border-border bg-surface px-2",
                "font-sans text-[11px] text-fg disabled:opacity-50",
              )}
            >
              {templates.map((entry) => (
                <option key={entry.udid} value={entry.udid}>
                  {`${entry.name} · ${entry.runtime}`}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy || !selectedSource}
              aria-label="Create a new simulator for this lane"
              onClick={() => selectedSource && onCreate(selectedSource)}
              className={cn(
                "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 font-sans text-xs",
                "text-fg/85 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {pending === "create" ? <Spinner /> : null}
              Create
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-sans text-[11px] leading-4 text-muted-fg">
            Only simulators already installed appear here.
          </p>
          <RefreshButton refreshing={refreshing} onRefresh={onRefresh} />
        </div>
      </div>
    </div>
  );
}

function RefreshButton({ refreshing, onRefresh }: { refreshing: boolean; onRefresh: () => void }) {
  return (
    <button
      type="button"
      disabled={refreshing}
      onClick={onRefresh}
      className="rounded-md px-2 py-1 font-sans text-xs text-muted-fg hover:bg-white/[0.06] hover:text-fg disabled:opacity-50"
    >
      Refresh
    </button>
  );
}
