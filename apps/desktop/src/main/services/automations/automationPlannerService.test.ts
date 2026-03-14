import { describe, expect, it } from "vitest";
import { createAutomationPlannerService } from "./automationPlannerService";
import type { AutomationRuleDraft } from "../../../shared/types";

function createPlannerForTests(args: { suites: Array<{ id: string; name: string }> }) {
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  } as any;

  let snapshot = {
    shared: {},
    local: { automations: [] as any[] },
    effective: {
      automations: [] as any[],
      testSuites: args.suites.map((s) => ({
        id: s.id,
        name: s.name,
        command: ["echo", "ok"],
        cwd: ".",
        env: {},
        timeoutMs: null,
        tags: []
      }))
    }
  };

  const projectConfigService = {
    get: () => snapshot,
    save: (next: any) => {
      snapshot = {
        ...snapshot,
        ...next,
        effective: {
          ...snapshot.effective,
          automations: next.local?.automations ?? snapshot.local.automations,
          testSuites: snapshot.effective.testSuites,
        },
      };
    },
  } as any;

  const laneService = {} as any;
  const automationService = { list: () => [], syncFromConfig: () => {} } as any;

  return {
    planner: createAutomationPlannerService({
      logger,
      projectRoot: "/tmp",
      projectConfigService,
      laneService,
      automationService
    }),
    getSnapshot: () => snapshot,
  };
}

function getPlanner(args: { suites: Array<{ id: string; name: string }> }) {
  const harness = createPlannerForTests(args);
  return harness;
}

describe("automationPlannerService.validateDraft", () => {
  it("resolves run-tests suite by fuzzy match", () => {
    const { planner } = getPlanner({ suites: [{ id: "unit", name: "Unit Tests" }] });

    const draft = createDraft({
      name: "Run unit tests",
      actions: [{ type: "run-tests", suite: "Unit Tests" }]
    });

    const res = planner.validateDraft({ draft, confirmations: [] });
    expect(res.ok).toBe(true);
    expect(res.normalized?.actions[0]?.type).toBe("run-tests");
    expect(res.normalized?.actions[0]?.suiteId).toBe("unit");
  });

  it("requires explicit confirmation for run-command", () => {
    const { planner } = getPlanner({ suites: [] });

    const draft = createDraft({
      name: "Echo",
      actions: [{ type: "run-command", command: "echo hello" }]
    });

    const noConfirm = planner.validateDraft({ draft, confirmations: [] });
    expect(noConfirm.ok).toBe(false);
    expect(noConfirm.requiredConfirmations.some((c) => c.key === "confirm.run-command")).toBe(true);

    const withConfirm = planner.validateDraft({ draft, confirmations: ["confirm.run-command"] });
    expect(withConfirm.ok).toBe(true);
  });

  it("validates schedule cron", () => {
    const { planner } = getPlanner({ suites: [] });

    const draft = createDraft({
      name: "Schedule",
      triggers: [{ type: "schedule", cron: "not-a-cron" }],
      trigger: { type: "schedule", cron: "not-a-cron" },
      actions: [{ type: "predict-conflicts" }]
    });
    const res = planner.validateDraft({ draft, confirmations: [] });
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.path === "triggers[0].cron")).toBe(true);
  });

  it("persists model, permissions, and legacy actions on save", () => {
    const { planner, getSnapshot } = getPlanner({ suites: [{ id: "unit", name: "Unit Tests" }] });

    const draft = createDraft({
      name: "Persistent rule",
      triggers: [{ type: "git.pr_opened", branch: "feat/*" }],
      trigger: { type: "git.pr_opened", branch: "feat/*" },
      modelConfig: {
        orchestratorModel: {
          modelId: "openai/gpt-5.4",
          thinkingLevel: "high",
        },
      } as any,
      permissionConfig: {
        providers: {
          unified: "full-auto",
          allowedTools: ["git", "linear"],
        },
      } as any,
      actions: [{ type: "run-tests", suite: "unit" }],
      legacyActions: [{ type: "run-tests", suite: "unit" }],
    });

    const saved = planner.saveDraft({ draft, confirmations: [] });
    expect(saved.rule.modelConfig?.orchestratorModel.modelId).toBe("openai/gpt-5.4");
    expect(saved.rule.permissionConfig?.providers?.allowedTools).toEqual(["git", "linear"]);
    expect(saved.rule.actions[0]?.type).toBe("run-tests");
    expect(getSnapshot().local.automations[0]?.actions?.[0]?.type).toBe("run-tests");
  });
});
 
function createDraft(
  overrides: Partial<AutomationRuleDraft>,
): AutomationRuleDraft {
  const trigger = overrides.trigger ?? overrides.triggers?.[0] ?? { type: "manual" };
  return {
    name: "Automation Rule",
    enabled: true,
    mode: "review",
    triggers: [trigger],
    trigger,
    executor: { mode: "automation-bot", targetId: null },
    reviewProfile: "quick",
    toolPalette: [],
    contextSources: [],
    memory: { mode: "project" },
    guardrails: {},
    outputs: { disposition: "comment-only", createArtifact: true },
    verification: { verifyBeforePublish: false, mode: "intervention" },
    billingCode: "auto:test",
    actions: [],
    ...overrides
  };
}
