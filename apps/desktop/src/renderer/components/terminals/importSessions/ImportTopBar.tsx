import type { RefObject } from "react";
import { ArrowClockwise, CircleNotch, MagnifyingGlass } from "@phosphor-icons/react";
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

/**
 * Provider filter over the session list: one segmented control, each option a
 * logo, a name and its count, so it reads as a summary and filters the list.
 */
export function ImportProviderFilter({
  providerChips,
  totalCount,
  providerFilter,
  onProviderFilterChange,
}: {
  providerChips: Array<{ provider: ExternalSessionProvider; count: number }>;
  totalCount: number;
  providerFilter: ProviderFilter;
  onProviderFilterChange: (filter: ProviderFilter) => void;
}) {
  return (
    <div className="import-providers">
      <div className="kit-seg" data-case="sentence" role="group" aria-label="Provider">
        <button
          type="button"
          aria-pressed={providerFilter === "all"}
          onClick={() => onProviderFilterChange("all")}
        >
          All
          <span className="kit-num">{totalCount}</span>
        </button>
        {providerChips.map((chip) => (
          <button
            key={chip.provider}
            type="button"
            aria-pressed={providerFilter === chip.provider}
            onClick={() => onProviderFilterChange(chip.provider)}
          >
            <ToolLogo toolType={PROVIDER_TOOL_TYPE[chip.provider]} size={13} />
            {importProviderLabel(chip.provider)}
            <span className="kit-num">{chip.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** One row of 28px controls: lane, search, computer, refresh. */
export function ImportTopBar({
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
    <div className="import-toolbar">
      <LaneCombobox
        lanes={laneOptions}
        value={laneFilter}
        onChange={onLaneFilterChange}
        showAllOption
        allLabel="All lanes"
        allDetail={String(laneFilterTotal)}
        size="compact"
        aria-label="Filter by lane"
      />
      <label className="import-search">
        <MagnifyingGlass size={12} aria-hidden="true" />
        <input
          ref={searchRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search sessions"
          aria-label="Search sessions"
          data-import-search=""
        />
      </label>
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
      <SmartTooltip content={{ label: "Refresh", description: "Scan again for sessions." }}>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh session list"
          className="kit-icon-btn"
        >
          {loading ? <CircleNotch size={13} className="animate-spin" /> : <ArrowClockwise size={13} />}
        </button>
      </SmartTooltip>
    </div>
  );
}
