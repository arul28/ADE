import React, { useState } from "react";
import { PackViewer } from "../packs/PackViewer";
import { LanePrPanel } from "../prs/LanePrPanel";
import { LaneConflictsPanel } from "./LaneConflictsPanel";
import { COLORS, MONO_FONT } from "./laneDesignTokens";

type InspectorTab = "context" | "pr" | "conflicts";

const TAB_DEFS: Array<{ id: InspectorTab; num: string; label: string }> = [
  { id: "context", num: "01", label: "CONTEXT" },
  { id: "pr", num: "02", label: "PR" },
  { id: "conflicts", num: "03", label: "CONFLICTS" },
];

export function LaneInspectorPane({
  laneId,
  defaultTab
}: {
  laneId: string | null;
  defaultTab?: InspectorTab;
}) {
  const [tab, setTab] = useState<InspectorTab>(defaultTab ?? "context");

  return (
    <div className="flex h-full flex-col" style={{ background: COLORS.pageBg }}>
      <div
        className="flex items-center gap-0.5 shrink-0"
        style={{ borderBottom: `1px solid ${COLORS.border}` }}
        role="tablist"
        aria-label="Inspector tabs"
      >
        {TAB_DEFS.map((def) => {
          const isActive = tab === def.id;
          return (
            <button
              key={def.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className="relative flex items-center gap-2 px-4 py-2.5 transition-colors duration-150"
              style={{
                fontFamily: MONO_FONT,
                fontSize: 10,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "1px",
                ...(isActive
                  ? {
                      background: COLORS.accentSubtle,
                      borderLeft: `2px solid ${COLORS.accent}`,
                      color: COLORS.textPrimary,
                    }
                  : {
                      background: "transparent",
                      borderLeft: "2px solid transparent",
                      color: COLORS.textMuted,
                    }),
              }}
              onClick={() => setTab(def.id)}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.color = COLORS.textSecondary;
              }}
              onMouseLeave={(e) => {
                if (!isActive) e.currentTarget.style.color = COLORS.textMuted;
              }}
            >
              <span style={{ color: isActive ? COLORS.accent : COLORS.textDim }}>{def.num}</span>
              <span>{def.label}</span>
            </button>
          );
        })}
      </div>
      <div className="flex-1 min-h-0" style={{ padding: 12 }}>
        {tab === "context" && (
          <div className="h-full overflow-auto">
            <PackViewer laneId={laneId} />
          </div>
        )}
        {tab === "pr" && (
          <div className="h-full overflow-auto">
            <LanePrPanel laneId={laneId} />
          </div>
        )}
        {tab === "conflicts" && (
          <div className="h-full">
            <LaneConflictsPanel laneId={laneId} />
          </div>
        )}
      </div>
    </div>
  );
}
