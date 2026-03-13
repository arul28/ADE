import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LinearArtifactMode, NormalizedLinearIssue } from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { IssueTracker } from "./issueTracker";
import { isWithinDir, nowIso, uniqueStrings, getErrorMessage } from "../shared/utils";

function bodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

type WorkpadRow = {
  id: string;
  issue_id: string;
  comment_id: string;
  last_body_hash: string | null;
  last_body: string | null;
};

export function createLinearOutboundService(args: {
  db: AdeDb;
  projectId: string;
  projectRoot: string;
  issueTracker: IssueTracker;
  logger?: Logger | null;
}) {
  const getRow = (issueId: string): WorkpadRow | null => {
    return args.db.get<WorkpadRow>(
      `
        select id, issue_id, comment_id, last_body_hash, last_body
        from linear_workpads
        where project_id = ?
          and issue_id = ?
        limit 1
      `,
      [args.projectId, issueId]
    );
  };

  const upsertRow = (params: {
    issueId: string;
    commentId: string;
    body: string;
  }): void => {
    const hash = bodyHash(params.body);
    const timestamp = nowIso();
    args.db.run(
      `
        insert into linear_workpads(id, project_id, issue_id, comment_id, last_body_hash, last_body, created_at, updated_at)
        values(?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(project_id, issue_id) do update set
          comment_id = excluded.comment_id,
          last_body_hash = excluded.last_body_hash,
          last_body = excluded.last_body,
          updated_at = excluded.updated_at
      `,
      [`${args.projectId}:${params.issueId}`, args.projectId, params.issueId, params.commentId, hash, params.body, timestamp, timestamp]
    );
  };

  const ensureWorkpad = async (params: { issueId: string; initialBody: string }): Promise<{ commentId: string }> => {
    const body = normalizeText(params.initialBody);
    const existing = getRow(params.issueId);
    if (existing?.comment_id) {
      if (existing.last_body_hash !== bodyHash(body)) {
        await args.issueTracker.updateComment(existing.comment_id, body);
        upsertRow({ issueId: params.issueId, commentId: existing.comment_id, body });
      }
      return { commentId: existing.comment_id };
    }

    const created = await args.issueTracker.createComment(params.issueId, body);
    upsertRow({ issueId: params.issueId, commentId: created.commentId, body });
    return { commentId: created.commentId };
  };

  const updateWorkpad = async (params: { issueId: string; body: string }): Promise<{ commentId: string }> => {
    const body = normalizeText(params.body);
    const existing = getRow(params.issueId);
    if (!existing?.comment_id) {
      return ensureWorkpad({ issueId: params.issueId, initialBody: body });
    }

    if (existing.last_body_hash === bodyHash(body)) {
      return { commentId: existing.comment_id };
    }

    await args.issueTracker.updateComment(existing.comment_id, body);
    upsertRow({ issueId: params.issueId, commentId: existing.comment_id, body });
    return { commentId: existing.comment_id };
  };

  const buildHeader = (issue: NormalizedLinearIssue): string => {
    return [
      "## ADE Workpad",
      "",
      `Issue: ${issue.identifier} — ${issue.title}`,
      `Issue updated at: ${issue.updatedAt}`,
      "",
    ].join("\n");
  };

  const publishMissionStart = async (params: {
    issue: NormalizedLinearIssue;
    missionId: string;
    missionTitle: string;
    templateId: string;
    routeReason: string;
    workerName?: string | null;
  }): Promise<void> => {
    const body = [
      buildHeader(params.issue),
      "### Status",
      "- State: In Progress",
      `- Mission: ${params.missionId}`,
      `- Mission title: ${params.missionTitle}`,
      `- Template: ${params.templateId}`,
      `- Worker: ${params.workerName ?? "auto"}`,
      "",
      "### Plan",
      `- ${params.routeReason}`,
      "- Execute implementation and tests before closeout.",
    ].join("\n");

    await ensureWorkpad({ issueId: params.issue.id, initialBody: body });
  };

  const publishMissionProgress = async (params: {
    issue: NormalizedLinearIssue;
    missionId: string;
    status: string;
    stepSummary?: string;
    lastError?: string | null;
  }): Promise<void> => {
    const body = [
      buildHeader(params.issue),
      "### Status",
      `- State: ${params.status}`,
      `- Mission: ${params.missionId}`,
      ...(params.stepSummary ? ["", "### Progress", `- ${params.stepSummary}`] : []),
      ...(params.lastError ? ["", "### Latest Error", `- ${params.lastError}`] : []),
    ].join("\n");

    await updateWorkpad({ issueId: params.issue.id, body });
  };

  const publishWorkflowStatus = async (params: {
    issue: NormalizedLinearIssue;
    workflowName: string;
    runId: string;
    targetType: string;
    state: string;
    currentStep?: string | null;
    delegatedOwner?: string | null;
    laneId?: string | null;
    missionId?: string | null;
    sessionId?: string | null;
    workerRunId?: string | null;
    prId?: string | null;
    reviewState?: string | null;
    reviewReadyReason?: string | null;
    waitingFor?: string | null;
    note?: string | null;
  }): Promise<void> => {
    const body = [
      buildHeader(params.issue),
      "### Workflow",
      `- Workflow: ${params.workflowName}`,
      `- Run: ${params.runId}`,
      `- Target: ${params.targetType.replace(/_/g, " ")}`,
      `- State: ${params.state.replace(/_/g, " ")}`,
      ...(params.currentStep ? [`- Current step: ${params.currentStep}`] : []),
      ...(params.delegatedOwner ? [`- Delegated owner: ${params.delegatedOwner}`] : []),
      ...(params.laneId ? [`- Lane: ${params.laneId}`] : []),
      ...(params.missionId ? [`- Mission: ${params.missionId}`] : []),
      ...(params.sessionId ? [`- Session: ${params.sessionId}`] : []),
      ...(params.workerRunId ? [`- Worker run: ${params.workerRunId}`] : []),
      ...(params.prId ? [`- PR: ${params.prId}`] : []),
      ...(params.reviewState ? [`- Review state: ${params.reviewState}`] : []),
      ...(params.reviewReadyReason ? [`- Review-ready reason: ${params.reviewReadyReason}`] : []),
      ...(params.waitingFor ? [`- Waiting for: ${params.waitingFor}`] : []),
      "",
      "### Latest update",
      params.note?.trim() || "Workflow run updated.",
    ].join("\n");

    await updateWorkpad({ issueId: params.issue.id, body });
  };

  const uploadArtifacts = async (params: {
    issueId: string;
    artifactPaths: string[];
    mode: LinearArtifactMode;
  }): Promise<string[]> => {
    const rawEntries = uniqueStrings(params.artifactPaths.map((entry) => entry.trim()).filter((entry) => entry.length > 0));
    if (!rawEntries.length) return [];
    const uploaded: string[] = [];

    for (const entry of rawEntries) {
      if (/^(https?|file):\/\//i.test(entry)) {
        uploaded.push(entry);
        continue;
      }

      const artifactPath = path.resolve(entry);
      if (!isWithinDir(args.projectRoot, artifactPath)) {
        args.logger?.warn("linear_sync.attachment_path_outside_project", {
          issueId: params.issueId,
          artifactPath,
          projectRoot: args.projectRoot,
        });
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(artifactPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;

      if (params.mode === "links") {
        uploaded.push(`file://${artifactPath}`);
        continue;
      }

      try {
        const uploadedAttachment = await args.issueTracker.uploadAttachment({
          issueId: params.issueId,
          filePath: artifactPath,
          title: path.basename(artifactPath),
        });
        uploaded.push(uploadedAttachment.url);
      } catch (error) {
        args.logger?.warn("linear_sync.attachment_upload_failed", {
          issueId: params.issueId,
          artifactPath,
          error: getErrorMessage(error),
        });
      }
    }
    return uploaded;
  };

  const publishMissionCloseout = async (params: {
    issue: NormalizedLinearIssue;
    missionId: string;
    status: "completed" | "failed" | "canceled";
    summary: string;
    prLinks?: string[];
    artifactPaths?: string[];
    artifactMode: LinearArtifactMode;
  }): Promise<void> => {
    await publishWorkflowCloseout({
      issue: params.issue,
      status: params.status,
      summary: params.summary,
      targetLabel: "Mission",
      targetId: params.missionId,
      prLinks: params.prLinks,
      artifactPaths: params.artifactPaths,
      artifactMode: params.artifactMode,
    });
  };

  const publishWorkflowCloseout = async (params: {
    issue: NormalizedLinearIssue;
    status: "completed" | "failed" | "canceled";
    summary: string;
    targetLabel: string;
    targetId?: string | null;
    contextLines?: string[];
    prLinks?: string[];
    artifactPaths?: string[];
    artifactMode: LinearArtifactMode;
  }): Promise<void> => {
    const prLinks = uniqueStrings((params.prLinks ?? []).filter((entry) => entry.trim().length > 0));
    const uploadedArtifacts = await uploadArtifacts({
      issueId: params.issue.id,
      artifactPaths: params.artifactPaths ?? [],
      mode: params.artifactMode,
    });

    const body = [
      buildHeader(params.issue),
      "### Status",
      `- Final state: ${params.status}`,
      params.targetId?.trim().length
        ? `- ${params.targetLabel}: ${params.targetId}`
        : `- Target: ${params.targetLabel}`,
      ...uniqueStrings(params.contextLines ?? []).map((line) => `- ${line}`),
      "",
      "### Closeout Summary",
      params.summary.trim() || "No summary provided.",
      ...(prLinks.length
        ? ["", "### Pull Requests", ...prLinks.map((link) => `- ${link}`)]
        : []),
      ...(uploadedArtifacts.length
        ? ["", "### Artifacts", ...uploadedArtifacts.map((link) => `- ${link}`)]
        : []),
    ].join("\n");

    await updateWorkpad({ issueId: params.issue.id, body });
  };

  return {
    ensureWorkpad,
    updateWorkpad,
    publishMissionStart,
    publishMissionProgress,
    publishWorkflowStatus,
    publishWorkflowCloseout,
    publishMissionCloseout,
  };
}

export type LinearOutboundService = ReturnType<typeof createLinearOutboundService>;
