import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openKvDb } from "../state/kvDb";
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

function quietLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) break;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeProjectFixture(prefix: string): { root: string; adeDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  const adeDir = path.join(root, ".ade");
  fs.mkdirSync(adeDir, { recursive: true });
  return { root, adeDir };
}

describe("projectConfigService - providers permissions", () => {
  function writeLocalYaml(adeDir: string, providers: Record<string, unknown>) {
    const localPath = path.join(adeDir, "local.yaml");
    fs.writeFileSync(
      localPath,
      YAML.stringify({
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
        ai: {
          permissions: {
            providers,
          },
        },
      }),
      "utf8",
    );
    return localPath;
  }

  it("parses permissions.providers fields into effective config", () => {
    const { root, adeDir } = makeProjectFixture("ade-project-config-providers-");

    writeLocalYaml(adeDir, {
      claude: "edit",
      codex: "plan",
      cursor: "full-auto",
      opencode: "default",
      codexSandbox: "workspace-write",
      writablePaths: ["/tmp/a", "/tmp/b"],
      allowedTools: ["Read", "Write"],
    });

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-1",
      db: makeDb(),
      logger: makeLogger(),
    });

    const providers = service.get().effective.ai?.permissions?.providers;
    expect(providers).toMatchObject({
      claude: "edit",
      codex: "plan",
      cursor: "full-auto",
      opencode: "default",
      codexSandbox: "workspace-write",
      writablePaths: ["/tmp/a", "/tmp/b"],
      allowedTools: ["Read", "Write"],
    });
  });

  it("drops invalid provider modes and keeps valid ones", () => {
    const { root, adeDir } = makeProjectFixture("ade-project-config-providers-invalid-");

    writeLocalYaml(adeDir, {
      claude: "bogus",
      codex: "plan",
    });

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-1",
      db: makeDb(),
      logger: makeLogger(),
    });

    const providers = service.get().effective.ai?.permissions?.providers;
    expect(providers).toBeDefined();
    expect(providers?.codex).toBe("plan");
    expect(providers?.claude).toBeUndefined();
  });

  it("ignores empty writablePaths/allowedTools arrays", () => {
    const { root, adeDir } = makeProjectFixture("ade-project-config-providers-empty-");

    writeLocalYaml(adeDir, {
      codex: "full-auto",
      writablePaths: [],
      allowedTools: [],
    });

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-1",
      db: makeDb(),
      logger: makeLogger(),
    });

    const providers = service.get().effective.ai?.permissions?.providers;
    expect(providers).toBeDefined();
    expect(providers?.codex).toBe("full-auto");
    expect(providers).not.toHaveProperty("writablePaths");
    expect(providers).not.toHaveProperty("allowedTools");
  });
});

