import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LinearSyncConfig } from "../../../shared/types";
import { createLinearWorkflowFileService } from "./linearWorkflowFileService";

function createFixtureRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-workflows-"));
}

describe("linearWorkflowFileService", () => {
  it("generates editable starter workflows when the repo has no workflow files", () => {
    const root = createFixtureRoot();
    const service = createLinearWorkflowFileService({ projectRoot: root });

    const loaded = service.load(null);

    expect(loaded.source).toBe("generated");
    expect(loaded.migration?.needsSave).toBe(true);
    expect(loaded.settings.ctoLinearAssigneeName).toBe("CTO");
    expect(loaded.workflows.map((workflow) => workflow.id)).toEqual([
      "cto-mission-autopilot",
      "cto-direct-employee-session",
      "cto-pr-fast-lane",
      "cto-human-review-gate",
    ]);

    const saved = service.save(loaded);

    expect(saved.source).toBe("repo");
    expect(saved.files.some((file) => file.kind === "settings")).toBe(true);
    expect(saved.files.filter((file) => file.kind === "workflow")).toHaveLength(4);
    expect(fs.existsSync(path.join(root, ".ade", "workflows", "linear", "_settings.yaml"))).toBe(true);
  });

  it("migrates legacy LinearSyncConfig into repo workflows and writes a compatibility snapshot", () => {
    const root = createFixtureRoot();
    const service = createLinearWorkflowFileService({ projectRoot: root });
    const legacy: LinearSyncConfig = {
      enabled: true,
      projects: [{ slug: "acme-platform", defaultWorker: "backend-dev" }],
      routing: {
        byLabel: {
          bug: "backend-hotfix",
        },
      },
      autoDispatch: {
        default: "auto",
        rules: [
          {
            id: "legacy-bug-rule",
            action: "auto",
            template: "fast-track",
            match: {
              labels: ["bug"],
              projectSlugs: ["acme-platform"],
              priority: ["high"],
            },
          },
        ],
      },
      concurrency: {
        global: 7,
      },
      artifacts: {
        mode: "attachments",
      },
    };

    const loaded = service.load(legacy);
    const migrated = loaded.workflows.find((workflow) => workflow.id === "legacy-bug-rule");

    expect(loaded.source).toBe("generated");
    expect(loaded.migration?.hasLegacyConfig).toBe(true);
    expect(loaded.migration?.needsSave).toBe(true);
    expect(migrated?.target.type).toBe("mission");
    expect(migrated?.target.missionTemplate).toBe("fast-track");
    expect(migrated?.target.workerSelector).toEqual({ mode: "slug", value: "backend-hotfix" });
    expect(migrated?.triggers.labels).toEqual(["bug"]);
    expect(migrated?.triggers.projectSlugs).toEqual(["acme-platform"]);
    expect(migrated?.closeout?.artifactMode).toBe("attachments");
    expect(migrated?.concurrency?.maxActiveRuns).toBe(7);

    const saved = service.save(loaded);

    expect(saved.source).toBe("repo");
    expect(saved.migration?.needsSave).toBe(false);
    expect(saved.migration?.compatibilitySnapshotPath).toBe(service.legacySnapshotPath);
    expect(fs.existsSync(service.legacySnapshotPath)).toBe(true);
  });
});
