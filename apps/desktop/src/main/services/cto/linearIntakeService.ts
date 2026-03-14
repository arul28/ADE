import { createHash } from "node:crypto";
import type { LinearWorkflowConfig, NormalizedLinearIssue } from "../../../shared/types";
import type { AdeDb } from "../state/kvDb";
import type { IssueTracker } from "./issueTracker";

function issueHash(issue: NormalizedLinearIssue): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        projectSlug: issue.projectSlug,
        teamKey: issue.teamKey,
        stateId: issue.stateId,
        stateType: issue.stateType,
        assigneeId: issue.assigneeId,
        assigneeName: issue.assigneeName,
        labels: issue.labels,
        priorityLabel: issue.priorityLabel,
        updatedAt: issue.updatedAt,
      })
    )
    .digest("hex");
}

export function createLinearIntakeService(args: {
  db: AdeDb;
  projectId: string;
  issueTracker: IssueTracker;
}) {
  const fetchCandidates = async (policy: LinearWorkflowConfig): Promise<NormalizedLinearIssue[]> => {
    const projectSlugs = Array.from(
      new Set(
        policy.workflows.flatMap((workflow) => workflow.triggers.projectSlugs ?? []).filter(Boolean)
      )
    );
    const querySlugs = projectSlugs.length ? projectSlugs : (policy.legacyConfig?.projects ?? []).map((entry) => entry.slug);
    const issues = await args.issueTracker.fetchCandidateIssues({
      projectSlugs: querySlugs,
      stateTypes: ["backlog", "unstarted", "started"],
    });

    const eligible = issues.filter((issue) => !issue.hasOpenBlockers);

    eligible.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    });

    return eligible.map((issue) => {
      const existing = args.db.get<{ payload_json: string; hash: string }>(
        `
          select payload_json, hash
          from linear_issue_snapshots
          where project_id = ?
            and issue_id = ?
          limit 1
        `,
        [args.projectId, issue.id]
      );
      const currentHash = issueHash(issue);
      const previousState = existing?.payload_json ? JSON.parse(existing.payload_json) as Record<string, unknown> : null;
      return {
        ...issue,
        previousStateId: typeof previousState?.stateId === "string" ? previousState.stateId : null,
        previousStateName: typeof previousState?.stateName === "string" ? previousState.stateName : null,
        previousStateType: typeof previousState?.stateType === "string" ? previousState.stateType : null,
        raw: {
          ...issue.raw,
          _snapshotHash: currentHash,
          _previousSnapshotHash: existing?.hash ?? null,
        },
      };
    });
  };

  const persistSnapshot = (issue: NormalizedLinearIssue): void => {
    const now = new Date().toISOString();
    args.db.run(
      `
        insert into linear_issue_snapshots(
          id, project_id, issue_id, identifier, state_type, assignee_id, updated_at_linear, payload_json, hash, created_at, updated_at
        )
        values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(project_id, issue_id) do update set
          identifier = excluded.identifier,
          state_type = excluded.state_type,
          assignee_id = excluded.assignee_id,
          updated_at_linear = excluded.updated_at_linear,
          payload_json = excluded.payload_json,
          hash = excluded.hash,
          updated_at = excluded.updated_at
      `,
      [
        `${args.projectId}:${issue.id}`,
        args.projectId,
        issue.id,
        issue.identifier,
        issue.stateType,
        issue.assigneeId,
        issue.updatedAt,
        JSON.stringify(issue),
        issueHash(issue),
        now,
        now,
      ]
    );
  };

  return {
    fetchCandidates,
    persistSnapshot,
    issueHash,
  };
}

export type LinearIntakeService = ReturnType<typeof createLinearIntakeService>;