describe("projectConfigService - lane env init", () => {
  it("preserves extended overlay fields and merged lane env init in effective config", () => {
    const { root, adeDir } = makeProjectFixture("ade-project-config-lane-init-");

    fs.writeFileSync(path.join(root, "docker-compose.yml"), "services: {}\n", "utf8");

    fs.writeFileSync(
      path.join(adeDir, "ade.yaml"),
      YAML.stringify({
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        automations: [],
        laneEnvInit: {
          envFiles: [{ source: ".env.template", dest: ".env" }],
        },
        laneOverlayPolicies: [
          {
            id: "backend-policy",
            name: "Backend policy",
            enabled: true,
            match: { tags: ["backend"] },
            overrides: {
              portRange: { start: 4100, end: 4199 },
              proxyHostname: "backend.localhost",
              computeBackend: "vps",
              envInit: {
                dependencies: [{ command: ["npm", "install"] }],
              },
            },
          },
        ],
      }),
      "utf8",
    );

    fs.writeFileSync(
      path.join(adeDir, "local.yaml"),
      YAML.stringify({
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        automations: [],
        laneEnvInit: {
          mountPoints: [{ source: "agent-profiles/default.json", dest: ".ade-agent/profile.json" }],
        },
        laneOverlayPolicies: [
          {
            id: "backend-policy",
            overrides: {
              envInit: {
                docker: { composePath: "docker-compose.yml" },
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
      projectId: "project-1",
      db: makeDb(),
      logger: makeLogger(),
    });

    const snapshot = service.get();
    const policy = snapshot.effective.laneOverlayPolicies[0];

    expect(policy?.overrides.portRange).toEqual({ start: 4100, end: 4199 });
    expect(policy?.overrides.proxyHostname).toBe("backend.localhost");
    expect(policy?.overrides.computeBackend).toBe("vps");
    expect(policy?.overrides.envInit).toEqual({
      dependencies: [{ command: ["npm", "install"] }],
      docker: { composePath: "docker-compose.yml" },
    });
    expect(snapshot.effective.laneEnvInit).toEqual({
      envFiles: [{ source: ".env.template", dest: ".env" }],
      mountPoints: [{ source: "agent-profiles/default.json", dest: ".ade-agent/profile.json" }],
    });
  });

  it("flags invalid extended lane env init settings during validation", () => {
    const { root, adeDir } = makeProjectFixture("ade-project-config-lane-init-invalid-");

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-1",
      db: makeDb(),
      logger: makeLogger(),
    });

    const validation = service.validate({
      shared: {
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        automations: [],
        laneEnvInit: {
          docker: { composePath: "missing-compose.yml" },
          dependencies: [{ command: ["npm", "install"], cwd: "missing-dir" }],
        },
        laneOverlayPolicies: [
          {
            id: "invalid-overlay",
            overrides: {
              portRange: { start: 4300, end: 4200 },
            },
          },
        ],
      },
      local: {
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
      },
    });

    expect(validation.ok).toBe(false);
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "effective.laneOverlayPolicies[0].overrides.portRange" }),
        expect.objectContaining({ path: "effective.laneEnvInit.docker.composePath" }),
        expect.objectContaining({ path: "effective.laneEnvInit.dependencies[0].cwd" }),
      ]),
    );
  });

  it("rejects process, suite, and overlay cwd values outside the project root", () => {
    const { root, adeDir } = makeProjectFixture("ade-project-config-cwd-");
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-config-cwd-outside-"));
    tempDirs.push(outsideDir);

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-1",
      db: makeDb(),
      logger: makeLogger(),
    });

    const validation = service.validate({
      shared: {
        version: 1,
        processes: [
          {
            id: "proc-1",
            name: "Proc 1",
            command: ["echo", "ok"],
            cwd: outsideDir,
          },
        ],
        stackButtons: [],
        testSuites: [
          {
            id: "suite-1",
            name: "Suite 1",
            command: ["echo", "ok"],
            cwd: outsideDir,
          },
        ],
        laneOverlayPolicies: [
          {
            id: "overlay-1",
            name: "Overlay 1",
            overrides: {
              cwd: outsideDir,
            },
          },
        ],
        automations: [],
      },
      local: {
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
      },
    });

    expect(validation.ok).toBe(false);
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "effective.processes[0].cwd", message: expect.stringContaining("project root") }),
        expect.objectContaining({ path: "effective.testSuites[0].cwd", message: expect.stringContaining("project root") }),
        expect.objectContaining({ path: "effective.laneOverlayPolicies[0].overrides.cwd", message: expect.stringContaining("project root") }),
      ]),
    );
  });

  it("deep merges nested docker config across shared and local lane env init", () => {
    const { root, adeDir } = makeProjectFixture("ade-project-config-lane-init-docker-merge-");
    fs.writeFileSync(path.join(root, "docker-compose.yml"), "services: {}\n", "utf8");

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-1",
      db: makeDb(),
      logger: makeLogger(),
    });

    service.save({
      shared: {
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        automations: [],
        laneEnvInit: {
          docker: { composePath: "docker-compose.yml", projectPrefix: "shared" },
        },
        laneOverlayPolicies: [],
      },
      local: {
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        automations: [],
        laneEnvInit: {
          docker: { services: ["api"] },
        },
        laneOverlayPolicies: [],
      },
    });

    const effective = service.getEffective();
    expect(effective.laneEnvInit?.docker).toEqual({
      composePath: "docker-compose.yml",
      projectPrefix: "shared",
      services: ["api"],
    });
  });
});

