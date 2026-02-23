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

describe("missionPlanner slash command translation", () => {
  it("translates /automate into a step with instructions and no startupCommand", () => {
    const prompt = "/automate";
    const plan = buildDeterministicMissionPlan({ prompt });
    const cmdStep = plan.steps.find((step) => step.metadata.slashCommand === "/automate");
    expect(cmdStep).toBeTruthy();
    expect(cmdStep!.metadata.stepType).toBe("command");
    expect(cmdStep!.metadata.instructions).toEqual(expect.stringContaining("Run the /automate skill"));
    expect(cmdStep!.metadata.startupCommand).toBeUndefined();
    expect(cmdStep!.metadata.slashCommand).toBe("/automate");
  });

  it("translates /finalize into a step with instructions and no startupCommand", () => {
    const prompt = "/finalize";
    const plan = buildDeterministicMissionPlan({ prompt });
    const cmdStep = plan.steps.find((step) => step.metadata.slashCommand === "/finalize");
    expect(cmdStep).toBeTruthy();
    expect(cmdStep!.metadata.stepType).toBe("command");
    expect(cmdStep!.metadata.instructions).toEqual(expect.stringContaining("Run the /finalize skill"));
    expect(cmdStep!.metadata.startupCommand).toBeUndefined();
    expect(cmdStep!.metadata.slashCommand).toBe("/finalize");
  });

  it("passes unknown /foobar through with startupCommand (untranslated)", () => {
    const prompt = "/foobar";
    const plan = buildDeterministicMissionPlan({ prompt });
    const cmdStep = plan.steps.find((step) => step.metadata.slashCommand === "/foobar");
    expect(cmdStep).toBeTruthy();
    expect(cmdStep!.metadata.stepType).toBe("command");
    expect(cmdStep!.metadata.startupCommand).toBe("/foobar");
    expect(cmdStep!.metadata.instructions).toBeUndefined();
  });

  it("places slash command steps after preceding implementation steps in the dependency chain", () => {
    const prompt = [
      "- Implement the backend API route.",
      "/automate"
    ].join("\n");
    const plan = buildDeterministicMissionPlan({ prompt });
    const cmdStep = plan.steps.find((step) => step.metadata.slashCommand === "/automate");
    expect(cmdStep).toBeTruthy();
    // The command step should depend on the step immediately before it (the last non-slash step)
    const cmdDeps = dependencyIndices(cmdStep!);
    expect(cmdDeps.length).toBeGreaterThan(0);
    // Its dependency index should be less than its own index (sequenced after prior steps)
    expect(cmdDeps.every((dep) => dep < cmdStep!.index)).toBe(true);
  });

  it("creates multiple command steps when prompt contains multiple slash commands", () => {
    const prompt = [
      "- Implement the backend API route.",
      "/automate",
      "/finalize"
    ].join("\n");
    const plan = buildDeterministicMissionPlan({ prompt });
    const cmdSteps = plan.steps.filter((step) => step.metadata.stepType === "command");
    expect(cmdSteps).toHaveLength(2);
    const slashCmds = cmdSteps.map((step) => step.metadata.slashCommand);
    expect(slashCmds).toContain("/automate");
    expect(slashCmds).toContain("/finalize");
    // Both should have translated instructions, no startupCommand
    for (const step of cmdSteps) {
      expect(step.metadata.instructions).toBeDefined();
      expect(step.metadata.startupCommand).toBeUndefined();
    }
  });
});

describe("missionPlanner role assignment", () => {
  it('assigns role "planning" to analysis steps', () => {
    // Use a long prompt with analysis keywords to trigger the analysis step
    const prompt = "Analyze the codebase structure and investigate the architecture patterns used across the project for a thorough review of the system.";
    const plan = buildDeterministicMissionPlan({ prompt });
    const analysisStep = plan.steps.find((step) => step.kind === "analysis");
    expect(analysisStep).toBeTruthy();
    expect(analysisStep!.metadata.role).toBe("planning");
  });

  it('assigns role "implementation" to implementation steps', () => {
    const prompt = "Implement the backend API route.";
    const plan = buildDeterministicMissionPlan({ prompt });
    const implStep = plan.steps.find((step) => step.kind === "implementation");
    expect(implStep).toBeTruthy();
    expect(implStep!.metadata.role).toBe("implementation");
  });

  it('assigns role "testing" to validation steps', () => {
    const prompt = "Implement the backend API route.";
    const plan = buildDeterministicMissionPlan({ prompt });
    const validationStep = plan.steps.find((step) => step.kind === "validation");
    expect(validationStep).toBeTruthy();
    expect(validationStep!.metadata.role).toBe("testing");
  });

  it('assigns role "integration" to integration steps', () => {
    const prompt = [
      "- Implement the backend API route.",
      "- Implement the frontend UI component."
    ].join("\n");
    const plan = buildDeterministicMissionPlan({ prompt });
    const integrationStep = plan.steps.find((step) => step.kind === "integration");
    expect(integrationStep).toBeTruthy();
    expect(integrationStep!.metadata.role).toBe("integration");
  });

  it('assigns role "merge" to summary steps', () => {
    const prompt = "Implement the backend API route.";
    const plan = buildDeterministicMissionPlan({ prompt });
    const summaryStep = plan.steps.find((step) => step.kind === "summary");
    expect(summaryStep).toBeTruthy();
    expect(summaryStep!.metadata.role).toBe("merge");
  });
});
