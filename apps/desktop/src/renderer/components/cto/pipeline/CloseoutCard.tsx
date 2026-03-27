import React from "react";
import { Bell, FlagCheckered, Tag } from "@phosphor-icons/react";
import type { LinearWorkflowCloseoutPolicy } from "../../../../shared/types/linearSync";
import { ISSUE_STATE_LABELS, enumLabel } from "./pipelineLabels";
import { cn } from "../../ui/cn";

type Props = {
  closeout: LinearWorkflowCloseoutPolicy | undefined;
  selected: boolean;
  onSelect: () => void;
  notificationsEnabled?: boolean;
};

export function CloseoutCard({ closeout, selected, onSelect, notificationsEnabled }: Props) {
  const successState = enumLabel(ISSUE_STATE_LABELS, closeout?.successState) || closeout?.successState || "Not set";
  const failureState = enumLabel(ISSUE_STATE_LABELS, closeout?.failureState) || closeout?.failureState || "Not set";

  const applyLabels = Array.from(
    new Set(
      [...(closeout?.applyLabels ?? []), ...(closeout?.labels ?? [])]
        .map((label) => label.trim())
        .filter(Boolean),
    ),
  );
  const hasLabels = applyLabels.length > 0;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "relative flex flex-col items-start rounded-xl px-4 py-3 text-left transition-all duration-200",
        "min-w-[160px] max-w-[200px]",
        selected ? "ring-1 ring-[#34D399]" : "hover:bg-white/[0.03]",
      )}
      style={{
        background: selected ? "rgba(52,211,153,0.05)" : "rgba(19,24,34,0.7)",
        border: `1px solid ${selected ? "rgba(52,211,153,0.25)" : "rgba(255,255,255,0.06)"}`,
        backdropFilter: "blur(12px)",
        boxShadow: selected
          ? "0 0 20px rgba(52,211,153,0.08), 0 0 40px rgba(52,211,153,0.04)"
          : "none",
      }}
    >
      <div className="flex items-center gap-2">
        <FlagCheckered size={14} style={{ color: "#34D399" }} weight="duotone" />
        <span className="text-[13px] font-medium text-fg">Closeout</span>
        {notificationsEnabled && (
          <span aria-label="Notifications enabled">
            <Bell size={11} style={{ color: "#FBBF24" }} weight="fill" />
          </span>
        )}
      </div>

      <div className="mt-2 space-y-1.5">
        {/* On success */}
        <div className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-full shrink-0"
            style={{ background: "#34D399" }}
          />
          <span className="text-[10px] text-muted-fg/40">On success</span>
          <span className="text-[11px] font-medium text-[#34D399]/80">{successState}</span>
        </div>

        {/* On failure */}
        <div className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-full shrink-0"
            style={{ background: "#EF4444" }}
          />
          <span className="text-[10px] text-muted-fg/40">On failure</span>
          <span className="text-[11px] font-medium text-[#EF4444]/80">{failureState}</span>
        </div>
      </div>

      {/* Labels applied */}
      {hasLabels && (
        <div className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-fg/40">
          <Tag size={10} style={{ color: "#A78BFA", opacity: 0.7 }} />
          <span>
            {applyLabels.length} label{applyLabels.length > 1 ? "s" : ""} applied
          </span>
        </div>
      )}
    </button>
  );
}
