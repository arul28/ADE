import React, { useMemo } from "react";
import { ChatCircleText, CircleNotch, GithubLogo, GitBranch, Hash, LinkSimple, MarkdownLogo, Plus, Sparkle, TreeStructure } from "@phosphor-icons/react";
import type { LaneSummary } from "../../../shared/types";
import { githubIssueToContextAttachment } from "./githubIssueStore";
import { requestGitHubIssueLaunch } from "./githubIssueLaunch";
import { requestIssueCreate } from "../../lib/issueCreateRequests";
import type { IssueRef } from "../../../shared/issueRefs";
import { useAppStore } from "../../state/appStore";
import { navigateToAppTarget } from "../../lib/openExternal";
import { showToast } from "../app/toast/toastStore";
import { GitHubIssueStateIcon, githubIssueStateLabel } from "../lanes/githubBrand";
import { Button } from "../ui/Button";
import type { ContextMenuEntry } from "../ui/ContextMenu";
import { Banner } from "../ui/notice";
import { GitHubIssueView } from "./GitHubIssueView";
import {
  commentOnGitHubIssue,
  editGitHubIssue,
  loadGitHubRepoCatalog,
  useGitHubIssue,
  useGitHubIssueWriteAccess,
  useGitHubRepoCatalog,
  type GitHubIssueDetail,
} from "./githubIssueStore";
import type { GitHubIssueEditing } from "./GitHubIssueView";
import type { GitHubIssueWriteAccess } from "../../../shared/types";
import { settingsRouteFor } from "../settings/settingsManifest";
import { copyIssueText, IssueViewerHeader, LinkedInAdeLanes, type IssueViewerProps } from "./issueViewerParts";

type GitHubRef = Extract<IssueRef, { provider: "github" }>;

