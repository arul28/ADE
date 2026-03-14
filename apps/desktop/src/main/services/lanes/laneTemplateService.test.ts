import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLaneTemplateService } from "./laneTemplateService";
import type {
  LaneTemplate,
  EffectiveProjectConfig,
  ProjectConfigSnapshot,
  ProjectConfigFile,
} from "../../../shared/types";
import { NO_DEFAULT_LANE_TEMPLATE } from "../../../shared/types";

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

function makeTemplate(overrides: Partial<LaneTemplate> = {}): LaneTemplate {
  return {
    id: "tpl-1",
    name: "Default Template",
    ...overrides,
  };
}

function makeEffective(overrides: Partial<EffectiveProjectConfig> = {}): EffectiveProjectConfig {
  return {
    version: 1,
    processes: [],
    stackButtons: [],
    testSuites: [],
    laneOverlayPolicies: [],
    automations: [],
    git: { autoRebaseOnHeadChange: false },
    ...overrides,
  };
}

function makeSnapshot(overrides: {
  effective?: Partial<EffectiveProjectConfig>;
  shared?: Partial<ProjectConfigFile>;
  local?: Partial<ProjectConfigFile>;
} = {}): ProjectConfigSnapshot {
  return {
    shared: {
      version: 1,
      processes: [],
      stackButtons: [],
      testSuites: [],
      automations: [],
      laneOverlayPolicies: [],
      ...overrides.shared,
    },
    local: {
      version: 1,
      processes: [],
      stackButtons: [],
      testSuites: [],
      automations: [],
      laneOverlayPolicies: [],
      ...overrides.local,
    },
    effective: makeEffective(overrides.effective),
    validation: { ok: true, issues: [] },
    trust: {
      sharedHash: "abc",
      localHash: "def",
      approvedSharedHash: null,
      requiresSharedTrust: false,
    },
    paths: {
      sharedPath: "/tmp/ade.yaml",
      localPath: "/tmp/local.yaml",
    },
  };
}

function makeProjectConfigService(snapshot: ProjectConfigSnapshot) {
  return {
    get: vi.fn(() => snapshot),
    getEffective: vi.fn(() => snapshot.effective),
    save: vi.fn(),
  } as any;
}

