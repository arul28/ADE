import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import type { Logger } from "../logging/logger";
import type { ProviderInstance } from "../../../shared/types/providerInstances";
import type { UsageSnapshot } from "../../../shared/types/usage";
import { createWindowAutoStartScheduler } from "./windowAutoStart";

const NOW = Date.parse("2026-09-18T12:00:00.000Z");

function instance(id: string, configHome = `/accounts/${id}`): ProviderInstance {
  return {
    id,
    provider: "claude",
    label: id,
    configHome,
    isDefault: id === "claude",
    createdAt: new Date(0).toISOString(),
    signedIn: true,
  };
}

function snapshot(
  resetsAt: string,
  provider: "claude" | "codex" = "claude",
  instanceId: string = provider,
): UsageSnapshot {
  return {
    windows: [{
      provider,
      windowType: "five_hour",
      accountId: `${provider}:${instanceId}`,
      percentUsed: 100,
      resetsAt,
      resetsInMs: Date.parse(resetsAt) - NOW,
    }],
    accounts: [{
      id: `${provider}:${instanceId}`,
      provider,
      instanceId,
      label: "Default",
      machines: [{ label: "test" }],
    }],
    pacing: {
      status: "on-track",
      projectedWeeklyPercent: 0,
      weekElapsedPercent: 0,
      expectedPercent: 0,
      deltaPercent: 0,
      etaHours: null,
      willLastToReset: true,
      resetsInHours: 1,
    },
    costs: [],
    extraUsage: [],
    lastPolledAt: new Date(NOW).toISOString(),
    errors: [],
  };
}

function childProcess(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => true),
    unref: vi.fn(),
  }) as unknown as ChildProcess;
}

