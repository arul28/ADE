import { FolderSimple } from "@phosphor-icons/react";
import { COLORS } from "../../lanes/laneDesignTokens";
import { cn } from "../../ui/cn";
import type { SessionPlace } from "./importBrowserModel";

export function LaneDot({ color, className }: { color: string | null | undefined; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block h-[7px] w-[7px] shrink-0 rounded-full", className)}
      style={{ backgroundColor: color?.trim() ? color : COLORS.accent }}
    />
  );
}

/** Lane dot + lane name, or a folder mark for sessions outside every lane. */
export function PlaceLabel({ place, className }: { place: SessionPlace; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      {place.kind === "lane" ? (
        <LaneDot color={place.color} />
      ) : (
        <FolderSimple size={11} weight="regular" className="shrink-0 opacity-70" aria-hidden="true" />
      )}
      <span className="truncate">{place.name}</span>
    </span>
  );
}

export function LiveBadge({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-emerald-300/90">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_6px_rgba(110,231,183,0.8)]" />
        Live
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/[0.12] px-2 py-0.5 text-[10px] font-medium text-emerald-200">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_6px_rgba(110,231,183,0.8)]" />
      Live
    </span>
  );
}

export function MetaSeparator() {
  return <span aria-hidden="true" className="text-muted-fg/30">·</span>;
}