describe("projectConfigService - AI mode migration", () => {
  it("ignores providers.mode and removes it on save", () => {
    const { root, adeDir } = makeProjectFixture("ade-project-config-");

    const localPath = path.join(adeDir, "local.yaml");
    fs.writeFileSync(
      localPath,
      YAML.stringify({
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
        providers: {
          mode: "hosted",
          contextTools: {
            conflictResolvers: {
              claude: { command: ["node", "resolver.js"] },
            },
          },
        },
      }),
      "utf8",
    );

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-1",
      db: makeDb(),
      logger: makeLogger(),
    });

    const snapshot = service.get();
    expect(snapshot.effective.providerMode).toBe("guest");
    expect(snapshot.local.ai?.mode).toBeUndefined();
    expect((snapshot.local.providers as Record<string, unknown> | undefined)?.mode).toBeUndefined();
    expect((snapshot.local.providers as Record<string, unknown> | undefined)?.contextTools).toBeDefined();

    service.save({
      shared: snapshot.shared,
      local: snapshot.local,
    });

    const persisted = YAML.parse(fs.readFileSync(localPath, "utf8")) as Record<string, unknown>;
    const persistedAi = persisted.ai as Record<string, unknown> | undefined;
    const persistedProviders = persisted.providers as Record<string, unknown> | undefined;

    expect(persistedAi).toBeUndefined();
    expect(persistedProviders?.mode).toBeUndefined();
    expect((persistedProviders?.contextTools as Record<string, unknown> | undefined)).toBeDefined();
  });

  it("parses and normalizes ai.orchestrator settings from local config", () => {
    const { root, adeDir } = makeProjectFixture("ade-project-config-orchestrator-");

    const localPath = path.join(adeDir, "local.yaml");
    fs.writeFileSync(
      localPath,
      YAML.stringify({
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
        ai: {
          orchestrator: {
            teammatePlanMode: "required",
            maxParallelWorkers: 9,
            contextPressureThreshold: 0.82,
            progressiveLoading: false,
            hooks: {
              TeammateIdle: {
                command: "echo teammate-idle",
                timeoutMs: 4500,
              },
              TaskCompleted: {
                command: "echo task-completed",
              },
            },
          },
        },
      }),
      "utf8",
    );

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-1",
      db: makeDb(),
      logger: makeLogger(),
    });

    const orchestrator = service.get().effective.ai?.orchestrator;
    expect(orchestrator?.teammatePlanMode).toBe("required");
    expect(orchestrator?.maxParallelWorkers).toBe(9);
    expect(orchestrator?.contextPressureThreshold).toBe(0.82);
    expect(orchestrator?.progressiveLoading).toBe(false);
    expect(orchestrator?.hooks?.TeammateIdle?.command).toBe("echo teammate-idle");
    expect(orchestrator?.hooks?.TeammateIdle?.timeoutMs).toBe(4500);
    expect(orchestrator?.hooks?.TaskCompleted?.command).toBe("echo task-completed");
  });

  it("preserves commit message feature settings and chat settings on read/save", () => {
    const { root, adeDir } = makeProjectFixture("ade-project-config-commit-messages-");

    const localPath = path.join(adeDir, "local.yaml");
    fs.writeFileSync(
      localPath,
      YAML.stringify({
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
        ai: {
          features: {
            commit_messages: true,
          },
          featureModelOverrides: {
            commit_messages: "openai/gpt-5.4-mini",
          },
          chat: {
            autoTitleEnabled: true,
            autoTitleModelId: "openai/gpt-5.4-mini",
            autoTitleRefreshOnComplete: false,
            autoAllowAskUser: false,
            codexSandbox: "workspace-write",
          },
        },
      }),
      "utf8",
    );

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-1",
      db: makeDb(),
      logger: makeLogger(),
    });

    const snapshot = service.get();
    expect(snapshot.effective.ai?.features?.commit_messages).toBe(true);
    expect(snapshot.effective.ai?.featureModelOverrides?.commit_messages).toBe("openai/gpt-5.4-mini");
    expect(snapshot.effective.ai?.sessionIntelligence?.titles?.enabled).toBe(true);
    expect(snapshot.effective.ai?.sessionIntelligence?.titles?.modelId).toBe("openai/gpt-5.4-mini");
    expect(snapshot.effective.ai?.sessionIntelligence?.titles?.refreshOnComplete).toBe(false);
    expect(snapshot.effective.ai?.chat?.autoAllowAskUser).toBe(false);
    expect(snapshot.effective.ai?.chat?.codexSandbox).toBe("workspace-write");

    service.save({
      shared: snapshot.shared,
      local: snapshot.local,
    });

    const persisted = YAML.parse(fs.readFileSync(localPath, "utf8")) as Record<string, any>;
    expect(persisted.ai?.features?.commit_messages).toBe(true);
    expect(persisted.ai?.featureModelOverrides?.commit_messages).toBe("openai/gpt-5.4-mini");
    expect(persisted.ai?.chat?.autoTitleEnabled).toBeUndefined();
    expect(persisted.ai?.chat?.autoTitleModelId).toBeUndefined();
    expect(persisted.ai?.chat?.autoTitleRefreshOnComplete).toBeUndefined();
    expect(persisted.ai?.sessionIntelligence?.titles?.enabled).toBe(true);
    expect(persisted.ai?.sessionIntelligence?.titles?.modelId).toBe("openai/gpt-5.4-mini");
    expect(persisted.ai?.sessionIntelligence?.titles?.refreshOnComplete).toBe(false);
    expect(persisted.ai?.chat?.autoAllowAskUser).toBe(false);
    expect(persisted.ai?.chat?.codexSandbox).toBe("workspace-write");
  });
});

