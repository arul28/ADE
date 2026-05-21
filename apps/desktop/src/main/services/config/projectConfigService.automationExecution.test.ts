import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectConfigService } from "./projectConfigService";

function makeDb() {
  const store = new Map<string, unknown>();
  return {
    getJson: vi.fn((key: string) => (store.has(key) ? store.get(key) : null)),
    setJson: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
    }),
    run: vi.fn(),
  } as any;
}

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

describe("projectConfigService automation execution normalization", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) break;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves lane creation fields from config", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-config-automation-execution-"));
    tempDirs.push(root);

    const adeDir = path.join(root, ".ade");
    fs.mkdirSync(adeDir, { recursive: true });

    fs.writeFileSync(
      path.join(adeDir, "ade.yaml"),
      YAML.stringify({
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [
          {
            id: "custom-lane-rule",
            trigger: { type: "manual" },
            execution: {
              kind: "mission",
              laneMode: "create",
              laneNamePreset: "custom",
              laneNameTemplate: "Auto {{trigger.issue.title}}",
              mission: { title: "Run mission" },
            },
          },
          {
            id: "preset-lane-rule",
            trigger: { type: "manual" },
            execution: {
              kind: "agent-session",
              laneMode: "nope",
              laneNamePreset: "issue-title",
              laneNameTemplate: "Should be dropped",
              session: { codexFastMode: true },
            },
          },
          {
            id: "require-trigger-lane-rule",
            trigger: { type: "manual" },
            execution: {
              kind: "agent-session",
              laneMode: "require-on-trigger",
            },
          },
          {
            id: "legacy-prompt-at-run-rule",
            trigger: { type: "manual" },
            execution: {
              kind: "agent-session",
              laneMode: "prompt-at-run",
            },
          },
          {
            id: "built-in-agent-rule",
            trigger: { type: "manual" },
            execution: {
              kind: "built-in",
              builtIn: {
                actions: [
                  {
                    type: "agent-session",
                    prompt: "Summarize",
                    modelConfig: { modelId: "openai/gpt-5.5", thinkingLevel: "high" },
                    codexFastMode: true,
                    permissionConfig: { providers: { codex: "full-auto", codexSandbox: "danger-full-access" } },
                  },
                ],
              },
            },
          },
        ],
      }),
      "utf8",
    );

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-automation-execution",
      db: makeDb(),
      logger: makeLogger(),
    });

    const [customRule, presetRule, requireTriggerLaneRule, legacyPromptAtRunRule, builtInAgentRule] = service.get().effective.automations;

    expect(customRule.execution).toMatchObject({
      kind: "mission",
      laneMode: "create",
      laneNamePreset: "custom",
      laneNameTemplate: "Auto {{trigger.issue.title}}",
      mission: { title: "Run mission" },
    });
    expect(presetRule.execution).toMatchObject({
      kind: "agent-session",
      laneMode: "reuse",
      laneNamePreset: "issue-title",
      session: { codexFastMode: true },
    });
    expect(presetRule.execution?.laneNameTemplate).toBeUndefined();
    expect(requireTriggerLaneRule.execution).toMatchObject({
      kind: "agent-session",
      laneMode: "require-on-trigger",
    });
    expect(legacyPromptAtRunRule.execution).toMatchObject({
      kind: "agent-session",
      laneMode: "require-on-trigger",
    });
    expect(builtInAgentRule.execution).toMatchObject({
      kind: "built-in",
      builtIn: {
        actions: [
          {
            type: "agent-session",
            modelConfig: { modelId: "openai/gpt-5.5", thinkingLevel: "high" },
            codexFastMode: true,
            permissionConfig: { providers: { codex: "full-auto", codexSandbox: "danger-full-access" } },
          },
        ],
      },
    });
  });

  it("flags fixed target lanes on require-on-trigger automation execution", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-config-automation-execution-"));
    tempDirs.push(root);

    const adeDir = path.join(root, ".ade");
    fs.mkdirSync(adeDir, { recursive: true });

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-automation-execution-validation",
      db: makeDb(),
      logger: makeLogger(),
    });

    const validation = service.validate({
      shared: {
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
      },
      local: {
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [
          {
            id: "bad-trigger-lane",
            name: "Bad trigger lane",
            enabled: true,
            mode: "review",
            trigger: { type: "manual" },
            triggers: [{ type: "manual" }],
            execution: {
              kind: "agent-session",
              laneMode: "require-on-trigger",
              targetLaneId: "lane-fixed",
            },
            executor: { mode: "automation-bot" },
            prompt: "Run.",
            reviewProfile: "quick",
            toolPalette: ["repo"],
            contextSources: [],
            guardrails: {},
            outputs: { disposition: "comment-only", createArtifact: true },
            verification: { verifyBeforePublish: false, mode: "intervention" },
            billingCode: "auto:test",
          },
          {
            id: "bad-step-lane",
            name: "Bad step lane",
            enabled: true,
            mode: "review",
            trigger: { type: "manual" },
            triggers: [{ type: "manual" }],
            execution: {
              kind: "built-in",
              laneMode: "require-on-trigger",
              builtIn: {
                actions: [{ type: "run-command", command: "pwd", targetLaneId: "lane-fixed" }],
              },
            },
            executor: { mode: "automation-bot" },
            reviewProfile: "quick",
            toolPalette: ["repo"],
            contextSources: [],
            guardrails: {},
            outputs: { disposition: "comment-only", createArtifact: true },
            verification: { verifyBeforePublish: false, mode: "intervention" },
            billingCode: "auto:test",
          },
        ],
      },
    } as any);

    expect(validation.ok).toBe(false);
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "effective.automations[0].execution.targetLaneId",
        }),
        expect.objectContaining({
          path: "effective.automations[1].execution.builtIn.actions[0].targetLaneId",
        }),
      ]),
    );
  });
});
