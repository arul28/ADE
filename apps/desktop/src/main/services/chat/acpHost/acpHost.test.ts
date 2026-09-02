/**
 * ACP host conformance suite.
 *
 * The core of this file is a `feature x dialect` table. Every cell must show
 * one of two outcomes:
 *
 *   run     — the feature works end to end.
 *   degrade — the feature is absent, and the host says so without throwing and
 *             without hanging.
 *
 * Every test has a deadline. A hang is a failure, not a slow pass.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACP_METHOD,
  ACP_RPC_METHOD_NOT_FOUND,
  normalizeAcpPermissionRequest,
  normalizeAcpRpcError,
  normalizeAcpRpcId,
  normalizeAcpSessionNotification,
  type AcpContentBlock,
  type AcpSessionConfigOption,
  type AcpSessionUpdate,
} from "./acpProtocolTypes";
import {
  ACP_DIALECTS,
  acpDialectFor,
  copilotDialect,
  grokDialect,
  GROK_CLAUDE_MARKER_OVERRIDE_ENV,
  GROK_SESSION_NOTIFICATION_METHOD,
  GROK_YOLO_MODE_CHANGED_METHOD,
  includeCopilotSlashCommand,
  kimiDialect,
  qwenDialect,
  readGrokPromptUsage,
} from "./acpDialects";
import {
  ACP_PROVIDER_IDS,
  behaviorOf,
  type AcpDialect,
  type AcpProviderId,
  type AcpSlashCommand,
} from "./acpHostTypes";
import { createAcpConnection, initializeAcpConnection, AcpRpcError } from "./acpConnection";
import {
  buildAcpPoolKey,
  createAcpSessionPool,
  hashPoolEnv,
  hashSpawnInvocation,
} from "./acpSessionPool";
import { buildUnifiedDiff, createAcpEventTranslator } from "./acpEventTranslator";
import {
  createAcpPermissionBridge,
  normalizePermissionOption,
  pendingPermissionToInputRequest,
  type AcpPendingPermission,
} from "./acpPermissionBridge";
import { openAcpSession, resolveAcpSessionEntry, textPromptBlock } from "./acpSession";
import { createMockAcpAgent, respondWithSession, type MockAcpAgent } from "./mockAcpAgent";
import type { AgentChatEvent } from "../../../../shared/types";

const DEADLINE_MS = 3_000;

/** Fail loudly rather than let a hang become a slow pass. */
async function withDeadline<T>(label: string, promise: Promise<T>, ms = DEADLINE_MS): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type Harness = {
  agent: MockAcpAgent;
  events: AgentChatEvent[];
  permissions: AcpPendingPermission[];
  settled: Array<{ requestId: string; outcome: string }>;
  slashLists: AcpSlashCommand[][];
  exits: Array<{ code: number | null }>;
  open: (overrides?: Partial<Parameters<typeof openAcpSession>[0]>) => ReturnType<typeof openAcpSession>;
};

const openHarnesses: Array<() => void> = [];

function makeHarness(dialect: AcpDialect, agentOverrides: Parameters<typeof createMockAcpAgent>[0] = {}): Harness {
  const agent = createMockAcpAgent(agentOverrides);
  agent.on(ACP_METHOD.sessionNew, respondWithSession("session-1"));
  const events: AgentChatEvent[] = [];
  const permissions: AcpPendingPermission[] = [];
  const settled: Array<{ requestId: string; outcome: string }> = [];
  const slashLists: AcpSlashCommand[][] = [];
  const exits: Array<{ code: number | null }> = [];
  const pool = createAcpSessionPool();
  openHarnesses.push(() => pool.disposeAll("test teardown"));

  return {
    agent,
    events,
    permissions,
    settled,
    slashLists,
    exits,
    open: (overrides = {}) =>
      openAcpSession({
        dialect,
        cwd: "/lane/worktree",
        spawnPlan: dialect.buildSpawnPlan({
          binaryPath: `/usr/local/bin/${dialect.binaryNames[0]}`,
          cwd: "/lane/worktree",
          baseEnv: {},
        }),
        sessionToken: "chat-1",
        pool,
        spawnOverride: () => agent.child,
        callbacks: {
          onEvents: (batch) => events.push(...batch),
          onPermissionRequested: (pending) => permissions.push(pending),
          onPermissionSettled: (requestId, outcome) => settled.push({ requestId, outcome }),
          onSlashCommands: (commands) => slashLists.push(commands),
          onProcessExit: (detail) => exits.push({ code: detail.code }),
        },
        ...overrides,
      }),
  };
}