describe("projectConfigService - PR transcript gists", () => {
  it("defaults off and persists the local secret-gist toggle", () => {
    const { root, adeDir } = makeProjectFixture("ade-project-config-pr-transcript-gists-");
    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-1",
      db: makeDb(),
      logger: makeLogger(),
    });

    expect(service.get().effective.github?.prTranscriptGists?.enabled).toBeUndefined();

    const enabled = service.setPrTranscriptGists({ enabled: true });
    expect(enabled.effective.github?.prTranscriptGists?.enabled).toBe(true);

    const localPath = path.join(adeDir, "local.yaml");
    let persisted = YAML.parse(fs.readFileSync(localPath, "utf8")) as Record<string, any>;
    expect(persisted.github?.prTranscriptGists?.enabled).toBe(true);

    const disabled = service.setPrTranscriptGists({ enabled: false });
    expect(disabled.effective.github?.prTranscriptGists?.enabled).toBe(false);
    persisted = YAML.parse(fs.readFileSync(localPath, "utf8")) as Record<string, any>;
    expect(persisted.github?.prTranscriptGists?.enabled).toBe(false);
  });
});

describe("projectConfigService - linear sync", () => {
  async function createLinearFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-config-linear-"));
    tempDirs.push(root);
    const adeDir = path.join(root, ".ade");
    fs.mkdirSync(adeDir, { recursive: true });
    const db = await openKvDb(path.join(adeDir, "ade.db"), quietLogger());
    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-config-linear",
      db,
      logger: quietLogger(),
    });
    return { root, adeDir, db, service };
  }

  it("merges shared/local linear sync config with local precedence", async () => {
    const fixture = await createLinearFixture();
    try {
      fixture.service.save({
        shared: {
          linearSync: {
            enabled: true,
            pollingIntervalSec: 300,
            projects: [{ slug: "acme-platform" }],
            routing: { byLabel: { bug: "backend-dev" } },
            autoDispatch: {
              default: "escalate",
              rules: [{ id: "rule-shared", action: "auto", match: { labels: ["bug"] } }],
            },
          },
        },
        local: {
          linearSync: {
            pollingIntervalSec: 120,
            routing: { byLabel: { feature: "frontend-dev" } },
            autoDispatch: {
              rules: [{ id: "rule-local", action: "escalate", match: { labels: ["night"] } }],
            },
          },
        },
      });

      const effective = fixture.service.getEffective();
      expect(effective.linearSync?.enabled).toBe(true);
      expect(effective.linearSync?.pollingIntervalSec).toBe(120);
      expect(effective.linearSync?.routing?.byLabel).toEqual({
        bug: "backend-dev",
        feature: "frontend-dev",
      });
      expect(effective.linearSync?.autoDispatch?.default).toBe("escalate");
      expect(effective.linearSync?.autoDispatch?.rules).toEqual([
        {
          id: "rule-local",
          action: "escalate",
          match: { labels: ["night"] },
        },
      ]);
    } finally {
      fixture.db.close();
    }
  });

  it("clamps linear sync confidence threshold to valid range", async () => {
    const fixture = await createLinearFixture();
    try {
      fixture.service.save({
        shared: {
          linearSync: {
            enabled: true,
            projects: [{ slug: "acme-platform" }],
            classification: { mode: "hybrid", confidenceThreshold: 1.4 },
          },
        },
        local: {},
      });

      const effective = fixture.service.getEffective();
      expect(effective.linearSync?.classification?.confidenceThreshold).toBe(1);
    } finally {
      fixture.db.close();
    }
  });
});

