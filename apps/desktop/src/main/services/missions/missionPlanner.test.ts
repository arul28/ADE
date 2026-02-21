import { describe, expect, it } from "vitest";
import { buildDeterministicMissionPlan } from "./missionPlanner";

function dependencyIndices(step: { metadata: Record<string, unknown> }): number[] {
  const raw = step.metadata.dependencyIndices;
  if (!Array.isArray(raw)) return [];
  return raw.map((value) => Number(value)).filter((value) => Number.isFinite(value)).map((value) => Math.floor(value));
}

describe("missionPlanner deterministic fan-out", () => {
  it("keeps backend/runtime/ui root branches as executable parallel leaves", () => {
    const prompt = [
      "1) Create 3 root implementation branches that can run in parallel:",
      "- Backend: add GET /api/health returning { ok: true, version, timestamp }.",
      "- Runtime: add heartbeat/stall recovery telemetry for orchestrated workers.",
      "- UI: show lane id, step status, and worker heartbeat age in the Missions detail panel."
    ].join("\n");

    const plan = buildDeterministicMissionPlan({ prompt, laneId: "lane-main" });
    const titles = plan.steps.map((step) => step.title);
    expect(titles).not.toContain("Create 3 root implementation branches that can run in parallel:");

    const rootSteps = plan.steps.filter((step) =>
      step.title.startsWith("Backend:")
      || step.title.startsWith("Runtime:")
      || step.title.startsWith("UI:")
    );
    expect(rootSteps.map((step) => step.title)).toEqual([
      "Backend: add GET /api/health returning { ok: true, version, timestamp }.",
      "Runtime: add heartbeat/stall recovery telemetry for orchestrated workers.",
      "UI: show lane id, step status, and worker heartbeat age in the Missions detail panel."
    ]);
    expect(rootSteps.every((step) => dependencyIndices(step).length === 0)).toBe(true);

    const integration = plan.steps.find((step) => step.title === "Integrate branch outputs");
    expect(integration).toBeTruthy();
    expect(dependencyIndices(integration!)).toEqual([0, 1, 2]);
  });

  it("does not serialize parallel implementation bullets into a sequential chain", () => {
    const prompt = [
      "- Implement the backend API route.",
      "- Implement the missions runtime heartbeat telemetry."
    ].join("\n");

    const plan = buildDeterministicMissionPlan({ prompt, laneId: "lane-main" });
    const implementationSteps = plan.steps.filter((step) => step.kind === "implementation");
    expect(implementationSteps).toHaveLength(2);
    expect(implementationSteps.every((step) => dependencyIndices(step).length === 0)).toBe(true);

    const integration = plan.steps.find((step) => step.title === "Integrate branch outputs");
    expect(integration).toBeTruthy();
    expect(dependencyIndices(integration!)).toEqual([0, 1]);
  });

  it("filters non-executable constraints from structured prompts and keeps real work items", () => {
    const prompt = [
      "Goals:",
      "- Exercise real parallel fan-out, dependency-safe joins, and clean terminal completion.",
      "- Keep changes minimal and focused.",
      "",
      "Plan requirements:",
      "1) Create 3 root implementation branches that can run in parallel:",
      "   - Backend: add GET /api/health returning { ok: true, version, timestamp }.",
      "   - Runtime: add heartbeat/stall recovery telemetry for orchestrated workers.",
      "   - UI: show lane id, step status, and worker heartbeat age in the Missions detail panel.",
      "2) Add an integration contract verification step that validates interfaces across backend/runtime/ui outputs.",
      "3) Final output: concise summary of files changed, tests run/results, lane fan-out, and dependency order.",
      "",
      "Hard constraints:",
      "- No manual intervention.",
      "- Step titles must be descriptive."
    ].join("\n");

    const plan = buildDeterministicMissionPlan({ prompt, laneId: "lane-main" });
    const titles = plan.steps.map((step) => step.title);

    expect(titles).not.toContain("Keep changes minimal and focused.");
    expect(titles).not.toContain("Exercise real parallel fan-out, dependency-safe joins, and clean terminal completion.");
    expect(titles).not.toContain("Create 3 root implementation branches that can run in parallel:");
    expect(titles).toContain("Backend: add GET /api/health returning { ok: true, version, timestamp }.");
    expect(titles).toContain("Runtime: add heartbeat/stall recovery telemetry for orchestrated workers.");
    expect(titles).toContain("UI: show lane id, step status, and worker heartbeat age in the Missions detail panel.");
  });
});