afterEach(() => {
  for (const dispose of openHarnesses.splice(0)) dispose();
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// Capability declarations
// ─────────────────────────────────────────────────────────────────────────────

describe("dialect capability declarations", () => {
  it("registers exactly the four ACP providers", () => {
    expect(Object.keys(ACP_DIALECTS).sort()).toEqual([...ACP_PROVIDER_IDS].sort());
    for (const providerId of ACP_PROVIDER_IDS) {
      expect(acpDialectFor(providerId).providerId).toBe(providerId);
    }
  });

  it.each(ACP_PROVIDER_IDS)("%s honors the requiresBehavior invariant", (providerId: AcpProviderId) => {
    const dialect = acpDialectFor(providerId);
    // A declared capability carries its behavior. The type system enforces this
    // at the definition site; this check protects against a later cast.
    for (const entry of [
      dialect.usage,
      dialect.closeSession,
      dialect.resumeSession,
      dialect.loadSession,
      dialect.sessionConfig,
      dialect.mcpInjection,
      dialect.imagePrompts,
    ]) {
      if (entry.declared) expect(typeof entry.behavior).toBe("function");
      else expect(entry).not.toHaveProperty("behavior");
    }
    // Style fields and capabilities agree.
    expect(dialect.usage.declared).toBe(dialect.usageSource !== "none");
    expect(dialect.closeSession.declared).toBe(dialect.closeStyle === "close_request");
    expect(dialect.resumeSession.declared).toBe(dialect.loadPolicy === "resume_preferred");
    expect(dialect.loadSession.declared).toBe(dialect.loadPolicy !== "never");
  });

  it.each(ACP_PROVIDER_IDS)("%s never advertises the client file system", (providerId: AcpProviderId) => {
    // Grok corrupts binary reads proxied through the text file system, and ADE
    // does not serve file reads for any ACP provider today.
    expect(acpDialectFor(providerId).advertiseFsCapability).toBe(false);
  });

  it("qwen owns one process per session because 0.22.3 has no session/close", () => {
    expect(qwenDialect.closeStyle).toBe("kill_process");
    expect(qwenDialect.oneProcessPerSession).toBe(true);
    expect(qwenDialect.authProbe.methodId).toBe("openai");
  });

  it("kimi 0.39.1 implements session/close and still hides usage", () => {
    expect(kimiDialect.closeStyle).toBe("close_request");
    expect(kimiDialect.oneProcessPerSession).toBe(false);
    expect(kimiDialect.usageSource).toBe("none");
    expect(kimiDialect.degradationNotes.length).toBeGreaterThan(0);
    expect(kimiDialect.authProbe.methodId).toBe("login");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Spawn plans
// ─────────────────────────────────────────────────────────────────────────────

describe("spawn plans", () => {
  it("grok places global flags before agent and scoped flags after it", () => {
    const plan = grokDialect.buildSpawnPlan({
      binaryPath: "/bin/grok",
      cwd: "/lane",
      baseEnv: {},
      modelId: "grok-4",
      reasoningEffort: "high",
    });
    expect(plan.args).toEqual([
      "--no-auto-update",
      "--no-plan",
      "--permission-mode",
      "default",
      "agent",
      "--no-leader",
      "-m",
      "grok-4",
      "--reasoning-effort",
      "high",
      "stdio",
    ]);
    expect(plan.args.indexOf("--no-auto-update")).toBeLessThan(plan.args.indexOf("agent"));
    expect(plan.args.indexOf("--permission-mode")).toBeLessThan(plan.args.indexOf("agent"));
    expect(plan.args.indexOf("--no-leader")).toBeGreaterThan(plan.args.indexOf("agent"));
    expect(plan.args[plan.args.length - 1]).toBe("stdio");
  });

  it("grok carries both halves of the neutralization on every spawn", () => {
    // Neither half works alone: `--permission-mode` only overrides
    // `~/.grok/config.toml`, and the marker override only cancels the Claude
    // settings import. A live six-arm probe on 1.0.13 proved dropping either
    // one re-opens the auto-approval hole, so they are asserted together.
    for (const permissionMode of [null, "plan", "default", "auto-edit", "auto", "yolo"]) {
      const plan = grokDialect.buildSpawnPlan({
        binaryPath: "/bin/grok",
        cwd: "/lane",
        baseEnv: { PATH: "/bin" },
        permissionMode,
      });
      expect(plan.args).toContain("--permission-mode");
      expect(plan.env[GROK_CLAUDE_MARKER_OVERRIDE_ENV]).toBe("1");
      expect(plan.env.PATH).toBe("/bin");
    }
  });

  it("grok always stamps --permission-mode, because yolo_mode_changed is dead on 1.0.13", () => {
    expect(
      grokDialect.buildSpawnPlan({ binaryPath: "/bin/grok", cwd: "/lane", baseEnv: {} }).args,
    ).toEqual(expect.arrayContaining(["--permission-mode", "default"]));
    expect(
      grokDialect.buildSpawnPlan({
        binaryPath: "/bin/grok",
        cwd: "/lane",
        baseEnv: {},
        permissionMode: "yolo",
      }).args,
    ).toEqual(expect.arrayContaining(["--permission-mode", "bypassPermissions"]));
    expect(
      grokDialect.buildSpawnPlan({
        binaryPath: "/bin/grok",
        cwd: "/lane",
        baseEnv: {},
        permissionMode: "auto-edit",
      }).args,
    ).toEqual(expect.arrayContaining(["--permission-mode", "acceptEdits"]));
  });

  it("grok sets no config home, even though GROK_HOME is a real override", () => {
    // `xai-dirs` honors GROK_HOME. ADE declines it on purpose: a private home
    // would hide the user's own `grok login` credential and rules.
    const plan = grokDialect.buildSpawnPlan({ binaryPath: "/bin/grok", cwd: "/lane", baseEnv: { PATH: "/bin" } });
    expect(plan.env.PATH).toBe("/bin");
    expect(plan.env.GROK_HOME).toBeUndefined();
    expect(plan.env.QWEN_HOME).toBeUndefined();
    expect(plan.env.KIMI_CODE_HOME).toBeUndefined();
    expect(plan.env.COPILOT_HOME).toBeUndefined();
  });

  it("qwen exports QWEN_HOME only when a config home exists", () => {
    expect(
      qwenDialect.buildSpawnPlan({ binaryPath: "/bin/qwen", cwd: "/lane", baseEnv: {} }).env.QWEN_HOME,
    ).toBeUndefined();
    expect(
      qwenDialect.buildSpawnPlan({
        binaryPath: "/bin/qwen",
        cwd: "/lane",
        baseEnv: {},
        configHome: "/home/.qwen",
      }).env.QWEN_HOME,
    ).toBe("/home/.qwen");
  });

  it("kimi spawns the acp subcommand and exports KIMI_CODE_HOME", () => {
    const plan = kimiDialect.buildSpawnPlan({
      binaryPath: "/bin/kimi",
      cwd: "/lane",
      baseEnv: {},
      configHome: "/home/.kimi-code",
    });
    expect(plan.args).toEqual(["acp"]);
    expect(plan.env.KIMI_CODE_HOME).toBe("/home/.kimi-code");
  });

  it("copilot gates the lane path through argv, not through the config file", () => {
    const plan = copilotDialect.buildSpawnPlan({
      binaryPath: "/bin/copilot",
      cwd: "/lane/worktree",
      baseEnv: {},
      configHome: "/home/.copilot",
    });
    expect(plan.args).toContain("--acp");
    expect(plan.args).toContain("--add-dir");
    expect(plan.args[plan.args.indexOf("--add-dir") + 1]).toBe("/lane/worktree");
    expect(plan.args).toContain("--config-dir");
    expect(plan.env.COPILOT_HOME).toBe("/home/.copilot");
  });

  // ADE removed its Copilot trust pre-seed: a live three-arm experiment on
  // 1.0.82 opened `session/new` with no trust key and no `--add-dir`, and the
  // JSONC rewrite the seed needed once replaced a user's real
  // `~/.copilot/config.json` with a stub. Nothing on the Copilot path may
  // write the provider's config home again.
  it("copilot leaves the config home byte-identical when a session opens", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-copilot-"));
    const configPath = path.join(home, "config.json");
    const live = `// User settings belong in settings.json.\n// This file is managed automatically.\n{\n  "trustedFolders": ["/already"],\n  "firstLaunchAt": "2026-03-11T00:00:00.000Z"\n}\n`;
    try {
      fs.writeFileSync(configPath, live, "utf8");
      const harness = makeHarness(copilotDialect);
      await withDeadline(
        "open",
        harness.open({
          spawnPlan: copilotDialect.buildSpawnPlan({
            binaryPath: "/bin/copilot",
            cwd: "/lane/worktree",
            baseEnv: {},
            configHome: home,
          }),
        }),
      );
      expect(fs.readdirSync(home)).toEqual(["config.json"]);
      expect(fs.readFileSync(configPath, "utf8")).toBe(live);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("copilot creates nothing in an empty config home", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-copilot-"));
    try {
      const harness = makeHarness(copilotDialect);
      await withDeadline(
        "open",
        harness.open({
          spawnPlan: copilotDialect.buildSpawnPlan({
            binaryPath: "/bin/copilot",
            cwd: "/lane/worktree",
            baseEnv: {},
            configHome: home,
          }),
        }),
      );
      expect(fs.readdirSync(home)).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Handshake and lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe("handshake", () => {
  it.each(ACP_PROVIDER_IDS)("%s completes initialize with honest capabilities", async (providerId: AcpProviderId) => {
    const dialect = acpDialectFor(providerId);
    const agent = createMockAcpAgent();
    const connection = createAcpConnection({
      dialect,
      spawnPlan: dialect.buildSpawnPlan({ binaryPath: "/bin/x", cwd: "/lane", baseEnv: {} }),
      spawnOverride: () => agent.child,
    });
    const result = await withDeadline("initialize", initializeAcpConnection({ connection, dialect }));
    expect(result.protocolVersionAccepted).toBe(true);
    const request = agent.received.find((entry) => entry.method === ACP_METHOD.initialize);
    const params = request?.params as Record<string, unknown>;
    expect(params.protocolVersion).toBe(1);
    expect((params.clientCapabilities as Record<string, unknown>).fs).toBeUndefined();
    connection.dispose("test finished");
  });

  it("stamps the grok client identifier at initialize", async () => {
    const agent = createMockAcpAgent();
    const connection = createAcpConnection({
      dialect: grokDialect,
      spawnPlan: grokDialect.buildSpawnPlan({ binaryPath: "/bin/grok", cwd: "/lane", baseEnv: {} }),
      spawnOverride: () => agent.child,
    });
    await withDeadline("initialize", initializeAcpConnection({ connection, dialect: grokDialect }));
    const params = agent.received[0]?.params as Record<string, unknown>;
    expect(params._meta).toEqual({ clientIdentifier: "ade" });
    connection.dispose("test finished");
  });

  it("survives a banner line and an unparsable line on stdout", async () => {
    const agent = createMockAcpAgent({ bannerLine: "qwen 1.2.3 - update available" });
    const connection = createAcpConnection({
      dialect: qwenDialect,
      spawnPlan: qwenDialect.buildSpawnPlan({ binaryPath: "/bin/qwen", cwd: "/lane", baseEnv: {} }),
      spawnOverride: () => agent.child,
    });
    agent.writeRaw("{ not json at all\n");
    await withDeadline("initialize", initializeAcpConnection({ connection, dialect: qwenDialect }));
    expect(connection.isAlive()).toBe(true);
    connection.dispose("test finished");
  });

  it("rejects every pending request when the process exits", async () => {
    const agent = createMockAcpAgent();
    const connection = createAcpConnection({
      dialect: qwenDialect,
      spawnPlan: qwenDialect.buildSpawnPlan({ binaryPath: "/bin/qwen", cwd: "/lane", baseEnv: {} }),
      spawnOverride: () => agent.child,
    });
    await withDeadline("initialize", initializeAcpConnection({ connection, dialect: qwenDialect }));
    // A request the agent accepts but never answers, so the exit is what
    // settles it rather than a -32601.
    agent.on(ACP_METHOD.sessionList, () => new Promise<never>(() => undefined));
    const pending = connection.request(ACP_METHOD.sessionList);
    await agent.waitForMethod(ACP_METHOD.sessionList);
    agent.exit(1);
    await withDeadline("rejection", expect(pending).rejects.toThrow(/closed/i));
  });

  it("answers an agent request the client never advertised, instead of hanging", async () => {
    const agent = createMockAcpAgent();
    const connection = createAcpConnection({
      dialect: qwenDialect,
      spawnPlan: qwenDialect.buildSpawnPlan({ binaryPath: "/bin/qwen", cwd: "/lane", baseEnv: {} }),
      spawnOverride: () => agent.child,
    });
    await withDeadline("initialize", initializeAcpConnection({ connection, dialect: qwenDialect }));
    await withDeadline(
      "fs read rejection",
      expect(agent.callClient(ACP_METHOD.fsReadTextFile, { path: "/x" })).rejects.toThrow(/does not implement/i),
    );
    connection.dispose("test finished");
  });
});

describe("protocol boundary normalization", () => {
  it("accepts only usable JSON-RPC ids and error payloads", () => {
    expect(normalizeAcpRpcId("request-1")).toBe("request-1");
    expect(normalizeAcpRpcId(3)).toBe(3);
    expect(normalizeAcpRpcId(Number.NaN)).toBeUndefined();
    expect(normalizeAcpRpcId(null)).toBeUndefined();
    expect(normalizeAcpRpcError({ code: -32000, message: "failed", data: { retry: true } })).toEqual({
      code: -32000,
      message: "failed",
      data: { retry: true },
    });
    expect(normalizeAcpRpcError({ code: "-32000", message: "failed" })).toBeNull();
  });

  it("drops malformed session updates before dispatch", () => {
    expect(normalizeAcpSessionNotification({
      sessionId: "session-1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
    })).toMatchObject({ sessionId: "session-1" });
    expect(normalizeAcpSessionNotification({
      sessionId: "session-1",
      update: { sessionUpdate: "agent_message_chunk" },
    })).toBeNull();
    expect(normalizeAcpSessionNotification({
      sessionId: "session-1",
      update: { sessionUpdate: "unknown_update" },
    })).toBeNull();
  });

  it("requires a complete permission payload before creating a pending card", () => {
    expect(normalizeAcpPermissionRequest({
      sessionId: "session-1",
      toolCall: { toolCallId: "tool-1", title: "Write file" },
      options: [{ optionId: "allow", name: "Allow" }],
    })).toMatchObject({ sessionId: "session-1", options: [{ optionId: "allow" }] });
    expect(normalizeAcpPermissionRequest({
      sessionId: "session-1",
      toolCall: { title: "Write file" },
      options: [{ optionId: "allow", name: "Allow" }],
    })).toBeNull();
    expect(normalizeAcpPermissionRequest({
      sessionId: "session-1",
      toolCall: { toolCallId: "tool-1" },
      options: [{ optionId: "allow" }],
    })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Session entry policy
// ─────────────────────────────────────────────────────────────────────────────

describe("session entry policy", () => {
  it("starts a new session when there is no stored id", () => {
    expect(
      resolveAcpSessionEntry({ dialect: qwenDialect, existingSessionId: null, adeHasTranscript: true }).mode,
    ).toBe("new");
  });

  it("prefers resume where the dialect advertises it", () => {
    const plan = resolveAcpSessionEntry({
      dialect: qwenDialect,
      existingSessionId: "s1",
      adeHasTranscript: true,
    });
    expect(plan.mode).toBe("resume");
    expect(plan.suppressReplay).toBe(false);
  });

  it("suppresses the load replay when ADE already holds the transcript", () => {
    const plan = resolveAcpSessionEntry({
      dialect: copilotDialect,
      existingSessionId: "s1",
      adeHasTranscript: true,
    });
    expect(plan.mode).toBe("load");
    expect(plan.suppressReplay).toBe(true);
  });

  it("keeps the load replay when ADE has no transcript to duplicate", () => {
    const plan = resolveAcpSessionEntry({
      dialect: copilotDialect,
      existingSessionId: "s1",
      adeHasTranscript: false,
    });
    expect(plan.suppressReplay).toBe(false);
  });

  it("drops every update a suppressed load replays", async () => {
    const harness = makeHarness(copilotDialect);
    harness.agent.on(ACP_METHOD.sessionLoad, (_params, agent) => {
      agent.emitUpdate("s1", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "replayed history" },
        messageId: "m1",
      });
      return { result: {} };
    });
    const session = await withDeadline(
      "open",
      harness.open({ existingSessionId: "s1", adeHasTranscript: true }),
    );
    expect(session.entryPlan.mode).toBe("load");
    expect(harness.events).toHaveLength(0);

    // Live updates after the load still arrive.
    harness.agent.emitUpdate("s1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "live" },
      messageId: "m2",
    });
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(harness.events.some((event) => event.type === "text" && event.text === "live")).toBe(true);
  });

  it("sends the grok auto-mode neutralizer after session/new, not before", async () => {
    const harness = makeHarness(grokDialect);
    await withDeadline("open", harness.open());
    const methods = harness.agent.methodsReceived();
    expect(methods).toContain(GROK_YOLO_MODE_CHANGED_METHOD);
    expect(methods.indexOf(GROK_YOLO_MODE_CHANGED_METHOD)).toBeGreaterThan(
      methods.indexOf(ACP_METHOD.sessionNew),
    );
    const notification = harness.agent.received.find(
      (entry) => entry.method === GROK_YOLO_MODE_CHANGED_METHOD,
    );
    expect(notification?.isNotification).toBe(true);
    expect(notification?.params).toMatchObject({ auto_mode: false, permission_mode: "ask" });
  });

  it.each(ACP_PROVIDER_IDS.filter((id) => id !== "grok"))(
    "%s sends no post-session-new notifications",
    async (providerId: AcpProviderId) => {
      const harness = makeHarness(acpDialectFor(providerId));
      await withDeadline("open", harness.open());
      expect(harness.agent.methodsReceived()).toEqual([ACP_METHOD.initialize, ACP_METHOD.sessionNew]);
    },
  );

  it("receives and ignores the grok spinner hint", async () => {
    const harness = makeHarness(grokDialect);
    await withDeadline("open", harness.open());
    harness.agent.emitNotification(GROK_SESSION_NOTIFICATION_METHOD, {
      pending_interaction: { kind: "permission" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    // A spinner hint is not a permission request. No card, and no answer.
    expect(harness.permissions).toHaveLength(0);
    expect(harness.events).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Streaming
// ─────────────────────────────────────────────────────────────────────────────

describe("stream translation", () => {
  function translateAll(updates: AcpSessionUpdate[], turnId = "turn-1"): AgentChatEvent[] {
    const translator = createAcpEventTranslator();
    translator.beginTurn(turnId);
    return updates.flatMap((update) => translator.translate(update));
  }

  it("keeps one message id across chunks that carry it", () => {
    const events = translateAll([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " }, messageId: "m1" },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" }, messageId: "m1" },
    ]);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.type === "text" && event.messageId === "m1")).toBe(true);
  });

  it("synthesizes one stable id for a stream that carries none", () => {
    const events = translateAll([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "b" } },
    ]);
    const ids = events.map((event) => (event.type === "text" ? event.messageId : null));
    expect(ids[0]).toBeTruthy();
    expect(ids[0]).toBe(ids[1]);
  });

  it("starts a new row when the message id changes", () => {
    const events = translateAll([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" }, messageId: "m1" },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "b" }, messageId: "m2" },
    ]);
    expect(events[0]).toMatchObject({ messageId: "m1" });
    expect(events[1]).toMatchObject({ messageId: "m2" });
  });

  it("maps a thought chunk to reasoning, not to text", () => {
    const events = translateAll([
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" }, messageId: "t1" },
    ]);
    expect(events).toEqual([
      { type: "reasoning", text: "thinking", itemId: "t1", turnId: "turn-1" },
    ]);
  });

  it("drops a user message chunk, because ADE already owns that bubble", () => {
    expect(
      translateAll([{ sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } }]),
    ).toEqual([]);
  });

  it("caps nothing, because live IPC publishes the uncompacted envelope", () => {
    const long = "x".repeat(200_000);
    const events = translateAll([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: long }, messageId: "m1" },
    ]);
    expect(events[0]).toMatchObject({ type: "text", text: long });
  });

  it("maps a plan update to plan steps", () => {
    const events = translateAll([
      {
        sessionUpdate: "plan",
        entries: [
          { content: "step one", priority: "high", status: "completed" },
          { content: "step two", priority: "low", status: "in_progress" },
        ],
      },
    ]);
    expect(events[0]).toMatchObject({
      type: "plan",
      steps: [
        { text: "step one", status: "completed" },
        { text: "step two", status: "in_progress" },
      ],
    });
  });
});

describe("tool call translation", () => {
  it("renders an execute tool as a command row, not a tool row", () => {
    const translator = createAcpEventTranslator();
    translator.beginTurn("turn-1");
    const opened = translator.translate({
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Run tests",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "npm test", cwd: "/lane" },
    });
    expect(translator.rowKindFor("tc1")).toBe("command");
    expect(opened[0]).toMatchObject({
      type: "command",
      command: "npm test",
      cwd: "/lane",
      itemId: "tc1",
      status: "running",
    });

    const closed = translator.translate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "12 passed" } }],
    });
    const command = closed.find((event) => event.type === "command");
    expect(command).toMatchObject({ output: "12 passed", status: "completed" });
    // The same work must not also produce a tool_call row.
    expect(closed.some((event) => event.type === "tool_call")).toBe(false);
  });

  it("renders an edit tool as file_change rows with diff content", () => {
    const translator = createAcpEventTranslator();
    translator.beginTurn("turn-1");
    translator.translate({
      sessionUpdate: "tool_call",
      toolCallId: "tc2",
      title: "Edit file",
      kind: "edit",
      status: "in_progress",
    });
    const events = translator.translate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc2",
      status: "completed",
      content: [{ type: "diff", path: "src/a.ts", oldText: "one\ntwo\n", newText: "one\nTWO\n" }],
    });
    const change = events.find((event) => event.type === "file_change");
    expect(change).toMatchObject({ type: "file_change", path: "src/a.ts", kind: "modify" });
    expect(change && "diff" in change ? change.diff : "").toContain("+TWO");
    expect(change && "diff" in change ? change.diff : "").toContain("-two");
  });

  it("keeps one row id per edited path across updates", () => {
    const translator = createAcpEventTranslator();
    translator.beginTurn("turn-1");
    translator.translate({ sessionUpdate: "tool_call", toolCallId: "tc3", title: "Edit", kind: "edit" });
    const first = translator.translate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc3",
      content: [{ type: "diff", path: "a.ts", oldText: "a", newText: "b" }],
    });
    const second = translator.translate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc3",
      status: "completed",
      content: [{ type: "diff", path: "a.ts", oldText: "a", newText: "c" }],
    });
    const firstId = first.find((event) => event.type === "file_change");
    const secondId = second.find((event) => event.type === "file_change");
    expect(firstId && "itemId" in firstId ? firstId.itemId : null).toBe(
      secondId && "itemId" in secondId ? secondId.itemId : undefined,
    );
  });

  it("emits tool_call then tool_result for an ordinary tool", () => {
    const translator = createAcpEventTranslator();
    translator.beginTurn("turn-1");
    const opened = translator.translate({
      sessionUpdate: "tool_call",
      toolCallId: "tc4",
      title: "Search",
      name: "grep",
      kind: "search",
      rawInput: { pattern: "todo" },
    });
    expect(opened[0]).toMatchObject({ type: "tool_call", tool: "grep", itemId: "tc4" });
    const closed = translator.translate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc4",
      status: "completed",
      rawOutput: { matches: 3 },
    });
    expect(closed[0]).toMatchObject({ type: "tool_result", tool: "grep", status: "completed" });
  });

  it("adopts a tool_call_update for a call it never saw open", () => {
    const translator = createAcpEventTranslator();
    translator.beginTurn("turn-1");
    const events = translator.translate({
      sessionUpdate: "tool_call_update",
      toolCallId: "orphan",
      title: "Orphan",
      status: "completed",
    });
    expect(events.some((event) => event.type === "tool_call")).toBe(true);
    expect(events.some((event) => event.type === "tool_result")).toBe(true);
  });

  it("closes a tool row exactly once", () => {
    const translator = createAcpEventTranslator();
    translator.beginTurn("turn-1");
    translator.translate({ sessionUpdate: "tool_call", toolCallId: "tc5", title: "T", kind: "other" });
    const first = translator.translate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc5",
      status: "completed",
    });
    const second = translator.translate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc5",
      status: "completed",
    });
    expect(first.filter((event) => event.type === "tool_result")).toHaveLength(1);
    expect(second.filter((event) => event.type === "tool_result")).toHaveLength(0);
  });
});