function logger(): Pick<Logger, "info" | "warn"> {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("window auto-start", () => {
  beforeEach(() => { vi.useFakeTimers({ now: NOW }); });
  afterEach(() => { vi.useRealTimers(); });

  it("arms at resetsAt plus five seconds", () => {
    const resetAt = new Date(NOW + 60_000).toISOString();
    const log = logger();
    const scheduler = createWindowAutoStartScheduler({
      logger: log as Logger,
      nowMs: () => Date.now(),
      listInstances: () => [instance("claude")],
      getProviderSettings: () => ({ smartBalance: false, autoStartWindows: true }),
    });

    scheduler.onSnapshot(snapshot(resetAt));

    expect(scheduler.getAutoStartState()).toEqual([{
      provider: "claude",
      instanceId: "claude",
      resetsAt: resetAt,
      dueAtMs: NOW + 65_000,
    }]);
  });

  it("replaces an earlier timer when the provider reports a newer reset", () => {
    const firstReset = new Date(NOW + 60_000).toISOString();
    const secondReset = new Date(NOW + 120_000).toISOString();
    const scheduler = createWindowAutoStartScheduler({
      logger: logger() as Logger,
      listInstances: () => [instance("claude")],
      getProviderSettings: () => ({ smartBalance: false, autoStartWindows: true }),
    });

    scheduler.onSnapshot(snapshot(firstReset));
    scheduler.onSnapshot(snapshot(secondReset));

    expect(scheduler.getAutoStartState()).toEqual([{
      provider: "claude",
      instanceId: "claude",
      resetsAt: secondReset,
      dueAtMs: NOW + 125_000,
    }]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not arm while the setting is off", () => {
    const scheduler = createWindowAutoStartScheduler({
      logger: logger() as Logger,
      listInstances: () => [instance("claude")],
      getProviderSettings: () => ({ smartBalance: false, autoStartWindows: false }),
    });

    scheduler.onSnapshot(snapshot(new Date(NOW + 60_000).toISOString()));

    expect(scheduler.getAutoStartState()).toEqual([]);
  });

  it("re-arms exactly once per window across an off/on toggle", async () => {
    const resetAt = new Date(NOW + 60_000).toISOString();
    const child = childProcess();
    const spawn = vi.fn(() => child);
    let autoStartWindows = true;
    const scheduler = createWindowAutoStartScheduler({
      logger: logger() as Logger,
      listInstances: () => [instance("claude")],
      getProviderSettings: () => ({ smartBalance: false, autoStartWindows }),
      spawn,
      resolveClaudeExecutable: () => ({ path: "/bin/claude", source: "path" }) as never,
    });

    scheduler.onSnapshot(snapshot(resetAt));
    expect(vi.getTimerCount()).toBe(1);

    // Off: the next snapshot drops the timer rather than leaving one armed.
    autoStartWindows = false;
    scheduler.onSnapshot(snapshot(resetAt));
    expect(scheduler.getAutoStartState()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    // On again, same window: one timer, not two.
    autoStartWindows = true;
    scheduler.onSnapshot(snapshot(resetAt));
    scheduler.onSnapshot(snapshot(resetAt));
    expect(scheduler.getAutoStartState()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(65_000);
    child.emit("close", 0);
    await Promise.resolve();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(scheduler.getAutoStartState()).toEqual([]);
  });

  it("spawns the base Claude instance without overriding its inherited config home", async () => {
    const resetAt = new Date(NOW + 60_000).toISOString();
    const child = childProcess();
    const spawn = vi.fn(() => child);
    const resolveClaudeExecutable = vi.fn(() => ({ path: "/bin/claude", source: "path" as const }));
    const requestQuotaRefresh = vi.fn(async () => {});
    const log = logger();
    const scheduler = createWindowAutoStartScheduler({
      logger: log as Logger,
      listInstances: () => [instance("claude", "/accounts/default")],
      getProviderSettings: () => ({ smartBalance: false, autoStartWindows: true }),
      spawn,
      resolveClaudeExecutable,
      requestQuotaRefresh,
    });

    scheduler.onSnapshot(snapshot(resetAt));
    await vi.advanceTimersByTimeAsync(65_000);
    child.emit("close", 0);
    await vi.runAllTimersAsync();

    expect(spawn).toHaveBeenCalledWith(
      "/bin/claude",
      ["-p", "Reply with OK.", "--model", "claude-haiku-4-5", "--output-format", "text"],
      expect.objectContaining({
        cwd: expect.any(String),
        windowsHide: true,
        env: expect.not.objectContaining({ CLAUDE_CONFIG_DIR: "/accounts/default" }),
      }),
    );
    expect(resolveClaudeExecutable).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.not.objectContaining({ CLAUDE_CONFIG_DIR: "/accounts/default" }),
    }));
    expect(requestQuotaRefresh).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith("usage.window_autostart", expect.objectContaining({
      provider: "claude",
      instanceId: "claude",
      model: "claude-haiku-4-5",
      ok: true,
    }));
  });

  it("uses Codex exec and CODEX_HOME", async () => {
    const resetAt = new Date(NOW + 60_000).toISOString();
    const child = childProcess();
    const spawn = vi.fn(() => child);
    const resolveCodexExecutable = vi.fn(() => ({ path: "/bin/codex", source: "path" as const }));
    const scheduler = createWindowAutoStartScheduler({
      logger: logger() as Logger,
      listInstances: () => [{ ...instance("codex-work", "/accounts/codex"), provider: "codex", isDefault: false }],
      getProviderSettings: () => ({ smartBalance: false, autoStartWindows: true }),
      spawn,
      resolveCodexExecutable,
    });

    scheduler.onSnapshot(snapshot(resetAt, "codex", "codex-work"));
    await vi.advanceTimersByTimeAsync(65_000);
    child.emit("close", 0);
    await vi.runAllTimersAsync();

    expect(spawn).toHaveBeenCalledWith(
      "/bin/codex",
      ["exec", "-m", "gpt-5.6-luna", "--skip-git-repo-check", "Reply with OK."],
      expect.objectContaining({
        cwd: expect.any(String),
        windowsHide: true,
        env: expect.objectContaining({ CODEX_HOME: "/accounts/codex" }),
      }),
    );
  });

  it("does not arm an account with no five-hour window", () => {
    const scheduler = createWindowAutoStartScheduler({
      logger: logger() as Logger,
      listInstances: () => [instance("claude")],
      getProviderSettings: () => ({ smartBalance: false, autoStartWindows: true }),
    });

    scheduler.onSnapshot({ ...snapshot(new Date(NOW + 60_000).toISOString()), windows: [], accounts: [] });

    expect(scheduler.getAutoStartState()).toEqual([]);
  });
});
