import os from "node:os";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { Logger } from "../logging/logger";
import type {
  ProviderInstance,
  ProviderInstanceProvider,
  ProviderInstanceSettings,
} from "../../../shared/types/providerInstances";
import {
  AUTOSTART_WINDOW_TYPE,
  isBaseProviderInstance,
  PROVIDER_INSTANCE_PROVIDERS,
} from "../../../shared/types/providerInstances";
import type { UsageSnapshot, UsageWindow } from "../../../shared/types/usage";
import {
  getMachineProviderInstanceStore,
  providerInstanceEnvPatch,
} from "../../../../../ade-cli/src/services/providerInstances/providerInstanceStore";
import { resolveClaudeCodeExecutable } from "../ai/claudeCodeExecutable";
import { resolveCodexExecutable } from "../ai/codexExecutable";
import { resolveCliSpawnInvocation, terminateProcessTree } from "../shared/processExecution";
import {
  BACKGROUND_UTILITY_CLAUDE_CLI_MODEL,
  BACKGROUND_UTILITY_CLAUDE_REASONING_EFFORT,
  BACKGROUND_UTILITY_CODEX_CLI_MODEL,
  BACKGROUND_UTILITY_CODEX_REASONING_EFFORT,
  claudeBackgroundUtilityFlags,
  codexStandardSpeedFlags,
} from "../../../shared/backgroundUtilityModel";
import { usageAccountId } from "./usageAccountId";

const AUTOSTART_DELAY_MS = 5_000;
const AUTOSTART_TIMEOUT_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/**
 * How far a reported reset may drift from the armed one and still be the same
 * window. A five-hour window's end is fixed once it opens, so a reset that
 * moved by more than this means the provider ended the window early.
 */
const RESET_DRIFT_SLACK_MS = 2 * 60_000;
/**
 * At most one early start per account in this span, so a provider that keeps
 * reporting an idle window (or a request that keeps failing) cannot turn every
 * poll into another CLI launch.
 */
const EARLY_START_COOLDOWN_MS = 15 * 60_000;

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
  /** Fires because the window ended before `resetAtMs`, not at it. */
  early: boolean;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * How ADE opens a provider's window: the cheapest request that counts — lowest
 * effort, standard speed, no tools or MCP setup, nothing saved. Unpinned, Codex
 * runs at config.toml's effort and service tier.
 */
type WindowOpener = {
  model: string;
  resolveExecutable: (env: NodeJS.ProcessEnv) => { path: string };
  args: (model: string) => string[];
};

/** Every window of this account in the snapshot. */
function accountWindows(
  snapshot: UsageSnapshot,
  provider: ProviderInstanceProvider,
  instanceId: string,
): UsageWindow[] {
  const accountId = usageAccountId({ provider, instanceId });
  const account = snapshot.accounts?.find(
    (candidate) => candidate.provider === provider && candidate.instanceId === instanceId,
  );
  return snapshot.windows.filter(
    (window) => window.provider === provider
      && (window.accountId === accountId || (account?.id && window.accountId === account.id)),
  );
}

/** The account's window that auto-start watches (`AUTOSTART_WINDOW_TYPE`). */
function findAutoStartWindow(
  snapshot: UsageSnapshot,
  provider: ProviderInstanceProvider,
  instanceId: string,
): UsageWindow | undefined {
  const windowType = AUTOSTART_WINDOW_TYPE[provider];
  if (!windowType) return undefined;
  return accountWindows(snapshot, provider, instanceId).find((window) => window.windowType === windowType);
}

/**
 * Whether the window armed to end at `armedResetAtMs` has already ended, read
 * from a fresh snapshot of the same account. Providers hand out resets early
 * (Codex does it at random, and both Claude and Codex let a banked reset be
 * spent): the five-hour window then disappears, loses its reset time, or comes
 * back unused with a different end.
 */
