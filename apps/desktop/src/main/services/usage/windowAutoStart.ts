import os from "node:os";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { Logger } from "../logging/logger";
import type {
  ProviderInstance,
  ProviderInstanceProvider,
  ProviderInstanceSettings,
} from "../../../shared/types/providerInstances";
import { isBaseProviderInstance } from "../../../shared/types/providerInstances";
import type { UsageSnapshot, UsageWindow } from "../../../shared/types/usage";
import {
  getMachineProviderInstanceStore,
  providerInstanceEnvPatch,
} from "../../../../../ade-cli/src/services/providerInstances/providerInstanceStore";
import { resolveClaudeCodeExecutable } from "../ai/claudeCodeExecutable";
import { resolveCodexExecutable } from "../ai/codexExecutable";
import { resolveCliSpawnInvocation, terminateProcessTree } from "../shared/processExecution";
import { usageAccountId } from "./usageAccountId";

const AUTOSTART_DELAY_MS = 5_000;
const AUTOSTART_TIMEOUT_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const AUTOSTART_PROVIDERS: readonly ProviderInstanceProvider[] = ["claude", "codex"];

export type AutoStartTimerState = {
  provider: ProviderInstanceProvider;
  instanceId: string;
  resetsAt: string;
  dueAtMs: number;
};

export type WindowAutoStartDependencies = {
  logger: Logger;
  nowMs?: () => number;
  listInstances?: (provider: ProviderInstanceProvider) => readonly ProviderInstance[];
  getProviderSettings?: (provider: ProviderInstanceProvider) => ProviderInstanceSettings;
  spawn?: (command: string, args: string[], options?: SpawnOptions) => ChildProcess;
  resolveClaudeExecutable?: typeof resolveClaudeCodeExecutable;
  resolveCodexExecutable?: typeof resolveCodexExecutable;
  requestQuotaRefresh?: () => Promise<unknown> | unknown;
};

type AutoStartTimer = AutoStartTimerState & {
  configHome: string;
  isBase: boolean;
  resetAtMs: number;
  timer: ReturnType<typeof setTimeout>;
};

function findFiveHourWindow(
  snapshot: UsageSnapshot,
  provider: ProviderInstanceProvider,
  instance: ProviderInstance,
): UsageWindow | undefined {
  const accountId = usageAccountId({ provider, instanceId: instance.id });
  const account = snapshot.accounts?.find(
    (candidate) => candidate.provider === provider && candidate.instanceId === instance.id,
  );
  return snapshot.windows.find(
    (window) => window.provider === provider
      && window.windowType === "five_hour"
      && (window.accountId === accountId || (account?.id && window.accountId === account.id)),
  );
}

function clearTimer(timers: Map<string, AutoStartTimer>, key: string): void {
  const state = timers.get(key);
  if (!state) return;
  clearTimeout(state.timer);
  timers.delete(key);
}

