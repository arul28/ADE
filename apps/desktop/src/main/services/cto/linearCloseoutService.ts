import type {
  ComputerUseArtifactOwner,
  LinearWorkflowDefinition,
  LinearWorkflowRun,
  NormalizedLinearIssue,
} from "../../../shared/types";
import { resolveOrchestratorArtifactUri } from "../../../shared/proofArtifacts";
import type { Logger } from "../logging/logger";
import type { createLinearOutboundService } from "./linearOutboundService";
import type { IssueTracker } from "./issueTracker";
import type { createMissionService } from "../missions/missionService";
import type { createOrchestratorService } from "../orchestrator/orchestratorService";
import type { createPrService } from "../prs/prService";
import type { createComputerUseArtifactBrokerService } from "../computerUse/computerUseArtifactBrokerService";
import { renderTemplateString } from "../shared/utils";

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
  prService: ReturnType<typeof createPrService>;
  computerUseArtifactBrokerService: ReturnType<typeof createComputerUseArtifactBrokerService>;
  logger?: Logger | null;
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

  const logLabelWarning = (issueId: string, label: string, error: unknown): void => {
    args.logger?.warn("linear_closeout.add_label_failed", {
      issueId,
      label,
      error: error instanceof Error ? error.message : String(error),
    });
  };

  const collectBrokerArtifactUris = (owners: ComputerUseArtifactOwner[]): string[] => uniqueStrings(
    owners.flatMap((owner) =>
      args.computerUseArtifactBrokerService
        .listArtifacts({ owner, limit: 100 })
        .map((artifact) => artifact.uri)
        .filter(isNonEmptyString)
    ),
  );

  const collectCloseoutArtifacts = (input: {
    run: LinearWorkflowRun;
    workflow: LinearWorkflowDefinition;
    issue: NormalizedLinearIssue;
  }): { prLinks: string[]; artifactPaths: string[]; contextLines: string[] } => {
    const prSummaries = args.prService.listAll();
    const linkedPr = input.run.linkedPrId
      ? prSummaries.find((entry) => entry.id === input.run.linkedPrId) ?? null
      : null;
    const lanePr = !linkedPr && input.run.executionLaneId
      ? args.prService.getForLane(input.run.executionLaneId)
      : null;
    const prLinks = uniqueStrings([
      linkedPr?.githubUrl,
      lanePr?.githubUrl,
    ]);
    const contextLines = uniqueStrings([
      `Workflow target: ${input.workflow.target.type}`,
      input.run.executionLaneId ? `Lane: ${input.run.executionLaneId}` : null,
      input.run.linkedSessionId ? `Session: ${input.run.linkedSessionId}` : null,
      input.run.linkedWorkerRunId ? `Worker run: ${input.run.linkedWorkerRunId}` : null,
      input.run.linkedPrId ? `Linked PR record: ${input.run.linkedPrId}` : null,
    ]);

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
      return {
        prLinks: uniqueStrings([...prLinks, ...missionPrLinks, ...orchestratorPrLinks]),
        artifactPaths: uniqueStrings([...missionArtifactUris, ...orchestratorUris]),
        contextLines,
      };
    }

    const owners: ComputerUseArtifactOwner[] = [];
    owners.push({ kind: "orchestrator_run", id: input.run.id });
    if (input.run.linkedSessionId) {
      owners.push({ kind: "chat_session", id: input.run.linkedSessionId });
    }
    if (input.run.executionLaneId) {
      owners.push({ kind: "lane", id: input.run.executionLaneId });
    }
    owners.push({ kind: "linear_issue", id: input.issue.id });
    if (input.run.linkedPrId) {
      owners.push({ kind: "github_pr", id: input.run.linkedPrId });
    }
    return {
      prLinks,
      artifactPaths: collectBrokerArtifactUris(owners),
      contextLines,
    };
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
    const prSummaries = args.prService.listAll();
    const linkedPr = input.run.linkedPrId
      ? prSummaries.find((entry) => entry.id === input.run.linkedPrId) ?? null
      : null;

    const closeoutArtifacts = collectCloseoutArtifacts(input);

    const templateValues: Record<string, unknown> = {
      issue: input.issue,
      workflow: {
        id: input.workflow.id,
        name: input.workflow.name,
      },
      run: input.run,
      target: {
        type: input.run.executionContext?.activeTargetType ?? input.workflow.target.type,
        id:
          input.run.linkedSessionId
          ?? input.run.linkedWorkerRunId
          ?? input.run.linkedMissionId
          ?? input.run.linkedPrId
          ?? input.run.executionLaneId
          ?? null,
      },
      pr: {
        id: input.run.linkedPrId ?? null,
        url: linkedPr?.githubUrl ?? closeoutArtifacts.prLinks[0] ?? null,
        links: closeoutArtifacts.prLinks,
      },
      review: {
        state: input.run.reviewState,
        readyReason: input.run.reviewReadyReason,
        note: input.run.latestReviewNote,
      },
      note: input.summary,
      waitingFor: input.run.executionContext?.waitingFor ?? null,
    };

    const desiredState = input.outcome === "completed"
      ? resolveStateId(states, closeout?.successState)
      : resolveStateId(states, closeout?.failureState);
    if (desiredState) {
      await args.issueTracker.updateIssueState(input.issue.id, desiredState);
    }

    for (const label of uniqueStrings([...(closeout?.applyLabels ?? []), ...(closeout?.labels ?? [])])) {
      try {
        await args.issueTracker.addLabel(input.issue.id, label);
      } catch (error) {
        logLabelWarning(input.issue.id, label, error);
      }
    }

    const renderedTemplate = closeout?.commentTemplate?.trim()
      ? renderTemplateString(closeout.commentTemplate, templateValues).trim()
      : "";
    const comment = renderedTemplate || (input.outcome === "completed" ? closeout?.successComment : closeout?.failureComment);
    if (comment?.trim()) {
      await args.issueTracker.createComment(input.issue.id, comment.trim());
    }
    const outboundStatus = input.outcome === "cancelled" ? "canceled" as const : input.outcome;
    const outboundTemplateValues = {
      ...templateValues,
      pr: {
        ...(templateValues.pr as Record<string, unknown>),
        links: closeoutArtifacts.prLinks,
      },
    };

    if (input.workflow.target.type === "mission" && input.run.linkedMissionId) {
      await args.outboundService.publishMissionCloseout({
        issue: input.issue,
        missionId: input.run.linkedMissionId,
        status: outboundStatus,
        summary: input.summary,
        prLinks: closeoutArtifacts.prLinks,
        artifactPaths: closeoutArtifacts.artifactPaths,
        artifactMode: closeout?.artifactMode ?? "links",
        commentTemplate: closeout?.commentTemplate ?? null,
        templateValues: outboundTemplateValues,
      });
      return;
    }

    await args.outboundService.publishWorkflowCloseout({
      issue: input.issue,
      status: outboundStatus,
      summary: input.summary,
      targetLabel: input.workflow.target.type.replace(/_/g, " "),
      targetId:
        input.run.linkedSessionId
        ?? input.run.linkedWorkerRunId
        ?? input.run.linkedPrId
        ?? input.run.executionLaneId
        ?? null,
      contextLines: closeoutArtifacts.contextLines,
      prLinks: closeoutArtifacts.prLinks,
      artifactPaths: closeoutArtifacts.artifactPaths,
      artifactMode: closeout?.artifactMode ?? "links",
      commentTemplate: closeout?.commentTemplate ?? null,
      templateValues: outboundTemplateValues,
    });
  };

  return {
    applyOutcome,
  };
}

export type LinearCloseoutService = ReturnType<typeof createLinearCloseoutService>;