describe("projectConfigService - project UI", () => {
  it("persists and merges the Linear batch launch default prompt", () => {
    const { root, adeDir } = makeProjectFixture("ade-project-config-ui-");
    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-ui",
      db: makeDb(),
      logger: makeLogger(),
    });

    service.save({
      shared: {
        ui: {
          linearBatchLaunchDefaultPrompt: "Shared prompt",
          webhookGatewayPublicUrl: "https://shared.example.com/ade-webhooks",
        },
      },
      local: {
        ui: {
          linearBatchLaunchDefaultPrompt: "Local prompt",
          webhookGatewayPublicUrl: "https://local.example.com/ade-webhooks",
        },
      },
    });

    const snapshot = service.get();
    expect(snapshot.shared.ui?.linearBatchLaunchDefaultPrompt).toBe("Shared prompt");
    expect(snapshot.shared.ui?.webhookGatewayPublicUrl).toBe("https://shared.example.com/ade-webhooks");
    expect(snapshot.local.ui?.linearBatchLaunchDefaultPrompt).toBe("Local prompt");
    expect(snapshot.local.ui?.webhookGatewayPublicUrl).toBe("https://local.example.com/ade-webhooks");
    expect(snapshot.effective.ui?.linearBatchLaunchDefaultPrompt).toBe("Local prompt");
    expect(snapshot.effective.ui?.webhookGatewayPublicUrl).toBe("https://local.example.com/ade-webhooks");
  });
});

