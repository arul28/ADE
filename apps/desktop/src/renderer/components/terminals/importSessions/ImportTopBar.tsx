import type { RefObject } from "react";
import { ArrowClockwise, CircleNotch, MagnifyingGlass } from "@phosphor-icons/react";
import { SmartTooltip } from "../../ui/SmartTooltip";
import { DraftMachinePicker } from "../../chat/DraftMachinePicker";
import { LaneCombobox, type LaneComboboxLane } from "../LaneCombobox";
import type { ExternalSessionSource } from "./contract";

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
