import path from "node:path";
import type { LaneLinearIssue, LaneSummary } from "../../../shared/types";
import type { IssueTracker, IssueTrackerIssueAttachmentInput } from "./issueTracker";
import { buildDeeplink } from "../../../shared/deeplinks";

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function dateLabel(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString();
}

function buildFallbackLinearUrl(issue: LaneLinearIssue, laneId: string): string {
  const fallback = `https://linear.app/issue/${encodeURIComponent(issue.identifier)}`;
  let url: URL;
  try {
    url = new URL(issue.url?.trim() || fallback);
  } catch {
    url = new URL(fallback);
  }
  url.hash = `ade-lane-${laneId}`;
  return url.toString();
}

function buildCardUrl(args: {
  issue: LaneLinearIssue;
  laneId: string;
  branch: string;
  repoOwner?: string | null;
  repoName?: string | null;
}): string {
  // Prefer the cross-machine ADE deeplink (so the attachment is actually
  // clickable from Linear and lands in another teammate's ADE). Fall back to
  // the historical Linear-issue-hash URL when we don't know the repo.
  if (args.repoOwner && args.repoName) {
    return buildDeeplink(
      {
        kind: "branch",
        repoOwner: args.repoOwner,
        repoName: args.repoName,
        branch: args.branch,
      },
      { form: "https" },
    );
  }
  return buildFallbackLinearUrl(args.issue, args.laneId);
}

export function buildLinearLaneCardAttachment(args: {
  lane: LaneSummary;
  issue: LaneLinearIssue;
  projectRoot: string;
  linkedAt?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
}): IssueTrackerIssueAttachmentInput {
  const linkedAt = args.linkedAt?.trim() || args.lane.createdAt || new Date().toISOString();
  const branch = args.issue.branchName?.trim() || args.lane.branchRef;
  const projectName = path.basename(args.projectRoot) || "project";
  const teamName = args.issue.teamName?.trim() || args.issue.teamKey;
  const projectLabel = args.issue.projectName?.trim() || args.issue.projectSlug;
  const labels = args.issue.labels.length ? args.issue.labels.join(", ") : "None";
  const cardUrl = buildCardUrl({
    issue: args.issue,
    laneId: args.lane.id,
    branch,
    repoOwner: args.repoOwner ?? null,
    repoName: args.repoName ?? null,
  });
  const hasDeeplink = Boolean(args.repoOwner && args.repoName);

  return {
    issueId: args.issue.id,
    title: hasDeeplink ? `Open in ADE: ${truncate(args.lane.name, 56)}` : `ADE lane: ${truncate(args.lane.name, 64)}`,
    subtitle: `${truncate(branch, 56)} - linked {linkedAt__since}`,
    url: cardUrl,
    metadata: {
      title: `ADE lane linked to ${args.issue.identifier}`,
      laneId: args.lane.id,
      laneName: args.lane.name,
      branch,
      baseRef: args.lane.baseRef,
      projectName,
      linkedAt,
      issueIdentifier: args.issue.identifier,
      attributes: [
        { name: "Lane", value: args.lane.name },
        { name: "Branch", value: branch },
        { name: "Base", value: args.lane.baseRef },
        { name: "ADE project", value: projectName },
        { name: "Linear team", value: teamName },
        { name: "Linear project", value: projectLabel },
        { name: "Issue state at link", value: args.issue.stateName },
        { name: "Assignee at link", value: args.issue.assigneeName?.trim() || "Unassigned" },
        { name: "Labels at link", value: labels },
        { name: "Linked at", value: dateLabel(linkedAt) },
        { name: "Lane ID", value: args.lane.id },
      ],
      messages: [
        {
          subject: "What ADE linked",
          body: `This Linear issue is linked to the ADE lane "${args.lane.name}" on branch "${branch}". ADE uses this lane link for branch naming, commit references, PR text, and chat context.`,
          timestamp: linkedAt,
        },
      ],
    },
  };
}

export function buildLinearLaneInitialComment(args: {
  lane: LaneSummary;
  issue: LaneLinearIssue;
  repoOwner?: string | null;
  repoName?: string | null;
}): string | null {
  if (!args.repoOwner || !args.repoName) return null;
  const branch = args.issue.branchName?.trim() || args.lane.branchRef;
  const url = buildDeeplink(
    {
      kind: "branch",
      repoOwner: args.repoOwner,
      repoName: args.repoName,
      branch,
    },
    { form: "https" },
  );
  return `ADE lane available for this issue — [Open in ADE](${url}) (branch \`${branch}\`).`;
}

