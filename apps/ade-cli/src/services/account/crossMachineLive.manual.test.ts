/**
 * LIVE two-brain check for cross-machine agents. Never runs in CI: it starts
 * real provider turns. Run by hand:
 *
 *   ADE_XM_LIVE=1 npx vitest run src/services/account/crossMachineLive.manual.test.ts
 *
 * Two brains (A and B) live in this one process, each with its own projects,
 * real embedded project runtimes, real chat services, its own cross-scope
 * router state and its own agent machine bridge. The ONLY fakes are at the
 * network boundary: the account directory, the account token, and opening a
 * paired connection, which here is an in-memory pipe into the other brain's
 * real multi-project RPC handler, created with the authenticated peer device
 * the sync host would pass. Everything above that is the shipping code.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const LIVE = process.env.ADE_XM_LIVE === "1";
const MODEL = process.env.ADE_XM_MODEL ?? "anthropic/claude-haiku-4-5";

type Brain = "A" | "B";
const net = vi.hoisted(() => ({
  online: { A: true, B: true } as Record<"A" | "B", boolean>,
  machineKeys: { A: "", B: "" } as Record<"A" | "B", string>,
  /** Connects a caller to brain `to`; set in beforeAll. */
  connect: null as null | ((to: "A" | "B", callerPeerDeviceId: string) => {
    write(data: string): void;
    onData(cb: (chunk: Buffer) => void): void;
    close(): void;
  }),
  /** Which brain's bridge is dialing, so the target sees the right peer. */
  dialingFrom: null as null | "A" | "B",
}));

vi.mock("./sharedAccountAuthService", async (importActual) => ({
  ...(await importActual<typeof import("./sharedAccountAuthService")>()),
  // The account service is the network boundary here: signed in, a token,
  // and every other method a harmless no-op.
  getSharedAccountAuthService: () => new Proxy({
    getStatus: () => ({ signedIn: true, userId: "user-1", source: "loopback" }),
    getAccessToken: async () => "token",
  } as Record<string, unknown>, {
    get: (target, key) => (key in target ? target[key as string] : () => () => {}),
  }),
  getSharedAccountDirectoryBaseUrl: () => "https://directory.invalid",
}));

vi.mock("./accountAuthService", async (importActual) => ({
  ...(await importActual<typeof import("./accountAuthService")>()),
  getSignedInAccountAccessToken: async () => "token",
}));

vi.mock("./accountMachineDirectoryService", async (importActual) => ({
  ...(await importActual<typeof import("./accountMachineDirectoryService")>()),
  reconcileAccountOwnedMachineTrust: async () => undefined,
  AccountMachineDirectoryService: class {
    async listMachines() {
      return {
        state: "ok",
        machines: (["A", "B"] as const).map((brain) => ({
          machineKey: net.machineKeys[brain],
          deviceId: `device-${brain}`,
          customName: `Machine ${brain}`,
          name: `Machine ${brain}`,
          online: net.online[brain],
          platform: "darwin",
          lastSeenAt: Date.now(),
        })),
      };
    }
    async pairListedMachine() {}
  },
}));

vi.mock("./pairedRemoteConnector", () => ({
  openPairedCandidate: async (args: {
    target: { pairedMachine: { machineKey: string } };
    acceptTransport: (transport: unknown) => Promise<unknown>;
  }) => {
    const to: "A" | "B" = args.target.pairedMachine.machineKey === net.machineKeys.A ? "A" : "B";
    if (!net.online[to]) throw new Error(`Machine ${to} is unreachable.`);
    const from = net.dialingFrom ?? (to === "A" ? "B" : "A");
    const transport = net.connect!(to, `agent-pool-of-${from}`);
    return { value: await args.acceptTransport(transport) };
  },
}));

