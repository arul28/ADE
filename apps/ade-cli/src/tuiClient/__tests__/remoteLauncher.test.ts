import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { RemoteRuntimeTarget } from "../../../../desktop/src/shared/types/remoteRuntime";
import {
  assertRelayAccountUnchanged,
  buildSshArgs,
  buildRemoteRuntimeRpcCommand,
  getCurrentAccountRelayProof,
  hasExplicitSshFallback,
  listRemoteSessions,
  machineSelectionMode,
  openRemoteRpcSession,
  pairedConnectionLabel,
  pairedEndpointCandidatesForPreference,
  pairedRouteAccountProof,
  parseRemoteAdeCodeArgs,
  remoteRuntimeLayoutCandidates,
  remoteTargetChoiceLabel,
  resolveRemoteTargetForLaunch,
  selectProject,
  takeAdeCodeRemoteArgs,
} from "../remoteLauncher";

describe("ade code remote launcher", () => {
  const legacyAccountTarget = (): RemoteRuntimeTarget => ({
    id: "legacy-account-studio",
    name: "Arul's Mac Studio",
    hostname: "100.75.20.63",
    transport: "ssh",
    pairedMachine: null,
    sshUser: null,
    port: null,
    sshKeyPath: null,
    routes: [
      { hostname: "100.75.20.63", port: null, source: "tailscale", lastSucceededAt: null },
      { hostname: "192.168.1.63", port: null, source: "bonjour", lastSucceededAt: null },
    ],
    lastSeenArch: "darwin-arm64",
    runtimeBinaryVersion: "1.2.27",
    lastConnectedAt: Date.now(),
  });

  it("detects remote as the first standalone ade code positional", () => {
    expect(takeAdeCodeRemoteArgs(["remote", "session", "--target", "mac"])).toEqual([
      "session",
      "--target",
      "mac",
    ]);
    expect(takeAdeCodeRemoteArgs(["--session", "remote"])).toBeNull();
    expect(takeAdeCodeRemoteArgs(["project"])).toBeNull();
  });

  it("parses project and session selection flags", () => {
    expect(parseRemoteAdeCodeArgs([
      "session",
      "--target",
      "workstation",
      "--project",
      "ADE",
      "--session",
      "chat-1",
    ])).toMatchObject({
      scope: "session",
      targetQuery: "workstation",
      projectQuery: "ADE",
      sessionQuery: "chat-1",
    });
  });

  it("parses explicit connection-path preferences and rejects unknown routes", () => {
    expect(parseRemoteAdeCodeArgs(["--route", "auto"]).routePreference).toBe("auto");
    expect(parseRemoteAdeCodeArgs(["--route", "local"]).routePreference).toBe("lan");
    expect(parseRemoteAdeCodeArgs(["--route", "tailscale"]).routePreference).toBe("tailnet");
    expect(parseRemoteAdeCodeArgs(["--route", "relay"]).routePreference).toBe("relay");
    expect(() => parseRemoteAdeCodeArgs(["--route", "internet"]))
      .toThrow(/Use auto, lan, tailscale, or relay/);
  });

  it("requires an interactive machine confirmation even when only one target is saved", () => {
    expect(machineSelectionMode(1, true)).toBe("prompt");
    expect(machineSelectionMode(3, true)).toBe("prompt");
    expect(machineSelectionMode(1, false)).toBe("auto");
    expect(machineSelectionMode(3, false)).toBe("flag-required");
  });

  it("filters explicit paths without changing automatic LAN-first ordering", () => {
    const candidates = [
      { endpoint: "ws://studio.local:8787/", kind: "lan" as const, lastSucceededAt: null },
      { endpoint: "ws://studio.example.ts.net:8787/", kind: "tailnet" as const, lastSucceededAt: null },
      { endpoint: "wss://relay.example/connect/machine", kind: "relay" as const, lastSucceededAt: null },
    ];

    expect(pairedEndpointCandidatesForPreference(candidates, "auto")).toEqual(candidates);
    expect(pairedEndpointCandidatesForPreference(candidates, "tailnet")).toEqual([
      candidates[1],
    ]);
    expect(pairedConnectionLabel(candidates[0]!)).toBe(
      "local network (studio.local:8787)",
    );
    expect(pairedConnectionLabel(candidates[1]!)).toBe(
      "Tailscale (studio.example.ts.net:8787)",
    );
    expect(pairedConnectionLabel(candidates[2]!)).toBe(
      "ADE Relay (relay.example)",
    );
  });

  it("builds the remote ADE stdio command for the selected runtime home", () => {
    const layout: Parameters<typeof buildRemoteRuntimeRpcCommand>[0] = {
      channel: "beta",
      homeDirName: ".ade-beta",
      homeDirExpr: "$HOME/.ade-beta",
      binDirExpr: "$HOME/.ade-beta/bin",
      runtimeDirExpr: "$HOME/.ade-beta/runtime",
      socketExpr: "$HOME/.ade-beta/sock/ade.sock",
      binaryExpr: "$HOME/.ade-beta/bin/ade",
    };

    expect(buildRemoteRuntimeRpcCommand(layout)).toContain('export ADE_HOME="$HOME/.ade-beta"');
    expect(buildRemoteRuntimeRpcCommand(layout)).toContain('export ADE_PACKAGE_CHANNEL="beta"');
    expect(buildRemoteRuntimeRpcCommand(layout)).toContain("export ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1");
    expect(buildRemoteRuntimeRpcCommand(layout)).toContain('export ADE_PTY_HOST_WORKER_COMMAND="$HOME/.ade-beta/bin/ade"');
    expect(buildRemoteRuntimeRpcCommand(layout)).toContain("exec $HOME/.ade-beta/bin/ade --socket $HOME/.ade-beta/sock/ade.sock rpc --stdio");
  });

  it("attaches to stable remote runtimes without repairing or installing services", () => {
    const layout: Parameters<typeof buildRemoteRuntimeRpcCommand>[0] = {
      channel: null,
      homeDirName: ".ade",
      homeDirExpr: "$HOME/.ade",
      binDirExpr: "$HOME/.ade/bin",
      runtimeDirExpr: "$HOME/.ade/runtime",
      socketExpr: "$HOME/.ade/sock/ade.sock",
      binaryExpr: "$HOME/.ade/bin/ade",
    };

    expect(buildRemoteRuntimeRpcCommand(layout)).toContain("export ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1");
    expect(buildRemoteRuntimeRpcCommand(layout)).not.toContain("ADE_PACKAGE_CHANNEL");
  });

  it("checks the saved remote target channel before the shared runtime home", () => {
    expect(remoteRuntimeLayoutCandidates({}, "beta").map((layout) => layout.homeDirName)).toEqual([
      ".ade-beta",
      ".ade",
      ".ade-alpha",
    ]);
    expect(remoteRuntimeLayoutCandidates({}, "alpha").map((layout) => layout.homeDirName)).toEqual([
      ".ade-alpha",
      ".ade",
      ".ade-beta",
    ]);
  });

  it("keeps the saved SSH alias for config credentials while overriding only the concrete route", () => {
    const target = {
      ...legacyAccountTarget(),
      hostname: "arul-studio",
      sshUser: "arul",
      sshKeyPath: null,
    };
    const args = buildSshArgs(
      target,
      { hostname: "100.75.20.63", port: 22, source: "tailscale", lastSucceededAt: null },
      "ade rpc --stdio",
    );

    expect(args).toContain("HostName=100.75.20.63");
    expect(args).toContain("arul@arul-studio");
    expect(args).not.toContain("arul@100.75.20.63");
    expect(args).toContain("StrictHostKeyChecking=yes");
  });

  it("keeps signed-out LAN and Tailscale pairing independent from Relay auth", async () => {
    const getAccountRelayProof = vi.fn(async () => null);
    const credentials = { accountOwnerUserId: null };

    await expect(pairedRouteAccountProof({
      kind: "lan",
      credentials,
      getAccountRelayProof,
    })).resolves.toBeNull();
    await expect(pairedRouteAccountProof({
      kind: "tailnet",
      credentials,
      getAccountRelayProof,
    })).resolves.toBeNull();
    expect(getAccountRelayProof).not.toHaveBeenCalled();
  });

  it("requires a fresh same-account proof before offering Relay", async () => {
    const getStatus = vi.fn(() => ({
      signedIn: true,
      userId: "account-a",
      email: "a@example.test",
      name: "A",
      expiresAt: "2026-07-15T22:00:00.000Z",
      source: "loopback" as const,
    }));
    const getAccessToken = vi.fn(async () => "fresh-short-lived-token");
    await expect(getCurrentAccountRelayProof({ getStatus, getAccessToken })).resolves.toEqual({
      userId: "account-a",
      token: "fresh-short-lived-token",
    });
    expect(getAccessToken).toHaveBeenCalledOnce();

    await expect(pairedRouteAccountProof({
      kind: "relay",
      credentials: { accountOwnerUserId: "account-a" },
      getAccountRelayProof: async () => ({
        userId: "account-a",
        token: "fresh-short-lived-token",
      }),
    })).resolves.toEqual({
      userId: "account-a",
      token: "fresh-short-lived-token",
    });
  });

  it("keeps Relay absent when signed out or signed in to a different account", async () => {
    await expect(pairedRouteAccountProof({
      kind: "relay",
      credentials: { accountOwnerUserId: "account-a" },
      getAccountRelayProof: async () => null,
    })).rejects.toThrow(/Sign in to ADE.*Relay.*Local network and Tailscale/i);

    await expect(pairedRouteAccountProof({
      kind: "relay",
      credentials: { accountOwnerUserId: "account-a" },
      getAccountRelayProof: async () => ({ userId: "account-b", token: "token-b" }),
    })).rejects.toThrow(/same ADE account.*Relay/i);

    await expect(assertRelayAccountUnchanged(
      { userId: "account-a", token: "token-a" },
      async () => ({ userId: "account-b", token: "token-b" }),
    )).rejects.toThrow(/account changed.*same account/i);
  });

  it("never invents SSH fallback from a paired LAN or Tailscale route", () => {
    const paired = {
      ...legacyAccountTarget(),
      transport: "paired" as const,
      pairedMachine: { hostIdentity: "host-1", machineKey: null },
      routes: [
        { hostname: "192.168.1.63", port: null, source: "bonjour" as const, lastSucceededAt: null },
        { hostname: "100.75.20.63", port: null, source: "tailscale" as const, lastSucceededAt: null },
      ],
    };
    expect(hasExplicitSshFallback(paired)).toBe(false);
    expect(hasExplicitSshFallback({
      ...paired,
      routes: [{ hostname: "studio", port: 22, source: "manual", lastSucceededAt: null }],
    })).toBe(true);
    expect(hasExplicitSshFallback({ ...paired, sshUser: "arul" })).toBe(true);
    expect(remoteTargetChoiceLabel(paired)).toBe(
      "Arul's Mac Studio (paired · local network → Tailscale → ADE Relay)",
    );
    expect(remoteTargetChoiceLabel({ ...legacyAccountTarget(), sshUser: "arul" }))
      .toContain("advanced SSH: arul@100.75.20.63");
  });

  it("upgrades the exact desktop-connected account target before broken SSH can run", async () => {
    const pairedTarget: RemoteRuntimeTarget = {
      ...legacyAccountTarget(),
      id: "paired-account-studio",
      hostname: "relay.example",
      transport: "paired",
      pairedMachine: { hostIdentity: "device-studio", machineKey: "machine-studio" },
      routes: [],
    };
    const listMachines = vi.fn(async () => ({
      state: "ok" as const,
      message: null,
      machines: [{
        machineKey: "machine-studio",
        deviceId: "device-studio",
        name: "Arul's Mac Studio",
        platform: "macOS",
        deviceType: "desktop",
        reachableEndpoints: [
          { kind: "tailnet" as const, host: "100.75.20.63", port: 8787 },
          { kind: "lan" as const, host: "192.168.1.63", port: 8787 },
          { kind: "relay" as const, url: "wss://relay.example/connect/machine-studio" },
        ],
        lastSeenAt: Date.now(),
        online: true,
      }],
    }));
    const pairListedMachine = vi.fn(async () => ({
      targetId: pairedTarget.id,
      machineKey: "machine-studio",
      deviceId: "device-studio",
      name: pairedTarget.name,
    }));
    const remove = vi.fn(() => true);

    await expect(resolveRemoteTargetForLaunch(legacyAccountTarget(), {
      accountMachines: { listMachines, pairListedMachine },
      registry: { get: (id) => id === pairedTarget.id ? pairedTarget : null, remove },
    })).resolves.toEqual(pairedTarget);
    expect(pairListedMachine).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("legacy-account-studio");
  });

  it("fails a legacy offline account target promptly without an SSH downgrade", async () => {
    const pairListedMachine = vi.fn();
    await expect(resolveRemoteTargetForLaunch(legacyAccountTarget(), {
      accountMachines: {
        listMachines: async () => ({
          state: "ok",
          message: null,
          machines: [{
            machineKey: "machine-studio",
            deviceId: "device-studio",
            name: "Arul's Mac Studio",
            platform: "macOS",
            deviceType: "desktop",
            reachableEndpoints: [
              { kind: "tailnet", host: "100.75.20.63", port: 8787 },
              { kind: "lan", host: "192.168.1.63", port: 8787 },
            ],
            lastSeenAt: Date.now() - 120_000,
            online: false,
          }],
        }),
        pairListedMachine,
      },
      registry: { get: () => null, remove: () => false },
    })).rejects.toThrow(/offline.*paired-only.*will not downgrade to SSH/i);
    expect(pairListedMachine).not.toHaveBeenCalled();
  });

  it("adopts a legacy offline account target when it has a verified secure Relay route", async () => {
    const machine = {
      machineKey: "machine-studio",
      deviceId: "device-studio",
      name: "Arul's Mac Studio",
      platform: "macOS",
      deviceType: "desktop",
      reachableEndpoints: [
        { kind: "tailnet" as const, host: "100.75.20.63", port: 8787 },
        { kind: "lan" as const, host: "192.168.1.63", port: 8787 },
        {
          kind: "relay" as const,
          url: "wss://ade-tunnel-relay.arulsharma1028.workers.dev/connect/machine-studio",
        },
      ],
      lastSeenAt: Date.now() - 120_000,
      online: false,
    };
    const pairedTarget: RemoteRuntimeTarget = {
      ...legacyAccountTarget(),
      id: "paired-account-studio",
      hostname: "ade-tunnel-relay.arulsharma1028.workers.dev",
      transport: "paired",
      pairedMachine: { hostIdentity: "device-studio", machineKey: "machine-studio" },
      routes: [],
    };
    const pairListedMachine = vi.fn(async () => ({
      targetId: pairedTarget.id,
      machineKey: machine.machineKey,
      deviceId: machine.deviceId,
      name: pairedTarget.name,
    }));
    const remove = vi.fn(() => true);

    await expect(resolveRemoteTargetForLaunch(legacyAccountTarget(), {
      accountMachines: {
        listMachines: async () => ({ state: "ok", message: null, machines: [machine] }),
        pairListedMachine,
      },
      registry: { get: (id) => id === pairedTarget.id ? pairedTarget : null, remove },
    })).resolves.toEqual(pairedTarget);
    expect(pairListedMachine).toHaveBeenCalledWith(
      machine,
      expect.objectContaining({ connectTimeoutMs: expect.any(Number) }),
    );
    expect(remove).toHaveBeenCalledWith("legacy-account-studio");
  });

  it("keeps an explicit SSH-config target when only one account hostname overlaps", async () => {
    const target = {
      ...legacyAccountTarget(),
      id: "manual-ssh-studio",
      name: "Build host alias",
      hostname: "studio-ssh-config",
      routes: [{
        hostname: "100.75.20.63",
        port: null,
        source: "manual" as const,
        lastSucceededAt: null,
      }],
    };
    const pairListedMachine = vi.fn();

    await expect(resolveRemoteTargetForLaunch(target, {
      accountMachines: {
        listMachines: async () => ({
          state: "ok",
          message: null,
          machines: [{
            machineKey: "machine-studio",
            deviceId: "device-studio",
            name: "Arul's Mac Studio",
            platform: "macOS",
            deviceType: "desktop",
            reachableEndpoints: [{ kind: "tailnet", host: "100.75.20.63", port: 8787 }],
            lastSeenAt: Date.now(),
            online: true,
          }],
        }),
        pairListedMachine,
      },
      registry: { get: () => null, remove: () => false },
    })).resolves.toEqual(target);
    expect(pairListedMachine).not.toHaveBeenCalled();
  });

  it("fails closed when an uncredentialed legacy account candidate cannot be verified", async () => {
    await expect(resolveRemoteTargetForLaunch(legacyAccountTarget(), {
      accountMachines: {
        listMachines: async () => ({
          state: "auth_expired",
          message: "The machine directory rejected your ADE account session. Sign in again. Reason: invalid issuer",
          machines: [],
        }),
        pairListedMachine: vi.fn(),
      },
      registry: { get: () => null, remove: () => false },
    })).rejects.toThrow(
      /auth expired.*Reason: invalid issuer.*will not silently downgrade.*to SSH.*explicit SSH user\/key/i,
    );
  });

  it("keeps a manual SSH target eligible when the account directory is unavailable", async () => {
    const target = {
      ...legacyAccountTarget(),
      id: "manual-ssh-target",
      routes: [{
        hostname: "100.75.20.63",
        port: null,
        source: "manual" as const,
        lastSucceededAt: null,
      }],
    };
    await expect(resolveRemoteTargetForLaunch(target, {
      accountMachines: {
        listMachines: async () => ({ state: "unavailable", message: "offline", machines: [] }),
        pairListedMachine: vi.fn(),
      },
      registry: { get: () => null, remove: () => false },
    })).resolves.toEqual(target);
  });

  it("does not adopt an exact account host when the saved SSH route is manual", async () => {
    const target = {
      ...legacyAccountTarget(),
      id: "manual-account-host",
      routes: [{
        hostname: "100.75.20.63",
        port: null,
        source: "manual" as const,
        lastSucceededAt: null,
      }],
    };
    const pairListedMachine = vi.fn();
    await expect(resolveRemoteTargetForLaunch(target, {
      accountMachines: {
        listMachines: async () => ({
          state: "ok",
          message: null,
          machines: [{
            machineKey: "machine-studio",
            deviceId: "device-studio",
            name: "Arul's Mac Studio",
            platform: "macOS",
            deviceType: "desktop",
            reachableEndpoints: [{ kind: "tailnet", host: "100.75.20.63", port: 8787 }],
            lastSeenAt: Date.now(),
            online: true,
          }],
        }),
        pairListedMachine,
      },
      registry: { get: () => null, remove: () => false },
    })).resolves.toEqual(target);
    expect(pairListedMachine).not.toHaveBeenCalled();
  });

  it("bounds an unreachable SSH target by one total deadline instead of polling every runtime forever", async () => {
    const children: Array<ChildProcessWithoutNullStreams & { kill: ReturnType<typeof vi.fn> }> = [];
    const spawnProcess = vi.fn(() => {
      const child = new EventEmitter() as ChildProcessWithoutNullStreams & { kill: ReturnType<typeof vi.fn> };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn(() => true);
      children.push(child);
      return child;
    });
    const startedAt = Date.now();

    await expect(openRemoteRpcSession({
      ...legacyAccountTarget(),
      id: "offline-explicit-ssh",
      name: "Offline workstation",
      sshUser: "arul",
    }, {
      totalTimeoutMs: 80,
      attemptTimeoutMs: 50,
      spawnProcess,
    })).rejects.toThrow(/bounded route\/runtime combinations.*deadline/i);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(spawnProcess.mock.calls.length).toBeLessThanOrEqual(2);
    expect(children.every((child) => child.kill.mock.calls.length > 0)).toBe(true);
  });

  it("falls back to positional chat list args for older remote action adapters", async () => {
    const calls: unknown[] = [];
    const client = {
      request: async (_method: string, params: unknown) => {
        calls.push(params);
        const args = (params as { arguments?: { domain?: string; action?: string; argsList?: unknown[] } }).arguments;
        if (args?.domain === "chat" && args.action === "listSessions" && !args.argsList) {
          return { ok: false, error: { message: "invalid lane id" } };
        }
        if (args?.domain === "chat" && args.action === "listSessions" && args.argsList) {
          return {
            result: [{
              sessionId: "chat-1",
              laneId: "lane-1",
              provider: "codex",
              model: "gpt-5.5",
              status: "idle",
              startedAt: "2026-06-15T00:00:00.000Z",
              endedAt: null,
              lastActivityAt: "2026-06-15T00:01:00.000Z",
              lastOutputPreview: null,
              summary: null,
            }],
          };
        }
        if (args?.domain === "terminal" && args.action === "list") {
          return { result: [] };
        }
        throw new Error("unexpected request");
      },
    };

    await expect(listRemoteSessions(client as never, "project-1")).resolves.toMatchObject([
      { sessionId: "chat-1", kind: "chat", title: "chat-1" },
    ]);
    expect(calls).toEqual([
      expect.objectContaining({
        projectId: "project-1",
        arguments: expect.objectContaining({
          domain: "chat",
          action: "listSessions",
          args: { includeArchived: false, includeAutomation: true },
        }),
      }),
      expect.objectContaining({
        projectId: "project-1",
        arguments: expect.objectContaining({
          domain: "chat",
          action: "listSessions",
          argsList: [null, { includeArchived: false, includeAutomation: true }],
        }),
      }),
      expect.objectContaining({
        projectId: "project-1",
        arguments: expect.objectContaining({
          domain: "terminal",
          action: "list",
          args: { limit: 200 },
        }),
      }),
    ]);
  });

  it("includes legacy Claude terminals when only the resume command identifies them", async () => {
    const client = {
      request: async (_method: string, params: unknown) => {
        const args = (params as { arguments?: { domain?: string; action?: string } }).arguments;
        if (args?.domain === "chat" && args.action === "listSessions") {
          return { result: [] };
        }
        if (args?.domain === "terminal" && args.action === "list") {
          return {
            result: [
              {
                terminalId: "claude-command-1",
                laneId: "lane-1",
                title: "Claude terminal",
                status: "running",
                runtimeState: "idle",
                startedAt: "2026-06-15T00:00:00.000Z",
                toolType: "shell",
                resumeCommand: "claude --resume claude-command-1",
              },
            ],
          };
        }
        throw new Error("unexpected request");
      },
    };

    await expect(listRemoteSessions(client as never, "project-1")).resolves.toMatchObject([
      { sessionId: "claude-command-1", kind: "terminal", title: "Claude terminal" },
    ]);
  });

  it("includes legacy Claude terminals when only resume metadata identifies them", async () => {
    const client = {
      request: async (_method: string, params: unknown) => {
        const args = (params as { arguments?: { domain?: string; action?: string } }).arguments;
        if (args?.domain === "chat" && args.action === "listSessions") {
          return { result: [] };
        }
        if (args?.domain === "terminal" && args.action === "list") {
          return {
            result: [
              {
                terminalId: "claude-metadata-1",
                laneId: "lane-1",
                title: "Claude metadata terminal",
                status: "running",
                runtimeState: "idle",
                startedAt: "2026-06-15T00:00:00.000Z",
                toolType: "shell",
                resumeMetadata: { provider: "claude" },
              },
            ],
          };
        }
        throw new Error("unexpected request");
      },
    };

    await expect(listRemoteSessions(client as never, "project-1")).resolves.toMatchObject([
      { sessionId: "claude-metadata-1", kind: "terminal", title: "Claude metadata terminal" },
    ]);
  });

  it("lists every tracked provider CLI terminal and hides chat-backed terminals", async () => {
    const terminals = [
      { terminalId: "claude-cli", toolType: "claude", laneId: "lane-1", title: "Claude", status: "running", runtimeState: "idle", startedAt: "2026-06-15T00:00:00.000Z" },
      { terminalId: "codex-cli", toolType: "codex", laneId: "lane-1", title: "Codex", status: "running", runtimeState: "idle", startedAt: "2026-06-15T00:00:00.000Z" },
      { terminalId: "cursor-cli", toolType: "cursor-cli", laneId: "lane-1", title: "Cursor", status: "running", runtimeState: "idle", startedAt: "2026-06-15T00:00:00.000Z" },
      { terminalId: "droid-cli", toolType: "droid", laneId: "lane-1", title: "Droid", status: "running", runtimeState: "idle", startedAt: "2026-06-15T00:00:00.000Z" },
      { terminalId: "opencode-cli", toolType: "opencode", laneId: "lane-1", title: "OpenCode", status: "running", runtimeState: "idle", startedAt: "2026-06-15T00:00:00.000Z" },
      // Chat-backed + plain shell must NOT be launchable.
      { terminalId: "codex-chat", toolType: "codex-chat", laneId: "lane-1", title: "Codex chat", status: "running", runtimeState: "idle", startedAt: "2026-06-15T00:00:00.000Z" },
      { terminalId: "cursor-chat", toolType: "cursor", laneId: "lane-1", title: "Cursor chat", status: "running", runtimeState: "idle", startedAt: "2026-06-15T00:00:00.000Z" },
      { terminalId: "raw-shell", toolType: "shell", laneId: "lane-1", title: "Shell", status: "running", runtimeState: "idle", startedAt: "2026-06-15T00:00:00.000Z" },
    ];
    const client = {
      request: async (_method: string, params: unknown) => {
        const args = (params as { arguments?: { domain?: string; action?: string } }).arguments;
        if (args?.domain === "chat" && args.action === "listSessions") return { result: [] };
        if (args?.domain === "terminal" && args.action === "list") return { result: terminals };
        throw new Error("unexpected request");
      },
    };

    const result = await listRemoteSessions(client as never, "project-1");
    expect(result.map((session) => session.sessionId).sort()).toEqual(
      ["claude-cli", "codex-cli", "cursor-cli", "droid-cli", "opencode-cli"].sort(),
    );
  });

  it("does not register a new remote project when a path query is ambiguous", async () => {
    const request = vi.fn();
    await expect(selectProject(request as never, [
      {
        projectId: "frontend",
        displayName: "frontend",
        rootPath: "/home/alice/frontend",
        addedAt: 0,
        lastOpenedAt: 0,
        gitOriginUrl: null,
      },
      {
        projectId: "backend",
        displayName: "backend",
        rootPath: "/home/alice/backend",
        addedAt: 0,
        lastOpenedAt: 0,
        gitOriginUrl: null,
      },
    ], "/home/alice")).rejects.toThrow("matches multiple entries");
    expect(request).not.toHaveBeenCalled();
  });
});
