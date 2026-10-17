import React, { useCallback, useEffect, useMemo, useState } from "react";
import { CircleNotch, Copy, GitBranch, Hash, LinkSimple, MarkdownLogo, TreeStructure } from "@phosphor-icons/react";
import type { LaneSummary, LinearIssueRef, NormalizedLinearIssue } from "../../../shared/types";
import { buildDeeplink } from "../../../shared/deeplinks";
import { makeLinearIssueContextAttachment } from "../../../shared/chatContextAttachments";
import { linearIssueRef, issueRefLabel } from "../../../shared/issueRefs";
import { resolveLinearIssueBranchName } from "../../../shared/linearIssueBranch";
import { requestLinearIssueLaunch } from "../../lib/linearLaunchRequests";
import { requestIssueCreate } from "../../lib/issueCreateRequests";
import { useAppStore } from "../../state/appStore";
import { showToast } from "../app/toast/toastStore";
import { settingsRouteFor } from "../settings/settingsManifest";
import { linearBrowserIssueToLaneIssue } from "../app/linearIssueBrowserModel";
import { LinearMark, LinearStateIcon } from "../lanes/linearBrand";
import type { ContextMenuEntry } from "../ui/ContextMenu";
import { Banner } from "../ui/notice";
import {
  copyIssueText,
  IssueActionDock,
  IssueStaleBanner,
  IssueViewerFrame,
  IssueViewerHeader,
  lanesCarryingIssue,
  LinkedInAdeLanes,
  type IssueViewerProps,
} from "./issueViewerParts";
import { LinearIssueView } from "./LinearIssueView";
import { editLinearIssue, useLinearIssue, useLinearPickerCatalog } from "./linearIssueStore";

/** A Linear issue in the shared viewer frame: read by identifier, editable in place. */
export function LinearIssueViewer({
  identifier,
  issueRef,
  variant,
  onAttachToChat,
  onOpenRelated,
  onViewAll,
  onClose,
}: IssueViewerProps & { identifier: string }) {
  const entry = useLinearIssue(identifier);
  const catalog = useLinearPickerCatalog();
  const issue = entry.issue;

  const handleEdit = useCallback((edit: Parameters<typeof editLinearIssue>[2]) => {
    if (!issue || !catalog) return;
    void editLinearIssue(entry.projectRoot, issue, edit, catalog).catch((error: unknown) => {
      showToast({
        tone: "error",
        title: `Couldn't update ${issue.identifier}`,
        message: error instanceof Error ? error.message : "Linear rejected the change.",
      });
    });
  }, [catalog, entry.projectRoot, issue]);

  const canComment = typeof window !== "undefined" && typeof window.ade?.cto?.createLinearIssueComment === "function";

  const openRelated = useCallback((ref: LinearIssueRef) => {
    const next = linearIssueRef(ref.identifier);
    if (next) onOpenRelated(next);
  }, [onOpenRelated]);

  // The launch modal takes over from here; a sheet would only sit behind it
  // and then over the lane the launch opens.
  const launch = useCallback((laneOnly: boolean) => {
    if (!issue) return;
    requestLinearIssueLaunch({ issues: [issue], laneOnly });
    if (variant === "sheet") onClose?.();
  }, [issue, onClose, variant]);

  const url = issue?.url ?? issueRef.url ?? null;
  const copyEntries = useMemo<ContextMenuEntry[]>(
    () => (issue ? linearCopyEntries(issue, variant) : []),
    [issue, variant],
  );

  const header = (
    <IssueViewerHeader
      mark={<LinearMark size={14} />}
      label={issue?.identifier ?? issueRefLabel(issueRef)}
      state={issue ? (
        <>
          <LinearStateIcon stateType={issue.stateType} size={12} />
          <span className="truncate">{issue.stateName}</span>
        </>
      ) : null}
      loading={entry.status === "loading" && Boolean(issue)}
      onRefresh={entry.refresh}
      url={url}
      openLabel="Open in Linear"
      copyEntries={copyEntries}
      copyTitle="Copy link, ID, branch name"
      onViewAll={onViewAll}
      onClose={onClose}
    />
  );

  let body: React.ReactNode;
  if (!issue) {
    body = (
      <IssueLoadState
        status={entry.status}
        error={entry.error}
        label={issueRefLabel(issueRef)}
        url={url}
        projectRoot={entry.projectRoot}
        onRetry={entry.refresh}
        onLeave={onClose}
      />
    );
  } else {
    body = (
      <>
        <IssueStaleBanner error={entry.error} onRetry={entry.refresh} />
        <LinearIssueView
          issue={issue}
          catalog={catalog ?? EMPTY_CATALOG}
          onEdit={catalog ? handleEdit : undefined}
          editPending={entry.editing}
          onOpenIssue={openRelated}
          branchName={resolveLinearIssueBranchName(issue)}
          activityDefaultOpen
          sideExtra={<LinkedInAde issue={issue} />}
          onSaveTitle={catalog ? (title) => editLinearIssue(entry.projectRoot, issue, { title }, catalog) : undefined}
          onSaveDescription={catalog ? (description) => editLinearIssue(entry.projectRoot, issue, { description }, catalog) : undefined}
          onComment={canComment ? async (body) => {
            await window.ade.cto?.createLinearIssueComment({ issueId: issue.id, body });
          } : undefined}
        />
      </>
    );
  }

  return (
    <IssueViewerFrame
      variant={variant}
      ariaLabel={`Linear issue ${issue?.identifier ?? identifier}`}
      header={header}
      dock={issue ? (
        <IssueActionDock
          label={issue.identifier}
          onLaunch={launch}
          attachment={() => makeLinearIssueContextAttachment(linearBrowserIssueToLaneIssue(issue))}
          onAttachToChat={onAttachToChat}
        />
      ) : null}
    >
      {body}
    </IssueViewerFrame>
  );
}

