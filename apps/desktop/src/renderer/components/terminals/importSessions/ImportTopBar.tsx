import type { RefObject } from "react";
import { ArrowClockwise, CircleNotch, MagnifyingGlass } from "@phosphor-icons/react";
import { cn } from "../../ui/cn";
import { SmartTooltip } from "../../ui/SmartTooltip";
import { DraftMachinePicker } from "../../chat/DraftMachinePicker";
import { ToolLogo } from "../ToolLogos";
import { LaneCombobox, type LaneComboboxLane } from "../LaneCombobox";
import { importProviderLabel } from "../../../../shared/externalSessionPolicy";
import {
  PROVIDER_TOOL_TYPE,
  type ExternalSessionProvider,
  type ExternalSessionSource,
} from "./contract";
import type { ProviderFilter } from "./importBrowserModel";

function Chip({
  selected,
  onClick,
  label,
  count,
  provider,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  count: number;
  provider?: ExternalSessionProvider;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border text-[11px] font-medium transition-colors duration-100",
        provider ? "pl-1.5 pr-2.5" : "px-2.5",
        selected
          ? "border-white/[0.14] bg-white/[0.08] text-fg"
          : "border-white/[0.05] bg-transparent text-muted-fg/75 hover:bg-white/[0.035] hover:text-fg",
      )}
    >
      {provider ? (
        <ToolLogo
          toolType={PROVIDER_TOOL_TYPE[provider]}
          size={14}
          className={cn("transition-opacity", selected ? "opacity-100" : "opacity-70")}
        />
      ) : null}
      {label}
      <span className={cn("tabular-nums text-[10px]", selected ? "text-fg/55" : "text-muted-fg/45")}>{count}</span>
    </button>
  );
}

export function ImportTopBar({
  providerChips,
  totalCount,
  providerFilter,
  onProviderFilterChange,
  laneOptions,
  laneFilter,
  onLaneFilterChange,
  laneFilterTotal,
  query,
  onQueryChange,
  searchRef,
  loading,
  onRefresh,
  sources,
  selectedSourceId,
  onSourceChange,
  sourceDisabled,
}: {
  providerChips: Array<{ provider: ExternalSessionProvider; count: number }>;
  totalCount: number;
  providerFilter: ProviderFilter;
  onProviderFilterChange: (filter: ProviderFilter) => void;
  laneOptions: LaneComboboxLane[];
  laneFilter: string;
  onLaneFilterChange: (laneId: string) => void;
  laneFilterTotal: number;
  query: string;
  onQueryChange: (query: string) => void;
  searchRef: RefObject<HTMLInputElement>;
  loading: boolean;
  onRefresh: () => void;
  sources: ExternalSessionSource[];
  selectedSourceId: string | null;
  onSourceChange: (machineId: string) => void;
  sourceDisabled: boolean;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-white/[0.06] px-4 py-2.5 sm:px-5">
      <div className="flex min-w-0 items-center gap-2">
        <LaneCombobox
          lanes={laneOptions}
          value={laneFilter}
          onChange={onLaneFilterChange}
          showAllOption
          allLabel="All lanes"
          allDetail={String(laneFilterTotal)}
          variant="pill"
          compact
          aria-label="Filter by lane"
        />
        <label className="relative flex h-7 min-w-[140px] flex-1 items-center">
          <MagnifyingGlass
            size={12}
            className="pointer-events-none absolute left-2.5 text-muted-fg/50"
            aria-hidden="true"
          />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search"
            aria-label="Search sessions"
            data-import-search=""
            className="h-7 w-full rounded-full border border-white/[0.06] bg-white/[0.02] pl-7 pr-3 text-[11.5px] text-fg placeholder:text-muted-fg/45 focus:border-white/[0.14] focus:bg-white/[0.035] focus:outline-none"
          />
        </label>
        <SmartTooltip content={{ label: "Refresh", description: "Scan again for sessions." }}>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            aria-label="Refresh session list"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/[0.06] text-muted-fg/70 transition-colors hover:bg-white/[0.04] hover:text-fg disabled:cursor-default"
          >
            {loading ? <CircleNotch size={12} className="animate-spin" /> : <ArrowClockwise size={12} />}
          </button>
        </SmartTooltip>
        <DraftMachinePicker
          machines={sources.map((source) => ({
            id: source.machineId,
            name: source.machineName,
            unavailableReason: source.online ? null : "Offline. Reconnect it to scan sessions.",
          }))}
          selectedMachineId={selectedSourceId}
          onChange={onSourceChange}
          disabled={sourceDisabled}
          tooltipLabel="Import from"
          triggerLabel="Choose import source"
          tooltipDescription="The computer to scan. The list and actions follow it."
        />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1" role="group" aria-label="Provider">
        <Chip
          label="All"
          count={totalCount}
          selected={providerFilter === "all"}
          onClick={() => onProviderFilterChange("all")}
        />
        {providerChips.map((chip) => (
          <Chip
            key={chip.provider}
            provider={chip.provider}
            label={importProviderLabel(chip.provider)}
            count={chip.count}
            selected={providerFilter === chip.provider}
            onClick={() => onProviderFilterChange(chip.provider)}
          />
        ))}
      </div>
    </div>
  );
}
