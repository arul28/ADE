import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createProjectConfigService, mergeAiConfig } from "./projectConfigService";

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

describe("projectConfigService - lane storage rules", () => {
  it("persists all cleanup fields and migrates the old delete setting to review retention", () => {
    const { root, adeDir } = makeProjectFixture("ade-project-config-lane-storage-");
    fs.writeFileSync(path.join(adeDir, "local.yaml"), YAML.stringify({
      version: 1,
      laneCleanup: {
        maxActiveLanes: 4,
        cleanupIntervalHours: 6,
        autoArchiveAfterHours: 72,
        autoDeleteArchivedAfterHours: 168,
        deleteRemoteBranchOnCleanup: true,
      },
    }));
    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-storage",
      db: makeDb(),
      logger: makeLogger(),
    });

    expect(service.get().effective.laneCleanup).toEqual({
      maxActiveLanes: 4,
      cleanupIntervalHours: 6,
      autoArchiveAfterHours: 72,
      reclaimArchivedAfterHours: 168,
    });

    const snapshot = service.get();
    service.save({
      shared: snapshot.shared,
      local: {
        ...snapshot.local,
        laneCleanup: {
          maxActiveLanes: 3,
          cleanupIntervalHours: 12,
          autoArchiveAfterHours: 48,
          reclaimArchivedAfterHours: 240,
        },
      },
    });
    const written = YAML.parse(fs.readFileSync(path.join(adeDir, "local.yaml"), "utf8"));
    expect(written.laneCleanup).toEqual({
      maxActiveLanes: 3,
      cleanupIntervalHours: 12,
      autoArchiveAfterHours: 48,
      reclaimArchivedAfterHours: 240,
    });
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
        testSuites: [],
        automations: [],
        laneEnvInit: {
          docker: { composePath: "docker-compose.yml", projectPrefix: "shared" },
        },
        laneOverlayPolicies: [],
      },
      local: {
        version: 1,
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
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
        ai: {
          features: {
            commit_messages: true,
          },
          featureModelOverrides: {
            commit_messages: "openai/gpt-5.4-mini",
            terminal_summaries: null,
          },
          featureReasoningOverrides: {
            commit_messages: "minimal",
            terminal_summaries: null,
          },
          chat: {
            autoTitleEnabled: true,
            autoTitleModelId: "openai/gpt-5.4-mini",
            autoTitleReasoningEffort: "minimal",
            autoTitleRefreshOnComplete: false,
            autoAllowAskUser: false,
            scheduledWorkPaused: true,
            piExtensionsEnabled: false,
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
    expect(snapshot.effective.ai?.featureModelOverrides?.terminal_summaries).toBeNull();
    expect(snapshot.effective.ai?.featureReasoningOverrides?.commit_messages).toBe("minimal");
    expect(snapshot.effective.ai?.featureReasoningOverrides?.terminal_summaries).toBeNull();
    expect(snapshot.effective.ai?.sessionIntelligence?.titles?.enabled).toBe(true);
    expect(snapshot.effective.ai?.sessionIntelligence?.titles?.modelId).toBe("openai/gpt-5.4-mini");
    expect(snapshot.effective.ai?.sessionIntelligence?.titles?.reasoningEffort).toBe("minimal");
    expect(snapshot.effective.ai?.sessionIntelligence?.titles?.refreshOnComplete).toBe(false);
    expect(snapshot.effective.ai?.chat?.autoAllowAskUser).toBe(false);
    expect(snapshot.effective.ai?.chat?.scheduledWorkPaused).toBe(true);
    // The opt-out only works if the coercer copies it; a dropped field would
    // silently read back as undefined and leave extensions enabled.
    expect(snapshot.effective.ai?.chat?.piExtensionsEnabled).toBe(false);
    expect(snapshot.effective.ai?.chat?.codexSandbox).toBe("workspace-write");

    service.save({
      shared: snapshot.shared,
      local: snapshot.local,
    });

    const persisted = YAML.parse(fs.readFileSync(localPath, "utf8")) as Record<string, any>;
    expect(persisted.ai?.features?.commit_messages).toBe(true);
    expect(persisted.ai?.featureModelOverrides?.commit_messages).toBe("openai/gpt-5.4-mini");
    expect(persisted.ai?.featureModelOverrides?.terminal_summaries).toBeNull();
    expect(persisted.ai?.featureReasoningOverrides?.commit_messages).toBe("minimal");
    expect(persisted.ai?.featureReasoningOverrides?.terminal_summaries).toBeNull();
    expect(persisted.ai?.chat?.autoTitleEnabled).toBeUndefined();
    expect(persisted.ai?.chat?.autoTitleModelId).toBeUndefined();
    expect(persisted.ai?.chat?.autoTitleReasoningEffort).toBeUndefined();
    expect(persisted.ai?.chat?.autoTitleRefreshOnComplete).toBeUndefined();
    expect(persisted.ai?.sessionIntelligence?.titles?.enabled).toBe(true);
    expect(persisted.ai?.sessionIntelligence?.titles?.modelId).toBe("openai/gpt-5.4-mini");
    expect(persisted.ai?.sessionIntelligence?.titles?.reasoningEffort).toBe("minimal");
    expect(persisted.ai?.sessionIntelligence?.titles?.refreshOnComplete).toBe(false);
    expect(persisted.ai?.chat?.autoAllowAskUser).toBe(false);
    expect(persisted.ai?.chat?.scheduledWorkPaused).toBe(true);
    expect(persisted.ai?.chat?.codexSandbox).toBe("workspace-write");
  });

  it("clears session intelligence reasoning overrides with null", () => {
    const merged = mergeAiConfig({
      sessionIntelligence: {
        titles: { modelId: "openai/gpt-5.4-mini", reasoningEffort: "minimal" },
        summaries: { modelId: "openai/gpt-5.4-mini", reasoningEffort: "low" },
      },
      featureModelOverrides: {
        terminal_summaries: "openai/gpt-5.4-mini",
      },
      featureReasoningOverrides: {
        terminal_summaries: "low",
      },
    }, {
      sessionIntelligence: {
        titles: { modelId: null, reasoningEffort: null },
        summaries: { modelId: null, reasoningEffort: null },
      },
      featureModelOverrides: {
        terminal_summaries: null,
      },
      featureReasoningOverrides: {
        terminal_summaries: null,
      },
    });

    expect(merged?.sessionIntelligence?.titles?.modelId).toBeNull();
    expect(merged?.sessionIntelligence?.summaries?.modelId).toBeNull();
    expect(merged?.featureModelOverrides?.terminal_summaries).toBeNull();
    expect(merged?.sessionIntelligence?.titles?.reasoningEffort).toBeNull();
    expect(merged?.sessionIntelligence?.summaries?.reasoningEffort).toBeNull();
    expect(merged?.featureReasoningOverrides?.terminal_summaries).toBeNull();
  });

  // Regression pin (quality gate): custom providers/slugs must use REPLACE
  // semantics, not union — a union made removals impossible to persist because
  // the settings UI writes the full authoritative list on every save.
  it("replaces custom providers and model slugs on write instead of unioning", () => {
    const shared = {
      customProviders: [
        { id: "acme", name: "Acme", baseURL: "https://acme.example/v1", models: ["m1"] },
        { id: "beta", name: "Beta", baseURL: "https://beta.example/v1", models: ["b1"] },
      ],
      customModelSlugs: ["acme/m1", "beta/b1"],
    };

    const merged = mergeAiConfig(shared, {
      customProviders: [{ id: "acme", name: "Acme", baseURL: "https://acme.example/v1", models: ["m1", "m2"] }],
      customModelSlugs: ["acme/m2"],
    });
    expect(merged?.customProviders).toEqual([
      { id: "acme", name: "Acme", baseURL: "https://acme.example/v1", models: ["m1", "m2"] },
    ]);
    expect(merged?.customModelSlugs).toEqual(["acme/m2"]);

    const kept = mergeAiConfig(shared, { defaultModel: "openai/gpt-5.4" });
    expect(kept?.customProviders).toEqual(shared.customProviders);
    expect(kept?.customModelSlugs).toEqual(shared.customModelSlugs);

    const cleared = mergeAiConfig(shared, { customProviders: [], customModelSlugs: [] });
    expect(cleared?.customProviders).toBeUndefined();
    expect(cleared?.customModelSlugs).toBeUndefined();
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
  it("preserves lane creation and cleanup fields from config", () => {
    const { root, adeDir } = makeProjectFixture("ade-project-config-automation-execution-");

    fs.writeFileSync(
      path.join(adeDir, "ade.yaml"),
      YAML.stringify({
        version: 1,
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
              orchestratorModel: { modelId: "anthropic/claude-sonnet-5", thinkingLevel: "medium" },
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
          {
            id: "lane-cleanup-rule",
            trigger: { type: "lane.merged", namePattern: "Release*" },
            execution: {
              kind: "built-in",
              builtIn: {
                actions: [
                  {
                    type: "delete-lane",
                    targetLaneId: "lane-release",
                    afterMinutes: 15,
                    alwaysRun: true,
                    laneDeleteOptions: {
                      deleteBranch: false,
                      deleteRemoteBranch: true,
                      force: true,
                    },
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
      laneCleanupRule,
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
      modelId: "anthropic/claude-sonnet-5",
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
    expect(laneCleanupRule.trigger).toEqual({ type: "lane.merged", namePattern: "Release*" });
    expect(laneCleanupRule.execution).toMatchObject({
      kind: "built-in",
      builtIn: {
        actions: [{
          type: "delete-lane",
          targetLaneId: "lane-release",
          afterMinutes: 15,
          alwaysRun: true,
          laneDeleteOptions: { deleteBranch: false, deleteRemoteBranch: true, force: true },
        }],
      },
    });
    expect(laneCleanupRule.enabled).toBe(true);
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
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
      },
      local: {
        version: 1,
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
