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

    const [customRule, presetRule] = service.get().effective.automations;

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
    });
    expect(presetRule.execution?.laneNameTemplate).toBeUndefined();
  });
});
