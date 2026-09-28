import React from "react";
import { CloudCheck, DesktopTower } from "@phosphor-icons/react";
import type { CrossMachineLaneMarker } from "../../state/crossMachineLanes";
import { SmartTooltip } from "../ui/SmartTooltip";
import { cn } from "../ui/cn";

/**
 * Machine marker on a lane header, or on the card that stands in for one.
 *
 * Rendered ONLY for lanes that are not on the physical Mac you're sitting at —
 * the common single-machine case pays nothing, and absence is what tells you a
 * lane is here. Never keyed off the project tab's binding; see
 * `resolveCrossMachineLaneMarkers` for why that distinction is the whole point.
 *
 * The resting form is a bare amber tower in an amber pill, with the name on
 * hover. Amber is machine identity throughout ADE and never status. Callers with
 * no lane header of their own (the command palette) pass `mode: "name"`.
 *
 * An unreachable machine keeps its rows, so this has a dimmed form — and it is
 * the only thing on the row that says why the group has gone quiet.
 */
export function LaneMachineMarker({ marker }: { marker: CrossMachineLaneMarker }) {
  return (
    <SmartTooltip
      forceEnabled
      content={{
        label: marker.machineName,
        description: marker.online
          ? "This lane lives on another connected machine."
          : "This machine is offline. Its lanes and chats are shown as last reported and cannot be acted on.",
      }}
    >
      <span
        role="img"
        tabIndex={0}
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium leading-none",
          marker.online
            ? "border-amber-400/20 bg-amber-400/[0.06] text-muted-fg/70"
            : "border-white/[0.08] bg-white/[0.03] text-muted-fg/45",
        )}
        aria-label={marker.online ? marker.machineName : `${marker.machineName}, offline`}
        data-machine-id={marker.machineId}
        data-machine-marker-mode={marker.mode}
        data-machine-online={marker.online ? "true" : "false"}
      >
        <DesktopTower
          size={10}
          weight="duotone"
          className={cn("shrink-0", marker.online ? "text-amber-400/85" : "text-muted-fg/45")}
        />
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
