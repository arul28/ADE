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
  automationService?: {
    list: () => { id: string }[];
    syncFromConfig: () => void;
    assertWebhookGatewayReadyForRule?: (rule: any) => void;
  };
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
  const automationService = args.automationService ?? { list: () => [], syncFromConfig: () => {} };

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
  automationService?: {
    list: () => { id: string }[];
    syncFromConfig: () => void;
    assertWebhookGatewayReadyForRule?: (rule: any) => void;
  };
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
          modelId: "opencode/openai/gpt-5.4",
          thinkingLevel: "high",
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
    expect(saved.rule.modelConfig?.modelId).toBe("opencode/openai/gpt-5.4");
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
      contextSources: [],
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

  it("checks the webhook gateway before saving enabled external event automations", () => {
    const calls: any[] = [];
    const { planner } = getPlanner({
      suites: [],
      automationService: {
        list: () => [],
        syncFromConfig: () => {},
        assertWebhookGatewayReadyForRule: (rule: any) => {
          calls.push(rule);
          throw new Error("Gateway missing");
        },
      },
    } as any);
    const draft = createDraft({
      name: "Linear label",
      triggers: [{ type: "linear.issue_labeled" }],
      trigger: { type: "linear.issue_labeled" },
      prompt: "Run a smoke triage.",
    });

    expect(() => planner.saveDraft({ draft, confirmations: [] })).toThrow(/Gateway missing/);
    expect(calls[0]?.name).toBe("Linear label");
  });

  it("normalizes issue-to-lane pipelines with per-step agent settings", () => {
    const { planner } = getPlanner({ suites: [] });
    const draft = createDraft({
      name: "Issue pipeline",
      triggers: [{ type: "github.issue_opened", repo: "arul28/ADE" }],
      trigger: { type: "github.issue_opened", repo: "arul28/ADE" },
      execution: { kind: "built-in" } as any,
      actions: [
        {
          type: "create-lane",
          laneNameTemplate: "{{trigger.issue.title}}",
          laneDescriptionTemplate: "{{trigger.issue.url}}",
        },
        {
          type: "agent-session",
          prompt: "Fix {{trigger.issue.title}}",
          sessionTitle: "Fix issue",
          modelConfig: { modelId: "opencode/openai/gpt-5.4", thinkingLevel: "high" },
          permissionConfig: { providers: { opencode: "full-auto" } },
        },
      ],
      legacyActions: [
        {
          type: "create-lane",
          laneNameTemplate: "{{trigger.issue.title}}",
          laneDescriptionTemplate: "{{trigger.issue.url}}",
        },
        {
          type: "agent-session",
          prompt: "Fix {{trigger.issue.title}}",
          sessionTitle: "Fix issue",
          modelConfig: { modelId: "opencode/openai/gpt-5.4", thinkingLevel: "high" },
          permissionConfig: { providers: { opencode: "full-auto" } },
        },
      ],
    } as any);

    const res = planner.validateDraft({ draft, confirmations: [] });
    expect(res.ok).toBe(true);
    expect(res.normalized?.actions[0]).toMatchObject({
      type: "create-lane",
      laneNameTemplate: "{{trigger.issue.title}}",
    });
    expect(res.normalized?.actions[1]).toMatchObject({
      type: "agent-session",
      modelConfig: { modelId: "opencode/openai/gpt-5.4", thinkingLevel: "high" },
      permissionConfig: { providers: { opencode: "full-auto" } },
    });
  });

  it("falls back to a boolean codexFastMode when an agent-session fastMode is non-boolean", () => {
    const { planner } = getPlanner({ suites: [] });
    const draft = createDraft({
      name: "Legacy fast mode action",
      triggers: [{ type: "github.issue_opened" }],
      trigger: { type: "github.issue_opened" },
      execution: { kind: "built-in" } as any,
      actions: [
        {
          type: "agent-session",
          prompt: "Investigate.",
          // A malformed/legacy payload: fastMode is not a boolean, but the
          // deprecated codexFastMode carries the real flag.
          fastMode: "yes",
          codexFastMode: true,
        } as any,
      ],
      legacyActions: [
        {
          type: "agent-session",
          prompt: "Investigate.",
          fastMode: "yes",
          codexFastMode: true,
        } as any,
      ],
    } as any);

    const res = planner.validateDraft({ draft, confirmations: [] });
    expect(res.ok).toBe(true);
    expect((res.normalized?.actions[0] as any).fastMode).toBe(true);
  });

  it("defaults the create-lane name template to trigger.issue.title when blank", () => {
    const { planner } = getPlanner({ suites: [] });
    const draft = createDraft({
      name: "Default lane name",
      triggers: [{ type: "github.issue_opened" }],
      trigger: { type: "github.issue_opened" },
      execution: { kind: "built-in" } as any,
      actions: [{ type: "create-lane", laneNameTemplate: "   " } as any],
      legacyActions: [{ type: "create-lane", laneNameTemplate: "   " } as any],
    });

    const res = planner.validateDraft({ draft, confirmations: [] });
    expect(res.ok).toBe(true);
    expect(res.normalized?.actions[0]).toMatchObject({
      type: "create-lane",
      laneNameTemplate: "{{trigger.issue.title}}",
    });
    expect((res.normalized?.actions[0] as any).laneDescriptionTemplate).toBeUndefined();
    expect((res.normalized?.actions[0] as any).parentLaneId).toBeUndefined();
  });

  it("preserves per-action targetLaneId on every action via the base spread", () => {
    const { planner } = getPlanner({ suites: [{ id: "unit", name: "Unit Tests" }] });
    const draft = createDraft({
      name: "Per-action lanes",
      execution: { kind: "built-in" } as any,
      actions: [
        {
          type: "ade-action",
          targetLaneId: "lane-ade",
          adeAction: { domain: "issue", action: "setLabels", args: { labels: ["x"] } },
        } as any,
        { type: "run-tests", suite: "unit", targetLaneId: "lane-tests" } as any,
        { type: "predict-conflicts", targetLaneId: "lane-conflict" } as any,
      ],
      legacyActions: [
        {
          type: "ade-action",
          targetLaneId: "lane-ade",
          adeAction: { domain: "issue", action: "setLabels", args: { labels: ["x"] } },
        } as any,
        { type: "run-tests", suite: "unit", targetLaneId: "lane-tests" } as any,
        { type: "predict-conflicts", targetLaneId: "lane-conflict" } as any,
      ],
    });

    const res = planner.validateDraft({ draft, confirmations: [] });
    expect(res.ok).toBe(true);
    expect((res.normalized?.actions[0] as any).targetLaneId).toBe("lane-ade");
    expect((res.normalized?.actions[1] as any).targetLaneId).toBe("lane-tests");
    expect((res.normalized?.actions[2] as any).targetLaneId).toBe("lane-conflict");
  });

  it("preserves require-on-trigger lane mode without requiring a target lane", () => {
    const { planner } = getPlanner({ suites: [] });
    const draft = createDraft({
      name: "Require trigger lane",
      execution: { kind: "agent-session", laneMode: "require-on-trigger" } as any,
      prompt: "Use the lane supplied by the caller.",
    });

    const res = planner.validateDraft({ draft, confirmations: [] });
    expect(res.ok).toBe(true);
    expect(res.normalized?.execution).toMatchObject({
      kind: "agent-session",
      laneMode: "require-on-trigger",
    });
  });

  it("normalizes legacy prompt-at-run lane mode to require-on-trigger", () => {
    const { planner } = getPlanner({ suites: [] });
    const draft = createDraft({
      name: "Legacy prompt at run",
      execution: { kind: "agent-session", laneMode: "prompt-at-run" } as any,
      prompt: "Use the selected lane.",
    });

    const res = planner.validateDraft({ draft, confirmations: [] });
    expect(res.ok).toBe(true);
    expect(res.normalized?.execution).toMatchObject({
      kind: "agent-session",
      laneMode: "require-on-trigger",
    });
  });

  it("rejects targetLaneId when lane mode requires the trigger lane", () => {
    const { planner } = getPlanner({ suites: [] });
    const draft = createDraft({
      name: "Conflicting trigger lane",
      execution: {
        kind: "agent-session",
        laneMode: "require-on-trigger",
        targetLaneId: "lane-fixed",
      } as any,
      prompt: "This should choose at trigger time.",
    });

    const res = planner.validateDraft({ draft, confirmations: [] });
    expect(res.ok).toBe(false);
    expect(res.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          path: "execution.targetLaneId",
        }),
      ]),
    );
  });

  it("rejects per-action targetLaneId when lane mode requires the trigger lane", () => {
    const { planner } = getPlanner({ suites: [] });
    const draft = createDraft({
      name: "Conflicting step lane",
      execution: {
        kind: "built-in",
        laneMode: "require-on-trigger",
      } as any,
      actions: [{ type: "run-command", command: "pwd", targetLaneId: "lane-fixed" } as any],
      legacyActions: [{ type: "run-command", command: "pwd", targetLaneId: "lane-fixed" } as any],
    });

    const res = planner.validateDraft({ draft, confirmations: ["confirm.run-command"] });
    expect(res.ok).toBe(false);
    expect(res.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          path: "actions[0].targetLaneId",
        }),
      ]),
    );
  });

  it("validates run-command cwd against the per-action targetLaneId before draft execution lane", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-planner-action-lane-"));
    const actionLane = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-planner-action-lane-target-"));
    const draftLane = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-planner-draft-lane-"));

    try {
      fs.mkdirSync(path.join(actionLane, "scripts"), { recursive: true });
      const { planner } = getPlanner({
        suites: [],
        projectRoot,
        laneWorktrees: { "lane-action": actionLane, "lane-draft": draftLane },
      });

      const draft = createDraft({
        name: "Per-action lane cwd",
        execution: { kind: "built-in", targetLaneId: "lane-draft" } as any,
        actions: [{ type: "run-command", command: "ls", cwd: "scripts", targetLaneId: "lane-action" } as any],
        legacyActions: [{ type: "run-command", command: "ls", cwd: "scripts", targetLaneId: "lane-action" } as any],
      });

      const res = planner.validateDraft({ draft, confirmations: ["confirm.run-command"] });
      expect(res.ok).toBe(true);
      expect(res.normalized?.actions[0]).toMatchObject({
        type: "run-command",
        cwd: "scripts",
        targetLaneId: "lane-action",
      });
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(actionLane, { recursive: true, force: true });
      fs.rmSync(draftLane, { recursive: true, force: true });
    }
  });

  it("preserves output disposition and verification settings", () => {
    const { planner } = getPlanner({ suites: [] });
    const draft = createDraft({
      name: "Publish settings",
      execution: { kind: "agent-session" } as any,
      prompt: "Prepare a draft PR.",
      outputs: {
        disposition: "open-pr-draft",
        createArtifact: false,
        notificationChannel: "automation-alerts",
      },
      verification: {
        verifyBeforePublish: true,
        mode: "dry-run",
      },
    });

    const res = planner.validateDraft({ draft, confirmations: [] });
    expect(res.ok).toBe(true);
    expect(res.normalized?.outputs).toMatchObject({
      disposition: "open-pr-draft",
      createArtifact: false,
      notificationChannel: "automation-alerts",
    });
    expect(res.normalized?.verification).toMatchObject({
      verifyBeforePublish: true,
      mode: "dry-run",
    });
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
    guardrails: {},
    outputs: { disposition: "comment-only", createArtifact: true },
    verification: { verifyBeforePublish: false, mode: "intervention" },
    billingCode: "auto:test",
    actions: [],
    ...overrides
  };
}