export function GitHubIssueViewer({
  githubRef,
  variant,
  onAttachToChat,
  onViewAll,
  onClose,
}: IssueViewerProps & { githubRef: GitHubRef }) {
  const entry = useGitHubIssue({ owner: githubRef.owner, repo: githubRef.repo, number: githubRef.number });
  const issue = entry.issue;
  const label = `#${githubRef.number}`;
  const url = issue?.url ?? githubRef.url ?? `https://github.com/${githubRef.owner}/${githubRef.repo}/issues/${githubRef.number}`;
  const copyEntries = useMemo<ContextMenuEntry[]>(() => (issue ? githubCopyEntries(issue, variant) : []), [issue, variant]);
  const repo = useMemo(() => ({ owner: githubRef.owner, name: githubRef.repo }), [githubRef.owner, githubRef.repo]);
  const access = useGitHubIssueWriteAccess(repo);
  const catalog = useGitHubRepoCatalog(repo);
  const readOnlyReason = issueReadOnlyReason(access);
  const editing = useMemo<GitHubIssueEditing | undefined>(() => {
    if (!issue) return undefined;
    const fail = (error: unknown) => {
      showToast({
        tone: "error",
        title: `Couldn't update #${issue.number}`,
        message: error instanceof Error ? error.message : "GitHub rejected the change.",
      });
    };
    return {
      readOnlyReason,
      catalog,
      onNeedCatalog: () => loadGitHubRepoCatalog(repo),
      onPatch: (patch, optimistic) => {
        void editGitHubIssue(entry.projectRoot, issue, patch, optimistic).catch(fail);
      },
      onSaveTitle: (title) => editGitHubIssue(entry.projectRoot, issue, { title }, { title }),
      onSaveBody: (body) => editGitHubIssue(entry.projectRoot, issue, { body }, { body }),
      onComment: async (body) => {
        await commentOnGitHubIssue(issue, body);
        // The count on the issue feeds the activity header and the list rows.
        entry.refresh();
      },
    };
  }, [catalog, entry, issue, readOnlyReason, repo]);

  const header = (
    <IssueViewerHeader
      mark={<GithubLogo size={14} weight="fill" />}
      label={label}
      state={issue ? (
        <>
          <GitHubIssueStateIcon state={issue.state} stateReason={issue.stateReason} />
          <span className="truncate">{githubIssueStateLabel(issue.state, issue.stateReason)}</span>
        </>
      ) : null}
      loading={entry.status === "loading" && Boolean(issue)}
      onRefresh={entry.refresh}
      url={url}
      openLabel="Open on GitHub"
      copyEntries={copyEntries}
      copyTitle="Copy link, reference, Markdown"
      onViewAll={onViewAll}
      onClose={onClose}
    />
  );

  let body: React.ReactNode;
  if (!issue) {
    body = <GitHubLoadState status={entry.status} error={entry.error} githubRef={githubRef} url={url} onRetry={entry.refresh} />;
  } else if (issue.isPullRequest) {
    // GitHub numbers issues and pull requests from one sequence, and an
    // `/issues/N` link to a pull request still resolves.
    body = (
      <div className="p-4">
        <Banner
          layout="inline"
          model={{
            id: "issue-is-pr",
            tone: "info",
            title: `${githubRef.owner}/${githubRef.repo}#${githubRef.number} is a pull request`,
            detail: "GitHub numbers issues and pull requests from one sequence.",
            actions: [
              {
                label: "Open pull request",
                onClick: () => {
                  onClose?.();
                  navigateToAppTarget({
                    kind: "pr",
                    prNumber: githubRef.number,
                    repoOwner: githubRef.owner,
                    repoName: githubRef.repo,
                  });
                },
              },
              { label: "Open on GitHub", href: url },
            ],
          }}
        />
      </div>
    );
  } else {
    body = (
      <>
        {entry.error ? (
          <div className="px-4 pt-3">
            <Banner
              layout="inline"
              model={{
                id: "issue-refresh-failed",
                tone: "warning",
                title: "Showing the last copy ADE read",
                detail: entry.error,
                actions: [{ label: "Retry", onClick: entry.refresh }],
              }}
            />
          </div>
        ) : null}
        {access && !access.writeSource ? <WriteAccessNotice access={access} onLeave={onClose} /> : null}
        <GitHubIssueView
          issue={issue}
          activityDefaultOpen
          sideExtra={<GitHubLinkedInAde issue={issue} />}
          editing={editing}
        />
      </>
    );
  }

  return (
    <section className="ade-issue-frame" data-issue-viewer={variant} aria-label={`GitHub issue ${githubRef.owner}/${githubRef.repo}#${githubRef.number}`}>
      {header}
      <div className="ade-issue-frame-scroll">{body}</div>
      {issue && !issue.isPullRequest ? (
        <div className="ade-issue-frame-dock">
          <Button
            type="button"
            variant="primary"
            casing="sentence"
            className="shrink-0 gap-1.5 px-3"
            title="New lane for this issue, plus an agent started on it"
            onClick={() => {
              if (variant === "sheet") onClose?.();
              requestGitHubIssueLaunch(issue);
            }}
          >
            <Sparkle size={13} weight="fill" />
            Launch agent
          </Button>
          <Button
            type="button"
            variant="outline"
            casing="sentence"
            className="shrink-0 gap-1.5 px-3"
            title="New lane for this issue. Start an agent later."
            onClick={() => {
              if (variant === "sheet") onClose?.();
              requestGitHubIssueLaunch(issue, { laneOnly: true });
            }}
          >
            <Plus size={13} weight="bold" />
            Lane only
          </Button>
          {onAttachToChat ? (
            <Button
              type="button"
              variant="outline"
              casing="sentence"
              className="shrink-0 gap-1.5 px-3"
              title="Add this issue to the chat's next message as context"
              onClick={() => {
                try {
                  onAttachToChat(githubIssueToContextAttachment(issue));
                } catch (error) {
                  showToast({
                    tone: "warning",
                    title: `Couldn't attach #${issue.number}`,
                    message: error instanceof Error ? error.message : "There is no chat to attach it to.",
                  });
                }
              }}
            >
              <ChatCircleText size={13} />
              Attach to chat
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Why edits are off, or null when an issue edit has a credential to use. */
function issueReadOnlyReason(access: GitHubIssueWriteAccess | null): string | null {
  if (!access) return "Checking whether ADE can edit issues here…";
  if (access.writeSource) return null;
  if (access.app?.installed && access.app.issuesPermission !== "write") {
    return "ADE's GitHub App can't edit issues until its Issues permission is approved.";
  }
  return "Connect GitHub CLI or add a token in Settings to edit issues.";
}

/** Said once, above the issue, with the action that fixes it. */
function WriteAccessNotice({ access, onLeave }: { access: GitHubIssueWriteAccess; onLeave?: () => void }) {
  const needsApproval = Boolean(access.app?.installed && access.app.issuesPermission !== "write");
  const openSettings = () => {
    onLeave?.();
    window.location.hash = `#${settingsRouteFor("integrations.github")}`;
  };
  return (
    <div className="px-4 pt-3">
      <Banner
        layout="inline"
        model={{
          id: "github-issue-read-only",
          tone: "info",
          title: needsApproval ? "Approve ADE's Issues permission to edit here" : "Read-only: no GitHub credential can edit issues",
          detail: needsApproval
            ? "An owner of the account approves it on GitHub. GitHub CLI or a token also works."
            : "Connect GitHub CLI or add a token with repository access.",
          actions: [
            ...(needsApproval && access.app?.manageUrl ? [{ label: "Review on GitHub", href: access.app.manageUrl }] : []),
            { label: "GitHub settings", onClick: openSettings },
          ],
        }}
      />
    </div>
  );
}

function GitHubLoadState({
  status,
  error,
  githubRef,
  url,
  onRetry,
}: {
  status: string;
  error: string | null;
  githubRef: GitHubRef;
  url: string;
  onRetry: () => void;
}) {
  const name = `${githubRef.owner}/${githubRef.repo}#${githubRef.number}`;
  if (status !== "missing" && status !== "error") {
    return (
      <div className="flex items-center gap-2 px-5 py-6 text-[12px] text-[color:var(--kit-text-3)]">
        <CircleNotch size={13} className="animate-spin" />
        Loading {name}…
      </div>
    );
  }
  return (
    <div className="p-4">
      <Banner
        layout="inline"
        model={status === "missing"
          ? {
            id: "issue-missing",
            tone: "warning",
            title: `GitHub didn't return ${name}`,
            detail: "The GitHub connection ADE uses may not have access to this repository, or the issue was deleted.",
            actions: [{ label: "Open on GitHub", href: url }, { label: "Retry", onClick: onRetry }],
          }
          : {
            id: "issue-error",
            tone: "error",
            title: `Couldn't load ${name}`,
            detail: error ?? "GitHub request failed.",
            actions: [{ label: "Retry", onClick: onRetry }, { label: "Open on GitHub", href: url }],
          }}
      />
    </div>
  );
}

function githubCopyEntries(issue: GitHubIssueDetail, variant: IssueViewerProps["variant"]): ContextMenuEntry[] {
  const reference = `${issue.owner}/${issue.repo}#${issue.number}`;
  return [
    {
      kind: "item",
      key: "sub-issue",
      label: "New sub-issue",
      icon: TreeStructure,
      onSelect: () => requestIssueCreate({
        provider: "github",
        prefill: { parent: { provider: "github", owner: issue.owner, repo: issue.repo, number: issue.number } },
        origin: variant === "pane" ? "pane" : null,
      }),
    },
    { kind: "item", key: "link", label: "Copy link", icon: LinkSimple, onSelect: () => copyIssueText(issue.url, "link") },
    { kind: "item", key: "ref", label: "Copy reference", icon: Hash, onSelect: () => copyIssueText(reference, reference) },
    {
      kind: "item",
      key: "closes",
      label: "Copy closing keyword",
      icon: GitBranch,
      title: "For a pull request body: closes the issue when the PR merges",
      onSelect: () => copyIssueText(`Fixes ${reference}`, "closing keyword"),
    },
    {
      kind: "item",
      key: "markdown",
      label: "Copy as Markdown",
      icon: MarkdownLogo,
      onSelect: () => copyIssueText(`[${reference} ${issue.title}](${issue.url})`, "Markdown link"),
    },
  ];
}

function GitHubLinkedInAde({ issue }: { issue: GitHubIssueDetail }) {
  const lanes = useAppStore((state) => state.lanes);
  const linked = useMemo(() => lanesLinkedToGitHubIssue(lanes, issue), [issue, lanes]);
  return <LinkedInAdeLanes linked={linked} />;
}

function lanesLinkedToGitHubIssue(
  lanes: LaneSummary[],
  issue: Pick<GitHubIssueDetail, "owner" | "repo" | "number">,
): Array<{ lane: LaneSummary; chatCount: number }> {
  const matches = (candidate: { owner?: string; repo?: string; number?: number } | null | undefined) => Boolean(
    candidate
    && candidate.number === issue.number
    && candidate.owner?.toLowerCase() === issue.owner.toLowerCase()
    && candidate.repo?.toLowerCase() === issue.repo.toLowerCase(),
  );
  const out: Array<{ lane: LaneSummary; chatCount: number }> = [];
  for (const lane of lanes) {
    const links = (lane.githubIssueLinks ?? []).filter((link) => matches(link.issue));
    if (links.length === 0) continue;
    const chats = new Set(links.map((link) => link.evidence?.chatSessionId).filter((id): id is string => Boolean(id)));
    out.push({ lane, chatCount: chats.size });
  }
  return out;
}
