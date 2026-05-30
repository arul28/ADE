import type { Logger } from "../logging/logger";
import type { LaneLinearIssue } from "../../../shared/types";
import type { IssueTracker } from "./issueTracker";

/**
 * Live Linear status round-trip (Item 6 "extra", gated OFF by default).
 *
 * As an ADE agent moves an issue through its lifecycle we reflect that back into
 * Linear: on launch the issue moves to the team's "In Progress" state, gets
 * assigned to the connected user, and a branch-link comment is posted; on PR
 * open a PR comment is posted; on merge the issue moves to "Done". Reuses the
 * existing `issueTracker` write surface (`updateIssueState` /
 * `updateIssueAssignee` / `createComment`) — no new Linear creds.
 *
 * Gating: enabled only when `ADE_LINEAR_LIVE_STATUS_ROUNDTRIP=1`. This keeps a
 * potentially noisy, write-heavy behavior off until a user opts in, mirroring
 * the `ADE_ENABLE_*` background-task flag convention in main.ts.
 */

const LIVE_STATUS_ENV_FLAG = "ADE_LINEAR_LIVE_STATUS_ROUNDTRIP";

export function isLinearLiveStatusRoundTripEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LIVE_STATUS_ENV_FLAG] === "1";
}

type WorkflowStateLite = { id: string; name: string; type: string };

export function createLinearLiveStatusService(args: {
  getIssueTracker: () => IssueTracker | null;
  /** Override the gate (tests inject `true`); defaults to the env flag. */
  enabled?: boolean;
  logger?: Logger | null;
}) {
  const logger = args.logger ?? null;
  const enabled = args.enabled ?? isLinearLiveStatusRoundTripEnabled();

  // Resolved once per team; workflow states rarely change within a session.
  const statesByTeam = new Map<string, WorkflowStateLite[]>();
  let viewerIdResolved = false;
  let viewerId: string | null = null;

  // De-dupe transitions: a single issue should move to In Progress / Done at
  // most once per direction even if multiple sessions launch against it.
  const movedInProgress = new Set<string>();
  const movedDone = new Set<string>();

  const warn = (event: string, fields: Record<string, unknown>): void => {
    logger?.warn(event, fields);
  };

  const resolveStatesForTeam = async (
    tracker: IssueTracker,
    teamKey: string | null,
  ): Promise<WorkflowStateLite[]> => {
    const key = (teamKey ?? "").trim() || "__all__";
    const cached = statesByTeam.get(key);
    if (cached) return cached;
    const states = await tracker.listWorkflowStates(teamKey ?? null);
    const lite = states.map((state) => ({ id: state.id, name: state.name, type: state.type }));
    statesByTeam.set(key, lite);
    return lite;
  };

  const pickStateId = (states: WorkflowStateLite[], wantedType: "started" | "completed"): string | null => {
    const match = states.find((state) => state.type === wantedType);
    return match?.id ?? null;
  };

  const resolveViewerId = async (tracker: IssueTracker): Promise<string | null> => {
    if (viewerIdResolved) return viewerId;
    viewerIdResolved = true;
    try {
      const status = await tracker.getConnectionStatus();
      viewerId = status.connected ? (status.viewerId ?? null) : null;
    } catch (error) {
      warn("linear_live_status.viewer_resolve_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      viewerId = null;
    }
    return viewerId;
  };

  /** On agent launch: In Progress + self-assign + branch-link comment. */
  const onAgentLaunched = async (input: {
    issue: LaneLinearIssue;
    branchName?: string | null;
    laneName?: string | null;
  }): Promise<void> => {
    if (!enabled) return;
    const tracker = args.getIssueTracker();
    if (!tracker) return;
    const issue = input.issue;
    if (movedInProgress.has(issue.id)) return;
    movedInProgress.add(issue.id);

    try {
      const states = await resolveStatesForTeam(tracker, issue.teamKey);
      const inProgressId = pickStateId(states, "started");
      if (inProgressId && inProgressId !== issue.stateId) {
        await tracker.updateIssueState(issue.id, inProgressId);
      }
    } catch (error) {
      movedInProgress.delete(issue.id);
      warn("linear_live_status.in_progress_failed", {
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const viewer = await resolveViewerId(tracker);
      if (viewer && issue.assigneeId !== viewer) {
        await tracker.updateIssueAssignee(issue.id, viewer);
      }
    } catch (error) {
      warn("linear_live_status.assign_failed", {
        issueId: issue.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const branch = (input.branchName ?? issue.branchName ?? "").trim();
    if (branch) {
      try {
        const laneLabel = input.laneName?.trim() ? ` in lane "${input.laneName.trim()}"` : "";
        await tracker.createComment(
          issue.id,
          `ADE started an agent${laneLabel} on branch \`${branch}\`.`,
        );
      } catch (error) {
        warn("linear_live_status.launch_comment_failed", {
          issueId: issue.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  /** On PR open: post a PR-link comment to each linked issue. */
  const onPrOpened = async (input: {
    issueIds: string[];
    prNumber: number;
    githubUrl: string;
  }): Promise<void> => {
    if (!enabled) return;
    const tracker = args.getIssueTracker();
    if (!tracker) return;
    const url = input.githubUrl.trim();
    if (!url) return;
    for (const issueId of new Set(input.issueIds.map((id) => id.trim()).filter(Boolean))) {
      try {
        await tracker.createComment(issueId, `ADE opened PR #${input.prNumber}: ${url}`);
      } catch (error) {
        warn("linear_live_status.pr_comment_failed", {
          issueId,
          prNumber: input.prNumber,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  /** On merge: move each linked issue to the team's Done state. */
  const onIssueMerged = async (input: {
    issues: Array<{ id: string; teamKey?: string | null; stateId?: string | null }>;
  }): Promise<void> => {
    if (!enabled) return;
    const tracker = args.getIssueTracker();
    if (!tracker) return;
    for (const issue of input.issues) {
      const issueId = issue.id.trim();
      if (!issueId || movedDone.has(issueId)) continue;
      movedDone.add(issueId);
      try {
        const states = await resolveStatesForTeam(tracker, issue.teamKey ?? null);
        const doneId = pickStateId(states, "completed");
        if (doneId && doneId !== issue.stateId) {
          await tracker.updateIssueState(issueId, doneId);
        }
      } catch (error) {
        movedDone.delete(issueId);
        warn("linear_live_status.done_failed", {
          issueId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  return {
    get enabled(): boolean {
      return enabled;
    },
    onAgentLaunched,
    onPrOpened,
    onIssueMerged,
  };
}

export type LinearLiveStatusService = ReturnType<typeof createLinearLiveStatusService>;