describe.skipIf(!LIVE)("cross-machine agents, live, two brains in one process", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-xm-live-"));
  const env = { ...process.env };
  type Side = {
    brain: Brain;
    projectRoot: string;
    projectId: string;
    runtime: any;
    handlerFor: (peerDeviceId: string | null) => any;
    cross: any;
    bridge: any;
    laneId: string;
  };
  const sides = {} as Record<Brain, Side>;
  let localHandlerA: any;

  const callA = async (method: string, params: Record<string, unknown>) => {
    const response = await localHandlerA({ jsonrpc: "2.0", id: Math.random(), method, params });
    return response;
  };

  const waitFor = async <T>(label: string, read: () => Promise<T | null | undefined | false>, timeoutMs = 180_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (value) return value as T;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  };

  beforeAll(async () => {
    // A brain process: this home only, operator ceiling, no inherited chat.
    for (const key of Object.keys(process.env)) {
      if (/^ADE_(CHAT_SESSION_ID|PROJECT_ROOT|WORKSPACE_ROOT|LANE_ID|BROWSER_ACTOR_TOKEN|RPC_|RUNTIME_SOCKET_PATH|PARENT_)/.test(key)) {
        delete process.env[key];
      }
    }
    process.env.ADE_HOME = path.join(root, "home");
    process.env.ADE_DEFAULT_ROLE = "cto";
    // The supervised PTY host is a separate built script; in-process node-pty runs real shells here.
    process.env.ADE_DISABLE_SUPERVISED_PTY_HOST = "1";

    const { createAdeRuntime } = await import("../../bootstrap");
    const { ProjectRegistry } = await import("../projects/projectRegistry");
    const { createMultiProjectRpcRequestHandler } = await import("../../multiProjectRpcServer");
    const { createCrossScopeChats } = await import("../chat/crossScopeChats");
    const { createAgentMachineBridge } = await import("./agentMachineBridge");
    const externalChats = await import("../../../../desktop/src/main/services/chat/externalChats");
    const { getOrCreateLocalAccountMachineIdentity } = await import(
      "../../../../desktop/src/main/services/account/localMachineIdentity"
    );
    const { startJsonRpcServer } = await import("../../jsonrpc");

    // Both brains share this process's machine identity; A answers to it.
    net.machineKeys.A = getOrCreateLocalAccountMachineIdentity().machineKey;
    net.machineKeys.B = "machine-b-key";
    externalChats.configureExternalChatStore(path.join(root, "external-chats.json"));

    const personalStub = {
      capabilities: () => ({ version: 1, actions: [] }),
      call: async () => { throw new Error("no personal scope in this test"); },
      streamEvents: async () => ({ events: [], nextCursor: 0 }),
      dispose: async () => {},
    };

    for (const brain of ["A", "B"] as const) {
      const projectRoot = path.join(root, `project-${brain}`);
      fs.mkdirSync(projectRoot, { recursive: true });
      const git = (args: string) => require("node:child_process").execSync(`git ${args}`, { cwd: projectRoot, stdio: "ignore" });
      git("init -q -b main");
      git("remote add origin https://github.com/example/xm-live.git");
      fs.writeFileSync(path.join(projectRoot, "README.md"), "# xm live\n");
      git("add -A");
      git("-c user.email=t@t -c user.name=t commit -qm init");
      const layoutDir = path.join(root, `layout-${brain}`);
      const registry = new ProjectRegistry({
        adeDir: layoutDir,
        projectsPath: path.join(layoutDir, "projects.json"),
        secretsDir: path.join(layoutDir, "secrets"),
        sockDir: path.join(layoutDir, "sock"),
        socketPath: path.join(layoutDir, "sock", "ade.sock"),
        desktopBridgeSocketPath: path.join(layoutDir, "sock", "bridge.sock"),
        binDir: path.join(layoutDir, "bin"),
        runtimeDir: path.join(layoutDir, "runtime"),
      } as never);
      const record = registry.add(fs.realpathSync.native(projectRoot));
      const runtime = await createAdeRuntime({
        projectRoot: record.rootPath,
        workspaceRoot: record.rootPath,
        runtimeProfile: "embedded",
        chatRuntime: "agent",
      });
      const scopeRegistry = {
        get: async () => ({ registryProjectId: record.projectId, record, runtime, dispose: () => {} }),
        getIfBooted: () => Promise.resolve({ registryProjectId: record.projectId, record, runtime, dispose: () => {} }),
        dispose: async () => {},
        disposeAll: async () => {},
      };
      const bridge = createAgentMachineBridge({ appVersion: "test", projectRoots: () => [record.rootPath] });
      const cross = createCrossScopeChats({
        projectRegistry: registry,
        scopeRegistry,
        personalChatScope: null,
        deliverRemote: async (machineKey, payload) => {
          net.dialingFrom = brain;
          try { return await bridge.deliverWake(machineKey, payload); } finally { net.dialingFrom = null; }
        },
        stateDir: path.join(root, `cross-${brain}`),
        logger: {
          info: (event, meta) => console.log(`[xm-log ${brain}] ${event} ${JSON.stringify(meta ?? {}).slice(0, 300)}`),
          warn: (event, meta) => console.log(`[xm-log ${brain}] WARN ${event} ${JSON.stringify(meta ?? {}).slice(0, 300)}`),
        },
      });
      const handlerFor = (peerDeviceId: string | null) => createMultiProjectRpcRequestHandler({
        serverVersion: "test",
        peerDeviceId,
        projectRegistry: registry,
        scopeRegistry: scopeRegistry as never,
        personalChatScope: personalStub as never,
        agentMachineBridge: bridge,
        crossScopeChats: cross,
      });
      const lanes = await runtime.laneService.list({ includeArchived: false });
      sides[brain] = {
        brain,
        projectRoot: record.rootPath,
        projectId: record.projectId,
        runtime,
        handlerFor,
        cross,
        bridge,
        laneId: lanes[0].id,
      };
    }
    // Children run on B: B's router is the process router.
    externalChats.setExternalParentRouter(sides.B.cross.router);

    net.connect = (to, callerPeerDeviceId) => {
      const toServer = new PassThrough();
      const toClient = new PassThrough();
      const handler = sides[to].handlerFor(callerPeerDeviceId);
      startJsonRpcServer(handler, {
        onData: (cb) => toServer.on("data", cb),
        write: (data) => { toClient.write(data); },
        close: () => { toClient.end(); },
      });
      return {
        onData: (cb) => toClient.on("data", cb),
        write: (data) => { toServer.write(data); },
        close: () => { toServer.end(); },
      };
    };
  }, 300_000);

  afterAll(async () => {
    for (const side of Object.values(sides)) {
      try { side.runtime.dispose(); } catch {}
    }
    process.env = env;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("an agent on A starts a subagent on B, and B's finished turn wakes the parent on A", async () => {
    const A = sides.A;
    const B = sides.B;
    // The parent: a real chat on A, as the CLI in its shell would identify.
    const parent = await A.runtime.agentChatService.createSession({
      laneId: A.laneId,
      provider: "claude",
      model: MODEL,
      modelId: MODEL,
      permissionMode: "full-auto",
    });
    localHandlerA = A.handlerFor(null);
    await callA("ade/initialize", { clientName: "ade-cli", identity: { role: "agent", chatSessionId: parent.id } });

    // Roster and listing through A's brain.
    const roster = await callA("machines.list", { includeProjects: true });
    console.log("[xm] roster", JSON.stringify(roster));
    expect(roster.state).toBe("ok");
    expect(roster.machines.find((m: any) => m.name === "Machine B")?.projects?.[0]?.origin).toBe("github.com/example/xm-live");

    const scope = { kind: "repo", originUrl: "https://github.com/example/xm-live.git" };
    const lanes = await callA("machines.call", {
      machine: "Machine B",
      scope,
      request: { method: "ade/actions/call", params: { name: "list_lanes", arguments: {} } },
    });
    console.log("[xm] lanes on B", JSON.stringify(lanes.result).slice(0, 300));

    // Create the child on B, parented to this chat.
    const created = await callA("machines.call", {
      machine: "Machine B",
      scope,
      request: {
        method: "ade/actions/call",
        params: {
          name: "run_ade_action",
          arguments: {
            domain: "chat",
            action: "createSession",
            args: {
              laneId: B.laneId,
              provider: "claude",
              model: MODEL,
              modelId: MODEL,
              orchestrationParentSessionId: parent.id,
              spawnKind: "subagent",
              permissionMode: "full-auto",
            },
          },
        },
      },
    });
    const child = created.result.result;
    console.log("[xm] child", child.id, "parent on B =", child.orchestrationParentSessionId, "machine:", created.machine.name);
    expect(child.orchestrationParentSessionId).toMatch(/^remote:agent-pool-of-A:/);
    expect(child.orchestrationParentSessionId.endsWith(parent.id)).toBe(true);

    // The child's permission came from the parent's level, not the `ask` floor.
    const parentLevel = A.runtime.agentChatService.permissionLevelOf(parent.id);
    const childLevel = B.runtime.agentChatService.permissionLevelOf(child.id);
    console.log("[xm] parent level", parentLevel, "child level", childLevel);
    expect(parentLevel).toBe("full-auto");
    expect(childLevel).toBe(parentLevel);

    // Listing on B through A shows it.
    const listed = await callA("machines.call", {
      machine: "Machine B",
      scope,
      request: { method: "ade/actions/call", params: { name: "run_ade_action", arguments: { domain: "chat", action: "listSessions", args: {} } } },
    });
    const listedSessions = listed.result.result ?? [];
    expect(listedSessions.some((session: any) => (session.sessionId ?? session.id) === child.id)).toBe(true);

    // Give the child a turn.
    await callA("machines.call", {
      machine: "Machine B",
      scope,
      request: {
        method: "ade/actions/call",
        params: { name: "run_ade_action", arguments: { domain: "chat", action: "messageSession", args: { sessionId: child.id, text: "Reply with exactly the word: pong", kind: "auto" } } },
      },
    });

    // The parent on A hears back, with the machine named.
    const history = await waitFor("the parent's wake", async () => {
      const events = await A.runtime.agentChatService.getChatEventHistory(parent.id);
      const list = Array.isArray(events) ? events : events?.events ?? [];
      const wake = list.find((envelope: any) => envelope?.event?.metadata?.spawnCompletion?.childSessionId === child.id
        || envelope?.event?.detail?.spawnCompletion?.childSessionId === child.id
        || (envelope?.event?.type === "subagent_result" && envelope?.event?.agentId === child.id));
      return wake ? list : null;
    });
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const settled = await A.runtime.agentChatService.getChatEventHistory(parent.id);
    const settledList = Array.isArray(settled) ? settled : settled?.events ?? [];
    for (const envelope of settledList) {
      const event = envelope?.event ?? {};
      console.log("[xm] parent event", event.type, event.status ?? "", JSON.stringify(event.metadata?.spawnCompletion ?? event.detail?.spawnCompletion ?? null)?.slice(0, 200), (event.text ?? event.message ?? event.summary ?? "").toString().slice(0, 160));
    }
    history.splice(0, history.length, ...settledList);
    const wakeMessage = history.find((envelope: any) => envelope?.event?.metadata?.spawnCompletion?.childSessionId === child.id);
    console.log("[xm] parent wake text:", wakeMessage?.event?.text?.slice(0, 300));
    console.log("[xm] completion:", JSON.stringify(wakeMessage?.event?.metadata?.spawnCompletion ?? null));
    expect(wakeMessage?.event?.metadata?.spawnCompletion?.childMachineName).toBe("Machine B");
    expect(wakeMessage?.event?.text).toContain(`ade chat read ${child.id} --machine "Machine B"`);

    // Read the child's transcript from A.
    const transcript = await callA("machines.call", {
      machine: "Machine B",
      scope,
      request: { method: "ade/actions/call", params: { name: "run_ade_action", arguments: { domain: "chat", action: "readTranscript", args: { sessionId: child.id, limit: 10, maxChars: 4000 } } } },
    });
    console.log("[xm] child transcript:", JSON.stringify(transcript.result).slice(0, 400));

    // A goes dark mid-turn: the completion waits in B's outbox, then lands once.
    net.online.A = false;
    await callA("machines.call", {
      machine: "Machine B",
      scope,
      request: {
        method: "ade/actions/call",
        params: { name: "run_ade_action", arguments: { domain: "chat", action: "messageSession", args: { sessionId: child.id, text: "Reply with exactly the word: ping", kind: "auto" } } },
      },
    });
    const queuedOnB = (): number => {
      try {
        return (JSON.parse(fs.readFileSync(path.join(root, "cross-B", "external-parent-wakes.json"), "utf8")) as unknown[]).length;
      } catch {
        return 0;
      }
    };
    await waitFor("the second completion to queue on B", async () => queuedOnB() > 0);
    console.log("[xm] queued on B while A offline:", queuedOnB());
    net.online.A = true;
    await new Promise((resolve) => setTimeout(resolve, 31_000));
    await B.cross.pump();
    expect(queuedOnB()).toBe(0);
    const after = await A.runtime.agentChatService.getChatEventHistory(parent.id);
    const afterList = Array.isArray(after) ? after : after?.events ?? [];
    const completions = afterList.filter((envelope: any) => envelope?.event?.metadata?.spawnCompletion?.childSessionId === child.id);
    const turnIds = completions.map((envelope: any) => envelope.event.metadata.spawnCompletion.childTurnId);
    console.log("[xm] completions on parent:", turnIds);
    expect(new Set(turnIds).size).toBe(turnIds.length);
    expect(turnIds.length).toBeGreaterThanOrEqual(2);
  }, 900_000);

  it("an agent on A runs commands in its work copy on B with --machine --wait", async () => {
    const A = sides.A;
    const B = sides.B;
    const { execSync, spawn } = await import("node:child_process");
    const netModule = await import("node:net");
    const { startJsonRpcServer } = await import("../../jsonrpc");
    const sh = (cwd: string, command: string) => execSync(command, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

    // One origin for both checkouts: a local bare repository behind the
    // GitHub URL the scope matches on.
    const bare = path.join(root, "origin.git");
    sh(root, `git init -q --bare ${JSON.stringify(bare)}`);
    for (const side of [A, B]) {
      sh(side.projectRoot, `git config url.${JSON.stringify(bare)}.insteadOf https://github.com/example/xm-live.git`);
      sh(side.projectRoot, "git config user.email t@t && git config user.name t");
    }
    sh(A.projectRoot, "git push -q origin main");
    sh(A.projectRoot, "git checkout -qb feat && echo pushed > pushed.txt && git add -A && git commit -qm pushed && git push -q -u origin feat");
    fs.writeFileSync(path.join(A.projectRoot, "note.txt"), "uncommitted on A\n");

    const parent = await A.runtime.agentChatService.createSession({
      laneId: A.laneId,
      provider: "claude",
      model: MODEL,
      modelId: MODEL,
      permissionMode: "full-auto",
    });
    const socketPath = path.join(os.tmpdir(), `ade-xm-${process.pid}.sock`);
    fs.rmSync(socketPath, { force: true });
    const server = netModule.createServer((socket) => {
      startJsonRpcServer(A.handlerFor(null), {
        onData: (cb) => socket.on("data", cb),
        write: (data) => { socket.write(data); },
        close: () => { socket.end(); },
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const cliEnv: NodeJS.ProcessEnv = { ...env, ADE_CHAT_SESSION_ID: parent.id, ADE_HOME: process.env.ADE_HOME };
    for (const key of Object.keys(cliEnv)) {
      if (/^ADE_(PROJECT_ROOT|WORKSPACE_ROOT|LANE_ID|RPC_|RUNTIME_SOCKET_PATH|PARENT_|DEFAULT_ROLE)/.test(key)) delete cliEnv[key];
    }
    // Async: brain A answers from this same process.
    const cli = (args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        [path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), path.join(process.cwd(), "src", "cli.ts"), "--socket", socketPath, ...args],
        { cwd: A.projectRoot, env: cliEnv },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => child.kill(), 120_000);
      child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
    try {
      const first = await cli(["shell", "start", "--machine", "Machine B", "--wait", "--text", "--", "cat", "note.txt", "pushed.txt"]);
      console.log("[xm-shell] first", first.status, first.stdout, first.stderr.slice(-800));
      expect(first.stdout).toContain("uncommitted on A");
      expect(first.stdout).toContain("pushed");
      expect(first.status).toBe(0);

      const copies = JSON.parse(fs.readFileSync(path.join(B.projectRoot, ".ade", "remote-work", "copies.json"), "utf8")).copies;
      expect(copies).toHaveLength(1);
      expect(copies[0].owner.endsWith(parent.id)).toBe(true);
      const shells = B.runtime.ptyService.list({ chatSessionId: copies[0].owner });
      expect(shells.length).toBe(1);

      // A's brain recorded where the chat worked, for its views.
      const parentSummary = await A.runtime.agentChatService.getSessionSummary(parent.id);
      console.log("[xm-shell] remoteWork", JSON.stringify(parentSummary?.remoteWork));
      expect(parentSummary?.remoteWork?.[0]?.machineName).toBe("Machine B");
      expect(parentSummary?.remoteWork?.[0]?.terminalIds).toContain(shells[0].id);
      expect(parentSummary?.remoteWork?.[0]?.projectId).toBe(B.projectId);

      // Settings › Machines on B lists the copy, as the desktop does.
      const desktopOnB = B.handlerFor(null);
      await desktopOnB({ jsonrpc: "2.0", id: 1, method: "ade/initialize", params: { clientName: "ade-desktop-local", identity: { role: "cto" } } });
      const listing = await desktopOnB({
        jsonrpc: "2.0", id: 2, method: "ade/actions/call",
        params: { projectId: B.projectId, name: "run_ade_action", arguments: { domain: "remote_work", action: "list", args: {} } },
      });
      const rows = JSON.stringify(listing);
      console.log("[xm-shell] remote_work.list", rows.slice(0, 500));
      expect(rows).toContain(parent.id);
      expect(rows).toContain('"machineName":"Machine A"');
      expect(rows).toContain(`"projectId":"${B.projectId}"`);

      const listed = await cli(["terminal", "list", "--machine", "Machine B", "--json"]);
      console.log("[xm-shell] terminal list", listed.status, listed.stdout.slice(0, 300), listed.stderr.slice(-300));
      expect(listed.status).toBe(0);
      expect(listed.stdout).toContain(shells[0].id);
      const readBack = await cli(["terminal", "read", shells[0].id, "--machine", "Machine B", "--json"]);
      expect(readBack.stdout).toContain("uncommitted on A");

      // Argv travels as argv: "!" and spaces arrive as written.
      const quoted = await cli(["shell", "start", "--machine", "Machine B", "--wait", "--text", "--", "node", "-e", "console.log('a b', !0)"]);
      console.log("[xm-shell] quoted", quoted.status, quoted.stdout.slice(0, 200));
      expect(quoted.stdout.replace(/\u001b\[[0-9;]*m/g, "")).toContain("a b true");

      const failing = await cli(["shell", "start", "--machine", "Machine B", "--wait", "--text", "--", "sh", "-c", "exit 3"]);
      console.log("[xm-shell] failing", failing.status, failing.stdout.slice(-300), failing.stderr.slice(-300));
      expect(failing.status).toBe(3);

      // Work made there and not pushed blocks the next sync.
      fs.writeFileSync(path.join(copies[0].path, "made-there.txt"), "x\n");
      const blocked = await cli(["shell", "start", "--machine", "Machine B", "--wait", "--text", "--", "true"]);
      console.log("[xm-shell] blocked", blocked.status, blocked.stderr.slice(-400));
      expect(blocked.status).not.toBe(0);
      expect(blocked.stderr + blocked.stdout).toContain("made-there.txt");

      const unpushed = path.join(A.projectRoot, "unpushed.txt");
      fs.writeFileSync(unpushed, "y\n");
      sh(A.projectRoot, "git add unpushed.txt && git commit -qm unpushed");
      const notOnOrigin = await cli(["shell", "start", "--machine", "Machine B", "--discard", "--wait", "--text", "--", "true"]);
      console.log("[xm-shell] not on origin", notOnOrigin.status, notOnOrigin.stderr.slice(-400));
      expect(notOnOrigin.stderr + notOnOrigin.stdout).toContain("Push it first");
      sh(A.projectRoot, "git reset -q --hard HEAD~1");

      const cleaned = await cli(["shell", "clean", "--machine", "Machine B", "--text"]);
      console.log("[xm-shell] clean", cleaned.status, cleaned.stdout, cleaned.stderr.slice(0, 600));
      expect(cleaned.stdout).toContain("Deleted");
      expect(fs.existsSync(copies[0].path)).toBe(false);


      // The copy goes when its chat is archived on A: B asks A at its next sweep.
      const again = await cli(["shell", "start", "--machine", "Machine B", "--wait", "--text", "--", "true"]);
      expect(again.status).toBe(0);
      const { createRemoteWorkCopyService } = await import("../../../../desktop/src/main/services/remoteWork/remoteWorkCopyService");
      const { externalChatContext } = await import("../../../../desktop/src/main/services/chat/externalChats");
      const { parseForeignCallerSessionId } = await import("../../../../desktop/src/shared/runtimeClientNames");
      // What the brain's hourly sweep asks: the chat's own machine, over B's bridge.
      const ownerGone = async (owner: string) => {
        const chatSessionId = parseForeignCallerSessionId(owner)?.chatSessionId ?? null;
        const machineKey = externalChatContext(owner)?.machineKey ?? null;
        if (!chatSessionId || !machineKey) return null;
        net.dialingFrom = "B";
        try {
          const answer = await B.bridge.locateChat(machineKey, chatSessionId);
          return answer ? { gone: !answer.found || answer.archived, archived: answer.archived } : null;
        } finally {
          net.dialingFrom = null;
        }
      };
      const sweeper = createRemoteWorkCopyService({ projectRoot: B.projectRoot });
      expect(await sweeper.sweep({ ownerGone })).toBe(0);
      await A.runtime.agentChatService.archiveSession({ sessionId: parent.id });
      expect(await sweeper.sweep({ ownerGone })).toBe(1);
      expect(sweeper.list()).toHaveLength(0);
    } finally {
      server.close();
      fs.rmSync(socketPath, { force: true });
    }
  }, 600_000);
});