describe("laneTemplateService", () => {
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    logger = makeLogger();
  });

  // ---------------------------------------------------------------
  // 1. Template loading tests
  // ---------------------------------------------------------------

  describe("listTemplates", () => {
    it("returns empty array when no templates configured", () => {
      const snapshot = makeSnapshot();
      const configService = makeProjectConfigService(snapshot);

      const service = createLaneTemplateService({
        projectConfigService: configService,

        logger,
      });

      expect(service.listTemplates()).toEqual([]);
    });

    it("returns templates from effective config", () => {
      const templates: LaneTemplate[] = [
        makeTemplate({ id: "tpl-a", name: "Frontend" }),
        makeTemplate({ id: "tpl-b", name: "Backend" }),
      ];
      const snapshot = makeSnapshot({ effective: { laneTemplates: templates } });
      const configService = makeProjectConfigService(snapshot);

      const service = createLaneTemplateService({
        projectConfigService: configService,

        logger,
      });

      const result = service.listTemplates();
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("tpl-a");
      expect(result[1].id).toBe("tpl-b");
    });
  });

  describe("getTemplate", () => {
    it("returns template by id", () => {
      const templates: LaneTemplate[] = [
        makeTemplate({ id: "tpl-a", name: "Frontend" }),
        makeTemplate({ id: "tpl-b", name: "Backend" }),
      ];
      const snapshot = makeSnapshot({ effective: { laneTemplates: templates } });
      const configService = makeProjectConfigService(snapshot);

      const service = createLaneTemplateService({
        projectConfigService: configService,

        logger,
      });

      const result = service.getTemplate("tpl-b");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("tpl-b");
      expect(result!.name).toBe("Backend");
    });

    it("returns null for unknown id", () => {
      const templates: LaneTemplate[] = [
        makeTemplate({ id: "tpl-a", name: "Frontend" }),
      ];
      const snapshot = makeSnapshot({ effective: { laneTemplates: templates } });
      const configService = makeProjectConfigService(snapshot);

      const service = createLaneTemplateService({
        projectConfigService: configService,

        logger,
      });

      expect(service.getTemplate("nonexistent")).toBeNull();
    });
  });

  // ---------------------------------------------------------------
  // 2. Default template selection tests
  // ---------------------------------------------------------------

  describe("getDefaultTemplateId", () => {
    it("returns null when no default set", () => {
      const snapshot = makeSnapshot();
      const configService = makeProjectConfigService(snapshot);

      const service = createLaneTemplateService({
        projectConfigService: configService,

        logger,
      });

      expect(service.getDefaultTemplateId()).toBeNull();
    });

    it("returns configured default", () => {
      const snapshot = makeSnapshot({
        effective: {
          laneTemplates: [makeTemplate({ id: "tpl-default" })],
          defaultLaneTemplate: "tpl-default"
        },
      });
      const configService = makeProjectConfigService(snapshot);

      const service = createLaneTemplateService({
        projectConfigService: configService,

        logger,
      });

      expect(service.getDefaultTemplateId()).toBe("tpl-default");
    });

    it("returns null when the configured default no longer exists", () => {
      const snapshot = makeSnapshot({
        effective: { defaultLaneTemplate: "tpl-missing", laneTemplates: [makeTemplate({ id: "tpl-live" })] },
      });
      const configService = makeProjectConfigService(snapshot);

      const service = createLaneTemplateService({
        projectConfigService: configService,

        logger,
      });

      expect(service.getDefaultTemplateId()).toBeNull();
    });
  });

  describe("setDefaultTemplateId", () => {
    it("updates local config", () => {
      const snapshot = makeSnapshot({
        effective: { laneTemplates: [makeTemplate({ id: "tpl-new", name: "New Default" })] },
      });
      const configService = makeProjectConfigService(snapshot);

      const service = createLaneTemplateService({
        projectConfigService: configService,

        logger,
      });

      service.setDefaultTemplateId("tpl-new");

      expect(configService.save).toHaveBeenCalledTimes(1);
      const savedArg = configService.save.mock.calls[0][0];
      expect(savedArg.local.defaultLaneTemplate).toBe("tpl-new");
      expect(logger.info).toHaveBeenCalledWith("lane_template.default_set", { templateId: "tpl-new" });
    });

    it("with null clears default", () => {
      const snapshot = makeSnapshot({
        local: { defaultLaneTemplate: "tpl-old" },
      });
      const configService = makeProjectConfigService(snapshot);

      const service = createLaneTemplateService({
        projectConfigService: configService,

        logger,
      });

      service.setDefaultTemplateId(null);

      expect(configService.save).toHaveBeenCalledTimes(1);
      const savedArg = configService.save.mock.calls[0][0];
      expect(savedArg.local.defaultLaneTemplate).toBeUndefined();
      expect(logger.info).toHaveBeenCalledWith("lane_template.default_set", { templateId: null });
    });

    it("stores an explicit no-default sentinel when overriding a shared default", () => {
      const snapshot = makeSnapshot({
        shared: { defaultLaneTemplate: "tpl-shared" },
        effective: {
          laneTemplates: [makeTemplate({ id: "tpl-shared" })],
          defaultLaneTemplate: "tpl-shared"
        },
      });
      const configService = makeProjectConfigService(snapshot);

      const service = createLaneTemplateService({
        projectConfigService: configService,

        logger,
      });

      service.setDefaultTemplateId(null);

      const savedArg = configService.save.mock.calls[0][0];
      expect(savedArg.local.defaultLaneTemplate).toBe(NO_DEFAULT_LANE_TEMPLATE);
    });

    it("rejects unknown defaults before saving", () => {
      const snapshot = makeSnapshot({
        effective: { laneTemplates: [makeTemplate({ id: "tpl-live" })] },
      });
      const configService = makeProjectConfigService(snapshot);

      const service = createLaneTemplateService({
        projectConfigService: configService,

        logger,
      });

      expect(() => service.setDefaultTemplateId("tpl-missing")).toThrow("Unknown lane template: tpl-missing");
      expect(configService.save).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // 3. Template application tests (resolveTemplateAsEnvInit)
  // ---------------------------------------------------------------

  describe("resolveTemplateAsEnvInit", () => {
    it("converts template to env init config", () => {
      const snapshot = makeSnapshot();
      const configService = makeProjectConfigService(snapshot);

      const service = createLaneTemplateService({
        projectConfigService: configService,

        logger,
      });

      const template = makeTemplate({
        id: "tpl-basic",
        name: "Basic",
        envFiles: [{ source: ".env.template", dest: ".env" }],
        dependencies: [{ command: ["npm", "install"] }],
      });

      const result = service.resolveTemplateAsEnvInit(template);
      expect(result.envFiles).toEqual([{ source: ".env.template", dest: ".env" }]);
      expect(result.dependencies).toEqual([{ command: ["npm", "install"] }]);
      expect(result.docker).toBeUndefined();
      expect(result.mountPoints).toBeUndefined();
    });

    it("with all fields populated", () => {
      const snapshot = makeSnapshot();
      const configService = makeProjectConfigService(snapshot);

      const service = createLaneTemplateService({
        projectConfigService: configService,

        logger,
      });

      const template = makeTemplate({
        id: "tpl-full",
        name: "Full Stack",
        description: "Full stack template with all fields",
        envFiles: [
          { source: ".env.template", dest: ".env", vars: { DB_URL: "postgres://localhost/dev" } },
          { source: ".env.backend", dest: ".env.local" },
        ],
        docker: {
          composePath: "docker-compose.yml",
          services: ["api", "db"],
          projectPrefix: "ade",
        },
        dependencies: [
          { command: ["npm", "install"] },
          { command: ["pip", "install", "-r", "requirements.txt"], cwd: "backend" },
        ],
        mountPoints: [
          { source: "agent-profiles/default.json", dest: ".ade-agent/profile.json" },
        ],
        portRange: { start: 4000, end: 4099 },
        envVars: { NODE_ENV: "development", DEBUG: "true" },
      });

      const result = service.resolveTemplateAsEnvInit(template);

      expect(result.envFiles).toHaveLength(2);
      expect(result.envFiles![0].source).toBe(".env.template");
      expect(result.envFiles![1].source).toBe(".env.backend");

      expect(result.docker).toEqual({
        composePath: "docker-compose.yml",
        services: ["api", "db"],
        projectPrefix: "ade",
      });

      expect(result.dependencies).toHaveLength(2);
      expect(result.dependencies![0].command).toEqual(["npm", "install"]);
      expect(result.dependencies![1].cwd).toBe("backend");

      expect(result.mountPoints).toHaveLength(1);
      expect(result.mountPoints![0].dest).toBe(".ade-agent/profile.json");
    });

    it("with minimal template", () => {
      const snapshot = makeSnapshot();
      const configService = makeProjectConfigService(snapshot);

      const service = createLaneTemplateService({
        projectConfigService: configService,

        logger,
      });

      const template = makeTemplate({
        id: "tpl-minimal",
        name: "Minimal",
      });

      const result = service.resolveTemplateAsEnvInit(template);

      expect(result.envFiles).toBeUndefined();
      expect(result.docker).toBeUndefined();
      expect(result.dependencies).toBeUndefined();
      expect(result.mountPoints).toBeUndefined();
    });

    it("preserves env file vars", () => {
      const snapshot = makeSnapshot();
      const configService = makeProjectConfigService(snapshot);

      const service = createLaneTemplateService({
        projectConfigService: configService,

        logger,
      });

      const template = makeTemplate({
        id: "tpl-vars",
        name: "With Vars",
        envFiles: [
          {
            source: ".env.template",
            dest: ".env",
            vars: {
              DB_URL: "postgres://localhost/lane",
              API_KEY: "dev-key-123",
              HOSTNAME: "{{HOSTNAME}}",
            },
          },
        ],
      });

      const result = service.resolveTemplateAsEnvInit(template);

      expect(result.envFiles).toHaveLength(1);
      expect(result.envFiles![0].vars).toEqual({
        DB_URL: "postgres://localhost/lane",
        API_KEY: "dev-key-123",
        HOSTNAME: "{{HOSTNAME}}",
      });
    });
  });
});