function windowEndedEarly(window: UsageWindow | undefined, armedResetAtMs: number): boolean {
  if (!window) return true;
  const resetAtMs = Date.parse(window.resetsAt);
  if (!Number.isFinite(resetAtMs)) return true;
  if (Math.abs(resetAtMs - armedResetAtMs) <= RESET_DRIFT_SLACK_MS) return false;
  return window.percentUsed === 0;
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
  const openers: Partial<Record<ProviderInstanceProvider, WindowOpener>> = {
    claude: {
      model: BACKGROUND_UTILITY_CLAUDE_CLI_MODEL,
      resolveExecutable: (env) => resolveClaudeExecutable({ env }),
      args: (model) => ["-p", "Reply with OK.", "--model", model, "--effort", BACKGROUND_UTILITY_CLAUDE_REASONING_EFFORT,
        "--output-format", "text", ...claudeBackgroundUtilityFlags(), "--no-session-persistence"],
    },
    codex: {
      model: BACKGROUND_UTILITY_CODEX_CLI_MODEL,
      resolveExecutable: (env) => resolveCodexExecutableFn({ env }),
      args: (model) => ["exec", "-m", model, "-c", `model_reasoning_effort=${BACKGROUND_UTILITY_CODEX_REASONING_EFFORT}`,
        ...codexStandardSpeedFlags(), "--ephemeral", "--skip-git-repo-check", "Reply with OK."],
    },
  };
  // A provider takes part only with both a window to watch and a way to open it.
  const autoStartProviders = PROVIDER_INSTANCE_PROVIDERS
    .filter((provider) => AUTOSTART_WINDOW_TYPE[provider] && openers[provider]);
  const timers = new Map<string, AutoStartTimer>();
  const lastEarlyStartAtMs = new Map<string, number>();
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
      && !existing.early
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
      early: false,
      timer,
    });
  };

  /**
   * Start the account's next window now, because the one it was waiting on
   * ended early. `armedResetAtMs` is the end the ended window had, so the fire
   * can tell that window apart from a new one somebody already opened.
   */
  const armEarly = (provider: ProviderInstanceProvider, instance: ProviderInstance, armedResetAtMs: number): void => {
    const key = usageAccountId({ provider, instanceId: instance.id });
    const existing = timers.get(key);
    if (existing?.early) return;
    const lastEarly = lastEarlyStartAtMs.get(key);
    if (lastEarly !== undefined && nowMs() - lastEarly < EARLY_START_COOLDOWN_MS) return;
    clearTimer(timers, key);
    const dueAtMs = nowMs() + AUTOSTART_DELAY_MS;
    const timer = setTimeout(() => {
      void fire(key);
    }, AUTOSTART_DELAY_MS);
    timer.unref?.();
    timers.set(key, {
      provider,
      instanceId: instance.id,
      resetsAt: Number.isFinite(armedResetAtMs) ? new Date(armedResetAtMs).toISOString() : "",
      dueAtMs,
      configHome: instance.configHome,
      isBase: isBaseProviderInstance(instance),
      resetAtMs: armedResetAtMs,
      early: true,
      timer,
    });
  };

  const runRequest = async (state: AutoStartTimer, opener: WindowOpener): Promise<boolean> => {
    const env = {
      ...process.env,
      ...providerInstanceEnvPatch({
        id: state.instanceId,
        provider: state.provider,
        configHome: state.configHome,
      }),
    };
    try {
      const resolved = opener.resolveExecutable(env);
      const invocation = resolveCliSpawnInvocation(resolved.path, opener.args(opener.model), env);
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
      ? findAutoStartWindow(latestSnapshot, state.provider, state.instanceId)
      : undefined;
    const currentResetAtMs = currentWindow ? Date.parse(currentWindow.resetsAt) : Number.NaN;
    // A window that is open now was opened by someone else (or the provider
    // moved the reset): follow it instead of sending a request. An early start
    // only stands down for a window other than the one that ended.
    const windowIsOpen = Number.isFinite(currentResetAtMs) && currentResetAtMs > now;
    const isEndedWindow = Number.isFinite(state.resetAtMs)
      && Math.abs(currentResetAtMs - state.resetAtMs) <= RESET_DRIFT_SLACK_MS;
    const newWindowInUse = windowIsOpen && !isEndedWindow && (currentWindow?.percentUsed ?? 0) > 0;
    if (state.early ? newWindowInUse : windowIsOpen) {
      arm(state.provider, instance, currentWindow!);
      return;
    }
    if (state.early) lastEarlyStartAtMs.set(key, now);

    const opener = openers[state.provider];
    if (!opener) return;
    const startedAt = nowMs();
    const runState = instance.configHome === state.configHome
      ? state
      : { ...state, configHome: instance.configHome };
    const ok = await runRequest(runState, opener);
    const durationMs = Math.max(0, nowMs() - startedAt);
    logger.info("usage.window_autostart", {
      provider: state.provider,
      instanceId: state.instanceId,
      model: opener.model,
      ok,
      early: state.early,
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
    for (const provider of autoStartProviders) {
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
        const key = usageAccountId({ provider, instanceId: instance.id });
        const existing = timers.get(key);
        const window = findAutoStartWindow(snapshot, provider, instance.id);
        if (existing && accountWindows(snapshot, provider, instance.id).length === 0) {
          // No reading for this account at all says nothing about its window;
          // keep waiting for the reset already armed.
          expected.add(key);
          continue;
        }
        // An early start is already on its way, or the armed reset has passed
        // and the timer is in its last few seconds: a poll in between must not
        // cancel it. The fire itself checks whether a window opened meanwhile.
        if (existing && (existing.early || existing.resetAtMs <= nowMs())) {
          expected.add(key);
          continue;
        }
        if (existing
          && existing.resetAtMs > nowMs()
          && windowEndedEarly(window, existing.resetAtMs)) {
          armEarly(provider, instance, existing.resetAtMs);
          if (timers.get(key)?.early) {
            expected.add(key);
            continue;
          }
        }
        if (!window) continue;
        const resetAtMs = Date.parse(window.resetsAt);
        if (!Number.isFinite(resetAtMs) || resetAtMs <= nowMs()) continue;
        expected.add(key);
        arm(provider, instance, window);
      }
    }
    for (const key of timers.keys()) {
      if (!expected.has(key)) clearTimer(timers, key);
    }
  }

  /**
   * The account's five-hour window was just reset on purpose (a banked reset
   * spent through ADE). Start the next one without waiting for a poll to
   * notice the window is gone.
   */
  function onWindowReset(accountId: string): void {
    if (disposed) return;
    for (const provider of autoStartProviders) {
      try {
        if (!getProviderSettings(provider).autoStartWindows) continue;
        const instance = listInstances(provider)
          .find((candidate) => usageAccountId({ provider, instanceId: candidate.id }) === accountId);
        if (!instance) continue;
        const window = latestSnapshot ? findAutoStartWindow(latestSnapshot, provider, instance.id) : undefined;
        lastEarlyStartAtMs.delete(accountId);
        armEarly(provider, instance, window ? Date.parse(window.resetsAt) : Number.NaN);
      } catch {
        // Settings or the account list could not be read; the next poll retries.
      }
      return;
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
    lastEarlyStartAtMs.clear();
    latestSnapshot = null;
  }

  return { onSnapshot, onWindowReset, getAutoStartState, dispose };
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
  EARLY_START_COOLDOWN_MS,
};
