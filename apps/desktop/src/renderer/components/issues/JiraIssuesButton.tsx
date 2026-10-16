import React, { useCallback, useEffect, useState } from "react";
import { JiraMark, JIRA_BRAND } from "../lanes/jiraBrand";
import { LinearPaneModal, type IssuePaneBrand } from "../app/LinearPaneModal";
import { requestIssueCreate } from "../../lib/issueCreateRequests";
import {
  clearPendingJiraIssuesPaneRequest,
  subscribeJiraIssuesPaneRequests,
  takePendingJiraIssuesPaneRequest,
} from "../../lib/issueNavigation";
import { settingsRouteFor } from "../settings/settingsManifest";
import { cn } from "../ui/cn";
import { JiraIssuesPane } from "./JiraIssuesPane";
import { useIssueTopBarPreferences } from "./issueTopBarPreferences";
import { useJiraConnectionStatus } from "./jiraIssueStore";

const JIRA_PANE_BRAND: IssuePaneBrand = {
  surface: JIRA_BRAND.surface,
  surfaceHover: JIRA_BRAND.surfaceHover,
  accent: JIRA_BRAND.primaryBright,
  border: JIRA_BRAND.border,
};

const MENU_ROW_CLASS =
  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] font-medium text-muted-fg/80 transition-colors duration-150 hover:bg-fg/[0.06] hover:text-fg/90";

export function JiraIssuesButton({
  variant = "icon",
  showTrigger = true,
  onMenuActivate,
}: {
  variant?: "icon" | "menu-row";
  showTrigger?: boolean;
  onMenuActivate?: () => void;
}) {
  const preferences = useIssueTopBarPreferences();
  const { status, loading, refresh } = useJiraConnectionStatus(preferences.jira);
  const [open, setOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const openSettings = useCallback(() => {
    window.location.hash = `#${settingsRouteFor("integrations.jira")}`;
  }, []);

  const openPane = useCallback(() => {
    void refresh().then((next) => {
      if (next?.connected) setOpen(true);
      else openSettings();
    });
  }, [openSettings, refresh]);

  useEffect(() => {
    if (variant !== "icon") return undefined;
    if (takePendingJiraIssuesPaneRequest()) openPane();
    return subscribeJiraIssuesPaneRequests(() => {
      clearPendingJiraIssuesPaneRequest();
      openPane();
    });
  }, [openPane, variant]);

  const visible = preferences.jira && status?.connected === true;
  const siteLabel = status?.siteUrl ? new URL(status.siteUrl).host : "Jira";

  const trigger = variant === "menu-row" ? (
    <button
      type="button"
      role="menuitem"
      aria-label="Jira issues"
      className={MENU_ROW_CLASS}
      onClick={() => { openPane(); onMenuActivate?.(); }}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <JiraMark size={12} />
      <span className="min-w-0 flex-1 truncate">Jira issues</span>
    </button>
  ) : (
    <button
      type="button"
      aria-label="Jira issues"
      aria-haspopup="dialog"
      aria-expanded={open}
      title="Jira issues"
      className={cn("ade-shell-control inline-flex h-[20px] w-[20px] items-center justify-center", "transition-[background-color,color,border-color,box-shadow] duration-150")}
      data-state={open ? "open" : undefined}
      onClick={() => (open ? setOpen(false) : openPane())}
      style={{ WebkitAppRegion: "no-drag", color: open ? JIRA_BRAND.primaryBright : undefined } as React.CSSProperties}
    >
      <JiraMark size={16} />
    </button>
  );

  return (
    <>
      {showTrigger && visible ? trigger : null}
      {status?.connected && status.siteUrl ? (
        <LinearPaneModal
          open={open}
          ariaLabel="Jira issues"
          brand={JIRA_PANE_BRAND}
          mark={<JiraMark size={14} />}
          headerTitle={siteLabel}
          headerSubtitle={status.email ?? "Connected"}
          loading={loading}
          refreshTitle="Refresh Jira issues"
          closeTitle="Close Jira issues"
          onRefresh={() => {
            setRefreshKey((key) => key + 1);
            void refresh();
          }}
          onNew={() => requestIssueCreate({ provider: "jira", origin: "pane" })}
          newTitle="New Jira issue"
          onClose={() => setOpen(false)}
        >
          <JiraIssuesPane siteUrl={status.siteUrl} refreshKey={refreshKey} />
        </LinearPaneModal>
      ) : null}
    </>
  );
}

