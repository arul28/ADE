import React, { useCallback, useMemo, useState } from "react";
import { Hash, LinkSimple, MarkdownLogo, TreeStructure } from "@phosphor-icons/react";
import type { JiraCreateMeta, JiraIssueDetail, JiraTransition, JiraUser } from "../../../shared/types/jira";
import { parseJiraError } from "../../../shared/jiraErrors";
import { jiraIssueToLaneIssue } from "../../../shared/laneJiraIssue";
import { makeJiraIssueContextAttachment } from "../../../shared/chatContextAttachments";
import type { IssueRef } from "../../../shared/issueRefs";
import { requestIssueCreate, type IssueCreateRequest } from "../../lib/issueCreateRequests";
import { requestJiraIssuesPaneOpen } from "../../lib/issueNavigation";
import { settingsRouteFor } from "../settings/settingsManifest";
import { JiraMark, JiraStatusIcon } from "../lanes/jiraBrand";
import { showToast } from "../app/toast/toastStore";
import type { ContextMenuEntry } from "../ui/ContextMenu";
import { Banner } from "../ui/notice";
import { JiraIssueView } from "./JiraIssueView";
import {
  addJiraIssueComment,
  editJiraIssue,
  isCompleteJiraIssue,
  loadJiraAssignableUsers,
  loadJiraCreateMeta,
  loadJiraLabels,
  loadJiraIssue,
  transitionJiraIssue,
  useJiraIssue,
} from "./jiraIssueStore";
import {
  copyIssueText,
  IssueActionDock,
  IssueStaleBanner,
  IssueViewerFrame,
  IssueViewerHeader,
  type IssueViewerProps,
} from "./issueViewerParts";
import type { JiraIssueEditing } from "./JiraIssueView";

type JiraRef = Extract<IssueRef, { provider: "jira" }>;

