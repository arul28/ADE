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

  it("filters artifact links outside project root while preserving remote links", async () => {
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

    await service.publishMissionCloseout({
      issue: issueFixture,
      missionId: "mission-1",
      status: "completed",
      summary: "Shipped",
      artifactMode: "links",
      artifactPaths: [insideArtifact, outsideArtifact, "https://example.com/artifact.txt"],
    });

    const latest = updateBodies[updateBodies.length - 1] ?? "";
    expect(latest).toContain(`file://${insideArtifact}`);
    expect(latest).toContain("https://example.com/artifact.txt");
    expect(latest).not.toContain(`file://${outsideArtifact}`);
    db.close();
  });
});
