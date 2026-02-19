import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createMissionService } from "./missionService";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  } as any;
}

async function createDbWithProjectAndLane() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-mission-service-"));
  const dbPath = path.join(root, "ade.db");
  const db = await openKvDb(dbPath, createLogger());

  const projectId = "proj-1";
  const laneId = "lane-1";
  const now = "2026-02-18T00:00:00.000Z";

  db.run(
    `
      insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
      values (?, ?, ?, ?, ?, ?)
    `,
    [projectId, root, "ADE", "main", now, now]
  );

  db.run(
    `
      insert into lanes(
        id,
        project_id,
        name,
        description,
        lane_type,
        base_ref,
        branch_ref,
        worktree_path,
        attached_root_path,
        is_edit_protected,
        parent_lane_id,
        color,
        icon,
        tags_json,
        status,
        created_at,
        archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      laneId,
      projectId,
      "Lane 1",
      null,
      "worktree",
      "main",
      "feature/lane-1",
      root,
      null,
      0,
      null,
      null,
      null,
      null,
      "active",
      now,
      null
    ]
  );

  return {
    db,
    projectId,
    laneId,
    dispose: () => db.close()
  };
}

describe("missionService lifecycle", () => {
  it("supports valid mission lifecycle transitions", async () => {
    const { db, projectId, laneId, dispose } = await createDbWithProjectAndLane();
    const service = createMissionService({ db, projectId });

    const created = service.create({
      prompt: "Implement profile tab improvements and prepare PR summary.",
      laneId
    });

    expect(created.status).toBe("queued");
    expect(created.steps.length).toBeGreaterThan(0);

    const started = service.update({ missionId: created.id, status: "in_progress" });
    expect(started.status).toBe("in_progress");

    const intervention = service.addIntervention({
      missionId: created.id,
      interventionType: "manual_input",
      title: "Need design confirmation",
      body: "Confirm whether we should preserve the old spacing scale."
    });

    expect(intervention.status).toBe("open");

    const paused = service.get(created.id);
    expect(paused?.status).toBe("intervention_required");
    expect(paused?.openInterventions).toBe(1);

    service.resolveIntervention({
      missionId: created.id,
      interventionId: intervention.id,
      status: "resolved",
      note: "Proceed with the new spacing scale."
    });

    const resumed = service.get(created.id);
    expect(resumed?.status).toBe("in_progress");
    expect(resumed?.openInterventions).toBe(0);

    const completed = service.update({
      missionId: created.id,
      status: "completed",
      outcomeSummary: "Updated profile layout and linked PR #123."
    });

    expect(completed.status).toBe("completed");
    expect(completed.outcomeSummary).toContain("PR #123");
    expect(completed.artifacts.some((artifact) => artifact.artifactType === "summary")).toBe(true);

    dispose();
  });

  it("rejects invalid mission and step transitions", async () => {
    const { db, projectId, laneId, dispose } = await createDbWithProjectAndLane();
    const service = createMissionService({ db, projectId });

    const created = service.create({
      prompt: "Write migration notes and close release lane.",
      laneId
    });

    expect(() => service.update({ missionId: created.id, status: "completed" })).toThrow(/Invalid mission transition/i);

    const firstStep = service.get(created.id)?.steps[0];
    expect(firstStep).toBeTruthy();
    if (!firstStep) {
      dispose();
      throw new Error("Expected first step");
    }

    expect(() =>
      service.updateStep({
        missionId: created.id,
        stepId: firstStep.id,
        status: "succeeded"
      })
    ).toThrow(/Invalid mission step transition/i);

    dispose();
  });

  it("creates intervention-required status when a running step fails", async () => {
    const { db, projectId, laneId, dispose } = await createDbWithProjectAndLane();
    const service = createMissionService({ db, projectId });

    const created = service.create({
      prompt: "Refactor auth checks and run regression tests.",
      laneId
    });

    service.update({ missionId: created.id, status: "in_progress" });

    const firstStep = service.get(created.id)?.steps[0];
    expect(firstStep).toBeTruthy();
    if (!firstStep) {
      dispose();
      throw new Error("Expected first step");
    }

    service.updateStep({
      missionId: created.id,
      stepId: firstStep.id,
      status: "running"
    });

    service.updateStep({
      missionId: created.id,
      stepId: firstStep.id,
      status: "failed",
      note: "Unit tests failed in CI parity suite."
    });

    const detail = service.get(created.id);
    expect(detail?.status).toBe("intervention_required");
    expect(detail?.openInterventions).toBeGreaterThan(0);
    expect(detail?.lastError).toContain("Unit tests failed");

    dispose();
  });
});
