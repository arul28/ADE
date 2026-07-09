import { describe, expect, it } from "vitest";
import { createAutomationPlannerService } from "./automationPlannerService";
import { TEMPLATES } from "../../../renderer/components/automations/templates/templateData";
import type { AutomationRuleDraft } from "../../../shared/types";

// Every shipped template must survive the same validation path the Save
// button uses. A template that fails here would seed a draft the user
// cannot save, or worse, one that saves with an empty action chain.

function createPlanner() {
  const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;
  let automations: unknown[] = [];
  const projectConfigService = {
    get: () => ({
      shared: {},
      local: { automations },
      effective: { automations, testSuites: [{ id: "default", name: "Default suite" }] },
    }),
    updateLocal: (updater: (local: { automations: unknown[] }) => { automations: unknown[] }) => {
      automations = updater({ automations }).automations;
    },
  } as never;
  const laneService = { getLaneWorktreePath: () => "/tmp" } as never;
  const automationService = { list: () => [], syncFromConfig: () => {} };
  return createAutomationPlannerService({
    logger,
    projectRoot: "/tmp",
    projectConfigService,
    laneService,
    automationService,
  });
}

describe("automation templates", () => {
  const planner = createPlanner();

  for (const template of TEMPLATES) {
    it(`template "${template.id}" passes draft validation`, () => {
      const result = planner.validateDraft({ draft: template.draft as AutomationRuleDraft });
      const blocking = result.issues.filter((issue) => issue.severity === "error");
      expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
    });

    it(`template "${template.id}" keeps a runnable execution surface`, () => {
      const draft = template.draft as AutomationRuleDraft;
      if (draft.execution?.kind === "built-in") {
        // A built-in template with an empty chain saves a rule that does nothing.
        expect(draft.actions?.length ?? 0).toBeGreaterThan(0);
        expect(draft.execution.builtIn?.actions?.length ?? 0).toBeGreaterThan(0);
      } else {
        expect(draft.execution?.kind).toBe("agent-session");
        expect((draft.prompt ?? "").length).toBeGreaterThan(0);
      }
    });
  }
});
