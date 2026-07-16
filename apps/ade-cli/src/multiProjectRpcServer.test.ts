import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createEventBuffer } from "./eventBuffer";
import { createMultiProjectRpcRequestHandler } from "./multiProjectRpcServer";
import * as gitModule from "../../desktop/src/main/services/git/git";
import { ProjectRegistry } from "./services/projects/projectRegistry";
import { ProjectScopeRegistry } from "./services/projects/projectScope";

function createRegistry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-multi-project-rpc-"));
  const rawProjectRoot = path.join(root, "project");
  fs.mkdirSync(rawProjectRoot, { recursive: true });
  const projectRoot = fs.realpathSync.native(rawProjectRoot);
  const expectedProjectRoot = projectRoot;
  const registry = new ProjectRegistry({
    adeDir: path.join(root, "home"),
    projectsPath: path.join(root, "home", "projects.json"),
    secretsDir: path.join(root, "home", "secrets"),
    sockDir: path.join(root, "home", "sock"),
    socketPath: path.join(root, "home", "sock", "ade.sock"),
    desktopBridgeSocketPath: path.join(root, "home", "sock", "desktop-bridge.sock"),
    binDir: path.join(root, "home", "bin"),
    runtimeDir: path.join(root, "home", "runtime"),
  });
  return { root, projectRoot, expectedProjectRoot, registry };
}

function makeAccountAuthServiceMock() {
  return {
    startLogin: vi.fn(async () => ({
      sessionId: "test-session",
      authorizeUrl: "https://accounts.example/authorize",
      expiresAt: "2026-05-10T00:05:00.000Z",
    })),
    pollLogin: vi.fn(async () => ({
      status: "pending" as const,
      message: null,
      authStatus: {
        signedIn: false,
        userId: null,
        email: null,
        name: null,
        expiresAt: null,
      },
    })),
    startDeviceLogin: vi.fn(async () => ({
      sessionId: "device-session",
      userCode: "ABCD-EFGH",
      verificationUri: "https://accounts.example/device",
      verificationUriComplete: "https://accounts.example/device?user_code=ABCD-EFGH",
      expiresAt: "2026-05-10T00:10:00.000Z",
      intervalSec: 5,
    })),
    pollDeviceLogin: vi.fn(async () => ({
      status: "pending" as const,
      message: null,
      intervalSec: 5,
      authStatus: {
        signedIn: false,
        userId: null,
        email: null,
        name: null,
        expiresAt: null,
      },
    })),
    getStatus: vi.fn(() => ({
      signedIn: false,
      userId: null,
      email: null,
      name: null,
      expiresAt: null,
    })),
    getSessionReadState: vi.fn(() => "missing" as const),
    getAccessToken: vi.fn(async () => "test-access-token"),
    createToken: vi.fn(async () => ({
      token: "test-refresh-token",
      source: "refresh_token" as const,
      guidance: "Set ADE_ACCOUNT_TOKEN.",
    })),
    cancelLogin: vi.fn(),
    signOut: vi.fn(() => ({
      signedIn: false,
      userId: null,
      email: null,
      name: null,
      expiresAt: null,
    })),
    onSignedIn: vi.fn(() => () => {}),
    dispose: vi.fn(),
  };
}

function restoreEnvVar(key: string, previous: string | undefined) {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}

function makeRuntime(label: string) {
  return {
    operationService: {
      start: vi.fn(() => ({ operationId: `${label}-operation`, startedAt: "2026-05-10T00:00:00.000Z" })),
      finish: vi.fn(),
    },
    laneService: {
      list: vi.fn(async () => [{ id: `${label}-lane`, name: label }]),
    },
    sessionService: {
      get: vi.fn(() => null),
    },
    syncService: {
      getStatus: vi.fn(async () => ({ role: "brain", label })),
      listDevices: vi.fn(async () => [{ deviceId: `${label}-device` }]),
    },
    eventBuffer: createEventBuffer(),
    dispose: vi.fn(),
  };
}

