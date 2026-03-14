import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openKvDb } from "../state/kvDb";
import { createPackService } from "./packService";

function makeLanePackBody(args: { taskSpec: string; intent: string; narrative?: string }): string {
  return [
    "# Lane: demo",
    "",
    "## Task Spec",
    "<!-- ADE_TASK_SPEC_START -->",
    args.taskSpec,
    "<!-- ADE_TASK_SPEC_END -->",
    "",
    "## Why",
    "<!-- ADE_INTENT_START -->",
    args.intent,
    "<!-- ADE_INTENT_END -->",
    "",
    "## Narrative",
    "<!-- ADE_NARRATIVE_START -->",
    args.narrative ?? "",
    "<!-- ADE_NARRATIVE_END -->",
    "",
    "## Sessions",
    "| When | Tool | Goal | Result | Delta |",
    "|------|------|------|--------|-------|",
    "| 12:00 | Shell | npm test | ok | +1/-0 |",
    ""
  ].join("\n");
}

describe("packService.getDeltaDigest", () => {
  it("returns changed sections and injects event meta for legacy payloads", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-delta-"));
    const packsDir = path.join(tmpRoot, "packs");
    fs.mkdirSync(packsDir, { recursive: true });

    const dbPath = path.join(tmpRoot, "kv.sqlite");
    const logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {}
    } as any;
    const db = await openKvDb(dbPath, logger);

    const projectId = "proj-1";
    const now = "2026-02-15T19:00:00.000Z";
    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      [projectId, tmpRoot, "demo", "main", now, now]
    );
    db.run(
      `
        insert into lanes(
          id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
          attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ["lane-1", projectId, "demo", null, "worktree", "main", "ade/demo", tmpRoot, null, 0, null, null, null, null, "active", now, null]
    );

    const packService = createPackService({
      db,
      logger,
      projectRoot: tmpRoot,
      projectId,
      packsDir,
      laneService: { list: async () => [], getLaneBaseAndBranch: () => ({ worktreePath: tmpRoot, baseRef: "main", branchRef: "ade/demo" }) } as any,
      sessionService: { readTranscriptTail: () => "" } as any,
      projectConfigService: { get: () => ({ local: { providers: {} }, effective: { providerMode: "guest", providers: {}, processes: [], testSuites: [], stackButtons: [] } }) } as any,
      operationService: { start: () => ({ operationId: "op-1" }), finish: () => {} } as any
    });

    const versionsDir = path.join(packsDir, "versions");
    fs.mkdirSync(versionsDir, { recursive: true });

    const beforeId = randomUUID();
    const afterId = randomUUID();
    const beforePath = path.join(versionsDir, `${beforeId}.md`);
    const afterPath = path.join(versionsDir, `${afterId}.md`);

    const beforeBody = makeLanePackBody({ taskSpec: "old spec", intent: "old intent" });
    const afterBody = makeLanePackBody({ taskSpec: "new spec", intent: "old intent" });
    fs.writeFileSync(beforePath, beforeBody, "utf8");
    fs.writeFileSync(afterPath, afterBody, "utf8");

    const t0 = "2026-02-15T19:01:00.000Z";
    const t1 = "2026-02-15T19:10:00.000Z";
    db.run(
      "insert into pack_versions(id, project_id, pack_key, version_number, content_hash, rendered_path, created_at) values (?, ?, ?, ?, ?, ?, ?)",
      [beforeId, projectId, "lane:lane-1", 1, "hash1", beforePath, t0]
    );
    db.run(
      "insert into pack_versions(id, project_id, pack_key, version_number, content_hash, rendered_path, created_at) values (?, ?, ?, ?, ?, ?, ?)",
      [afterId, projectId, "lane:lane-1", 2, "hash2", afterPath, t1]
    );
    db.run(
      "insert into pack_heads(project_id, pack_key, current_version_id, updated_at) values (?, ?, ?, ?)",
      [projectId, "lane:lane-1", afterId, t1]
    );

    // Insert a legacy event without meta keys; getDeltaDigest should still be able to filter/select via injected meta.
    const eventId = randomUUID();
    db.run(
      "insert into pack_events(id, project_id, pack_key, event_type, payload_json, created_at) values (?, ?, ?, ?, ?, ?)",
      [eventId, projectId, "lane:lane-1", "refresh_triggered", JSON.stringify({ trigger: "session_end", laneId: "lane-1" }), "2026-02-15T19:05:00.000Z"]
    );
    for (let i = 0; i < 12; i += 1) {
      db.run(
        "insert into pack_events(id, project_id, pack_key, event_type, payload_json, created_at) values (?, ?, ?, ?, ?, ?)",
        [
          randomUUID(),
          projectId,
          "lane:lane-1",
          "refresh_triggered",
          JSON.stringify({ trigger: "session_end", laneId: "lane-1", i }),
          `2026-02-15T19:${String(6 + i).padStart(2, "0")}:00.000Z`
        ]
      );
    }

    const digest = await packService.getDeltaDigest({
      packKey: "lane:lane-1",
      sinceVersionId: beforeId,
      minimumImportance: "medium",
      limit: 10
    });

    expect(digest.newVersion.versionId).toBe(afterId);
    expect(digest.changedSections.some((c) => c.sectionId === "task_spec" && c.changeType === "modified")).toBe(true);
    expect(digest.highImpactEvents.length).toBeGreaterThan(0);
    expect((digest.highImpactEvents[0]!.payload as any).importance).toBeDefined();
    expect((digest.highImpactEvents[0]!.payload as any).category).toBeDefined();
    expect(digest.clipReason).toBe("budget_clipped");
    expect(digest.omittedSections).toContain("events:limit_cap");
  });
});
