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

  const projectConfigService = {
    get: () => ({
      effective: {
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
    })
  } as any;

  const laneService = {} as any;
  const automationService = { list: () => [], syncFromConfig: () => {} } as any;

  return createAutomationPlannerService({
    logger,
    projectRoot: "/tmp",
    projectConfigService,
    laneService,
    automationService
  });
}

describe("automationPlannerService.validateDraft", () => {
  it("resolves run-tests suite by fuzzy match", () => {
    const planner = createPlannerForTests({ suites: [{ id: "unit", name: "Unit Tests" }] });

    const draft: AutomationRuleDraft = {
      name: "Run unit tests",
      enabled: true,
      trigger: { type: "manual" },
      actions: [{ type: "run-tests", suite: "Unit Tests" }]
    };

    const res = planner.validateDraft({ draft, confirmations: [] });
    expect(res.ok).toBe(true);
    expect(res.normalized?.actions[0]?.type).toBe("run-tests");
    expect(res.normalized?.actions[0]?.suiteId).toBe("unit");
  });

  it("requires explicit confirmation for run-command", () => {
    const planner = createPlannerForTests({ suites: [] });

    const draft: AutomationRuleDraft = {
      name: "Echo",
      enabled: true,
      trigger: { type: "manual" },
      actions: [{ type: "run-command", command: "echo hello" }]
    };

    const noConfirm = planner.validateDraft({ draft, confirmations: [] });
    expect(noConfirm.ok).toBe(false);
    expect(noConfirm.requiredConfirmations.some((c) => c.key === "confirm.run-command")).toBe(true);

    const withConfirm = planner.validateDraft({ draft, confirmations: ["confirm.run-command"] });
    expect(withConfirm.ok).toBe(true);
  });

  it("blocks sync-to-mirror when enabled, allows when disabled", () => {
    const planner = createPlannerForTests({ suites: [] });

    const enabledDraft: AutomationRuleDraft = {
      name: "Mirror",
      enabled: true,
      trigger: { type: "manual" },
      actions: [{ type: "sync-to-mirror" }]
    };
    expect(planner.validateDraft({ draft: enabledDraft, confirmations: [] }).ok).toBe(false);

    const disabledDraft: AutomationRuleDraft = {
      name: "Mirror",
      enabled: false,
      trigger: { type: "manual" },
      actions: [{ type: "sync-to-mirror" }]
    };
    expect(planner.validateDraft({ draft: disabledDraft, confirmations: [] }).ok).toBe(true);
  });

  it("validates schedule cron", () => {
    const planner = createPlannerForTests({ suites: [] });

    const draft: AutomationRuleDraft = {
      name: "Schedule",
      enabled: true,
      trigger: { type: "schedule", cron: "not-a-cron" },
      actions: [{ type: "update-packs" }]
    };
    const res = planner.validateDraft({ draft, confirmations: [] });
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.path === "trigger.cron")).toBe(true);
  });
});

