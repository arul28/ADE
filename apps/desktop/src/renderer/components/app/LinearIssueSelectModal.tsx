import React, { useCallback, useState } from "react";
import { Check } from "@phosphor-icons/react";

import type { CtoLinearQuickView, LaneLinearIssue } from "../../../shared/types";
import { LinearIssueBrowser, linearBrowserIssueToLaneIssue } from "./LinearIssueBrowser";
import { LinearPaneModal } from "./LinearPaneModal";

export function LinearIssueSelectModal({
  open,
  ariaLabel = "Select Linear issue",
  projectRoot,
  selectedIssue,
  pinnedIssue,
  pinnedIssueLabel,
  actionLabel = "Connect issue",
  actionBusyLabel,
  actionDisabled = false,
  showBranchPreview = true,
  onOpenChange,
  onSelectIssue,
  onOpenLinearSettings,
}: {
  open: boolean;
  ariaLabel?: string;
  projectRoot?: string | null;
  selectedIssue: LaneLinearIssue | null;
  pinnedIssue?: LaneLinearIssue | null;
  pinnedIssueLabel?: string;
  actionLabel?: string;
  actionBusyLabel?: string;
  actionDisabled?: boolean;
  showBranchPreview?: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectIssue: (issue: LaneLinearIssue) => void;
  onOpenLinearSettings?: () => void;
}) {
  const featuredIssue = pinnedIssue ?? selectedIssue;
  const [quickView, setQuickView] = useState<CtoLinearQuickView | null>(null);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const openLinearSettings = useCallback(() => {
    onOpenChange(false);
    onOpenLinearSettings?.();
  }, [onOpenChange, onOpenLinearSettings]);

  return (
    <LinearPaneModal
      open={open}
      ariaLabel={ariaLabel}
      quickView={quickView}
      loading={browserLoading}
      onRefresh={() => setRefreshKey((key) => key + 1)}
      onClose={close}
    >
      <LinearIssueBrowser
        projectRoot={projectRoot}
        featuredIssue={featuredIssue}
        featuredIssueLabel={pinnedIssueLabel ?? (pinnedIssue ? "Linked to this lane" : "Selected issue")}
        actionLabel={actionLabel}
        actionBusyLabel={actionBusyLabel}
        actionIcon={<Check size={14} />}
        actionDisabled={actionDisabled}
        showBranchPreview={showBranchPreview}
        refreshKey={refreshKey}
        onOpenLinearSettings={openLinearSettings}
        onQuickViewChange={setQuickView}
        onLoadingChange={setBrowserLoading}
        onIssueAction={(issue) => {
          onSelectIssue(linearBrowserIssueToLaneIssue(issue));
          onOpenChange(false);
        }}
      />
    </LinearPaneModal>
  );
}
