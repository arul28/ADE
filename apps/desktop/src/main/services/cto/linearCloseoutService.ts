import type {
  LinearWorkflowDefinition,
  LinearWorkflowRun,
  NormalizedLinearIssue,
} from "../../../shared/types";
import { resolveOrchestratorArtifactUri } from "../../../shared/proofArtifacts";
import type { createLinearOutboundService } from "./linearOutboundService";
import type { IssueTracker } from "./issueTracker";
import type { createMissionService } from "../missions/missionService";
import type { createOrchestratorService } from "../orchestrator/orchestratorService";

function resolveStateId(states: Array<{ id: string; name: string; type: string }>, stateKey: string | undefined): string | null {
  if (!stateKey) return null;
  const normalized = stateKey.toLowerCase();
  if (normalized === "done") {
    return states.find((entry) => entry.type === "completed")?.id ?? null;
  }
  if (normalized === "blocked") {
    return states.find((entry) => entry.name.toLowerCase().includes("block"))?.id ?? null;
  }
  if (normalized === "in_progress") {
    return states.find((entry) => entry.type === "started")?.id ?? null;
  }
  if (normalized === "in_review") {
    return states.find((entry) => entry.name.toLowerCase().includes("review"))?.id ?? null;
  }
  if (normalized === "todo") {
    return states.find((entry) => entry.type === "unstarted")?.id ?? null;
  }
  if (normalized === "canceled") {
    return states.find((entry) => entry.type === "canceled")?.id ?? null;
  }
  return null;
}

export function createLinearCloseoutService(args: {
  issueTracker: IssueTracker;
  outboundService: ReturnType<typeof createLinearOutboundService>;
  missionService: ReturnType<typeof createMissionService>;
  orchestratorService: ReturnType<typeof createOrchestratorService>;
}) {
  const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

  const uniqueStrings = (values: Array<string | null | undefined>): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
      if (!isNonEmptyString(value)) continue;
      const normalized = value.trim();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
    return out;
  };

  const applyOutcome = async (input: {
    run: LinearWorkflowRun;
    workflow: LinearWorkflowDefinition;
    issue: NormalizedLinearIssue;
    outcome: "completed" | "failed" | "cancelled";
    summary: string;
  }): Promise<void> => {
    const states = await args.issueTracker.fetchWorkflowStates(input.issue.teamKey);
    const closeout = input.workflow.closeout;

    const desiredState = input.outcome === "completed"
      ? resolveStateId(states, closeout?.successState)
      : resolveStateId(states, closeout?.failureState);
    if (desiredState) {
      await args.issueTracker.updateIssueState(input.issue.id, desiredState);
    }

    for (const label of closeout?.applyLabels ?? []) {
      await args.issueTracker.addLabel(input.issue.id, label);
    }

    const comment = input.outcome === "completed" ? closeout?.successComment : closeout?.failureComment;
    if (comment?.trim()) {
      await args.issueTracker.createComment(input.issue.id, comment.trim());
    }

    if (input.workflow.target.type === "mission" && input.run.linkedMissionId) {
      const mission = args.missionService.get(input.run.linkedMissionId);
      const missionArtifactUris = mission?.artifacts
        .map((artifact) => artifact.uri)
        .filter(isNonEmptyString) ?? [];
      const missionPrLinks = mission?.artifacts
        .filter((artifact) => artifact.artifactType === "pr")
        .map((artifact) => artifact.uri)
        .filter(isNonEmptyString) ?? [];
      const orchestratorArtifacts = args.orchestratorService.getArtifactsForMission(input.run.linkedMissionId);
      const orchestratorUris = orchestratorArtifacts
        .map((artifact) => resolveOrchestratorArtifactUri({
          kind: artifact.kind,
          value: artifact.value,
          metadata: artifact.metadata,
        }))
        .filter(isNonEmptyString);
      const orchestratorPrLinks = orchestratorArtifacts
        .filter((artifact) => artifact.kind === "pr")
        .map((artifact) => resolveOrchestratorArtifactUri({
          kind: artifact.kind,
          value: artifact.value,
          metadata: artifact.metadata,
        }))
        .filter(isNonEmptyString);
      await args.outboundService.publishMissionCloseout({
        issue: input.issue,
        missionId: input.run.linkedMissionId,
        status: input.outcome === "cancelled" ? "canceled" : input.outcome,
        summary: input.summary,
        prLinks: uniqueStrings([...missionPrLinks, ...orchestratorPrLinks]),
        artifactPaths: uniqueStrings([...missionArtifactUris, ...orchestratorUris]),
        artifactMode: closeout?.artifactMode ?? "links",
      });
    }
  };

  return {
    applyOutcome,
  };
}

export type LinearCloseoutService = ReturnType<typeof createLinearCloseoutService>;
