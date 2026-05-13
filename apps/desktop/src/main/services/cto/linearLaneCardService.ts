import path from "node:path";
import type { LaneLinearIssue, LaneSummary } from "../../../shared/types";
import type { IssueTracker, IssueTrackerIssueAttachmentInput } from "./issueTracker";

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

function buildCardUrl(issue: LaneLinearIssue, laneId: string): string {
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

export function buildLinearLaneCardAttachment(args: {
  lane: LaneSummary;
  issue: LaneLinearIssue;
  projectRoot: string;
  linkedAt?: string | null;
}): IssueTrackerIssueAttachmentInput {
  const linkedAt = args.linkedAt?.trim() || args.lane.createdAt || new Date().toISOString();
  const branch = args.issue.branchName?.trim() || args.lane.branchRef;
  const projectName = path.basename(args.projectRoot) || "project";
  const teamName = args.issue.teamName?.trim() || args.issue.teamKey;
  const projectLabel = args.issue.projectName?.trim() || args.issue.projectSlug;
  const labels = args.issue.labels.length ? args.issue.labels.join(", ") : "None";

  return {
    issueId: args.issue.id,
    title: `ADE lane: ${truncate(args.lane.name, 64)}`,
    subtitle: `${truncate(branch, 56)} - linked {linkedAt__since}`,
    url: buildCardUrl(args.issue, args.lane.id),
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

export async function publishLinearLaneCard(args: {
  issueTracker: IssueTracker;
  lane: LaneSummary;
  issue: LaneLinearIssue;
  projectRoot: string;
  linkedAt?: string | null;
}): Promise<{ url: string; id?: string }> {
  return args.issueTracker.createIssueAttachment(
    buildLinearLaneCardAttachment({
      lane: args.lane,
      issue: args.issue,
      projectRoot: args.projectRoot,
      linkedAt: args.linkedAt,
    }),
  );
}
