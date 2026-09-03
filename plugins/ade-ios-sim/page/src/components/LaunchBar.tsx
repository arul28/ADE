/**
 * The two picker rows above the stage: the device, then the launch target.
 *
 * `ChatIosSimulatorPanel.tsx`'s own two `<div className="flex items-center
 * gap-1">` blocks, moved. Two details are load-bearing and are kept:
 *
 * - The launch-target row collapses to a READ-ONLY line when there is one
 *   target or none. A one-option `<select>` is a control that cannot be used,
 *   and "No launchable app found" is the sentence a reader with no target needs.
 * - Apply is a second Launch, not a different verb. It rebuilds, reinstalls and
 *   relaunches the running app, and only appears while a session is live.
 */

import React from "react";
import { ArrowClockwise, Play, Power } from "@phosphor-icons/react";

import type { IosSimulatorDevice, IosSimulatorLaunchTarget } from "../types";
import { deviceLabel, targetLabel } from "./simFormat";

export function DevicePicker({
  devices,
  selectedUdid,
  disabled,
  busy,
  canStop,
  onSelect,
  onRefresh,
  onStop,
}: {
  devices: IosSimulatorDevice[];
  selectedUdid: string | null;
  disabled: boolean;
  busy: boolean;
  canStop: boolean;
  onSelect: (udid: string | null) => void;
  onRefresh: () => void;
  onStop: () => void;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-1" data-sim-pane="device-picker">
      <select
        className="min-w-0 flex-1 rounded border border-white/[0.08] bg-black/20 px-1.5 py-1 font-sans text-[10px] text-fg/75 outline-none disabled:opacity-50"
        aria-label="Simulator device"
        value={selectedUdid ?? ""}
        disabled={disabled}
        onChange={(event) => onSelect(event.currentTarget.value || null)}
      >
        {devices.length ? (
          devices.map((device) => (
            <option key={device.udid} value={device.udid}>
              {deviceLabel(device)}
            </option>
          ))
        ) : (
          <option value="">No available simulator</option>
        )}
      </select>
      <button
        type="button"
        className="inline-flex h-7 w-7 items-center justify-center rounded border border-white/[0.08] bg-white/[0.03] text-fg/55 transition-colors hover:text-fg/85 disabled:cursor-not-allowed disabled:opacity-45"
        onClick={onRefresh}
        disabled={busy}
        aria-label="Refresh simulator state"
        title="Refresh simulator state"
      >
        <ArrowClockwise size={14} />
      </button>
      {canStop ? (
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded border border-rose-400/22 bg-rose-500/8 px-1.5 font-sans text-[10px] font-medium text-rose-200/80 transition-colors hover:bg-rose-500/12 disabled:cursor-not-allowed disabled:opacity-45"
          onClick={onStop}
          disabled={busy}
          title="Stop the running simulator"
        >
          <Power size={12} weight="bold" />
          Stop
        </button>
      ) : null}
    </div>
  );
}

export function LaunchTargetPicker({
  targets,
  selectedId,
  canLaunch,
  busy,
  live,
  onSelect,
  onLaunch,
}: {
  targets: IosSimulatorLaunchTarget[];
  selectedId: string | null;
  canLaunch: boolean;
  busy: boolean;
  live: boolean;
  onSelect: (id: string | null) => void;
  onLaunch: () => void;
}): React.ReactElement {
  const active = targets.find((target) => target.id === selectedId) ?? targets[0] ?? null;
  return (
    <div className="flex items-center gap-1" data-sim-pane="launch-bar">
      {targets.length > 1 ? (
        <select
          className="min-w-0 flex-1 rounded border border-white/[0.08] bg-black/20 px-1.5 py-1 font-sans text-[10px] text-fg/75 outline-none"
          aria-label="Launch target"
          value={active?.id ?? ""}
          onChange={(event) => onSelect(event.currentTarget.value || null)}
        >
          {targets.map((target) => (
            <option key={target.id} value={target.id}>
              {targetLabel(target)}
            </option>
          ))}
        </select>
      ) : (
        <div className="min-w-0 flex-1 rounded-md border border-white/[0.08] bg-black/20 px-2 py-1.5 font-sans text-[11px] text-fg/75">
          {targetLabel(active)}
        </div>
      )}
      <button
        type="button"
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-emerald-400/20 bg-emerald-500/10 px-2 font-sans text-[11px] font-medium text-emerald-100/85 transition-colors hover:bg-emerald-500/15 disabled:cursor-not-allowed disabled:opacity-45"
        disabled={busy || !canLaunch || !active}
        onClick={onLaunch}
      >
        <Play size={13} weight="fill" />
        Launch
      </button>
      {live ? (
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-cyan-400/20 bg-cyan-500/10 px-2 font-sans text-[11px] font-medium text-cyan-100/85 transition-colors hover:bg-cyan-500/15 disabled:cursor-not-allowed disabled:opacity-45"
          disabled={busy || !canLaunch || !active}
          onClick={onLaunch}
          title="Rebuild, reinstall, and relaunch the active app"
        >
          <ArrowClockwise size={13} />
          Apply
        </button>
      ) : null}
    </div>
  );
}
