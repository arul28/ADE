import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { aggregate } from "./aggregator";

const createdRunIds: string[] = [];

function writeEvents(runId: string, events: Array<Record<string, unknown>>): void {
  createdRunIds.push(runId);
  const dir = join(homedir(), ".ade", "perf-runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "events.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
}

describe("aggregate", () => {
  afterEach(() => {
    for (const runId of createdRunIds.splice(0)) {
      rmSync(join(homedir(), ".ade", "perf-runs", runId), {
        recursive: true,
        force: true,
      });
    }
  });

  it("rejects traversal run ids", () => {
    expect(() => aggregate("../outside")).toThrow(/Invalid perf run id/);
  });

  it("skips malformed process metric samples", () => {
    const runId = `test-run-${process.pid}-${Date.now()}`;
    writeEvents(runId, [
      { ts: 1, kind: "scenarioStart", scenario: "boot.open-project" },
      { ts: 2, kind: "processMetrics" },
      {
        ts: 3,
        kind: "processMetrics",
        processes: [{ pid: 1, type: "Browser", cpuPercent: 12, workingSetSizeKb: 256 }],
        mainRss: 1024,
        mainHeapUsed: 512,
      },
      { ts: 4, kind: "scenarioEnd", scenario: "boot.open-project", ok: true },
    ]);

    const summary = aggregate(runId);

    expect(summary.process.mainCpuPercentP95).toBe(12);
    expect(summary.scenarios["boot.open-project"]?.ok).toBe(true);
  });
});