describe("projectConfigService - automation execution", () => {
  it("preserves lane creation fields from config", () => {
    const { root, adeDir } = makeProjectFixture("ade-project-config-automation-execution-");

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
            modelConfig: {
              orchestratorModel: { modelId: "anthropic/claude-sonnet-4-6", thinkingLevel: "medium" },
              profileId: "legacy-profile",
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
              session: { fastMode: true },
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
                    fastMode: true,
                    permissionConfig: { providers: { codex: "full-auto", codexSandbox: "danger-full-access" } },
                  },
                ],
              },
            },
          },
          {
            id: "legacy-launch-mission-rule",
            trigger: { type: "manual" },
            execution: {
              kind: "built-in",
              builtIn: {
                actions: [
                  {
                    type: "launch-mission",
                    sessionTitle: "Launch nightly",
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

    const [
      customRule,
      presetRule,
      requireTriggerLaneRule,
      legacyPromptAtRunRule,
      builtInAgentRule,
      legacyLaunchMissionRule,
    ] = service.get().effective.automations;

    expect(customRule.execution).toMatchObject({
      kind: "agent-session",
      laneMode: "create",
      laneNamePreset: "custom",
      laneNameTemplate: "Auto {{trigger.issue.title}}",
      session: { title: "Run mission" },
    });
    expect(customRule.prompt).toBe("Run mission");
    expect(customRule.modelConfig).toMatchObject({
      modelId: "anthropic/claude-sonnet-4-6",
      thinkingLevel: "medium",
    });
    expect(presetRule.execution).toMatchObject({
      kind: "agent-session",
      laneMode: "reuse",
      laneNamePreset: "issue-title",
      session: { fastMode: true },
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
            fastMode: true,
            permissionConfig: { providers: { codex: "full-auto", codexSandbox: "danger-full-access" } },
          },
        ],
      },
    });
    expect(legacyLaunchMissionRule.execution).toMatchObject({
      kind: "agent-session",
      laneMode: "reuse",
      session: { title: "Launch nightly" },
    });
    expect(legacyLaunchMissionRule.prompt).toBe("Launch nightly");
  });

  it("flags fixed target lanes on require-on-trigger automation execution", () => {
    const { root, adeDir } = makeProjectFixture("ade-project-config-automation-execution-validation-");

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

describe("projectConfigService - process groups", () => {
  it("merges processGroups by id with local overriding shared", () => {
    const { root, adeDir } = makeProjectFixture("ade-project-config-groups-merge-");

    fs.writeFileSync(
      path.join(adeDir, "ade.yaml"),
      YAML.stringify({
        version: 1,
        processes: [],
        processGroups: [
          { id: "backend", name: "Backend" },
          { id: "frontend", name: "Frontend" },
        ],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
      }),
      "utf8",
    );

    fs.writeFileSync(
      path.join(adeDir, "local.yaml"),
      YAML.stringify({
        version: 1,
        processes: [],
        processGroups: [{ id: "frontend", name: "Web" }],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
      }),
      "utf8",
    );

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-groups-merge",
      db: makeDb(),
      logger: makeLogger(),
    });

    const groups = service.get().effective.processGroups;
    const byId = new Map(groups.map((g) => [g.id, g]));
    expect(byId.has("backend")).toBe(true);
    expect(byId.has("frontend")).toBe(true);
    expect(byId.get("backend")!.name).toBe("Backend");
    expect(byId.get("frontend")!.name).toBe("Web");
  });

  it("rolls back config-derived row refreshes when a snapshot write fails", () => {
    const { root, adeDir } = makeProjectFixture("ade-project-config-rollback-");
    fs.writeFileSync(
      path.join(adeDir, "ade.yaml"),
      YAML.stringify({
        version: 1,
        processes: [],
        processGroups: [],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
      }),
      "utf8",
    );
    const db = makeDb();
    db.run.mockImplementation((sql: string) => {
      if (/delete from stack_buttons/i.test(sql)) {
        throw new Error("delete failed");
      }
    });
    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-rollback",
      db,
      logger: makeLogger(),
    });

    expect(() => service.get()).toThrow("delete failed");
    const statements = db.run.mock.calls.map((call: unknown[]) => String(call[0]).trim());
    expect(statements[0]).toBe("BEGIN IMMEDIATE");
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });

  it("falls back to id when an effective processGroup has no name", () => {
    const { root, adeDir } = makeProjectFixture("ade-project-config-groups-fallback-");

    fs.writeFileSync(
      path.join(adeDir, "ade.yaml"),
      YAML.stringify({
        version: 1,
        processes: [],
        processGroups: [{ id: "infra" }],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
      }),
      "utf8",
    );

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-groups-fallback",
      db: makeDb(),
      logger: makeLogger(),
    });

    const groups = service.get().effective.processGroups;
    const infra = groups.find((g) => g.id === "infra");
    expect(infra).toBeTruthy();
    expect(infra!.name).toBe("infra");
  });

  it("round-trips ProcessDefinition.groupIds with local overriding shared", () => {
    const { root, adeDir } = makeProjectFixture("ade-project-config-groupids-override-");

    fs.writeFileSync(
      path.join(adeDir, "ade.yaml"),
      YAML.stringify({
        version: 1,
        processes: [
          {
            id: "api",
            name: "API",
            command: ["npm", "run", "api"],
            groupIds: ["backend"],
          },
        ],
        processGroups: [
          { id: "backend", name: "Backend" },
          { id: "frontend", name: "Frontend" },
        ],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
      }),
      "utf8",
    );

    fs.writeFileSync(
      path.join(adeDir, "local.yaml"),
      YAML.stringify({
        version: 1,
        processes: [{ id: "api", groupIds: ["frontend"] }],
        processGroups: [],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
      }),
      "utf8",
    );

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-groupids-override",
      db: makeDb(),
      logger: makeLogger(),
    });

    const api = service.get().effective.processes.find((p) => p.id === "api");
    expect(api).toBeTruthy();
    expect(api!.groupIds).toEqual(["frontend"]);
  });

  it("preserves shared groupIds when local does not override them", () => {
    const { root, adeDir } = makeProjectFixture("ade-project-config-groupids-preserve-");

    fs.writeFileSync(
      path.join(adeDir, "ade.yaml"),
      YAML.stringify({
        version: 1,
        processes: [
          {
            id: "api",
            name: "API",
            command: ["npm", "run", "api"],
            groupIds: ["backend"],
          },
        ],
        processGroups: [{ id: "backend", name: "Backend" }],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
      }),
      "utf8",
    );

    fs.writeFileSync(
      path.join(adeDir, "local.yaml"),
      YAML.stringify({
        version: 1,
        processes: [{ id: "api", cwd: "./server" }],
        processGroups: [],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
      }),
      "utf8",
    );

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-groupids-preserve",
      db: makeDb(),
      logger: makeLogger(),
    });

    const api = service.get().effective.processes.find((p) => p.id === "api");
    expect(api).toBeTruthy();
    expect(api!.groupIds).toEqual(["backend"]);
  });

  it("returns an empty array when processGroups section is absent", () => {
    const { root, adeDir } = makeProjectFixture("ade-project-config-groups-empty-");

    fs.writeFileSync(
      path.join(adeDir, "local.yaml"),
      YAML.stringify({
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
      }),
      "utf8",
    );

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-groups-empty",
      db: makeDb(),
      logger: makeLogger(),
    });

    const groups = service.get().effective.processGroups;
    expect(Array.isArray(groups)).toBe(true);
    expect(groups.length).toBe(0);
  });

  it("normalizes project-root absolute process and test paths to portable relative paths", () => {
    const { root, adeDir } = makeProjectFixture("ade-project-config-portable-paths-");
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(root, "apps", "desktop"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "dogfood.sh"), "#!/bin/sh\n", "utf8");
    fs.writeFileSync(path.join(root, "scripts", "run-tests.sh"), "#!/bin/sh\n", "utf8");

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-portable-paths",
      db: makeDb(),
      logger: makeLogger(),
    });

    const snapshot = service.save({
      shared: {
        version: 1,
        processes: [
          {
            id: "dogfood",
            name: "Dogfood",
            command: [path.join(root, "scripts", "dogfood.sh"), "code-review"],
            cwd: root,
          },
        ],
        stackButtons: [],
        testSuites: [
          {
            id: "desktop-tests",
            name: "Desktop tests",
            command: [path.join(root, "scripts", "run-tests.sh")],
            cwd: path.join(root, "apps", "desktop"),
          },
        ],
        laneOverlayPolicies: [
          {
            id: "desktop",
            name: "Desktop",
            overrides: { cwd: path.join(root, "apps", "desktop") },
          },
        ],
        automations: [],
      },
      local: {
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
      },
    });

    expect(snapshot.effective.processes[0]?.cwd).toBe(".");
    expect(snapshot.effective.processes[0]?.command[0]).toBe("scripts/dogfood.sh");
    expect(snapshot.effective.testSuites[0]?.cwd).toBe("apps/desktop");
    expect(snapshot.effective.testSuites[0]?.command[0]).toBe("../../scripts/run-tests.sh");
    expect(snapshot.effective.laneOverlayPolicies[0]?.overrides.cwd).toBe("apps/desktop");

    const saved = YAML.parse(fs.readFileSync(path.join(adeDir, "ade.yaml"), "utf8"));
    expect(saved.processes[0].cwd).toBe(".");
    expect(saved.processes[0].command[0]).toBe("scripts/dogfood.sh");
    expect(saved.testSuites[0].cwd).toBe("apps/desktop");
    expect(saved.testSuites[0].command[0]).toBe("../../scripts/run-tests.sh");
    expect(saved.laneOverlayPolicies[0].overrides.cwd).toBe("apps/desktop");
  });

  it("normalizes foreign-platform absolute process paths to portable relative paths", () => {
    const { root, adeDir } = makeProjectFixture("ade-project-config-cross-platform-");

    const projectDirName = path.basename(root);
    const windowsProjectRoot = `C:\\repo\\${projectDirName}`;
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-cross-platform-paths",
      db: makeDb(),
      logger: makeLogger(),
    });

    const snapshot = service.save({
      shared: {
        version: 1,
        processes: [
          {
            id: "dogfood",
            name: "Dogfood",
            command: [`${windowsProjectRoot}\\scripts\\dogfood.sh`, "code-review"],
            cwd: windowsProjectRoot,
          },
        ],
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
        automations: [],
      },
    });

    expect(snapshot.effective.processes[0]?.cwd).toBe(".");
    expect(snapshot.effective.processes[0]?.command[0]).toBe("scripts/dogfood.sh");

    const saved = YAML.parse(fs.readFileSync(path.join(adeDir, "ade.yaml"), "utf8"));
    expect(saved.processes[0].cwd).toBe(".");
    expect(saved.processes[0].command[0]).toBe("scripts/dogfood.sh");
  });
});

describe("projectConfigService - notifications", () => {
  it("deep-merges APNs local overrides with shared notification config", () => {
    const { root, adeDir } = makeProjectFixture("ade-project-config-notifications-");

    fs.writeFileSync(
      path.join(adeDir, "ade.yaml"),
      YAML.stringify({
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
        notifications: {
          apns: {
            enabled: true,
            env: "production",
            keyId: "KEY_SHARED",
            teamId: "TEAM_SHARED",
            bundleId: "com.ade.shared",
            keyStored: true,
          },
        },
      }),
      "utf8",
    );

    fs.writeFileSync(
      path.join(adeDir, "local.yaml"),
      YAML.stringify({
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
        notifications: {
          apns: {
            keyId: "KEY_LOCAL",
          },
        },
      }),
      "utf8",
    );

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-notifications",
      db: makeDb(),
      logger: makeLogger(),
    });

    expect(service.get().effective.notifications?.apns).toEqual({
      enabled: true,
      env: "production",
      keyId: "KEY_LOCAL",
      teamId: "TEAM_SHARED",
      bundleId: "com.ade.shared",
      keyStored: true,
    });
  });
});