const EMPTY_CATALOG = { projects: [], users: [], states: [], labels: [] };

type LinearReachability = "unknown" | "connected" | "disconnected" | "no-project";

/**
 * Why an issue could not be shown, said the way that fixes it. "Linear didn't
 * return ADE-123" is the wrong message when the real answer is that this
 * project is not connected to Linear, or that no project is open at all, so a
 * failed read asks the connection once before choosing the words.
 */
function IssueLoadState({
  status,
  error,
  label,
  url,
  projectRoot,
  onRetry,
  onLeave,
}: {
  status: string;
  error: string | null;
  label: string;
  url: string | null;
  projectRoot: string | null;
  onRetry: () => void;
  /** Called before an action takes the user to another page (closes the sheet). */
  onLeave?: () => void;
}) {
  const setShowWelcome = useAppStore((state) => state.setShowWelcome);
  const failed = status === "missing" || status === "error";
  const [reachability, setReachability] = useState<LinearReachability>("unknown");
  useEffect(() => {
    if (!failed) return undefined;
    if (!projectRoot) {
      setReachability("no-project");
      return undefined;
    }
    let cancelled = false;
    const read = window.ade?.cto?.getLinearConnectionStatus;
    if (!read) return undefined;
    void read()
      .then((connection) => {
        if (!cancelled) setReachability(connection.connected ? "connected" : "disconnected");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [failed, projectRoot]);

  if (!failed) {
    return (
      <div className="flex items-center gap-2 px-5 py-6 text-[12px] text-[color:var(--kit-text-3)]">
        <CircleNotch size={13} className="animate-spin" />
        Loading {label}…
      </div>
    );
  }
  const openAction = url ? [{ label: "Open in Linear", href: url }] : [];
  let model: React.ComponentProps<typeof Banner>["model"];
  if (reachability === "no-project") {
    model = {
      id: "issue-no-project",
      tone: "warning",
      title: `Open the ADE project for ${label}`,
      detail: "ADE reads Linear through a project's connection, and no project is open.",
      actions: [{ label: "Open project picker", onClick: () => { onLeave?.(); setShowWelcome(true); } }, ...openAction],
    };
  } else if (reachability === "disconnected") {
    model = {
      id: "issue-linear-disconnected",
      tone: "warning",
      title: `Connect Linear to open ${label}`,
      detail: "This project isn't connected to Linear yet.",
      actions: [
        {
          label: "Open Linear settings",
          onClick: () => {
            onLeave?.();
            window.location.hash = `#${settingsRouteFor("integrations.linear")}`;
          },
        },
        ...openAction,
      ],
    };
  } else if (status === "missing") {
    model = {
      id: "issue-missing",
      tone: "warning",
      title: `Linear didn't return ${label}`,
      detail: "It may be in another Linear workspace, or it was deleted.",
      actions: [...openAction, { label: "Retry", onClick: onRetry }],
    };
  } else {
    model = {
      id: "issue-error",
      tone: "error",
      title: `Couldn't load ${label}`,
      detail: error ?? "Linear request failed.",
      actions: [{ label: "Retry", onClick: onRetry }, ...openAction],
    };
  }
  return (
    <div className="p-4">
      <Banner layout="inline" model={model} />
    </div>
  );
}

function linearCopyEntries(issue: NormalizedLinearIssue, variant: IssueViewerProps["variant"]): ContextMenuEntry[] {
  const copy = copyIssueText;
  const branchName = resolveLinearIssueBranchName(issue);
  const entries: ContextMenuEntry[] = [
    {
      kind: "item",
      key: "sub-issue",
      label: "New sub-issue",
      icon: TreeStructure,
      onSelect: () => requestIssueCreate({
        provider: "linear",
        prefill: { parent: { provider: "linear", identifier: issue.identifier, teamKey: issue.teamKey ?? null } },
        origin: variant === "pane" ? "pane" : null,
      }),
    },
  ];
  if (issue.url) {
    entries.push({ kind: "item", key: "link", label: "Copy link", icon: LinkSimple, onSelect: () => copy(issue.url!, "link") });
  }
  entries.push({ kind: "item", key: "id", label: "Copy ID", icon: Hash, onSelect: () => copy(issue.identifier, issue.identifier) });
  if (branchName) {
    entries.push({ kind: "item", key: "branch", label: "Copy branch name", icon: GitBranch, onSelect: () => copy(branchName, "branch name") });
  }
  entries.push({
    kind: "item",
    key: "markdown",
    label: "Copy as Markdown",
    icon: MarkdownLogo,
    onSelect: () => copy(issue.url ? `[${issue.identifier} ${issue.title}](${issue.url})` : `${issue.identifier} ${issue.title}`, "Markdown link"),
  });
  entries.push({
    kind: "item",
    key: "deeplink",
    label: "Copy ADE link",
    icon: Copy,
    onSelect: () => copy(buildDeeplink({ kind: "linear-issue", issueIdentifier: issue.identifier }), "ADE link"),
  });
  return entries;
}

/**
 * Where this issue already lives in ADE: the lanes that carry it, and how many
 * chats in each were handed it. Read from lane data ADE already holds, so the
 * strip costs nothing to draw.
 */
function LinkedInAde({ issue }: { issue: NormalizedLinearIssue }) {
  const lanes = useAppStore((state) => state.lanes);
  const linked = useMemo(() => lanesLinkedToIssue(lanes, issue), [issue, lanes]);
  return <LinkedInAdeLanes linked={linked} />;
}

function lanesLinkedToIssue(
  lanes: LaneSummary[],
  issue: Pick<NormalizedLinearIssue, "id" | "identifier">,
): Array<{ lane: LaneSummary; chatCount: number }> {
  const identifier = issue.identifier.toUpperCase();
  const matches = (candidate: { id?: string | null; identifier?: string | null } | null | undefined) =>
    Boolean(candidate && (candidate.id === issue.id || candidate.identifier?.toUpperCase() === identifier));
  return lanesCarryingIssue(
    lanes,
    (lane) => (lane.linearIssueLinks ?? []).filter((link) => matches(link.issue)),
    (lane) => matches(lane.linearIssue),
  );
}
