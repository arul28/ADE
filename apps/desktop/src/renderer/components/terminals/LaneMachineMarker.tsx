import React from "react";
import { DesktopTower } from "@phosphor-icons/react";
import type { CrossMachineLaneMarker } from "../../state/crossMachineLanes";
import { SmartTooltip } from "../ui/SmartTooltip";
import { cn } from "../ui/cn";

/**
 * Adaptive machine marker on a lane header.
 *
 * Rendered ONLY for lanes that are not on the machine you're sitting at — the
 * common single-machine case pays nothing. Default form is a bare monochrome
 * glyph; the name is promoted into the row when a glyph alone would be
 * ambiguous (the machine is offline, two or more foreign machines on screen, or
 * the branch also exists elsewhere). The lane accent owns the color channel, so
 * this stays monochrome: a tint here would read as a second lane color.
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