export function createWindowAutoStartScheduler({
  logger,
  nowMs = Date.now,
  listInstances = (provider) => getMachineProviderInstanceStore().list(provider),
  getProviderSettings = (provider) => getMachineProviderInstanceStore().getProviderSettings(provider),
  spawn: spawnProcess = (command, args, options) => spawn(command, args, options ?? {}),
  resolveClaudeExecutable = resolveClaudeCodeExecutable,
  resolveCodexExecutable: resolveCodexExecutableFn = resolveCodexExecutable,
  requestQuotaRefresh,
}: WindowAutoStartDependencies) {
  const timers = new Map<string, AutoStartTimer>();
  let latestSnapshot: UsageSnapshot | null = null;
  let disposed = false;

  const arm = (provider: ProviderInstanceProvider, instance: ProviderInstance, window: UsageWindow): void => {
    const resetAtMs = Date.parse(window.resetsAt);
    if (!Number.isFinite(resetAtMs) || resetAtMs <= nowMs()) return;
    const key = usageAccountId({ provider, instanceId: instance.id });
    const dueAtMs = resetAtMs + AUTOSTART_DELAY_MS;
    const isBase = isBaseProviderInstance(instance);
    const existing = timers.get(key);
    if (existing
      && existing.resetAtMs === resetAtMs
      && existing.configHome === instance.configHome
      && existing.isBase === isBase) return;
    clearTimer(timers, key);
    const delayMs = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, dueAtMs - nowMs()));
    const timer = setTimeout(() => {
      void fire(key);
    }, delayMs);
    timer.unref?.();
    timers.set(key, {
      provider,
      instanceId: instance.id,
      resetsAt: window.resetsAt,
      dueAtMs,
      configHome: instance.configHome,
      isBase,
      resetAtMs,
      timer,
    });
  };

  const runRequest = async (state: AutoStartTimer): Promise<boolean> => {
    const env = {
      ...process.env,
      ...providerInstanceEnvPatch({
        id: state.instanceId,
        provider: state.provider,
        configHome: state.configHome,
      }),
    };
    const model = state.provider === "claude" ? "claude-haiku-4-5" : "gpt-5.6-luna";
    try {
      const resolved = state.provider === "claude"
        ? resolveClaudeExecutable({ env })
        : resolveCodexExecutableFn({ env });
      const args = state.provider === "claude"
        ? ["-p", "Reply with OK.", "--model", model, "--output-format", "text"]
        : ["exec", "-m", model, "--skip-git-repo-check", "Reply with OK."];
      const invocation = resolveCliSpawnInvocation(resolved.path, args, env);
      const options: SpawnOptions = {
        env,
        cwd: os.tmpdir(),
        stdio: "ignore",
        windowsHide: true,
        ...(invocation.windowsVerbatimArguments !== undefined
          ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
          : {}),
      };
      const child = spawnProcess(invocation.command, invocation.args, options);
      return await waitForChild(child);
    } catch {
      return false;
    }
  };

  const fire = async (key: string): Promise<void> => {
    const state = timers.get(key);
    if (!state || disposed) return;
    timers.delete(key);

    let instance: ProviderInstance | undefined;
    try {
      if (!getProviderSettings(state.provider).autoStartWindows) return;
      instance = listInstances(state.provider).find((candidate) => candidate.id === state.instanceId);
    } catch {
      return;
    }
    if (!instance) return;

    const now = nowMs();
    const currentWindow = latestSnapshot
      ? findFiveHourWindow(latestSnapshot, state.provider, {
        id: state.instanceId,
        provider: state.provider,
        label: "",
        configHome: state.configHome,
        isDefault: false,
        createdAt: "",
        signedIn: true,
      })
      : undefined;
    const currentResetAtMs = currentWindow ? Date.parse(currentWindow.resetsAt) : Number.NaN;
    if (Number.isFinite(currentResetAtMs) && currentResetAtMs > now) {
      if (instance) arm(state.provider, instance, currentWindow!);
      return;
    }

    const startedAt = nowMs();
    const runState = instance.configHome === state.configHome
      ? state
      : { ...state, configHome: instance.configHome };
    const ok = await runRequest(runState);
    const durationMs = Math.max(0, nowMs() - startedAt);
    const model = state.provider === "claude" ? "claude-haiku-4-5" : "gpt-5.6-luna";
    logger.info("usage.window_autostart", {
      provider: state.provider,
      instanceId: state.instanceId,
      model,
      ok,
      durationMs,
    });
    try {
      await requestQuotaRefresh?.();
    } catch (error) {
      logger.warn("usage.window_autostart_refresh_failed", {
        provider: state.provider,
        instanceId: state.instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  function onSnapshot(snapshot: UsageSnapshot): void {
    if (disposed) return;
    latestSnapshot = snapshot;
    const expected = new Set<string>();
    for (const provider of AUTOSTART_PROVIDERS) {
      let settings: ProviderInstanceSettings;
      let instances: readonly ProviderInstance[];
      try {
        settings = getProviderSettings(provider);
        instances = listInstances(provider);
      } catch {
        continue;
      }
      if (!settings.autoStartWindows) continue;
      for (const instance of instances) {
        const window = findFiveHourWindow(snapshot, provider, instance);
        if (!window) continue;
        const resetAtMs = Date.parse(window.resetsAt);
        if (!Number.isFinite(resetAtMs) || resetAtMs <= nowMs()) continue;
        const key = usageAccountId({ provider, instanceId: instance.id });
        expected.add(key);
        arm(provider, instance, window);
      }
    }
    for (const key of timers.keys()) {
      if (!expected.has(key)) clearTimer(timers, key);
    }
  }

  function getAutoStartState(): AutoStartTimerState[] {
    return [...timers.values()]
      .map(({ provider, instanceId, resetsAt, dueAtMs }) => ({ provider, instanceId, resetsAt, dueAtMs }))
      .sort((a, b) => `${a.provider}:${a.instanceId}`.localeCompare(`${b.provider}:${b.instanceId}`));
  }

  function dispose(): void {
    disposed = true;
    for (const key of timers.keys()) clearTimer(timers, key);
    latestSnapshot = null;
  }

  return { onSnapshot, getAutoStartState, dispose };
}

function waitForChild(child: ChildProcess): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      terminateProcessTree(child);
      finish(false);
    }, AUTOSTART_TIMEOUT_MS);
    timeout.unref?.();
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(ok);
    };
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

export const _testing = {
  AUTOSTART_DELAY_MS,
  AUTOSTART_TIMEOUT_MS,
  MAX_TIMER_DELAY_MS,
};
