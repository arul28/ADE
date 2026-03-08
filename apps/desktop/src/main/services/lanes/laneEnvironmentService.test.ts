import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createLaneEnvironmentService } from "./laneEnvironmentService";
import type { LaneEnvInitConfig, LaneOverlayOverrides, LaneSummary } from "../../../shared/types";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  } as any;
}

function makeLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "feature-auth",
    description: null,
    laneType: "worktree",
    baseRef: "main",
    branchRef: "feature/auth",
    worktreePath: "/tmp/test-worktree",
    attachedRootPath: null,
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    folder: null,
    createdAt: new Date().toISOString(),
    archivedAt: null,
    ...overrides
  };
}

describe("laneEnvironmentService", () => {
  let projectRoot: string;
  let adeDir: string;
  let events: any[];
  const originalPath = process.env.PATH;
  const originalDockerLogPath = process.env.ADE_TEST_DOCKER_LOG;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-env-"));
    adeDir = path.join(projectRoot, ".ade");
    fs.mkdirSync(adeDir, { recursive: true });
    events = [];
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    process.env.PATH = originalPath;
    if (originalDockerLogPath == null) {
      delete process.env.ADE_TEST_DOCKER_LOG;
    } else {
      process.env.ADE_TEST_DOCKER_LOG = originalDockerLogPath;
    }
  });

  function createService() {
    return createLaneEnvironmentService({
      projectRoot,
      adeDir,
      logger: createLogger(),
      broadcastEvent: (ev) => events.push(ev)
    });
  }

  describe("env file copying/templating", () => {
    it("copies and templates env files with lane-specific values", async () => {
      // Create a template file
      fs.writeFileSync(path.join(projectRoot, ".env.template"), "PORT={{PORT}}\nHOSTNAME={{HOSTNAME}}\nDB={{DB_URL}}");

      const worktreePath = path.join(projectRoot, "worktree-1");
      fs.mkdirSync(worktreePath, { recursive: true });

      const lane = makeLane({ id: "lane-1", name: "feature-auth", worktreePath });
      const config: LaneEnvInitConfig = {
        envFiles: [{ source: ".env.template", dest: ".env", vars: { DB_URL: "postgres://localhost/lane1" } }]
      };
      const overrides: LaneOverlayOverrides = {
        portRange: { start: 3100, end: 3199 }
      };

      const service = createService();
      const result = await service.initLaneEnvironment(lane, config, overrides);

      expect(result.overallStatus).toBe("completed");
      const envContent = fs.readFileSync(path.join(worktreePath, ".env"), "utf-8");
      expect(envContent).toContain("PORT=3100");
      expect(envContent).toContain("HOSTNAME=feature-auth.localhost");
      expect(envContent).toContain("DB=postgres://localhost/lane1");
    });

    it("skips missing source files gracefully", async () => {
      const worktreePath = path.join(projectRoot, "worktree-2");
      fs.mkdirSync(worktreePath, { recursive: true });

      const lane = makeLane({ id: "lane-2", name: "test-lane", worktreePath });
      const config: LaneEnvInitConfig = {
        envFiles: [{ source: "nonexistent.env", dest: ".env" }]
      };

      const service = createService();
      const result = await service.initLaneEnvironment(lane, config, {});

      expect(result.overallStatus).toBe("completed");
    });
  });

  describe("multi-lane collision", () => {
    it("produces different env files for different lanes", async () => {
      fs.writeFileSync(path.join(projectRoot, ".env.template"), "PORT={{PORT}}\nHOSTNAME={{HOSTNAME}}");

      const wt1 = path.join(projectRoot, "wt-lane-1");
      const wt2 = path.join(projectRoot, "wt-lane-2");
      fs.mkdirSync(wt1, { recursive: true });
      fs.mkdirSync(wt2, { recursive: true });

      const lane1 = makeLane({ id: "lane-1", name: "feature-auth", worktreePath: wt1 });
      const lane2 = makeLane({ id: "lane-2", name: "bugfix-login", worktreePath: wt2 });

      const config: LaneEnvInitConfig = {
        envFiles: [{ source: ".env.template", dest: ".env" }]
      };

      const service = createService();

      const overrides1: LaneOverlayOverrides = { portRange: { start: 3000, end: 3099 } };
      const overrides2: LaneOverlayOverrides = { portRange: { start: 3100, end: 3199 } };

      await service.initLaneEnvironment(lane1, config, overrides1);
      await service.initLaneEnvironment(lane2, config, overrides2);

      const env1 = fs.readFileSync(path.join(wt1, ".env"), "utf-8");
      const env2 = fs.readFileSync(path.join(wt2, ".env"), "utf-8");

      expect(env1).toContain("PORT=3000");
      expect(env1).toContain("HOSTNAME=feature-auth.localhost");
      expect(env2).toContain("PORT=3100");
      expect(env2).toContain("HOSTNAME=bugfix-login.localhost");

      // Verify no collision
      expect(env1).not.toEqual(env2);
    });

    it("tracks separate progress for each lane", async () => {
      const wt1 = path.join(projectRoot, "wt-1");
      const wt2 = path.join(projectRoot, "wt-2");
      fs.mkdirSync(wt1, { recursive: true });
      fs.mkdirSync(wt2, { recursive: true });

      const lane1 = makeLane({ id: "l1", name: "lane-1", worktreePath: wt1 });
      const lane2 = makeLane({ id: "l2", name: "lane-2", worktreePath: wt2 });

      const config: LaneEnvInitConfig = {
        envFiles: []
      };

      const service = createService();
      await service.initLaneEnvironment(lane1, config, {});
      await service.initLaneEnvironment(lane2, config, {});

      const p1 = service.getProgress("l1");
      const p2 = service.getProgress("l2");
      expect(p1).not.toBeNull();
      expect(p2).not.toBeNull();
      expect(p1!.laneId).toBe("l1");
      expect(p2!.laneId).toBe("l2");
    });
  });

  describe("mount points", () => {
    it("copies agent profile files to worktree", async () => {
      const profileDir = path.join(adeDir, "agent-profiles");
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(path.join(profileDir, "default.json"), '{"model":"claude"}');

      const worktreePath = path.join(projectRoot, "wt-mount");
      fs.mkdirSync(worktreePath, { recursive: true });

      const lane = makeLane({ id: "l-mount", name: "mount-test", worktreePath });
      const config: LaneEnvInitConfig = {
        mountPoints: [{ source: "agent-profiles/default.json", dest: ".ade-agent/profile.json" }]
      };

      const service = createService();
      const result = await service.initLaneEnvironment(lane, config, {});

      expect(result.overallStatus).toBe("completed");
      const content = fs.readFileSync(path.join(worktreePath, ".ade-agent/profile.json"), "utf-8");
      expect(JSON.parse(content)).toEqual({ model: "claude" });
    });
  });

  describe("resolveEnvInitConfig", () => {
    it("returns undefined when both inputs are undefined", () => {
      const service = createService();
      expect(service.resolveEnvInitConfig(undefined, {})).toBeUndefined();
    });

    it("returns overlay config when no project default", () => {
      const service = createService();
      const overlayInit: LaneEnvInitConfig = {
        dependencies: [{ command: ["npm", "install"] }]
      };
      const result = service.resolveEnvInitConfig(undefined, { envInit: overlayInit });
      expect(result).toEqual(overlayInit);
    });

    it("merges project default with overlay", () => {
      const service = createService();
      const projectDefault: LaneEnvInitConfig = {
        envFiles: [{ source: ".env.template", dest: ".env" }],
        dependencies: [{ command: ["npm", "install"] }]
      };
      const overlayInit: LaneEnvInitConfig = {
        envFiles: [{ source: ".env.backend", dest: ".env.local" }],
        docker: { composePath: "docker-compose.yml" }
      };
      const result = service.resolveEnvInitConfig(projectDefault, { envInit: overlayInit });
      expect(result).toBeDefined();
      expect(result!.envFiles).toHaveLength(2);
      expect(result!.dependencies).toHaveLength(1);
      expect(result!.docker).toEqual({ composePath: "docker-compose.yml" });
    });

    it("deep merges nested docker config fields", () => {
      const service = createService();
      const projectDefault: LaneEnvInitConfig = {
        docker: { composePath: "docker-compose.yml", projectPrefix: "ade" }
      };
      const overlayInit: LaneEnvInitConfig = {
        docker: { services: ["api"] }
      };
      const result = service.resolveEnvInitConfig(projectDefault, { envInit: overlayInit });
      expect(result?.docker).toEqual({
        composePath: "docker-compose.yml",
        projectPrefix: "ade",
        services: ["api"]
      });
    });
  });

  describe("cleanupLaneEnvironment", () => {
    it("uses the configured compose file when tearing down docker resources", async () => {
      const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-env-bin-"));
      const dockerLogPath = path.join(projectRoot, "docker-args.log");
      const dockerPath = path.join(binDir, "docker");
      fs.writeFileSync(
        dockerPath,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$ADE_TEST_DOCKER_LOG\"\n",
        { mode: 0o755 }
      );
      process.env.PATH = `${binDir}:${originalPath ?? ""}`;
      process.env.ADE_TEST_DOCKER_LOG = dockerLogPath;

      const composeDir = path.join(projectRoot, "infra");
      fs.mkdirSync(composeDir, { recursive: true });
      fs.writeFileSync(path.join(composeDir, "compose.yaml"), "services: {}\n");

      const worktreePath = path.join(projectRoot, "wt-cleanup");
      fs.mkdirSync(worktreePath, { recursive: true });

      const lane = makeLane({ id: "lane-clean", name: "cleanup lane", worktreePath });
      const service = createService();
      await service.cleanupLaneEnvironment(lane, {
        docker: { composePath: "infra/compose.yaml", projectPrefix: "lane" }
      });

      expect(fs.readFileSync(dockerLogPath, "utf-8").trim().split("\n")).toEqual([
        "compose",
        "-f",
        path.join(projectRoot, "infra/compose.yaml"),
        "-p",
        "lane-lane-clean",
        "down",
        "--remove-orphans"
      ]);
    });
  });

  describe("progress events", () => {
    it("broadcasts events during env init", async () => {
      fs.writeFileSync(path.join(projectRoot, ".env.template"), "PORT={{PORT}}");

      const worktreePath = path.join(projectRoot, "wt-events");
      fs.mkdirSync(worktreePath, { recursive: true });

      const lane = makeLane({ id: "lane-ev", name: "event-lane", worktreePath });
      const config: LaneEnvInitConfig = {
        envFiles: [{ source: ".env.template", dest: ".env" }]
      };

      const service = createService();
      await service.initLaneEnvironment(lane, config, {});

      // Should have received multiple events (start, step running, step completed, overall completed)
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe("lane-env-init");
      const lastEvent = events[events.length - 1];
      expect(lastEvent.progress.overallStatus).toBe("completed");
    });
  });
});
