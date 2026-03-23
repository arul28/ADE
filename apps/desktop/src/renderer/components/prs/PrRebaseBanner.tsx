import React from "react";
import { Warning, XCircle } from "@phosphor-icons/react";
import type { RebaseNeed, AutoRebaseLaneStatus } from "../../../shared/types";

type PrRebaseBannerProps = {
  laneId: string;
  rebaseNeeds: RebaseNeed[];
  autoRebaseStatuses?: AutoRebaseLaneStatus[];
  onTabChange: (tab: string) => void;
};

export function PrRebaseBanner({ laneId, rebaseNeeds, autoRebaseStatuses, onTabChange }: PrRebaseBannerProps) {
  const [dismissed, setDismissed] = React.useState(false);
  const [syncBusy, setSyncBusy] = React.useState(false);

  const need = rebaseNeeds.find((n) => n.laneId === laneId);
  const autoStatus = autoRebaseStatuses?.find((s) => s.laneId === laneId);
  const hasAutoRebaseError = autoStatus?.state === "rebaseConflict";

  // Reset dismissed state when lane changes
  React.useEffect(() => {
    setDismissed(false);
  }, [laneId]);

  if (dismissed) return null;
  if (hasAutoRebaseError) {
    return (
      <div
        style={{
          background: "#EF44440A",
          border: "1px solid #EF444430",
          padding: "10px 14px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div className="flex items-center" style={{ gap: 8, minWidth: 0 }}>
          <XCircle size={14} weight="fill" style={{ color: "#EF4444", flexShrink: 0 }} />
          <span className="font-mono font-bold uppercase" style={{ fontSize: 10, letterSpacing: "1px", color: "#FCA5A5" }}>
            AUTO-REBASE FAILED — conflicts need manual resolution
          </span>
        </div>
        <button
          type="button"
          className="font-mono font-bold uppercase tracking-[1px]"
          style={{
            fontSize: 10,
            padding: "4px 10px",
            background: "transparent",
            color: "#EF4444",
            border: "1px solid #EF444440",
            cursor: "pointer",
            flexShrink: 0,
          }}
          onClick={() => onTabChange("rebase")}
        >
          RESOLVE IN REBASE TAB
        </button>
      </div>
    );
  }

  if (!need || need.behindBy === 0) return null;

  const handleSync = async () => {
    setSyncBusy(true);
    try {
      await window.ade.rebase.execute({ laneId, aiAssisted: true });
    } catch {
      /* swallow — user can use rebase tab for details */
    } finally {
      setSyncBusy(false);
    }
  };

  const handleDismiss = async () => {
    try {
      await window.ade.rebase.dismiss(laneId);
    } catch {
      /* swallow */
    }
    setDismissed(true);
  };

  return (
    <div
      style={{
        background: "#F59E0B0A",
        border: "1px solid #F59E0B30",
        padding: "10px 14px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <div className="flex items-center" style={{ gap: 8, minWidth: 0 }}>
        <Warning size={14} weight="fill" style={{ color: "#F59E0B", flexShrink: 0 }} />
        <span className="font-mono font-bold" style={{ fontSize: 11, color: "#F5D08B" }}>
          {need.behindBy} commit{need.behindBy !== 1 ? "s" : ""} behind {need.baseBranch}
          {need.conflictPredicted
            ? " — conflicts predicted, rebase required"
            : " — no conflicts, rebase recommended"}
        </span>
      </div>
      <div className="flex items-center" style={{ gap: 6, flexShrink: 0 }}>
        <button
          type="button"
          disabled={syncBusy}
          className="font-mono font-bold uppercase tracking-[1px]"
          style={{
            fontSize: 10,
            padding: "4px 10px",
            background: "transparent",
            color: "#F59E0B",
            border: "1px solid #F59E0B40",
            cursor: syncBusy ? "not-allowed" : "pointer",
            opacity: syncBusy ? 0.5 : 1,
          }}
          onClick={() => void handleSync()}
        >
          {syncBusy ? "REBASING..." : "REBASE NOW (LOCAL ONLY)"}
        </button>
        <button
          type="button"
          className="font-mono font-bold uppercase tracking-[1px]"
          style={{
            fontSize: 10,
            padding: "4px 10px",
            background: "transparent",
            color: "#A1A1AA",
            border: "1px solid #27272A",
            cursor: "pointer",
          }}
          onClick={() => onTabChange("rebase")}
        >
          VIEW REBASE DETAILS
        </button>
        <button
          type="button"
          className="font-mono font-bold uppercase tracking-[1px]"
          style={{
            fontSize: 10,
            padding: "4px 10px",
            background: "transparent",
            color: "#71717A",
            border: "1px solid #27272A",
            cursor: "pointer",
          }}
          onClick={() => void handleDismiss()}
        >
          DISMISS
        </button>
      </div>
    </div>
  );
}
