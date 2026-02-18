import React from "react";
import { cn } from "../../ui/cn";
import type { LaneSummary } from "../../../../shared/types";

type LaneDropdownProps = {
  lanes: LaneSummary[];
  value: string | null;
  onChange: (laneId: string) => void;
  placeholder?: string;
  className?: string;
};

export function LaneDropdown({
  lanes,
  value,
  onChange,
  placeholder = "Select lane...",
  className
}: LaneDropdownProps) {
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-fg focus:border-accent focus:outline-none",
        className
      )}
    >
      <option value="" disabled>
        {placeholder}
      </option>
      {lanes.map((lane) => (
        <option key={lane.id} value={lane.id}>
          {lane.name} ({lane.branchRef})
        </option>
      ))}
    </select>
  );
}