export function buildLinearPrCardAttachment(args: {
  lane: LaneSummary;
  issue: LaneLinearIssue;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  githubUrl: string;
  linkedAt?: string | null;
}): IssueTrackerIssueAttachmentInput {
  const linkedAt = args.linkedAt?.trim() || new Date().toISOString();
  const branch = args.issue.branchName?.trim() || args.lane.branchRef;
  const adePrUrl = buildDeeplink(
    {
      kind: "pr",
      repoOwner: args.repoOwner,
      repoName: args.repoName,
      prNumber: args.prNumber,
    },
    { form: "https" },
  );
  const adeLaneUrl = buildDeeplink(
    {
      kind: "branch",
      repoOwner: args.repoOwner,
      repoName: args.repoName,
      branch,
      prNumber: args.prNumber,
    },
    { form: "https" },
  );
  const repo = `${args.repoOwner}/${args.repoName}`;

  return {
    issueId: args.issue.id,
    title: `Open in ADE PR #${args.prNumber}: ${truncate(args.issue.identifier, 40)}`,
    subtitle: `${truncate(repo, 42)}#${args.prNumber} - linked {linkedAt__since}`,
    url: adePrUrl,
    metadata: {
      title: `ADE PR linked to ${args.issue.identifier}`,
      laneId: args.lane.id,
      laneName: args.lane.name,
      branch,
      repo,
      githubPrNumber: args.prNumber,
      githubUrl: args.githubUrl,
      adePrUrl,
      adeLaneUrl,
      linkedAt,
      issueIdentifier: args.issue.identifier,
      attributes: [
        { name: "Lane", value: args.lane.name },
        { name: "Branch", value: branch },
        { name: "GitHub PR", value: `${repo}#${args.prNumber}` },
        { name: "GitHub URL", value: args.githubUrl },
        { name: "ADE PR", value: adePrUrl },
        { name: "ADE lane", value: adeLaneUrl },
        { name: "Linked at", value: dateLabel(linkedAt) },
      ],
      messages: [
        {
          subject: "ADE PR linked",
          body: `ADE linked [GitHub PR ${repo}#${args.prNumber}](${args.githubUrl}) and [ADE PR #${args.prNumber}](${adePrUrl}) to this Linear issue from lane "${args.lane.name}".`,
          timestamp: linkedAt,
        },
      ],
    },
  };
}

export async function publishLinearLaneCard(args: {
  issueTracker: IssueTracker;
  lane: LaneSummary;
  issue: LaneLinearIssue;
  projectRoot: string;
  linkedAt?: string | null;
  /** Optional: when known, used to render the cross-machine ADE deeplink. */
  repoOwner?: string | null;
  repoName?: string | null;
  /** When true, also post a one-time comment so timeline-watchers see the link. */
  postInitialComment?: boolean;
  /** Optional log hook used for the (best-effort) comment-create step. */
  log?: (event: string, fields: Record<string, unknown>) => void;
}): Promise<{ url: string; id?: string }> {
  const result = await args.issueTracker.createIssueAttachment(
    buildLinearLaneCardAttachment({
      lane: args.lane,
      issue: args.issue,
      projectRoot: args.projectRoot,
      linkedAt: args.linkedAt,
      repoOwner: args.repoOwner ?? null,
      repoName: args.repoName ?? null,
    }),
  );

  if (args.postInitialComment) {
    const body = buildLinearLaneInitialComment({
      lane: args.lane,
      issue: args.issue,
      repoOwner: args.repoOwner ?? null,
      repoName: args.repoName ?? null,
    });
    if (body) {
      try {
        await args.issueTracker.createComment(args.issue.id, body);
      } catch (error) {
        args.log?.("linear.lane_initial_comment_failed", {
          issueId: args.issue.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return result;
}

export async function publishLinearPrCard(args: {
  issueTracker: IssueTracker;
  lane: LaneSummary;
  issue: LaneLinearIssue;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  githubUrl: string;
  linkedAt?: string | null;
}): Promise<{ url: string; id?: string }> {
  return await args.issueTracker.createIssueAttachment(
    buildLinearPrCardAttachment({
      lane: args.lane,
      issue: args.issue,
      repoOwner: args.repoOwner,
      repoName: args.repoName,
      prNumber: args.prNumber,
      githubUrl: args.githubUrl,
      linkedAt: args.linkedAt,
    }),
  );
}
