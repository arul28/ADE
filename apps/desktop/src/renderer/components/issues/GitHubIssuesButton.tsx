import React, { useCallback, useEffect, useState } from "react";
import { GithubLogo } from "@phosphor-icons/react";
import {
  clearPendingGitHubIssuesPaneRequest,
  subscribeGitHubIssuesPaneRequests,
  takePendingGitHubIssuesPaneRequest,
} from "../../lib/githubIssuesPaneRequests";
import { LinearPaneModal, type IssuePaneBrand } from "../app/LinearPaneModal";
import { requestIssueCreate } from "../../lib/issueCreateRequests";
import { GITHUB_BRAND } from "../lanes/githubBrand";
import { cn } from "../ui/cn";
import { GitHubIssuesPane } from "./GitHubIssuesPane";
import { refreshGitHubIssueSummary, useGitHubIssueSummary, useProjectGitHubRepo } from "./githubIssueStore";
import { useIssueTopBarPreferences } from "./issueTopBarPreferences";

const GITHUB_PANE_BRAND: IssuePaneBrand = {
  surface: GITHUB_BRAND.surface,
  surfaceHover: GITHUB_BRAND.surfaceHover,
  accent: GITHUB_BRAND.primaryBright,
  border: GITHUB_BRAND.border,
};

const MENU_ROW_CLASS =
  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] font-medium text-muted-fg/80 transition-colors duration-150 hover:bg-fg/[0.06] hover:text-fg/90";

/**
 * The GitHub Issues button in the top bar, beside Linear.
 *
 * Shown only when it has something to show: the setting is on, the project's
 * origin is a GitHub repository with issues enabled, and at least one issue is
 * open. The count comes from one cached GraphQL point (see `githubIssueStore`),
 * so the button costs nothing while the pane is closed.
 */
export function GitHubIssuesButton({
  variant = "icon",
  showTrigger = true,
  onMenuActivate,
}: {
  variant?: "icon" | "menu-row";
  showTrigger?: boolean;
  onMenuActivate?: () => void;
}) {
  const preferences = useIssueTopBarPreferences();
  const { repo } = useProjectGitHubRepo();
  const summary = useGitHubIssueSummary(preferences.github ? repo : null);
  const [open, setOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const openPane = useCallback(() => {
    setOpen(true);
    if (repo) refreshGitHubIssueSummary(repo, { force: true });
  }, [repo]);

  // "All issues" from the issue sheet, answered by the one icon instance.
  useEffect(() => {
    if (variant !== "icon") return undefined;
    if (takePendingGitHubIssuesPaneRequest()) setOpen(true);
    return subscribeGitHubIssuesPaneRequests(() => {
      clearPendingGitHubIssuesPaneRequest();
      setOpen(true);
    });
  }, [variant]);

  const visible = preferences.github
    && repo != null
    && summary?.hasIssuesEnabled === true
    && summary.openCount > 0;
  const countLabel = summary ? `${summary.openCount} open` : "";

  const trigger = variant === "menu-row" ? (
    <button
      type="button"
      role="menuitem"
      aria-label="GitHub issues"
      className={MENU_ROW_CLASS}
      onClick={() => {
        openPane();
        onMenuActivate?.();
      }}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <GithubLogo size={12} weight="fill" />
      <span className="min-w-0 flex-1 truncate">GitHub issues</span>
    </button>
  ) : (
    <button
      type="button"
      aria-label="GitHub issues"
      aria-haspopup="dialog"
      aria-expanded={open}
      title="GitHub issues"
      className={cn(
        "ade-shell-control inline-flex h-[20px] w-[20px] items-center justify-center",
        "transition-[background-color,color,border-color,box-shadow] duration-150",
      )}
      data-state={open ? "open" : undefined}
      onClick={() => (open ? setOpen(false) : openPane())}
      style={{
        WebkitAppRegion: "no-drag",
        color: open ? GITHUB_BRAND.primaryBright : undefined,
      } as React.CSSProperties}
    >
      <GithubLogo size={16} weight="fill" />
    </button>
  );

  return (
    <>
      {showTrigger && visible ? trigger : null}
      {repo ? (
        <LinearPaneModal
          open={open}
          ariaLabel="GitHub issues"
          brand={GITHUB_PANE_BRAND}
          mark={<GithubLogo size={14} weight="fill" />}
          headerTitle={`${repo.owner}/${repo.name}`}
          headerSubtitle={summary ? `Issues · ${countLabel}` : "Issues"}
          refreshTitle="Refresh GitHub issues"
          closeTitle="Close GitHub issues"
          onRefresh={() => {
            setRefreshKey((key) => key + 1);
            refreshGitHubIssueSummary(repo, { force: true });
          }}
          onNew={() => requestIssueCreate({ provider: "github", origin: "pane" })}
          newTitle="New GitHub issue"
          onClose={() => setOpen(false)}
        >
          <GitHubIssuesPane repo={repo} refreshKey={refreshKey} />
        </LinearPaneModal>
      ) : null}
    </>
  );
}
