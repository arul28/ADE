import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applySyncWebPairingFlags,
  buildAdeCodeArgs,
  buildCliPlan,
  checkLinearReadiness,
  detectAccountLoginMode,
  detectUnmergedLaneCreateNudge,
  findProjectRoots,
  formatOutput,
  graphWaitState,
  inferFormatter,
  isEphemeralRuntimeSocketPath,
  isFailedServiceManagerResult,
  machineRuntimeMismatchReason,
  parseCliArgs,
  readRuntimeIdleExitMs,
  renderLaneGraph,
  resolveAdeCodeModulePath,
  resolveRoots,
  runCli,
  startHeadlessRpcSocketServer,
  shouldAutoRegisterProjectForPlan,
  shouldBlockManualMachineRuntimeSpawn,
  shouldEnforceMachineRuntimeBuildCompatibility,
  shouldAttemptDesktopSocketConnection,
  summarizeExecution,
  unwrapToolResult,
} from "./cli";
import { EncryptedFileCredentialStore } from "./services/credentials/credentialStore";

type ResolveRootsOptions = Parameters<typeof resolveRoots>[0];

process.env.ADE_ENABLE_AUTOMATIONS = "1";
process.env.ADE_ENABLE_MACOS_VM = "1";

const crdtHostIt = process.platform === "darwin" ? it : it.skip;

