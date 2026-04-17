import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { NormalizedLinearIssue } from "../../../shared/types";
import { openKvDb } from "../state/kvDb";
import { createLinearOutboundService } from "./linearOutboundService";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

const issueFixture: NormalizedLinearIssue = {
  id: "issue-1",
  identifier: "ABC-12",
  title: "Stabilize auth refresh",
  description: "Auth refresh sometimes fails after idle timeout.",
  url: "https://linear.app/acme/issue/ABC-12",
  projectId: "proj-1",
  projectSlug: "acme-platform",
  teamId: "team-1",
  teamKey: "ACME",
  stateId: "state-1",
  stateName: "Todo",
  stateType: "unstarted",
  priority: 2,
  priorityLabel: "high",
  labels: ["bug"],
  assigneeId: null,
  assigneeName: null,
  ownerId: "user-1",
  blockerIssueIds: [],
  hasOpenBlockers: false,
  createdAt: "2026-03-05T00:00:00.000Z",
  updatedAt: "2026-03-05T00:00:00.000Z",
  raw: {},
};

describe("linearOutboundService", () => {
  it("keeps one persistent workpad comment and avoids duplicate updates for identical body", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-outbound-"));
    const db = await openKvDb(path.join(root, "ade.db"), createLogger());

    const createComment = vi.fn(async () => ({ commentId: "comment-1" }));
    const updateComment = vi.fn(async () => {});
    const service = createLinearOutboundService({
      db,
      projectId: "project-1",
      projectRoot: root,
      issueTracker: {
        createComment,
        updateComment,
        uploadAttachment: vi.fn(),
      } as any,
      logger: createLogger(),
    });

    await service.publishMissionStart({
      issue: issueFixture,
      missionId: "mission-1",
      missionTitle: "Fix auth refresh",
      templateId: "bug-fix",
      routeReason: "Matched bug rule",
      workerName: "Backend Dev",
    });
    expect(createComment).toHaveBeenCalledTimes(1);

    await service.publishMissionProgress({
      issue: issueFixture,
      missionId: "mission-1",
      status: "in_progress",
      stepSummary: "1/3 steps completed.",
    });
    await service.publishMissionProgress({
      issue: issueFixture,
      missionId: "mission-1",
      status: "in_progress",
      stepSummary: "1/3 steps completed.",
    });

    expect(updateComment).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("reuses the same workpad comment across workflow launch, progress, and final closeout", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-workpad-lifecycle-"));
    const db = await openKvDb(path.join(root, "ade.db"), createLogger());
    const createComment = vi.fn(async () => ({ commentId: "comment-workpad-1" }));
    const updateBodies: string[] = [];
    const updateComment = vi.fn(async (_commentId: string, body: string) => {
      updateBodies.push(body);
    });
    const service = createLinearOutboundService({
      db,
      projectId: "project-1",
      projectRoot: root,
      issueTracker: {
        createComment,
        updateComment,
        uploadAttachment: vi.fn(),
      } as any,
      logger: createLogger(),
    });

    await service.publishWorkflowStatus({
      issue: issueFixture,
      workflowName: "Assigned worker run",
      runId: "run-1",
      targetType: "worker_run",
      state: "waiting_for_target",
      currentStep: "Launch worker run",
      delegatedOwner: "backend-dev",
      laneId: "lane-22",
      workerRunId: "worker-run-22",
      note: "Delegated the issue into a dedicated worker lane.",
    });
    await service.publishWorkflowStatus({
      issue: issueFixture,
      workflowName: "Assigned worker run",
      runId: "run-1",
      targetType: "worker_run",
      state: "waiting_for_pr",
      currentStep: "Wait for PR",
      delegatedOwner: "backend-dev",
      laneId: "lane-22",
      workerRunId: "worker-run-22",
      prId: "pr-22",
      waitingFor: "review-ready PR",
      note: "PR linked and awaiting review-ready state.",
    });
    await service.publishWorkflowCloseout({
      issue: issueFixture,
      status: "completed",
      summary: "Validated proof and closed out the delegated workflow.",
      targetLabel: "worker run",
      targetId: "worker-run-22",
      contextLines: ["Lane: lane-22", "Linked PR record: pr-22"],
      prLinks: ["https://github.com/acme/repo/pull/22"],
      artifactMode: "links",
    });

    expect(createComment).toHaveBeenCalledTimes(1);
    expect(updateComment).toHaveBeenCalledTimes(2);
    expect(updateBodies[0]).toContain("- Lane: lane-22");
    expect(updateBodies[0]).toContain("- Worker run: worker-run-22");
    expect(updateBodies[1]).toContain("### Closeout Summary");
    expect(updateBodies[1]).toContain("https://github.com/acme/repo/pull/22");

    const stored = db.get<{ comment_id: string }>(
      `select comment_id from linear_workpads where project_id = ? and issue_id = ? limit 1`,
      ["project-1", issueFixture.id]
    );
    expect(stored?.comment_id).toBe("comment-workpad-1");
    db.close();
  });

  it("preserves inside-project artifact links and rejects files outside the project root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-artifacts-"));
    const db = await openKvDb(path.join(root, "ade.db"), createLogger());
    const insideArtifact = path.join(root, "build.log");
    fs.writeFileSync(insideArtifact, "log", "utf8");
    const outsideArtifact = path.join(os.tmpdir(), "outside.log");
    fs.writeFileSync(outsideArtifact, "outside", "utf8");

    const updateBodies: string[] = [];
    const service = createLinearOutboundService({
      db,
      projectId: "project-1",
      projectRoot: root,
      issueTracker: {
        createComment: vi.fn(async () => ({ commentId: "comment-1" })),
        updateComment: vi.fn(async (_commentId: string, body: string) => {
          updateBodies.push(body);
        }),
        uploadAttachment: vi.fn(),
      } as any,
      logger: createLogger(),
    });

    await service.publishMissionStart({
      issue: issueFixture,
      missionId: "mission-1",
      missionTitle: "Auth mission",
      templateId: "bug-fix",
      routeReason: "Matched bug",
    });

    await service.publishWorkflowCloseout({
      issue: issueFixture,
      status: "completed",
      summary: "Shipped",
      targetLabel: "employee session",
      targetId: "session-1",
      contextLines: ["Workflow target: employee_session"],
      artifactMode: "links",
      artifactPaths: [insideArtifact, outsideArtifact, "https://example.com/artifact.txt"],
    });

    const latest = updateBodies[updateBodies.length - 1] ?? "";
    expect(latest).toContain(`file://${insideArtifact}`);
    expect(latest).toContain("https://example.com/artifact.txt");
    expect(latest).not.toContain(`file://${outsideArtifact}`);
    db.close();
  });

  it("uploads attachment-mode artifacts from inside the project root and skips files outside it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-attachment-upload-"));
    const db = await openKvDb(path.join(root, "ade.db"), createLogger());
    const insideArtifact = path.join(root, "inside.png");
    const outsideArtifact = path.join(os.tmpdir(), `ade-outside-${Date.now()}.png`);
    fs.writeFileSync(insideArtifact, "inside", "utf8");
    fs.writeFileSync(outsideArtifact, "outside", "utf8");

    const uploadAttachment = vi.fn(async ({ filePath }: { filePath: string }) => ({
      url: `https://linear.example/${path.basename(filePath)}`,
    }));
    const updateBodies: string[] = [];
    const service = createLinearOutboundService({
      db,
      projectId: "project-1",
      projectRoot: root,
      issueTracker: {
        createComment: vi.fn(async () => ({ commentId: "comment-1" })),
        updateComment: vi.fn(async (_commentId: string, body: string) => {
          updateBodies.push(body);
        }),
        uploadAttachment,
      } as any,
      logger: createLogger(),
    });

    await service.publishMissionStart({
      issue: issueFixture,
      missionId: "mission-1",
      missionTitle: "Auth mission",
      templateId: "bug-fix",
      routeReason: "Matched bug",
    });

    await service.publishWorkflowCloseout({
      issue: issueFixture,
      status: "completed",
      summary: "Uploaded proof artifacts.",
      targetLabel: "employee session",
      targetId: "session-1",
      artifactMode: "attachments",
      artifactPaths: [insideArtifact, outsideArtifact],
    });

    expect(uploadAttachment).toHaveBeenCalledTimes(1);
    expect(uploadAttachment).toHaveBeenCalledWith({
      issueId: issueFixture.id,
      filePath: insideArtifact,
      title: path.basename(insideArtifact),
    });

    const latest = updateBodies[updateBodies.length - 1] ?? "";
    expect(latest).toContain(`https://linear.example/${path.basename(insideArtifact)}`);
    expect(latest).not.toContain(`https://linear.example/${path.basename(outsideArtifact)}`);
    db.close();
  });

  it("keeps the mission closeout wrapper body shape stable", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-mission-closeout-"));
    const db = await openKvDb(path.join(root, "ade.db"), createLogger());
    const updateBodies: string[] = [];
    const service = createLinearOutboundService({
      db,
      projectId: "project-1",
      projectRoot: root,
      issueTracker: {
        createComment: vi.fn(async () => ({ commentId: "comment-1" })),
        updateComment: vi.fn(async (_commentId: string, body: string) => {
          updateBodies.push(body);
        }),
        uploadAttachment: vi.fn(),
      } as any,
      logger: createLogger(),
    });

    await service.publishMissionStart({
      issue: issueFixture,
      missionId: "mission-1",
      missionTitle: "Auth mission",
      templateId: "bug-fix",
      routeReason: "Matched bug",
    });

    await service.publishMissionCloseout({
      issue: issueFixture,
      missionId: "mission-1",
      status: "completed",
      summary: "Shipped",
      artifactMode: "links",
    });

    const latest = updateBodies[updateBodies.length - 1] ?? "";
    expect(latest).toContain("- Mission: mission-1");
    expect(latest).not.toContain("- Target:");
    db.close();
  });

  it("renders comment templates for workflow status and closeout bodies", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-template-comment-"));
    const db = await openKvDb(path.join(root, "ade.db"), createLogger());
    const createBodies: string[] = [];
    const bodies: string[] = [];
    const service = createLinearOutboundService({
      db,
      projectId: "project-1",
      projectRoot: root,
      issueTracker: {
        createComment: vi.fn(async (_issueId: string, body: string) => {
          createBodies.push(body);
          return { commentId: "comment-1" };
        }),
        updateComment: vi.fn(async (_commentId: string, body: string) => {
          bodies.push(body);
        }),
        uploadAttachment: vi.fn(),
      } as any,
      logger: createLogger(),
    });

    await service.publishWorkflowStatus({
      issue: issueFixture,
      workflowName: "Assigned worker run",
      runId: "run-7",
      targetType: "worker_run",
      state: "waiting_for_target",
      note: "Delegated the issue.",
      waitingFor: "delegated work",
      commentTemplate: [
        "Issue {{ issue.identifier }}",
        "Workflow {{ workflow.name }}",
        "Target {{ target.type }}",
        "Note {{ note }}",
      ].join("\n"),
    });

    await service.publishWorkflowCloseout({
      issue: issueFixture,
      status: "completed",
      summary: "Closed.",
      targetLabel: "worker run",
      targetId: "worker-22",
      artifactMode: "links",
      commentTemplate: "Closeout {{ issue.identifier }} {{ target.id }} {{ note }}",
    });

    expect(createBodies[0]).toContain("Issue ABC-12");
    expect(createBodies[0]).toContain("Workflow Assigned worker run");
    expect(createBodies[0]).toContain("Target worker_run");
    expect(bodies[0]).toContain("Closeout ABC-12 worker-22 Closed.");
    db.close();
  });
});
