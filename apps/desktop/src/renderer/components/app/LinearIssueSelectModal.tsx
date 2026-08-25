import React, { useCallback, useState } from "react";
import { Check } from "@phosphor-icons/react";

import type { CtoLinearQuickView, LaneLinearIssue } from "../../../shared/types";
import { canOpenInAdeBrowser, openExternalUrl, openUrlInAdeBrowser } from "../../lib/openExternal";
import { LinearMark, LINEAR_BRAND } from "../lanes/linearBrand";
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
  mode = "attach",
  onOpenChange,
  onSelectIssue,
  onRemoveIssue,
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
  mode?: "attach" | "details";
  onOpenChange: (open: boolean) => void;
  onSelectIssue: (issue: LaneLinearIssue) => void;
  onRemoveIssue?: (issue: LaneLinearIssue) => void;
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
      {mode === "details" ? (
        <LinearIssueDetails
          issue={featuredIssue}
          onOpenChange={onOpenChange}
          onRemoveIssue={onRemoveIssue}
        />
      ) : (
        <LinearIssueBrowser
          projectRoot={projectRoot}
          featuredIssue={featuredIssue}
          featuredIssueLabel={pinnedIssueLabel ?? (pinnedIssue ? "Linked to this lane" : "Selected issue")}
          actionLabel={actionLabel}
          actionBusyLabel={actionBusyLabel}
          actionIcon={<Check size={14} />}
          actionDisabled={actionDisabled}
          showBranchPreview={showBranchPreview}
          singleSelect
          refreshKey={refreshKey}
          onOpenLinearSettings={openLinearSettings}
          onQuickViewChange={setQuickView}
          onLoadingChange={setBrowserLoading}
          onIssueAction={(issue) => {
            onSelectIssue(linearBrowserIssueToLaneIssue(issue));
            onOpenChange(false);
          }}
        />
      )}
    </LinearPaneModal>
  );
}

function LinearIssueDetails({
  issue,
  onOpenChange,
  onRemoveIssue,
}: {
  issue: LaneLinearIssue | null;
  onOpenChange: (open: boolean) => void;
  onRemoveIssue?: (issue: LaneLinearIssue) => void;
}) {
  if (!issue) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-muted-fg/60">
        No Linear issue selected.
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        <div className="flex items-center gap-2">
          <span
            className="grid h-6 w-6 place-items-center rounded-md"
            style={{ background: LINEAR_BRAND.surfaceHover, color: LINEAR_BRAND.primaryBright }}
          >
            <LinearMark size={13} />
          </span>
          <span className="font-mono text-[12px] text-fg/80">{issue.identifier}</span>
          {issue.stateName ? (
            <span className="rounded px-1.5 py-0.5 text-[10px] text-muted-fg/70" style={{ background: "rgba(255,255,255,0.06)" }}>
              {issue.stateName}
            </span>
          ) : null}
        </div>
        <h2 className="mt-3 text-[18px] font-semibold text-fg">{issue.title}</h2>
        {issue.description?.trim() ? (
          <pre className="mt-4 whitespace-pre-wrap font-sans text-[13px] leading-6 text-fg/80">{issue.description}</pre>
        ) : (
          <p className="mt-4 text-[13px] text-muted-fg/50">No description.</p>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-white/10 px-3 py-2">
        {issue.url ? (
          <button
            type="button"
            className="ade-shell-control inline-flex h-7 items-center rounded-md px-2.5 text-[12px]"
            data-variant="ghost"
            onClick={() => {
              if (canOpenInAdeBrowser(issue.url)) openUrlInAdeBrowser(issue.url);
              else openExternalUrl(issue.url);
            }}
          >
            Open
          </button>
        ) : null}
        {onRemoveIssue ? (
          <button
            type="button"
            className="ade-shell-control inline-flex h-7 items-center rounded-md px-2.5 text-[12px]"
            data-variant="ghost"
            onClick={() => {
              onRemoveIssue(issue);
              onOpenChange(false);
            }}
          >
            Remove
          </button>
        ) : null}
      </div>
    </div>
  );
}