function withEnv<T>(updates: Record<string, string | undefined>, run: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(updates)) {
    previous.set(key, process.env[key]);
    const value = updates[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function baseResolveOpts(): Omit<
  ResolveRootsOptions,
  "projectRoot" | "workspaceRoot"
> {
  return {
    role: "external",
    headless: true,
    requireSocket: false,
    socketPath: null,
    pretty: false,
    text: false,
    timeoutMs: 15_000,
  };
}

function expectExecutePlan(
  plan: ReturnType<typeof buildCliPlan>,
): Extract<ReturnType<typeof buildCliPlan>, { kind: "execute" }> {
  expect(plan.kind).toBe("execute");
  if (plan.kind !== "execute") {
    throw new Error(`Expected execute plan, got ${plan.kind}`);
  }
  return plan;
}

function expectStaticPlan(
  plan: ReturnType<typeof buildCliPlan>,
): Extract<ReturnType<typeof buildCliPlan>, { kind: "static" }> {
  expect(plan.kind).toBe("static");
  if (plan.kind !== "static") {
    throw new Error(`Expected static plan, got ${plan.kind}`);
  }
  return plan;
}

function writeSyncHostSingletonLock(args: {
  lockPath: string;
  pid: number;
  port: number;
  packageChannel: string | null;
  adeHome: string;
}): void {
  const now = "2026-06-11T00:00:00.000Z";
  fs.mkdirSync(path.dirname(args.lockPath), { recursive: true });
  fs.writeFileSync(args.lockPath, `${JSON.stringify({
    version: 1,
    owner: {
      id: "other-channel-brain",
      pid: args.pid,
      port: args.port,
      appName: args.packageChannel === "beta" ? "ADE Beta" : "ADE",
      packageChannel: args.packageChannel,
      adeHome: args.adeHome,
      serviceName: args.packageChannel === "beta" ? "com.ade.runtime.beta" : "com.ade.runtime",
      socketPath: path.join(args.adeHome, "sock", "ade.sock"),
      projectRoot: "/Users/admin/Projects/ADE",
      commandLine: null,
      quitCommand: `ADE_HOME='${args.adeHome}' ade brain stop --text`,
      createdAt: now,
      updatedAt: now,
    },
  }, null, 2)}\n`, "utf8");
}

describe("ADE CLI", () => {
  it("builds projectless account commands and reports the signed-out local-first message", () => {
    const statusPlan = expectExecutePlan(buildCliPlan(["auth", "status"]));
    expect(statusPlan).toMatchObject({
      label: "auth status",
      formatter: "account-auth",
      machineOnly: true,
      machineAutoStart: true,
      connectRole: "cto",
      steps: [{
        method: "account.call",
        params: { action: "status", args: {} },
      }],
    });
    expect(shouldAutoRegisterProjectForPlan(statusPlan)).toBe(false);

    const logoutPlan = expectExecutePlan(buildCliPlan(["logout"]));
    expect(logoutPlan.steps[0]).toMatchObject({
      method: "account.call",
      params: { action: "signOut", args: {} },
    });
    expect(shouldAutoRegisterProjectForPlan(logoutPlan)).toBe(false);

    expect(buildCliPlan(["login", "--max-wait", "42"])).toEqual({
      kind: "account-login",
      maxWaitSec: 42,
      explicitHeadless: false,
    });
    expect(buildCliPlan(["login", "--headless"])).toEqual({
      kind: "account-login",
      maxWaitSec: null,
      explicitHeadless: true,
    });
    const tokenPlan = expectExecutePlan(buildCliPlan(["account", "token", "create"]));
    expect(tokenPlan).toMatchObject({
      label: "account token create",
      formatter: "account-token",
      machineOnly: true,
      machineAutoStart: true,
      connectRole: "cto",
      steps: [{
        method: "account.call",
        params: { action: "createToken", args: {} },
        injectProjectRootIntoArgs: true,
      }],
    });
    const machines = expectExecutePlan(buildCliPlan(["machines", "list"]));
    expect(machines).toMatchObject({
      label: "account machines list",
      formatter: "account-machines",
      machineOnly: true,
      machineAutoStart: true,
      connectRole: "cto",
      steps: [{
        method: "account.call",
        params: { action: "listMachines", args: {} },
      }],
    });
    expect(shouldAutoRegisterProjectForPlan(machines)).toBe(false);
    expect(buildCliPlan([
      "machines",
      "connect",
      "mk_studio",
      "--project",
      "ADE",
    ])).toEqual({
      kind: "account-machine-connect",
      machine: "mk_studio",
      remoteArgs: ["--project", "ADE"],
    });
    expect(buildCliPlan([
      "machine",
      "hop",
      "--machine",
      "device_studio",
      "--session",
      "Fix auth",
    ])).toEqual({
      kind: "account-machine-connect",
      machine: "device_studio",
      remoteArgs: ["--session", "Fix auth"],
    });
    expect(() => buildCliPlan(["machines", "connect", "--project", "ADE"]))
      .toThrow(/requires a stable machine key/i);
    expect(formatOutput(
      { state: "signed_out", machines: [], message: null },
      { ...baseResolveOpts(), projectRoot: null, workspaceRoot: null, text: true },
      "account-machines",
    )).toContain("run `ade login`");
    expect(formatOutput(
      {
        state: "ok",
        message: null,
        machines: [{
          machineKey: "lan-only",
          deviceId: "device-lan",
          name: "LAN only",
          platform: "macOS",
          deviceType: "desktop",
          reachableEndpoints: [{ kind: "lan", host: "192.168.1.8", port: 8787 }],
          lastSeenAt: 1,
          online: true,
        }],
      },
      { ...baseResolveOpts(), projectRoot: null, workspaceRoot: null, text: true },
      "account-machines",
    )).toContain("unreachable");
    const rawActionPlan = expectExecutePlan(buildCliPlan(["actions", "run", "account.status"]));
    expect(rawActionPlan.steps[0]).toMatchObject({
      method: "account.call",
      params: { action: "status", args: {} },
    });
    expect(rawActionPlan.connectRole).toBeUndefined();

    const connection = {
      mode: "runtime-socket" as const,
      projectRoot: "/unused",
      workspaceRoot: "/unused",
      socketPath: "/tmp/ade.sock",
      request: async () => null,
      close: () => {},
    };
    const summarized = summarizeExecution({
      plan: statusPlan,
      connection,
      values: {
        result: {
          domain: "account",
          action: "status",
          result: {
            signedIn: false,
            userId: null,
            email: null,
            name: null,
            expiresAt: null,
          },
          statusHints: {},
        },
      },
    });
    expect(formatOutput(summarized, {
      ...baseResolveOpts(),
      projectRoot: null,
      workspaceRoot: null,
      text: true,
    }, inferFormatter(statusPlan))).toBe(
      "Not signed in — local use does not require an account.\n",
    );
  });

  it("auto-detects env-token, headless, SSH, browser-open failure, and browser-capable login modes", () => {
    expect(detectAccountLoginMode({
      env: { ADE_ACCOUNT_TOKEN: "secret" } as NodeJS.ProcessEnv,
      platform: "linux",
    })).toBe("env-token");
    expect(detectAccountLoginMode({
      explicitHeadless: true,
      env: { ADE_ACCOUNT_TOKEN: "inherited", DISPLAY: ":0" } as NodeJS.ProcessEnv,
      platform: "linux",
    })).toBe("device");
    expect(detectAccountLoginMode({
      explicitHeadless: true,
      env: { DISPLAY: ":0" } as NodeJS.ProcessEnv,
      platform: "linux",
    })).toBe("device");
    expect(detectAccountLoginMode({
      env: { SSH_CONNECTION: "host details", DISPLAY: ":0" } as NodeJS.ProcessEnv,
      platform: "linux",
    })).toBe("device");
    expect(detectAccountLoginMode({ env: {} as NodeJS.ProcessEnv, platform: "linux" }))
      .toBe("device");
    expect(detectAccountLoginMode({
      browserOpenFailed: true,
      env: { DISPLAY: ":0" } as NodeJS.ProcessEnv,
      platform: "linux",
    })).toBe("device");
    expect(detectAccountLoginMode({
      env: { DISPLAY: ":0" } as NodeJS.ProcessEnv,
      platform: "linux",
    })).toBe("loopback");
    expect(detectAccountLoginMode({ env: {} as NodeJS.ProcessEnv, platform: "darwin" }))
      .toBe("loopback");
  });

  it("formats account auth sources and durable-token provisioning guidance", () => {
    expect(formatOutput({
      signedIn: true,
      email: "person@example.com",
      source: "device",
    }, { text: true } as any, "account-auth")).toBe("Signed in as person@example.com (device)\n");
    const tokenOutput = formatOutput({
      token: "refresh-token-once",
      source: "refresh_token",
    }, { text: true } as any, "account-token");
    expect(tokenOutput.match(/refresh-token-once/g)).toHaveLength(1);
    expect(tokenOutput).toContain("ADE_ACCOUNT_TOKEN");
    expect(tokenOutput).toContain("secret manager");
  });

  it("parses global options without stealing command flags", () => {
    const parsed = parseCliArgs([
      "--project-root",
      "/tmp/project",
      "--role",
      "cto",
      "actions",
      "run",
      "git.stageFile",
      "--arg",
      "laneId=lane-1",
    ]);

    expect(parsed.options.projectRoot).toBe("/tmp/project");
    expect(parsed.options.role).toBe("cto");
    expect(parsed.command).toEqual([
      "actions",
      "run",
      "git.stageFile",
      "--arg",
      "laneId=lane-1",
    ]);
  });

  it("defaults ordinary CLI calls to the agent runtime role", () => {
    const previousRole = process.env.ADE_DEFAULT_ROLE;
    delete process.env.ADE_DEFAULT_ROLE;
    try {
      const parsed = parseCliArgs(["lanes", "list"]);
      expect(parsed.options.role).toBe("agent");
    } finally {
      if (previousRole === undefined) delete process.env.ADE_DEFAULT_ROLE;
      else process.env.ADE_DEFAULT_ROLE = previousRole;
    }
  });

  it("parses socket mode with an optional socket path override", () => {
    const spaced = parseCliArgs([
      "--socket",
      "/tmp/ade-runtime.sock",
      "--project-root",
      "/tmp/project",
      "linear",
      "graphql",
      "--query",
      "query { viewer { id } }",
    ]);
    expect(spaced.options.requireSocket).toBe(true);
    expect(spaced.options.headless).toBe(false);
    expect(spaced.options.socketPath).toBe("/tmp/ade-runtime.sock");
    expect(spaced.command.slice(0, 2)).toEqual(["linear", "graphql"]);

    const joined = parseCliArgs([
      "--socket=tcp://127.0.0.1:8787",
      "linear",
      "issue",
      "ADE-69",
    ]);
    expect(joined.options.requireSocket).toBe(true);
    expect(joined.options.socketPath).toBe("tcp://127.0.0.1:8787");
    expect(joined.command).toEqual(["linear", "issue", "ADE-69"]);

    const flagOnly = parseCliArgs(["--socket", "linear", "issue", "ADE-69"]);
    expect(flagOnly.options.requireSocket).toBe(true);
    expect(flagOnly.options.socketPath).toBeNull();
    expect(flagOnly.command).toEqual(["linear", "issue", "ADE-69"]);
  });

  it("maps ade code to the terminal Work chat launcher", () => {
    const parsed = parseCliArgs([
      "--project-root",
      "/tmp/project",
      "code",
      "--print-state",
    ]);
    expect(parsed.options.projectRoot).toBe("/tmp/project");
    expect(parsed.command).toEqual(["code", "--print-state"]);

    const plan = buildCliPlan(parsed.command);
    expect(plan).toEqual({ kind: "ade-code", rest: ["--print-state"] });
  });

  it("keeps general ADE Code help local and delegates remote help to its command", () => {
    const general = buildCliPlan(["code", "--help"]);
    expect(general.kind).toBe("help");
    if (general.kind !== "help") return;
    expect(general.text).toContain("ade code --socket /tmp/ade.sock");
    expect(general.text).toContain("ade code --require-socket");
    expect(general.text).toContain("ade code --lane <id|name|branch>");
    expect(general.text).toContain("Command palette");

    expect(buildCliPlan(["code", "remote", "--help"])).toEqual({
      kind: "ade-code",
      rest: ["remote", "--help"],
    });
    expect(buildCliPlan(["code", "remote", "--target", "studio"])).toEqual({
      kind: "ade-code",
      rest: ["remote", "--target", "studio"],
    });
  });

  it("shows help for bare ade invocations", () => {
    expect(buildCliPlan([])).toEqual({
      kind: "help",
      text: expect.stringContaining(
        "Agent-focused command-line interface for ADE",
      ),
    });
  });

  it("keeps global help on the help surface", () => {
    const plan = buildCliPlan(["--help"]);
    expect(plan.kind).toBe("help");
  });

  it("hides internal Automations commands when disabled", () => {
    withEnv(
      {
        ADE_DISABLE_AUTOMATIONS: "1",
        ADE_ENABLE_AUTOMATIONS: undefined,
      },
      () => {
        const plan = buildCliPlan(["--help"]);
        expect(plan.kind).toBe("help");
        if (plan.kind !== "help") return;
        expect(plan.text).not.toContain("ade automations");
      },
    );
  });

  it("reports internal feature availability instead of planning production-only commands", () => {
    withEnv(
      {
        ADE_DISABLE_AUTOMATIONS: "1",
        ADE_ENABLE_AUTOMATIONS: undefined,
      },
      () => {
        expect(() => buildCliPlan(["automations", "list"])).toThrow(/disabled on this build/);

        const automationHelp = buildCliPlan(["help", "automations"]);
        expect(automationHelp.kind).toBe("help");
        if (automationHelp.kind === "help") {
          expect(automationHelp.text).toContain("ADE_ENABLE_AUTOMATIONS=1");
        }
      },
    );
  });

  it("keeps global version on the version surface", () => {
    const version = buildCliPlan(["--version"]);
    expect(version.kind).toBe("help");
    if (version.kind !== "help") return;
    expect(version.text).toMatch(/^ade \S+\n$/);
    expect(buildCliPlan(["-v"])).toEqual(version);
  });

  it("builds brain, runtime, and stdio RPC commands", () => {
    expect(buildCliPlan(["brain", "status"])).toEqual({
      kind: "brain",
      rest: ["status"],
    });
    expect(buildCliPlan(["brain", "restart"])).toEqual({
      kind: "brain",
      rest: ["restart"],
    });
    expect(buildCliPlan(["brain", "--socket", "/tmp/ade.sock", "status"])).toEqual({
      kind: "brain",
      rest: ["--socket", "/tmp/ade.sock", "status"],
    });
    expect(buildCliPlan(["brain", "pin", "generate"])).toEqual({
      kind: "execute",
      label: "sync pin generate",
      steps: [{ key: "result", method: "sync.generatePin" }],
    });
    expect(buildCliPlan(["brain", "pin", "set", "123456"])).toEqual({
      kind: "execute",
      label: "sync pin set",
      steps: [
        { key: "result", method: "sync.setPin", params: { pin: "123456" } },
      ],
    });
    expect(buildCliPlan(["brain", "pin", "clear"])).toEqual({
      kind: "execute",
      label: "sync pin clear",
      steps: [{ key: "result", method: "sync.clearPin" }],
    });
    expect(buildCliPlan(["runtime", "status"])).toEqual({
      kind: "runtime",
      rest: ["status"],
    });
    expect(() => buildCliPlan(["runtime", "run"])).toThrow(
      "ade runtime run requires --socket <path>.",
    );
    expect(
      buildCliPlan(["runtime", "run", "--socket", "/tmp/ade.sock"]),
    ).toEqual({
      kind: "serve",
      rest: ["--socket", "/tmp/ade.sock", "--no-sync"],
    });
    expect(
      buildCliPlan(["runtime", "--socket", "/tmp/ade.sock", "run", "--no-sync"]),
    ).toEqual({
      kind: "serve",
      rest: ["--socket", "/tmp/ade.sock", "--no-sync"],
    });
    const parsedRuntimeRun = parseCliArgs([
      "--socket",
      "/tmp/global.sock",
      "runtime",
      "run",
    ]);
    expect(buildCliPlan(parsedRuntimeRun.command, parsedRuntimeRun.options)).toEqual({
      kind: "serve",
      rest: ["--socket", "/tmp/global.sock", "--no-sync"],
    });
    expect(
      buildCliPlan(["runtime", "start", "--socket", "/tmp/ade.sock"]),
    ).toEqual({
      kind: "runtime",
      rest: ["start", "--socket", "/tmp/ade.sock"],
    });
    expect(buildCliPlan(["desktop"])).toEqual({
      kind: "desktop",
      rest: [],
    });
    expect(
      buildCliPlan(["serve", "--socket", "/tmp/ade.sock", "--port", "7777"]),
    ).toEqual({
      kind: "serve",
      rest: ["--socket", "/tmp/ade.sock", "--port", "7777"],
    });
    expect(buildCliPlan(["serve", "--service-status"])).toEqual({
      kind: "serve",
      rest: ["--service-status"],
    });
    expect(buildCliPlan(["rpc", "--stdio"])).toEqual({
      kind: "rpc-stdio",
      rest: [],
    });
    expect(buildCliPlan(["rpc", "stdio", "--trace"])).toEqual({
      kind: "rpc-stdio",
      rest: ["--trace"],
    });
  });

  crdtHostIt("serve fails instead of exiting successfully when another channel owns mobile sync", async () => {
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-serve-conflict-"));
    const projectRoot = path.join(adeHome, "project");
    const lockPath = path.join(adeHome, "sync-host-lock.json");
    const socketPath = path.join(adeHome, "sock", "ade.sock");
    fs.mkdirSync(projectRoot, { recursive: true });
    const originalEnv = {
      ADE_HOME: process.env.ADE_HOME,
      ADE_PROJECT_ROOT: process.env.ADE_PROJECT_ROOT,
      ADE_PACKAGE_CHANNEL: process.env.ADE_PACKAGE_CHANNEL,
      ADE_SYNC_HOST_LOCK_PATH: process.env.ADE_SYNC_HOST_LOCK_PATH,
      ADE_SYNC_HOST_SINGLETON_TEST_MODE: process.env.ADE_SYNC_HOST_SINGLETON_TEST_MODE,
    };
    const ownerProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      stdio: "ignore",
    });
    ownerProcess.on("error", () => {});
    ownerProcess.unref();
    if (!ownerProcess.pid) {
      throw new Error("Failed to start fake sync-host owner process.");
    }

    try {
      process.env.ADE_HOME = adeHome;
      process.env.ADE_PROJECT_ROOT = projectRoot;
      delete process.env.ADE_PACKAGE_CHANNEL;
      process.env.ADE_SYNC_HOST_LOCK_PATH = lockPath;
      process.env.ADE_SYNC_HOST_SINGLETON_TEST_MODE = "1";
      writeSyncHostSingletonLock({
        lockPath,
        pid: ownerProcess.pid,
        port: 8801,
        packageChannel: "beta",
        adeHome: path.join(os.homedir(), ".ade-beta"),
      });

      await expect(runCli(["serve", "--socket", socketPath])).rejects.toThrow(
        "ADE brain refusing to run without mobile sync.",
      );
      expect(fs.existsSync(socketPath)).toBe(false);
    } finally {
      if (originalEnv.ADE_HOME === undefined) delete process.env.ADE_HOME;
      else process.env.ADE_HOME = originalEnv.ADE_HOME;
      if (originalEnv.ADE_PROJECT_ROOT === undefined) delete process.env.ADE_PROJECT_ROOT;
      else process.env.ADE_PROJECT_ROOT = originalEnv.ADE_PROJECT_ROOT;
      if (originalEnv.ADE_PACKAGE_CHANNEL === undefined) delete process.env.ADE_PACKAGE_CHANNEL;
      else process.env.ADE_PACKAGE_CHANNEL = originalEnv.ADE_PACKAGE_CHANNEL;
      if (originalEnv.ADE_SYNC_HOST_LOCK_PATH === undefined) delete process.env.ADE_SYNC_HOST_LOCK_PATH;
      else process.env.ADE_SYNC_HOST_LOCK_PATH = originalEnv.ADE_SYNC_HOST_LOCK_PATH;
      if (originalEnv.ADE_SYNC_HOST_SINGLETON_TEST_MODE === undefined) delete process.env.ADE_SYNC_HOST_SINGLETON_TEST_MODE;
      else process.env.ADE_SYNC_HOST_SINGLETON_TEST_MODE = originalEnv.ADE_SYNC_HOST_SINGLETON_TEST_MODE;
      ownerProcess.kill("SIGKILL");
      fs.rmSync(adeHome, { recursive: true, force: true });
    }
  });

  const posixIt = process.platform === "win32" ? it.skip : it;
  posixIt(
    "creates the headless RPC unix socket with 0600 perms and parent dir 0700",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-headless-sock-"));
      const socketPath = path.join(root, "sock", "ade.sock");
      const stop = await startHeadlessRpcSocketServer({
        socketPath,
        createHandler: () => (async () => ({})) as never,
      });
      try {
        expect(stop).not.toBeNull();
        const dirMode = fs.statSync(path.dirname(socketPath)).mode & 0o777;
        const sockMode = fs.statSync(socketPath).mode & 0o777;
        expect(dirMode).toBe(0o700);
        expect(sockMode).toBe(0o600);
      } finally {
        stop?.();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("returns null for a named-pipe socket path (desktop path; no dir/chmod)", async () => {
    // isAdeRuntimeNamedPipePath matches by string prefix, so this exercises the
    // named-pipe early-return branch on any platform without touching the fs.
    const stop = await startHeadlessRpcSocketServer({
      socketPath: "//./pipe/ade-headless-named-pipe-test",
      createHandler: () => (async () => ({})) as never,
    });
    expect(stop).toBeNull();
  });

  it("recognizes the hidden PTY host worker entrypoint", () => {
    expect(buildCliPlan(["__ade-pty-host-worker"])).toEqual({
      kind: "pty-host-worker",
    });
  });

  it("classifies only ADE temp runtime sockets as ephemeral", () => {
    const tempSocket = path.join(os.tmpdir(), "ade-stdio-rpc-test", "sock", "ade.sock");

    expect(isEphemeralRuntimeSocketPath(tempSocket)).toBe(true);
    expect(isEphemeralRuntimeSocketPath(path.join(os.tmpdir(), "other-app", "ade.sock"))).toBe(false);
    expect(isEphemeralRuntimeSocketPath(path.join(os.homedir(), ".ade", "sock", "ade.sock"))).toBe(false);
    expect(isEphemeralRuntimeSocketPath("tcp://127.0.0.1:8765")).toBe(false);
  });

  it("blocks manual service-socket runtime spawn when service mutation is disabled", () => {
    expect(shouldBlockManualMachineRuntimeSpawn("/Users/example/.ade-beta/sock/ade.sock", {
      ADE_DISABLE_RUNTIME_SERVICE_INSTALL: "1",
    })).toBe(true);
    expect(shouldBlockManualMachineRuntimeSpawn("/Users/example/.ade-beta/sock/ade.sock", {})).toBe(false);
    expect(shouldBlockManualMachineRuntimeSpawn("tcp://127.0.0.1:9999", {
      ADE_DISABLE_RUNTIME_SERVICE_INSTALL: "1",
    })).toBe(false);
    expect(shouldBlockManualMachineRuntimeSpawn(path.join(os.tmpdir(), "ade-code-test", "ade.sock"), {
      ADE_DISABLE_RUNTIME_SERVICE_INSTALL: "1",
    })).toBe(false);
  });

  it("parses runtime idle expiry with a minimum clamp", () => {
    expect(readRuntimeIdleExitMs({ ADE_RUNTIME_IDLE_EXIT_MS: "30000" } as NodeJS.ProcessEnv)).toBe(30_000);
    expect(readRuntimeIdleExitMs({ ADE_RUNTIME_IDLE_EXIT_MS: "100" } as NodeJS.ProcessEnv)).toBe(5_000);
    expect(readRuntimeIdleExitMs({ ADE_RUNTIME_IDLE_EXIT_MS: "nope" } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("allows explicit runtime socket overrides across build hashes", () => {
    const currentVersion = process.env.ADE_CLI_VERSION?.trim() || "0.0.0";
    const runtimeInfo = {
      version: currentVersion,
      buildHash: "other-build",
      defaultRole: "agent",
      packageChannel: null,
      projectRoot: null,
      pid: 123,
    };

    expect(
      machineRuntimeMismatchReason(runtimeInfo, "expected-build", "agent"),
    ).toBe("build hash changed");
    expect(
      machineRuntimeMismatchReason(runtimeInfo, "expected-build", "agent", {
        enforceBuildCompatibility: false,
      }),
    ).toBeNull();
  });

  it("only disables machine runtime build checks for explicit socket overrides", () => {
    expect(
      shouldEnforceMachineRuntimeBuildCompatibility(null),
    ).toBe(true);
    expect(
      shouldEnforceMachineRuntimeBuildCompatibility("/tmp/ade.sock"),
    ).toBe(false);
  });

  it("marks failed service manager results as CLI failures", () => {
    expect(
      isFailedServiceManagerResult({
        ok: false,
        serviceName: "com.ade.runtime",
        action: "install",
        path: "/tmp/com.ade.runtime.plist",
        message: "launchctl failed",
      }),
    ).toBe(true);
    expect(
      isFailedServiceManagerResult({
        ok: true,
        serviceName: "com.ade.runtime",
        action: "install",
        path: "/tmp/com.ade.runtime.plist",
        message: "installed",
      }),
    ).toBe(false);
  });

  it("builds project init command", () => {
    expect(buildCliPlan(["init", "/tmp/project"])).toEqual({
      kind: "init",
      targetPath: "/tmp/project",
    });
    expect(buildCliPlan(["init"])).toEqual({
      kind: "init",
      targetPath: null,
    });
  });

  it("builds machine project registry commands", () => {
    expect(buildCliPlan(["projects", "list"])).toEqual({
      kind: "execute",
      label: "projects list",
      formatter: "projects-list",
      steps: [{ key: "result", method: "projects.list" }],
    });
    expect(buildCliPlan(["project", "add", "/tmp/project"])).toEqual({
      kind: "execute",
      label: "projects add",
      formatter: "projects-list",
      steps: [
        {
          key: "result",
          method: "projects.add",
          params: { rootPath: "/tmp/project" },
        },
      ],
    });
    expect(buildCliPlan(["projects", "remove", "project_abc"])).toEqual({
      kind: "execute",
      label: "projects remove",
      steps: [
        {
          key: "result",
          method: "projects.remove",
          params: { projectId: "project_abc" },
        },
      ],
    });
    expect(
      buildCliPlan(["projects", "touch", "--project-id", "project_abc"]),
    ).toEqual({
      kind: "execute",
      label: "projects touch",
      formatter: "projects-list",
      steps: [
        {
          key: "result",
          method: "projects.touch",
          params: { projectId: "project_abc" },
        },
      ],
    });
    expect(buildCliPlan(["projects", "inspect", "/tmp/worktree"])).toEqual({
      kind: "execute",
      label: "projects inspect",
      steps: [
        {
          key: "result",
          method: "projects.inspectPath",
          params: { path: "/tmp/worktree" },
        },
      ],
    });
  });

  it("does not auto-register cwd for machine-scoped registry commands", () => {
    const projects = buildCliPlan(["projects", "list"]);
    expect(projects.kind).toBe("execute");
    if (projects.kind !== "execute") return;
    expect(shouldAutoRegisterProjectForPlan(projects)).toBe(false);

    const lanes = buildCliPlan(["lanes", "list"]);
    expect(lanes.kind).toBe("execute");
    if (lanes.kind !== "execute") return;
    expect(shouldAutoRegisterProjectForPlan(lanes)).toBe(true);
  });

  it("builds sync status and pairing PIN commands", () => {
    const status = buildCliPlan([
      "sync",
      "status",
      "--include-transfer-readiness",
    ]);
    expect(status.kind).toBe("execute");
    if (status.kind !== "execute") return;
    expect(status.steps).toEqual([
      {
        key: "result",
        method: "sync.getStatus",
        params: {
          includeTransferReadiness: true,
          forceTransferReadiness: false,
        },
      },
    ]);

    const web = buildCliPlan(["sync", "web"]);
    expect(web.kind).toBe("execute");
    if (web.kind !== "execute") return;
    expect(web.label).toBe("sync web");
    expect(web.formatter).toBe("sync-web");
    expect(web.syncWebOpen).toBe(false);
    expect(web.syncWebNoClipboard).toBe(false);
    expect(web.steps).toEqual([
      {
        key: "result",
        method: "sync.getStatus",
      },
    ]);

    for (const alias of ["web-pair", "webclient"]) {
      const aliasPlan = expectExecutePlan(buildCliPlan(["sync", alias]));
      expect(aliasPlan.label).toBe("sync web");
      expect(aliasPlan.steps[0]?.method).toBe("sync.getStatus");
    }

    const webWithFlags = expectExecutePlan(
      buildCliPlan(["sync", "web", "--open", "--no-clipboard"]),
    );
    expect(webWithFlags.syncWebOpen).toBe(true);
    expect(webWithFlags.syncWebNoClipboard).toBe(true);

    const setPin = buildCliPlan(["sync", "pin", "set", "123456"]);
    expect(setPin.kind).toBe("execute");
    if (setPin.kind !== "execute") return;
    expect(setPin.steps).toEqual([
      {
        key: "result",
        method: "sync.setPin",
        params: { pin: "123456" },
      },
    ]);

    const generatePin = buildCliPlan(["sync", "pin", "generate"]);
    expect(generatePin.kind).toBe("execute");
    if (generatePin.kind !== "execute") return;
    expect(generatePin.steps).toEqual([
      {
        key: "result",
        method: "sync.generatePin",
      },
    ]);
  });

  it("reads SSH pairing requests only from stdin and allows socketless machine recovery", () => {
    const request = JSON.stringify({
      version: 1,
      device: {
        id: "ios-device-1",
        name: "Arul's iPhone",
        platform: "iOS",
        type: "phone",
        dpopPublicKey: "public-key",
      },
    });
    const bytes = Buffer.from(request);
    let offset = 0;
    const readSpy = vi.spyOn(fs, "readSync").mockImplementation((
      _fd: number,
      buffer: NodeJS.ArrayBufferView,
      ...args: unknown[]
    ) => {
      const bufferOffset = typeof args[0] === "number" ? args[0] : 0;
      const length = typeof args[1] === "number" ? args[1] : buffer.byteLength;
      const count = Math.min(length, bytes.length - offset);
      if (count <= 0) return 0;
      const destination = Buffer.from(
        buffer.buffer as ArrayBuffer,
        buffer.byteOffset,
        buffer.byteLength,
      );
      bytes.copy(destination, bufferOffset, offset, offset + count);
      offset += count;
      return count;
    });
    try {
      const plan = expectExecutePlan(buildCliPlan([
        "sync",
        "pair-device",
        "--json-stdin",
      ]));
      expect(plan).toMatchObject({
        label: "sync pair-device",
        machineOnly: true,
        machineAutoStart: true,
        steps: [{
          key: "result",
          method: "sync.authorizeSshPairing",
          params: JSON.parse(request),
        }],
      });
    } finally {
      readSpy.mockRestore();
    }

    expect(() => buildCliPlan([
      "sync",
      "pair-device",
      "--device-secret",
      "must-not-be-an-argument",
    ])).toThrow(/requires --json-stdin/);

    const unexpectedArgReadSpy = vi.spyOn(fs, "readSync");
    try {
      expect(() => buildCliPlan([
        "sync",
        "pair-device",
        "--json-stdin",
        "--device-secret",
        "must-not-be-an-argument",
      ])).toThrow(/accepts only --json-stdin/);
      expect(unexpectedArgReadSpy).not.toHaveBeenCalled();
    } finally {
      unexpectedArgReadSpy.mockRestore();
    }
  });

  it("formats sync web pairing info from sync status", () => {
    const plan = expectExecutePlan(buildCliPlan(["sync", "web"]));
    const connection = {
      mode: "runtime-socket" as const,
      projectRoot: "/tmp/project",
      workspaceRoot: "/tmp/project",
      socketPath: "/tmp/ade.sock",
      request: async () => null,
      close: () => {},
    };
    const result = summarizeExecution({
      plan,
      connection,
      values: {
        result: {
          pairingPin: "123456",
          pairingPinConfigured: true,
          localDevice: { name: "Fallback Machine" },
          pairingConnectInfo: {
            hostIdentity: {
              deviceId: "device-1",
              siteId: "site-1",
              name: "Arul's Mac Studio",
              platform: "macOS",
              deviceType: "desktop",
            },
            port: 8787,
            addressCandidates: [{ host: "10.0.0.2", kind: "lan" }],
          },
        },
      },
    });

    expect(result).toMatchObject({
      pairingUrl: expect.stringContaining("https://app.ade-app.dev/pair#"),
      code: "123456",
      pinConfigured: true,
      machineName: "Arul's Mac Studio",
      relayEnabled: false,
    });
    expect(formatOutput(result, { text: true } as any, inferFormatter(plan)))
      .toContain("  Code   123456");
  });

  it("formats sync web pairing info when the configured PIN is hidden", () => {
    const plan = expectExecutePlan(buildCliPlan(["sync", "web"]));
    const connection = {
      mode: "runtime-socket" as const,
      projectRoot: "/tmp/project",
      workspaceRoot: "/tmp/project",
      socketPath: "/tmp/ade.sock",
      request: async () => null,
      close: () => {},
    };
    const result = summarizeExecution({
      plan,
      connection,
      values: {
        result: {
          pairingPin: null,
          pairingPinConfigured: true,
          localDevice: { name: "Fallback Machine" },
          pairingConnectInfo: {
            hostIdentity: {
              deviceId: "device-1",
              siteId: "site-1",
              name: "Arul's Mac Studio",
              platform: "macOS",
              deviceType: "desktop",
            },
            port: 8787,
            addressCandidates: [{ host: "10.0.0.2", kind: "lan" }],
          },
        },
      },
    });

    expect(result).toMatchObject({
      code: null,
      pinConfigured: true,
    });
    const output = formatOutput(result, { text: true } as any, inferFormatter(plan));
    expect(output).toContain("  Code   (PIN configured but hidden after runtime restart)");
    expect(output).toContain("  Known  Use the existing code if you already know it.");
    expect(output).toContain("  New    ade sync pin generate");
    expect(output).toContain("  Set    ade sync pin set <6-digit-code>");
    expect(output).toContain(
      "Open the link and enter the existing code if you know it. " +
        "Generate or set a new code only if you need ADE to display or copy one.",
    );
    expect(output).not.toContain("no PIN set");
  });

  it("applies sync web clipboard and open flags only when a link exists", () => {
    const options = {
      ...baseResolveOpts(),
      projectRoot: null,
      workspaceRoot: null,
      text: true,
    };
    const plan = expectExecutePlan(buildCliPlan(["sync", "web", "--open"]));
    const pairing = {
      pairingUrl: "https://app.ade-app.dev/pair#payload",
      code: "123456",
      pinConfigured: true,
      machineName: "Arul's Mac Studio",
      relayEnabled: false,
    };
    const calls: string[] = [];

    const effects = applySyncWebPairingFlags(plan, options, pairing, {
      copy: (url) => {
        calls.push(`copy:${url}`);
        return true;
      },
      open: (url) => {
        calls.push(`open:${url}`);
        return { failed: false, message: "" };
      },
    });

    expect(effects).toEqual({
      outputSuffix: "\n(copied to clipboard)",
      exitCode: null,
    });
    expect(calls).toEqual([
      "copy:https://app.ade-app.dev/pair#payload",
      "open:https://app.ade-app.dev/pair#payload",
    ]);

    const noLinkEffects = applySyncWebPairingFlags(
      plan,
      options,
      { ...pairing, pairingUrl: null },
      {
        copy: () => {
          throw new Error("should not copy");
        },
        open: () => {
          throw new Error("should not open");
        },
      },
    );
    expect(noLinkEffects).toEqual({ outputSuffix: "", exitCode: null });
  });

  it("does not copy sync web pairing links for JSON output or --no-clipboard", () => {
    const pairing = {
      pairingUrl: "https://app.ade-app.dev/pair#payload",
      code: "123456",
      pinConfigured: true,
      machineName: "Arul's Mac Studio",
      relayEnabled: false,
    };
    const baseOptions = {
      ...baseResolveOpts(),
      projectRoot: null,
      workspaceRoot: null,
    };
    const jsonPlan = expectExecutePlan(buildCliPlan(["sync", "web"]));
    let copied = false;
    const jsonEffects = applySyncWebPairingFlags(
      jsonPlan,
      { ...baseOptions, text: false },
      pairing,
      {
        copy: () => {
          copied = true;
          return true;
        },
      },
    );
    expect(jsonEffects).toEqual({ outputSuffix: "", exitCode: null });
    expect(copied).toBe(false);

    const noClipboardPlan = expectExecutePlan(
      buildCliPlan(["sync", "web", "--no-clipboard"]),
    );
    const noClipboardEffects = applySyncWebPairingFlags(
      noClipboardPlan,
      { ...baseOptions, text: true },
      pairing,
      {
        copy: () => {
          copied = true;
          return true;
        },
      },
    );
    expect(noClipboardEffects).toEqual({ outputSuffix: "", exitCode: null });
  });

  it("prints a sync web no-address message cleanly", () => {
    const plan = expectExecutePlan(buildCliPlan(["sync", "web"]));
    const result = summarizeExecution({
      plan,
      connection: {
        mode: "runtime-socket" as const,
        projectRoot: "/tmp/project",
        workspaceRoot: "/tmp/project",
        socketPath: "/tmp/ade.sock",
        request: async () => null,
        close: () => {},
      },
      values: {
        result: {
          pairingPin: null,
          pairingPinConfigured: false,
          localDevice: { name: "Fallback Machine" },
          pairingConnectInfo: null,
        },
      },
    });

    expect(formatOutput(result, { text: true } as any, inferFormatter(plan)))
      .toBe("No machine addresses are published yet — is the sync host running? (ade sync status)\n");
  });

  it("builds sync cloud relay and security commands", () => {
    expect(expectExecutePlan(buildCliPlan(["sync", "relay"])).steps).toEqual([
      { key: "result", method: "sync.getCloudRelayStatus" },
    ]);
    expect(
      expectExecutePlan(buildCliPlan(["sync", "relay", "enable"])).steps,
    ).toEqual([
      {
        key: "result",
        method: "sync.setCloudRelayEnabled",
        params: { enabled: true },
      },
    ]);
    expect(
      expectExecutePlan(buildCliPlan(["sync", "relay", "disable"])).steps,
    ).toEqual([
      {
        key: "result",
        method: "sync.setCloudRelayEnabled",
        params: { enabled: false },
      },
    ]);

    expect(expectExecutePlan(buildCliPlan(["sync", "security"])).steps).toEqual([
      { key: "result", method: "sync.getRequireDpop" },
    ]);
    expect(
      expectExecutePlan(
        buildCliPlan(["sync", "security", "require-dpop", "on"]),
      ).steps,
    ).toEqual([
      {
        key: "result",
        method: "sync.setRequireDpop",
        params: { requireDpop: true },
      },
    ]);
    expect(
      expectExecutePlan(
        buildCliPlan(["sync", "security", "require-dpop", "off"]),
      ).steps,
    ).toEqual([
      {
        key: "result",
        method: "sync.setRequireDpop",
        params: { requireDpop: false },
      },
    ]);
    expect(() =>
      buildCliPlan(["sync", "security", "require-dpop", "maybe"]),
    ).toThrow(/on or off/);
  });

  it("forwards resolved roots and socket intent to ade code", () => {
    const previousRuntimeSocket = process.env.ADE_RUNTIME_SOCKET_PATH;
    const previousRpcSocket = process.env.ADE_RPC_SOCKET_PATH;
    const previousRpcUrl = process.env.ADE_RPC_URL;
    const previousWorkspace = process.env.ADE_WORKSPACE_ROOT;
    delete process.env.ADE_RPC_SOCKET_PATH;
    delete process.env.ADE_RPC_URL;
    delete process.env.ADE_WORKSPACE_ROOT;
    process.env.ADE_RUNTIME_SOCKET_PATH = "/tmp/ade-runtime.sock";
    try {
      const args = buildAdeCodeArgs(["--print-state"], {
        ...baseResolveOpts(),
        projectRoot: "/tmp/project",
        workspaceRoot: null,
        headless: false,
        requireSocket: true,
      });

      expect(args).toEqual([
        "--project-root",
        "/tmp/project",
        "--workspace-root",
        "/tmp/project",
        "--socket",
        "/tmp/ade-runtime.sock",
        "--require-socket",
        "--print-state",
      ]);
    } finally {
      if (previousRuntimeSocket === undefined)
        delete process.env.ADE_RUNTIME_SOCKET_PATH;
      else process.env.ADE_RUNTIME_SOCKET_PATH = previousRuntimeSocket;
      if (previousRpcSocket === undefined)
        delete process.env.ADE_RPC_SOCKET_PATH;
      else process.env.ADE_RPC_SOCKET_PATH = previousRpcSocket;
      if (previousRpcUrl === undefined) delete process.env.ADE_RPC_URL;
      else process.env.ADE_RPC_URL = previousRpcUrl;
      if (previousWorkspace === undefined)
        delete process.env.ADE_WORKSPACE_ROOT;
      else process.env.ADE_WORKSPACE_ROOT = previousWorkspace;
    }
  });

  it("resolves ade code from packaged runtime resources", () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-runtime-"));
    const modulePath = path.join(runtimeRoot, "tuiClient", "cli.mjs");
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(modulePath, "export async function runAdeCodeCli() { return 0; }\n");
    try {
      withEnv(
        {
          ADE_RUNTIME_ROOT: runtimeRoot,
          ADE_RESOLVED_RUNTIME_ROOT: undefined,
        },
        () => {
          expect(resolveAdeCodeModulePath()).toBe(modulePath);
        },
      );
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("preserves command-local value flags that overlap global flags", () => {
    const parsed = parseCliArgs([
      "files",
      "write",
      "src/index.ts",
      "--text",
      "hello",
    ]);
    expect(parsed.options.text).toBe(false);
    expect(parsed.command).toEqual([
      "files",
      "write",
      "src/index.ts",
      "--text",
      "hello",
    ]);

    const plan = buildCliPlan(parsed.command);
    const executePlan = expectExecutePlan(plan);

    expect(executePlan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "file",
        action: "writeWorkspaceText",
        args: {
          path: "src/index.ts",
          text: "hello",
        },
      },
    });

    const typed = parseCliArgs([
      "ios-sim",
      "type",
      "--value",
      "hello",
      "--text",
    ]);
    expect(typed.options.text).toBe(true);
    expect(typed.command).toEqual(["ios-sim", "type", "--value", "hello"]);
  });

  it("builds a generic ADE action invocation", () => {
    const plan = buildCliPlan([
      "actions",
      "run",
      "git.stageFile",
      "--arg",
      "laneId=lane-1",
      "--arg",
      "path=src/index.ts",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;

    expect(plan.steps).toEqual([
      {
        key: "result",
        method: "ade/actions/call",
        params: {
          name: "run_ade_action",
          arguments: {
            domain: "git",
            action: "stageFile",
            args: {
              laneId: "lane-1",
              path: "src/index.ts",
            },
          },
        },
        unwrapToolResult: true,
      },
    ]);
  });

  it("builds typed storage commands and renders the snapshot as text", () => {
    const snapshotPlan = expectExecutePlan(buildCliPlan(["storage", "snapshot"]));
    expect(inferFormatter(snapshotPlan)).toBe("storage-snapshot");
    expect(snapshotPlan.steps).toEqual([
      {
        key: "result",
        method: "ade/actions/call",
        params: {
          name: "run_ade_action",
          arguments: { domain: "storage", action: "getSnapshot", args: {} },
        },
        unwrapToolResult: true,
      },
    ]);

    const refreshPlan = expectExecutePlan(
      buildCliPlan(["storage", "snapshot", "--refresh"]),
    );
    expect(refreshPlan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "storage",
        action: "getSnapshot",
        args: { forceRefresh: true },
      },
    });

    const compressPlan = expectExecutePlan(buildCliPlan(["storage", "compress"]));
    expect(inferFormatter(compressPlan)).toBe("storage-compress");
    expect(compressPlan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: { domain: "storage", action: "compressNow", args: {} },
    });

    expect(
      expectExecutePlan(buildCliPlan(["storage", "actions"])).steps[0]?.params,
    ).toEqual({ name: "list_ade_actions", arguments: { domain: "storage" } });

    expect(
      expectExecutePlan(buildCliPlan([
        "storage",
        "action",
        "cleanupPreview",
        "--input-json",
        '{"targets":["cache"]}',
      ]))
        .steps[0]?.params,
    ).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "storage",
        action: "cleanupPreview",
        args: { targets: ["cache"] },
      },
    });

    expect(() => buildCliPlan(["storage", "bogus"])).toThrow(/storage supports/);

    const snapshotText = formatOutput(
      {
        generatedAt: "2026-07-12T00:00:00.000Z",
        projectRoot: "/repo",
        volume: { freeBytes: 5 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 },
        totalAdeBytes: 2 * 1024 ** 3,
        categories: [
          {
            id: "chats_history",
            bytes: 1.5 * 1024 ** 3,
            fileCount: 12,
            safety: "compressible",
            compressibleBytes: 1024 ** 3,
          },
          { id: "caches", bytes: 512 * 1024 ** 2, fileCount: 3, safety: "safe_to_remove" },
        ],
        scanDurationMs: 5,
        truncated: false,
      },
      { text: true } as never,
      inferFormatter(snapshotPlan),
    );
    expect(snapshotText).toContain("ADE storage");
    expect(snapshotText).toContain("GB free of");
    expect(snapshotText).toContain("chats_history");
  });

  it("formats external session action results as text", () => {
    const plan = expectExecutePlan(buildCliPlan([
      "actions",
      "run",
      "external-sessions.list",
      "--arg",
      "limit=1",
    ]));

    const formatter = inferFormatter(plan);
    expect(formatter).toBe("external-sessions");

    const listText = formatOutput(
      [
        {
          provider: "codex",
          id: "thread-1",
          cwd: "/repo",
          title: "Investigate flaky test",
          alreadyImported: false,
          possiblyActive: true,
        },
      ],
      { ...baseResolveOpts(), projectRoot: null, workspaceRoot: null, text: true },
      formatter,
    );
    expect(listText).toContain("provider");
    expect(listText).toContain("codex");
    expect(listText).toContain("active");
    expect(listText).toContain("Investigate flaky test");

    const importText = formatOutput(
      { kind: "cli", sessionId: "terminal-1", ptyId: "pty-1", laneId: "lane-1" },
      { ...baseResolveOpts(), projectRoot: null, workspaceRoot: null, text: true },
      formatter,
    );
    expect(importText).toContain("ADE external session import");
    expect(importText).toContain("terminal-1");
    expect(importText).toContain("pty-1");
  });

  it("builds typed ADE secret commands", () => {
    const list = expectExecutePlan(buildCliPlan(["secrets", "list"]));
    expect(list.formatter).toBe("project-secrets");
    expect(list.steps).toEqual([
      {
        key: "result",
        method: "ade/actions/call",
        params: {
          name: "run_ade_action",
          arguments: {
            domain: "project_secret",
            action: "list",
            args: {},
          },
        },
        unwrapToolResult: true,
      },
    ]);

    const get = expectExecutePlan(buildCliPlan(["secret", "get", "STRIPE_API_KEY"]));
    expect(get.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "project_secret",
        action: "get",
        args: { name: "STRIPE_API_KEY" },
      },
    });

    const set = expectExecutePlan(buildCliPlan(["secrets", "set", "TOKEN", "--value", "abc123"]));
    expect(set.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "project_secret",
        action: "set",
        args: { name: "TOKEN", value: "abc123" },
      },
    });

    const remove = expectExecutePlan(buildCliPlan(["secrets", "rm", "TOKEN"]));
    expect(remove.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "project_secret",
        action: "delete",
        args: { name: "TOKEN", confirmName: "TOKEN" },
      },
    });
  });

  it("builds typed ADE search commands", () => {
    const query = expectExecutePlan(
      buildCliPlan([
        "search",
        "login redirect",
        "--kind",
        "chat,terminal",
        "--lane",
        "fix-login",
        "--limit",
        "5",
        "--cursor",
        "abc",
      ]),
    );
    expect(query.formatter).toBe("search-results");
    expect(query.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "search",
        action: "query",
        args: {
          query: "login redirect",
          kinds: ["chat", "terminal"],
          laneId: "fix-login",
          limit: 5,
          cursor: "abc",
        },
      },
    });
    // Query invocations exit nonzero when nothing matches, zero otherwise.
    expect(query.exitCodeFromResult?.({ results: [] })).toBe(1);
    expect(query.exitCodeFromResult?.({ results: [{ id: "chat:1" }] })).toBe(0);

    // Bare query omits optional args entirely.
    const bare = expectExecutePlan(buildCliPlan(["search", "just words"]));
    expect(bare.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "search",
        action: "query",
        args: { query: "just words" },
      },
    });

    // Unknown kinds are a usage error (exit 2), not a silent pass-through.
    expect(() => buildCliPlan(["search", "q", "--kind", "chat,bogus"])).toThrow(
      /Unknown search kind/,
    );

    // A missing query is a usage error, but --status / --rebuild are not queries.
    expect(() => buildCliPlan(["search"])).toThrow(/requires a query/);
    const status = expectExecutePlan(buildCliPlan(["search", "--status"]));
    expect(status.formatter).toBe("search-status");
    expect(status.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: { domain: "search", action: "indexStatus", args: {} },
    });
    const rebuild = expectExecutePlan(buildCliPlan(["search", "--rebuild"]));
    expect(rebuild.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: { domain: "search", action: "rebuildIndex", args: {} },
    });
  });

  it("builds PR transcript gist settings commands", () => {
    const enable = buildCliPlan(["settings", "pr-transcript-gists", "enable"]);
    expect(enable.kind).toBe("execute");
    if (enable.kind !== "execute") return;
    expect(enable.label).toBe("enable PR chat transcripts");
    expect(enable.steps).toEqual([
      {
        key: "result",
        method: "ade/actions/call",
        params: {
          name: "run_ade_action",
          arguments: {
            domain: "project_config",
            action: "setPrTranscriptGists",
            args: { enabled: true },
          },
        },
        unwrapToolResult: true,
      },
    ]);

    const disable = buildCliPlan(["config", "gist-transcripts", "off"]);
    expect(disable.kind).toBe("execute");
    if (disable.kind !== "execute") return;
    expect(disable.steps[0]).toEqual(expect.objectContaining({
      params: expect.objectContaining({
        arguments: expect.objectContaining({
          domain: "project_config",
          action: "setPrTranscriptGists",
          args: { enabled: false },
        }),
      }),
    }));

    const status = buildCliPlan(["settings", "transcript-gists", "status"]);
    expect(status.kind).toBe("execute");
    if (status.kind !== "execute") return;
    expect(status.steps[0]).toEqual(expect.objectContaining({
      params: expect.objectContaining({
        arguments: expect.objectContaining({
          domain: "project_config",
          action: "get",
        }),
      }),
    }));
  });

  it("builds a diff patch invocation with an explicit path flag", () => {
    const parsed = parseCliArgs([
      "diff",
      "patch",
      "--lane",
      "main",
      "--path",
      "file.txt",
      "--text",
    ]);
    expect(parsed.options.text).toBe(true);

    const plan = buildCliPlan(parsed.command);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;

    expect(plan).toEqual({
      kind: "execute",
      label: "diff patch",
      steps: [
        {
          key: "result",
          method: "ade/actions/call",
          params: {
            name: "run_ade_action",
            arguments: {
              domain: "diff",
              action: "getFilePatch",
              args: {
                filePath: "file.txt",
                mode: "unstaged",
                compareRef: null,
                compareTo: null,
                laneId: "main",
              },
            },
          },
          unwrapToolResult: true,
        },
      ],
    });
  });

  it("builds nested generic ADE action args", () => {
    const plan = buildCliPlan([
      "actions",
      "run",
      "git.status",
      "--arg",
      "filters.clean=false",
      "--arg-json",
      'metadata.tags=["review"]',
    ]);
    const executePlan = expectExecutePlan(plan);

    expect(executePlan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "git",
        action: "status",
        args: {
          filters: {
            clean: false,
          },
          metadata: {
            tags: ["review"],
          },
        },
      },
    });
  });

  it("builds documented generic ADE action JSON shapes", () => {
    const objectCall = buildCliPlan([
      "actions",
      "run",
      "git.push",
      "--input-json",
      '{"laneId":"lane-1","setUpstream":true}',
    ]);
    expect(objectCall.kind).toBe("execute");
    if (objectCall.kind !== "execute") return;
    expect(objectCall.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "git",
        action: "push",
        args: {
          laneId: "lane-1",
          setUpstream: true,
        },
      },
    });

    const argsListCall = buildCliPlan([
      "actions",
      "run",
      "pr.submitReview",
      "--args-list-json",
      '["pr-1",{"event":"APPROVE"}]',
    ]);
    expect(argsListCall.kind).toBe("execute");
    if (argsListCall.kind !== "execute") return;
    expect(argsListCall.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "pr",
        action: "submitReview",
        argsList: ["pr-1", { event: "APPROVE" }],
      },
    });

    const scalarCall = buildCliPlan([
      "actions",
      "run",
      "git.getConflictState",
      "--scalar",
      "lane-1",
    ]);
    expect(scalarCall.kind).toBe("execute");
    if (scalarCall.kind !== "execute") return;
    expect(scalarCall.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "git",
        action: "getConflictState",
        arg: "lane-1",
      },
    });
  });







  it("reads wait state from run graphs with a nested visual graph", () => {
    const waitState = graphWaitState({
      domain: "graph_state",
      action: "getRunGraph",
      result: {
        graph: {
          run: { id: "run-1", status: "succeeded" },
          steps: [{ id: "step-1", status: "succeeded" }],
          attempts: [{ id: "attempt-1", status: "completed" }],
          graph: { nodes: [], edges: [] },
        },
      },
    });

    expect(waitState).toEqual({ status: "succeeded", activeCount: 0 });
  });



  it("rejects invalid JSON action shapes before execution", () => {
    expect(() =>
      buildCliPlan(["actions", "run", "git.push", "--input-json", "[1,2]"]),
    ).toThrow(/--input-json must be a JSON object/);
    expect(() =>
      buildCliPlan([
        "actions",
        "run",
        "git.push",
        "--args-list-json",
        '{"laneId":"lane-1"}',
      ]),
    ).toThrow(/--args-list-json must be a JSON array/);
    expect(() =>
      buildCliPlan([
        "actions",
        "run",
        "account.pollDeviceLogin",
        "--args-list-json",
        '["device-session","unexpected"]',
      ]),
    ).toThrow(/account actions accept object input/);
  });

  it("builds chat create with both model and modelId plus explicit reasoning and fast-mode args", () => {
    // This strict-equality assertion must not absorb the ambient parent
    // default when the test itself runs inside an ADE-tracked agent shell.
    const savedParentEnv = process.env.ADE_CHAT_SESSION_ID;
    delete process.env.ADE_CHAT_SESSION_ID;
    try {
    const plan = buildCliPlan([
      "chat",
      "create",
      "--lane",
      "lane-1",
      "--provider",
      "claude",
      "--model",
      "anthropic/claude-opus-4-8",
      "--permissions",
      "full-auto",
      "--reasoning-effort",
      "xhigh",
      "--no-fast",
      "--arg",
      "openInUi=true",
    ]);

    const executePlan = expectExecutePlan(plan);

    expect(executePlan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "chat",
        action: "createSession",
        args: {
          laneId: "lane-1",
          provider: "claude",
          model: "anthropic/claude-opus-4-8",
          modelId: "anthropic/claude-opus-4-8",
          permissionMode: "full-auto",
          droidPermissionMode: null,
          title: null,
          surface: "work",
          fastMode: false,
          codexFastMode: false,
          reasoningEffort: "xhigh",
          openInUi: true,
        },
      },
    });
    } finally {
      if (savedParentEnv === undefined) delete process.env.ADE_CHAT_SESSION_ID;
      else process.env.ADE_CHAT_SESSION_ID = savedParentEnv;
    }
  });

  it("chains chat create --prompt into a first chat send", () => {
    const plan = buildCliPlan([
      "chat",
      "create",
      "--lane",
      "lane-1",
      "--provider",
      "claude",
      "--model",
      "anthropic/claude-opus-4-8",
      "--prompt",
      "Fix the tests",
    ]);

    const executePlan = expectExecutePlan(plan);
    expect(executePlan.steps).toHaveLength(2);
    expect(executePlan.steps[0]?.key).toBe("session");

    const sendStep = executePlan.steps[1]!;
    const sendParams = (sendStep.params as (v: Record<string, unknown>) => Record<string, unknown>)({
      session: { domain: "chat", action: "createSession", result: { sessionId: "chat-new" } },
    });
    expect(sendParams).toMatchObject({
      arguments: {
        domain: "chat",
        action: "sendMessage",
        args: {
          sessionId: "chat-new",
          text: "Fix the tests",
        },
      },
    });
  });

  it("builds new chat mode with auto-created lane and kickoff prompt", () => {
    const plan = buildCliPlan([
      "new",
      "chat",
      "--mode",
      "chat",
      "--lane",
      "auto",
      "--lane-name",
      "fix-login",
      "--base",
      "origin/main",
      "--provider",
      "codex",
      "--model",
      "openai/gpt-5.5",
      "--reasoning-effort",
      "xhigh",
      "--permissions",
      "full-auto",
      "--no-fast",
      "--prompt",
      "Fix login",
      "--arg",
      "openInUi=true",
    ]);

    const executePlan = expectExecutePlan(plan);
    expect(executePlan.steps).toHaveLength(3);
    expect(executePlan.steps[0]?.params).toEqual({
      name: "create_lane",
      arguments: {
        name: "fix-login",
        baseBranch: "origin/main",
      },
    });

    const createParams = (executePlan.steps[1]?.params as (v: Record<string, unknown>) => Record<string, unknown>)({
      lane: { id: "lane-new" },
    });
    expect(createParams).toMatchObject({
      name: "run_ade_action",
      arguments: {
        domain: "chat",
        action: "createSession",
        args: {
          laneId: "lane-new",
          provider: "codex",
          model: "openai/gpt-5.5",
          modelId: "openai/gpt-5.5",
          reasoningEffort: "xhigh",
          permissionMode: "full-auto",
          fastMode: false,
          codexFastMode: false,
          openInUi: true,
        },
      },
    });

    const sendParams = (executePlan.steps[2]?.params as (v: Record<string, unknown>) => Record<string, unknown>)({
      session: { domain: "chat", action: "createSession", result: { sessionId: "chat-new" } },
    });
    expect(sendParams).toMatchObject({
      name: "run_ade_action",
      arguments: {
        domain: "chat",
        action: "sendMessage",
        args: {
          sessionId: "chat-new",
          text: "Fix login",
        },
      },
    });
  });

  it("builds new chat CLI mode with the same launch controls", () => {
    const plan = buildCliPlan([
      "new",
      "chat",
      "--mode",
      "cli",
      "--lane",
      "lane-1",
      "--provider",
      "Codex",
      "--model",
      "openai/gpt-5.5",
      "--reasoning-effort",
      "xhigh",
      "--permissions",
      "full-auto",
      "--no-fast",
      "--prompt",
      "Fix the tests",
    ]);

    const executePlan = expectExecutePlan(plan);
    expect(executePlan.label).toBe("new chat cli");
    expect(executePlan.steps).toHaveLength(1);
    const launchParams = (executePlan.steps[0]?.params as (v: Record<string, unknown>) => Record<string, unknown>)({});
    expect(launchParams).toMatchObject({
      name: "start_cli_session",
      arguments: {
          laneId: "lane-1",
          provider: "codex",
        model: "openai/gpt-5.5",
        modelId: "openai/gpt-5.5",
        reasoningEffort: "xhigh",
        permissionMode: "full-auto",
        fastMode: false,
        codexFastMode: false,
        initialInput: "Fix the tests",
        cols: 120,
        rows: 36,
        tracked: true,
      },
    });
  });

  it("adds a valid --type to new chat createSession args and rejects invalid values", () => {
    const plan = buildCliPlan([
      "new",
      "chat",
      "--mode",
      "chat",
      "--lane",
      "lane-1",
      "--provider",
      "codex",
      "--model",
      "openai/gpt-5.5",
      "--type",
      "peer",
    ]);
    const executePlan = expectExecutePlan(plan);
    const createParams = (executePlan.steps[0]?.params as (v: Record<string, unknown>) => Record<string, unknown>)({});
    expect(createParams).toMatchObject({
      arguments: {
        domain: "chat",
        action: "createSession",
        args: { spawnKind: "peer" },
      },
    });

    expect(() => buildCliPlan([
      "new",
      "chat",
      "--mode",
      "chat",
      "--lane",
      "lane-1",
      "--type",
      "manager",
    ])).toThrow(/--type must be subagent, peer, or none/);
  });

  it("builds the unmerged-work child-lane nudge when the current lane is ahead", () => {
    const notice = detectUnmergedLaneCreateNudge(
      { newLaneName: "next-task", cwd: "/tmp/worktree", currentLaneId: "lane-current" },
      (gitArgs) => {
        const command = gitArgs.join(" ");
        if (command === "symbolic-ref --quiet --short refs/remotes/origin/HEAD") {
          return { status: 0, stdout: "origin/main\n" };
        }
        if (command === "rev-list --count origin/main..HEAD") {
          return { status: 0, stdout: "3\n" };
        }
        if (command === "branch --show-current") {
          return { status: 0, stdout: "feature/current\n" };
        }
        return { status: 1, stdout: "" };
      },
    );

    expect(notice).toBe([
      '⚠ Lane "feature/current" has 3 commit(s) not on main.',
      "  To carry them into the new lane instead:",
      "    ade lanes child --lane lane-current --name next-task",
      "  Continuing off remote main (origin/main).",
    ].join("\n"));
  });

  it("rejects unknown providers for new chat before launching", () => {
    expect(() =>
      buildCliPlan([
        "new",
        "chat",
        "--lane",
        "lane-1",
        "--provider",
        "mystery",
      ]),
    ).toThrow(/Provider must be claude, codex, cursor, droid, opencode, or shell/);
  });

  it("does not treat new --mode values as subcommands", () => {
    const plan = buildCliPlan([
      "new",
      "--mode",
      "cli",
      "--lane",
      "lane-1",
      "--prompt",
      "Fix the tests",
    ]);

    const executePlan = expectExecutePlan(plan);
    const launchParams = (executePlan.steps[0]?.params as (v: Record<string, unknown>) => Record<string, unknown>)({});
    expect(launchParams).toMatchObject({
      name: "start_cli_session",
      arguments: {
        laneId: "lane-1",
        provider: "codex",
        initialInput: "Fix the tests",
      },
    });
  });

  it("prints chat create config without launching a session", () => {
    const plan = buildCliPlan([
      "chat",
      "create",
      "--lane",
      "lane-1",
      "--provider",
      "codex",
      "--model",
      "openai/gpt-5.5",
      "--reasoning-effort",
      "xhigh",
      "--permissions",
      "full-auto",
      "--no-fast",
      "--print-config",
    ]);

    const staticPlan = expectStaticPlan(plan);
    const value = staticPlan.value as { input: Record<string, unknown> };
    expect(staticPlan.value).toMatchObject({
      ok: true,
      dryRun: true,
      action: "chat.createSession",
      input: {
        laneId: "lane-1",
        provider: "codex",
        model: "openai/gpt-5.5",
        modelId: "openai/gpt-5.5",
        reasoningEffort: "xhigh",
        permissionMode: "full-auto",
        fastMode: false,
        codexFastMode: false,
      },
      resolved: {
        provider: "codex",
        model: "openai/gpt-5.5",
        reasoningEffort: "xhigh",
        fastMode: false,
        permissionMode: "full-auto",
        codex: {
          codexSandbox: "danger-full-access",
          codexApprovalPolicy: "never",
        },
      },
    });
    expect(value.input).not.toHaveProperty("droidPermissionMode");
    expect(value.input).not.toHaveProperty("title");
  });

  describe("chat create parent lineage", () => {
    const savedParentEnv = process.env.ADE_CHAT_SESSION_ID;
    afterEach(() => {
      if (savedParentEnv === undefined) delete process.env.ADE_CHAT_SESSION_ID;
      else process.env.ADE_CHAT_SESSION_ID = savedParentEnv;
    });

    const dryRunCreate = (...extra: string[]) =>
      buildCliPlan([
        "chat", "create",
        "--lane", "lane-1",
        "--provider", "codex",
        "--model", "openai/gpt-5.5",
        "--print-config",
        ...extra,
      ]);

    it("defaults orchestrationParentSessionId from ADE_CHAT_SESSION_ID", () => {
      process.env.ADE_CHAT_SESSION_ID = "parent-session-1";
      const staticPlan = expectStaticPlan(dryRunCreate());
      expect((staticPlan.value as { input: Record<string, unknown> }).input.orchestrationParentSessionId)
        .toBe("parent-session-1");
    });

    it("omits the parent when the env var is not set", () => {
      delete process.env.ADE_CHAT_SESSION_ID;
      const staticPlan = expectStaticPlan(dryRunCreate());
      expect((staticPlan.value as { input: Record<string, unknown> }).input)
        .not.toHaveProperty("orchestrationParentSessionId");
    });

    it("--parent overrides the env default", () => {
      process.env.ADE_CHAT_SESSION_ID = "parent-session-1";
      const staticPlan = expectStaticPlan(dryRunCreate("--parent", "explicit-parent"));
      expect((staticPlan.value as { input: Record<string, unknown> }).input.orchestrationParentSessionId)
        .toBe("explicit-parent");
    });

    it("--no-parent opts out even with the env var set", () => {
      process.env.ADE_CHAT_SESSION_ID = "parent-session-1";
      const staticPlan = expectStaticPlan(dryRunCreate("--no-parent"));
      expect((staticPlan.value as { input: Record<string, unknown> }).input)
        .not.toHaveProperty("orchestrationParentSessionId");
    });

    it("rejects --parent combined with --no-parent", () => {
      expect(() => dryRunCreate("--parent", "p", "--no-parent")).toThrow(/--no-parent/);
    });

    it("ade new chat --mode chat inherits the env parent in its launch args", () => {
      process.env.ADE_CHAT_SESSION_ID = "parent-session-1";
      const plan = buildCliPlan([
        "new", "chat",
        "--mode", "chat",
        "--lane", "lane-1",
        "--provider", "codex",
        "--model", "openai/gpt-5.5",
        "--print-config",
      ]);
      const staticPlan = expectStaticPlan(plan);
      expect((staticPlan.value as { launch: Record<string, unknown> }).launch.orchestrationParentSessionId)
        .toBe("parent-session-1");
    });
  });

  it("prints chat create --prompt dry-run with the follow-up send", () => {
    const plan = buildCliPlan([
      "chat",
      "create",
      "--lane",
      "lane-1",
      "--provider",
      "claude",
      "--model",
      "anthropic/claude-opus-4-8",
      "--prompt",
      "Fix the tests",
      "--print-config",
    ]);

    const staticPlan = expectStaticPlan(plan);
    expect(staticPlan.value).toMatchObject({
      action: "chat.createSession",
      input: {
        laneId: "lane-1",
        provider: "claude",
        model: "anthropic/claude-opus-4-8",
      },
      afterCreate: [
        {
          action: "chat.sendMessage",
          input: {
            sessionId: "<created-session-id>",
            text: "Fix the tests",
          },
        },
      ],
    });
  });

  it("prints chat create from Linear dry-run with attachment flags", () => {
    const plan = buildCliPlan([
      "chat",
      "create",
      "--lane",
      "lane-1",
      "--from-linear-issue",
      "ENG-431",
      "--role",
      "worked",
      "--source",
      "chat_attach",
      "--include-in-pr",
      "--close-on-merge",
      "--print-config",
    ]);

    const staticPlan = expectStaticPlan(plan);
    expect(staticPlan.value).toMatchObject({
      action: "chat.createSession",
      afterCreate: [
        {
          action: "lane.attachLinearIssueToSession",
          input: {
            chatSessionId: "<created-session-id>",
            issues: [{ identifier: "ENG-431" }],
            role: "worked",
            source: "chat_attach",
            includeInPr: true,
            closeOnMerge: true,
          },
        },
        {
          action: "chat.sendMessage",
          input: {
            sessionId: "<created-session-id>",
          },
        },
      ],
    });
  });

  it("omits unset optional fields from chat create config previews", () => {
    const plan = buildCliPlan([
      "chat",
      "create",
      "--lane",
      "lane-1",
      "--provider",
      "codex",
      "--model",
      "openai/gpt-5.5",
      "--print-config",
    ]);

    const staticPlan = expectStaticPlan(plan);
    const value = staticPlan.value as { input: Record<string, unknown> };
    expect(staticPlan.value).toMatchObject({
      input: {
        laneId: "lane-1",
        provider: "codex",
        model: "openai/gpt-5.5",
        modelId: "openai/gpt-5.5",
        surface: "work",
      },
      resolved: {
        provider: "codex",
        model: "openai/gpt-5.5",
        reasoningEffort: null,
        fastMode: null,
        permissionMode: "default",
      },
    });
    expect(value.input).not.toHaveProperty("reasoningEffort");
    expect(value.input).not.toHaveProperty("permissionMode");
    expect(value.input).not.toHaveProperty("droidPermissionMode");
    expect(value.input).not.toHaveProperty("title");
    expect(value.input).not.toHaveProperty("fastMode");
    expect(value.input).not.toHaveProperty("codexFastMode");
  });

  it("builds chat read as a transcript action", () => {
    const plan = buildCliPlan([
      "chat",
      "read",
      "chat-1",
      "--limit",
      "25",
      "--since",
      "2026-06-29T00:00:00.000Z",
    ]);

    const executePlan = expectExecutePlan(plan);
    expect(executePlan.formatter).toBe("chat-read");
    expect(executePlan.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "chat",
        action: "readTranscript",
        args: {
          sessionId: "chat-1",
          limit: 25,
          since: "2026-06-29T00:00:00.000Z",
        },
      },
    });
  });

  it("routes chat send through the normalized message primitive", () => {
    const executePlan = expectExecutePlan(buildCliPlan([
      "chat",
      "send",
      "chat-1",
      "--text",
      "keep going",
    ]));

    expect(executePlan.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "chat",
        action: "messageSession",
        args: {
          sessionId: "chat-1",
          text: "keep going",
          kind: "auto",
        },
      },
    });
  });

  it("builds chat steer as an explicit steer action", () => {
    const executePlan = expectExecutePlan(buildCliPlan([
      "chat",
      "steer",
      "chat-1",
      "--text",
      "use this context",
    ]));

    expect(executePlan.label).toBe("chat steer");
    expect(executePlan.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "chat",
        action: "steer",
        args: {
          sessionId: "chat-1",
          text: "use this context",
        },
      },
    });
  });

  it.each([
    ["wait", "wait"],
    ["nudge", "steer"],
    ["retry", "interrupt_retry_same_thread"],
    ["resume", "restart_resume_thread"],
  ] as const)("maps chat recovery action %s to %s", (cliAction, action) => {
    const executePlan = expectExecutePlan(buildCliPlan([
      "chat",
      "recover",
      "chat-1",
      "--turn",
      "turn-1",
      "--action",
      cliAction,
    ]));

    expect(executePlan.label).toBe("chat recover");
    expect(executePlan.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "chat",
        action: "recoverCodexTurn",
        args: {
          sessionId: "chat-1",
          turnId: "turn-1",
          action,
        },
      },
    });
  });

  it("rejects incomplete or unknown chat recovery requests", () => {
    expect(() => buildCliPlan([
      "chat", "recover", "chat-1", "--action", "wait",
    ])).toThrow(/turnId/);
    expect(() => buildCliPlan([
      "chat", "recover", "chat-1", "--turn", "turn-1", "--action", "replace",
    ])).toThrow(/wait, nudge, retry, or resume/);
  });

  it("filters the typed chat model inventory by provider", () => {
    const executePlan = expectExecutePlan(buildCliPlan([
      "chat",
      "models",
      "--provider",
      "codex",
    ]));

    expect(executePlan.label).toBe("chat models");
    expect(executePlan.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "chat",
        action: "getAvailableModels",
        args: { provider: "codex" },
      },
    });
  });

  it("requests the complete typed chat model inventory when provider is omitted", () => {
    const executePlan = expectExecutePlan(buildCliPlan(["chat", "models"]));

    expect(executePlan.label).toBe("chat models");
    expect(executePlan.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "chat",
        action: "getAvailableModels",
        args: {},
      },
    });
  });

  it("builds chat message with an explicit routing kind", () => {
    const executePlan = expectExecutePlan(buildCliPlan([
      "chat",
      "message",
      "chat-1",
      "--kind",
      "interrupt-replace",
      "--text",
      "stop and use this direction",
    ]));

    expect(executePlan.label).toBe("chat message");
    expect(executePlan.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "chat",
        action: "messageSession",
        args: {
          sessionId: "chat-1",
          text: "stop and use this direction",
          kind: "interrupt-replace",
        },
      },
    });
  });

  it("builds chat wait as a bounded state wait", () => {
    const plan = buildCliPlan([
      "chat",
      "wait",
      "chat-1",
      "--for",
      "awaiting-input",
      "--timeout-ms",
      "120000",
      "--poll-interval-ms",
      "500",
    ]);

    expect(plan).toMatchObject({
      kind: "chat-wait",
      sessionId: "chat-1",
      waitFor: "awaiting-input",
      timeoutMs: 120000,
      pollIntervalMs: 500,
    });
  });

  it("parses chat session ids after value flags", () => {
    const plan = buildCliPlan([
      "chat",
      "wait",
      "--for",
      "idle",
      "chat-1",
    ]);

    expect(plan).toMatchObject({
      kind: "chat-wait",
      sessionId: "chat-1",
      waitFor: "idle",
    });
  });

  it("defaults chat wait to idle and accepts a positional wait target", () => {
    expect(buildCliPlan(["chat", "wait", "chat-1"])).toMatchObject({
      kind: "chat-wait",
      sessionId: "chat-1",
      waitFor: "idle",
    });

    expect(buildCliPlan(["chat", "wait", "chat-1", "terminal"])).toMatchObject({
      kind: "chat-wait",
      sessionId: "chat-1",
      waitFor: "terminal",
    });
  });

  it("rejects reasoning effort on legacy agent spawn", () => {
    expect(() =>
      buildCliPlan([
        "agent",
        "spawn",
        "--lane",
        "lane-1",
        "--prompt",
        "fix",
        "--reasoning-effort",
        "xhigh",
      ]),
    ).toThrow(/agent spawn does not support reasoning effort/);
  });

  it("rejects conflicting chat create kickoff aliases and no-kickoff flags", () => {
    for (const kickoffFlag of ["--prompt", "--kickoff", "--kickoff-prompt"]) {
      expect(() =>
        buildCliPlan([
          "chat",
          "create",
          "--lane",
          "lane-1",
          kickoffFlag,
          "Fix the tests",
          "--no-kickoff",
        ]),
      ).toThrow(/--no-kickoff cannot be used with --prompt\/--kickoff/);
      expect(() =>
        buildCliPlan([
          "chat",
          "create",
          "--lane",
          "lane-1",
          "--from-linear-issue",
          "ENG-431",
          kickoffFlag,
          "Fix the tests",
          "--no-kickoff",
        ]),
      ).toThrow(/--no-kickoff cannot be used with --prompt\/--kickoff/);
    }
  });

  it("rejects --print=value on chat send", () => {
    expect(() => buildCliPlan([
      "chat",
      "send",
      "chat-1",
      "--print=true",
      "--text",
      "Hello",
    ])).toThrow(/--print must be set at session creation time/);
  });

  it("formats chat transcript reads as role-separated text", () => {
    const text = formatOutput(
      [
        { role: "user", text: "hello", timestamp: "2026-06-29T12:00:00.000Z" },
        { role: "assistant", text: "hi", timestamp: "2026-06-29T12:00:01.000Z" },
      ],
      { ...baseResolveOpts(), projectRoot: null, workspaceRoot: null, text: true },
      "chat-read",
    );

    expect(text).toContain("ADE chat transcript");
    expect(text).toContain("user 2026-06-29T12:00:00.000Z");
    expect(text).toContain("hello");
    expect(text).toContain("assistant 2026-06-29T12:00:01.000Z");
  });

  it("builds chat show/status as positional session summary calls", () => {
    const show = buildCliPlan(["chat", "show", "chat-1"]);
    expect(show.kind).toBe("execute");
    if (show.kind !== "execute") return;
    expect(show.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "chat",
        action: "getSessionSummary",
        argsList: ["chat-1"],
      },
    });

    const status = buildCliPlan(["chat", "status", "--session-id", "chat-2"]);
    expect(status.kind).toBe("execute");
    if (status.kind !== "execute") return;
    expect(status.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "chat",
        action: "getSessionSummary",
        argsList: ["chat-2"],
      },
    });
  });

  it("maps chat list filters to the listSessions action", () => {
    const plan = buildCliPlan([
      "chat",
      "list",
      "--lane",
      "lane-1",
      "--include-automation",
      "--include-identity",
      "--no-archived",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "chat",
        action: "listSessions",
        args: {
          laneId: "lane-1",
          includeAutomation: true,
          includeIdentity: true,
          includeArchived: false,
        },
      },
    });

    expect(() =>
      buildCliPlan(["chat", "list", "--include-archived", "--no-archived"]),
    ).toThrow(/Use either --include-archived or --no-archived/);
  });

  it("builds complete machine-only personal chat plans without project registration", async () => {
    const list = expectExecutePlan(buildCliPlan([
      "chat",
      "list",
      "--personal",
      "--no-archived",
    ]));
    expect(list).toMatchObject({
      machineOnly: true,
      label: "personal chat list",
      formatter: "chat-list",
      steps: [{
        method: "personalChats.call",
        params: { action: "list", args: { includeArchived: false } },
      }],
    });
    expect(shouldAutoRegisterProjectForPlan(list)).toBe(false);

    const create = expectExecutePlan(buildCliPlan([
      "chat",
      "create",
      "--personal",
      "--provider",
      "codex",
      "--model",
      "openai/gpt-5.5",
      "--prompt",
      "Plan a trip",
    ]));
    expect(create.steps).toEqual([{
      key: "result",
      method: "personalChats.call",
      params: {
        action: "create",
        args: {
          provider: "codex",
          model: "openai/gpt-5.5",
          modelId: "openai/gpt-5.5",
          title: null,
          reasoningEffort: null,
          permissionMode: null,
          kickoffText: "Plan a trip",
        },
      },
    }]);

    const send = expectExecutePlan(buildCliPlan([
      "chat",
      "send",
      "personal-1",
      "--personal",
      "--text",
      "hello",
    ]));
    expect(send.steps[0]).toMatchObject({
      method: "personalChats.call",
      params: {
        action: "send",
        args: { sessionId: "personal-1", text: "hello" },
      },
    });

    const actions = expectStaticPlan(buildCliPlan(["chat", "actions", "--personal"]));
    expect(actions.value).toMatchObject({
      actions: expect.arrayContaining([
        expect.objectContaining({ name: "personalChats.create" }),
        expect.objectContaining({ name: "personalChats.saveTempAttachment" }),
        expect.objectContaining({ name: "personalChats.terminalDispose" }),
      ]),
    });
    expect(formatOutput(actions.value, {
      ...baseResolveOpts(),
      projectRoot: null,
      workspaceRoot: null,
      text: true,
    }, actions.formatter)).toContain(
      "ade chat action --personal <action>",
    );

    const rawTerminalDispose = expectExecutePlan(buildCliPlan([
      "chat",
      "action",
      "--personal",
      "terminalDispose",
      "--input-json",
      '{"ptyId":"pty-1","sessionId":"terminal-1"}',
    ]));
    expect(rawTerminalDispose.steps[0]).toEqual({
      key: "result",
      method: "personalChats.call",
      params: {
        action: "terminalDispose",
        args: { ptyId: "pty-1", sessionId: "terminal-1" },
      },
    });

    const steer = expectExecutePlan(buildCliPlan([
      "chat",
      "steer",
      "personal-1",
      "--personal",
      "--text",
      "focus",
      "--image-url",
      "https://example.test/image.png",
    ]));
    expect(steer.steps[0]).toMatchObject({
      params: {
        action: "steer",
        args: {
          sessionId: "personal-1",
          text: "focus",
          attachments: [{
            type: "image-url",
            url: "https://example.test/image.png",
            path: "https://example.test/image.png",
          }],
        },
      },
    });

    const models = expectExecutePlan(buildCliPlan([
      "chat",
      "models",
      "--personal",
      "--provider",
      "codex",
    ]));
    expect(models.steps[0]).toMatchObject({
      params: { action: "models", args: { provider: "codex" } },
    });

    const update = expectExecutePlan(buildCliPlan([
      "chat",
      "update",
      "personal-1",
      "--personal",
      "--title",
      "Trip planning",
      "--tag",
      "review-ready",
      "--reasoning-effort",
      "high",
      "--fast",
    ]));
    expect(update.steps[0]).toMatchObject({
      params: {
        action: "updateSession",
        args: {
          sessionId: "personal-1",
          title: "Trip planning",
          tag: "review-ready",
          reasoningEffort: "high",
          fastMode: true,
        },
      },
    });

    // `--tag ""` clears the Claude session tag (empty string is forwarded, not dropped).
    const clearTag = expectExecutePlan(buildCliPlan([
      "chat",
      "update",
      "personal-1",
      "--personal",
      "--tag",
      "",
    ]));
    expect(clearTag.steps[0]).toMatchObject({
      params: {
        action: "updateSession",
        args: {
          sessionId: "personal-1",
          tag: "",
        },
      },
    });

    expect(() => buildCliPlan([
      "chat",
      "list",
      "--personal",
      "--lane",
      "lane-1",
    ])).toThrow(/cannot be combined with --lane/);
    expect(() => buildCliPlan([
      "chat",
      "create",
      "--personal",
      "--provider",
      "codex",
    ])).toThrow(/model is required/);
    expect(() => buildCliPlan([
      "chat",
      "action",
      "--personal",
      "not-real",
    ])).toThrow(/Unknown personal chat action/);
    expect(() => buildCliPlan([
      "chat",
      "typo",
      "--personal",
    ])).toThrow(/Personal chats support.*got 'typo'/);
    await expect(runCli([
      "--headless",
      "chat",
      "list",
      "--personal",
    ])).rejects.toThrow(/require the machine-owned ADE brain/);
  });

  posixIt("executes personal chat commands over the machine socket without project registration", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-personal-chat-sock-"));
    const socketPath = path.join(root, "ade.sock");
    const requests: Array<{ method: string; params?: unknown }> = [];
    const stop = await startHeadlessRpcSocketServer({
      socketPath,
      createHandler: () => (async (request: any) => {
        requests.push({ method: request.method, params: request.params });
        if (request.method === "ade/initialize") return {};
        if (request.method === "personalChats.call") {
          return { action: "list", result: [] };
        }
        throw new Error(`Unexpected method: ${request.method}`);
      }) as any,
    });

    try {
      const result = await runCli([
        "--socket",
        socketPath,
        "chat",
        "list",
        "--personal",
        "--text",
      ]);
      expect(result.exitCode).toBe(0);
      expect(requests.filter((request) => request.method === "ade/initialize")).toHaveLength(2);
      expect(requests.at(-1)).toEqual({
        method: "personalChats.call",
        params: { action: "list", args: {} },
      });
      expect(requests.some((request) => request.method === "projects.add")).toBe(false);
    } finally {
      stop?.();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  posixIt("runs typed account status as CTO and passes project config root for token creation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-account-status-sock-"));
    const socketPath = path.join(root, "ade.sock");
    const requests: Array<{ method: string; params?: unknown }> = [];
    const stop = await startHeadlessRpcSocketServer({
      socketPath,
      createHandler: () => (async (request: any) => {
        requests.push({ method: request.method, params: request.params });
        if (request.method === "ade/initialize") {
          return {
            runtimeInfo: {
              version: process.env.ADE_CLI_VERSION?.trim() || "0.0.0",
              buildHash: null,
              defaultRole: "cto",
              packageChannel: null,
              projectRoot: null,
              pid: process.pid,
            },
          };
        }
        if (request.method === "account.call") {
          const action = request.params?.action;
          if (action === "createToken") {
            return {
              domain: "account",
              action,
              result: {
                token: "durable-token-output",
                source: "refresh_token",
                guidance: "Store it in a secret manager.",
              },
              statusHints: {},
            };
          }
          return {
            domain: "account",
            action,
            result: {
              signedIn: true,
              userId: "typed-status-user",
              email: "typed-status@example.com",
              name: "Typed Status User",
              expiresAt: "2026-07-15T10:00:00.000Z",
              source: "env-token",
            },
            statusHints: {},
          };
        }
        throw new Error(`Unexpected method: ${request.method}`);
      }) as any,
    });

    try {
      const result = await runCli([
        "--socket",
        socketPath,
        "--headless",
        "auth",
        "status",
        "--text",
      ]);
      expect(result).toEqual({
        output: "Signed in as typed-status@example.com (env-token)\n",
        exitCode: 0,
      });
      const initializeRequests = requests.filter((request) => request.method === "ade/initialize");
      expect(initializeRequests.length).toBeGreaterThan(0);
      for (const request of initializeRequests) {
        expect(request.params).toMatchObject({ identity: { role: "cto" } });
      }
      expect(requests.at(-1)).toEqual({
        method: "account.call",
        params: { action: "status", args: {} },
      });
      expect(requests.some((request) => request.method === "projects.add")).toBe(false);

      requests.length = 0;
      const tokenResult = await runCli([
        "--project-root",
        root,
        "--socket",
        socketPath,
        "account",
        "token",
        "create",
        "--text",
      ]);
      expect(tokenResult.exitCode).toBe(0);
      expect(tokenResult.output).toContain("durable-token-output");
      expect(requests.at(-1)).toEqual({
        method: "account.call",
        params: {
          action: "createToken",
          args: { projectRoot: root },
        },
      });
      expect(requests.some((request) => request.method === "projects.add")).toBe(false);
    } finally {
      stop?.();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  posixIt("rejects an inherited expired ADE_ACCOUNT_TOKEN instead of reporting login success", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-account-env-token-sock-"));
    const socketPath = path.join(root, "ade.sock");
    const requests: Array<{ method: string; params?: unknown }> = [];
    const stop = await startHeadlessRpcSocketServer({
      socketPath,
      createHandler: () => (async (request: any) => {
        requests.push({ method: request.method, params: request.params });
        if (request.method === "ade/initialize") {
          return {
            runtimeInfo: {
              version: process.env.ADE_CLI_VERSION?.trim() || "0.0.0",
              buildHash: null,
              defaultRole: "cto",
              packageChannel: null,
              projectRoot: null,
              pid: process.pid,
            },
          };
        }
        if (request.method === "account.call") {
          if (request.params?.action === "getToken") {
            throw new Error("expired token rejected");
          }
          return {
            domain: "account",
            action: "status",
            result: {
              signedIn: false,
              userId: null,
              email: null,
              name: null,
              expiresAt: "2026-07-14T11:59:00.000Z",
              source: "env-token",
            },
            statusHints: {},
          };
        }
        throw new Error(`Unexpected method: ${request.method}`);
      }) as any,
    });
    const previousToken = process.env.ADE_ACCOUNT_TOKEN;
    const expiredToken = "expired-token-that-must-not-appear";

    try {
      process.env.ADE_ACCOUNT_TOKEN = expiredToken;
      let caught: unknown;
      try {
        await runCli(["--socket", socketPath, "login", "--text"]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("ADE_ACCOUNT_TOKEN is expired or invalid.");
      expect(JSON.stringify(caught)).not.toContain(expiredToken);
      expect(requests.filter((request) => request.method === "account.call")).toEqual([
        { method: "account.call", params: { action: "status", args: {} } },
        { method: "account.call", params: { action: "getToken", args: {} } },
      ]);
    } finally {
      if (previousToken === undefined) delete process.env.ADE_ACCOUNT_TOKEN;
      else process.env.ADE_ACCOUNT_TOKEN = previousToken;
      stop?.();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  posixIt("uses a valid machine-brain env token when the invoking CLI did not inherit it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-account-brain-env-token-sock-"));
    const socketPath = path.join(root, "ade.sock");
    const requests: Array<{ method: string; params?: unknown }> = [];
    const stop = await startHeadlessRpcSocketServer({
      socketPath,
      createHandler: () => (async (request: any) => {
        requests.push({ method: request.method, params: request.params });
        if (request.method === "ade/initialize") {
          return {
            runtimeInfo: {
              version: process.env.ADE_CLI_VERSION?.trim() || "0.0.0",
              defaultRole: "cto",
              projectRoot: null,
              pid: process.pid,
            },
          };
        }
        if (request.method === "account.call" && request.params?.action === "status") {
          return {
            domain: "account",
            action: "status",
            result: {
              signedIn: true,
              userId: "brain-env-user",
              email: "brain-env@example.com",
              name: "Brain Env User",
              expiresAt: "2026-07-14T13:00:00.000Z",
              source: "env-token",
            },
            statusHints: {},
          };
        }
        throw new Error(`Unexpected method: ${request.method}`);
      }) as any,
    });
    const previousToken = process.env.ADE_ACCOUNT_TOKEN;
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      delete process.env.ADE_ACCOUNT_TOKEN;
      const result = await runCli(["--socket", socketPath, "login", "--text"]);

      expect(result).toEqual({
        output: "Signed in as brain-env@example.com (env-token)\n",
        exitCode: 0,
      });
      expect(requests.filter((request) => request.method === "account.call")).toEqual([
        { method: "account.call", params: { action: "status", args: {} } },
      ]);
      expect(stderrWrite.mock.calls.flat().join("")).toContain(
        "Using ADE_ACCOUNT_TOKEN; no interactive sign-in is required.",
      );
    } finally {
      stderrWrite.mockRestore();
      if (previousToken === undefined) delete process.env.ADE_ACCOUNT_TOKEN;
      else process.env.ADE_ACCOUNT_TOKEN = previousToken;
      stop?.();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  posixIt("verifies a refresh-token env credential before reporting login success", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-account-env-refresh-sock-"));
    const socketPath = path.join(root, "ade.sock");
    const requests: Array<{ method: string; params?: any }> = [];
    let verified = false;
    const stop = await startHeadlessRpcSocketServer({
      socketPath,
      createHandler: () => (async (request: any) => {
        requests.push({ method: request.method, params: request.params });
        if (request.method === "ade/initialize") {
          return {
            runtimeInfo: {
              version: process.env.ADE_CLI_VERSION?.trim() || "0.0.0",
              defaultRole: "cto",
              projectRoot: null,
              pid: process.pid,
            },
          };
        }
        if (request.method === "account.call") {
          const action = request.params?.action;
          if (action === "getToken") {
            verified = true;
            return { domain: "account", action, result: "access-token-must-not-print", statusHints: {} };
          }
          if (action === "status") {
            return {
              domain: "account",
              action,
              result: {
                signedIn: verified,
                userId: verified ? "env-user" : null,
                email: verified ? "env@example.com" : null,
                name: null,
                expiresAt: verified ? "2026-07-14T13:00:00.000Z" : null,
                source: "env-token",
              },
              statusHints: {},
            };
          }
        }
        throw new Error(`Unexpected method: ${request.method}`);
      }) as any,
    });
    const previousToken = process.env.ADE_ACCOUNT_TOKEN;
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      process.env.ADE_ACCOUNT_TOKEN = "refresh-env-secret-must-not-print";
      const result = await runCli(["--socket", socketPath, "login", "--text"]);
      expect(result).toEqual({
        output: "Signed in as env@example.com (env-token)\n",
        exitCode: 0,
      });
      expect(JSON.stringify(result)).not.toContain("access-token-must-not-print");
      expect(JSON.stringify(result)).not.toContain("refresh-env-secret-must-not-print");
      const stderr = stderrWrite.mock.calls
        .map(([chunk]) => String(chunk))
        .join("");
      expect(stderr).not.toContain("access-token-must-not-print");
      expect(stderr).not.toContain("refresh-env-secret-must-not-print");
      expect(requests.filter((request) => request.method === "account.call"))
        .toEqual([
          { method: "account.call", params: { action: "status", args: {} } },
          { method: "account.call", params: { action: "getToken", args: {} } },
          { method: "account.call", params: { action: "status", args: {} } },
        ]);
    } finally {
      stderrWrite.mockRestore();
      if (previousToken === undefined) delete process.env.ADE_ACCOUNT_TOKEN;
      else process.env.ADE_ACCOUNT_TOKEN = previousToken;
      stop?.();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  posixIt("runs explicit headless login despite local and brain env auth", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-account-explicit-device-sock-"));
    const socketPath = path.join(root, "ade.sock");
    const requests: Array<{ method: string; params?: any }> = [];
    const stop = await startHeadlessRpcSocketServer({
      socketPath,
      createHandler: () => (async (request: any) => {
        requests.push({ method: request.method, params: request.params });
        if (request.method === "ade/initialize") {
          return {
            runtimeInfo: {
              version: process.env.ADE_CLI_VERSION?.trim() || "0.0.0",
              defaultRole: "cto",
              projectRoot: null,
              pid: process.pid,
            },
          };
        }
        if (request.method === "account.call") {
          const action = request.params?.action;
          if (action === "status") {
            return {
              domain: "account",
              action,
              result: {
                signedIn: true,
                userId: "brain-env-user",
                email: "brain-env@example.com",
                name: null,
                expiresAt: "2026-07-14T13:00:00.000Z",
                source: "env-token",
              },
              statusHints: {},
            };
          }
          if (action === "startDeviceLogin") {
            return {
              domain: "account",
              action,
              result: {
                sessionId: "device-at-deadline",
                userCode: "DEAD-LINE",
                verificationUri: "https://directory.example.test/device",
                expiresAt: new Date(Date.now() + 10).toISOString(),
                intervalSec: 1,
              },
              statusHints: {},
            };
          }
          if (action === "pollDeviceLogin") {
            return {
              domain: "account",
              action,
              result: {
                status: "signed_in",
                authStatus: {
                  signedIn: true,
                  userId: "headless-user",
                  email: "headless@example.com",
                  name: null,
                  expiresAt: "2026-07-14T13:00:00.000Z",
                  source: "device",
                },
              },
              statusHints: {},
            };
          }
        }
        throw new Error(`Unexpected method: ${request.method}`);
      }) as any,
    });
    const previousToken = process.env.ADE_ACCOUNT_TOKEN;
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      process.env.ADE_ACCOUNT_TOKEN = "inherited-token-that-must-not-short-circuit";
      const result = await runCli([
        "--socket",
        socketPath,
        "login",
        "--headless",
        "--text",
      ]);
      expect(result).toEqual({
        output: "Signed in as headless@example.com (device)\n",
        exitCode: 0,
      });
      expect(requests.filter((request) => request.method === "account.call")).toEqual([
        {
          method: "account.call",
          params: {
            action: "startDeviceLogin",
            args: { projectRoot: expect.any(String), ignoreEnvCredential: true },
          },
        },
        {
          method: "account.call",
          params: { action: "pollDeviceLogin", args: { sessionId: "device-at-deadline" } },
        },
      ]);
    } finally {
      stderrWrite.mockRestore();
      if (previousToken === undefined) delete process.env.ADE_ACCOUNT_TOKEN;
      else process.env.ADE_ACCOUNT_TOKEN = previousToken;
      stop?.();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  posixIt("autostarts a machine brain for socketless headless login", async () => {
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-local-runtime-account-login-"));
    const projectRoot = path.join(adeHome, "project");
    const socketPath = path.join(adeHome, "sock", "ade.sock");
    fs.mkdirSync(projectRoot, { recursive: true });
    const accessToken = [
      Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify({
        sub: "socketless-headless-user",
        email: "socketless@example.com",
        exp: Math.floor(Date.now() / 1000) + 3600,
      })).toString("base64url"),
      "signature",
    ].join(".");
    let codeRequests = 0;
    let tokenRequests = 0;
    const directory = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/device/code") {
        codeRequests += 1;
        response.end(JSON.stringify({
          device_code: "socketless-device-code",
          user_code: "SOCK-LESS",
          verification_uri: "https://directory.example.test/device",
          expires_in: 60,
          interval: 1,
        }));
        return;
      }
      if (request.url === "/device/token") {
        tokenRequests += 1;
        response.end(JSON.stringify({
          access_token: accessToken,
          refresh_token: "socketless-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
        }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });
    await new Promise<void>((resolve, reject) => {
      directory.once("error", reject);
      directory.listen(0, "127.0.0.1", () => {
        directory.off("error", reject);
        resolve();
      });
    });
    const address = directory.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to start the account directory test server.");
    }

    const envKeys = [
      "ADE_HOME",
      "ADE_PROJECT_ROOT",
      "ADE_RUNTIME_SOCKET_PATH",
      "ADE_RPC_SOCKET_PATH",
      "ADE_RPC_URL",
      "ADE_ACCOUNT_DIRECTORY_URL",
      "ADE_ACCOUNT_TOKEN",
      "NODE_OPTIONS",
    ] as const;
    const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
    const previousArgvEntry = process.argv[1];
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      process.env.ADE_HOME = adeHome;
      process.env.ADE_PROJECT_ROOT = projectRoot;
      delete process.env.ADE_RUNTIME_SOCKET_PATH;
      delete process.env.ADE_RPC_SOCKET_PATH;
      delete process.env.ADE_RPC_URL;
      delete process.env.ADE_ACCOUNT_TOKEN;
      process.env.ADE_ACCOUNT_DIRECTORY_URL = `http://127.0.0.1:${address.port}`;
      process.env.NODE_OPTIONS = process.env.NODE_OPTIONS?.includes("--import tsx")
        ? process.env.NODE_OPTIONS
        : `${process.env.NODE_OPTIONS?.trim() ?? ""} --import tsx`.trim();
      process.argv[1] = path.join(path.dirname(new URL(import.meta.url).pathname), "cli.ts");

      expect(fs.existsSync(socketPath)).toBe(false);
      const result = await runCli([
        "--project-root",
        projectRoot,
        "login",
        "--headless",
        "--text",
      ]);

      expect(result).toEqual({
        output: "Signed in as socketless@example.com (device)\n",
        exitCode: 0,
      });
      expect(fs.existsSync(socketPath)).toBe(true);
      expect(codeRequests).toBe(1);
      expect(tokenRequests).toBe(1);
    } finally {
      try {
        await runCli(["--socket", socketPath, "runtime", "stop", "--text"]);
      } catch {
        // Best-effort cleanup if the detached test runtime never became available.
      }
      stderrWrite.mockRestore();
      process.argv[1] = previousArgvEntry;
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await new Promise<void>((resolve) => directory.close(() => resolve()));
      fs.rmSync(adeHome, { recursive: true, force: true });
    }
  }, 30_000);

  posixIt("accepts current-session deadline success but rejects a stale signed-in account", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-account-deadline-sock-"));
    const socketPath = path.join(root, "ade.sock");
    const requests: Array<{ method: string; params?: any }> = [];
    let completeCurrentSessionAtDeadline = true;
    let devicePollCount = 0;
    const stop = await startHeadlessRpcSocketServer({
      socketPath,
      createHandler: () => (async (request: any) => {
        requests.push({ method: request.method, params: request.params });
        if (request.method === "ade/initialize") {
          return {
            runtimeInfo: {
              version: process.env.ADE_CLI_VERSION?.trim() || "0.0.0",
              defaultRole: "cto",
              projectRoot: null,
              pid: process.pid,
            },
          };
        }
        if (request.method === "account.call") {
          const action = request.params?.action;
          if (action === "startDeviceLogin") {
            return {
              domain: "account",
              action,
              result: {
                sessionId: "device-at-deadline",
                userCode: "DEAD-LINE",
                verificationUri: "https://directory.example.test/device",
                expiresAt: new Date(Date.now()).toISOString(),
                intervalSec: 1,
              },
              statusHints: {},
            };
          }
          if (action === "pollDeviceLogin") {
            devicePollCount += 1;
            if (completeCurrentSessionAtDeadline && devicePollCount === 2) {
              return {
                domain: "account",
                action,
                result: {
                  status: "signed_in",
                  authStatus: {
                    signedIn: true,
                    userId: "deadline-user",
                    email: "deadline@example.com",
                    name: null,
                    expiresAt: "2026-07-14T13:00:00.000Z",
                    source: "device",
                  },
                },
                statusHints: {},
              };
            }
            return {
              domain: "account",
              action,
              result: {
                status: "pending",
                authStatus: completeCurrentSessionAtDeadline
                  ? { signedIn: false }
                  : {
                      signedIn: true,
                      userId: "stale-user",
                      email: "stale@example.com",
                      source: "device",
                    },
              },
              statusHints: {},
            };
          }
          if (action === "cancelLogin") {
            return {
              domain: "account",
              action,
              result: { signedIn: true, source: "device" },
              statusHints: {},
            };
          }
        }
        throw new Error(`Unexpected method: ${request.method}`);
      }) as any,
    });
    const previousToken = process.env.ADE_ACCOUNT_TOKEN;
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      delete process.env.ADE_ACCOUNT_TOKEN;
      const result = await runCli(["--socket", socketPath, "login", "--headless", "--text"]);
      expect(result).toEqual({
        output: "Signed in as deadline@example.com (device)\n",
        exitCode: 0,
      });
      expect(requests.filter((request) => request.method === "account.call")
        .map((request) => request.params?.action)).toEqual([
        "startDeviceLogin",
        "pollDeviceLogin",
        "pollDeviceLogin",
      ]);

      requests.length = 0;
      completeCurrentSessionAtDeadline = false;
      devicePollCount = 0;
      const staleAccountResult = await runCli([
        "--socket",
        socketPath,
        "login",
        "--headless",
        "--text",
      ]);
      expect(staleAccountResult).toEqual({
        output: "Not signed in — local use does not require an account.\n",
        exitCode: 1,
      });
      expect(requests.filter((request) => request.method === "account.call")
        .map((request) => request.params?.action)).toEqual([
        "startDeviceLogin",
        "pollDeviceLogin",
        "pollDeviceLogin",
        "cancelLogin",
      ]);
    } finally {
      stderrWrite.mockRestore();
      if (previousToken === undefined) delete process.env.ADE_ACCOUNT_TOKEN;
      else process.env.ADE_ACCOUNT_TOKEN = previousToken;
      stop?.();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  posixIt("keeps loopback login active when browser and device startup both fail", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-account-login-sock-"));
    const socketPath = path.join(root, "ade.sock");
    const authorizeUrl = "https://accounts.example/authorize";
    const requests: Array<{ method: string; params?: any }> = [];
    const stop = await startHeadlessRpcSocketServer({
      socketPath,
      createHandler: () => (async (request: any) => {
        requests.push({ method: request.method, params: request.params });
        if (request.method === "ade/initialize") {
          return {
            runtimeInfo: {
              version: process.env.ADE_CLI_VERSION?.trim() || "0.0.0",
              buildHash: null,
              defaultRole: "cto",
              packageChannel: null,
              projectRoot: null,
              pid: process.pid,
            },
          };
        }
        if (request.method === "account.call") {
          const action = request.params?.action;
          if (action === "status") {
            return {
              domain: "account",
              action,
              result: {
                signedIn: false,
                userId: null,
                email: null,
                name: null,
                expiresAt: null,
                source: null,
              },
              statusHints: {},
            };
          }
          if (action === "startLogin") {
            return {
              domain: "account",
              action,
              result: {
                sessionId: "loopback-1",
                authorizeUrl,
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              },
              statusHints: {},
            };
          }
          if (action === "startDeviceLogin") {
            throw new Error("ADE account device login is not configured.");
          }
          if (action === "pollLogin") {
            return {
              domain: "account",
              action,
              result: {
                status: "signed_in",
                authStatus: {
                  signedIn: true,
                  email: "person@example.com",
                  source: "loopback",
                },
              },
              statusHints: {},
            };
          }
        }
        throw new Error(`Unexpected method: ${request.method}`);
      }) as any,
    });
    const envKeys = [
      "ADE_ACCOUNT_TOKEN",
      "DISPLAY",
      "PATH",
      "SSH_CLIENT",
      "SSH_CONNECTION",
      "SSH_TTY",
      "WAYLAND_DISPLAY",
    ] as const;
    const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      delete process.env.ADE_ACCOUNT_TOKEN;
      process.env.DISPLAY = ":0";
      process.env.PATH = "";
      delete process.env.SSH_CLIENT;
      delete process.env.SSH_CONNECTION;
      delete process.env.SSH_TTY;
      delete process.env.WAYLAND_DISPLAY;

      const result = await runCli([
        "--socket",
        socketPath,
        "login",
        "--max-wait",
        "2",
        "--text",
      ]);

      expect(result).toEqual({
        output: "Signed in as person@example.com (loopback)\n",
        exitCode: 0,
      });
      const accountActions = requests
        .filter((request) => request.method === "account.call")
        .map((request) => request.params?.action);
      expect(accountActions).toEqual(["status", "startLogin", "startDeviceLogin", "pollLogin"]);
      expect(stderrWrite.mock.calls.flat().join("")).toContain(authorizeUrl);
    } finally {
      stderrWrite.mockRestore();
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      stop?.();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  posixIt("advises starting the machine brain when a personal chat connection fails", async () => {
    const socketPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-personal-chat-missing-")),
      "missing.sock",
    );
    try {
      await runCli([
        "--socket",
        socketPath,
        "--timeout-ms",
        "25",
        "chat",
        "list",
        "--personal",
      ]);
      throw new Error("Expected the personal chat command to fail without a machine brain.");
    } catch (error) {
      expect((error as { details?: { nextAction?: string } }).details?.nextAction).toContain(
        "ade brain start",
      );
    } finally {
      fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
    }
  });

  it("requires a chat session id for chat show", () => {
    expect(() => buildCliPlan(["chat", "show"])).toThrow(
      /sessionId is required/,
    );
  });

  it("builds chat slash commands for a positional session id", () => {
    const plan = buildCliPlan(["chat", "slash", "chat-1"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("chat slash commands");
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "chat",
        action: "getSlashCommands",
        args: { sessionId: "chat-1" },
      },
    });
    expect(() => buildCliPlan(["chat", "slash"])).toThrow(
      /sessionId is required/,
    );
  });

  it("builds typed Codex goal chat commands", () => {
    const setGoal = expectExecutePlan(buildCliPlan([
      "chat",
      "goal",
      "chat-1",
      "--objective",
      "Ship the Codex upgrade",
    ]));
    expect(setGoal.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "chat",
        action: "setCodexGoal",
        args: {
          sessionId: "chat-1",
          objective: "Ship the Codex upgrade",
        },
      },
    });

    const pause = expectExecutePlan(buildCliPlan(["chat", "goal", "chat-1", "--status", "paused"]));
    expect(pause.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "chat",
        action: "setCodexGoalStatus",
        args: {
          sessionId: "chat-1",
          status: "paused",
        },
      },
    });

    const inspect = expectExecutePlan(buildCliPlan(["chat", "goal", "chat-1"]));
    expect(inspect.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "chat",
        action: "getCodexGoal",
        args: { sessionId: "chat-1" },
      },
    });

    const clear = expectExecutePlan(buildCliPlan(["chat", "clear-goal", "chat-1"]));
    expect(clear.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "chat",
        action: "clearCodexGoal",
        args: { sessionId: "chat-1" },
      },
    });

    expect(() => buildCliPlan(["chat", "goal", "chat-1", "--status", "done"]))
      .toThrow(/status must be active, paused, blocked, or complete/);
  });

  it("builds typed chat handoff and fork commands", () => {
    const handoff = expectExecutePlan(buildCliPlan([
      "chat",
      "handoff",
      "chat-1",
      "--model",
      "openai/gpt-5.5-codex",
      "--reasoning-effort",
      "xhigh",
      "--no-fast",
      "--note",
      "Focus on the failing handoff tests first.",
    ]));
    expect(handoff.label).toBe("chat handoff");
    expect(handoff.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "chat",
        action: "handoffSession",
        args: {
          sourceSessionId: "chat-1",
          targetModelId: "openai/gpt-5.5-codex",
          mode: "brief",
          reasoningEffort: "xhigh",
          fastMode: false,
          codexFastMode: false,
          handoffNote: "Focus on the failing handoff tests first.",
        },
      },
    });

    const fork = expectExecutePlan(buildCliPlan([
      "chat",
      "fork",
      "chat-1",
      "openai/gpt-5.5-codex",
      "--permissions",
      "full-auto",
      "--sandbox",
      "danger-full-access",
    ]));
    expect(fork.label).toBe("chat fork");
    expect(fork.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "chat",
        action: "handoffSession",
        args: {
          sourceSessionId: "chat-1",
          targetModelId: "openai/gpt-5.5-codex",
          mode: "fork",
          permissionMode: "full-auto",
          codexSandbox: "danger-full-access",
        },
      },
    });
  });

  it("passes --target-lane through a brief handoff and rejects it for fork", () => {
    const handoff = expectExecutePlan(buildCliPlan([
      "chat",
      "handoff",
      "chat-1",
      "--model",
      "openai/gpt-5.5-codex",
      "--target-lane",
      "lane-42",
    ]));
    expect(handoff.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "chat",
        action: "handoffSession",
        args: {
          sourceSessionId: "chat-1",
          targetModelId: "openai/gpt-5.5-codex",
          mode: "brief",
          targetLaneId: "lane-42",
        },
      },
    });

    expect(() =>
      buildCliPlan([
        "chat",
        "fork",
        "chat-1",
        "openai/gpt-5.5-codex",
        "--target-lane",
        "lane-42",
      ]),
    ).toThrow(/--target-lane is only valid for brief handoffs/);
  });

  it("builds typed chat rewind and subagent commands", () => {
    const rewind = expectExecutePlan(buildCliPlan([
      "chat",
      "rewind-files",
      "chat-1",
      "--message",
      "user-msg-1",
      "--dry-run",
    ]));
    expect(rewind.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "chat",
        action: "rewindFiles",
        args: {
          sessionId: "chat-1",
          userMessageId: "user-msg-1",
          dryRun: true,
        },
      },
    });

    const list = expectExecutePlan(buildCliPlan(["chat", "subagents", "chat-1"]));
    expect(list.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "chat",
        action: "listSubagents",
        args: { sessionId: "chat-1" },
      },
    });

    const transcript = expectExecutePlan(buildCliPlan([
      "chat",
      "subagent-transcript",
      "chat-1",
      "--agent",
      "agent-1",
      "--limit",
      "25",
    ]));
    expect(transcript.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "chat",
        action: "getSubagentTranscript",
        args: {
          sessionId: "chat-1",
          agentId: "agent-1",
          limit: 25,
        },
      },
    });
  });

  it("builds typed chat schedules pause/resume/inspect commands", () => {
    const pause = expectExecutePlan(buildCliPlan(["chat", "schedules", "chat-1", "--pause"]));
    expect(pause.label).toBe("chat schedules pause");
    expect(pause.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "chat",
        action: "setScheduledWorkPaused",
        args: { sessionId: "chat-1", paused: true },
      },
    });

    const resume = expectExecutePlan(buildCliPlan(["chat", "schedules", "chat-1", "--resume"]));
    expect(resume.label).toBe("chat schedules resume");
    expect(resume.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "chat",
        action: "setScheduledWorkPaused",
        args: { sessionId: "chat-1", paused: false },
      },
    });

    const inspect = expectExecutePlan(buildCliPlan(["chat", "schedules", "chat-1"]));
    expect(inspect.label).toBe("chat schedules");
    expect(inspect.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "chat",
        action: "getSessionSummary",
        argsList: ["chat-1"],
      },
    });

    expect(() => buildCliPlan(["chat", "schedules", "chat-1", "--pause", "--resume"])).toThrow(
      /either --pause or --resume/,
    );

    const list = expectExecutePlan(buildCliPlan(["chat", "scheduled-work", "list", "chat-1", "--all"]));
    expect(list.label).toBe("chat scheduled-work list");
    expect(list.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "chat",
        action: "listScheduledWork",
        args: { sessionId: "chat-1", includeTerminal: true },
      },
    });

    const listAllChats = expectExecutePlan(buildCliPlan(["chat", "scheduled-work", "list", "--all"]));
    expect(listAllChats.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "chat",
        action: "listScheduledWork",
        args: { includeTerminal: true },
      },
    });

    for (const alias of ["schedule", "schedules"]) {
      expect(expectExecutePlan(buildCliPlan(["chat", alias, "list", "chat-1"])).steps[0]?.params)
        .toMatchObject({
          arguments: {
            action: "listScheduledWork",
            args: { sessionId: "chat-1" },
          },
        });
      expect(expectExecutePlan(buildCliPlan(["chat", alias, "cancel", "chat-1", "cron-1"])).steps[0]?.params)
        .toMatchObject({
          arguments: {
            action: "cancelScheduledWork",
            args: { sessionId: "chat-1", scheduleId: "cron-1" },
          },
        });
    }

    const cancel = expectExecutePlan(buildCliPlan([
      "chat",
      "scheduled-work",
      "cancel",
      "chat-1",
      "cron-1",
    ]));
    expect(cancel.label).toBe("chat scheduled-work cancel");
    expect(cancel.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "chat",
        action: "cancelScheduledWork",
        args: { sessionId: "chat-1", scheduleId: "cron-1" },
      },
    });
    expect(() => buildCliPlan(["chat", "scheduled-work", "cancel", "chat-1"])).toThrow(
      /scheduleId is required/,
    );
  });

  it("rejects prototype-sensitive generic ADE action arg paths", () => {
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    for (const arg of [
      "__proto__.polluted=true",
      "safe.__proto__.polluted=true",
      "constructor.prototype.polluted=true",
    ]) {
      expect(() =>
        buildCliPlan(["actions", "run", "git.status", "--arg", arg]),
      ).toThrow(/not allowed/);
    }

    expect(() =>
      buildCliPlan([
        "actions",
        "run",
        "git.status",
        "--arg-json",
        "prototype.polluted=true",
      ]),
    ).toThrow(/not allowed/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("validates required arguments before service execution", () => {
    expect(() => buildCliPlan(["lanes", "create"])).toThrow(/name is required/);
    expect(() => buildCliPlan(["lanes", "child", "--name", "child"])).toThrow(
      /parent lane is required/,
    );
    expect(() => buildCliPlan(["diff", "file", "--lane", "main"])).toThrow(
      /path is required/,
    );
    expect(() => buildCliPlan(["diff", "patch", "--lane", "main"])).toThrow(
      /path is required/,
    );
    expect(() => buildCliPlan(["files", "write", "src/index.ts"])).toThrow(
      /--text, --from-file, or --stdin/,
    );
    expect(() => buildCliPlan(["chat", "send", "hello"])).toThrow(
      /message text is required/,
    );
    expect(() =>
      buildCliPlan(["agent", "spawn", "--prompt", "fix it"]),
    ).toThrow(/laneId is required/);
    expect(() => buildCliPlan(["tests", "run", "--lane", "main"])).toThrow(
      /--suite <id> or --command/,
    );
  });

  it("unwraps typed ADE action results while preserving actions run envelopes", () => {
    const connection = {
      mode: "headless" as const,
      projectRoot: "/tmp/project",
      workspaceRoot: "/tmp/project",
      socketPath: "/tmp/project/.ade/ade.sock",
      request: async () => null,
      close: () => {},
    };

    const typed = summarizeExecution({
      plan: { kind: "execute", label: "git status", steps: [] },
      connection,
      values: {
        result: {
          domain: "git",
          action: "getStatus",
          result: { clean: true },
          statusHints: {},
        },
      },
    } as any);
    expect(typed).toEqual({ clean: true });

    const escapeHatch = summarizeExecution({
      plan: { kind: "execute", label: "action run", steps: [] },
      connection,
      values: {
        result: {
          domain: "git",
          action: "getStatus",
          result: { clean: true },
          statusHints: {},
        },
      },
    } as any);
    expect(escapeHatch).toMatchObject({
      domain: "git",
      action: "getStatus",
      result: { clean: true },
    });

    for (const mode of ["headless", "desktop-socket"] as const) {
      const chatConnection = { ...connection, mode };
      const chatCreateWithKickoff = summarizeExecution({
        plan: { kind: "execute", label: "chat create", steps: [] },
        connection: chatConnection,
        values: {
          session: {
            domain: "chat",
            action: "createSession",
            result: { sessionId: "chat-new" },
          },
          result: {
            domain: "chat",
            action: "sendMessage",
            result: { ok: true, accepted: true, sessionId: "chat-new" },
          },
        },
      } as any);
      expect(chatCreateWithKickoff).toEqual({
        ok: true,
        session: { sessionId: "chat-new" },
        kickoff: { ok: true, accepted: true, sessionId: "chat-new" },
      });

      const newChatWithLaneAndKickoff = summarizeExecution({
        plan: { kind: "execute", label: "new chat", steps: [] },
        connection: chatConnection,
        values: {
          lane: { id: "lane-new", name: "fix-login" },
          session: {
            domain: "chat",
            action: "createSession",
            result: { sessionId: "chat-new" },
          },
          result: {
            domain: "chat",
            action: "sendMessage",
            result: { ok: true, accepted: true, sessionId: "chat-new" },
          },
        },
      } as any);
      expect(newChatWithLaneAndKickoff).toEqual({
        ok: true,
        lane: { id: "lane-new", name: "fix-login" },
        session: { sessionId: "chat-new" },
        kickoff: { ok: true, accepted: true, sessionId: "chat-new" },
      });

      const chatRead = summarizeExecution({
        plan: { kind: "execute", label: "chat read", steps: [] },
        connection: chatConnection,
        values: {
          result: {
            domain: "chat",
            action: "readTranscript",
            result: { entries: [{ role: "user", text: mode }] },
          },
        },
      } as any);
      expect(chatRead).toEqual({ entries: [{ role: "user", text: mode }] });
    }
  });


  it("turns ADE action failure envelopes into CLI tool errors", () => {
    expect(() =>
      unwrapToolResult({
        ok: false,
        error: {
          code: -32011,
          message: "Action 'git.nonexistent_action' is not callable.",
        },
      }),
    ).toThrow(/not callable/);
  });

  it("renders richer doctor text", () => {
    const output = formatOutput(
      {
        ok: true,
        cliVersion: "0.0.0",
        mode: "headless",
        projectRoot: "/tmp/project",
        workspaceRoot: "/tmp/project",
        project: { projectInitialized: true },
        desktop: {
          socketAvailable: false,
          socketPath: "/tmp/project/.ade/ade.sock",
        },
        actions: { rpcActionCount: 10, actionCount: 42 },
        git: { message: "Git repository detected on main." },
        github: {
          message:
            "GitHub remote detected and a local auth mechanism is available.",
        },
        linear: { message: "Linear credentials are present locally." },
        providers: {
          message:
            "AI provider configuration or provider CLI availability was detected locally.",
        },
        computerUse: {
          message: "Local macOS computer-use fallback commands are available.",
        },
        path: { message: "ade is available on PATH." },
        recommendation: "Using live ADE desktop state.",
        recommendations: [],
      },
      {
        projectRoot: null,
        workspaceRoot: null,
        role: "agent",
        headless: false,
        requireSocket: false,
        socketPath: null,
        pretty: true,
        text: true,
        timeoutMs: 1000,
      },
      "doctor",
    );

    expect(output).toContain("ADE doctor");
    expect(output).toContain("cli version");
    expect(output).toContain("service actions");
    expect(output).toContain("Git repository detected");
  });

  it("adds sync route health to doctor and names a loopback listener mismatch", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-doctor-sync-"));
    fs.mkdirSync(path.join(projectRoot, ".ade"), { recursive: true });
    try {
      const plan = expectExecutePlan(buildCliPlan(["doctor"]));
      expect(plan.steps).toContainEqual({
        key: "syncStatus",
        method: "sync.getStatus",
        params: { includeTransferReadiness: false },
        optional: true,
      });
      const summary = summarizeExecution({
        plan,
        connection: {
          mode: "runtime-socket",
          projectRoot,
          workspaceRoot: projectRoot,
          socketPath: path.join(projectRoot, ".ade", "ade.sock"),
        },
        values: {
          rpcActions: { actions: [{}] },
          actions: { actions: [{}] },
          syncStatus: {
            pairingConnectInfo: { port: 8787 },
            routeHealth: {
              listener: {
                listenerBound: true,
                loopbackAdeValidated: false,
                reason: "Expected ADE 426 Upgrade Required; received 404 Not Found.",
              },
              tailscale: {
                enabled: true,
                tailscaleReachable: false,
                reason: "Tailscale route points at the listener mismatch.",
              },
              relay: {
                enabled: true,
                relayControlConnected: true,
                relayBridgeValidated: false,
                reason: "Relay bridge refused the listener mismatch.",
              },
            },
          },
        },
      } as any) as Record<string, any>;

      expect(summary.sync).toMatchObject({
        enabled: true,
        usable: false,
        status: "warning",
      });
      expect(summary.sync.failingRoutes).toEqual([
        expect.stringContaining("listener"),
        expect.stringContaining("tailscale"),
        expect.stringContaining("relay"),
      ]);
      expect(summary.sync.message).toContain("404 Not Found");
      const output = formatOutput(summary, {
        projectRoot,
        workspaceRoot: projectRoot,
        role: "agent",
        headless: false,
        requireSocket: false,
        socketPath: null,
        pretty: true,
        text: true,
        timeoutMs: 1000,
      }, "doctor");
      expect(output).toContain("Sync route failure");
      expect(output).toContain("listener");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("detects project-local Linear credentials in doctor readiness", () => {
    const previousAdeLinearApi = process.env.ADE_LINEAR_API;
    const previousLinearApiKey = process.env.LINEAR_API_KEY;
    const previousAdeLinearToken = process.env.ADE_LINEAR_TOKEN;
    const previousLinearToken = process.env.LINEAR_TOKEN;
    delete process.env.ADE_LINEAR_API;
    delete process.env.LINEAR_API_KEY;
    delete process.env.ADE_LINEAR_TOKEN;
    delete process.env.LINEAR_TOKEN;
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-linear-readiness-"));
    const store = new EncryptedFileCredentialStore({
      secretsDir: path.join(projectRoot, ".ade", "secrets"),
    });
    store.setSync("linear.token.v1", "lin_project_token");

    try {
      const readiness = checkLinearReadiness(projectRoot);
      expect(readiness.ready).toBe(true);
      expect(readiness.details).toMatchObject({
        projectCredentialStoreTokenPresent: true,
        tokenEnvPresent: false,
      });
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      if (previousAdeLinearApi === undefined) delete process.env.ADE_LINEAR_API;
      else process.env.ADE_LINEAR_API = previousAdeLinearApi;
      if (previousLinearApiKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = previousLinearApiKey;
      if (previousAdeLinearToken === undefined) delete process.env.ADE_LINEAR_TOKEN;
      else process.env.ADE_LINEAR_TOKEN = previousAdeLinearToken;
      if (previousLinearToken === undefined) delete process.env.LINEAR_TOKEN;
      else process.env.LINEAR_TOKEN = previousLinearToken;
    }
  });

  it("attempts Windows named-pipe desktop sockets without filesystem existence checks", () => {
    expect(shouldAttemptDesktopSocketConnection("\\\\.\\pipe\\ade-123")).toBe(
      true,
    );
    expect(shouldAttemptDesktopSocketConnection("//./pipe/ade-123")).toBe(true);
  });

  it("renders a compact lane graph", () => {
    const graph = renderLaneGraph({
      lanes: [
        { id: "main", name: "main", branchRef: "main" },
        {
          id: "child",
          name: "child",
          branchRef: "feature",
          parentLaneId: "main",
        },
        {
          id: "sibling",
          name: "sibling",
          branchRef: "feature-2",
          parentLaneId: "main",
        },
      ],
    });

    expect(graph).toContain("ADE lanes");
    expect(graph).toContain("\\- main (id: main) [main]");
    expect(graph).toContain("|- child (id: child) [feature]");
    expect(graph).toContain("\\- sibling (id: sibling) [feature-2]");
  });

  it("renders linked Linear issue identifiers in lane graph and detail text", () => {
    const lane = {
      id: "lane-linear",
      name: "ADE-69 Fix linked lane",
      branchRef: "ade-69-fix-linked-lane",
      linearIssue: {
        id: "issue-69",
        identifier: "ADE-69",
        title: "Fix linked lane",
      },
      linearIssueLinks: [
        {
          id: "link-70",
          issue: { id: "issue-70", identifier: "ADE-70", title: "Follow-up" },
        },
      ],
    };

    expect(renderLaneGraph({ lanes: [lane] })).toContain(
      "\\- ADE-69 Fix linked lane (id: lane-linear) [ade-69-fix-linked-lane] {ADE-69, ADE-70}",
    );

    const detail = formatOutput(
      { lane },
      {
        projectRoot: null,
        workspaceRoot: null,
        role: "agent",
        headless: false,
        requireSocket: false,
        socketPath: null,
        pretty: false,
        text: true,
        timeoutMs: 1000,
      },
      "lane-detail",
    );
    expect(detail).toContain("linear issue");
    expect(detail).toContain("ADE-69: Fix linked lane");
    expect(detail).toContain("ADE-70: Follow-up");
  });

  it("accepts --option=value syntax equivalently to --option value", () => {
    const spaced = parseCliArgs([
      "--project-root",
      "/tmp/project",
      "--role",
      "cto",
      "lanes",
      "list",
    ]);
    const joined = parseCliArgs([
      "--project-root=/tmp/project",
      "--role=cto",
      "lanes",
      "list",
    ]);
    expect(joined.options.projectRoot).toBe(spaced.options.projectRoot);
    expect(joined.options.role).toBe("cto");
    expect(joined.command).toEqual(["lanes", "list"]);
  });

  it("prefers headless mode for local proof capture commands", () => {
    const screenshot = buildCliPlan(["proof", "screenshot"]);
    const capture = buildCliPlan([
      "proof",
      "capture",
      "--caption",
      "Done",
      "--owner-kind",
      "chat",
      "--owner-id",
      "chat-1",
    ]);
    const record = buildCliPlan(["proof", "record", "--seconds", "3"]);
    const list = buildCliPlan(["proof", "list"]);

    expect(screenshot.kind).toBe("execute");
    expect(capture.kind).toBe("execute");
    expect(record.kind).toBe("execute");
    expect(list.kind).toBe("execute");
    if (
      screenshot.kind !== "execute" ||
      capture.kind !== "execute" ||
      record.kind !== "execute" ||
      list.kind !== "execute"
    )
      return;

    expect(screenshot.preferHeadless).toBe(true);
    expect(capture.preferHeadless).toBe(true);
    expect(capture.steps[0]?.params).toMatchObject({
      name: "screenshot_environment",
      arguments: {
        name: "Done",
        ownerKind: "chat",
        ownerId: "chat-1",
      },
    });
    expect(record.preferHeadless).toBe(true);
    expect(list.preferHeadless).toBeUndefined();
  });

  it("maps proof attach to visual artifact ingestion", () => {
    const plan = buildCliPlan([
      "proof",
      "attach",
      "/tmp/done.png",
      "--caption",
      "Checkout complete",
      "--owner-kind",
      "chat",
      "--owner-id",
      "chat-1",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;

    expect(plan.steps[0]?.params).toMatchObject({
      name: "ingest_computer_use_artifacts",
      arguments: {
        backendStyle: "manual",
        backendName: "ade-cli",
        toolName: "proof attach",
        ownerKind: "chat",
        ownerId: "chat-1",
        inputs: [
          {
            kind: "screenshot",
            title: "Checkout complete",
            description: "Checkout complete",
            path: "/tmp/done.png",
          },
        ],
      },
    });
  });

  it("rejects invalid --role values", () => {
    expect(() => parseCliArgs(["--role", "bogus", "lanes", "list"])).toThrow(
      /--role must be one of/,
    );
  });

  it("maps default lanes/git/prs subcommands to the right RPC actions", () => {
    const lanes = buildCliPlan(["lanes", "list"]);
    expect(lanes.kind).toBe("execute");
    if (lanes.kind !== "execute") return;
    expect(lanes.visualizer).toBe("lanes");
    expect(lanes.steps[0]?.params).toEqual({
      name: "list_lanes",
      arguments: { includeArchived: false },
    });

    const git = buildCliPlan(["git", "status"]);
    expect(git.kind).toBe("execute");
    if (git.kind !== "execute") return;
    expect(git.steps[0]?.params).toEqual({
      name: "git_get_sync_status",
      arguments: {},
    });

    const prs = buildCliPlan(["prs", "list"]);
    expect(prs.kind).toBe("execute");
    if (prs.kind !== "execute") return;
    expect(prs.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: { domain: "pr", action: "listAll", args: {} },
    });
  });

  it("maps git user-identity and prs list-open to typed RPC tools", () => {
    const identity = buildCliPlan(["git", "user-identity"]);
    expect(identity.kind).toBe("execute");
    if (identity.kind !== "execute") return;
    expect(identity.steps[0]?.params).toEqual({
      name: "git_get_user_identity",
      arguments: {},
    });

    const openPrs = buildCliPlan(["prs", "list-open"]);
    expect(openPrs.kind).toBe("execute");
    if (openPrs.kind !== "execute") return;
    expect(openPrs.steps[0]?.params).toEqual({
      name: "prs_list_open",
      arguments: {},
    });
  });

  it("forwards lane reparent stack base branch override to the runtime action", () => {
    const reparent = buildCliPlan([
      "lanes",
      "reparent",
      "lane-child",
      "--parent",
      "lane-parent",
      "--stack-base-branch",
      "develop",
    ]);
    expect(reparent.kind).toBe("execute");
    if (reparent.kind !== "execute") return;
    expect(reparent.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "lane",
        action: "reparent",
        args: {
          laneId: "lane-child",
          newParentLaneId: "lane-parent",
          stackBaseBranchRef: "develop",
        },
      },
    });

    const reparentDefault = buildCliPlan([
      "lanes",
      "reparent",
      "lane-child",
      "--parent",
      "lane-parent",
    ]);
    expect(reparentDefault.kind).toBe("execute");
    if (reparentDefault.kind !== "execute") return;
    expect(reparentDefault.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "lane",
        action: "reparent",
        args: {
          laneId: "lane-child",
          newParentLaneId: "lane-parent",
        },
      },
    });
  });

  it("maps lane delete flags to the shared lane action", () => {
    const plan = buildCliPlan([
      "lanes",
      "delete",
      "lane-old",
      "--force",
      "--delete-branch",
      "--delete-remote-branch",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") throw new Error(`expected execute plan, got ${plan.kind}`);
    expect(plan.label).toBe("lane delete");
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "lane",
        action: "delete",
        args: {
          laneId: "lane-old",
          force: true,
          deleteBranch: true,
          deleteRemoteBranch: true,
        },
      },
    });
  });

  it("forwards PR GitHub snapshot full-history flag to the runtime action", () => {
    const snapshot = buildCliPlan([
      "prs",
      "github-snapshot",
      "--include-external-closed",
    ]);
    expect(snapshot.kind).toBe("execute");
    if (snapshot.kind !== "execute") return;
    expect(snapshot.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "pr",
        action: "getGithubSnapshot",
        args: {
          force: false,
          includeExternalClosed: true,
        },
      },
    });
  });

  it("maps discoverable git status, sync, and conflict helpers to existing actions", () => {
    const fullStatus = buildCliPlan([
      "git",
      "status",
      "--full",
      "--lane",
      "lane-1",
    ]);
    expect(fullStatus.kind).toBe("execute");
    if (fullStatus.kind !== "execute") return;
    expect(fullStatus.label).toBe("lane status");
    expect(fullStatus.steps[0]?.params).toEqual({
      name: "get_lane_status",
      arguments: { laneId: "lane-1" },
    });

    const sync = buildCliPlan([
      "git",
      "sync",
      "--lane",
      "lane-1",
      "--rebase",
      "--base",
      "main",
    ]);
    expect(sync.kind).toBe("execute");
    if (sync.kind !== "execute") return;
    expect(sync.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "git",
        action: "sync",
        args: { laneId: "lane-1", mode: "rebase", baseRef: "main" },
      },
    });

    const pull = buildCliPlan([
      "git",
      "pull",
      "--lane",
      "lane-1",
      "--rebase",
    ]);
    expect(pull.kind).toBe("execute");
    if (pull.kind !== "execute") return;
    expect(pull.steps[0]?.params).toEqual({
      name: "git_pull",
      arguments: { laneId: "lane-1", mode: "rebase" },
    });
    expect(() =>
      buildCliPlan([
        "git",
        "pull",
        "--lane",
        "lane-1",
        "--mode",
        "merge",
        "--rebase",
      ]),
    ).toThrow(/either --mode or a mode flag/);

    const undo = buildCliPlan([
      "git",
      "undo",
      "--lane",
      "lane-1",
    ]);
    expect(undo.kind).toBe("execute");
    if (undo.kind !== "execute") return;
    expect(undo.steps[0]?.params).toEqual({
      name: "git_undo_last_head_change",
      arguments: { laneId: "lane-1" },
    });

    const redo = buildCliPlan([
      "git",
      "redo",
      "--lane",
      "lane-1",
    ]);
    expect(redo.kind).toBe("execute");
    if (redo.kind !== "execute") return;
    expect(redo.steps[0]?.params).toEqual({
      name: "git_redo_last_head_change",
      arguments: { laneId: "lane-1" },
    });

    const conflictShow = buildCliPlan([
      "git",
      "conflict",
      "show",
      "--lane",
      "lane-1",
    ]);
    expect(conflictShow.kind).toBe("execute");
    if (conflictShow.kind !== "execute") return;
    expect(conflictShow.steps[0]?.params).toEqual({
      name: "get_lane_conflict_state",
      arguments: { laneId: "lane-1" },
    });

    const conflictResolve = buildCliPlan([
      "git",
      "conflict",
      "resolve",
      "--lane",
      "lane-1",
      "--kind",
      "rebase",
    ]);
    expect(conflictResolve.kind).toBe("execute");
    if (conflictResolve.kind !== "execute") return;
    expect(conflictResolve.steps[0]?.params).toEqual({
      name: "rebase_continue",
      arguments: { laneId: "lane-1" },
    });

    const push = buildCliPlan([
      "git",
      "push",
      "--lane",
      "lane-1",
      "--set-upstream",
      "--force-with-lease",
    ]);
    expect(push.kind).toBe("execute");
    if (push.kind !== "execute") return;
    expect(push.steps[0]?.params).toEqual({
      name: "git_push",
      arguments: { laneId: "lane-1", forceWithLease: true, setUpstream: true },
    });

    const tag = buildCliPlan([
      "git",
      "tag",
      "abc123",
      "--name",
      "v1.2.3",
      "--message",
      "Release 1.2.3",
      "--lane",
      "lane-1",
    ]);
    expect(tag.kind).toBe("execute");
    if (tag.kind !== "execute") return;
    expect(tag.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "git",
        action: "createTag",
        args: { laneId: "lane-1", commitSha: "abc123", tagName: "v1.2.3", message: "Release 1.2.3" },
      },
    });

    const reset = buildCliPlan([
      "git",
      "reset",
      "def456",
      "--hard",
      "--lane",
      "lane-1",
    ]);
    expect(reset.kind).toBe("execute");
    if (reset.kind !== "execute") return;
    expect(reset.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "git",
        action: "resetToCommit",
        args: { laneId: "lane-1", commitSha: "def456", mode: "hard" },
      },
    });

    const reachable = buildCliPlan([
      "git",
      "is-reachable",
      "fed789",
      "--lane",
      "lane-1",
    ]);
    expect(reachable.kind).toBe("execute");
    if (reachable.kind !== "execute") return;
    expect(reachable.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "git",
        action: "isCommitInLaneHistory",
        args: { laneId: "lane-1", commitSha: "fed789" },
      },
    });
  });

  it("resolves stash OIDs before CLI pop and drop actions", () => {
    const pop = buildCliPlan([
      "git",
      "stash",
      "pop",
      "stash@{0}",
      "--lane",
      "lane-1",
    ]);
    expect(pop.kind).toBe("execute");
    if (pop.kind !== "execute") return;
    expect(pop.steps[0]?.params).toEqual({
      name: "list_stashes",
      arguments: { laneId: "lane-1" },
    });
    const popParams = typeof pop.steps[1]?.params === "function"
      ? pop.steps[1].params({ stashes: { stashes: [{ ref: "stash@{0}", oid: "oid-0" }] } })
      : pop.steps[1]?.params;
    expect(popParams).toEqual({
      name: "stash_pop",
      arguments: {
        laneId: "lane-1",
        stashRef: "stash@{0}",
        stashOid: "oid-0",
      },
    });

    const drop = buildCliPlan([
      "git",
      "stash",
      "drop",
      "stash@{1}",
      "--lane",
      "lane-1",
    ]);
    expect(drop.kind).toBe("execute");
    if (drop.kind !== "execute") return;
    const dropParams = typeof drop.steps[1]?.params === "function"
      ? drop.steps[1].params({ stashes: { stashes: [{ ref: "stash@{1}", oid: "oid-1" }] } })
      : drop.steps[1]?.params;
    expect(dropParams).toEqual({
      name: "stash_drop",
      arguments: {
        laneId: "lane-1",
        stashRef: "stash@{1}",
        stashOid: "oid-1",
      },
    });
  });

  it("uses the latest lane stash when CLI pop omits a stash ref", () => {
    const plan = buildCliPlan([
      "git",
      "stash",
      "pop",
      "--lane",
      "lane-1",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    const params = typeof plan.steps[1]?.params === "function"
      ? plan.steps[1].params({ stashes: { stashes: [{ ref: "stash@{3}", oid: "oid-3" }] } })
      : plan.steps[1]?.params;
    expect(params).toEqual({
      name: "stash_pop",
      arguments: {
        laneId: "lane-1",
        stashRef: "stash@{3}",
        stashOid: "oid-3",
      },
    });
  });

  it("resolves a stash ref from an explicit OID when CLI stash omits the ref", () => {
    const plan = buildCliPlan([
      "git",
      "stash",
      "drop",
      "--stash-oid",
      "oid-3",
      "--lane",
      "lane-1",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    const params = typeof plan.steps[1]?.params === "function"
      ? plan.steps[1].params({
        stashes: {
          stashes: [
            { ref: "stash@{0}", oid: "oid-0" },
            { ref: "stash@{3}", oid: "oid-3" },
          ],
        },
      })
      : plan.steps[1]?.params;
    expect(params).toEqual({
      name: "stash_drop",
      arguments: {
        laneId: "lane-1",
        stashRef: "stash@{3}",
        stashOid: "oid-3",
      },
    });
  });

  it("keeps explicit stash OIDs on direct CLI stash calls", () => {
    const plan = buildCliPlan([
      "git",
      "stash",
      "drop",
      "stash@{0}",
      "--oid",
      "oid-0",
      "--lane",
      "lane-1",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.params).toEqual({
      name: "stash_drop",
      arguments: {
        laneId: "lane-1",
        stashRef: "stash@{0}",
        stashOid: "oid-0",
      },
    });
  });

  it("throws a clear CLI error when a stash ref cannot be resolved to an OID", () => {
    const plan = buildCliPlan([
      "git",
      "stash",
      "pop",
      "stash@{2}",
      "--lane",
      "lane-1",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(() => {
      if (typeof plan.steps[1]?.params !== "function") throw new Error("Expected resolver params.");
      plan.steps[1].params({ stashes: { stashes: [{ ref: "stash@{0}", oid: "oid-0" }] } });
    }).toThrow(/Stash stash@\{2\} is not saved for this lane/);
  });

  it("throws a clear CLI error when a stash OID cannot be resolved to a ref", () => {
    const plan = buildCliPlan([
      "git",
      "stash",
      "drop",
      "--stash-oid",
      "oid-9",
      "--lane",
      "lane-1",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(() => {
      if (typeof plan.steps[1]?.params !== "function") throw new Error("Expected resolver params.");
      plan.steps[1].params({ stashes: { stashes: [{ ref: "stash@{0}", oid: "oid-0" }] } });
    }).toThrow(/Stash OID oid-9 is not saved for this lane/);
  });

  it("throws a clear CLI error when no default lane stash exists", () => {
    const plan = buildCliPlan([
      "git",
      "stash",
      "drop",
      "--lane",
      "lane-1",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(() => {
      if (typeof plan.steps[1]?.params !== "function") throw new Error("Expected resolver params.");
      plan.steps[1].params({ stashes: { stashes: [] } });
    }).toThrow(/No saved stashes were found for this lane/);
  });

  it("preserves the public git push --set-upstream flag", () => {
    const plan = buildCliPlan([
      "git",
      "push",
      "--lane",
      "lane-1",
      "--set-upstream",
      "--force-with-lease",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") throw new Error(`expected execute plan, got ${plan.kind}`);
    expect(plan.steps[0]?.params).toEqual({
      name: "git_push",
      arguments: {
        laneId: "lane-1",
        forceWithLease: true,
        setUpstream: true,
      },
    });
  });

  it("maps action and operation wait aliases to the ADE status poller", () => {
    const actionWait = buildCliPlan([
      "actions",
      "wait",
      "--operation",
      "op-1",
      "--previous-hash",
      "abc",
    ]);
    expect(actionWait.kind).toBe("execute");
    if (actionWait.kind !== "execute") return;
    expect(actionWait.steps[0]?.params).toEqual({
      name: "get_ade_action_status",
      arguments: {
        operationId: "op-1",
        previousHash: "abc",
        waitForMs: 30_000,
      },
    });

    const operationStatus = buildCliPlan([
      "operations",
      "status",
      "--test-run",
      "test-1",
      "--wait-ms",
      "5000",
    ]);
    expect(operationStatus.kind).toBe("execute");
    if (operationStatus.kind !== "execute") return;
    expect(operationStatus.steps[0]?.params).toEqual({
      name: "get_ade_action_status",
      arguments: { testRunId: "test-1", waitForMs: 5000 },
    });
  });

  it("uses the parent ADE project when invoked inside an ADE-managed lane worktree", () => {
    const rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-roots-"));
    // findProjectRoots canonicalizes symlinks (e.g. /var -> /private/var on macOS).
    const root = fs.realpathSync.native(rawRoot);
    const worktree = path.join(root, ".ade", "worktrees", "feature-lane");
    const nested = path.join(worktree, "apps", "ade-cli");
    fs.mkdirSync(path.join(root, ".ade"), { recursive: true });
    fs.mkdirSync(path.join(worktree, ".ade"), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });

    expect(findProjectRoots(nested)).toEqual({
      projectRoot: root,
      workspaceRoot: worktree,
    });
  });

  it("defaults workspaceRoot to projectRoot when ADE_PROJECT_ROOT overrides discovery", () => {
    const prevProject = process.env.ADE_PROJECT_ROOT;
    const prevWorkspace = process.env.ADE_WORKSPACE_ROOT;
    try {
      delete process.env.ADE_WORKSPACE_ROOT;
      process.env.ADE_PROJECT_ROOT = "/explicit/project-root";
      const roots = resolveRoots({
        ...baseResolveOpts(),
        projectRoot: null,
        workspaceRoot: null,
      });
      expect(roots.projectRoot).toBe("/explicit/project-root");
      expect(roots.workspaceRoot).toBe("/explicit/project-root");
    } finally {
      if (prevProject === undefined) delete process.env.ADE_PROJECT_ROOT;
      else process.env.ADE_PROJECT_ROOT = prevProject;
      if (prevWorkspace === undefined) delete process.env.ADE_WORKSPACE_ROOT;
      else process.env.ADE_WORKSPACE_ROOT = prevWorkspace;
    }
  });

  it("defaults workspaceRoot to CLI projectRoot when only --project-root is set", () => {
    const prevProject = process.env.ADE_PROJECT_ROOT;
    const prevWorkspace = process.env.ADE_WORKSPACE_ROOT;
    try {
      delete process.env.ADE_PROJECT_ROOT;
      delete process.env.ADE_WORKSPACE_ROOT;
      const roots = resolveRoots({
        ...baseResolveOpts(),
        projectRoot: "/cli/project-root",
        workspaceRoot: null,
      });
      expect(roots.projectRoot).toBe("/cli/project-root");
      expect(roots.workspaceRoot).toBe("/cli/project-root");
    } finally {
      if (prevProject === undefined) delete process.env.ADE_PROJECT_ROOT;
      else process.env.ADE_PROJECT_ROOT = prevProject;
      if (prevWorkspace === undefined) delete process.env.ADE_WORKSPACE_ROOT;
      else process.env.ADE_WORKSPACE_ROOT = prevWorkspace;
    }
  });

  it("still honors ADE_WORKSPACE_ROOT when both project and workspace overrides exist", () => {
    const prevProject = process.env.ADE_PROJECT_ROOT;
    const prevWorkspace = process.env.ADE_WORKSPACE_ROOT;
    try {
      process.env.ADE_PROJECT_ROOT = "/explicit/project-root";
      process.env.ADE_WORKSPACE_ROOT = "/explicit/workspace-root";
      const roots = resolveRoots({
        ...baseResolveOpts(),
        projectRoot: null,
        workspaceRoot: null,
      });
      expect(roots.projectRoot).toBe("/explicit/project-root");
      expect(roots.workspaceRoot).toBe("/explicit/workspace-root");
    } finally {
      if (prevProject === undefined) delete process.env.ADE_PROJECT_ROOT;
      else process.env.ADE_PROJECT_ROOT = prevProject;
      if (prevWorkspace === undefined) delete process.env.ADE_WORKSPACE_ROOT;
      else process.env.ADE_WORKSPACE_ROOT = prevWorkspace;
    }
  });

  it("maps PR link arguments to the service contract", () => {
    const plan = buildCliPlan([
      "prs",
      "link",
      "--lane",
      "lane-1",
      "--url",
      "https://github.com/acme/ade/pull/123",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;

    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "pr",
        action: "linkToLane",
        args: {
          laneId: "lane-1",
          prUrlOrNumber: "https://github.com/acme/ade/pull/123",
        },
      },
    });
  });

  it("maps `git checkout <branch>` to git_checkout_branch with mode=existing by default", () => {
    const plan = buildCliPlan([
      "git",
      "checkout",
      "feature/foo",
      "--lane",
      "lane-1",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;

    expect(plan.steps[0]?.params).toEqual({
      name: "git_checkout_branch",
      arguments: {
        laneId: "lane-1",
        branchName: "feature/foo",
        mode: "existing",
        acknowledgeActiveWork: false,
      },
    });
  });

  it("maps `git checkout --create` to mode=create with optional --from/--base", () => {
    const plan = buildCliPlan([
      "git",
      "checkout",
      "feature/new",
      "--lane",
      "lane-1",
      "--create",
      "--from",
      "main",
      "--base",
      "main",
      "--ack-active-work",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;

    expect(plan.steps[0]?.params).toEqual({
      name: "git_checkout_branch",
      arguments: {
        laneId: "lane-1",
        branchName: "feature/new",
        mode: "create",
        startPoint: "main",
        baseRef: "main",
        acknowledgeActiveWork: true,
      },
    });
  });

  it("accepts the `-b` short flag as an alias for --create", () => {
    const plan = buildCliPlan([
      "git",
      "checkout",
      "topic-1",
      "--lane",
      "lane-1",
      "-b",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    const args = (
      plan.steps[0]?.params as { arguments: Record<string, unknown> }
    ).arguments;
    expect(args.mode).toBe("create");
    expect(args.branchName).toBe("topic-1");
  });

  it("omits startPoint and baseRef from the call when not supplied", () => {
    const plan = buildCliPlan([
      "git",
      "checkout",
      "feature/x",
      "--lane",
      "lane-1",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    const args = (
      plan.steps[0]?.params as { arguments: Record<string, unknown> }
    ).arguments;
    expect(args).not.toHaveProperty("startPoint");
    expect(args).not.toHaveProperty("baseRef");
  });

  it("rejects `git checkout` without a branch name", () => {
    expect(() => buildCliPlan(["git", "checkout", "--lane", "lane-1"])).toThrow(
      /branchName/,
    );
  });

  it("shows command help from subcommand help flags", () => {
    const prsHelp = buildCliPlan(["prs", "create", "--help"]);
    expect(prsHelp.kind).toBe("help");
    if (prsHelp.kind !== "help") return;
    expect(prsHelp.text).toContain("PR identifiers may be ADE PR ids");
    expect(prsHelp.text).toContain("prs link");

    const actionsHelp = buildCliPlan(["actions", "run", "--help"]);
    expect(actionsHelp.kind).toBe("help");
    if (actionsHelp.kind !== "help") return;
    expect(actionsHelp.text).toContain("Argument shapes");
    expect(actionsHelp.text).toContain("--args-list-json");

    const chatCreateHelp = buildCliPlan(["help", "chat", "create"]);
    expect(chatCreateHelp.kind).toBe("help");
    if (chatCreateHelp.kind !== "help") return;
    expect(chatCreateHelp.text).toContain("--reasoning-effort");
    expect(chatCreateHelp.text).toContain("ultracode");
    expect(chatCreateHelp.text).toContain("--prompt <text>");
    expect(chatCreateHelp.text).toContain("ade new chat --mode cli");
    expect(chatCreateHelp.text).toContain("codexSandbox=danger-full-access");

    const chatHelp = buildCliPlan(["help", "chat"]);
    expect(chatHelp.kind).toBe("help");
    if (chatHelp.kind !== "help") return;
    expect(chatHelp.text).toContain("ade chat message <session>");
    expect(chatHelp.text).toContain("ade chat steer <session>");
    expect(chatHelp.text).toContain("ade chat wait <session>");
    expect(chatHelp.text).toContain("ade chat recover <session>");
    expect(chatHelp.text).toContain("ade chat models --provider codex");
    expect(chatHelp.text).toContain("ade chat read <session>");
    expect(chatHelp.text).toContain("ade new chat --mode cli");

    const newChatHelp = buildCliPlan(["help", "new", "chat"]);
    expect(newChatHelp.kind).toBe("help");
    if (newChatHelp.kind !== "help") return;
    expect(newChatHelp.text).toContain("--type <subagent|peer|none>");

    const laneCommandHelp = buildCliPlan(["help", "lanes"]);
    expect(laneCommandHelp.kind).toBe("help");
    if (laneCommandHelp.kind !== "help") return;
    expect(laneCommandHelp.text).toContain("lanes create --parent <lane>");
    expect(laneCommandHelp.text).toContain("carry the parent's unmerged work");

    const chatRecoveryHelp = buildCliPlan(["help", "chat", "recover"]);
    expect(chatRecoveryHelp.kind).toBe("help");
    if (chatRecoveryHelp.kind !== "help") return;
    expect(chatRecoveryHelp.text).toContain("same actions as the desktop");
    expect(chatRecoveryHelp.text).toContain("--action resume");

    const agentSpawnHelp = buildCliPlan(["agent", "spawn", "--help"]);
    expect(agentSpawnHelp.kind).toBe("help");
    if (agentSpawnHelp.kind !== "help") return;
    expect(agentSpawnHelp.text).toContain("does not");
    expect(agentSpawnHelp.text).toContain("--reasoning-effort");

    // Regression: --text as output flag must not swallow --help.
    const lanesHelp = buildCliPlan(["lanes", "list", "--text", "--help"]);
    expect(lanesHelp.kind).toBe("help");

    const reparentHelp = buildCliPlan([
      "lanes",
      "reparent",
      "lane-child",
      "--stack-base-branch",
      "develop",
      "--help",
    ]);
    expect(reparentHelp.kind).toBe("help");
  });

  it("maps PR create Linear close flag to the typed RPC tool", () => {
    const plan = buildCliPlan([
      "prs",
      "create",
      "--lane",
      "lane-1",
      "--title",
      "Linked PR",
      "--body",
      "Body",
      "--close-linear-issue-on-merge",
    ]);

    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "create_pr_from_lane",
      arguments: {
        laneId: "lane-1",
        title: "Linked PR",
        body: "Body",
        draft: false,
        closeLinearIssueOnMerge: true,
      },
    });
  });

  it("summarizes PR create output with GitHub and ADE links", () => {
    const connection = {
      mode: "headless" as const,
      projectRoot: "/tmp/project",
      workspaceRoot: "/tmp/project",
      socketPath: "/tmp/project/.ade/ade.sock",
      request: async () => null,
      close: () => {},
    };
    const summarized = summarizeExecution({
      plan: { kind: "execute", label: "PR create", steps: [] },
      connection,
      values: {
        result: {
          pr: {
            id: "pr-42",
            laneId: "lane-1",
            repoOwner: "acme",
            repoName: "ade",
            githubPrNumber: 42,
            githubUrl: "https://github.com/acme/ade/pull/42",
            title: "Add PR deeplinks",
            state: "open",
          },
        },
      },
    } as any);

    expect(summarized).toMatchObject({
      githubUrl: "https://github.com/acme/ade/pull/42",
      adeUrl: "https://ade-app.dev/open?type=pr&repo=acme%2Fade&number=42",
    });

    const text = formatOutput(
      summarized,
      { ...baseResolveOpts(), projectRoot: null, workspaceRoot: null, text: true },
      "pr-create",
    );
    expect(text).toContain("ADE pull request created");
    expect(text).toContain("GitHub URL");
    expect(text).toContain("https://github.com/acme/ade/pull/42");
    expect(text).toContain("ADE URL");
    expect(text).toContain("https://ade-app.dev/open?type=pr&repo=acme%2Fade&number=42");
  });

  it("maps lane create Linear issue JSON to the typed RPC tool", () => {
    const plan = buildCliPlan([
      "lanes",
      "create",
      "--name",
      "Linked lane",
      "--base",
      "main",
      "--branch-name",
      "ade-123-linked-lane",
      "--linear-issue-json",
      '{"id":"issue-1","identifier":"ADE-123","title":"Linked lane"}',
    ]);

    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "create_lane",
      arguments: {
        name: "Linked lane",
        baseBranch: "main",
        branchName: "ade-123-linked-lane",
        linearIssue: {
          id: "issue-1",
          identifier: "ADE-123",
          title: "Linked lane",
        },
      },
    });
  });

  it("maps existing lane Linear issue linking to the lane action", () => {
    const plan = buildCliPlan([
      "lanes",
      "link-linear-issue",
      "lane-1",
      "--linear-issue-json",
      '{"id":"issue-1","identifier":"ADE-123","title":"Linked lane"}',
      "--source",
      "manual",
      "--no-include-in-pr",
    ]);

    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "lane",
        action: "linkLinearIssues",
        args: {
          laneId: "lane-1",
          issues: [{
            id: "issue-1",
            identifier: "ADE-123",
            title: "Linked lane",
          }],
          source: "manual",
          includeInPr: false,
        },
      },
    });
  });

  it("accepts attach-linear-issue as a lane-scoped link alias with --issue-id shorthand", () => {
    const plan = buildCliPlan([
      "lanes",
      "attach-linear-issue",
      "lane-7",
      "--issue-id",
      "ENG-431",
      "--close-on-merge",
    ]);

    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "lane",
        action: "linkLinearIssues",
        args: {
          laneId: "lane-7",
          issues: [{ id: "ENG-431", identifier: "ENG-431" }],
          closeOnMerge: true,
        },
      },
    });
  });

  it("maps lane detach-linear-issue to lane.unlinkLinearIssues (all non-primary by default)", () => {
    const detachAll = buildCliPlan(["lanes", "detach-linear-issue", "lane-7"]);
    expect(detachAll.kind).toBe("execute");
    if (detachAll.kind !== "execute") return;
    expect(detachAll.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "lane",
        action: "unlinkLinearIssues",
        args: { laneId: "lane-7" },
      },
    });

    const detachOne = buildCliPlan([
      "lanes",
      "detach-linear-issue",
      "lane-7",
      "--issue-id",
      "ENG-431",
    ]);
    expect(detachOne.kind).toBe("execute");
    if (detachOne.kind !== "execute") return;
    expect(detachOne.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "lane",
        action: "unlinkLinearIssues",
        args: { laneId: "lane-7", issueId: "ENG-431" },
      },
    });
  });

  it("maps chat attach/detach/list to session-scoped lane actions", () => {
    // attachLinearIssueToSession takes an issues array keyed by chatSessionId.
    const attach = buildCliPlan([
      "chat",
      "attach-linear-issue",
      "session-9",
      "--issue-id",
      "ENG-431",
    ]);
    expect(attach.kind).toBe("execute");
    if (attach.kind !== "execute") return;
    expect(attach.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "lane",
        action: "attachLinearIssueToSession",
        args: {
          chatSessionId: "session-9",
          issues: [{ id: "ENG-431", identifier: "ENG-431" }],
        },
      },
    });

    // detach with a specific issueId.
    const detach = buildCliPlan([
      "chat",
      "detach-linear-issue",
      "session-9",
      "--issue-id",
      "ENG-431",
    ]);
    expect(detach.kind).toBe("execute");
    if (detach.kind !== "execute") return;
    expect(detach.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "lane",
        action: "detachLinearIssueFromSession",
        args: { chatSessionId: "session-9", issueId: "ENG-431" },
      },
    });

    // detach with no issueId detaches every issue from the session.
    const detachAll = buildCliPlan(["chat", "detach-linear-issue", "session-9"]);
    expect(detachAll.kind).toBe("execute");
    if (detachAll.kind !== "execute") return;
    expect(detachAll.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "lane",
        action: "detachLinearIssueFromSession",
        args: { chatSessionId: "session-9" },
      },
    });

    // listLinearIssuesForSession takes an object arg.
    const list = buildCliPlan(["chat", "linear-issues", "session-9"]);
    expect(list.kind).toBe("execute");
    if (list.kind !== "execute") return;
    expect(list.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "lane",
        action: "listLinearIssuesForSession",
        args: { chatSessionId: "session-9" },
      },
    });
  });

  it("attaches multiple issues to a session in one call", () => {
    const plan = buildCliPlan([
      "chat",
      "attach-linear-issue",
      "session-9",
      "--linear-issue-json",
      '[{"id":"a","identifier":"ENG-1"},{"id":"b","identifier":"ENG-2"}]',
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        args: {
          chatSessionId: "session-9",
          issues: [
            { id: "a", identifier: "ENG-1" },
            { id: "b", identifier: "ENG-2" },
          ],
        },
      },
    });
  });

  it("resolves the session id from ADE_CHAT_SESSION_ID for chat attach", () => {
    const prev = process.env.ADE_CHAT_SESSION_ID;
    process.env.ADE_CHAT_SESSION_ID = "env-session";
    try {
      const plan = buildCliPlan(["chat", "attach-linear-issue", "--issue-id", "ENG-1"]);
      expect(plan.kind).toBe("execute");
      if (plan.kind !== "execute") return;
      expect(plan.steps[0]?.params).toMatchObject({
        arguments: { args: { chatSessionId: "env-session" } },
      });
    } finally {
      if (prev === undefined) delete process.env.ADE_CHAT_SESSION_ID;
      else process.env.ADE_CHAT_SESSION_ID = prev;
    }
  });

  it("builds lanes create-from-linear as a single create_lane step without --start-chat", () => {
    const plan = buildCliPlan([
      "lanes",
      "create-from-linear",
      "--linear-issue-json",
      '{"id":"issue-1","identifier":"ENG-431","title":"Fix OAuth"}',
      "--base",
      "main",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.params).toEqual({
      name: "create_lane",
      arguments: {
        name: "Fix OAuth",
        linearIssue: { id: "issue-1", identifier: "ENG-431", title: "Fix OAuth" },
        baseBranch: "main",
      },
    });
  });

  it("chains create_lane -> chat createSession -> attach Linear issue -> kickoff for create-from-linear --start-chat", () => {
    const plan = buildCliPlan([
      "lanes",
      "create-from-linear",
      "--linear-issue-json",
      '{"id":"issue-1","identifier":"ENG-431","title":"Fix OAuth","url":"https://linear.app/x/ENG-431"}',
      "--start-chat",
      "--provider",
      "codex",
      "--model",
      "gpt-5",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps).toHaveLength(4);
    expect(plan.steps[0]?.key).toBe("lane");

    // Step 2 derives laneId from the create_lane result.
    const chatStep = plan.steps[1]!;
    expect(typeof chatStep.params).toBe("function");
    const chatParams = (chatStep.params as (v: Record<string, unknown>) => Record<string, unknown>)({
      lane: { domain: "lane", action: "create", result: { lane: { id: "lane-new" } } },
    });
    expect(chatParams).toMatchObject({
      name: "run_ade_action",
      arguments: {
        domain: "chat",
        action: "createSession",
        args: { laneId: "lane-new", surface: "work", provider: "codex", model: "gpt-5", modelId: "gpt-5" },
      },
    });

    // Step 3 attaches the issue to the chat so the runtime posts chat/lane cards.
    const attachStep = plan.steps[2]!;
    const attachParams = (attachStep.params as (v: Record<string, unknown>) => Record<string, unknown>)({
      chat: { domain: "chat", action: "createSession", result: { id: "session-new" } },
    });
    expect(attachParams).toMatchObject({
      arguments: {
        domain: "lane",
        action: "attachLinearIssueToSession",
        args: {
          chatSessionId: "session-new",
          issues: [{ id: "issue-1", identifier: "ENG-431", title: "Fix OAuth", url: "https://linear.app/x/ENG-431" }],
          role: "worked",
          source: "chat_attach",
        },
      },
    });

    // Step 4 derives sessionId from the createSession result and sends a kickoff.
    const sendStep = plan.steps[3]!;
    const sendParams = (sendStep.params as (v: Record<string, unknown>) => Record<string, unknown>)({
      chat: { domain: "chat", action: "createSession", result: { id: "session-new" } },
    });
    expect(sendParams).toMatchObject({
      arguments: { domain: "chat", action: "sendMessage", args: { sessionId: "session-new" } },
    });
    const sendArgs = (sendParams.arguments as { args: { text: string } }).args;
    expect(sendArgs.text).toContain("ENG-431");
    expect(sendArgs.text).toContain("https://linear.app/x/ENG-431");
  });

  it("builds a per-issue create_lane step for batch-create-from-linear", () => {
    const plan = buildCliPlan([
      "lanes",
      "batch-create-from-linear",
      "--linear-issues-json",
      '[{"id":"i1","identifier":"ENG-1","title":"A"},{"id":"i2","identifier":"ENG-2","title":"B"}]',
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps).toHaveLength(2);
    // Each step is keyed by the issue identifier and tolerant of sibling failure.
    expect(plan.steps[0]?.key).toBe("ENG-1");
    expect(plan.steps[0]?.optional).toBe(true);
    expect(plan.steps[1]?.key).toBe("ENG-2");
    expect(plan.steps[0]?.params).toMatchObject({
      name: "create_lane",
      arguments: { name: "A", linearIssue: { identifier: "ENG-1" } },
    });
  });

  it("rejects --start-chat for the batch create path", () => {
    expect(() =>
      buildCliPlan([
        "lanes",
        "batch-create-from-linear",
        "--issue-id",
        "ENG-1",
        "--start-chat",
      ]),
    ).toThrow(/creates lanes only/);
  });

  it("maps chat create --from-linear-issue to create + attach + kickoff", () => {
    const plan = buildCliPlan([
      "chat",
      "create",
      "--lane",
      "lane-1",
      "--from-linear-issue",
      "ENG-431",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[0]?.key).toBe("session");

    const attachStep = plan.steps[1]!;
    const attachParams = (attachStep.params as (v: Record<string, unknown>) => Record<string, unknown>)({
      session: { domain: "chat", action: "createSession", result: { id: "session-x" } },
    });
    expect(attachParams).toMatchObject({
      arguments: {
        domain: "lane",
        action: "attachLinearIssueToSession",
        args: { chatSessionId: "session-x", issues: [{ identifier: "ENG-431" }] },
      },
    });

    const noKickoffPlan = expectExecutePlan(buildCliPlan([
      "chat",
      "create",
      "--lane",
      "lane-1",
      "--from-linear-issue",
      "ENG-431",
      "--no-kickoff",
    ]));
    expect(noKickoffPlan.steps).toHaveLength(2);
    expect(noKickoffPlan.steps[1]?.key).toBe("attach");

    const summary = summarizeExecution({
      plan: noKickoffPlan,
      connection: {
        mode: "headless",
        projectRoot: "/tmp/project",
        workspaceRoot: "/tmp/project",
        socketPath: "/tmp/project/.ade/ade.sock",
        request: async () => null,
        close: () => {},
      },
      values: {
        session: {
          domain: "chat",
          action: "createSession",
          result: { sessionId: "session-x" },
        },
        attach: {
          domain: "lane",
          action: "attachLinearIssueToSession",
          result: { linked: true },
        },
      },
    } as any);
    expect(summary).toEqual({
      ok: true,
      session: { sessionId: "session-x" },
      attach: { linked: true },
    });
  });

  it("routes the linear write-bridge commands to linear_issue_tracker positional actions", () => {
    const comment = buildCliPlan(["linear", "comment", "ENG-431", "All green"]);
    expect(comment.kind).toBe("execute");
    if (comment.kind !== "execute") return;
    expect(comment.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "linear_issue_tracker",
        action: "createComment",
        argsList: ["ENG-431", "All green"],
      },
    });

    const setState = buildCliPlan(["linear", "set-state", "ENG-431", "state-done"]);
    expect(setState.kind).toBe("execute");
    if (setState.kind !== "execute") return;
    expect(setState.steps[0]?.params).toMatchObject({
      arguments: { action: "updateIssueState", argsList: ["ENG-431", "state-done"] },
    });

    const assignNone = buildCliPlan(["linear", "assign", "ENG-431", "none"]);
    expect(assignNone.kind).toBe("execute");
    if (assignNone.kind !== "execute") return;
    expect(assignNone.steps[0]?.params).toMatchObject({
      arguments: { action: "updateIssueAssignee", argsList: ["ENG-431", null] },
    });

    const label = buildCliPlan(["linear", "label", "ENG-431", "needs-review"]);
    expect(label.kind).toBe("execute");
    if (label.kind !== "execute") return;
    expect(label.steps[0]?.params).toMatchObject({
      arguments: { action: "addLabel", argsList: ["ENG-431", "needs-review"] },
    });
  });

  it("defaults the linear comment issue id from ADE_LINEAR_ISSUE_IDS", () => {
    const prev = process.env.ADE_LINEAR_ISSUE_IDS;
    process.env.ADE_LINEAR_ISSUE_IDS = "ENG-900, ENG-901";
    try {
      const plan = buildCliPlan(["linear", "comment", "done"]);
      expect(plan.kind).toBe("execute");
      if (plan.kind !== "execute") return;
      expect(plan.steps[0]?.params).toMatchObject({
        arguments: { action: "createComment", argsList: ["ENG-900", "done"] },
      });
    } finally {
      if (prev === undefined) delete process.env.ADE_LINEAR_ISSUE_IDS;
      else process.env.ADE_LINEAR_ISSUE_IDS = prev;
    }
  });

  it("routes linear graphql through the runtime-owned Linear connection", () => {
    const plan = buildCliPlan([
      "linear",
      "graphql",
      "--query",
      "query Viewer { viewer { id name } }",
      "--operation-name",
      "Viewer",
      "--variables-json",
      "{\"includeArchived\":false}",
      "--max-retries",
      "99",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "linear_issue_tracker",
        action: "graphql",
        args: {
          query: "query Viewer { viewer { id name } }",
          operationName: "Viewer",
          variables: { includeArchived: false },
          maxRetries: 10,
        },
      },
    });
  });

  it("revalidates linear graphql payloads after generic argument overrides", () => {
    expect(() =>
      buildCliPlan([
        "linear",
        "graphql",
        "--query",
        "query Viewer { viewer { id name } }",
        "--arg-json",
        "variables=[]",
      ]),
    ).toThrow(/'variables' must be a JSON object/);

    expect(() =>
      buildCliPlan([
        "linear",
        "graphql",
        "--query",
        "query Viewer { viewer { id name } }",
        "--input-json",
        "{\"query\":123}",
      ]),
    ).toThrow(/GraphQL query is required/);

    expect(() =>
      buildCliPlan([
        "linear",
        "graphql",
        "--query",
        "query Viewer { viewer { id name } }",
        "--input-json",
        "{\"maxRetries\":\"many\"}",
      ]),
    ).toThrow(/'maxRetries' must be a number/);
  });

  it("attaches an issue to the current session via linear attach --this-session", () => {
    const prev = process.env.ADE_CHAT_SESSION_ID;
    process.env.ADE_CHAT_SESSION_ID = "current-session";
    try {
      const plan = buildCliPlan(["linear", "attach", "--this-session", "--issue-id", "ENG-431"]);
      expect(plan.kind).toBe("execute");
      if (plan.kind !== "execute") return;
      expect(plan.steps[0]?.params).toEqual({
        name: "run_ade_action",
        arguments: {
          domain: "lane",
          action: "attachLinearIssueToSession",
          args: {
            chatSessionId: "current-session",
            issues: [{ id: "ENG-431", identifier: "ENG-431" }],
          },
        },
      });
    } finally {
      if (prev === undefined) delete process.env.ADE_CHAT_SESSION_ID;
      else process.env.ADE_CHAT_SESSION_ID = prev;
    }
  });

  it("errors when linear attach --this-session has no session env", () => {
    const prev = process.env.ADE_CHAT_SESSION_ID;
    delete process.env.ADE_CHAT_SESSION_ID;
    try {
      expect(() =>
        buildCliPlan(["linear", "attach", "--this-session", "--issue-id", "ENG-1"]),
      ).toThrow(/ADE_CHAT_SESSION_ID/);
    } finally {
      if (prev !== undefined) process.env.ADE_CHAT_SESSION_ID = prev;
    }
  });

  it("rejects a Linear issue object missing both id and identifier", () => {
    expect(() =>
      buildCliPlan([
        "lanes",
        "attach-linear-issue",
        "lane-1",
        "--linear-issue-json",
        '{"title":"no ids here"}',
      ]),
    ).toThrow(/missing both "id" and "identifier"/);
  });

  it("maps Linear quick view through the runtime-owned issue tracker action", () => {
    const plan = buildCliPlan(["linear", "quick-view", "--text"]);

    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("Linear quick view");
    expect(plan.formatter).toBe("linear-quick-view");
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "linear_issue_tracker",
        action: "getQuickView",
        args: {},
      },
    });
  });

  it("maps Linear picker data through the runtime-owned issue tracker action", () => {
    const plan = buildCliPlan(["linear", "picker-data", "--text"]);

    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("Linear picker data");
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "linear_issue_tracker",
        action: "getIssuePickerData",
        args: {},
      },
    });
  });

  it("maps Linear search-issues filters through the runtime-owned issue tracker action", () => {
    const plan = buildCliPlan([
      "linear",
      "search-issues",
      "--project-id",
      "proj-1",
      "--state-type",
      "started,unstarted",
      "--query",
      "auth",
      "--first",
      "25",
      "--include-archived",
    ]);

    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("Linear search issues");
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "linear_issue_tracker",
        action: "searchIssues",
        args: {
          projectId: "proj-1",
          stateTypes: ["started", "unstarted"],
          query: "auth",
          first: 25,
          includeArchived: true,
        },
      },
    });
  });

  it("maps Linear issue comments to the scalar issue tracker action", () => {
    const plan = buildCliPlan(["linear", "issue-comments", "ADE-69"]);

    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "linear_issue_tracker",
        action: "fetchIssueComments",
        arg: "ADE-69",
      },
    });
  });

  it("shows focused ios-sim help for subcommand help flags", () => {
    const renderHelp = buildCliPlan(["ios-sim", "preview-render", "--help"]);
    expect(renderHelp.kind).toBe("help");
    if (renderHelp.kind !== "help") return;
    expect(renderHelp.text).toContain("iOS Simulator: preview-render");
    expect(renderHelp.text).toContain("--source, --file <p>");
    expect(renderHelp.text).toContain("--index <n>");
    expect(renderHelp.text).toContain("final command agents should run");

    const aliasHelp = buildCliPlan(["help", "ios", "snapshot"]);
    expect(aliasHelp.kind).toBe("help");
    if (aliasHelp.kind !== "help") return;
    expect(aliasHelp.text).toContain("iOS Simulator: snapshot");
    expect(aliasHelp.text).toContain("ADEInspector/accessibility");

    const targetHelp = buildCliPlan([
      "ios-sim",
      "launch",
      "--target",
      "preview-target",
      "--help",
    ]);
    expect(targetHelp.kind).toBe("help");
    if (targetHelp.kind !== "help") return;
    expect(targetHelp.text).toContain("iOS Simulator: launch");
    expect(targetHelp.text).toContain("--target, --target-id <id>");

    const nestedHelp = buildCliPlan(["ios-sim", "help", "select"]);
    expect(nestedHelp.kind).toBe("help");
    if (nestedHelp.kind !== "help") return;
    expect(nestedHelp.text).toContain("iOS Simulator: select");
    expect(nestedHelp.text).toContain("emits a drawer selection event");

    const typeHelp = buildCliPlan(["ios-sim", "type", "--help"]);
    expect(typeHelp.kind).toBe("help");
    if (typeHelp.kind !== "help") return;
    expect(typeHelp.text).toContain("iOS Simulator: type");
    expect(typeHelp.text).toContain("--value, --message <v>");
  });

  it("shell-escapes argv tokens after -- when building shell start commands", () => {
    const plan = buildCliPlan([
      "shell",
      "start",
      "--lane",
      "lane-1",
      "--",
      "cat",
      "file with spaces.txt",
      "literal&name",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "pty",
        action: "create",
        args: expect.objectContaining({
          laneId: "lane-1",
          startupCommand: "cat 'file with spaces.txt' 'literal&name'",
          toolType: "shell",
          cols: 120,
          rows: 36,
          tracked: true,
        }),
      },
    });
  });

  it("maps provider shell launches to start_cli_session", () => {
    const plan = buildCliPlan([
      "shell",
      "start-cli",
      "codex",
      "--lane",
      "lane-1",
      "--permission-mode",
      "edit",
      "--message",
      "fix the tests",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "start_cli_session",
      arguments: expect.objectContaining({
        laneId: "lane-1",
        provider: "codex",
        permissionMode: "edit",
        initialInput: "fix the tests",
        title: "Codex",
        cols: 120,
        rows: 36,
        tracked: true,
      }),
    });
  });

  it("forwards model and reasoning flags for provider shell launches", () => {
    const plan = buildCliPlan([
      "shell",
      "start-cli",
      "codex",
      "--lane",
      "lane-1",
      "--model",
      "gpt-5.4",
      "--reasoning",
      "high",
      "--no-fast",
      "--message",
      "fix the tests",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") throw new Error(`expected execute plan, got ${plan.kind}`);
    expect(plan.steps[0]?.params).toEqual({
      name: "start_cli_session",
      arguments: expect.objectContaining({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        reasoningEffort: "high",
        fastMode: false,
        initialInput: "fix the tests",
      }),
    });
  });

  it("does not treat option values as start-cli providers", () => {
    expect(() =>
      buildCliPlan([
        "shell",
        "start-cli",
        "--lane",
        "lane-1",
        "--permission-mode",
        "edit",
      ]),
    ).toThrow("provider is required");
  });

  it("finds a start-cli provider after value-taking options", () => {
    const plan = buildCliPlan([
      "shell",
      "start-cli",
      "--lane",
      "lane-1",
      "--permission-mode",
      "edit",
      "codex",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      name: "start_cli_session",
      arguments: {
        laneId: "lane-1",
        provider: "codex",
        permissionMode: "edit",
      },
    });
  });

  it("finds a start-cli provider after initial-input value-taking options", () => {
    const plan = buildCliPlan([
      "shell",
      "start-cli",
      "--lane",
      "lane-1",
      "--initial-input",
      "hello agent",
      "codex",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      name: "start_cli_session",
      arguments: {
        laneId: "lane-1",
        provider: "codex",
        initialInput: "hello agent",
      },
    });
  });

  it("accepts Claude auto permission mode for provider CLI launches", () => {
    const plan = buildCliPlan([
      "shell",
      "start-cli",
      "claude",
      "--lane",
      "lane-1",
      "--permission-mode",
      "auto",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      name: "start_cli_session",
      arguments: {
        laneId: "lane-1",
        provider: "claude",
        permissionMode: "auto",
      },
    });
  });

  it("accepts --provider on shell start as the CLI-session launcher", () => {
    const plan = buildCliPlan([
      "shell",
      "start",
      "--provider",
      "claude",
      "--lane",
      "lane-1",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      name: "start_cli_session",
      arguments: {
        laneId: "lane-1",
        provider: "claude",
        permissionMode: "default",
      },
    });
  });

  it("renders an empty lane graph placeholder when no lanes are returned", () => {
    expect(renderLaneGraph({ lanes: [] })).toBe("ADE lanes\n(no lanes)");
    expect(renderLaneGraph(null)).toBe("ADE lanes\n(no lanes)");
  });

  it("automations list maps to the automations.list action", () => {
    const plan = buildCliPlan(["automations", "list"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: { domain: "automations", action: "list", args: {} },
    });
  });

  it("automations show reads the id from a positional or from --id", () => {
    const byPositional = buildCliPlan(["automations", "show", "rule-42"]);
    expect(byPositional.kind).toBe("execute");
    if (byPositional.kind !== "execute") return;
    expect(byPositional.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "get",
        args: { id: "rule-42" },
      },
    });

    const byFlag = buildCliPlan(["automations", "show", "--id", "rule-42"]);
    expect(byFlag.kind).toBe("execute");
    if (byFlag.kind !== "execute") return;
    expect(byFlag.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "get",
        args: { id: "rule-42" },
      },
    });
  });

  it("automations show errors loudly when id is missing", () => {
    expect(() => buildCliPlan(["automations", "show"])).toThrow(/rule id/);
  });

  it("automations create parses an inline YAML --text body via parseDraftInput", () => {
    // The CLI also accepts --from-file / --stdin; --text is the in-process variant.
    const plan = buildCliPlan([
      "automations",
      "create",
      "--text",
      "id: my-rule\nname: My rule\nenabled: true\n",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "saveRule",
        args: {
          draft: { id: "my-rule", name: "My rule", enabled: true },
        },
      },
    });
  });

  it("automations create accepts an inline JSON --text body", () => {
    const plan = buildCliPlan([
      "automations",
      "create",
      "--text",
      '{"id":"json-rule","name":"J"}',
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        args: { draft: { id: "json-rule", name: "J" } },
      },
    });
  });

  it("automations create rejects an empty body with a usage error", () => {
    expect(() =>
      buildCliPlan(["automations", "create", "--text", "   \n  "]),
    ).toThrow(/empty/i);
  });

  it("automations create rejects unparseable YAML/JSON", () => {
    expect(() =>
      buildCliPlan(["automations", "create", "--text", "{ this is: [unclosed"]),
    ).toThrow(/Failed to parse rule body/i);
  });

  it("automations create rejects a top-level non-object body", () => {
    // A bare string/array wouldn't round-trip through saveDraft safely.
    expect(() =>
      buildCliPlan(["automations", "create", "--text", "- one\n- two\n"]),
    ).toThrow(/must be an object/i);
  });

  it("automations update merges the provided id into the draft payload", () => {
    const plan = buildCliPlan([
      "automations",
      "update",
      "rule-42",
      "--text",
      "name: Renamed\n",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "saveRule",
        args: {
          draft: { name: "Renamed", id: "rule-42" },
        },
      },
    });
  });

  it("automations delete targets the id", () => {
    const plan = buildCliPlan(["automations", "delete", "rule-42"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "deleteRule",
        args: { id: "rule-42" },
      },
    });
  });

  it("automations toggle requires --enabled true|false and coerces to boolean", () => {
    const enabled = buildCliPlan([
      "automations",
      "toggle",
      "rule-42",
      "--enabled",
      "true",
    ]);
    expect(enabled.kind).toBe("execute");
    if (enabled.kind !== "execute") return;
    expect(enabled.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "toggleRule",
        args: { id: "rule-42", enabled: true },
      },
    });

    const disabled = buildCliPlan([
      "automations",
      "toggle",
      "rule-42",
      "--enabled",
      "false",
    ]);
    expect(disabled.kind).toBe("execute");
    if (disabled.kind !== "execute") return;
    expect(disabled.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "toggleRule",
        args: { id: "rule-42", enabled: false },
      },
    });
  });

  it("automations create merges --lane-mode and preset flags into draft.execution", () => {
    const plan = buildCliPlan([
      "automations",
      "create",
      "--text",
      "id: r1\nname: R\n",
      "--lane-mode",
      "create",
      "--lane-name-preset",
      "issue-title",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        args: {
          draft: {
            id: "r1",
            execution: { laneMode: "create", laneNamePreset: "issue-title" },
          },
        },
      },
    });
  });

  it("automations create with --lane-mode reuse and --lane sets targetLaneId", () => {
    const plan = buildCliPlan([
      "automations",
      "create",
      "--text",
      "id: r1\n",
      "--lane-mode",
      "reuse",
      "--lane",
      "lane-99",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        args: {
          draft: {
            execution: { laneMode: "reuse", targetLaneId: "lane-99" },
          },
        },
      },
    });
  });

  it("automations create with implicit reuse accepts --lane", () => {
    const plan = buildCliPlan([
      "automations",
      "create",
      "--text",
      "id: r1\n",
      "--lane",
      "lane-99",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        args: {
          draft: {
            execution: { targetLaneId: "lane-99" },
          },
        },
      },
    });
  });

  it("automations create accepts require-on-trigger lane mode without a target lane", () => {
    const plan = buildCliPlan([
      "automations",
      "create",
      "--text",
      "id: r1\n",
      "--lane-mode",
      "require-on-trigger",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        args: {
          draft: {
            execution: { laneMode: "require-on-trigger" },
          },
        },
      },
    });
  });

  it("automations create rejects --lane with --lane-mode require-on-trigger", () => {
    expect(() =>
      buildCliPlan([
        "automations",
        "create",
        "--text",
        "id: r1\n",
        "--lane-mode",
        "require-on-trigger",
        "--lane",
        "lane-1",
      ]),
    ).toThrow(/--lane is only valid with --lane-mode reuse/);
  });

  it("automations create with --lane-name-preset custom accepts --lane-name-template", () => {
    const plan = buildCliPlan([
      "automations",
      "create",
      "--text",
      "id: r1\n",
      "--lane-mode",
      "create",
      "--lane-name-preset",
      "custom",
      "--lane-name-template",
      "{{trigger.issue.author}}/{{trigger.issue.title}}",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        args: {
          draft: {
            execution: {
              laneMode: "create",
              laneNamePreset: "custom",
              laneNameTemplate:
                "{{trigger.issue.author}}/{{trigger.issue.title}}",
            },
          },
        },
      },
    });
  });

  it("automations create rejects --lane with --lane-mode create", () => {
    expect(() =>
      buildCliPlan([
        "automations",
        "create",
        "--text",
        "id: r1\n",
        "--lane-mode",
        "create",
        "--lane",
        "lane-1",
      ]),
    ).toThrow(/--lane is only valid with --lane-mode reuse/);
  });

  it("automations create rejects --lane-name-preset with --lane-mode reuse", () => {
    expect(() =>
      buildCliPlan([
        "automations",
        "create",
        "--text",
        "id: r1\n",
        "--lane-mode",
        "reuse",
        "--lane-name-preset",
        "issue-title",
      ]),
    ).toThrow(/--lane-name-preset is only valid with --lane-mode create/);
  });

  it("automations create rejects --lane-name-template with non-custom preset", () => {
    expect(() =>
      buildCliPlan([
        "automations",
        "create",
        "--text",
        "id: r1\n",
        "--lane-mode",
        "create",
        "--lane-name-preset",
        "issue-title",
        "--lane-name-template",
        "{{trigger.issue.title}}",
      ]),
    ).toThrow(
      /--lane-name-template is only valid with --lane-name-preset custom/,
    );
  });

  it("automations create rejects unknown --lane-mode value", () => {
    expect(() =>
      buildCliPlan([
        "automations",
        "create",
        "--text",
        "id: r1\n",
        "--lane-mode",
        "bogus",
      ]),
    ).toThrow(/--lane-mode must be one of create, reuse, require-on-trigger/);
  });

  it("automations runs accepts a --status filter", () => {
    const plan = buildCliPlan([
      "automations",
      "runs",
      "--rule",
      "r1",
      "--status",
      "failed",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "listRuns",
        args: { automationId: "r1", status: "failed" },
      },
    });
  });

  it("automations runs rejects an unknown --status value", () => {
    expect(() =>
      buildCliPlan(["automations", "runs", "--status", "wat"]),
    ).toThrow(/--status must be one of/);
  });

  it("automations example prints a parseable example rule via help kind", () => {
    const plan = buildCliPlan(["automations", "example"]);
    expect(plan.kind).toBe("help");
    if (plan.kind !== "help") return;
    const parsed = JSON.parse(plan.text);
    expect(parsed).toMatchObject({
      execution: { laneMode: "create", laneNamePreset: "issue-num-title" },
    });
  });

  it("automations create auto-migrates a legacy create-lane first action into laneMode", () => {
    const draft = JSON.stringify({
      id: "legacy-rule",
      actions: [
        { type: "create-lane", laneNameTemplate: "{{trigger.issue.title}}" },
        { type: "agent-session", modelId: "claude-opus-4-8" },
      ],
    });
    const plan = buildCliPlan(["automations", "create", "--text", draft]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        args: {
          draft: {
            execution: {
              laneMode: "create",
              laneNamePreset: "custom",
              laneNameTemplate: "{{trigger.issue.title}}",
            },
            actions: [{ type: "agent-session" }],
          },
        },
      },
    });
  });

  it("automations create --allow-legacy preserves the legacy create-lane action", () => {
    const draft = JSON.stringify({
      id: "legacy-rule",
      actions: [{ type: "create-lane", laneNameTemplate: "x" }],
    });
    const plan = buildCliPlan([
      "automations",
      "create",
      "--text",
      draft,
      "--allow-legacy",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        args: {
          draft: {
            actions: [{ type: "create-lane", laneNameTemplate: "x" }],
          },
        },
      },
    });
  });

  it("automations run-show wires the automation-run-detail formatter", () => {
    const plan = buildCliPlan(["automations", "run-show", "run-1"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.formatter).toBe("automation-run-detail");
  });

  it("automations ingress status, start, and refresh use the webhook gateway runtime actions", () => {
    const status = buildCliPlan(["automations", "ingress", "status"]);
    expect(status.kind).toBe("execute");
    if (status.kind !== "execute") return;
    expect(status.formatter).toBe("automation-ingress");
    expect(status.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "getIngressStatus",
        args: {},
      },
    });

    const start = buildCliPlan(["automations", "ingress", "start"]);
    expect(start.kind).toBe("execute");
    if (start.kind !== "execute") return;
    expect(start.formatter).toBe("automation-ingress");
    expect(start.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "startIngress",
        args: {},
      },
    });

    const refresh = buildCliPlan(["automations", "ingress", "refresh"]);
    expect(refresh.kind).toBe("execute");
    if (refresh.kind !== "execute") return;
    expect(refresh.formatter).toBe("automation-ingress");
    expect(refresh.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "refreshWebhookGatewayStatus",
        args: {},
      },
    });
  });

  it("automations ingress set-url and clear-url update the public gateway URL", () => {
    const set = buildCliPlan([
      "automations",
      "ingress",
      "set-url",
      "https://ade.example.com/ade-webhooks",
    ]);
    expect(set.kind).toBe("execute");
    if (set.kind !== "execute") return;
    expect(set.formatter).toBe("automation-ingress");
    expect(set.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "setWebhookGatewayPublicUrl",
        args: { publicUrl: "https://ade.example.com/ade-webhooks" },
      },
    });

    const clear = buildCliPlan(["automations", "ingress", "clear-url"]);
    expect(clear.kind).toBe("execute");
    if (clear.kind !== "execute") return;
    expect(clear.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "automations",
        action: "setWebhookGatewayPublicUrl",
        args: { publicUrl: null },
      },
    });
  });

  it("automations linear-ingress maps status/connect/disconnect/poll to runtime actions", () => {
    const cases: Array<[string, string]> = [
      ["status", "linearIngressGetStatus"],
      ["connect", "linearIngressSetup"],
      ["disconnect", "linearIngressTeardown"],
      ["poll", "linearIngressPollNow"],
    ];
    for (const [mode, action] of cases) {
      const plan = buildCliPlan(["automations", "linear-ingress", mode]);
      expect(plan.kind).toBe("execute");
      if (plan.kind !== "execute") return;
      expect(plan.formatter).toBe("automation-linear-ingress");
      expect(plan.steps[0]?.params).toEqual({
        name: "run_ade_action",
        arguments: { domain: "automations", action, args: {} },
      });
    }
  });

  it("automations linear-ingress rejects unknown modes", () => {
    expect(() =>
      buildCliPlan(["automations", "linear-ingress", "nope"]),
    ).toThrow(/status, connect, disconnect, or poll/);
  });

  it("automations cleanups list and cancel map to runtime actions", () => {
    const list = buildCliPlan(["automations", "cleanups", "list"]);
    expect(list.kind).toBe("execute");
    if (list.kind !== "execute") return;
    expect(list.formatter).toBe("automation-cleanups");
    expect(list.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "listScheduledCleanups",
        args: {},
      },
    });

    const cancel = buildCliPlan(["automations", "cleanups", "cancel", "cleanup-7"]);
    expect(cancel.kind).toBe("execute");
    if (cancel.kind !== "execute") return;
    expect(cancel.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "cancelScheduledCleanup",
        args: { id: "cleanup-7" },
      },
    });
  });

  it("automations cleanups cancel requires an id", () => {
    expect(() => buildCliPlan(["automations", "cleanups", "cancel"])).toThrow(
      /scheduled cleanup id/,
    );
  });

  it("automations toggle errors when --enabled is omitted", () => {
    expect(() => buildCliPlan(["automations", "toggle", "rule-42"])).toThrow(
      /--enabled <true\|false>/,
    );
  });

  it("automations toggle rejects invalid --enabled values", () => {
    expect(() =>
      buildCliPlan(["automations", "toggle", "rule-42", "--enabled", "maybe"]),
    ).toThrow(/must be true or false/);
  });

  it("automations run passes dryRun only when --dry-run is set", () => {
    const plain = buildCliPlan(["automations", "run", "rule-42"]);
    expect(plain.kind).toBe("execute");
    if (plain.kind !== "execute") return;
    expect(plain.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "triggerManually",
        args: { id: "rule-42" },
      },
    });

    const dry = buildCliPlan(["automations", "run", "rule-42", "--dry-run"]);
    expect(dry.kind).toBe("execute");
    if (dry.kind !== "execute") return;
    expect(dry.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "triggerManually",
        args: { id: "rule-42", dryRun: true },
      },
    });
  });

  it("automations run forwards --lane as laneId", () => {
    const plan = buildCliPlan([
      "automations",
      "run",
      "rule-42",
      "--lane",
      "lane-7",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: { args: { id: "rule-42", laneId: "lane-7" } },
    });
  });

  it("automations trigger aliases run and forwards --lane as laneId", () => {
    const plan = buildCliPlan([
      "automations",
      "trigger",
      "rule-42",
      "--lane",
      "lane-7",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "automations",
        action: "triggerManually",
        args: { id: "rule-42", laneId: "lane-7" },
      },
    });
  });

  it("automations runs passes through --rule and --limit as filters", () => {
    const plan = buildCliPlan([
      "automations",
      "runs",
      "--rule",
      "rule-42",
      "--limit",
      "25",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "listRuns",
        args: { automationId: "rule-42", limit: 25 },
      },
    });
  });

  it("automations runs sends an empty filter when no flags are given", () => {
    const plan = buildCliPlan(["automations", "runs"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: { domain: "automations", action: "listRuns", args: {} },
    });
  });

  it("automations run-show / run-detail both map to getRunDetail", () => {
    for (const verb of ["run-show", "run-detail"]) {
      const plan = buildCliPlan(["automations", verb, "run-7"]);
      expect(plan.kind).toBe("execute");
      if (plan.kind !== "execute") continue;
      expect(plan.steps[0]?.params).toEqual({
        name: "run_ade_action",
        arguments: {
          domain: "automations",
          action: "getRunDetail",
          args: { runId: "run-7" },
        },
      });
    }
  });

  it("automations rejects unknown subcommands with a usage error", () => {
    expect(() => buildCliPlan(["automations", "nope"])).toThrow(
      /list, show, create, update, delete, toggle, run, ingress, linear-ingress, cleanups, runs/,
    );
  });

  it("singular `automation` is accepted as an alias for `automations`", () => {
    const plan = buildCliPlan(["automation", "list"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: { domain: "automations", action: "list" },
    });
  });

  it("ios-sim status maps to ios_simulator/getStatus", () => {
    const plan = buildCliPlan(["ios-sim", "status"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.params).toMatchObject({
      name: "run_ade_action",
      arguments: { domain: "ios_simulator", action: "getStatus" },
    });
  });

  it("ios-sim devices / list / ls aliases all map to listDevices", () => {
    for (const sub of ["devices", "list", "ls"]) {
      const plan = buildCliPlan(["ios-sim", sub]);
      expect(plan.kind).toBe("execute");
      if (plan.kind !== "execute") continue;
      expect(plan.steps[0]?.params).toMatchObject({
        arguments: { domain: "ios_simulator", action: "listDevices" },
      });
    }
  });

  it("ios-sim launch passes mode + build flags through to the action", () => {
    const plan = buildCliPlan([
      "ios-sim",
      "launch",
      "--device",
      "AAA-BBB",
      "--mode",
      "snapshot",
      "--no-build",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "ios_simulator",
        action: "launch",
        args: { deviceUdid: "AAA-BBB", mode: "snapshot", build: false },
      },
    });
  });

  it("ios-sim launch accepts simulator visibility flags", () => {
    const background = buildCliPlan([
      "ios-sim",
      "launch",
      "--target",
      "app",
      "--background",
    ]);
    expect(background.kind).toBe("execute");
    if (background.kind !== "execute") return;
    expect(background.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "ios_simulator",
        action: "launch",
        args: { targetId: "app", keepSimulatorInBackground: true },
      },
    });

    const foreground = buildCliPlan([
      "ios-sim",
      "launch",
      "--target",
      "app",
      "--foreground",
    ]);
    expect(foreground.kind).toBe("execute");
    if (foreground.kind !== "execute") return;
    expect(foreground.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "ios_simulator",
        action: "launch",
        args: { targetId: "app", keepSimulatorInBackground: false },
      },
    });
  });

  it("ios-sim preview stream aliases map to live view actions", () => {
    const start = buildCliPlan(["ios-sim", "preview-start", "--fps", "30"]);
    expect(start.kind).toBe("execute");
    if (start.kind !== "execute") return;
    expect(start.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "ios_simulator",
        action: "startStream",
        args: { fps: 30, backend: "simulator-window-capture" },
      },
    });

    const stop = buildCliPlan(["ios-sim", "preview-stop"]);
    expect(stop.kind).toBe("execute");
    if (stop.kind !== "execute") return;
    expect(stop.steps[0]?.params).toMatchObject({
      arguments: { domain: "ios_simulator", action: "stopStream" },
    });
  });

  it("ios-sim launch and claim carry the agent lane claim", () => {
    const previousLane = process.env.ADE_LANE_ID;
    const previousChat = process.env.ADE_CHAT_SESSION_ID;
    try {
      process.env.ADE_LANE_ID = "lane-env-1";
      process.env.ADE_CHAT_SESSION_ID = "chat-env-1";
      const launch = buildCliPlan(["ios-sim", "launch", "--target", "app"]);
      expect(launch.kind).toBe("execute");
      if (launch.kind !== "execute") return;
      expect(launch.steps[0]?.params).toMatchObject({
        arguments: {
          domain: "ios_simulator",
          action: "launch",
          args: {
            targetId: "app",
            laneId: "lane-env-1",
            chatSessionId: "chat-env-1",
          },
        },
      });

      const claim = buildCliPlan(["ios-sim", "claim", "--lane", "lane-explicit"]);
      expect(claim.kind).toBe("execute");
      if (claim.kind !== "execute") return;
      expect(claim.steps[0]?.params).toMatchObject({
        arguments: {
          domain: "ios_simulator",
          action: "claim",
          args: {
            laneId: "lane-explicit",
            chatSessionId: "chat-env-1",
          },
        },
      });
    } finally {
      if (previousLane === undefined) delete process.env.ADE_LANE_ID;
      else process.env.ADE_LANE_ID = previousLane;
      if (previousChat === undefined) delete process.env.ADE_CHAT_SESSION_ID;
      else process.env.ADE_CHAT_SESSION_ID = previousChat;
    }
  });

  it("tool claim commands require an explicit or ADE-provided lane", () => {
    const previousLane = process.env.ADE_LANE_ID;
    const previousChat = process.env.ADE_CHAT_SESSION_ID;
    try {
      delete process.env.ADE_LANE_ID;
      delete process.env.ADE_CHAT_SESSION_ID;

      expect(() => buildCliPlan(["ios-sim", "claim"])).toThrow(/requires --lane/);
      expect(() => buildCliPlan(["app-control", "claim"])).toThrow(/requires --lane/);
      expect(() => buildCliPlan(["browser", "claim"])).toThrow(/requires --lane/);

      process.env.ADE_LANE_ID = "lane-env-1";
      expect(buildCliPlan(["ios-sim", "claim"]).kind).toBe("execute");
      expect(buildCliPlan(["app-control", "claim"]).kind).toBe("execute");
      expect(buildCliPlan(["browser", "claim"]).kind).toBe("execute");
    } finally {
      if (previousLane === undefined) delete process.env.ADE_LANE_ID;
      else process.env.ADE_LANE_ID = previousLane;
      if (previousChat === undefined) delete process.env.ADE_CHAT_SESSION_ID;
      else process.env.ADE_CHAT_SESSION_ID = previousChat;
    }
  });

  it("ios-sim inspect requires both coordinates and forwards them", () => {
    expect(() => buildCliPlan(["ios-sim", "inspect"])).toThrow(/--x|--y/);
    const plan = buildCliPlan([
      "ios-sim",
      "inspect",
      "--x",
      "120",
      "--y",
      "420",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "ios_simulator",
        action: "inspectPoint",
        args: { x: 120, y: 420 },
      },
    });
  });

  it("ios-sim preview commands map to Xcode preview actions", () => {
    const status = buildCliPlan([
      "ios-sim",
      "preview-status",
      "--source",
      "Views/HomeView.swift",
      "--line",
      "42",
    ]);
    expect(status.kind).toBe("execute");
    if (status.kind !== "execute") return;
    expect(status.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "ios_simulator",
        action: "getPreviewCapability",
        args: { sourceFile: "Views/HomeView.swift", sourceLine: 42 },
      },
    });

    const list = buildCliPlan([
      "ios-sim",
      "previews",
      "--source",
      "Views/HomeView.swift",
    ]);
    expect(list.kind).toBe("execute");
    if (list.kind !== "execute") return;
    expect(list.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "ios_simulator",
        action: "listPreviewTargets",
        args: { sourceFile: "Views/HomeView.swift" },
      },
    });

    const open = buildCliPlan([
      "ios-sim",
      "preview-open",
      "--project-root",
      "/tmp/app",
    ]);
    expect(open.kind).toBe("execute");
    if (open.kind !== "execute") return;
    expect(open.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "ios_simulator",
        action: "openPreviewWorkspace",
        args: { projectRoot: "/tmp/app" },
      },
    });
  });

  it("ios-sim preview-match resolves the best preview target from source and element context", () => {
    const plan = expectExecutePlan(buildCliPlan([
      "ios-sim",
      "preview-match",
      "--source",
      "Views/HomeView.swift",
      "--line",
      "44",
      "--label",
      "Settings",
      "--component-id",
      "settings-row",
      "--project-root",
      "/tmp/app",
    ]));
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "ios_simulator",
        action: "resolvePreviewMatch",
        args: {
          projectRoot: "/tmp/app",
          sourceFile: "Views/HomeView.swift",
          sourceLine: 44,
          elementLabel: "Settings",
          componentId: "settings-row",
        },
      },
    });
  });

  it("ios-sim preview-ensure opens or checks the Preview Lab workspace", () => {
    const plan = expectExecutePlan(buildCliPlan([
      "ios-sim",
      "preview-ensure",
      "--source",
      "Views/HomeView.swift",
      "--line",
      "12",
      "--no-open",
      "--timeout-ms",
      "5000",
    ]));
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "ios_simulator",
        action: "ensurePreviewWorkspace",
        args: {
          sourceFile: "Views/HomeView.swift",
          sourceLine: 12,
          openIfNeeded: false,
          timeoutMs: 5000,
        },
      },
    });
  });

  it("formats preview-match and preview-ensure text as Preview Lab output", () => {
    const matchPlan = expectExecutePlan(buildCliPlan(["ios-sim", "preview-match", "--source", "Views/HomeView.swift"]));
    const ensurePlan = expectExecutePlan(buildCliPlan(["ios-sim", "preview-ensure"]));
    const currentPlan = expectExecutePlan(buildCliPlan(["ios-sim", "preview-current"]));
    expect(inferFormatter(matchPlan)).toBe("ios-sim-preview");
    expect(inferFormatter(ensurePlan)).toBe("ios-sim-preview");
    expect(inferFormatter(currentPlan)).toBe("ios-sim-preview");

    const output = formatOutput({
      status: "missing-preview",
      confidence: "none",
      target: null,
      selectedSourceFile: "apps/ios/ADE/Views/HomeView.swift",
      selectedSourceLine: 42,
      suggestedSourceFile: "apps/ios/ADE/Views/HomePreviews.swift",
      suggestedSourceFilePath: "apps/ios/ADE/Views/HomePreviews.swift",
      suggestedTitle: "Home Preview",
      reason: "No #Preview was found near HomeView.swift.",
    }, {
      text: true,
      pretty: false,
    } as any, "ios-sim-preview");
    expect(output).toContain("ADE iOS Preview match");
    expect(output).toMatch(/status\s+missing-preview/);
    expect(output).toMatch(/suggested file\s+apps\/ios\/ADE\/Views\/HomePreviews\.swift/);

    const currentOutput = formatOutput({
      ok: false,
      match: {
        status: "no-context",
        confidence: "none",
        target: null,
        selectedSourceFile: null,
        selectedSourceLine: null,
        reason: "Select a source-backed simulator element first.",
      },
      target: null,
      render: null,
      error: "Select a source-backed simulator element first.",
    }, {
      text: true,
      pretty: false,
    } as any, "ios-sim-preview");
    expect(currentOutput).toContain("ADE iOS Preview current");
    expect(currentOutput).toMatch(/status\s+no-context/);
  });

  it("ios-sim preview-current renders the currently selected simulator preview", () => {
    const plan = expectExecutePlan(buildCliPlan([
      "ios-sim",
      "preview-current",
      "--source",
      "Views/HomeView.swift",
      "--line",
      "44",
      "--label",
      "Settings",
      "--component-id",
      "settings-row",
      "--tab",
      "tab-1",
      "--timeout",
      "30",
      "--project-root",
      "/tmp/app",
    ]));
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "ios_simulator",
        action: "renderCurrentPreview",
        args: {
          projectRoot: "/tmp/app",
          sourceFile: "Views/HomeView.swift",
          sourceLine: 44,
          elementLabel: "Settings",
          componentId: "settings-row",
          tabIdentifier: "tab-1",
          timeoutSec: 30,
        },
      },
    });
  });

  it("ios-sim preview-render requires a source file and forwards render options", () => {
    expect(() => buildCliPlan(["ios-sim", "preview-render"])).toThrow(
      /sourceFilePath/,
    );

    const plan = buildCliPlan([
      "ios-sim",
      "preview-render",
      "--source",
      "Views/HomeView.swift",
      "--index",
      "2",
      "--tab",
      "tab-1",
      "--timeout",
      "30",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "ios_simulator",
        action: "renderPreview",
        args: {
          sourceFilePath: "Views/HomeView.swift",
          previewDefinitionIndexInFile: 2,
          tabIdentifier: "tab-1",
          timeoutSec: 30,
        },
      },
    });
  });

  it("ios-sim shutdown forwards --force to the shutdown action", () => {
    const plain = buildCliPlan(["ios-sim", "shutdown"]);
    expect(plain.kind).toBe("execute");
    if (plain.kind !== "execute") return;
    expect(plain.steps[0]?.params).toMatchObject({
      arguments: { domain: "ios_simulator", action: "shutdown" },
    });
    expect((plain.steps[0]?.params as any).arguments.args.force ?? false).toBe(
      false,
    );

    const forced = buildCliPlan(["ios-sim", "shutdown", "--force"]);
    expect(forced.kind).toBe("execute");
    if (forced.kind !== "execute") return;
    expect(forced.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "ios_simulator",
        action: "shutdown",
        args: { force: true },
      },
    });
  });

  it("keeps shell --command when an argument terminator has no trailing tokens", () => {
    const plan = buildCliPlan([
      "shell",
      "start",
      "--lane",
      "lane-1",
      "--command",
      "npm test",
      "--",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "pty",
        action: "create",
        args: {
          startupCommand: "npm test",
        },
      },
    });
  });

  it("keeps start-cli --message when an argument terminator has no trailing tokens", () => {
    const plan = buildCliPlan([
      "shell",
      "start-cli",
      "codex",
      "--lane",
      "lane-1",
      "--message",
      "hello",
      "--",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      name: "start_cli_session",
      arguments: {
        provider: "codex",
        initialInput: "hello",
      },
    });
  });

  it("ios-sim type accepts clear text payload aliases without shadowing output --text", () => {
    const withValue = buildCliPlan([
      "ios-sim",
      "type",
      "--value",
      "hello",
      "--text",
    ]);
    expect(withValue.kind).toBe("execute");
    if (withValue.kind !== "execute") return;
    expect(withValue.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "ios_simulator",
        action: "typeText",
        args: { text: "hello" },
      },
    });

    const withPositional = buildCliPlan([
      "ios-sim",
      "type",
      "hello world",
      "--text",
    ]);
    expect(withPositional.kind).toBe("execute");
    if (withPositional.kind !== "execute") return;
    expect(withPositional.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "ios_simulator",
        action: "typeText",
        args: { text: "hello world" },
      },
    });
  });

  it("attaches shell starts to the active ADE chat session from the environment", () => {
    const previous = process.env.ADE_CHAT_SESSION_ID;
    try {
      process.env.ADE_CHAT_SESSION_ID = "chat-env-1";
      const plan = buildCliPlan([
        "shell",
        "start",
        "--lane",
        "lane-1",
        "--command",
        "npm test",
      ]);
      expect(plan.kind).toBe("execute");
      if (plan.kind !== "execute") return;
      expect(plan.steps[0]?.params).toMatchObject({
        arguments: {
          domain: "pty",
          action: "create",
          args: {
            laneId: "lane-1",
            chatSessionId: "chat-env-1",
            startupCommand: "npm test",
          },
        },
      });
    } finally {
      if (previous === undefined) delete process.env.ADE_CHAT_SESSION_ID;
      else process.env.ADE_CHAT_SESSION_ID = previous;
    }
  });

  it("lets an explicit shell chat session override the environment", () => {
    const previous = process.env.ADE_CHAT_SESSION_ID;
    try {
      process.env.ADE_CHAT_SESSION_ID = "chat-env-1";
      const plan = buildCliPlan([
        "shell",
        "start",
        "--lane",
        "lane-1",
        "--chat-session",
        "chat-explicit-1",
        "--command",
        "npm test",
      ]);
      expect(plan.kind).toBe("execute");
      if (plan.kind !== "execute") return;
      expect(plan.steps[0]?.params).toMatchObject({
        arguments: {
          domain: "pty",
          action: "create",
          args: {
            chatSessionId: "chat-explicit-1",
          },
        },
      });
    } finally {
      if (previous === undefined) delete process.env.ADE_CHAT_SESSION_ID;
      else process.env.ADE_CHAT_SESSION_ID = previous;
    }
  });

  it("ignores a blank ADE chat session environment value for shell starts", () => {
    const previous = process.env.ADE_CHAT_SESSION_ID;
    try {
      process.env.ADE_CHAT_SESSION_ID = "   ";
      const plan = buildCliPlan([
        "shell",
        "start",
        "--lane",
        "lane-1",
        "--command",
        "npm test",
      ]);
      expect(plan.kind).toBe("execute");
      if (plan.kind !== "execute") return;
      expect(plan.steps[0]?.params).toMatchObject({
        arguments: {
          domain: "pty",
          action: "create",
          args: expect.not.objectContaining({
            chatSessionId: expect.anything(),
          }),
        },
      });
    } finally {
      if (previous === undefined) delete process.env.ADE_CHAT_SESSION_ID;
      else process.env.ADE_CHAT_SESSION_ID = previous;
    }
  });

  it("`ios` and `simulator` are accepted as aliases for `ios-sim`", () => {
    for (const alias of ["ios", "simulator"]) {
      const plan = buildCliPlan([alias, "devices"]);
      expect(plan.kind).toBe("execute");
      if (plan.kind !== "execute") continue;
      expect(plan.steps[0]?.params).toMatchObject({
        arguments: { domain: "ios_simulator", action: "listDevices" },
      });
    }
  });

  it("app-control status maps to app_control actions", () => {
    const status = buildCliPlan(["app-control", "status"]);
    expect(status.kind).toBe("execute");
    if (status.kind !== "execute") return;
    expect(status.steps[0]?.params).toMatchObject({
      name: "run_ade_action",
      arguments: { domain: "app_control", action: "getStatus" },
    });
  });

  it("app-control launch requires a command and supports aliases", () => {
    const launch = buildCliPlan([
      "app-control",
      "launch",
      "--command",
      "npm run dev",
      "--debug-port",
      "9333",
      "--force",
    ]);
    expect(launch.kind).toBe("execute");
    if (launch.kind !== "execute") return;
    expect(launch.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "app_control",
        action: "launch",
        args: {
          command: "npm run dev",
          debugPort: 9333,
          force: true,
        },
      },
    });

    const command = buildCliPlan(["electron", "launch", "pnpm", "dev"]);
    expect(command.kind).toBe("execute");
    if (command.kind !== "execute") return;
    expect(command.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "app_control",
        action: "launch",
        args: { command: "pnpm dev" },
      },
    });
  });

  it("app-control launch, connect, and claim carry the agent lane claim", () => {
    const previousLane = process.env.ADE_LANE_ID;
    const previousChat = process.env.ADE_CHAT_SESSION_ID;
    try {
      process.env.ADE_LANE_ID = "lane-env-1";
      process.env.ADE_CHAT_SESSION_ID = "chat-env-1";
      const launch = buildCliPlan(["app-control", "launch", "--command", "npm run dev"]);
      expect(launch.kind).toBe("execute");
      if (launch.kind !== "execute") return;
      expect(launch.steps[0]?.params).toMatchObject({
        arguments: {
          domain: "app_control",
          action: "launch",
          args: {
            command: "npm run dev",
            laneId: "lane-env-1",
            chatSessionId: "chat-env-1",
          },
        },
      });

      const connect = buildCliPlan(["app-control", "connect", "--cdp-port", "9222"]);
      expect(connect.kind).toBe("execute");
      if (connect.kind !== "execute") return;
      expect(connect.steps[0]?.params).toMatchObject({
        arguments: {
          domain: "app_control",
          action: "connect",
          args: {
            cdpPort: 9222,
            laneId: "lane-env-1",
            chatSessionId: "chat-env-1",
          },
        },
      });

      const claim = buildCliPlan(["app-control", "claim", "--lane", "lane-explicit"]);
      expect(claim.kind).toBe("execute");
      if (claim.kind !== "execute") return;
      expect(claim.steps[0]?.params).toMatchObject({
        arguments: {
          domain: "app_control",
          action: "claim",
          args: {
            laneId: "lane-explicit",
            chatSessionId: "chat-env-1",
          },
        },
      });
    } finally {
      if (previousLane === undefined) delete process.env.ADE_LANE_ID;
      else process.env.ADE_LANE_ID = previousLane;
      if (previousChat === undefined) delete process.env.ADE_CHAT_SESSION_ID;
      else process.env.ADE_CHAT_SESSION_ID = previousChat;
    }
  });

  it("terminal read and write map to terminal actions", () => {
    const read = buildCliPlan([
      "terminal",
      "read",
      "--chat-session",
      "chat-1",
      "--max-bytes",
      "500",
    ]);
    expect(read.kind).toBe("execute");
    if (read.kind !== "execute") return;
    expect(read.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "terminal",
        action: "read",
        args: { chatSessionId: "chat-1", maxBytes: 500 },
      },
    });

    const readByPty = buildCliPlan([
      "terminal",
      "read",
      "--pty",
      "pty-1",
      "--since",
      "12",
    ]);
    expect(readByPty.kind).toBe("execute");
    if (readByPty.kind !== "execute") return;
    expect(readByPty.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "terminal",
        action: "read",
        args: { ptyId: "pty-1", since: 12 },
      },
    });

    const write = buildCliPlan([
      "terminal",
      "write",
      "--terminal",
      "term-1",
      "--data",
      "y\n",
    ]);
    expect(write.kind).toBe("execute");
    if (write.kind !== "execute") return;
    expect(write.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "terminal",
        action: "write",
        args: { terminalId: "term-1", data: "y\n" },
      },
    });
  });

  it("formats shell start text with the terminal read command", () => {
    const text = formatOutput(
      { sessionId: "session-1", ptyId: "pty-1", pid: 1234 },
      { ...baseResolveOpts(), projectRoot: null, workspaceRoot: null, text: true },
      "pty-create",
    );

    expect(text).toContain("ADE shell session");
    expect(text).toContain("session-1");
    expect(text).toContain("pty-1");
    expect(text).toContain("ade terminal read --terminal session-1 --text");
  });

  it("app-control logs and terminal write use the active App Control terminal", () => {
    const logs = buildCliPlan(["app-control", "logs", "--max-bytes", "1024"]);
    expect(logs.kind).toBe("execute");
    if (logs.kind !== "execute") return;
    expect(logs.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "app_control",
        action: "readTerminal",
        args: { maxBytes: 1024 },
      },
    });

    const write = buildCliPlan([
      "app-control",
      "terminal",
      "write",
      "--data",
      "y\n",
    ]);
    expect(write.kind).toBe("execute");
    if (write.kind !== "execute") return;
    expect(write.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "app_control",
        action: "writeTerminal",
        args: { data: "y\n" },
      },
    });
  });

  it("app-control connect, select, click, and type map to App Control actions", () => {
    const connect = buildCliPlan([
      "app-control",
      "connect",
      "--cdp-port",
      "9222",
      "--force",
    ]);
    expect(connect.kind).toBe("execute");
    if (connect.kind !== "execute") return;
    expect(connect.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "app_control",
        action: "connect",
        args: { cdpPort: 9222, force: true },
      },
    });

    const positionalConnect = buildCliPlan(["app-control", "connect", "9333"]);
    expect(positionalConnect.kind).toBe("execute");
    if (positionalConnect.kind !== "execute") return;
    expect(positionalConnect.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "app_control",
        action: "connect",
        args: { cdpPort: 9333 },
      },
    });

    const select = buildCliPlan([
      "app-control",
      "select",
      "--x",
      "120",
      "--y",
      "420",
    ]);
    expect(select.kind).toBe("execute");
    if (select.kind !== "execute") return;
    expect(select.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "app_control",
        action: "selectPoint",
        args: { x: 120, y: 420 },
      },
    });

    const click = buildCliPlan(["app", "click", "120", "420"]);
    expect(click.kind).toBe("execute");
    if (click.kind !== "execute") return;
    expect(click.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "app_control",
        action: "click",
        args: { x: 120, y: 420 },
      },
    });

    const type = buildCliPlan([
      "app-control",
      "type",
      "--value",
      "hello",
      "--text",
    ]);
    expect(type.kind).toBe("execute");
    if (type.kind !== "execute") return;
    expect(type.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "app_control",
        action: "typeText",
        args: { text: "hello" },
      },
    });

    const scroll = buildCliPlan([
      "app-control",
      "scroll",
      "--x",
      "120",
      "--y",
      "420",
      "--delta-y",
      "600",
    ]);
    expect(scroll.kind).toBe("execute");
    if (scroll.kind !== "execute") return;
    expect(scroll.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "app_control",
        action: "scroll",
        args: { x: 120, y: 420, deltaY: 600 },
      },
    });

    const attachTarget = buildCliPlan([
      "app-control",
      "attach-target",
      "--target",
      "target-1",
    ]);
    expect(attachTarget.kind).toBe("execute");
    if (attachTarget.kind !== "execute") return;
    expect(attachTarget.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "app_control",
        action: "attachToTarget",
        argsList: ["target-1"],
      },
    });
  });

  it("browser commands map to built-in browser actions", () => withEnv({
    ADE_LANE_ID: undefined,
    ADE_CHAT_SESSION_ID: undefined,
  }, () => {
    const open = buildCliPlan([
      "browser",
      "open",
      "localhost:5173",
      "--new-tab",
    ]);
    expect(open.kind).toBe("execute");
    if (open.kind !== "execute") return;
    expect(open.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "navigate",
        args: { url: "localhost:5173", newTab: true, openPanel: true },
      },
    });

    const panel = buildCliPlan(["browser", "panel"]);
    expect(panel.kind).toBe("execute");
    if (panel.kind !== "execute") return;
    expect(panel.steps[0]?.params).toMatchObject({
      arguments: { domain: "built_in_browser", action: "showPanel", args: {} },
    });

    const authorize = buildCliPlan([
      "browser",
      "authorize",
      "--tab",
      "tab-1",
      "--lease-ttl-ms",
      "4500",
    ]);
    expect(authorize.kind).toBe("execute");
    if (authorize.kind !== "execute") return;
    expect(authorize.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "requestOriginAccess",
        args: { tabId: "tab-1", leaseTtlMs: 4500 },
      },
    });

    const panelWithUrl = buildCliPlan([
      "browser",
      "panel",
      "--url",
      "localhost:5173",
    ]);
    expect(panelWithUrl.kind).toBe("execute");
    if (panelWithUrl.kind !== "execute") return;
    expect(panelWithUrl.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "showPanel",
        args: { url: "localhost:5173" },
      },
    });

    const targetedOpen = buildCliPlan([
      "browser",
      "open",
      "https://example.com",
      "--tab",
      "tab-1",
    ]);
    expect(targetedOpen.kind).toBe("execute");
    if (targetedOpen.kind !== "execute") return;
    expect(targetedOpen.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "navigate",
        args: { url: "https://example.com", tabId: "tab-1", openPanel: true },
      },
    });

    const hiddenOpen = buildCliPlan([
      "browser",
      "open",
      "https://example.com",
      "--no-panel",
    ]);
    expect(hiddenOpen.kind).toBe("execute");
    if (hiddenOpen.kind !== "execute") return;
    expect(hiddenOpen.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "navigate",
        args: { url: "https://example.com", openPanel: false },
      },
    });

    const openWithGenericArg = buildCliPlan([
      "browser",
      "open",
      "https://example.com",
      "--arg",
      "openPanel=false",
    ]);
    expect(openWithGenericArg.kind).toBe("execute");
    if (openWithGenericArg.kind !== "execute") return;
    expect(openWithGenericArg.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "navigate",
        args: { url: "https://example.com", openPanel: false },
      },
    });

    const openFromGenericUrl = buildCliPlan([
      "browser",
      "open",
      "--arg",
      "url=https://example.com",
    ]);
    expect(openFromGenericUrl.kind).toBe("execute");
    if (openFromGenericUrl.kind !== "execute") return;
    expect(openFromGenericUrl.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "navigate",
        args: { url: "https://example.com", openPanel: true },
      },
    });

    const backgroundTab = buildCliPlan([
      "browser",
      "new-tab",
      "https://example.com",
      "--background",
    ]);
    expect(backgroundTab.kind).toBe("execute");
    if (backgroundTab.kind !== "execute") return;
    expect(backgroundTab.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "createTab",
        args: { url: "https://example.com", activate: false, openPanel: true },
      },
    });

    const switchTab = buildCliPlan(["browser", "switch", "--tab", "tab-1"]);
    expect(switchTab.kind).toBe("execute");
    if (switchTab.kind !== "execute") return;
    expect(switchTab.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "switchTab",
        args: { tabId: "tab-1", openPanel: true },
      },
    });

    const screenshotTab = buildCliPlan(["browser", "screenshot", "--tab", "tab-1"]);
    expect(screenshotTab.kind).toBe("execute");
    if (screenshotTab.kind !== "execute") return;
    expect(screenshotTab.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "captureScreenshot",
        args: { tabId: "tab-1" },
      },
    });

    const reloadTab = buildCliPlan(["browser", "reload", "--tab", "tab-1"]);
    expect(reloadTab.kind).toBe("execute");
    if (reloadTab.kind !== "execute") return;
    expect(reloadTab.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "reload",
        args: { tabId: "tab-1" },
      },
    });

    const observeTab = buildCliPlan(["browser", "observe", "--tab", "tab-1", "--keep", "3", "--max-elements", "12", "--map", "--no-diagnostics"]);
    expect(observeTab.kind).toBe("execute");
    if (observeTab.kind !== "execute") return;
    expect(observeTab.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "observe",
        args: { tabId: "tab-1", keepCount: 3, maxElements: 12, includeElementMap: true, includeDiagnostics: false },
      },
    });

    const trace = buildCliPlan(["browser", "trace", "--tab", "tab-1", "--limit", "7"]);
    expect(trace.kind).toBe("execute");
    if (trace.kind !== "execute") return;
    expect(trace.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "getTrace",
        args: { tabId: "tab-1", limit: 7 },
      },
    });

    const sessionStart = buildCliPlan([
      "browser",
      "session",
      "start",
      "--tab",
      "tab-1",
      "--lane",
      "lane-1",
      "--lease-ttl-ms",
      "6000",
    ]);
    expect(sessionStart.kind).toBe("execute");
    if (sessionStart.kind !== "execute") return;
    expect(sessionStart.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "startSession",
        args: { tabId: "tab-1", laneId: "lane-1", leaseTtlMs: 6000 },
      },
    });

    const sessions = buildCliPlan(["browser", "sessions", "--include-ended"]);
    expect(sessions.kind).toBe("execute");
    if (sessions.kind !== "execute") return;
    expect(sessions.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "listSessions",
        args: { includeEnded: true },
      },
    });

    const sessionEnd = buildCliPlan(["browser", "session", "end", "bs-1"]);
    expect(sessionEnd.kind).toBe("execute");
    if (sessionEnd.kind !== "execute") return;
    expect(sessionEnd.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "endSession",
        args: { sessionId: "bs-1" },
      },
    });

    const observeSession = buildCliPlan(["browser", "observe", "--browser-session", "bs-1", "--map"]);
    expect(observeSession.kind).toBe("execute");
    if (observeSession.kind !== "execute") return;
    expect(observeSession.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "observe",
        args: { sessionId: "bs-1", includeElementMap: true },
      },
    });

    const clickTab = buildCliPlan(["browser", "click", "--tab", "tab-1", "--x", "12", "--y", "24", "--no-observe"]);
    expect(clickTab.kind).toBe("execute");
    if (clickTab.kind !== "execute") return;
    expect(clickTab.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "click",
        args: { tabId: "tab-1", x: 12, y: 24, observe: false },
      },
    });

    const clickSelector = buildCliPlan([
      "browser",
      "click",
      "--tab",
      "tab-1",
      "--selector",
      "button[type=submit]",
      "--no-dom",
    ]);
    expect(clickSelector.kind).toBe("execute");
    if (clickSelector.kind !== "execute") return;
    expect(clickSelector.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "click",
        args: { tabId: "tab-1", selector: "button[type=submit]", includeDom: false },
      },
    });

    const clickText = buildCliPlan(["browser", "click", "--tab", "tab-1", "--text-match", "Sign in"]);
    expect(clickText.kind).toBe("execute");
    if (clickText.kind !== "execute") return;
    expect(clickText.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "click",
        args: { tabId: "tab-1", text: "Sign in" },
      },
    });

    const clickHandle = buildCliPlan(["browser", "click", "--tab", "tab-1", "--handle", "obs-1:e:2", "--fast"]);
    expect(clickHandle.kind).toBe("execute");
    if (clickHandle.kind !== "execute") return;
    expect(clickHandle.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "click",
        args: { tabId: "tab-1", handle: "obs-1:e:2", waitAfterMs: 0 },
      },
    });

    const clickSession = buildCliPlan(["browser", "click", "--browser-session", "bs-1", "--x", "12", "--y", "24"]);
    expect(clickSession.kind).toBe("execute");
    if (clickSession.kind !== "execute") return;
    expect(clickSession.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "click",
        args: { sessionId: "bs-1", x: 12, y: 24 },
      },
    });

    const waitTab = buildCliPlan(["browser", "wait", "--tab", "tab-1", "--selector", ".ready", "--timeout-ms", "2500"]);
    expect(waitTab.kind).toBe("execute");
    if (waitTab.kind !== "execute") return;
    expect(waitTab.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "wait",
        args: { tabId: "tab-1", selector: ".ready", timeoutMs: 2500 },
      },
    });

    const waitNetworkIdle = buildCliPlan(["browser", "wait", "--tab", "tab-1", "--network-idle", "--network-idle-ms", "250"]);
    expect(waitNetworkIdle.kind).toBe("execute");
    if (waitNetworkIdle.kind !== "execute") return;
    expect(waitNetworkIdle.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "wait",
        args: { tabId: "tab-1", loadState: "network-idle", networkIdleMs: 250 },
      },
    });

    const sessionClickAlias = buildCliPlan(["browser", "session", "click", "bs-1", "--x", "12", "--y", "24"]);
    expect(sessionClickAlias.kind).toBe("execute");
    if (sessionClickAlias.kind !== "execute") return;
    expect(sessionClickAlias.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "click",
        args: { sessionId: "bs-1", x: 12, y: 24 },
      },
    });

    const sessionWaitAlias = buildCliPlan(["browser", "session", "wait", "bs-1", "--network-idle", "--network-idle-ms", "250"]);
    expect(sessionWaitAlias.kind).toBe("execute");
    if (sessionWaitAlias.kind !== "execute") return;
    expect(sessionWaitAlias.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "wait",
        args: { sessionId: "bs-1", loadState: "network-idle", networkIdleMs: 250 },
      },
    });

    const fillTab = buildCliPlan(["browser", "fill", "--tab", "tab-1", "--selector", "input[name=email]", "--value", "me@example.com", "--lane", "lane-1", "--lease-ttl-ms", "5000"]);
    expect(fillTab.kind).toBe("execute");
    if (fillTab.kind !== "execute") return;
    expect(fillTab.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "fill",
        args: {
          tabId: "tab-1",
          selector: "input[name=email]",
          text: "me@example.com",
          laneId: "lane-1",
          leaseTtlMs: 5000,
        },
      },
    });

    const fillByText = buildCliPlan(["browser", "fill", "--tab", "tab-1", "--text-match", "Email", "--value", "me@example.com"]);
    expect(fillByText.kind).toBe("execute");
    if (fillByText.kind !== "execute") return;
    expect(fillByText.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "fill",
        args: {
          tabId: "tab-1",
          text: "Email",
          value: "me@example.com",
        },
      },
    });

    const clearField = buildCliPlan(["browser", "clear-field", "--tab", "tab-1", "--test-id", "search"]);
    expect(clearField.kind).toBe("execute");
    if (clearField.kind !== "execute") return;
    expect(clearField.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "clear",
        args: { tabId: "tab-1", testId: "search" },
      },
    });

    const typeTab = buildCliPlan(["browser", "type", "--tab", "tab-1", "hello"]);
    expect(typeTab.kind).toBe("execute");
    if (typeTab.kind !== "execute") return;
    expect(typeTab.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "typeText",
        args: { tabId: "tab-1", text: "hello" },
      },
    });

    const keyTab = buildCliPlan(["browser", "press", "--tab", "tab-1", "--selector", "input[name=q]", "Enter"]);
    expect(keyTab.kind).toBe("execute");
    if (keyTab.kind !== "execute") return;
    expect(keyTab.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "dispatchKey",
        args: { tabId: "tab-1", selector: "input[name=q]", key: "Enter" },
      },
    });

    const scrollTab = buildCliPlan(["browser", "scroll", "--tab", "tab-1", "--dy", "480"]);
    expect(scrollTab.kind).toBe("execute");
    if (scrollTab.kind !== "execute") return;
    expect(scrollTab.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "scroll",
        args: { tabId: "tab-1", deltaX: 0, deltaY: 480 },
      },
    });

    const selectPoint = buildCliPlan([
      "browser",
      "select",
      "--x",
      "120",
      "--y",
      "420",
      "--tab",
      "tab-1",
      "--no-screenshot",
    ]);
    expect(selectPoint.kind).toBe("execute");
    if (selectPoint.kind !== "execute") return;
    expect(selectPoint.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "selectPoint",
        args: { tabId: "tab-1", x: 120, y: 420, includeScreenshot: false },
      },
    });

    const proof = buildCliPlan(["browser", "proof", "--tab", "tab-1", "--caption", "Verified"]);
    expect(proof.kind).toBe("execute");
    if (proof.kind !== "execute") return;
    expect(proof.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "observe",
        args: { tabId: "tab-1", includeDom: false },
      },
    });
    const proofParams = proof.steps[1]?.params;
    expect(typeof proofParams).toBe("function");
    if (typeof proofParams !== "function") return;
    expect(proofParams({ observation: { filePath: "/tmp/browser-proof.png" } })).toMatchObject({
      name: "ingest_computer_use_artifacts",
      arguments: {
        backendName: "ade-browser",
        toolName: "browser proof",
        inputs: [
          {
            kind: "screenshot",
            title: "Verified",
            description: "Verified",
            path: "/tmp/browser-proof.png",
          },
        ],
      },
    });
  }));

  it("browser open and claim commands carry the agent lane claim", () => {
    const previousLane = process.env.ADE_LANE_ID;
    const previousChat = process.env.ADE_CHAT_SESSION_ID;
    try {
      process.env.ADE_LANE_ID = "lane-env-1";
      process.env.ADE_CHAT_SESSION_ID = "chat-env-1";

      const open = buildCliPlan(["browser", "open", "localhost:5173"]);
      expect(open.kind).toBe("execute");
      if (open.kind !== "execute") return;
      expect(open.steps[0]?.params).toMatchObject({
        arguments: {
          domain: "built_in_browser",
          action: "navigate",
          args: {
            url: "localhost:5173",
            activate: false,
            reuseOwnedTab: true,
            openPanel: false,
            laneId: "lane-env-1",
            chatSessionId: "chat-env-1",
          },
        },
      });

      const newTabOpen = buildCliPlan(["browser", "open", "localhost:5173", "--new-tab"]);
      expect(newTabOpen.kind).toBe("execute");
      if (newTabOpen.kind !== "execute") return;
      expect(newTabOpen.steps[0]?.params).toMatchObject({
        arguments: {
          domain: "built_in_browser",
          action: "navigate",
          args: {
            url: "localhost:5173",
            activate: false,
            newTab: true,
            openPanel: false,
            laneId: "lane-env-1",
            chatSessionId: "chat-env-1",
          },
        },
      });
      expect((newTabOpen.steps[0]?.params as any).arguments.args.reuseOwnedTab).toBeUndefined();

      const panelOpen = buildCliPlan(["browser", "open", "localhost:5173", "--panel"]);
      expect(panelOpen.kind).toBe("execute");
      if (panelOpen.kind !== "execute") return;
      expect(panelOpen.steps[0]?.params).toMatchObject({
        arguments: {
          domain: "built_in_browser",
          action: "navigate",
          args: {
            url: "localhost:5173",
            reuseOwnedTab: true,
            openPanel: true,
            laneId: "lane-env-1",
            chatSessionId: "chat-env-1",
          },
        },
      });
      expect((panelOpen.steps[0]?.params as any).arguments.args.activate).toBeUndefined();

      const activeOpen = buildCliPlan(["browser", "open", "localhost:5173", "--active-tab"]);
      expect(activeOpen.kind).toBe("execute");
      if (activeOpen.kind !== "execute") return;
      expect(activeOpen.steps[0]?.params).toMatchObject({
        arguments: {
          domain: "built_in_browser",
          action: "navigate",
          args: {
            url: "localhost:5173",
            openPanel: false,
            laneId: "lane-env-1",
            chatSessionId: "chat-env-1",
          },
        },
      });
      expect((activeOpen.steps[0]?.params as any).arguments.args.newTab).toBeUndefined();
      expect((activeOpen.steps[0]?.params as any).arguments.args.activate).toBeUndefined();

      const ownedScreenshot = buildCliPlan(["browser", "screenshot"]);
      expect(ownedScreenshot.kind).toBe("execute");
      if (ownedScreenshot.kind !== "execute") return;
      expect(ownedScreenshot.steps[0]?.params).toMatchObject({
        arguments: {
          domain: "built_in_browser",
          action: "captureScreenshot",
          args: {
            laneId: "lane-env-1",
            chatSessionId: "chat-env-1",
          },
        },
      });

      const panel = buildCliPlan(["browser", "panel"]);
      expect(panel.kind).toBe("execute");
      if (panel.kind !== "execute") return;
      expect((panel.steps[0]?.params as any).arguments.args).toEqual({});
      expect(panel.steps[0]?.params).toMatchObject({
        arguments: {
          domain: "built_in_browser",
          action: "showPanel",
          args: {},
        },
      });

      const switchTab = buildCliPlan(["browser", "switch", "--tab", "tab-1"]);
      expect(switchTab.kind).toBe("execute");
      if (switchTab.kind !== "execute") return;
      expect((switchTab.steps[0]?.params as any).arguments.args).toEqual({
        tabId: "tab-1",
        openPanel: true,
      });
      expect(switchTab.steps[0]?.params).toMatchObject({
        arguments: {
          domain: "built_in_browser",
          action: "switchTab",
          args: {
            tabId: "tab-1",
            openPanel: true,
          },
        },
      });

      const explicitSwitchClaim = buildCliPlan([
        "browser",
        "switch",
        "--tab",
        "tab-1",
        "--lane",
        "lane-explicit",
        "--chat-session",
        "chat-explicit",
      ]);
      expect(explicitSwitchClaim.kind).toBe("execute");
      if (explicitSwitchClaim.kind !== "execute") return;
      expect(explicitSwitchClaim.steps[0]?.params).toMatchObject({
        arguments: {
          domain: "built_in_browser",
          action: "switchTab",
          args: {
            tabId: "tab-1",
            openPanel: true,
            laneId: "lane-explicit",
            chatSessionId: "chat-explicit",
          },
        },
      });

      const claim = buildCliPlan([
        "browser",
        "claim",
        "--lane",
        "lane-explicit",
        "--chat-session",
        "chat-explicit",
        "--tab",
        "tab-1",
        "--force",
        "--lease-ttl-ms",
        "7000",
      ]);
      expect(claim.kind).toBe("execute");
      if (claim.kind !== "execute") return;
      expect(claim.steps[0]?.params).toMatchObject({
        arguments: {
          domain: "built_in_browser",
          action: "claim",
          args: {
            laneId: "lane-explicit",
            chatSessionId: "chat-explicit",
            tabId: "tab-1",
            force: true,
            leaseTtlMs: 7000,
          },
        },
      });
    } finally {
      if (previousLane === undefined) delete process.env.ADE_LANE_ID;
      else process.env.ADE_LANE_ID = previousLane;
      if (previousChat === undefined) delete process.env.ADE_CHAT_SESSION_ID;
      else process.env.ADE_CHAT_SESSION_ID = previousChat;
    }
  });

  it("update commands map to auto-update actions", () => {
    const status = buildCliPlan(["update", "status"]);
    expect(status.kind).toBe("execute");
    if (status.kind !== "execute") return;
    expect(status.steps[0]?.params).toMatchObject({
      arguments: { domain: "update", action: "getSnapshot", args: {} },
    });

    const check = buildCliPlan(["auto-update", "check"]);
    expect(check.kind).toBe("execute");
    if (check.kind !== "execute") return;
    expect(check.steps[0]?.params).toMatchObject({
      arguments: { domain: "update", action: "checkForUpdates", args: {} },
    });

    const install = buildCliPlan(["updates", "install"]);
    expect(install.kind).toBe("execute");
    if (install.kind !== "execute") return;
    expect(install.steps[0]?.params).toMatchObject({
      arguments: { domain: "update", action: "quitAndInstall", args: {} },
    });

    const dismiss = buildCliPlan(["update", "dismiss"]);
    expect(dismiss.kind).toBe("execute");
    if (dismiss.kind !== "execute") return;
    expect(dismiss.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "update",
        action: "dismissInstalledNotice",
        args: {},
      },
    });

    const actions = buildCliPlan(["update", "actions"]);
    expect(actions.kind).toBe("execute");
    if (actions.kind !== "execute") return;
    expect(actions.steps[0]?.params).toMatchObject({
      name: "list_ade_actions",
      arguments: { domain: "update" },
    });
  });

  it("usage snapshot routes to the usage.getUsageSnapshot action with no args", () => {
    const plan = buildCliPlan(["usage", "snapshot"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("usage snapshot");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: { domain: "usage", action: "getUsageSnapshot", args: {} },
    });

    const aliased = buildCliPlan(["quota", "snapshot"]);
    expect(aliased.kind).toBe("execute");
    if (aliased.kind !== "execute") return;
    expect(aliased.steps[0]?.params).toEqual(plan.steps[0]?.params);
  });

  it("usage refresh routes to the usage.forceRefresh action", () => {
    const plan = buildCliPlan(["usage", "refresh"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("usage refresh");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: { domain: "usage", action: "forceRefresh", args: {} },
    });

    const polled = buildCliPlan(["usage", "poll"]);
    expect(polled.kind).toBe("execute");
    if (polled.kind !== "execute") return;
    expect(polled.steps[0]?.params).toEqual(plan.steps[0]?.params);

    const history = buildCliPlan(["usage", "refresh", "--history"]);
    expect(history.kind).toBe("execute");
    if (history.kind !== "execute") return;
    expect(history.label).toBe("usage history refresh");
    expect(history.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: { domain: "usage", action: "refreshHistory", args: {} },
    });
  });

  it("usage budget get routes to the budget.getConfig action", () => {
    const plan = buildCliPlan(["usage", "budget", "get"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("usage budget get");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: { domain: "budget", action: "getConfig", args: {} },
    });
  });

  it("usage budget set --from-file parses the JSON body and forwards it as args", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-usage-budget-"));
    const budgetPath = path.join(root, "budget.json");
    const config = { caps: [{ provider: "claude", scope: "global", limitUsd: 25 }] };
    fs.writeFileSync(budgetPath, JSON.stringify(config));

    const plan = buildCliPlan(["usage", "budget", "set", "--from-file", budgetPath]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("usage budget update");
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: { domain: "budget", action: "updateConfig", args: config },
    });

    expect(() =>
      buildCliPlan(["usage", "budget", "set", "--text", "[1,2,3]"]),
    ).toThrow(/must be a JSON object/i);
    expect(() =>
      buildCliPlan(["usage", "budget", "set", "--text", "   \n  "]),
    ).toThrow(/non-empty JSON object/i);
    expect(() => buildCliPlan(["usage", "budget", "set"])).toThrow(
      /at least one field/i,
    );
    expect(() =>
      buildCliPlan(["usage", "budget", "set", "--text", "{}"]),
    ).toThrow(/at least one field/i);
  });

  it("usage budget check defaults scope to global and forwards --provider", () => {
    const plan = buildCliPlan(["usage", "budget", "check", "--provider", "claude"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("usage budget check");
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "budget",
        action: "checkBudget",
        args: { scope: "global", scopeId: null, provider: "claude" },
      },
    });

    expect(() => buildCliPlan(["usage", "budget", "bogus"])).toThrow(
      /usage budget supports get, set, check, or cumulative/,
    );
  });

  it("usage budget cumulative routes with scope parameters", () => {
    const plan = buildCliPlan(["usage", "budget", "cumulative", "--scope", "global"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("usage budget cumulative");
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "budget",
        action: "getCumulativeUsage",
        args: { scope: "global", scopeId: null, provider: null },
      },
    });

    const aliased = buildCliPlan([
      "quota",
      "budget",
      "totals",
      "--provider",
      "cursor",
    ]);
    expect(aliased.kind).toBe("execute");
    if (aliased.kind !== "execute") return;
    expect(aliased.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "budget",
        action: "getCumulativeUsage",
        args: { scope: "global", scopeId: null, provider: "cursor" },
      },
    });
  });

  it("usage command aliases resolve to usage help", () => {
    const direct = buildCliPlan(["usage", "--help"]);
    const quota = buildCliPlan(["quota", "--help"]);
    const helpQuota = buildCliPlan(["help", "quota"]);
    expect(direct.kind).toBe("help");
    expect(quota.kind).toBe("help");
    expect(helpQuota.kind).toBe("help");
    if (direct.kind !== "help" || quota.kind !== "help" || helpQuota.kind !== "help") return;
    expect(quota.text).toBe(direct.text);
    expect(helpQuota.text).toBe(direct.text);
  });

  it("parses ade history list with operation filters", () => {
    const plan = buildCliPlan([
      "history",
      "list",
      "--lane",
      "lane-1",
      "--kind",
      "push",
      "--status",
      "succeeded",
      "--limit",
      "25",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("history list");
    expect(plan.formatter).toBe("history-list");
    expect(plan.historyStatusFilter).toBe("succeeded");
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "operation",
        action: "list",
        args: { laneId: "lane-1", kind: "push", status: "succeeded", limit: 25 },
      },
    });
  });

  it("parses ade history show by operation id", () => {
    const plan = buildCliPlan(["history", "show", "--id", "op-1"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("history show");
    expect(plan.historyOperationId).toBe("op-1");
    expect(plan.formatter).toBe("history-show");
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: { domain: "operation", action: "get", args: { operationId: "op-1" } },
    });
  });

  it("parses ade history commits for a lane", () => {
    const plan = buildCliPlan([
      "history",
      "commits",
      "--lane",
      "lane-1",
      "--limit",
      "12",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("history commits");
    expect(plan.formatter).toBe("history-commits");
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "git",
        action: "listRecentCommits",
        args: { laneId: "lane-1", limit: 12 },
      },
    });
  });

  it("parses ade history export to a file", () => {
    const plan = buildCliPlan([
      "history",
      "export",
      "--lane",
      "lane-1",
      "--status",
      "failed",
      "--out",
      "/tmp/history.json",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("history export");
    expect(plan.writeResultPath).toBe("/tmp/history.json");
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "operation",
        action: "list",
        args: { laneId: "lane-1", status: "failed", limit: 1000 },
      },
    });
  });

  it("honors ade history export --limit", () => {
    const plan = buildCliPlan([
      "history",
      "export",
      "--lane",
      "lane-1",
      "--limit",
      "100",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "operation",
        action: "list",
        args: { laneId: "lane-1", limit: 100 },
      },
    });
  });

  it("shows help for ade history", () => {
    const plan = buildCliPlan(["history", "--help"]);
    expect(plan.kind).toBe("help");
    if (plan.kind !== "help") return;
    expect(plan.text).toContain("ade history list");
    expect(plan.text).toContain("ade history export");
  });

  it("attaches a rendered lane graph when the plan has the lanes visualizer", () => {
    const connection = {
      mode: "headless" as const,
      projectRoot: "/tmp/project",
      workspaceRoot: "/tmp/project",
      socketPath: "/tmp/project/.ade/ade.sock",
      request: async () => null,
      close: () => {},
    };
    const summarized = summarizeExecution({
      plan: {
        kind: "execute",
        label: "lanes list",
        steps: [],
        visualizer: "lanes",
      },
      connection,
      values: {
        result: {
          lanes: [
            { id: "main", name: "main", branchRef: "main" },
            {
              id: "child",
              name: "child",
              branchRef: "feature",
              parentLaneId: "main",
            },
          ],
        },
      },
    } as any);
    expect(summarized).toMatchObject({
      lanes: expect.any(Array),
    });
    expect((summarized as any).visual).toContain("\\- main (id: main) [main]");
    expect((summarized as any).visual).toContain(
      "\\- child (id: child) [feature]",
    );
  });
});