describe("multi-project RPC server", () => {
  it("reconciles account-owned client trust on sign-out and account switch", async () => {
    const { registry } = createRegistry();
    const accountAuthService = makeAccountAuthServiceMock();
    const reconcileAccountOwnership = vi.fn();
    const previousDefaultRole = process.env.ADE_DEFAULT_ROLE;
    process.env.ADE_DEFAULT_ROLE = "cto";
    try {
      const handler = createMultiProjectRpcRequestHandler({
        serverVersion: "test",
        projectRegistry: registry,
        accountAuthService,
        reconcileAccountOwnership,
      });
      await handler({
        jsonrpc: "2.0",
        id: 1,
        method: "ade/initialize",
        params: { identity: { role: "cto" } },
      });

      await handler({
        jsonrpc: "2.0",
        id: 2,
        method: "account.call",
        params: { action: "signOut", args: {} },
      });
      expect(reconcileAccountOwnership).toHaveBeenLastCalledWith(null);

      (accountAuthService.pollLogin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        status: "signed_in",
        message: null,
        authStatus: {
          signedIn: true,
          userId: "account-b",
          email: null,
          name: null,
          expiresAt: "2026-07-15T22:00:00.000Z",
        },
      });
      await handler({
        jsonrpc: "2.0",
        id: 3,
        method: "account.call",
        params: { action: "pollLogin", args: { sessionId: "test-session" } },
      });
      expect(reconcileAccountOwnership).toHaveBeenLastCalledWith("account-b");

      (accountAuthService.getStatus as ReturnType<typeof vi.fn>).mockReturnValue({
        signedIn: true,
        userId: "account-b",
        email: null,
        name: null,
        expiresAt: "2026-07-15T22:00:00.000Z",
      });
      (accountAuthService.getAccessToken as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error("ADE account session expired."));
      await handler({
        jsonrpc: "2.0",
        id: 4,
        method: "account.call",
        params: { action: "listMachines", args: {} },
      });
      expect(reconcileAccountOwnership).toHaveBeenLastCalledWith(null);
      handler.dispose();
    } finally {
      restoreEnvVar("ADE_DEFAULT_ROLE", previousDefaultRole);
    }
  });

  it("exposes the machine account action domain without a project id", async () => {
    const { registry } = createRegistry();
    const accountAuthService = {
      startLogin: vi.fn(),
      pollLogin: vi.fn(),
      startDeviceLogin: vi.fn(),
      pollDeviceLogin: vi.fn(),
      getStatus: vi.fn(() => ({
        signedIn: false,
        userId: null,
        email: null,
        name: null,
        expiresAt: null,
      })),
      getSessionReadState: vi.fn(() => "missing" as const),
      getAccessToken: vi.fn(),
      createToken: vi.fn(),
      cancelLogin: vi.fn(),
      signOut: vi.fn(),
      onSignedIn: vi.fn(() => () => {}),
      dispose: vi.fn(),
    };
    const handler = createMultiProjectRpcRequestHandler({
      serverVersion: "test",
      projectRegistry: registry,
      accountAuthService,
    });

    await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "ade/initialize",
      params: {},
    });
    const result = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "account.call",
      params: { action: "status" },
    });

    expect(result).toEqual({
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
    });
    expect(accountAuthService.getStatus).toHaveBeenCalledTimes(1);
    expect(registry.list()).toHaveLength(0);
    handler.dispose();
  });

  it("allows the open account.status action for a non-cto caller", async () => {
    const { registry } = createRegistry();
    const accountAuthService = makeAccountAuthServiceMock();
    (accountAuthService.getStatus as ReturnType<typeof vi.fn>).mockReturnValue({
      signedIn: true,
      userId: "user_123",
      email: "person@example.com",
      name: "Person",
      expiresAt: "2026-07-15T10:00:00.000Z",
      source: "env-token",
    });
    const previousDefaultRole = process.env.ADE_DEFAULT_ROLE;
    process.env.ADE_DEFAULT_ROLE = "agent";
    try {
      const handler = createMultiProjectRpcRequestHandler({
        serverVersion: "test",
        projectRegistry: registry,
        accountAuthService,
      });
      await handler({
        jsonrpc: "2.0",
        id: 1,
        method: "ade/initialize",
        params: { identity: { role: "agent" } },
      });
      const result = await handler({
        jsonrpc: "2.0",
        id: 2,
        method: "account.call",
        params: { action: "status" },
      });
      expect(result).toEqual({
        domain: "account",
        action: "status",
        result: {
          signedIn: true,
          userId: null,
          email: null,
          name: null,
          expiresAt: "2026-07-15T10:00:00.000Z",
          source: "env-token",
        },
        statusHints: {},
      });
      expect(accountAuthService.getStatus).toHaveBeenCalledTimes(1);
      handler.dispose();
    } finally {
      restoreEnvVar("ADE_DEFAULT_ROLE", previousDefaultRole);
    }
  });

  it("rejects cto-only account actions for a non-cto caller", async () => {
    const { registry } = createRegistry();
    const accountAuthService = makeAccountAuthServiceMock();
    const previousDefaultRole = process.env.ADE_DEFAULT_ROLE;
    process.env.ADE_DEFAULT_ROLE = "agent";
    try {
      const handler = createMultiProjectRpcRequestHandler({
        serverVersion: "test",
        projectRegistry: registry,
        accountAuthService,
      });
      await handler({
        jsonrpc: "2.0",
        id: 1,
        method: "ade/initialize",
        params: { identity: { role: "agent" } },
      });
      for (const action of [
        "getToken",
        "createToken",
        "startLogin",
        "startDeviceLogin",
        "pollDeviceLogin",
        "cancelLogin",
        "signOut",
        "listMachines",
        "pairMachine",
      ]) {
        await expect(
          handler({
            jsonrpc: "2.0",
            id: 2,
            method: "account.call",
            params: { action },
          }),
        ).rejects.toThrow(/requires the cto role/);
      }
      expect(accountAuthService.getAccessToken).not.toHaveBeenCalled();
      expect(accountAuthService.createToken).not.toHaveBeenCalled();
      expect(accountAuthService.startLogin).not.toHaveBeenCalled();
      expect(accountAuthService.startDeviceLogin).not.toHaveBeenCalled();
      expect(accountAuthService.pollDeviceLogin).not.toHaveBeenCalled();
      expect(accountAuthService.cancelLogin).not.toHaveBeenCalled();
      expect(accountAuthService.signOut).not.toHaveBeenCalled();
      handler.dispose();
    } finally {
      restoreEnvVar("ADE_DEFAULT_ROLE", previousDefaultRole);
    }
  });

  it("rejects cto-only account actions when the caller sends no identity", async () => {
    const { registry } = createRegistry();
    const accountAuthService = makeAccountAuthServiceMock();
    const previousDefaultRole = process.env.ADE_DEFAULT_ROLE;
    delete process.env.ADE_DEFAULT_ROLE;
    try {
      const handler = createMultiProjectRpcRequestHandler({
        serverVersion: "test",
        projectRegistry: registry,
        accountAuthService,
      });
      await handler({
        jsonrpc: "2.0",
        id: 1,
        method: "ade/initialize",
        params: {},
      });
      await expect(
        handler({
          jsonrpc: "2.0",
          id: 2,
          method: "account.call",
          params: { action: "getToken" },
        }),
      ).rejects.toThrow(/requires the cto role/);
      expect(accountAuthService.getAccessToken).not.toHaveBeenCalled();
      handler.dispose();
    } finally {
      restoreEnvVar("ADE_DEFAULT_ROLE", previousDefaultRole);
    }
  });

  it("allows cto-only account actions for a cto caller", async () => {
    const { registry } = createRegistry();
    const accountAuthService = makeAccountAuthServiceMock();
    const previousDefaultRole = process.env.ADE_DEFAULT_ROLE;
    process.env.ADE_DEFAULT_ROLE = "cto";
    try {
      const handler = createMultiProjectRpcRequestHandler({
        serverVersion: "test",
        projectRegistry: registry,
        accountAuthService,
      });
      await handler({
        jsonrpc: "2.0",
        id: 1,
        method: "ade/initialize",
        params: { identity: { role: "cto" } },
      });
      const result = await handler({
        jsonrpc: "2.0",
        id: 2,
        method: "account.call",
        params: { action: "getToken" },
      });
      expect(result).toMatchObject({
        domain: "account",
        action: "getToken",
        result: "test-access-token",
      });
      expect(accountAuthService.getAccessToken).toHaveBeenCalledTimes(1);
      handler.dispose();
    } finally {
      restoreEnvVar("ADE_DEFAULT_ROLE", previousDefaultRole);
    }
  });

  it("prioritizes the invoking project config root for durable token creation", async () => {
    const { projectRoot, registry } = createRegistry();
    const accountAuthService = makeAccountAuthServiceMock();
    const registerAccountConfigRoot = vi.fn();
    const previousDefaultRole = process.env.ADE_DEFAULT_ROLE;
    process.env.ADE_DEFAULT_ROLE = "cto";
    try {
      const handler = createMultiProjectRpcRequestHandler({
        serverVersion: "test",
        projectRegistry: registry,
        accountAuthService,
        registerAccountConfigRoot,
      });
      await handler({
        jsonrpc: "2.0",
        id: 1,
        method: "ade/initialize",
        params: { identity: { role: "cto" } },
      });
      await handler({
        jsonrpc: "2.0",
        id: 2,
        method: "account.call",
        params: {
          action: "createToken",
          args: { projectRoot },
        },
      });

      expect(registerAccountConfigRoot).toHaveBeenCalledWith(projectRoot, undefined, {
        prioritize: true,
      });
      expect(accountAuthService.createToken).toHaveBeenCalledTimes(1);
      expect(registry.list()).toEqual([]);
      handler.dispose();
    } finally {
      restoreEnvVar("ADE_DEFAULT_ROLE", previousDefaultRole);
    }
  });

  it("reports a build hash for manually-started CLI entrypoints", async () => {
    const { registry, root } = createRegistry();
    const cliPath = path.join(root, "manual-cli.cjs");
    fs.writeFileSync(cliPath, "console.log('manual runtime');\n");
    const expectedHash = createHash("sha256").update(fs.readFileSync(cliPath)).digest("hex");
    const originalArgv = process.argv;
    const originalBuildHash = process.env.ADE_RUNTIME_BUILD_HASH;
    process.argv = [originalArgv[0] ?? "node", cliPath];
    delete process.env.ADE_RUNTIME_BUILD_HASH;
    try {
      const handler = createMultiProjectRpcRequestHandler({
        serverVersion: "test",
        projectRegistry: registry,
      });

      const init = await handler({
        jsonrpc: "2.0",
        id: 1,
        method: "ade/initialize",
        params: {},
      });

      expect(init).toMatchObject({
        runtimeInfo: {
          buildHash: expectedHash,
          multiProject: true,
        },
      });
      handler.dispose();
    } finally {
      process.argv = originalArgv;
      if (originalBuildHash === undefined) {
        delete process.env.ADE_RUNTIME_BUILD_HASH;
      } else {
        process.env.ADE_RUNTIME_BUILD_HASH = originalBuildHash;
      }
    }
  });

  it("exposes machine personal chats without a project id", async () => {
    const { registry } = createRegistry();
    const personalChatScope = {
      capabilities: vi.fn(() => ({ version: 1 as const, actions: ["list" as const, "send" as const] })),
      call: vi.fn(async (action: unknown, args: unknown) => ({ action: action as "list", result: args })),
      streamEvents: vi.fn(async () => ({
        events: [],
        nextCursor: 0,
        hasMore: false,
        eventEpoch: "epoch",
        gap: false,
        oldestCursor: null,
      })),
      transcriptPath: vi.fn(async () => null),
      isTurnActive: vi.fn(async () => false),
      dispose: vi.fn(async () => undefined),
    };
    const handler = createMultiProjectRpcRequestHandler({
      serverVersion: "test",
      projectRegistry: registry,
      personalChatScope,
    });

    const initialized = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "ade/initialize",
      params: {},
    });
    expect(initialized).toMatchObject({
      capabilities: { personalChats: { version: 1, actions: ["list", "send"] } },
    });
    await expect(handler({
      jsonrpc: "2.0",
      id: 2,
      method: "personalChats.call",
      params: { action: "send", args: { sessionId: "personal-1", text: "hello" } },
    })).resolves.toEqual({
      action: "send",
      result: { sessionId: "personal-1", text: "hello" },
    });
    expect(personalChatScope.call).toHaveBeenCalledWith("send", {
      sessionId: "personal-1",
      text: "hello",
    });
    handler.dispose();
    expect(personalChatScope.dispose).not.toHaveBeenCalled();
  });

  it("exposes runtime-scoped project registry methods", async () => {
    const { projectRoot, expectedProjectRoot, registry } = createRegistry();
    const handler = createMultiProjectRpcRequestHandler({
      serverVersion: "test",
      projectRegistry: registry,
    });

    await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "ade/initialize",
      params: { protocolVersion: "test" },
    });

    const added = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "projects.add",
      params: {
        rootPath: projectRoot,
        catalogVisibility: "system",
        registrationSource: "test",
      },
    });
    expect(added).toMatchObject({
      rootPath: expectedProjectRoot,
      displayName: "project",
      gitOriginUrl: null,
      catalogVisibility: "system",
      registrationSource: "test",
    });

    const listed = await handler({
      jsonrpc: "2.0",
      id: 3,
      method: "projects.list",
      params: {},
    });
    // Both projects.add and projects.list stamp the host-resolved icon; the
    // temp project root has no icon file, so each yields the same all-null icon.
    expect(listed).toEqual([added]);

    const projectId = (added as { projectId: string }).projectId;
    const touched = await handler({
      jsonrpc: "2.0",
      id: 4,
      method: "projects.touch",
      params: { projectId },
    });
    expect((touched as { projectId: string }).projectId).toBe(projectId);

    await handler({
      jsonrpc: "2.0",
      id: 5,
      method: "projects.remove",
      params: { projectId },
    });
    expect(await handler({ jsonrpc: "2.0", id: 6, method: "projects.list", params: {} })).toEqual([]);

    // projects.inspectPath routes to the shared desktop inspector: a plain
    // directory (not a git checkout) classifies as not-git with no parent.
    expect(await handler({
      jsonrpc: "2.0",
      id: 7,
      method: "projects.inspectPath",
      params: { path: projectRoot },
    })).toMatchObject({
      kind: "not-git",
      worktreeRoot: null,
      parent: null,
    });
    await expect(handler({
      jsonrpc: "2.0",
      id: 8,
      method: "projects.inspectPath",
      params: {},
    })).rejects.toThrow("projects.inspectPath requires path.");

    handler.dispose();
  });

  it("preflights destination storage without creating the clone folder", async () => {
    const { root, registry } = createRegistry();
    const parentDir = path.join(root, "projects");
    fs.mkdirSync(parentDir, { recursive: true });
    const handler = createMultiProjectRpcRequestHandler({
      serverVersion: "test",
      projectRegistry: registry,
    });

    const initialized = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "ade/initialize",
      params: {},
    });
    expect(initialized).toMatchObject({
      capabilities: {
        machineProjects: { handoffStoragePreflight: true },
      },
    });

    const preflight = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "projects.getHandoffStoragePreflight",
      params: { parentDir, repoName: "ade-handoff" },
    }) as {
      targetPath: string;
      requiredBytes: number;
      freeBytes: number;
      targetExists: boolean;
      blockingErrors: string[];
    };

    expect(preflight.targetPath).toBe(path.join(parentDir, "ade-handoff"));
    expect(preflight.requiredBytes).toBeGreaterThanOrEqual(1024 * 1024 * 1024);
    expect(preflight.freeBytes).toBeGreaterThan(0);
    expect(preflight.targetExists).toBe(false);
    expect(preflight.blockingErrors).toEqual([]);
    expect(fs.existsSync(preflight.targetPath)).toBe(false);

    fs.mkdirSync(preflight.targetPath);
    const occupied = await handler({
      jsonrpc: "2.0",
      id: 3,
      method: "projects.getHandoffStoragePreflight",
      params: { parentDir, repoName: "ade-handoff" },
    }) as { targetExists: boolean; blockingErrors: string[] };
    expect(occupied.targetExists).toBe(true);
    expect(occupied.blockingErrors.join(" ")).toMatch(/already exists/i);

    const destinationAuthFailure = await handler({
      jsonrpc: "2.0",
      id: 4,
      method: "projects.getHandoffStoragePreflight",
      params: {
        parentDir,
        repoName: "private-repo",
        originUrl: `file://${path.join(root, "missing-private.git")}`,
        branchRef: "feature/handoff",
        sourceHeadSha: "1".repeat(40),
      },
    }) as { blockingErrors: string[] };
    expect(destinationAuthFailure.blockingErrors.join(" ")).toMatch(
      /destination cannot read the published repository with its own Git credentials/i,
    );
    handler.dispose();
  });

  it("keeps destination GitHub authorization out of preflight command arguments", async () => {
    const { root, registry } = createRegistry();
    const parentDir = path.join(root, "projects");
    fs.mkdirSync(parentDir, { recursive: true });
    const sourceHeadSha = "2".repeat(40);
    const destinationToken = "destination-private-token";
    const originalAdeHome = process.env.ADE_HOME;
    const originalGitHubToken = process.env.ADE_GITHUB_TOKEN;
    process.env.ADE_HOME = path.join(root, "machine-home");
    process.env.ADE_GITHUB_TOKEN = destinationToken;
    const runGitSpy = vi.spyOn(gitModule, "runGit").mockResolvedValue({
      exitCode: 0,
      stdout: `${sourceHeadSha}\trefs/heads/feature/handoff\n`,
      stderr: "",
    });
    const handler = createMultiProjectRpcRequestHandler({
      serverVersion: "test",
      projectRegistry: registry,
    });

    try {
      await handler({
        jsonrpc: "2.0",
        id: 1,
        method: "ade/initialize",
        params: {},
      });
      const preflight = await handler({
        jsonrpc: "2.0",
        id: 2,
        method: "projects.getHandoffStoragePreflight",
        params: {
          parentDir,
          repoName: "private-repo",
          originUrl: "https://github.com/example/private-repo.git",
          branchRef: "feature/handoff",
          sourceHeadSha,
        },
      }) as { blockingErrors: string[] };

      expect(preflight.blockingErrors).toEqual([]);
      expect(runGitSpy).toHaveBeenCalledOnce();
      const [args, options] = runGitSpy.mock.calls[0] ?? [];
      const expectedAuthorization = `AUTHORIZATION: basic ${Buffer.from(
        `x-access-token:${destinationToken}`,
        "utf8",
      ).toString("base64")}`;
      expect(args).toEqual([
        "ls-remote",
        "--heads",
        "https://github.com/example/private-repo.git",
        "refs/heads/feature/handoff",
      ]);
      expect(args?.join(" ")).not.toContain(destinationToken);
      expect(args?.join(" ")).not.toContain(expectedAuthorization);
      expect(options?.env).toMatchObject({
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: expectedAuthorization,
      });
    } finally {
      handler.dispose();
      runGitSpy.mockRestore();
      if (originalAdeHome === undefined) delete process.env.ADE_HOME;
      else process.env.ADE_HOME = originalAdeHome;
      if (originalGitHubToken === undefined) delete process.env.ADE_GITHUB_TOKEN;
      else process.env.ADE_GITHUB_TOKEN = originalGitHubToken;
    }
  });

  it("requires projectId for project-scoped methods", async () => {
    const { registry } = createRegistry();
    const handler = createMultiProjectRpcRequestHandler({
      serverVersion: "test",
      projectRegistry: registry,
    });

    await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "ade/initialize",
      params: {},
    });

    await expect(handler({
      jsonrpc: "2.0",
      id: 2,
      method: "ade/actions/list",
      params: {},
    })).rejects.toThrow("requires params.projectId");

    handler.dispose();
  });

  it("passes runtime state into project scopes", async () => {
    const { projectRoot, registry } = createRegistry();
    const added = registry.add(projectRoot);
    const runtime = { dispose: vi.fn() };
    const scopeRegistry = {
      get: vi.fn(async () => ({
        registryProjectId: added.projectId,
        record: added,
        runtime,
        dispose: vi.fn(),
      })),
      dispose: vi.fn(),
      disposeAll: vi.fn(),
    } as unknown as ProjectScopeRegistry;
    const handler = createMultiProjectRpcRequestHandler({
      serverVersion: "test",
      projectRegistry: registry,
      scopeRegistry,
    });

    const init = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "ade/initialize",
      params: {},
    });
    expect(init).toMatchObject({
      runtimeInfo: { multiProject: true },
      capabilities: {
        actions: { listChanged: true },
        projects: true,
      },
    });

    const actions = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "ade/actions/list",
      params: { projectId: added.projectId },
    }) as { actions: Array<{ name: string }> };
    expect(actions.actions.length).toBeGreaterThan(0);
    expect(scopeRegistry.get).toHaveBeenCalledWith(added.projectId);

    handler.dispose();
  });

  it("exposes runtime sync PIN methods through the active sync host scope", async () => {
    const { projectRoot, registry } = createRegistry();
    const added = registry.add(projectRoot);
    const syncService = {
      getPin: vi.fn(() => "123456"),
      setPin: vi.fn(async (pin: string) => ({ role: "brain", pairingPin: pin })),
      generatePin: vi.fn(async () => ({ role: "brain", pairingPin: "111222" })),
      clearPin: vi.fn(async () => ({ role: "brain", pairingPin: null })),
      getStatus: vi.fn(async () => ({ role: "brain" })),
      refreshDiscovery: vi.fn(),
      listDevices: vi.fn(),
      updateLocalDevice: vi.fn(async (args: { name?: string }) => ({ deviceId: "machine-1", name: args.name })),
      forgetDevice: vi.fn(async (deviceId: string) => ({ role: "brain", forgotten: deviceId })),
      setActiveLanePresence: vi.fn(async (_laneIds: string[]) => {}),
    };
    const scopeRegistry = {
      get: vi.fn(),
      ensureSyncHost: vi.fn(),
      switchSyncHost: vi.fn(),
      resolveActiveSyncHost: vi.fn(async () => ({
        registryProjectId: added.projectId,
        record: added,
        runtime: { syncService },
        dispose: vi.fn(),
      })),
      dispose: vi.fn(),
      disposeAll: vi.fn(),
    } as unknown as ProjectScopeRegistry;
    const handler = createMultiProjectRpcRequestHandler({
      serverVersion: "test",
      projectRegistry: registry,
      scopeRegistry,
    });

    await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "ade/initialize",
      params: {},
    });

    expect(await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "sync.getPin",
      params: { projectId: added.projectId },
    })).toEqual({ pin: "123456" });

    expect(await handler({
      jsonrpc: "2.0",
      id: 3,
      method: "sync.setPin",
      params: { projectId: added.projectId, pin: "654321" },
    })).toEqual({ role: "brain", pairingPin: "654321" });

    expect(await handler({
      jsonrpc: "2.0",
      id: 4,
      method: "sync.generatePin",
      params: { projectId: added.projectId },
    })).toEqual({ role: "brain", pairingPin: "111222" });

    await handler({
      jsonrpc: "2.0",
      id: 5,
      method: "sync.clearPin",
      params: { projectId: added.projectId },
    });

    expect(await handler({
      jsonrpc: "2.0",
      id: 6,
      method: "sync.updateLocalDevice",
      params: { projectId: added.projectId, name: "Mac Studio" },
    })).toEqual({ deviceId: "machine-1", name: "Mac Studio" });

    expect(await handler({
      jsonrpc: "2.0",
      id: 7,
      method: "sync.forgetDevice",
      params: { projectId: added.projectId, deviceId: "phone-1" },
    })).toEqual({ role: "brain", forgotten: "phone-1" });

    expect(await handler({
      jsonrpc: "2.0",
      id: 8,
      method: "sync.setActiveLanePresence",
      params: { projectId: added.projectId, laneIds: ["lane-1", 42, "lane-2"] },
    })).toBeNull();

    expect(scopeRegistry.resolveActiveSyncHost).toHaveBeenCalled();
    expect(scopeRegistry.switchSyncHost).not.toHaveBeenCalled();
    expect(syncService.setPin).toHaveBeenCalledWith("654321");
    expect(syncService.generatePin).toHaveBeenCalledTimes(1);
    expect(syncService.clearPin).toHaveBeenCalledTimes(1);
    expect(syncService.updateLocalDevice).toHaveBeenCalledWith({ name: "Mac Studio" });
    expect(syncService.forgetDevice).toHaveBeenCalledWith("phone-1");
    expect(syncService.setActiveLanePresence).toHaveBeenCalledWith(["lane-1", "lane-2"]);

    handler.dispose();
  });

  it("dispatches desktop pairing info through the daemon's trusted local sync surface", async () => {
    const { projectRoot, registry } = createRegistry();
    const added = registry.add(projectRoot);
    const pairingInfo = {
      pairingUrl: "https://app.ade-app.dev/pair#desktop-grant",
      code: "123456",
      pinConfigured: true,
      machineName: "Mac Studio",
      relayEnabled: true,
      hasRelayCandidate: true,
    };
    const executeRemoteCommand = vi.fn(async () => pairingInfo);
    const scopeRegistry = {
      get: vi.fn(),
      ensureSyncHost: vi.fn(),
      switchSyncHost: vi.fn(),
      resolveActiveSyncHost: vi.fn(async () => ({
        registryProjectId: added.projectId,
        record: added,
        runtime: { syncService: { executeRemoteCommand } },
        dispose: vi.fn(),
      })),
      dispose: vi.fn(),
      disposeAll: vi.fn(),
    } as unknown as ProjectScopeRegistry;
    const handler = createMultiProjectRpcRequestHandler({
      serverVersion: "test",
      projectRegistry: registry,
      scopeRegistry,
    });

    await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "ade/initialize",
      params: {},
    });

    await expect(handler({
      jsonrpc: "2.0",
      id: 2,
      method: "sync.getDesktopPairingInfo",
      params: {},
    })).resolves.toEqual(pairingInfo);
    expect(executeRemoteCommand).toHaveBeenCalledWith({
      commandId: expect.stringMatching(/^local-runtime-/),
      action: "sync.getDesktopPairingInfo",
      args: {},
    });
    expect(scopeRegistry.resolveActiveSyncHost).toHaveBeenCalledTimes(1);

    handler.dispose();
  });

  it("does not switch the active sync host for read-only sync polls with a projectId", async () => {
    const { root, projectRoot, registry } = createRegistry();
    const active = registry.add(projectRoot);
    const otherRoot = path.join(root, "other-project");
    fs.mkdirSync(otherRoot, { recursive: true });
    const other = registry.add(otherRoot);
    const activeRuntime = makeRuntime("active");
    const scopeRegistry = {
      get: vi.fn(),
      ensureSyncHost: vi.fn(),
      switchSyncHost: vi.fn(),
      resolveActiveSyncHost: vi.fn(async () => ({
        registryProjectId: active.projectId,
        record: active,
        runtime: activeRuntime,
        dispose: vi.fn(),
      })),
      dispose: vi.fn(),
      disposeAll: vi.fn(),
    } as unknown as ProjectScopeRegistry;
    const handler = createMultiProjectRpcRequestHandler({
      serverVersion: "test",
      projectRegistry: registry,
      scopeRegistry,
    });

    await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "ade/initialize",
      params: {},
    });

    expect(await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "sync.getStatus",
      params: { projectId: other.projectId },
    })).toEqual({ role: "brain", label: "active" });

    expect(await handler({
      jsonrpc: "2.0",
      id: 3,
      method: "sync.listDevices",
      params: { projectId: other.projectId },
    })).toEqual([{ deviceId: "active-device" }]);

    expect(scopeRegistry.resolveActiveSyncHost).toHaveBeenCalledTimes(2);
    expect(scopeRegistry.switchSyncHost).not.toHaveBeenCalled();
    expect(scopeRegistry.ensureSyncHost).not.toHaveBeenCalled();

    handler.dispose();
  });

  it("returns machine publisher health when no project sync scope exists", async () => {
    const { registry } = createRegistry();
    const scopeRegistry = {
      get: vi.fn(),
      ensureSyncHost: vi.fn(),
      switchSyncHost: vi.fn(),
      resolveActiveSyncHost: vi.fn(async () => null),
      dispose: vi.fn(),
      disposeAll: vi.fn(),
    } as unknown as ProjectScopeRegistry;
    const accountDirectoryHealth = {
      state: "http_error" as const,
      skipReason: "The account directory returned HTTP 401: invalid audience",
      directoryOrigin: "https://directory.example",
      lastAttemptAt: 123,
      lastSuccessAt: null,
      lastHttpStatus: 401,
      lastHttpReason: "invalid audience",
      reachableEndpointCount: 2,
    };
    const handler = createMultiProjectRpcRequestHandler({
      serverVersion: "test",
      projectRegistry: registry,
      scopeRegistry,
      getAccountDirectoryHealth: () => accountDirectoryHealth,
    });

    await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "ade/initialize",
      params: {},
    });
    const status = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "sync.getStatus",
      params: {},
    }) as { routeHealth: { accountDirectory: unknown } };

    expect(status.routeHealth.accountDirectory).toEqual(accountDirectoryHealth);
    expect(scopeRegistry.resolveActiveSyncHost).toHaveBeenCalledTimes(1);
    handler.dispose();
  });

  it("rejects desktop/TUI sync host switches through the runtime RPC", async () => {
    const { root, projectRoot, registry } = createRegistry();
    const first = registry.add(projectRoot);
    const secondRoot = path.join(root, "second-project");
    fs.mkdirSync(secondRoot, { recursive: true });
    const second = registry.add(secondRoot);
    const secondRuntime = makeRuntime("second");
    const scopeRegistry = {
      get: vi.fn(),
      ensureSyncHost: vi.fn(),
      switchSyncHost: vi.fn(async () => ({
        registryProjectId: second.projectId,
        record: second,
        runtime: secondRuntime,
        dispose: vi.fn(),
      })),
      resolveActiveSyncHost: vi.fn(),
      dispose: vi.fn(),
      disposeAll: vi.fn(),
    } as unknown as ProjectScopeRegistry;
    const handler = createMultiProjectRpcRequestHandler({
      serverVersion: "test",
      projectRegistry: registry,
      scopeRegistry,
    });

    await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "ade/initialize",
      params: {},
    });

    await expect(handler({
      jsonrpc: "2.0",
      id: 2,
      method: "sync.switchHost",
      params: { projectId: second.projectId },
    })).rejects.toMatchObject({
      code: -32601,
      message: "Method not found: sync.switchHost",
    });

    expect(scopeRegistry.switchSyncHost).not.toHaveBeenCalled();
    expect(scopeRegistry.resolveActiveSyncHost).not.toHaveBeenCalled();
    expect(scopeRegistry.ensureSyncHost).not.toHaveBeenCalled();
    expect(first.projectId).not.toBe(second.projectId);

    handler.dispose();
  });

  it("drops cached project handlers when the backing project scope is disposed", async () => {
    const { projectRoot, registry } = createRegistry();
    const added = registry.add(projectRoot);
    const firstRuntime = makeRuntime("first");
    const secondRuntime = makeRuntime("second");
    let disposeListener: ((projectId: string) => void) | null = null;
    let getCount = 0;
    const scopeRegistry = {
      get: vi.fn(async () => ({
        registryProjectId: added.projectId,
        record: added,
        runtime: getCount++ === 0 ? firstRuntime : secondRuntime,
        dispose: vi.fn(),
      })),
      ensureSyncHost: vi.fn(),
      switchSyncHost: vi.fn(),
      resolveActiveSyncHost: vi.fn(async () => ({
        registryProjectId: added.projectId,
        record: added,
        runtime: firstRuntime,
        dispose: vi.fn(),
      })),
      dispose: vi.fn(),
      disposeAll: vi.fn(),
      onDispose: vi.fn((listener: (projectId: string) => void) => {
        disposeListener = listener;
        return () => {
          disposeListener = null;
        };
      }),
    } as unknown as ProjectScopeRegistry;
    const handler = createMultiProjectRpcRequestHandler({
      serverVersion: "test",
      projectRegistry: registry,
      scopeRegistry,
    });

    await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "ade/initialize",
      params: {},
    });

    const first = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "ade/actions/call",
      params: {
        projectId: added.projectId,
        name: "run_ade_action",
        arguments: { domain: "lane", action: "list" },
      },
    }) as { result: Array<{ id: string }> };
    expect(first.result[0]?.id).toBe("first-lane");

    (disposeListener as ((projectId: string) => void) | null)?.(added.projectId);

    const second = await handler({
      jsonrpc: "2.0",
      id: 4,
      method: "ade/actions/call",
      params: {
        projectId: added.projectId,
        name: "run_ade_action",
        arguments: { domain: "lane", action: "list" },
      },
    }) as { result: Array<{ id: string }> };
    expect(second.result[0]?.id).toBe("second-lane");
    expect(scopeRegistry.get).toHaveBeenCalledTimes(2);

    handler.dispose();
  });

  it("subscribes to project runtime events and emits JSON-RPC notifications", async () => {
    const { projectRoot, registry } = createRegistry();
    const added = registry.add(projectRoot);
    const eventBuffer = createEventBuffer();
    const scopeRegistry = {
      get: vi.fn(async () => ({
        registryProjectId: added.projectId,
        record: added,
        runtime: {
          eventBuffer,
          dispose: vi.fn(),
        },
        dispose: vi.fn(),
      })),
      ensureSyncHost: vi.fn(),
      dispose: vi.fn(),
      disposeAll: vi.fn(),
    } as unknown as ProjectScopeRegistry;
    const handler = createMultiProjectRpcRequestHandler({
      serverVersion: "test",
      projectRegistry: registry,
      scopeRegistry,
    });
    const notify = vi.fn();
    handler.setNotifier(notify);

    await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "ade/initialize",
      params: {},
    });

    const subscribed = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "runtimeEvents.subscribe",
      params: {
        projectId: added.projectId,
        category: "runtime",
      },
    }) as { subscriptionId: string; eventEpoch: string };
    expect(subscribed.eventEpoch).toBe(eventBuffer.epoch());

    eventBuffer.push({
      timestamp: "2026-05-10T00:00:00.000Z",
      category: "runtime",
      payload: { type: "file_change", event: { path: "README.md" } },
    });
    eventBuffer.push({
      timestamp: "2026-05-10T00:00:01.000Z",
      category: "orchestrator",
      payload: { type: "ignored" },
    });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("runtime/event", {
      subscriptionId: subscribed.subscriptionId,
      projectId: added.projectId,
      eventEpoch: eventBuffer.epoch(),
      event: expect.objectContaining({
        category: "runtime",
        payload: { type: "file_change", event: { path: "README.md" } },
      }),
    });

    expect(await handler({
      jsonrpc: "2.0",
      id: 3,
      method: "runtimeEvents.unsubscribe",
      params: { subscriptionId: subscribed.subscriptionId },
    })).toEqual({ removed: true });

    eventBuffer.push({
      timestamp: "2026-05-10T00:00:02.000Z",
      category: "runtime",
      payload: { type: "file_change", event: { path: "package.json" } },
    });
    expect(notify).toHaveBeenCalledTimes(1);

    handler.dispose();
  });

  it("can subscribe to project runtime events without replaying buffered history", async () => {
    const { projectRoot, registry } = createRegistry();
    const added = registry.add(projectRoot);
    const eventBuffer = createEventBuffer();
    eventBuffer.push({
      timestamp: "2026-05-10T00:00:00.000Z",
      category: "runtime",
      payload: { type: "file_change", event: { path: "old.ts" } },
    });
    const scopeRegistry = {
      get: vi.fn(async () => ({
        registryProjectId: added.projectId,
        record: added,
        runtime: {
          eventBuffer,
          dispose: vi.fn(),
        },
        dispose: vi.fn(),
      })),
      ensureSyncHost: vi.fn(),
      dispose: vi.fn(),
      disposeAll: vi.fn(),
    } as unknown as ProjectScopeRegistry;
    const handler = createMultiProjectRpcRequestHandler({
      serverVersion: "test",
      projectRegistry: registry,
      scopeRegistry,
    });
    const notify = vi.fn();
    handler.setNotifier(notify);

    await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "ade/initialize",
      params: {},
    });

    const subscribed = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "runtimeEvents.subscribe",
      params: {
        projectId: added.projectId,
        category: "runtime",
        replay: false,
      },
    }) as { subscriptionId: string; hasMore: boolean; nextCursor: number };

    expect(subscribed.hasMore).toBe(false);
    expect(subscribed.nextCursor).toBe(1);
    expect(notify).not.toHaveBeenCalled();

    eventBuffer.push({
      timestamp: "2026-05-10T00:00:01.000Z",
      category: "runtime",
      payload: { type: "file_change", event: { path: "new.ts" } },
    });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("runtime/event", expect.objectContaining({
      subscriptionId: subscribed.subscriptionId,
      event: expect.objectContaining({
        payload: { type: "file_change", event: { path: "new.ts" } },
      }),
    }));

    handler.dispose();
  });
});
