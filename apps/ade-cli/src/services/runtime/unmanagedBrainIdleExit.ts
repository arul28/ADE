import fs from "node:fs";
import { isTruthyEnvFlag } from "../../../../desktop/src/shared/doNotTrack";
import { isAdoptableAdeHome } from "../projects/machineLayout";
import { DEV_TEST_MACHINE_ENV } from "../sync/devTestMachine";

/**
 * Dev and test brains leave once nobody runs them and they sit idle.
 *
 * A brain started by a launcher on an ephemeral socket exits after
 * `ADE_RUNTIME_IDLE_EXIT_MS` (the CLI sets it); a desktop's brain exits with
 * its parent (`ADE_RUNTIME_PARENT_PID`); the installed service brain is
 * restarted by its service manager and never idles out. A brain a dev or
 * test launcher started (a dev machine's, a dev desktop's) had nothing to
 * end it once its launcher was gone, and the emulators it started ran on
 * with it.
 *
 * Such a brain now exits after `UNMANAGED_BRAIN_IDLE_EXIT_MS` with nothing to
 * do, once its parent is gone. Its emulators stop on the way out: a brain on
 * a home that does not adopt does not hand them off.
 *
 * Only a brain its launcher marked: `ADE_DEV_BRAIN=1` (`scripts/dev-shared.mjs`,
 * `scripts/dev-machine.mjs`), `--dev-test-machine` (`ADE_DEV_TEST_MACHINE`),
 * or the dev launcher's own socket variable. A brain on a custom home that
 * nothing marked (`nohup ade serve`, cron, a cloud box) runs until stopped.
 *
 * Never for, even when marked: the installed app's ADE home (`~/.ade`,
 * `~/.ade-alpha`), a brain its service manager started (launchd's job label
 * in `XPC_SERVICE_NAME`, a systemd unit's `INVOCATION_ID`, the Windows
 * supervisor's pid record), a desktop's brain, or a brain with any explicit
 * `ADE_RUNTIME_IDLE_EXIT_MS` (that setting, `0` included, is the caller's
 * answer).
 */

/** How long a brain nobody manages may sit with nothing to do. */
export const UNMANAGED_BRAIN_IDLE_EXIT_MS = 30 * 60_000;
/** How often it checks; well under the limit, and a cheap check. */
const CHECK_EVERY_MS = 60_000;

export type UnmanagedBrainFacts = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  adeHome: string;
  /** The runtime service's name (`com.ade.runtime`): launchd puts the job label in `XPC_SERVICE_NAME`. */
  serviceName: string;
  /** Windows: the supervisor's pid record names this brain's parent. Null when unknown. */
  windowsSupervised: boolean | null;
};

/** Whether a service manager started this brain: then it is managed, and restarted rather than idled out. */
export function startedByServiceManager(facts: Pick<UnmanagedBrainFacts, "env" | "platform" | "serviceName" | "windowsSupervised">): boolean {
  if (facts.platform === "darwin") {
    const label = facts.env.XPC_SERVICE_NAME?.trim() ?? "";
    // Every ADE channel's job label starts with the stable one (`com.ade.runtime.alpha`).
    return label !== "" && label !== "0" && (label === facts.serviceName || label.startsWith("com.ade."));
  }
  // Set for every process a systemd unit starts. A shell inside a terminal
  // that systemd runs as a unit inherits it too, so such a brain reads as
  // managed and is left alone: the safe side.
  if (facts.platform === "linux") return Boolean(facts.env.INVOCATION_ID?.trim());
  // No readable supervisor record reads as not supervised: a supervised
  // brain's parent is the supervisor, alive, so it is never orphaned anyway.
  if (facts.platform === "win32") return facts.windowsSupervised === true;
  return true;
}

/** Whether a dev or test launcher marked this brain as its own. */
export function startedByDevLauncher(env: NodeJS.ProcessEnv): boolean {
  return isTruthyEnvFlag(env.ADE_DEV_BRAIN)
    || env[DEV_TEST_MACHINE_ENV] === "1"
    || Boolean(env.ADE_DEV_RUNTIME_SOCKET_PATH?.trim());
}

/** The idle limit for this brain, or null when something else manages its life. */
export function unmanagedBrainIdleExitMs(facts: UnmanagedBrainFacts): number | null {
  if (!startedByDevLauncher(facts.env)) return null;
  if (facts.env.ADE_RUNTIME_IDLE_EXIT_MS !== undefined) return null;
  if (facts.env.ADE_RUNTIME_PARENT_PID?.trim()) return null;
  if (isAdoptableAdeHome(facts.adeHome)) return null;
  if (startedByServiceManager(facts)) return null;
  return UNMANAGED_BRAIN_IDLE_EXIT_MS;
}

/**
 * Whether the process that started this brain is gone: reparented to
 * launchd or init (pid 1), to a Linux subreaper (`systemd --user`), or a
 * parent pid that no longer runs (Windows does not reparent).
 */
export function isOrphanedProcess(args: {
  ppid: number;
  platform: NodeJS.Platform;
  isPidAlive: (pid: number) => boolean;
  readParentName?: (pid: number) => string | null;
}): boolean {
  if (args.ppid <= 1) return true;
  if (!args.isPidAlive(args.ppid)) return true;
  if (args.platform === "linux") return (args.readParentName ?? readLinuxProcessName)(args.ppid) === "systemd";
  return false;
}

function readLinuxProcessName(pid: number): string | null {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Calls `onIdle` once the brain has been orphaned and idle (`isBusy` false)
 * for `idleExitMs` in a row. Any busy check, or a parent that is back,
 * restarts the clock. The timer is unref'd. Returns the stop.
 */
export function monitorUnmanagedBrainIdleExit(args: {
  idleExitMs: number | null;
  isOrphaned: () => boolean;
  isBusy: () => Promise<boolean>;
  onIdle: (idleMs: number) => void;
  now?: () => number;
  checkEveryMs?: number;
}): () => void {
  if (args.idleExitMs == null) return () => {};
  const idleExitMs = args.idleExitMs;
  const now = args.now ?? Date.now;
  let quietSince = now();
  let stopped = false;
  let checking = false;
  const check = async () => {
    if (stopped || checking) return;
    checking = true;
    try {
      const busy = !args.isOrphaned() || await args.isBusy().catch(() => true);
      if (stopped) return;
      if (busy) {
        quietSince = now();
        return;
      }
      if (now() - quietSince >= idleExitMs) {
        stopped = true;
        clearInterval(timer);
        args.onIdle(now() - quietSince);
      }
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => void check(), args.checkEveryMs ?? Math.min(CHECK_EVERY_MS, Math.max(1_000, Math.floor(idleExitMs / 4))));
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
