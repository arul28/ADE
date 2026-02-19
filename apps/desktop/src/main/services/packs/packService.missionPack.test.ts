import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPackService } from "./packService";
import { openKvDb } from "../state/kvDb";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  } as any;
}

describe("packService mission pack", () => {
  it("refreshes mission packs with durable version/event metadata", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pack-mission-"));
    const packsDir = path.join(projectRoot, ".ade", "packs");
    fs.mkdirSync(path.join(projectRoot, "docs", "architecture"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "docs", "PRD.md"), "# PRD\n\nMission pack tests\n", "utf8");

    const db = await openKvDb(path.join(projectRoot, "ade.db"), createLogger());
    const projectId = "proj-1";
    const laneId = "lane-1";
    const missionId = "mission-1";
    const now = "2026-02-19T00:00:00.000Z";

    db.run(
      `
        insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
        values (?, ?, ?, ?, ?, ?)
      `,
      [projectId, projectRoot, "ADE", "main", now, now]
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
        projectRoot,
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
    db.run(
      `
        insert into missions(
          id,
          project_id,
          lane_id,
          title,
          prompt,
          status,
          priority,
          execution_mode,
          target_machine_id,
          outcome_summary,
          last_error,
          metadata_json,
          created_at,
          updated_at,
          started_at,
          completed_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [missionId, projectId, laneId, "Mission 1", "Implement context hardening gate.", "in_progress", "high", "local", null, null, null, null, now, now, now, null]
    );
    db.run(
      `
        insert into mission_steps(
          id,
          mission_id,
          project_id,
          step_index,
          title,
          detail,
          kind,
          lane_id,
          status,
          metadata_json,
          created_at,
          updated_at,
          started_at,
          completed_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ["mstep-1", missionId, projectId, 0, "Design runtime contracts", null, "manual", laneId, "running", null, now, now, now, null]
    );
    db.run(
      `
        insert into orchestrator_runs(
          id,
          project_id,
          mission_id,
          status,
          context_profile,
          scheduler_state,
          runtime_cursor_json,
          last_error,
          metadata_json,
          created_at,
          updated_at,
          started_at,
          completed_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ["run-1", projectId, missionId, "running", "orchestrator_deterministic_v1", "active", null, null, null, now, now, now, null]
    );
    db.run(
      `
        insert into mission_step_handoffs(
          id,
          project_id,
          mission_id,
          mission_step_id,
          run_id,
          step_id,
          attempt_id,
          handoff_type,
          producer,
          payload_json,
          created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ["handoff-1", projectId, missionId, "mstep-1", "run-1", "ostep-1", "attempt-1", "attempt_started", "orchestrator", "{\"summary\":\"started\"}", now]
    );

    const packService = createPackService({
      db,
      logger: createLogger(),
      projectRoot,
      projectId,
      packsDir,
      laneService: {
        list: async () => [],
        getLaneBaseAndBranch: () => ({ worktreePath: projectRoot, baseRef: "main", branchRef: "feature/lane-1" })
      } as any,
      sessionService: { readTranscriptTail: () => "" } as any,
      projectConfigService: {
        get: () => ({
          local: { providers: {} },
          effective: {
            providerMode: "guest",
            providers: {},
            processes: [],
            testSuites: [],
            stackButtons: []
          }
        })
      } as any,
      operationService: {
        start: () => ({ operationId: "op-1" }),
        finish: () => {}
      } as any
    });

    const refreshed = await packService.refreshMissionPack({
      missionId,
      reason: "test_refresh",
      runId: "run-1"
    });

    expect(refreshed.packType).toBe("mission");
    expect(refreshed.packKey).toBe(`mission:${missionId}`);
    expect(refreshed.exists).toBe(true);
    expect(refreshed.versionId).toBeTruthy();
    expect(refreshed.versionNumber).toBeGreaterThan(0);
    expect(refreshed.contentHash).toBeTruthy();
    expect(refreshed.body).toContain("Mission Pack:");
    expect(refreshed.body).toContain("Step Handoffs");
    expect(refreshed.body).toContain("attempt_started");
    expect(refreshed.body).toContain("Orchestrator Runs");

    const fetched = packService.getMissionPack(missionId);
    expect(fetched.exists).toBe(true);
    expect(fetched.packType).toBe("mission");
    expect(fetched.versionId).toBe(refreshed.versionId);
    expect(fetched.versionNumber).toBe(refreshed.versionNumber);

    const versions = packService.listVersions({ packKey: `mission:${missionId}` });
    expect(versions.length).toBeGreaterThan(0);
    expect(versions[0]?.packType).toBe("mission");

    const events = packService.listEvents({ packKey: `mission:${missionId}` });
    expect(events.some((event) => event.eventType === "refresh_triggered")).toBe(true);

    const indexRow = db.get<{ metadata_json: string | null; pack_type: string }>(
      "select metadata_json, pack_type from packs_index where project_id = ? and pack_key = ? limit 1",
      [projectId, `mission:${missionId}`]
    );
    expect(indexRow?.pack_type).toBe("mission");
    const metadata = (() => {
      try {
        return indexRow?.metadata_json ? (JSON.parse(indexRow.metadata_json) as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    })();
    expect(metadata?.reason).toBe("test_refresh");
    expect(metadata?.runId).toBe("run-1");
    expect(typeof metadata?.versionId).toBe("string");
    expect(typeof metadata?.contentHash).toBe("string");

    db.close();
  });
});