describe("unified diff", () => {
  it("produces one hunk around the change", () => {
    const diff = buildUnifiedDiff("f.ts", "a\nb\nc\n", "a\nB\nc\n");
    expect(diff).toContain("--- a/f.ts");
    expect(diff).toContain("+++ b/f.ts");
    expect(diff).toContain("-b");
    expect(diff).toContain("+B");
    expect(diff).not.toContain("-a");
  });

  it("returns nothing when the text did not change", () => {
    expect(buildUnifiedDiff("f.ts", "same", "same")).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Slash commands and config options
// ─────────────────────────────────────────────────────────────────────────────

describe("slash command advertisement", () => {
  it("fires once for a repeated identical list", () => {
    const seen: AcpSlashCommand[][] = [];
    const translator = createAcpEventTranslator({ callbacks: { onSlashCommands: (list) => seen.push(list) } });
    const update: AcpSessionUpdate = {
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "review", description: "Review the diff" }],
    };
    translator.translate(update);
    translator.translate(update);
    translator.translate(update);
    expect(seen).toHaveLength(1);
  });

  it("fires again when the list actually changes", () => {
    const seen: AcpSlashCommand[][] = [];
    const translator = createAcpEventTranslator({ callbacks: { onSlashCommands: (list) => seen.push(list) } });
    translator.translate({
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "a", description: "A" }],
    });
    translator.translate({
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "a", description: "A" }, { name: "b", description: "B" }],
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toHaveLength(2);
  });

  it("filters copilot terminal-only commands out of the picker", () => {
    expect(includeCopilotSlashCommand({ name: "/diff", description: "" })).toBe(false);
    expect(includeCopilotSlashCommand({ name: "resume", description: "" })).toBe(false);
    expect(includeCopilotSlashCommand({ name: "login", description: "" })).toBe(false);
    expect(includeCopilotSlashCommand({ name: "undo", description: "" })).toBe(false);
    expect(includeCopilotSlashCommand({ name: "plan", description: "" })).toBe(true);
  });

  it("applies the dialect filter through the translator", () => {
    const seen: AcpSlashCommand[][] = [];
    const translator = createAcpEventTranslator({
      includeSlashCommand: copilotDialect.includeSlashCommand,
      callbacks: { onSlashCommands: (list) => seen.push(list) },
    });
    translator.translate({
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "diff", description: "terminal only" },
        { name: "explain", description: "a real command" },
      ],
    });
    expect(seen[0]?.map((command) => command.name)).toEqual(["explain"]);
  });

  it("reports config options and mode changes through the typed callback", () => {
    const snapshots: Array<{ currentModeId: string | null; count: number }> = [];
    const translator = createAcpEventTranslator({
      callbacks: {
        onConfigOptions: (snapshot) =>
          snapshots.push({ currentModeId: snapshot.currentModeId, count: snapshot.options.length }),
      },
    });
    translator.translate({
      sessionUpdate: "config_option_update",
      configOptions: [{ id: "mode", name: "Mode" }],
    });
    translator.translate({ sessionUpdate: "current_mode_update", currentModeId: "plan" });
    expect(snapshots).toEqual([
      { currentModeId: null, count: 1 },
      { currentModeId: "plan", count: 0 },
    ]);
  });

  it("normalizes Copilot currentValue config options before the callback", () => {
    const snapshots: AcpSessionConfigOption[][] = [];
    const translator = createAcpEventTranslator({
      callbacks: { onConfigOptions: (snapshot) => snapshots.push(snapshot.options) },
    });
    translator.translate({
      sessionUpdate: "config_option_update",
      configOptions: [
        {
          id: "mode",
          name: "Mode",
          currentValue: "https://agentclientprotocol.com/protocol/session-modes#agent",
          options: [{ value: "https://agentclientprotocol.com/protocol/session-modes#agent", name: "Agent" }],
        } as never,
      ],
    });
    expect(snapshots[0]?.[0]).toMatchObject({
      id: "mode",
      value: "https://agentclientprotocol.com/protocol/session-modes#agent",
      options: [{ id: "https://agentclientprotocol.com/protocol/session-modes#agent", name: "Agent" }],
    });
  });
});

