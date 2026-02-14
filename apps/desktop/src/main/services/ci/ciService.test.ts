import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCiService } from "./ciService";
import type { AdeDb } from "../state/kvDb";
import type { ProjectConfigFile } from "../../../shared/types";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  } as any;
}

function createInMemoryAdeDb(): AdeDb {
  const kv = new Map<string, unknown>();
  return {
    getJson: <T,>(key: string) => (kv.has(key) ? (kv.get(key) as T) : null),
    setJson: (key: string, value: unknown) => {
      kv.set(key, value);
    },
    run: () => {},
    get: () => null,
    all: () => [],
    flushNow: () => {},
    close: () => {}
  };
}

function createInMemoryProjectConfigService(): {
  get: () => { shared: ProjectConfigFile; local: ProjectConfigFile };
  save: (args: { shared: ProjectConfigFile; local: ProjectConfigFile }) => { shared: ProjectConfigFile; local: ProjectConfigFile };
} {
  const empty: ProjectConfigFile = {
    version: 1,
    processes: [],
    stackButtons: [],
    testSuites: [],
    laneOverlayPolicies: [],
    automations: []
  };

  let shared: ProjectConfigFile = { ...empty };
  let local: ProjectConfigFile = { ...empty };

  return {
    get: () => ({ shared, local }),
    save: ({ shared: nextShared, local: nextLocal }: { shared: ProjectConfigFile; local: ProjectConfigFile }) => {
      shared = nextShared;
      local = nextLocal;
      return { shared, local };
    }
  };
}

function writeText(absPath: string, content: string) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, "utf8");
}

describe("ciService integration", () => {
  it("imports a GitHub Actions job as a test suite and persists import state", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-ci-"));
    try {
      const workflowPath = path.join(projectRoot, ".github", "workflows", "ci.yml");
      writeText(
        workflowPath,
        [
          "name: CI",
          "on: [push]",
          "jobs:",
          "  test:",
          "    steps:",
          "      - run: npm test",
          ""
        ].join("\n")
      );

      const db = createInMemoryAdeDb();
      const projectConfigService = createInMemoryProjectConfigService();
      const service = createCiService({
        db,
        logger: createLogger(),
        projectRoot,
        projectConfigService: projectConfigService as any
      });

      const scan1 = await service.scan();
      const job1 = scan1.jobs.find((j) => j.provider === "github-actions" && j.jobName === "test");
      expect(job1).toBeTruthy();
      expect(job1?.suggestedCommand).toEqual(["npm", "test"]);

      const import1 = await service.import({
        mode: "import",
        selections: [{ jobId: job1!.id, kind: "testSuite" }]
      });
      const mappedId = import1.importState.importedJobs[0]?.targetId;
      expect(typeof mappedId).toBe("string");
      expect(mappedId).toMatch(/^ci_/);

      const snapshot1 = projectConfigService.get();
      const suite1 = (snapshot1.shared.testSuites ?? []).find((t) => t.id === mappedId);
      expect(suite1).toBeTruthy();
      expect(suite1?.command).toEqual(["npm", "test"]);

      // Update workflow command and run sync; mapping should be preserved.
      writeText(
        workflowPath,
        [
          "name: CI",
          "on: [push]",
          "jobs:",
          "  test:",
          "    steps:",
          "      - run: pnpm test",
          ""
        ].join("\n")
      );

      const scan2 = await service.scan();
      const job2 = scan2.jobs.find((j) => j.id === job1!.id);
      expect(job2).toBeTruthy();
      expect(job2?.suggestedCommand).toEqual(["pnpm", "test"]);

      const import2 = await service.import({
        mode: "sync",
        selections: [{ jobId: job1!.id, kind: "testSuite" }]
      });
      expect(import2.importState.importedJobs[0]?.targetId).toBe(mappedId);

      const snapshot2 = projectConfigService.get();
      const suite2 = (snapshot2.shared.testSuites ?? []).find((t) => t.id === mappedId);
      expect(suite2).toBeTruthy();
      expect(suite2?.command).toEqual(["pnpm", "test"]);

      const stored = db.getJson("ci:import_state");
      expect(stored).toBeTruthy();
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
