import React from "react";
import { CloudCheck, DesktopTower } from "@phosphor-icons/react";
import { isMachineMarkerShown, type CrossMachineLaneMarker } from "../../state/crossMachineLanes";
import { SmartTooltip } from "../ui/SmartTooltip";

/**
 * Machine marker on a lane header, or on the card that stands in for one.
 *
 * By default it shows ONLY for a lane whose machine is offline: an unreachable
 * machine keeps its rows, and this dimmed tower says why the group has gone
 * quiet. Callers with no lane header of their own (the command palette) pass
 * `mode: "name"`.
 *
 * `named`: the list shows lanes from more than one computer, so a lane that is
 * not on this computer names its computer also while it is online. Two groups
 * both called "Primary" then read as two computers.
 */
export function LaneMachineMarker({ marker, named = false }: { marker: CrossMachineLaneMarker; named?: boolean }) {
  const offline = isMachineMarkerShown(marker);
  if (!offline && !named) return null;
  if (!offline) {
    return (
      <SmartTooltip forceEnabled content={{ label: marker.machineName, description: "This lane is on another computer." }}>
        <span
          role="img"
          tabIndex={0}
          className="inline-flex min-w-0 shrink items-center gap-1 rounded-full border border-fg/[0.10] bg-fg/[0.04] px-1.5 py-px text-[10px] font-medium leading-none text-muted-fg/75"
          aria-label={marker.machineName}
          data-machine-id={marker.machineId}
          data-machine-marker-mode="name"
          data-machine-online="true"
        >
          <DesktopTower size={10} weight="duotone" className="shrink-0 text-muted-fg/60" />
          <span className="max-w-28 truncate">{marker.machineName}</span>
        </span>
      </SmartTooltip>
    );
  }
  return (
    <SmartTooltip
      forceEnabled
      content={{
        label: marker.machineName,
        description: "This machine is offline. Its lanes and chats are shown as last reported and cannot be acted on.",
      }}
    >
      <span
        role="img"
        tabIndex={0}
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-fg/[0.08] bg-fg/[0.03] px-1.5 py-px text-[10px] font-medium leading-none text-muted-fg/45"
        aria-label={`${marker.machineName}, offline`}
        data-machine-id={marker.machineId}
        data-machine-marker-mode={named ? "name" : marker.mode}
        data-machine-online="false"
      >
        <DesktopTower size={10} weight="duotone" className="shrink-0 text-muted-fg/45" />
        {marker.mode === "name" || named ? <span className="max-w-24 truncate">{marker.machineName}</span> : null}
      </span>
    </SmartTooltip>
  );
}

/**
 * Machine marker for a cloud lane: the lane's machine is a provider's VM, so
 * the header names that cloud the way it would name another Mac. Sky, not
 * amber — it is a cloud, not one of your machines.
 */
export function LaneCloudMarker({ provider }: { provider: "devin" | "cursor" }) {
  const name = provider === "devin" ? "Devin Cloud" : "Cursor Cloud";
  return (
    <SmartTooltip
      forceEnabled
      content={{
        label: name,
        description: `This lane lives on ${name}. Its chats run on the cloud VM and push to the lane's branch; ADE keeps a synced copy here.`,
      }}
    >
      <span
        role="img"
        tabIndex={0}
        aria-label={name}
        data-lane-cloud={provider}
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-sky-400/25 bg-sky-400/[0.08] px-1.5 py-px text-[10px] font-medium leading-none text-sky-100/85"
      >
        <CloudCheck size={10} weight="fill" className="shrink-0 text-sky-300" />
        <span>{name}</span>
      </span>
    </SmartTooltip>
  );
}