export function JiraIssueViewer({
  jiraRef,
  variant,
  onAttachToChat,
  onViewAll,
  onClose,
  onOpenRelated,
}: IssueViewerProps & { jiraRef: JiraRef }) {
  const entry = useJiraIssue(jiraRef);
  const issue = entry.issue;
  const [transitions, setTransitions] = useState<JiraTransition[]>([]);
  const [assignees, setAssignees] = useState<JiraUser[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [createMeta, setCreateMeta] = useState<JiraCreateMeta | null>(null);
  const label = jiraRef.key;
  const url = issue?.url ?? jiraRef.url ?? `${jiraRef.siteUrl}/browse/${jiraRef.key}`;
  const readOnlyReason = issue && !isCompleteJiraIssue(entry)
    ? entry.error ? "ADE couldn't read the whole issue. Retry to edit it." : "Reading the whole issue from Jira…"
    : issue?.permissions.edit ? null : "This Jira account does not have permission to edit this issue.";

  const loadTransitions = useCallback(async () => {
    if (!issue || !window.ade?.jira?.listTransitions) return;
    try {
      setTransitions(await window.ade.jira.listTransitions({ key: issue.key }));
    } catch (error) {
      showToast({ tone: "error", title: `Couldn't load ${issue.key} statuses`, message: error instanceof Error ? error.message : "Jira request failed." });
    }
  }, [issue]);
  const loadAssignees = useCallback(async () => {
    if (!issue) return;
    try {
      setAssignees(await loadJiraAssignableUsers(entry.projectRoot, { projectKey: issue.projectKey, key: issue.key }));
    } catch (error) {
      showToast({ tone: "error", title: `Couldn't load assignees for ${issue.key}`, message: error instanceof Error ? error.message : "Jira request failed." });
    }
  }, [entry.projectRoot, issue]);
  const loadLabels = useCallback(async () => {
    if (!issue) return;
    try {
      setLabels(await loadJiraLabels(entry.projectRoot));
    } catch (error) {
      showToast({ tone: "error", title: `Couldn't load labels for ${issue.key}`, message: error instanceof Error ? error.message : "Jira request failed." });
    }
  }, [entry.projectRoot, issue]);
  const loadCreateMeta = useCallback(async () => {
    if (!issue) return;
    try {
      setCreateMeta(await loadJiraCreateMeta(entry.projectRoot, issue.projectKey));
    } catch (error) {
      showToast({ tone: "error", title: `Couldn't load priorities for ${issue.key}`, message: error instanceof Error ? error.message : "Jira request failed." });
    }
  }, [entry.projectRoot, issue]);

  const editing = useMemo<JiraIssueEditing | undefined>(() => {
    if (!issue) return undefined;
    const fail = (error: unknown) => showToast({
      tone: "error",
      title: `Couldn't update ${issue.key}`,
      message: error instanceof Error ? error.message : "Jira rejected the change.",
    });
    const edit = (patch: Parameters<typeof editJiraIssue>[3], optimistic: Partial<JiraIssueDetail>) => {
      void editJiraIssue(entry.projectRoot, jiraRef.siteUrl, issue, patch, optimistic).catch(fail);
    };
    return {
      readOnlyReason,
      canTransition: issue.permissions.transition,
      canAssign: issue.permissions.assign,
      canComment: issue.permissions.comment,
      transitions,
      assignees,
      labels,
      createMeta,
      onNeedTransitions: loadTransitions,
      onNeedAssignees: loadAssignees,
      onNeedLabels: loadLabels,
      onNeedCreateMeta: loadCreateMeta,
      onSaveTitle: async (title) => { await editJiraIssue(entry.projectRoot, jiraRef.siteUrl, issue, { title }, { title }); },
      onSaveDescription: async (description) => { await editJiraIssue(entry.projectRoot, jiraRef.siteUrl, issue, { description }, { description }); },
      onSetAssignee: (accountId) => {
        const assignee = accountId ? assignees.find((user) => user.accountId === accountId) ?? issue.assignee : null;
        edit({ assigneeAccountId: accountId }, { assignee });
      },
      onSetPriority: (priorityId) => {
        const priority = createMeta?.priorities.find((item) => item.id === priorityId) ?? issue.priority;
        edit({ priorityId }, { priority });
      },
      onSetLabels: (nextLabels) => edit({ labels: nextLabels }, { labels: nextLabels }),
      onSetDueDate: (dueDate) => edit({ dueDate }, { dueDate }),
      onTransition: (transition) => {
        void transitionJiraIssue(entry.projectRoot, jiraRef.siteUrl, issue, transition).catch(fail);
      },
      onComment: (body) => addJiraIssueComment(entry.projectRoot, jiraRef.siteUrl, issue, body),
    };
  }, [assignees, createMeta, entry.projectRoot, issue, jiraRef.siteUrl, labels, loadAssignees, loadCreateMeta, loadLabels, loadTransitions, readOnlyReason, transitions]);

  const copyEntries = useMemo<ContextMenuEntry[]>(() => (issue ? jiraCopyEntries(issue, variant) : []), [issue, variant]);
  const header = (
    <IssueViewerHeader
      mark={<JiraMark size={14} />}
      label={label}
      state={issue ? <><JiraStatusIcon category={issue.status.category} /><span className="truncate">{issue.status.name}</span></> : null}
      loading={entry.status === "loading" && Boolean(issue)}
      onRefresh={entry.refresh}
      url={url}
      openLabel="Open in Jira"
      copyEntries={copyEntries}
      copyTitle="Copy link, reference or Markdown"
      onViewAll={variant === "sheet" ? () => { onClose?.(); requestJiraIssuesPaneOpen(); } : onViewAll}
      onClose={onClose}
    />
  );

  let body: React.ReactNode;
  if (!issue) {
    body = <JiraLoadState status={entry.status} error={entry.error} jiraRef={jiraRef} url={url} onRetry={entry.refresh} />;
  } else {
    body = (
      <>
        <IssueStaleBanner error={entry.error} onRetry={entry.refresh} />
        {readOnlyReason && isCompleteJiraIssue(entry) ? <JiraPermissionNotice reason={readOnlyReason} onLeave={onClose} /> : null}
        <JiraIssueView
          issue={issue}
          siteUrl={jiraRef.siteUrl}
          projectRoot={entry.projectRoot}
          onOpenRelated={onOpenRelated}
          editing={editing}
        />
      </>
    );
  }

  return (
    <IssueViewerFrame
      variant={variant}
      ariaLabel={`Jira issue ${jiraRef.key}`}
      header={header}
      dock={issue ? (
        <IssueActionDock
          label={issue.key}
          onLaunch={(laneOnly) => showToast({
            tone: "info",
            title: laneOnly ? "Jira lane creation is coming soon" : "Jira agent launch is coming soon",
            message: "Jira issue launch will be connected in the shared launcher.",
          })}
          attachment={() => {
            const laneIssue = jiraIssueToLaneIssue(issue, jiraRef.siteUrl);
            if (!laneIssue) throw new Error("Jira issue details are incomplete.");
            return makeJiraIssueContextAttachment(laneIssue);
          }}
          onAttachToChat={onAttachToChat}
        />
      ) : null}
    >
      {body}
    </IssueViewerFrame>
  );
}

function jiraCopyEntries(issue: JiraIssueDetail, variant: IssueViewerProps["variant"]): ContextMenuEntry[] {
  const markdown = `[${issue.key} ${issue.title}](${issue.url})`;
  return [
    {
      kind: "item",
      key: "sub-issue",
      label: "New sub-issue",
      icon: TreeStructure,
      onSelect: () => requestIssueCreate({
        provider: "jira",
        // The shared request channel currently has no Jira variant; the
        // composer reads this extended shape at runtime.
        prefill: { parent: { provider: "jira", siteUrl: issue.url.split("/browse/")[0]!, key: issue.key } },
        origin: variant === "pane" ? "pane" : null,
      } as unknown as IssueCreateRequest),
    },
    { kind: "item", key: "link", label: "Copy link", icon: LinkSimple, onSelect: () => copyIssueText(issue.url, "link") },
    { kind: "item", key: "ref", label: "Copy reference", icon: Hash, onSelect: () => copyIssueText(issue.key, issue.key) },
    { kind: "item", key: "markdown", label: "Copy as Markdown", icon: MarkdownLogo, onSelect: () => copyIssueText(markdown, "Markdown link") },
  ];
}

function openSettings(onLeave?: () => void): void {
  onLeave?.();
  window.location.hash = `#${settingsRouteFor("integrations.jira")}`;
}

function JiraPermissionNotice({ reason, onLeave }: { reason: string; onLeave?: () => void }) {
  return (
    <div className="px-4 pt-3">
      <Banner
        layout="inline"
        model={{
          id: "jira-issue-read-only",
          tone: "info",
          title: "Read-only: Jira permissions are limited",
          detail: reason,
          actions: [{ label: "Jira settings", onClick: () => openSettings(onLeave) }],
        }}
      />
    </div>
  );
}

function JiraLoadState({
  status,
  error,
  jiraRef,
  url,
  onRetry,
}: {
  status: string;
  error: string | null;
  jiraRef: JiraRef;
  url: string;
  onRetry: () => void;
}) {
  if (status !== "missing" && status !== "error") {
    return <div className="px-5 py-6 text-[12px] text-[color:var(--kit-text-3)]">Loading {jiraRef.key}…</div>;
  }
  const parsed = parseJiraError(error);
  const retryAt = parsed?.retryAt ? new Date(parsed.retryAt) : null;
  const retryTime = retryAt && Number.isFinite(retryAt.getTime()) ? retryAt.toLocaleTimeString() : null;
  const message = parsed?.message ?? error ?? "Jira request failed.";
  let title = `Couldn't load ${jiraRef.key}`;
  let detail = message;
  let showSettingsAction = false;
  if (parsed?.reason === "not-connected") {
    title = "Connect Jira to open this issue";
    detail = `${jiraRef.siteUrl} is not connected on this machine.`;
    showSettingsAction = true;
  } else if (parsed?.reason === "unauthenticated") {
    title = "Jira rejected the saved API token";
    detail = "Update the site URL, email or API token in Jira settings.";
    showSettingsAction = true;
  } else if (parsed?.reason === "forbidden") {
    title = `Your Jira account cannot read ${jiraRef.key}`;
    detail = "Ask a Jira administrator for access to this project or issue.";
  } else if (parsed?.reason === "rate-limited") {
    title = "Jira is rate-limiting requests";
    detail = retryTime ? `Try again after ${retryTime}. ${message}` : message;
  } else if (parsed?.reason === "not-found" || status === "missing") {
    title = `Jira didn't return ${jiraRef.key}`;
    detail = "Check that the issue exists and that ADE is connected to the right Jira site.";
  }
  return (
    <div className="p-4">
      <Banner
        layout="inline"
        model={{
          id: `jira-issue-${parsed?.reason ?? status}`,
          tone: parsed?.reason === "failed" ? "error" : "warning",
          title,
          detail,
          actions: [
            ...(showSettingsAction ? [{ label: parsed?.reason === "not-connected" ? "Connect Jira" : "Jira settings", onClick: () => openSettings() }] : []),
            { label: "Retry", onClick: onRetry },
            { label: "Open in Jira", href: url },
          ],
        }}
      />
    </div>
  );
}
