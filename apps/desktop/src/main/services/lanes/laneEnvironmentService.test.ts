import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
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

  function createService(
    // Trusted by default: the gate is required in production, so the helper
    // supplies a config service that always allows execution and each trust
    // test passes its own.
    projectConfigService: { getExecutableConfig: () => unknown } = { getExecutableConfig: () => ({}) },
    logger: any = createLogger(),
  ) {
    return createLaneEnvironmentService({
      projectRoot,
      adeDir,
      logger,
      broadcastEvent: (ev) => events.push(ev),
      projectConfigService
    });
  }

  function untrustedConfigService() {
    return {
      getExecutableConfig: () => {
        const error = new Error("ADE_TRUST_REQUIRED: shared config not trusted") as Error & { code?: string };
        error.code = "ADE_TRUST_REQUIRED";
        throw error;
      }
    };
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

    it("fails when an env file source escapes the project root", async () => {
      const outsidePath = path.join(path.dirname(projectRoot), `lane-env-outside-${Date.now()}.env`);
      fs.writeFileSync(outsidePath, "SECRET=1\n", "utf8");

      const worktreePath = path.join(projectRoot, "worktree-escape");
      fs.mkdirSync(worktreePath, { recursive: true });

      const lane = makeLane({ id: "lane-escape", name: "escape-lane", worktreePath });
      const config: LaneEnvInitConfig = {
        envFiles: [{ source: `../${path.basename(outsidePath)}`, dest: ".env" }]
      };

      try {
        const service = createService();
        const result = await service.initLaneEnvironment(lane, config, {});
        expect(result.overallStatus).toBe("failed");
      } finally {
        fs.rmSync(outsidePath, { force: true });
      }
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

  describe("dependency installs", () => {
    it("fails when a dependency cwd escapes the worktree", async () => {
      const worktreePath = path.join(projectRoot, "wt-deps");
      fs.mkdirSync(worktreePath, { recursive: true });
      fs.mkdirSync(path.join(path.dirname(worktreePath), "outside-deps"), { recursive: true });

      const lane = makeLane({ id: "l-deps", name: "deps-test", worktreePath });
      const config: LaneEnvInitConfig = {
        dependencies: [{ command: ["npm", "--version"], cwd: "../outside-deps" }]
      };

      const service = createService();
      const result = await service.initLaneEnvironment(lane, config, {});

      expect(result.overallStatus).toBe("failed");
    });
  });

  // The setup step runs real shell lines; the POSIX shell is the contract under
  // test here, and Windows quoting is covered by the invocation helpers.
  describe.skipIf(process.platform === "win32")("setup script", () => {
    it("runs configured commands in the worktree with lane env vars", async () => {
      const worktreePath = path.join(projectRoot, "wt-setup");
      fs.mkdirSync(worktreePath, { recursive: true });

      const lane = makeLane({ id: "lane-setup", name: "feature-auth", worktreePath });
      const config: LaneEnvInitConfig = {
        setupScript: {
          commands: [
            'printf "%s\\n" "$PORT|$LANE_NAME|$PRIMARY_WORKTREE_PATH|$PWD" > setup-out.txt',
            "printf 'second\\n' >> setup-out.txt",
          ],
          injectPrimaryPath: true,
        },
      };

      const service = createService();
      const result = await service.initLaneEnvironment(lane, config, {
        portRange: { start: 3400, end: 3499 },
      });

      expect(result.overallStatus).toBe("completed");
      expect(result.steps.map((step) => step.kind)).toEqual(["setup-script"]);
      const lines = fs.readFileSync(path.join(worktreePath, "setup-out.txt"), "utf-8").trim().split("\n");
      expect(lines[1]).toBe("second");
      const [port, laneName, primaryPath, cwd] = lines[0]!.split("|");
      expect(port).toBe("3400");
      expect(laneName).toBe("feature-auth");
      expect(fs.realpathSync(primaryPath!)).toBe(fs.realpathSync(projectRoot));
      expect(fs.realpathSync(cwd!)).toBe(fs.realpathSync(worktreePath));
    });

    it("omits PRIMARY_WORKTREE_PATH unless the template opts in", async () => {
      const worktreePath = path.join(projectRoot, "wt-setup-noinject");
      fs.mkdirSync(worktreePath, { recursive: true });

      const lane = makeLane({ id: "lane-setup-noinject", name: "no-inject", worktreePath });
      const service = createService();
      const result = await service.initLaneEnvironment(
        lane,
        { setupScript: { commands: ['printf "[%s]" "$PRIMARY_WORKTREE_PATH" > primary.txt'] } },
        {},
      );

      expect(result.overallStatus).toBe("completed");
      expect(fs.readFileSync(path.join(worktreePath, "primary.txt"), "utf-8")).toBe("[]");
    });

    it("adds no step when no setup script is configured for this platform", async () => {
      const worktreePath = path.join(projectRoot, "wt-setup-none");
      fs.mkdirSync(worktreePath, { recursive: true });
      fs.writeFileSync(path.join(projectRoot, ".env.template"), "PORT={{PORT}}");

      const lane = makeLane({ id: "lane-setup-none", name: "none", worktreePath });
      const service = createService();
      const result = await service.initLaneEnvironment(
        lane,
        {
          envFiles: [{ source: ".env.template", dest: ".env" }],
          setupScript: { commands: [], windowsCommands: ["echo windows-only"] },
        },
        {},
      );

      expect(result.overallStatus).toBe("completed");
      expect(result.steps.map((step) => step.kind)).toEqual(["env-files"]);
    });

    it("fails the run when a setup command exits non-zero and skips later commands", async () => {
      const worktreePath = path.join(projectRoot, "wt-setup-fail");
      fs.mkdirSync(worktreePath, { recursive: true });

      const lane = makeLane({ id: "lane-setup-fail", name: "fail", worktreePath });
      const service = createService();
      const result = await service.initLaneEnvironment(
        lane,
        {
          setupScript: {
            commands: ["echo boom 1>&2; exit 3", "touch never-ran.txt"],
          },
        },
        {},
      );

      expect(result.overallStatus).toBe("failed");
      const step = result.steps.find((entry) => entry.kind === "setup-script");
      expect(step?.status).toBe("failed");
      expect(step?.error).toContain("boom");
      expect(fs.existsSync(path.join(worktreePath, "never-ran.txt"))).toBe(false);
    });

    it("runs a configured script file after the commands", async () => {
      const worktreePath = path.join(projectRoot, "wt-setup-script");
      fs.mkdirSync(worktreePath, { recursive: true });
      const scriptDir = path.join(projectRoot, "scripts");
      fs.mkdirSync(scriptDir, { recursive: true });
      fs.writeFileSync(
        path.join(scriptDir, "setup.sh"),
        "#!/bin/sh\nprintf 'script:%s\\n' \"$LANE_SLUG\" >> order.txt\n",
        { mode: 0o755 },
      );

      const lane = makeLane({ id: "lane-setup-script", name: "Script Lane", worktreePath });
      const service = createService();
      const result = await service.initLaneEnvironment(
        lane,
        {
          setupScript: {
            commands: ["printf 'command\\n' > order.txt"],
            scriptPath: "scripts/setup.sh",
          },
        },
        {},
      );

      expect(result.overallStatus).toBe("completed");
      expect(fs.readFileSync(path.join(worktreePath, "order.txt"), "utf-8")).toBe(
        "command\nscript:script-lane\n",
      );
    });

    it("fails when the configured script file does not exist", async () => {
      const worktreePath = path.join(projectRoot, "wt-setup-missing");
      fs.mkdirSync(worktreePath, { recursive: true });

      const lane = makeLane({ id: "lane-setup-missing", name: "missing", worktreePath });
      const service = createService();
      const result = await service.initLaneEnvironment(
        lane,
        { setupScript: { scriptPath: "scripts/does-not-exist.sh" } },
        {},
      );

      expect(result.overallStatus).toBe("failed");
      const step = result.steps.find((entry) => entry.kind === "setup-script");
      expect(step?.error).toContain("scripts/does-not-exist.sh");
    });

    it("fails when the configured script path escapes the project root", async () => {
      const worktreePath = path.join(projectRoot, "wt-setup-escape");
      fs.mkdirSync(worktreePath, { recursive: true });

      const lane = makeLane({ id: "lane-setup-escape", name: "escape", worktreePath });
      const service = createService();
      const result = await service.initLaneEnvironment(
        lane,
        { setupScript: { scriptPath: "../outside-setup.sh" } },
        {},
      );

      expect(result.overallStatus).toBe("failed");
    });

    it("refuses to run setup scripts while the shared config is untrusted", async () => {
      // `.ade/ade.yaml` is repo-committed, so `laneEnvInit`/`laneTemplates` can
      // carry an attacker's shell. Failing loudly beats executing it, and beats
      // skipping it silently (which reads as success).
      const worktreePath = path.join(projectRoot, "wt-setup-untrusted");
      fs.mkdirSync(worktreePath, { recursive: true });

      const lane = makeLane({ id: "lane-setup-untrusted", name: "untrusted", worktreePath });
      const service = createService(untrustedConfigService());
      const result = await service.initLaneEnvironment(
        lane,
        { setupScript: { commands: ["touch pwned.txt"] } },
        {},
      );

      expect(result.overallStatus).toBe("failed");
      const step = result.steps.find((entry) => entry.kind === "setup-script");
      expect(step?.status).toBe("failed");
      expect(step?.error).toContain("isn't trusted yet");
      expect(fs.existsSync(path.join(worktreePath, "pwned.txt"))).toBe(false);
    });

    it("runs setup scripts once the shared config is trusted", async () => {
      const worktreePath = path.join(projectRoot, "wt-setup-trusted");
      fs.mkdirSync(worktreePath, { recursive: true });

      const lane = makeLane({ id: "lane-setup-trusted", name: "trusted", worktreePath });
      const service = createService({ getExecutableConfig: () => ({}) });
      const result = await service.initLaneEnvironment(
        lane,
        { setupScript: { commands: ["touch allowed.txt"] } },
        {},
      );

      expect(result.overallStatus).toBe("completed");
      expect(fs.existsSync(path.join(worktreePath, "allowed.txt"))).toBe(true);
    });

    it("fails with the OS error when a script file is not executable", async () => {
      // Script files are spawned directly rather than pasted into a shell line,
      // so they must carry the executable bit and a shebang.
      const worktreePath = path.join(projectRoot, "wt-setup-noexec");
      fs.mkdirSync(worktreePath, { recursive: true });
      const scriptDir = path.join(projectRoot, "scripts");
      fs.mkdirSync(scriptDir, { recursive: true });
      fs.writeFileSync(
        path.join(scriptDir, "not-executable.sh"),
        "#!/bin/sh" + String.fromCharCode(10) + "echo hi" + String.fromCharCode(10),
        { mode: 0o644 },
      );

      const lane = makeLane({ id: "lane-setup-noexec", name: "noexec", worktreePath });
      const service = createService();
      const result = await service.initLaneEnvironment(
        lane,
        { setupScript: { scriptPath: "scripts/not-executable.sh" } },
        {},
      );

      expect(result.overallStatus).toBe("failed");
      const step = result.steps.find((entry) => entry.kind === "setup-script");
      expect(step?.error).toContain("EACCES");
    });

    it("runs the setup script after every other init step", async () => {
      const worktreePath = path.join(projectRoot, "wt-setup-order");
      fs.mkdirSync(worktreePath, { recursive: true });
      fs.writeFileSync(path.join(projectRoot, ".env.order"), "PORT={{PORT}}");

      const lane = makeLane({ id: "lane-setup-order", name: "order", worktreePath });
      const service = createService();
      const result = await service.initLaneEnvironment(
        lane,
        {
          envFiles: [{ source: ".env.order", dest: ".env" }],
          setupScript: { commands: ["cp .env .env.copied"] },
        },
        {},
      );

      expect(result.overallStatus).toBe("completed");
      expect(result.steps.map((step) => step.kind)).toEqual(["env-files", "setup-script"]);
      expect(fs.readFileSync(path.join(worktreePath, ".env.copied"), "utf-8")).toContain("PORT=3000");
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

    it("keeps a windows-only setup script in the normalized config on darwin", () => {
      // Normalization used the PLATFORM-specific resolver as an existence
      // check, so a `windowsCommands`-only template lost its setup script on
      // macOS — and the normalized config is what merges and persists.
      const service = createService();
      const projectDefault: LaneEnvInitConfig = {
        setupScript: { windowsCommands: ["pwsh -c ./setup.ps1"] }
      };
      const result = service.resolveEnvInitConfig(projectDefault, {});
      expect(result?.setupScript).toEqual({ windowsCommands: ["pwsh -c ./setup.ps1"] });
    });
  });

  describe("per-lane serialization", () => {
    /**
     * Real `docker` stub that sleeps, so "did these overlap?" is decided by
     * actual concurrency rather than by microtask ordering.
     */
    function installSlowDockerStub(): { composePath: string; cleanup: () => void } {
      const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-env-slow-bin-"));
      fs.writeFileSync(
        path.join(binDir, "docker"),
        "#!/bin/sh\nsleep 0.4\n",
        { mode: 0o755 },
      );
      process.env.PATH = `${binDir}:${originalPath ?? ""}`;
      fs.writeFileSync(path.join(projectRoot, "docker-compose.yml"), "services: {}\n");
      return {
        composePath: "docker-compose.yml",
        cleanup: () => fs.rmSync(binDir, { recursive: true, force: true }),
      };
    }

    it("never interleaves init and cleanup for the same lane", async () => {
      // The unarchive Docker restore is not awaited by its caller, so a quick
      // archive right after it used to run `compose down` while `compose up`
      // was still bringing the stack up.
      const { composePath, cleanup: removeStub } = installSlowDockerStub();
      try {
        const service = createService();
        const config: LaneEnvInitConfig = { docker: { composePath } };
        const order: string[] = [];

        const lane = makeLane({ worktreePath: projectRoot });
        const init = service.initLaneEnvironment(lane, config, {}).then(() => {
          order.push("init");
        });
        const cleanup = service.cleanupLaneEnvironment(lane, config).then(() => {
          order.push("cleanup");
        });

        await Promise.all([init, cleanup]);
        expect(order).toEqual(["init", "cleanup"]);
      } finally {
        removeStub();
      }
    });

    it("does not let one lane's environment work block another's", async () => {
      const { composePath, cleanup: removeStub } = installSlowDockerStub();
      try {
        const service = createService();
        const order: string[] = [];

        const slow = service
          .initLaneEnvironment(makeLane({ id: "lane-slow", worktreePath: projectRoot }), { docker: { composePath } }, {})
          .then(() => {
            order.push("slow");
          });
        // No steps at all: this resolves at once unless queued behind the
        // other lane's compose run.
        const fast = service
          .initLaneEnvironment(makeLane({ id: "lane-fast", worktreePath: projectRoot }), {}, {})
          .then(() => {
            order.push("fast");
          });

        await Promise.all([slow, fast]);
        expect(order).toEqual(["fast", "slow"]);
      } finally {
        removeStub();
      }
    });

    /** Poll until `predicate` holds, so the test observes real async progress. */
    async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
      const deadline = Date.now() + 5000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    function dockerStepRunning(): boolean {
      return events.some((ev) =>
        ev.progress.steps.some((step: any) => step.kind === "docker" && step.status === "running"),
      );
    }

    it("stops an in-flight init at the next step boundary when cleanup is queued", async () => {
      // Cleanup is serialized behind init, and a full init can run for minutes
      // (120s/300s budgets per step), so an archive arriving mid-init used to
      // wait the whole sequence out for a lane that is going away.
      const { composePath, cleanup: removeStub } = installSlowDockerStub();
      try {
        const warnings: { event: string; meta?: any }[] = [];
        const service = createService(undefined, {
          ...createLogger(),
          warn: (event: string, meta?: any) => warnings.push({ event, meta }),
        });

        const worktreePath = path.join(projectRoot, "wt-cancel");
        fs.mkdirSync(worktreePath, { recursive: true });
        fs.writeFileSync(path.join(projectRoot, "copy-me.txt"), "payload");
        const lane = makeLane({ id: "lane-cancel", worktreePath });
        // Docker runs first and is slow; copy-paths is the step that must not run.
        const config: LaneEnvInitConfig = {
          docker: { composePath },
          copyPaths: [{ source: "copy-me.txt", dest: "copied.txt" }],
        };

        const init = service.initLaneEnvironment(lane, config, {});
        await waitUntil(dockerStepRunning, "the docker step to start");

        const cleanup = service.cleanupLaneEnvironment(lane, config);
        const [progress] = await Promise.all([init, cleanup]);

        expect(fs.existsSync(path.join(worktreePath, "copied.txt"))).toBe(false);
        expect(progress.overallStatus).toBe("failed");
        expect(progress.steps.find((step) => step.kind === "docker")?.status).toBe("completed");
        const copyStep = progress.steps.find((step) => step.kind === "copy-paths");
        expect(copyStep?.status).toBe("skipped");
        expect(copyStep?.error).toContain("Cancelled");
        expect(warnings.map((entry) => entry.event)).toContain(
          "lane_env_cleanup.waiting_for_inflight_init",
        );
        // The cleanup deleted the progress entry, so the marker is the only
        // record that this worktree was left half-built — and unarchive reads
        // it to decide between a docker-only restore and a full re-init.
        expect(service.getProgress(lane.id)).toBeNull();
        expect(service.wasLastInitIncomplete(lane.id)).toBe(true);
        // Durable: an archive today and an unarchive after a restart is the
        // whole point, so a fresh service must still see it.
        expect(createService().wasLastInitIncomplete(lane.id)).toBe(true);
      } finally {
        removeStub();
      }
    });

    it("clears the incomplete-init marker once a later init completes", async () => {
      const { composePath, cleanup: removeStub } = installSlowDockerStub();
      try {
        const service = createService();
        const worktreePath = path.join(projectRoot, "wt-repair");
        fs.mkdirSync(worktreePath, { recursive: true });
        const lane = makeLane({ id: "lane-repair", worktreePath });
        fs.writeFileSync(path.join(projectRoot, "copy-me.txt"), "payload");
        // Two steps, so the cancellation has a boundary to stop at.
        const config: LaneEnvInitConfig = {
          docker: { composePath },
          copyPaths: [{ source: "copy-me.txt", dest: "copied.txt" }],
        };

        const init = service.initLaneEnvironment(lane, config, {});
        await waitUntil(dockerStepRunning, "the docker step to start");
        await Promise.all([init, service.cleanupLaneEnvironment(lane, config)]);
        expect(service.wasLastInitIncomplete(lane.id)).toBe(true);

        await service.initLaneEnvironment(lane, config, {});

        expect(service.wasLastInitIncomplete(lane.id)).toBe(false);
        expect(createService().wasLastInitIncomplete(lane.id)).toBe(false);
      } finally {
        removeStub();
      }
    });

    it("marks the init incomplete when a failure leaves later steps unrun", async () => {
      const service = createService();
      const worktreePath = path.join(projectRoot, "wt-early-fail");
      fs.mkdirSync(worktreePath, { recursive: true });
      fs.writeFileSync(path.join(projectRoot, "copy-me.txt"), "payload");
      const lane = makeLane({ id: "lane-early-fail", worktreePath });

      // env-files runs first and fails on the escaping source; copy-paths
      // never runs, so the worktree really is half-built.
      const progress = await service.initLaneEnvironment(
        lane,
        {
          envFiles: [{ source: "../outside.env", dest: ".env" }],
          copyPaths: [{ source: "copy-me.txt", dest: "copied.txt" }],
        },
        {},
      );

      expect(progress.overallStatus).toBe("failed");
      expect(progress.steps.find((step) => step.kind === "copy-paths")?.status).toBe("pending");
      expect(service.wasLastInitIncomplete(lane.id)).toBe(true);
    });

    it("does not mark the init incomplete when only the last step fails", async () => {
      const service = createService();
      const worktreePath = path.join(projectRoot, "wt-last-fail");
      fs.mkdirSync(worktreePath, { recursive: true });
      const lane = makeLane({ id: "lane-last-fail", worktreePath });

      // A single planned step that fails: everything before it (nothing)
      // completed, so unarchive must NOT re-template the worktree.
      const progress = await service.initLaneEnvironment(
        lane,
        { copyPaths: [{ source: "../outside.txt", dest: "copied.txt" }] },
        {},
      );

      expect(progress.overallStatus).toBe("failed");
      expect(progress.steps.some((step) => step.status === "pending")).toBe(false);
      expect(service.wasLastInitIncomplete(lane.id)).toBe(false);
    });

    it("skips a queued init whose precondition no longer holds when the queue reaches it", async () => {
      // Ordering, not politeness: the caller's own "is this lane still active?"
      // check runs before it enqueues, so a teardown already queued ahead of it
      // runs first and the init would `compose up` a lane that is now archived.
      const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-env-precond-bin-"));
      try {
        const dockerLogPath = path.join(projectRoot, "docker-args.log");
        fs.writeFileSync(
          path.join(binDir, "docker"),
          "#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$ADE_TEST_DOCKER_LOG\"\n",
          { mode: 0o755 },
        );
        process.env.PATH = `${binDir}:${originalPath ?? ""}`;
        process.env.ADE_TEST_DOCKER_LOG = dockerLogPath;
        fs.writeFileSync(path.join(projectRoot, "docker-compose.yml"), "services: {}\n");

        const service = createService();
        const worktreePath = path.join(projectRoot, "wt-precond");
        fs.mkdirSync(worktreePath, { recursive: true });
        const lane = makeLane({ id: "lane-precond", worktreePath });
        const config: LaneEnvInitConfig = { docker: { composePath: "docker-compose.yml" } };
        const dockerArgs = (): string =>
          fs.existsSync(dockerLogPath) ? fs.readFileSync(dockerLogPath, "utf-8") : "";

        // The teardown goes in first; the restore's init lands behind it while
        // the lane still looks active, exactly as the unarchive race does.
        const cleanup = service.cleanupLaneEnvironment(lane, config);
        const init = service.initLaneEnvironment(lane, config, {}, {
          precondition: async () => !dockerArgs().includes("down"),
        });
        const [, progress] = await Promise.all([cleanup, init]);

        expect(dockerArgs()).toContain("down");
        expect(dockerArgs()).not.toContain("up");
        expect(progress.steps).toEqual([]);
        // Nothing ran, so nothing was announced to the UI either.
        expect(events).toEqual([]);
      } finally {
        fs.rmSync(binDir, { recursive: true, force: true });
      }
    });

    it("leaves the incomplete-init marker untouched when the precondition skips the run", async () => {
      const service = createService();
      const worktreePath = path.join(projectRoot, "wt-precond-marker");
      fs.mkdirSync(worktreePath, { recursive: true });
      fs.writeFileSync(path.join(projectRoot, "copy-me.txt"), "payload");
      const lane = makeLane({ id: "lane-precond-marker", worktreePath });
      const copyPaths = [{ source: "copy-me.txt", dest: "copied.txt" }];

      // env-files fails first, so copy-paths never runs and the worktree is
      // recorded as half-built.
      await service.initLaneEnvironment(
        lane,
        { envFiles: [{ source: "../outside.env", dest: ".env" }], copyPaths },
        {},
      );
      expect(service.wasLastInitIncomplete(lane.id)).toBe(true);

      const progress = await service.initLaneEnvironment(lane, { copyPaths }, {}, {
        precondition: async () => false,
      });

      expect(progress.steps).toEqual([]);
      expect(fs.existsSync(path.join(worktreePath, "copied.txt"))).toBe(false);
      // A skipped run repaired nothing, so it must not report the lane healthy.
      expect(service.wasLastInitIncomplete(lane.id)).toBe(true);
    });

    it("sees another service instance's incomplete-init mark without being recreated", async () => {
      // Desktop main and the ade-cli brain build this service over the same
      // `.ade` directory, so a marker cached for the life of a process let one
      // host keep answering "that init completed" after the other cancelled it.
      const writer = createService();
      const reader = createService();
      const worktreePath = path.join(projectRoot, "wt-cross-process");
      fs.mkdirSync(worktreePath, { recursive: true });
      fs.writeFileSync(path.join(projectRoot, "copy-me.txt"), "payload");
      const lane = makeLane({ id: "lane-cross-process", worktreePath });
      const copyPaths = [{ source: "copy-me.txt", dest: "copied.txt" }];

      // The reader answers — and would have cached — before the mark exists.
      expect(reader.wasLastInitIncomplete(lane.id)).toBe(false);

      await writer.initLaneEnvironment(
        lane,
        { envFiles: [{ source: "../outside.env", dest: ".env" }], copyPaths },
        {},
      );

      expect(reader.wasLastInitIncomplete(lane.id)).toBe(true);

      // And the clear crosses back the same way.
      await writer.initLaneEnvironment(lane, { copyPaths }, {});

      expect(reader.wasLastInitIncomplete(lane.id)).toBe(false);
    });

    it("runs every step when no cleanup is queued", async () => {
      const { composePath, cleanup: removeStub } = installSlowDockerStub();
      try {
        const service = createService();
        const worktreePath = path.join(projectRoot, "wt-normal");
        fs.mkdirSync(worktreePath, { recursive: true });
        fs.writeFileSync(path.join(projectRoot, "copy-me.txt"), "payload");
        const lane = makeLane({ id: "lane-normal", worktreePath });

        const progress = await service.initLaneEnvironment(
          lane,
          {
            docker: { composePath },
            copyPaths: [{ source: "copy-me.txt", dest: "copied.txt" }],
          },
          {},
        );

        expect(progress.overallStatus).toBe("completed");
        expect(progress.steps.map((step) => step.status)).toEqual(["completed", "completed"]);
        expect(fs.existsSync(path.join(worktreePath, "copied.txt"))).toBe(true);
      } finally {
        removeStub();
      }
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
        fs.realpathSync(path.join(projectRoot, "infra/compose.yaml")),
        "-p",
        "lane-lane-clean",
        "down",
        "--remove-orphans"
      ]);
    });

    it("skips docker teardown when the compose path escapes the project root", async () => {
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

      const outsideCompose = path.join(path.dirname(projectRoot), `compose-${Date.now()}.yaml`);
      fs.writeFileSync(outsideCompose, "services: {}\n");

      const worktreePath = path.join(projectRoot, "wt-cleanup-escape");
      fs.mkdirSync(worktreePath, { recursive: true });

      try {
        const lane = makeLane({ id: "lane-clean-escape", name: "cleanup lane", worktreePath });
        const service = createService();
        await service.cleanupLaneEnvironment(lane, {
          docker: { composePath: `../${path.basename(outsideCompose)}`, projectPrefix: "lane" }
        });

        expect(fs.existsSync(dockerLogPath)).toBe(false);
      } finally {
        fs.rmSync(outsideCompose, { force: true });
      }
    });

    it("still runs docker teardown when compose path validation hits a non-escape error", async () => {
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
      const composePath = path.join(composeDir, "compose.yaml");
      fs.writeFileSync(composePath, "services: {}\n");

      const worktreePath = path.join(projectRoot, "wt-cleanup-permission");
      fs.mkdirSync(worktreePath, { recursive: true });

      const originalLstatSync = fs.lstatSync.bind(fs);
      const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" as const });
      const spy = vi.spyOn(fs, "lstatSync").mockImplementation(((filePath: fs.PathLike) => {
        if (String(filePath) === composePath) {
          throw permissionError;
        }
        return originalLstatSync(filePath);
      }) as typeof fs.lstatSync);

      try {
        const lane = makeLane({ id: "lane-clean-permission", name: "cleanup lane", worktreePath });
        const service = createService();
        await service.cleanupLaneEnvironment(lane, {
          docker: { composePath: "infra/compose.yaml", projectPrefix: "lane" }
        });

        expect(fs.readFileSync(dockerLogPath, "utf-8").trim().split("\n")).toEqual([
          "compose",
          "-f",
          fs.realpathSync(composePath),
          "-p",
          "lane-lane-clean-permission",
          "down",
          "--remove-orphans"
        ]);
      } finally {
        spy.mockRestore();
      }
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
