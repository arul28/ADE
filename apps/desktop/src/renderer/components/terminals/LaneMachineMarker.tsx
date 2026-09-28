import React from "react";
import { CloudCheck, DesktopTower } from "@phosphor-icons/react";
import type { CrossMachineLaneMarker } from "../../state/crossMachineLanes";
import { SmartTooltip } from "../ui/SmartTooltip";

/**
 * Machine marker on a lane header, or on the card that stands in for one.
 *
 * Rendered ONLY for a lane whose machine is offline. A project open on several
 * machines is one project: its lanes and chats work wherever they live, and the
 * top bar's connection dot already says the machines are linked, so an online
 * machine gets no badge. An unreachable machine keeps its rows, though, and
 * this dimmed tower is the only thing on them that says why the group has gone
 * quiet. Callers with no lane header of their own (the command palette) pass
 * `mode: "name"`.
 */
export function LaneMachineMarker({ marker }: { marker: CrossMachineLaneMarker }) {
  if (marker.online) return null;
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
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.03] px-1.5 py-px text-[10px] font-medium leading-none text-muted-fg/45"
        aria-label={`${marker.machineName}, offline`}
        data-machine-id={marker.machineId}
        data-machine-marker-mode={marker.mode}
        data-machine-online="false"
      >
        <DesktopTower size={10} weight="duotone" className="shrink-0 text-muted-fg/45" />
        {marker.mode === "name" ? <span className="max-w-24 truncate">{marker.machineName}</span> : null}
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
