import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { finishPerfRun, getActiveRun, initPerfRunFromEnv } from "./perfLog";

const originalRunId = process.env.ADE_PERF_RUN_ID;
const originalScenario = process.env.ADE_PERF_SCENARIO;
const createdRunIds: string[] = [];

function restoreEnv(): void {
  if (originalRunId === undefined) {
    delete process.env.ADE_PERF_RUN_ID;
  } else {
    process.env.ADE_PERF_RUN_ID = originalRunId;
  }
  if (originalScenario === undefined) {
    delete process.env.ADE_PERF_SCENARIO;
  } else {
    process.env.ADE_PERF_SCENARIO = originalScenario;
  }
}

describe("perfLog", () => {
  afterEach(() => {
    const active = getActiveRun();
    if (active) finishPerfRun(active.runId);
    for (const runId of createdRunIds.splice(0)) {
      rmSync(join(homedir(), ".ade", "perf-runs", runId), {
        recursive: true,
        force: true,
      });
    }
    restoreEnv();
  });

  it("sanitizes env run ids to match aggregator validation", () => {
    process.env.ADE_PERF_RUN_ID = `test-run..${process.pid}`;
    process.env.ADE_PERF_SCENARIO = "boot.open-project";

    const run = initPerfRunFromEnv();

    expect(run?.runId).toBe(`test-run.${process.pid}`);
    expect(run?.runId).not.toContain("..");
    if (run) createdRunIds.push(run.runId);
  });
});