describe("session config", () => {
  it("qwen sets mode, model, and thinking", async () => {
    const harness = makeHarness(qwenDialect);
    harness.agent.on(ACP_METHOD.sessionSetConfigOption, () => ({ result: {} }));
    const session = await withDeadline("open", harness.open());
    await withDeadline("set", session.setConfigOption({ configId: "model", value: "qwen3-coder" }));
    const call = harness.agent.received.find((entry) => entry.method === ACP_METHOD.sessionSetConfigOption);
    expect(call?.params).toMatchObject({ sessionId: "session-1", configId: "model", value: "qwen3-coder" });
    expect([...qwenDialect.configOptionIds]).toEqual(["mode", "model", "thinking"]);
  });

  it.each(["kimi", "grok", "copilot"] as const)(
    "%s refuses a config option instead of sending a call it does not support",
    async (providerId) => {
      const harness = makeHarness(acpDialectFor(providerId));
      const session = await withDeadline("open", harness.open());
      await withDeadline(
        "refusal",
        expect(session.setConfigOption({ configId: "mode", value: "plan" })).rejects.toThrow(
          /does not accept session config options/i,
        ),
      );
      expect(harness.agent.methodsReceived()).not.toContain(ACP_METHOD.sessionSetConfigOption);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Permissions
// ─────────────────────────────────────────────────────────────────────────────

describe("permission option normalization", () => {
  it("trusts the wire kind when the agent sends one", () => {
    const option = normalizePermissionOption({ optionId: "x", name: "Weird", kind: "reject_always" });
    expect(option).toMatchObject({ kind: "reject_always", kindFromWire: true });
  });

  it("recognizes the grok enable-always-approve option from its id", () => {
    const option = normalizePermissionOption({ optionId: "enable-always-approve", name: "Always allow" });
    expect(option.kind).toBe("allow_always");
    expect(option.kindFromWire).toBe(false);
  });

  it("classifies plain allow and reject ids", () => {
    expect(normalizePermissionOption({ optionId: "allow", name: "Allow" }).kind).toBe("allow_once");
    expect(normalizePermissionOption({ optionId: "reject", name: "Reject" }).kind).toBe("reject_once");
    expect(normalizePermissionOption({ optionId: "deny-always", name: "Never" }).kind).toBe("reject_always");
  });

  it("never guesses an unknown option into an always kind", () => {
    expect(normalizePermissionOption({ optionId: "zzz", name: "Hmm" }).kind).toBe("allow_once");
  });
});

describe("permission round trip", () => {
  it("answers the agent with the option the user chose", async () => {
    const harness = makeHarness(qwenDialect);
    const session = await withDeadline("open", harness.open());
    const answer = harness.agent.callClient(ACP_METHOD.sessionRequestPermission, {
      sessionId: session.sessionId,
      toolCall: { toolCallId: "tc1", title: "Write file", kind: "edit" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    await vi.waitFor(() => expect(harness.permissions).toHaveLength(1));
    harness.permissions[0]!.select("allow");
    await expect(withDeadline("permission answer", answer)).resolves.toMatchObject({
      outcome: { outcome: "selected", optionId: "allow" },
    });
    expect(harness.settled).toEqual([{ requestId: harness.permissions[0]!.requestId, outcome: "selected" }]);
  });

  it("routes pooled permission requests to the matching ACP session", async () => {
    const agent = createMockAcpAgent();
    let nextSession = 1;
    agent.on(ACP_METHOD.sessionNew, () => ({ result: { sessionId: `session-${nextSession++}` } }));
    const pool = createAcpSessionPool();
    openHarnesses.push(() => pool.disposeAll("test teardown"));
    const first: AcpPendingPermission[] = [];
    const second: AcpPendingPermission[] = [];
    const open = (sessionToken: string, permissions: AcpPendingPermission[]) => openAcpSession({
      dialect: kimiDialect,
      cwd: "/lane/worktree",
      spawnPlan: kimiDialect.buildSpawnPlan({ binaryPath: "/bin/kimi", cwd: "/lane/worktree", baseEnv: {} }),
      sessionToken,
      pool,
      spawnOverride: () => agent.child,
      callbacks: {
        onEvents: () => undefined,
        onPermissionRequested: (pending) => permissions.push(pending),
        onPermissionSettled: () => undefined,
      },
    });
    const [firstSession, secondSession] = await withDeadline("pooled opens", Promise.all([
      open("chat-first", first),
      open("chat-second", second),
    ]));

    const firstAnswer = agent.callClient(ACP_METHOD.sessionRequestPermission, {
      sessionId: firstSession.sessionId,
      toolCall: { toolCallId: "first-tool", title: "First write", kind: "edit" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    });
    await vi.waitFor(() => expect(first).toHaveLength(1));
    expect(second).toHaveLength(0);

    const secondAnswer = agent.callClient(ACP_METHOD.sessionRequestPermission, {
      sessionId: secondSession.sessionId,
      toolCall: { toolCallId: "second-tool", title: "Second write", kind: "edit" },
      options: [{ optionId: "reject", name: "Reject", kind: "reject_once" }],
    });
    await vi.waitFor(() => expect(second).toHaveLength(1));
    expect(first).toHaveLength(1);

    second[0]!.select("reject");
    first[0]!.select("allow");
    await expect(withDeadline("first permission", firstAnswer)).resolves.toMatchObject({
      outcome: { outcome: "selected", optionId: "allow" },
    });
    await expect(withDeadline("second permission", secondAnswer)).resolves.toMatchObject({
      outcome: { outcome: "selected", optionId: "reject" },
    });
    await firstSession.close("test finished");
    await secondSession.close("test finished");
  });

  it("answers cancelled for every open request when the turn is cancelled", async () => {
    const harness = makeHarness(qwenDialect);
    harness.agent.on(ACP_METHOD.sessionCancel, () => ({ result: {} }));
    const session = await withDeadline("open", harness.open());
    const answer = harness.agent.callClient(ACP_METHOD.sessionRequestPermission, {
      sessionId: session.sessionId,
      toolCall: { toolCallId: "tc1", title: "Delete" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    });
    await vi.waitFor(() => expect(harness.permissions).toHaveLength(1));
    await withDeadline("cancel", session.cancel("user stopped the turn"));
    await expect(withDeadline("permission cancellation", answer)).resolves.toMatchObject({
      outcome: { outcome: "cancelled" },
    });
  });

  it("fails closed when the host cannot raise a card", async () => {
    const bridge = createAcpPermissionBridge({
      callbacks: {
        onPermissionRequested: () => {
          throw new Error("no surface available");
        },
        onPermissionSettled: () => undefined,
      },
    });
    await expect(
      withDeadline(
        "fail closed",
        bridge.handleRequest({
          sessionId: "s",
          toolCall: { toolCallId: "t" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        }),
      ),
    ).resolves.toMatchObject({ outcome: { outcome: "cancelled" } });
  });

  it("answers a malformed permission request instead of hanging", async () => {
    const bridge = createAcpPermissionBridge({
      callbacks: { onPermissionRequested: () => undefined, onPermissionSettled: () => undefined },
    });
    await expect(withDeadline("malformed", bridge.handleRequest({ nonsense: true }))).resolves.toMatchObject({
      outcome: { outcome: "cancelled" },
    });
  });

  it("rejects open requests when the connection goes away", async () => {
    const settled: string[] = [];
    const bridge = createAcpPermissionBridge({
      callbacks: {
        onPermissionRequested: () => undefined,
        onPermissionSettled: (_id, outcome) => settled.push(outcome),
      },
    });
    const pending = bridge.handleRequest({
      sessionId: "s",
      toolCall: { toolCallId: "t" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    });
    bridge.rejectAll("process exited");
    await withDeadline("rejection", expect(pending).rejects.toThrow(/abandoned/i));
    expect(settled).toEqual(["closed"]);
  });

  it("shapes a pending permission as an ADE pending-input request", () => {
    const bridge = createAcpPermissionBridge({
      callbacks: {
        onPermissionRequested: (pending) => {
          const request = pendingPermissionToInputRequest({
            pending,
            source: "ade",
            providerLabel: "Grok",
          });
          expect(request.kind).toBe("approval");
          expect(request.blocking).toBe(true);
          expect(request.options?.map((option) => option.value)).toEqual([
            "enable-always-approve",
            "reject",
          ]);
          expect(request.questions[0]?.question).toBe("Run rm -rf");
        },
        onPermissionSettled: () => undefined,
      },
    });
    void bridge.handleRequest({
      sessionId: "s",
      toolCall: { toolCallId: "t", title: "Run rm -rf" },
      options: [
        { optionId: "enable-always-approve", name: "Always allow" },
        { optionId: "reject", name: "Reject" },
      ],
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Supervision invariant
// ─────────────────────────────────────────────────────────────────────────────

describe("unsupervised session invariant", () => {
  /** One turn that writes a file and never asks. */
  const writingTurn = (harness: Harness, kind: "edit" | "execute" | "read" = "edit") => {
    harness.agent.on(ACP_METHOD.sessionPrompt, (_params, agent) => {
      agent.emitUpdate("session-1", {
        sessionUpdate: "tool_call",
        toolCallId: `tc-${kind}`,
        title: kind === "execute" ? "Run ls" : "Write src/app.ts",
        kind,
        status: "completed",
        rawInput: { command: "ls" },
      });
      return { result: { stopReason: "end_turn" } };
    });
  };

  const notices = (harness: Harness) =>
    harness.events.filter((event) => event.type === "system_notice");

  it("says so once when writes happened with zero permission requests", async () => {
    const harness = makeHarness(grokDialect);
    writingTurn(harness);
    const session = await withDeadline("open", harness.open({ permissionMode: "default" }));
    await withDeadline("turn", session.prompt({ turnId: "t1", blocks: [textPromptBlock("go")] }));
    expect(notices(harness)).toHaveLength(1);
    expect(notices(harness)[0]).toMatchObject({
      type: "system_notice",
      severity: "warning",
      message: "Grok changed files here without asking ADE to approve. ADE's approval cards can't gate this chat.",
    });
    expect(session.unsupervised).toBe(true);
  });

  it("reports what ADE observed, and never guesses who decided", async () => {
    // Grok evaluates per-project remembered approvals before prompt policy, so
    // silence can also mean the user granted "always allow" earlier — possibly
    // in Grok's own TUI, outside ADE. The headline must stay true under both
    // causes, and the detail body names them rather than picking one.
    const harness = makeHarness(grokDialect);
    writingTurn(harness);
    const session = await withDeadline("open", harness.open({ permissionMode: "default" }));
    await withDeadline("turn", session.prompt({ turnId: "t1", blocks: [textPromptBlock("go")] }));
    const notice = notices(harness)[0];
    const message = notice?.type === "system_notice" ? notice.message : "";
    expect(message).not.toMatch(/approved its own/i);
    expect(message).toContain("without asking ADE to approve");
    const detail = notice?.type === "system_notice" ? notice.detail : undefined;
    expect(typeof detail === "string" && detail).toContain("already granted");
    expect(typeof detail === "string" && detail).toContain("is approving the work itself");
  });

  it("says it once and only once, however many turns follow", async () => {
    const harness = makeHarness(grokDialect);
    writingTurn(harness);
    const session = await withDeadline("open", harness.open({ permissionMode: "default" }));
    await withDeadline("turn 1", session.prompt({ turnId: "t1", blocks: [textPromptBlock("go")] }));
    await withDeadline("turn 2", session.prompt({ turnId: "t2", blocks: [textPromptBlock("go")] }));
    await withDeadline("turn 3", session.prompt({ turnId: "t3", blocks: [textPromptBlock("go")] }));
    expect(notices(harness)).toHaveLength(1);
  });

  it("stays silent when the agent did ask, even for later turns it does not", async () => {
    // A user who answered `allow-edits-session` bought the silence. Blaming the
    // agent for the user's own choice would be a false alarm.
    const harness = makeHarness(grokDialect);
    const session = await withDeadline("open", harness.open({ permissionMode: "default" }));
    const answer = harness.agent.callClient(ACP_METHOD.sessionRequestPermission, {
      sessionId: session.sessionId,
      toolCall: { toolCallId: "tc1", title: "Write file", kind: "edit" },
      options: [{ optionId: "allow-edits-session", name: "Allow edits this session" }],
    });
    await vi.waitFor(() => expect(harness.permissions).toHaveLength(1));
    harness.permissions[0]!.select("allow-edits-session");
    await withDeadline("permission answer", answer);

    writingTurn(harness);
    await withDeadline("turn", session.prompt({ turnId: "t1", blocks: [textPromptBlock("go")] }));
    expect(notices(harness)).toHaveLength(0);
    expect(session.unsupervised).toBe(false);
  });

  it("stays silent in a mode that never promised a prompt", async () => {
    const harness = makeHarness(grokDialect);
    writingTurn(harness);
    const session = await withDeadline("open", harness.open({ permissionMode: "yolo" }));
    await withDeadline("turn", session.prompt({ turnId: "t1", blocks: [textPromptBlock("go")] }));
    expect(notices(harness)).toHaveLength(0);
  });

  it("stays silent for a read-only turn, because reads never prompt anywhere", async () => {
    const harness = makeHarness(grokDialect);
    writingTurn(harness, "read");
    const session = await withDeadline("open", harness.open({ permissionMode: "default" }));
    await withDeadline("turn", session.prompt({ turnId: "t1", blocks: [textPromptBlock("go")] }));
    expect(notices(harness)).toHaveLength(0);
  });

  it("names commands rather than file changes when the turn only ran commands", async () => {
    const harness = makeHarness(grokDialect);
    writingTurn(harness, "execute");
    const session = await withDeadline("open", harness.open({ permissionMode: "default" }));
    await withDeadline("turn", session.prompt({ turnId: "t1", blocks: [textPromptBlock("go")] }));
    expect(notices(harness)[0]).toMatchObject({
      message: "Grok ran commands here without asking ADE to approve. ADE's approval cards can't gate this chat.",
    });
  });

  it("degrades loudly when the preflight could not confirm supervision", async () => {
    // No tool call at all: a session ADE could not verify still says so, and it
    // still runs. It never claims a supervision it cannot deliver.
    const harness = makeHarness(grokDialect);
    harness.agent.on(ACP_METHOD.sessionPrompt, () => ({ result: { stopReason: "end_turn" } }));
    const session = await withDeadline(
      "open",
      harness.open({ permissionMode: "default", supervisionPreflight: { ok: false, detail: "spawn ENOENT" } }),
    );
    await withDeadline("turn", session.prompt({ turnId: "t1", blocks: [textPromptBlock("go")] }));
    expect(notices(harness)).toHaveLength(1);
    expect(notices(harness)[0]).toMatchObject({
      message: "ADE could not confirm that Grok will ask before it edits files here. It may approve its own changes.",
    });
    await withDeadline("turn 2", session.prompt({ turnId: "t2", blocks: [textPromptBlock("go")] }));
    expect(notices(harness)).toHaveLength(1);
  });

  it("says nothing at all when the preflight passed and the agent behaved", async () => {
    const harness = makeHarness(grokDialect);
    harness.agent.on(ACP_METHOD.sessionPrompt, () => ({ result: { stopReason: "end_turn" } }));
    const session = await withDeadline(
      "open",
      harness.open({ permissionMode: "default", supervisionPreflight: { ok: true } }),
    );
    await withDeadline("turn", session.prompt({ turnId: "t1", blocks: [textPromptBlock("go")] }));
    expect(notices(harness)).toHaveLength(0);
  });

  it("repeats nothing for a chat that already showed the line in an earlier run", async () => {
    const harness = makeHarness(grokDialect);
    writingTurn(harness);
    const session = await withDeadline(
      "open",
      harness.open({ permissionMode: "default", supervisionAlreadyNotified: true }),
    );
    await withDeadline("turn", session.prompt({ turnId: "t1", blocks: [textPromptBlock("go")] }));
    expect(notices(harness)).toHaveLength(0);
  });

  it("applies to every ACP provider, not just grok", async () => {
    for (const providerId of ACP_PROVIDER_IDS) {
      const harness = makeHarness(acpDialectFor(providerId));
      writingTurn(harness);
      const session = await withDeadline("open", harness.open({ permissionMode: "default" }));
      await withDeadline("turn", session.prompt({ turnId: "t1", blocks: [textPromptBlock("go")] }));
      expect(notices(harness)).toHaveLength(1);
      expect(notices(harness)[0]?.type === "system_notice" && notices(harness)[0]?.message)
        .toContain(acpDialectFor(providerId).displayName);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cancel
// ─────────────────────────────────────────────────────────────────────────────

describe("cancel", () => {
  it.each(["grok", "copilot"] as const)(
    "%s sends cancel as a notification, never as a request",
    async (providerId) => {
      const harness = makeHarness(acpDialectFor(providerId));
      const session = await withDeadline("open", harness.open());
      await withDeadline("cancel", session.cancel("stopped"));
      const cancel = harness.agent.received.find((entry) => entry.method === ACP_METHOD.sessionCancel);
      expect(cancel?.isNotification).toBe(true);
    },
  );

  it.each(["qwen", "kimi"] as const)("%s sends cancel as a request", async (providerId) => {
    const harness = makeHarness(acpDialectFor(providerId));
    harness.agent.on(ACP_METHOD.sessionCancel, () => ({ result: {} }));
    const session = await withDeadline("open", harness.open());
    await withDeadline("cancel", session.cancel("stopped"));
    const cancel = harness.agent.received.find((entry) => entry.method === ACP_METHOD.sessionCancel);
    expect(cancel?.isNotification).toBe(false);
  });

  it("falls back to the notification form when the request form is unknown", async () => {
    const harness = makeHarness(qwenDialect);
    // No handler registered, so the mock answers -32601, exactly like Grok.
    const session = await withDeadline("open", harness.open());
    await withDeadline("cancel", session.cancel("stopped"));
    const cancels = harness.agent.received.filter((entry) => entry.method === ACP_METHOD.sessionCancel);
    expect(cancels).toHaveLength(2);
    expect(cancels[1]?.isNotification).toBe(true);
  });

  it("reports a cancelled turn as interrupted even when the agent says end_turn", async () => {
    const harness = makeHarness(copilotDialect);
    let releasePrompt: (() => void) | null = null;
    harness.agent.on(ACP_METHOD.sessionPrompt, async () => {
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
      // github/copilot-cli issue 4561: a cancelled turn reports end_turn.
      return { result: { stopReason: "end_turn" } };
    });
    const session = await withDeadline("open", harness.open());
    const turn = session.prompt({ turnId: "turn-1", blocks: [textPromptBlock("go")] as AcpContentBlock[] });
    await vi.waitFor(() => expect(releasePrompt).toBeTruthy());
    await withDeadline("cancel", session.cancel("user stopped"));
    releasePrompt!();
    const outcome = await withDeadline("turn", turn);
    expect(outcome.stopReason).toBe("end_turn");
    expect(outcome.interrupted).toBe(true);
  });

  it("reports an uncancelled turn as not interrupted", async () => {
    const harness = makeHarness(qwenDialect);
    harness.agent.on(ACP_METHOD.sessionPrompt, () => ({ result: { stopReason: "end_turn" } }));
    const session = await withDeadline("open", harness.open());
    const outcome = await withDeadline(
      "turn",
      session.prompt({ turnId: "turn-1", blocks: [textPromptBlock("go")] as AcpContentBlock[] }),
    );
    expect(outcome.interrupted).toBe(false);
  });
});

describe("turn lifecycle", () => {
  it("rejects the in-flight prompt when the process exits", async () => {
    const harness = makeHarness(qwenDialect);
    harness.agent.on(ACP_METHOD.sessionPrompt, () => new Promise(() => undefined));
    const session = await withDeadline("open", harness.open());
    const turn = session.prompt({
      turnId: "turn-1",
      blocks: [textPromptBlock("go")] as AcpContentBlock[],
    });
    await harness.agent.waitForMethod(ACP_METHOD.sessionPrompt);
    harness.agent.exit(1);
    await expect(withDeadline("prompt after exit", turn)).rejects.toThrow(/closed/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Usage
// ─────────────────────────────────────────────────────────────────────────────

describe("usage", () => {
  it("qwen folds a usage_update into a context_usage event", async () => {
    const harness = makeHarness(qwenDialect);
    harness.agent.on(ACP_METHOD.sessionPrompt, (_params, agent) => {
      agent.emitUpdate("session-1", { sessionUpdate: "usage_update", used: 25_000, size: 100_000 });
      return { result: { stopReason: "end_turn" } };
    });
    const session = await withDeadline("open", harness.open());
    await withDeadline(
      "turn",
      session.prompt({ turnId: "turn-1", blocks: [textPromptBlock("go")] as AcpContentBlock[] }),
    );
    const usage = harness.events.find((event) => event.type === "context_usage");
    expect(usage).toMatchObject({
      type: "context_usage",
      usage: { totalTokens: 25_000, maxTokens: 100_000, percentage: 25 },
    });
  });

  it("grok reads usage from the prompt result meta", async () => {
    const harness = makeHarness(grokDialect);
    harness.agent.on(ACP_METHOD.sessionPrompt, () => ({
      result: {
        stopReason: "end_turn",
        _meta: {
          costUsdTicks: 2_500_000_000,
          cachedReadTokens: 40,
          modelUsage: { "grok-4": { inputTokens: 100, outputTokens: 20, reasoningTokens: 5 } },
        },
      },
    }));
    const session = await withDeadline("open", harness.open());
    const outcome = await withDeadline(
      "turn",
      session.prompt({ turnId: "turn-1", blocks: [textPromptBlock("go")] as AcpContentBlock[] }),
    );
    expect(outcome.usage).toMatchObject({
      costUsd: 2.5,
      cacheReadTokens: 40,
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      totalTokens: 120,
    });
    expect(outcome.events.some((event) => event.type === "tokens")).toBe(true);
  });

  it("grok usage reader returns null for meta it cannot read", () => {
    expect(readGrokPromptUsage(null)).toBeNull();
    expect(readGrokPromptUsage({ unrelated: true })).toBeNull();
  });

  it("kimi reports no usage, and emits no usage events at all", async () => {
    const harness = makeHarness(kimiDialect);
    harness.agent.on(ACP_METHOD.sessionPrompt, (_params, agent) => {
      // Even if a future build starts sending it, the dialect declares none, so
      // ADE must stay consistent with the hidden usage meter.
      agent.emitUpdate("session-1", { sessionUpdate: "usage_update", used: 10, size: 100 });
      return { result: { stopReason: "end_turn", usage: { totalTokens: 5, inputTokens: 4, outputTokens: 1 } } };
    });
    const session = await withDeadline("open", harness.open());
    const outcome = await withDeadline(
      "turn",
      session.prompt({ turnId: "turn-1", blocks: [textPromptBlock("go")] as AcpContentBlock[] }),
    );
    expect(outcome.usage).toBeNull();
    expect(outcome.events).toEqual([]);
    expect(harness.events.some((event) => event.type === "context_usage")).toBe(false);
  });

  it("copilot reads usage from both sources", async () => {
    const behavior = behaviorOf(copilotDialect.usage);
    expect(behavior).toBeTruthy();
    expect(behavior!({ usageUpdate: { used: 10, size: 40 } })).toMatchObject({
      contextUsedTokens: 10,
      contextWindowTokens: 40,
    });
    expect(behavior!({ promptUsage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, thoughtTokens: 2 } })).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      reasoningTokens: 2,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Close and pooling
// ─────────────────────────────────────────────────────────────────────────────

describe("close and eviction", () => {
  it.each(["kimi", "grok", "copilot"] as const)(
    "%s ends a session with session/close and keeps the process",
    async (providerId) => {
      const harness = makeHarness(acpDialectFor(providerId));
      harness.agent.on(ACP_METHOD.sessionClose, () => ({ result: {} }));
      const session = await withDeadline("open", harness.open());
      await withDeadline("close", session.close("chat ended"));
      expect(harness.agent.methodsReceived()).toContain(ACP_METHOD.sessionClose);
      expect(session.connection.isAlive()).toBe(true);
    },
  );

  it("qwen ends a session by ending its private process", async () => {
    const harness = makeHarness(qwenDialect);
    const session = await withDeadline("open", harness.open());
    await withDeadline("close", session.close("chat ended"));
    expect(harness.agent.methodsReceived()).not.toContain(ACP_METHOD.sessionClose);
    expect(session.connection.isAlive()).toBe(false);
  });

  it("close is safe to call twice", async () => {
    const harness = makeHarness(kimiDialect);
    harness.agent.on(ACP_METHOD.sessionClose, () => ({ result: {} }));
    const session = await withDeadline("open", harness.open());
    await withDeadline("close", session.close("first"));
    await withDeadline("close again", session.close("second"));
    expect(harness.agent.methodsReceived().filter((method) => method === ACP_METHOD.sessionClose)).toHaveLength(1);
  });

  it("survives an agent that answers session/close with method not found", async () => {
    const harness = makeHarness(copilotDialect);
    const session = await withDeadline("open", harness.open());
    await withDeadline("close", session.close("chat ended"));
    // Copilot 1.0.82 answers -32601. Degraded, not thrown. The pooled process
    // stays usable for other chats.
    expect(session.connection.isAlive()).toBe(true);
  });
});

describe("pooling", () => {
  it("keys a pool entry on provider, cwd, environment, and invocation", () => {
    const base = { providerId: "qwen", cwd: "/lane", envHash: "aaa", invocationHash: "iii" };
    const keys = [
      buildAcpPoolKey(base),
      buildAcpPoolKey({ ...base, envHash: "bbb" }),
      buildAcpPoolKey({ ...base, cwd: "/other" }),
      buildAcpPoolKey({ ...base, invocationHash: "jjj" }),
    ];
    expect(new Set(keys).size).toBe(4);
  });

  it("separates two chats whose model rides a process-global spawn flag", () => {
    // Grok takes the model as `-m` on the command line, and `session/new`
    // cannot override it. Sharing would run the second chat on the first
    // chat's model.
    const forModel = (modelId: string) =>
      hashSpawnInvocation(
        grokDialect.buildSpawnPlan({ binaryPath: "/bin/grok", cwd: "/lane", baseEnv: {}, modelId }),
      );
    expect(forModel("grok-4")).not.toBe(forModel("grok-4-fast"));
  });

  it("hashes only the declared environment keys", () => {
    const base = hashPoolEnv({ QWEN_HOME: "/h", IRRELEVANT: "1" }, ["QWEN_HOME"]);
    const same = hashPoolEnv({ QWEN_HOME: "/h", IRRELEVANT: "2" }, ["QWEN_HOME"]);
    const different = hashPoolEnv({ QWEN_HOME: "/other" }, ["QWEN_HOME"]);
    expect(base).toBe(same);
    expect(base).not.toBe(different);
  });

  it("gives a kill_process dialect a private key per session", () => {
    const base = { providerId: "qwen", cwd: "/lane", envHash: "a", invocationHash: "i" };
    expect(buildAcpPoolKey({ ...base, privateToken: "chat-1" })).not.toBe(
      buildAcpPoolKey({ ...base, privateToken: "chat-2" }),
    );
  });

  it("shares one process between two sessions with the same key", async () => {
    const pool = createAcpSessionPool();
    const agent = createMockAcpAgent();
    const plan = grokDialect.buildSpawnPlan({ binaryPath: "/bin/grok", cwd: "/lane", baseEnv: {} });
    const first = await withDeadline(
      "acquire",
      pool.acquire({
        dialect: grokDialect,
        spawnPlan: plan,
        poolEnvKeys: grokDialect.poolEnvKeys,
        sessionToken: "chat-1",
        spawnOverride: () => agent.child,
      }),
    );
    const second = await withDeadline(
      "acquire again",
      pool.acquire({
        dialect: grokDialect,
        spawnPlan: plan,
        poolEnvKeys: grokDialect.poolEnvKeys,
        sessionToken: "chat-2",
        spawnOverride: () => agent.child,
      }),
    );
    expect(second.connection).toBe(first.connection);
    expect(pool.size()).toBe(1);
    pool.disposeAll("test finished");
  });

  it("never shares a qwen process between two sessions", async () => {
    const pool = createAcpSessionPool();
    const plan = qwenDialect.buildSpawnPlan({ binaryPath: "/bin/qwen", cwd: "/lane", baseEnv: {} });
    const agents = [createMockAcpAgent(), createMockAcpAgent()];
    let index = 0;
    const acquire = (sessionToken: string) =>
      pool.acquire({
        dialect: qwenDialect,
        spawnPlan: plan,
        poolEnvKeys: qwenDialect.poolEnvKeys,
        sessionToken,
        spawnOverride: () => agents[index++]!.child,
      });
    const first = await withDeadline("acquire", acquire("chat-1"));
    const second = await withDeadline("acquire again", acquire("chat-2"));
    expect(second.connection).not.toBe(first.connection);
    expect(pool.size()).toBe(2);
    pool.disposeAll("test finished");
  });

  it("keeps a released connection warm for the idle window", async () => {
    vi.useFakeTimers();
    const pool = createAcpSessionPool();
    const agent = createMockAcpAgent();
    const plan = grokDialect.buildSpawnPlan({ binaryPath: "/bin/grok", cwd: "/lane", baseEnv: {} });
    const acquired = pool.acquire({
      dialect: grokDialect,
      spawnPlan: plan,
      poolEnvKeys: grokDialect.poolEnvKeys,
      sessionToken: "chat-1",
      idleTtlMs: 5_000,
      spawnOverride: () => agent.child,
    });
    await vi.advanceTimersByTimeAsync(0);
    const lease = await acquired;
    lease.release();
    expect(pool.has(lease.poolKey)).toBe(true);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(pool.has(lease.poolKey)).toBe(true);
    await vi.advanceTimersByTimeAsync(2);
    expect(pool.has(lease.poolKey)).toBe(false);
    vi.useRealTimers();
  });

  it("ignores a release from a stale generation", async () => {
    const pool = createAcpSessionPool();
    const plan = grokDialect.buildSpawnPlan({ binaryPath: "/bin/grok", cwd: "/lane", baseEnv: {} });
    const agents = [createMockAcpAgent(), createMockAcpAgent()];
    let index = 0;
    const acquire = () =>
      pool.acquire({
        dialect: grokDialect,
        spawnPlan: plan,
        poolEnvKeys: grokDialect.poolEnvKeys,
        sessionToken: "chat-1",
        spawnOverride: () => agents[index++]!.child,
      });
    const first = await withDeadline("acquire", acquire());
    first.evict("simulated crash");
    const second = await withDeadline("acquire again", acquire());
    expect(second.generation).not.toBe(first.generation);
    // The stale lease must not tear down the replacement.
    first.release();
    expect(pool.has(second.poolKey)).toBe(true);
    pool.disposeAll("test finished");
  });

  it("drops a pool entry when its process exits", async () => {
    const pool = createAcpSessionPool();
    const agent = createMockAcpAgent();
    const plan = grokDialect.buildSpawnPlan({ binaryPath: "/bin/grok", cwd: "/lane", baseEnv: {} });
    const lease = await withDeadline(
      "acquire",
      pool.acquire({
        dialect: grokDialect,
        spawnPlan: plan,
        poolEnvKeys: grokDialect.poolEnvKeys,
        sessionToken: "chat-1",
        spawnOverride: () => agent.child,
      }),
    );
    agent.exit(3);
    await vi.waitFor(() => expect(pool.has(lease.poolKey)).toBe(false));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MCP injection
// ─────────────────────────────────────────────────────────────────────────────

describe("MCP injection", () => {
  it("drops an HTTP server when the agent did not advertise HTTP", async () => {
    const harness = makeHarness(qwenDialect, {
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: false, sse: false } },
    });
    await withDeadline(
      "open",
      harness.open({
        mcpServers: [
          { type: "http", name: "remote", url: "https://example.test", headers: [] },
          { name: "local", command: "/bin/server", args: [], env: [] },
        ],
      }),
    );
    const call = harness.agent.received.find((entry) => entry.method === ACP_METHOD.sessionNew);
    const servers = (call?.params as { mcpServers: Array<{ name: string }> }).mcpServers;
    expect(servers.map((server) => server.name)).toEqual(["local"]);
  });

  it("keeps an HTTP server when the agent advertised HTTP", async () => {
    const harness = makeHarness(qwenDialect, {
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: true } },
    });
    await withDeadline(
      "open",
      harness.open({ mcpServers: [{ type: "http", name: "remote", url: "https://example.test", headers: [] }] }),
    );
    const call = harness.agent.received.find((entry) => entry.method === ACP_METHOD.sessionNew);
    expect((call?.params as { mcpServers: unknown[] }).mcpServers).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The run | degrade matrix
// ─────────────────────────────────────────────────────────────────────────────

describe("run | degrade conformance matrix", () => {
  type Feature =
    | "capabilities"
    | "lifecycle"
    | "prompt_stream"
    | "permission"
    | "cancel"
    | "close_eviction"
    | "resume"
    | "slash_advertise"
    | "usage_fold"
    | "mcp_injection";

  const EXPECTED: Record<Feature, Record<AcpProviderId, "run" | "degrade">> = {
    capabilities: { qwen: "run", kimi: "run", grok: "run", copilot: "run" },
    lifecycle: { qwen: "run", kimi: "run", grok: "run", copilot: "run" },
    prompt_stream: { qwen: "run", kimi: "run", grok: "run", copilot: "run" },
    permission: { qwen: "run", kimi: "run", grok: "run", copilot: "run" },
    cancel: { qwen: "run", kimi: "run", grok: "run", copilot: "run" },
    // Qwen 0.22.3 has no session/close. It degrades to ending its private process.
    close_eviction: { qwen: "degrade", kimi: "run", grok: "run", copilot: "run" },
    // Copilot's resume is unverified, so ADE uses session/load instead.
    resume: { qwen: "run", kimi: "run", grok: "run", copilot: "degrade" },
    slash_advertise: { qwen: "run", kimi: "run", grok: "run", copilot: "run" },
    // Kimi reports no usage at all.
    usage_fold: { qwen: "run", kimi: "degrade", grok: "run", copilot: "run" },
    mcp_injection: { qwen: "run", kimi: "run", grok: "run", copilot: "run" },
  };

  it("records the expected outcome for every cell", () => {
    const cells = Object.values(EXPECTED).flatMap((row) => Object.values(row));
    expect(cells).toHaveLength(40);
  });

  it.each(ACP_PROVIDER_IDS)("%s matches its declared matrix row", (providerId: AcpProviderId) => {
    const dialect = acpDialectFor(providerId);
    expect(dialect.closeSession.declared ? "run" : "degrade").toBe(EXPECTED.close_eviction[providerId]);
    expect(dialect.resumeSession.declared ? "run" : "degrade").toBe(EXPECTED.resume[providerId]);
    expect(dialect.usage.declared ? "run" : "degrade").toBe(EXPECTED.usage_fold[providerId]);
    expect(dialect.mcpInjection.declared ? "run" : "degrade").toBe(EXPECTED.mcp_injection[providerId]);
  });

  it.each(ACP_PROVIDER_IDS)(
    "%s runs a whole turn without throwing and without hanging",
    async (providerId: AcpProviderId) => {
      const harness = makeHarness(acpDialectFor(providerId));
      harness.agent.on(ACP_METHOD.sessionPrompt, (_params, agent) => {
        agent.emitUpdate("session-1", {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "done" },
          messageId: "m1",
        });
        agent.emitUpdate("session-1", {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "explain", description: "Explain the change" }],
        });
        return { result: { stopReason: "end_turn" } };
      });
      harness.agent.on(ACP_METHOD.sessionCancel, () => ({ result: {} }));
      harness.agent.on(ACP_METHOD.sessionClose, () => ({ result: {} }));

      const session = await withDeadline("open", harness.open());
      const outcome = await withDeadline(
        "turn",
        session.prompt({ turnId: "turn-1", blocks: [textPromptBlock("hello")] as AcpContentBlock[] }),
      );
      expect(outcome.interrupted).toBe(false);
      await vi.waitFor(() =>
        expect(harness.events.some((event) => event.type === "text" && event.text === "done")).toBe(true),
      );
      expect(harness.slashLists).toHaveLength(1);
      await withDeadline("close", session.close("chat ended"));
    },
  );

  it.each(ACP_PROVIDER_IDS)(
    "%s degrades rather than hangs when the agent implements nothing but initialize",
    async (providerId: AcpProviderId) => {
      const dialect = acpDialectFor(providerId);
      const agent = createMockAcpAgent();
      // Deliberately no session/new handler, so it answers -32601.
      const pool = createAcpSessionPool();
      const attempt = openAcpSession({
        dialect,
        cwd: "/lane",
        spawnPlan: dialect.buildSpawnPlan({ binaryPath: "/bin/x", cwd: "/lane", baseEnv: {} }),
        sessionToken: "chat-1",
        pool,
        spawnOverride: () => agent.child,
        callbacks: {
          onEvents: () => undefined,
          onPermissionRequested: () => undefined,
          onPermissionSettled: () => undefined,
        },
      });
      await withDeadline("open failure", expect(attempt).rejects.toBeInstanceOf(AcpRpcError));
      await withDeadline(
        "error code",
        expect(attempt).rejects.toMatchObject({ code: ACP_RPC_METHOD_NOT_FOUND }),
      );
      pool.disposeAll("test finished");
    },
  );
});
