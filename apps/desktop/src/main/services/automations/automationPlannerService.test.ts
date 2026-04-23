import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAutomationPlannerService } from "./automationPlannerService";
import type { AutomationRuleDraft } from "../../../shared/types";

function createPlannerForTests(args: {
  suites: Array<{ id: string; name: string }>;
  projectRoot?: string;
  laneWorktrees?: Record<string, string>;
}) {
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  } as any;
  const projectRoot = args.projectRoot ?? "/tmp";

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

  const laneService = {
    getLaneWorktreePath: (laneId: string) => args.laneWorktrees?.[laneId] ?? projectRoot,
  } as any;
  const automationService = { list: () => [], syncFromConfig: () => {} } as any;

  return {
    planner: createAutomationPlannerService({
      logger,
      projectRoot,
      projectConfigService,
      laneService,
      automationService
    }),
    getSnapshot: () => snapshot,
  };
}

function getPlanner(args: {
  suites: Array<{ id: string; name: string }>;
  projectRoot?: string;
  laneWorktrees?: Record<string, string>;
}) {
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

  it("rejects run-command cwd values that resolve through symlinks outside the project root", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-planner-root-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-planner-outside-"));
    const linkPath = path.join(projectRoot, "linked-outside");
    fs.symlinkSync(outsideDir, linkPath);

    try {
      const { planner } = getPlanner({ suites: [], projectRoot });
      const draft = createDraft({
        name: "Escape",
        actions: [{ type: "run-command", command: "echo hello", cwd: "linked-outside" }]
      });

      const result = planner.validateDraft({ draft, confirmations: ["confirm.run-command"] });
      expect(result.ok).toBe(false);
      expect(result.issues.some((issue) => issue.path === "actions[0].cwd")).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects run-command cwd values that escape through symlinks", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-planner-root-"));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-planner-outside-"));
    const linkedPath = path.join(projectRoot, "outside-link");
    fs.symlinkSync(outsideRoot, linkedPath);

    try {
      const { planner } = getPlanner({ suites: [], projectRoot });
      const draft = createDraft({
        name: "Symlink escape",
        actions: [{ type: "run-command", command: "pwd", cwd: "outside-link" }]
      });

      const result = planner.validateDraft({ draft, confirmations: ["confirm.run-command"] });
      expect(result.ok).toBe(false);
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "actions[0].cwd",
            message: expect.stringContaining("project root"),
          }),
        ]),
      );
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("validates run-command cwd against the target lane worktree", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-planner-root-"));
    const laneWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-planner-worktree-"));

    try {
      fs.mkdirSync(path.join(laneWorktree, "nested"), { recursive: true });
      const { planner } = getPlanner({
        suites: [],
        projectRoot,
        laneWorktrees: { "lane-1": laneWorktree },
      });
      const draft = createDraft({
        name: "Lane cwd",
        execution: { kind: "built-in", targetLaneId: "lane-1" } as any,
        actions: [{ type: "run-command", command: "pwd", cwd: "nested" }],
      });

      const result = planner.validateDraft({ draft, confirmations: ["confirm.run-command"] });
      expect(result.ok).toBe(true);
      expect(result.normalized?.actions[0]).toMatchObject({
        type: "run-command",
        cwd: "nested",
      });
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(laneWorktree, { recursive: true, force: true });
    }
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
          modelId: "opencode/openai/gpt-5.4",
          thinkingLevel: "high",
        },
      } as any,
      permissionConfig: {
        providers: {
          opencode: "full-auto",
          allowedTools: ["git", "linear"],
        },
      } as any,
      actions: [{ type: "run-tests", suite: "unit" }],
      legacyActions: [{ type: "run-tests", suite: "unit" }],
    });

    const saved = planner.saveDraft({ draft, confirmations: [] });
    expect(saved.rule.modelConfig?.orchestratorModel.modelId).toBe("opencode/openai/gpt-5.4");
    expect(saved.rule.permissionConfig?.providers?.allowedTools).toEqual(["git", "linear"]);
    expect(saved.rule.actions[0]?.type).toBe("run-tests");
    expect(getSnapshot().local.automations[0]?.actions?.[0]?.type).toBe("run-tests");
  });

  it("accepts canonical GitHub triggers and ade-action steps without rehydrating project context", () => {
    const { planner, getSnapshot } = getPlanner({ suites: [] });
    const draft = createDraft({
      name: "Label issue",
      triggers: [{ type: "github.issue_opened", titleRegex: "^Bug", bodyRegex: "crash", repo: "acme/ade" }],
      trigger: { type: "github.issue_opened", titleRegex: "^Bug", bodyRegex: "crash", repo: "acme/ade" },
      includeProjectContext: false,
      memory: { mode: "none" },
      contextSources: [{ type: "project-memory" }],
      actions: [{ type: "ade-action", adeAction: { domain: "issue", action: "setLabels", args: { labels: ["triage"] } } }],
      legacyActions: [{ type: "ade-action", adeAction: { domain: "issue", action: "setLabels", args: { labels: ["triage"] } } }],
    });

    const saved = planner.saveDraft({ draft, confirmations: [] });

    expect(saved.rule.triggers[0]).toMatchObject({
      type: "github.issue_opened",
      titleRegex: "^Bug",
      bodyRegex: "crash",
      repo: "acme/ade",
    });
    expect(saved.rule.actions[0]).toMatchObject({
      type: "ade-action",
      adeAction: { domain: "issue", action: "setLabels" },
    });
    expect(saved.rule.includeProjectContext).toBe(false);
    expect(getSnapshot().local.automations[0]?.includeProjectContext).toBe(false);
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
