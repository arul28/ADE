/**
 * Live handshake against installed ACP binaries, through ADE's own host.
 *
 * Skipped unless ACP_LIVE_PROBE=1. CI has no credentials and must not spawn
 * vendor CLIs. The verification brief runs this locally.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentChatEvent } from "../../../../shared/types";
import { resolveAcpExecutable } from "../../ai/acpExecutables";
import { isAcpAuthError } from "../../ai/acpAuthProbe";
import { loadQwenUserSettings } from "../../ai/qwenUserSettings";
import { copilotConfigHome, qwenConfigHome } from "../../shared/providerConfigHomes";
import { copilotDialect, grokDialect, kimiDialect, qwenDialect } from "./acpDialects";
import { createAcpConnection, initializeAcpConnection } from "./acpConnection";
import { ACP_METHOD } from "./acpProtocolTypes";
import { openAcpSession, textPromptBlock, type AcpSession } from "./acpSession";
import { createAcpSessionPool } from "./acpSessionPool";

const LIVE = process.env.ACP_LIVE_PROBE === "1";
const LIVE_DEADLINE_MS = 45_000;
const cwd = process.cwd();

const pools: Array<{ disposeAll: (reason: string) => void }> = [];
const sessions: AcpSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.close("live test teardown").catch(() => undefined);
  }
  for (const pool of pools.splice(0)) pool.disposeAll("live test teardown");
});

async function withDeadline<T>(label: string, promise: Promise<T>, ms = LIVE_DEADLINE_MS): Promise<T> {
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

describe.skipIf(!LIVE)("ACP host live handshake", () => {
  it("opens a Copilot session through ADE's host without deadlocking on trust", async () => {
    const executable = resolveAcpExecutable("copilot");
    expect(executable.source).not.toBe("fallback-command");
    const pool = createAcpSessionPool();
    pools.push(pool);
    const dialect = copilotDialect;
    const spawnPlan = dialect.buildSpawnPlan({
      binaryPath: executable.path,
      cwd,
      baseEnv: process.env,
      configHome: copilotConfigHome(),
    });
    const session = await withDeadline(
      "copilot open",
      openAcpSession({
        dialect,
        cwd,
        spawnPlan,
        sessionToken: "live-copilot",
        pool,
        callbacks: {
          onEvents: () => undefined,
          onPermissionRequested: (pending) => pending.cancel(),
          onPermissionSettled: () => undefined,
        },
      }),
    );
    sessions.push(session);
    expect(session.sessionId.length).toBeGreaterThan(0);
    expect(session.connection.initializeResult?.agentCapabilities?.loadSession).toBe(true);
    expect(session.connection.isAlive()).toBe(true);
  });

  it("opens a Grok session through ADE's host and stamps permission-mode on spawn", async () => {
    const executable = resolveAcpExecutable("grok");
    expect(executable.source).not.toBe("fallback-command");
    const pool = createAcpSessionPool();
    pools.push(pool);
    const dialect = grokDialect;
    const spawnPlan = dialect.buildSpawnPlan({
      binaryPath: executable.path,
      cwd,
      baseEnv: process.env,
      permissionMode: "default",
    });
    expect(spawnPlan.args).toEqual(expect.arrayContaining(["--permission-mode", "default"]));
    const session = await withDeadline(
      "grok open",
      openAcpSession({
        dialect,
        cwd,
        spawnPlan,
        sessionToken: "live-grok",
        pool,
        callbacks: {
          onEvents: () => undefined,
          onPermissionRequested: (pending) => pending.cancel(),
          onPermissionSettled: () => undefined,
        },
      }),
    );
    sessions.push(session);
    expect(session.sessionId.length).toBeGreaterThan(0);
    expect(session.connection.initializeResult?.agentCapabilities?.sessionCapabilities).toMatchObject({
      resume: {},
      close: {},
    });
  });

  it("runs a Copilot ping through ADE's host from a tiny cwd", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ade-acp-live-copilot-"));
    writeFileSync(path.join(tmp, "README.md"), "probe\n");
    try {
      const executable = resolveAcpExecutable("copilot");
      const pool = createAcpSessionPool();
      pools.push(pool);
      const events: AgentChatEvent[] = [];
      const spawnPlan = copilotDialect.buildSpawnPlan({
        binaryPath: executable.path,
        cwd: tmp,
        baseEnv: process.env,
        configHome: copilotConfigHome(),
      });
      const session = await withDeadline(
        "copilot open tiny",
        openAcpSession({
          dialect: copilotDialect,
          cwd: tmp,
          spawnPlan,
          sessionToken: "live-copilot-ping",
          pool,
          callbacks: {
            onEvents: (batch) => events.push(...batch),
            onPermissionRequested: (pending) => pending.cancel(),
            onPermissionSettled: () => undefined,
          },
        }),
      );
      sessions.push(session);
      const outcome = await withDeadline(
        "copilot ping",
        session.prompt({
          turnId: "live-ping",
          blocks: [textPromptBlock("Reply with exactly the word ping and nothing else. Do not use tools.")],
        }),
        60_000,
      );
      expect(outcome.stopReason).toBe("end_turn");
      expect(events.some((event) => event.type === "text" && event.text.toLowerCase().includes("ping"))).toBe(true);
      expect(outcome.usage?.inputTokens).toBeGreaterThan(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("qwen initialize works without auth; session/new is the re-login card", async () => {
    const executable = resolveAcpExecutable("qwen");
    expect(executable.source).not.toBe("fallback-command");
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ade-acp-live-qwen-"));
    const configHome = path.join(tmp, "qwen-home");
    const fakeHome = path.join(tmp, "home");
    mkdirSync(configHome, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env, QWEN_HOME: configHome, HOME: fakeHome };
    delete env.OPENAI_API_KEY;
    delete env.DASHSCOPE_API_KEY;
    delete env.QWEN_API_KEY;
    const spawnPlan = qwenDialect.buildSpawnPlan({
      binaryPath: executable.path,
      cwd: tmp,
      baseEnv: env,
      configHome,
    });
    const connection = createAcpConnection({ dialect: qwenDialect, spawnPlan });
    try {
      const { response } = await withDeadline(
        "qwen initialize",
        initializeAcpConnection({ connection, dialect: qwenDialect }),
      );
      expect(response.agentCapabilities?.loadSession).toBe(true);
      expect(response.agentCapabilities?.sessionCapabilities).not.toHaveProperty("close");
      expect(response.authMethods?.map((method) => method.id)).toEqual(["openai"]);
      await expect(
        connection.request(ACP_METHOD.sessionNew, { cwd: tmp, mcpServers: [] }),
      ).rejects.toSatisfy((error: unknown) => isAcpAuthError(error));
    } finally {
      connection.dispose("live qwen unauth");
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("kimi initialize works without auth; session/new is the re-login card", async () => {
    const executable = resolveAcpExecutable("kimi");
    expect(executable.source).not.toBe("fallback-command");
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ade-acp-live-kimi-"));
    const configHome = path.join(tmp, "kimi-home");
    const fakeHome = path.join(tmp, "home");
    mkdirSync(configHome, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      KIMI_CODE_HOME: configHome,
      HOME: fakeHome,
      PATH: `${path.join(os.homedir(), ".kimi-code", "bin")}:${process.env.PATH ?? ""}`,
    };
    delete env.MOONSHOT_API_KEY;
    delete env.KIMI_API_KEY;
    const spawnPlan = kimiDialect.buildSpawnPlan({
      binaryPath: executable.path,
      cwd: tmp,
      baseEnv: env,
      configHome,
    });
    const connection = createAcpConnection({ dialect: kimiDialect, spawnPlan });
    try {
      const { response } = await withDeadline(
        "kimi initialize",
        initializeAcpConnection({ connection, dialect: kimiDialect }),
      );
      expect(response.agentCapabilities?.sessionCapabilities).toMatchObject({
        list: {},
        resume: {},
        close: {},
      });
      expect(response.authMethods?.[0]).toMatchObject({ id: "login", type: "terminal" });
      await expect(
        connection.request(ACP_METHOD.sessionNew, { cwd: tmp, mcpServers: [] }),
      ).rejects.toSatisfy((error: unknown) => isAcpAuthError(error));
    } finally {
      connection.dispose("live kimi unauth");
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("runs a Qwen ping through ADE's host with this machine's Qwen settings", async () => {
    const executable = resolveAcpExecutable("qwen");
    expect(executable.source).not.toBe("fallback-command");
    const settings = await loadQwenUserSettings();
    expect(settings.authenticated).toBe(true);
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ade-acp-live-qwen-auth-"));
    writeFileSync(path.join(tmp, "README.md"), "probe\n");
    try {
      const events: AgentChatEvent[] = [];
      const pool = createAcpSessionPool();
      pools.push(pool);
      const spawnPlan = qwenDialect.buildSpawnPlan({
        binaryPath: executable.path,
        cwd: tmp,
        baseEnv: process.env,
        configHome: qwenConfigHome(),
      });
      const session = await withDeadline(
        "qwen open",
        openAcpSession({
          dialect: qwenDialect,
          cwd: tmp,
          spawnPlan,
          sessionToken: "live-qwen-ping",
          pool,
          callbacks: {
            onEvents: (batch) => events.push(...batch),
            onPermissionRequested: (pending) => pending.cancel(),
            onPermissionSettled: () => undefined,
          },
        }),
        60_000,
      );
      sessions.push(session);
      expect(session.sessionId.length).toBeGreaterThan(0);
      if (settings.defaultModelId) {
        await session.setConfigOption({ configId: "model", value: settings.defaultModelId });
      }
      const outcome = await withDeadline(
        "qwen ping",
        session.prompt({
          turnId: "live-qwen-ping",
          blocks: [textPromptBlock("Reply with exactly the word ping and nothing else. Do not use tools.")],
        }),
        90_000,
      );
      expect(outcome.stopReason).toBe("end_turn");
      expect(events.some((event) => event.type === "text" && event.text.toLowerCase().includes("ping"))).toBe(true);
      expect(
        settings.models.some((model) => model.id === settings.defaultModelId)
        || Boolean(settings.defaultModelId),
      ).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
