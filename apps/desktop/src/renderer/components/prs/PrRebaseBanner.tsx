import React from "react";
import { GitBranch } from "@phosphor-icons/react";
import type { RebaseNeed, AutoRebaseLaneStatus } from "../../../shared/types";
import { findLaneBaseNeed } from "./shared/rebaseNeedUtils";
import { Banner } from "../ui/notice";

type PrRebaseBannerProps = {
  laneId: string;
  rebaseNeeds: RebaseNeed[];
  autoRebaseStatuses?: AutoRebaseLaneStatus[];
  onTabChange: (tab: string) => void;
  onRefresh?: () => Promise<void> | void;
  onRebaseDone?: () => Promise<void> | void;
};

export function PrRebaseBanner({ laneId, rebaseNeeds, autoRebaseStatuses, onTabChange, onRefresh, onRebaseDone }: PrRebaseBannerProps) {
  const [dismissed, setDismissed] = React.useState(false);
  const [syncBusy, setSyncBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const need = React.useMemo(() => {
    const laneNeed = findLaneBaseNeed(rebaseNeeds, laneId);
    if (!laneNeed || laneNeed.behindBy <= 0) return null;
    return laneNeed;
  }, [laneId, rebaseNeeds]);
  const autoStatus = autoRebaseStatuses?.find((s) => s.laneId === laneId);
  const hasAutoRebaseError = autoStatus?.state === "rebaseConflict" || autoStatus?.state === "rebaseFailed";

  // Reset dismissed state when lane changes
  React.useEffect(() => {
    setDismissed(false);
    setActionError(null);
  }, [laneId]);

  if (dismissed) return null;
  if (hasAutoRebaseError) {
    return (
      <Banner
        layout="inline"
        model={{
          id: `pr-rebase-failed:${laneId}`,
          tone: "error",
          title: "Auto-rebase failed — manual follow-up required",
          actions: [{ label: "Resolve in rebase tab", onClick: () => onTabChange("rebase") }],
        }}
      />
    );
  }

  if (!need || need.behindBy === 0) return null;

  const handleSync = async () => {
    setSyncBusy(true);
    setActionError(null);
    try {
      await window.ade.rebase.execute({ laneId, aiAssisted: true });
      await onRefresh?.();
      if (onRebaseDone && onRebaseDone !== onRefresh) {
        await onRebaseDone();
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSyncBusy(false);
    }
  };

  const handleDismiss = async () => {
    setActionError(null);
    try {
      await window.ade.lanes.dismissRebaseSuggestion({ laneId });
      await onRefresh?.();
      setDismissed(true);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <Banner
      layout="inline"
      model={{
        id: `pr-rebase:${laneId}`,
        tone: "warning",
        icon: <GitBranch size={13} weight="bold" />,
        title: `${need.behindBy} commit${need.behindBy !== 1 ? "s" : ""} behind ${need.baseBranch}${
          need.conflictPredicted ? " — conflicts predicted, rebase required" : " — no conflicts, rebase recommended"
        }`,
        busy: syncBusy,
        actions: [
          {
            label: syncBusy ? "Rebasing..." : "Rebase now (local only)",
            onClick: () => void handleSync(),
            disabled: syncBusy,
          },
          { label: "View rebase details", onClick: () => onTabChange("rebase") },
          { label: "Hide banner", variant: "link", onClick: () => void handleDismiss() },
        ],
        error: actionError ?? undefined,
      }}
    />
  );
}
