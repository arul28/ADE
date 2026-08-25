import React, { useCallback, useState } from "react";
import { GithubLogo } from "@phosphor-icons/react";

import type { LaneGitHubIssue } from "../../../shared/types";
import { GitHubIssueBrowser } from "./GitHubIssueBrowser";
import { LinearPaneModal } from "./LinearPaneModal";
import { GITHUB_BRAND } from "../lanes/githubBrand";

const GITHUB_PANE_BRAND = {
  surface: GITHUB_BRAND.surface,
  surfaceHover: GITHUB_BRAND.surfaceHover,
  accent: GITHUB_BRAND.primaryBright,
  border: GITHUB_BRAND.border,
} as const;

export function GitHubIssueSelectModal({
  open,
  ariaLabel = "Select GitHub issue",
  selectedIssue,
  mode = "attach",
  actionLabel = "Attach issue",
  actionBusyLabel,
  actionDisabled = false,
  onOpenChange,
  onSelectIssue,
  onRemoveIssue,
}: {
  open: boolean;
  ariaLabel?: string;
  selectedIssue: LaneGitHubIssue | null;
  mode?: "attach" | "details";
  actionLabel?: string;
  actionBusyLabel?: string;
  actionDisabled?: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectIssue: (issue: LaneGitHubIssue) => void;
  onRemoveIssue?: (issue: LaneGitHubIssue) => void;
}) {
  const [browserLoading, setBrowserLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [repoLabel, setRepoLabel] = useState<string | null>(null);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  return (
    <LinearPaneModal
      open={open}
      ariaLabel={ariaLabel}
      loading={browserLoading}
      brand={GITHUB_PANE_BRAND}
      mark={<GithubLogo size={14} weight="fill" />}
      headerTitle="GitHub"
      headerSubtitle={repoLabel ?? "Current repository"}
      refreshTitle="Refresh GitHub"
      closeTitle="Close GitHub"
      onRefresh={() => setRefreshKey((key) => key + 1)}
      onClose={close}
    >
      <GitHubIssueBrowser
        selectedIssue={selectedIssue}
        mode={mode}
        actionLabel={browserLoading ? (actionBusyLabel ?? actionLabel) : actionLabel}
        actionDisabled={actionDisabled || browserLoading}
        refreshKey={refreshKey}
        onLoadingChange={setBrowserLoading}
        onRepoChange={(repo) => setRepoLabel(repo ? `${repo.owner}/${repo.name}` : null)}
        onIssueAction={(issue) => {
          onSelectIssue(issue);
          onOpenChange(false);
        }}
        onRemoveIssue={onRemoveIssue ? (issue) => {
          onRemoveIssue(issue);
          onOpenChange(false);
        } : undefined}
      />
    </LinearPaneModal>
  );
}
