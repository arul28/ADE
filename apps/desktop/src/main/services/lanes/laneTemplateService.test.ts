import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLaneTemplateService } from "./laneTemplateService";
import { createProjectNewLaneSettings } from "./newLaneSettingsStore";
import { resolveSetupScriptConfig, unsupportedWindowsScriptPathError } from "./setupScriptConfig";
import type {
  LaneTemplate,
  EffectiveProjectConfig,
  ProjectConfigSnapshot,
  ProjectConfigFile,
} from "../../../shared/types";
import { defaultEffectiveGitConfig } from "../../../shared/types/config";

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
    testSuites: [],
    laneOverlayPolicies: [],
    automations: [],
    git: defaultEffectiveGitConfig(),
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
      testSuites: [],
      automations: [],
      laneOverlayPolicies: [],
      ...overrides.shared,
    },
    local: {
      version: 1,
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

function makeNewLaneSettings(configService: ReturnType<typeof makeProjectConfigService>) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-templates-"));
  return createProjectNewLaneSettings({
    projectRoot,
    adeDir: path.join(projectRoot, ".ade"),
    projectConfigService: configService,
    logger: makeLogger(),
  });
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
        newLaneSettings: makeNewLaneSettings(configService),
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
        newLaneSettings: makeNewLaneSettings(configService),
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
        newLaneSettings: makeNewLaneSettings(configService),
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
        newLaneSettings: makeNewLaneSettings(configService),
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
        newLaneSettings: makeNewLaneSettings(configService),
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
        newLaneSettings: makeNewLaneSettings(configService),
        logger,
      });

      expect(service.getDefaultTemplateId()).toBe("tpl-default");
    });

    it("returns null for a missing configured template", () => {
      const snapshot = makeSnapshot({
        effective: { defaultLaneTemplate: "tpl-missing", laneTemplates: [makeTemplate({ id: "tpl-live" })] },
      });
      const configService = makeProjectConfigService(snapshot);

      const service = createLaneTemplateService({
        projectConfigService: configService,
        newLaneSettings: makeNewLaneSettings(configService),
        logger,
      });

      expect(service.getDefaultTemplateId()).toBeNull();
    });
  });

  describe("setDefaultTemplateId", () => {
    it("rejects unknown defaults before saving", () => {
      const snapshot = makeSnapshot({
        effective: { laneTemplates: [makeTemplate({ id: "tpl-live" })] },
      });
      const configService = makeProjectConfigService(snapshot);

      const service = createLaneTemplateService({
        projectConfigService: configService,
        newLaneSettings: makeNewLaneSettings(configService),
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
        newLaneSettings: makeNewLaneSettings(configService),
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
      expect(result.setupScript).toBeUndefined();
    });

    it("carries the setup script into env init so it actually runs", () => {
      const snapshot = makeSnapshot();
      const configService = makeProjectConfigService(snapshot);
      const service = createLaneTemplateService({
        projectConfigService: configService,
        newLaneSettings: makeNewLaneSettings(configService),
        logger,
      });

      const template = makeTemplate({
        id: "tpl-setup",
        name: "With setup script",
        setupScript: { commands: ["npm run bootstrap"], injectPrimaryPath: true },
      });

      const result = service.resolveTemplateAsEnvInit(template);
      expect(result.setupScript).toEqual({
        commands: ["npm run bootstrap"],
        injectPrimaryPath: true,
      });
    });

    it("with all fields populated", () => {
      const snapshot = makeSnapshot();
      const configService = makeProjectConfigService(snapshot);

      const service = createLaneTemplateService({
        projectConfigService: configService,
        newLaneSettings: makeNewLaneSettings(configService),
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
        newLaneSettings: makeNewLaneSettings(configService),
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
        newLaneSettings: makeNewLaneSettings(configService),
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

  // ---------------------------------------------------------------
  // 4. Setup script resolution tests
  // ---------------------------------------------------------------

  describe("resolveSetupScriptConfig", () => {
    // The most specific list wins: this OS's own, then macOS/Linux, then any OS.
    // An ADE Cloud computer is Linux: shared macOS/Linux commands that call a
    // macOS-only tool still run there, and say how to fix the template.
    const all = {
      commands: ["generic-cmd"],
      unixCommands: ["bash unix.sh"],
      macosCommands: ["bash mac.sh"],
      linuxCommands: ["bash linux.sh"],
      windowsCommands: ["powershell win.ps1"],
      scriptPath: "setup.sh",
      unixScriptPath: "scripts/unix.sh",
      macosScriptPath: "scripts/mac.sh",
      linuxScriptPath: "scripts/linux.sh",
      windowsScriptPath: "scripts/win.ps1",
    };
    it.each<[string, LaneTemplate["setupScript"], NodeJS.Platform, ReturnType<typeof resolveSetupScriptConfig>]>([
      ["no setup script", undefined, "darwin", null],
      ["empty commands and no script", { commands: [] }, "darwin", null],
      ["blank commands only", { commands: ["  ", ""] }, "linux", null],
      ["macOS takes its own fields", all, "darwin", { commands: ["bash mac.sh"], scriptPath: "scripts/mac.sh", injectPrimaryPath: false }],
      ["Linux takes its own fields", all, "linux", { commands: ["bash linux.sh"], scriptPath: "scripts/linux.sh", injectPrimaryPath: false }],
      ["Windows takes its own fields", all, "win32", { commands: ["powershell win.ps1"], scriptPath: "scripts/win.ps1", injectPrimaryPath: false }],
      ["macOS falls back to macOS/Linux", { ...all, macosCommands: undefined, macosScriptPath: undefined }, "darwin", { commands: ["bash unix.sh"], scriptPath: "scripts/unix.sh", injectPrimaryPath: false }],
      ["another Unix skips the macOS and Linux fields", all, "freebsd", { commands: ["bash unix.sh"], scriptPath: "scripts/unix.sh", injectPrimaryPath: false }],
      ["any OS's fields when nothing closer is set", { commands: [" npm install ", "npm run build"], scriptPath: "scripts/post-setup.sh", injectPrimaryPath: true }, "linux", { commands: ["npm install", "npm run build"], scriptPath: "scripts/post-setup.sh", injectPrimaryPath: true }],
      ["an empty Linux list still wins over the shared one", { commands: ["generic-cmd"], linuxCommands: [] }, "linux", null],
      ["shared macOS/Linux commands with a macOS-only tool, on Linux", { unixCommands: ["cp -c -R ../main/node_modules ."] }, "linux", { commands: ["cp -c -R ../main/node_modules ."], injectPrimaryPath: false, macosOnlyOnLinux: "cp -c" }],
      ["the same commands on macOS", { unixCommands: ["cp -c -R ../main/node_modules ."] }, "darwin", { commands: ["cp -c -R ../main/node_modules ."], injectPrimaryPath: false }],
      ["Linux commands of its own never carry the macOS note", { unixCommands: ["xcrun simctl list"], linuxCommands: ["npm ci"] }, "linux", { commands: ["npm ci"], injectPrimaryPath: false }],
    ])("%s", (_label, setupScript, platform, expected) => {
      expect(resolveSetupScriptConfig(setupScript, platform)).toEqual(expected);
    });
  });

  describe("unsupportedWindowsScriptPathError", () => {
    it("names the fix when Windows falls back to a script it cannot execute", () => {
      // A template with only a generic `scriptPath: scripts/setup.sh` resolves
      // to that .sh on win32. Spawning it there dies with a raw ENOEXEC that
      // reads as an ADE bug, so the step has to say what to configure instead.
      const message = unsupportedWindowsScriptPathError("scripts/setup.sh", "win32");

      expect(message).toContain("scripts/setup.sh");
      expect(message).toContain("windowsScriptPath");
    });

    it("rejects an extension-less script on Windows", () => {
      expect(unsupportedWindowsScriptPathError("scripts/setup", "win32")).toContain("windowsScriptPath");
    });

    it("allows the extensions Windows can actually launch", () => {
      for (const script of ["scripts\\setup.ps1", "setup.CMD", "setup.bat", "C:\\tools\\setup.exe"]) {
        expect(unsupportedWindowsScriptPathError(script, "win32")).toBeNull();
      }
    });

    it("never blocks a POSIX script, where the shebang decides", () => {
      expect(unsupportedWindowsScriptPathError("scripts/setup.sh", "darwin")).toBeNull();
      expect(unsupportedWindowsScriptPathError("scripts/setup", "linux")).toBeNull();
    });
  });
});
