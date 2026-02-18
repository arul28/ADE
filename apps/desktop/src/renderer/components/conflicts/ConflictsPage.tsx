import React from "react";
import { cn } from "../ui/cn";
import { ConflictsProvider, useConflictsState, useConflictsDispatch } from "./state/ConflictsContext";
import { MergeOneLaneTab } from "./tabs/MergeOneLaneTab";
import { MergeMultipleLanesTab } from "./tabs/MergeMultipleLanesTab";
import type { ActiveTab } from "./state/types";

const TABS: { id: ActiveTab; label: string }[] = [
  { id: "merge-one", label: "Merge One Lane" },
  { id: "merge-multiple", label: "Merge Multiple Lanes" },
];

function ConflictsPageInner() {
  const { activeTab } = useConflictsState();
  const dispatch = useConflictsDispatch();

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-border/50 bg-card/30 px-3 py-1">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => dispatch({ type: "SET_ACTIVE_TAB", tab: tab.id })}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
              activeTab === tab.id
                ? "bg-accent/15 text-accent"
                : "text-muted-fg hover:text-fg hover:bg-muted/30"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Active tab content */}
      <div className="min-h-0 flex-1">
        {activeTab === "merge-one" ? <MergeOneLaneTab /> : <MergeMultipleLanesTab />}
      </div>
    </div>
  );
}

export function ConflictsPage() {
  return (
    <ConflictsProvider>
      <ConflictsPageInner />
    </ConflictsProvider>
  );
}
