import fs from "node:fs";
import path from "node:path";
import type { createLaneService } from "./laneService";
import type { MacosVmPhaseNumber, MacosVmStatus } from "../../../shared/types/macosVm";
import { resolvePathWithinRoot } from "../shared/utils";

export type LaneLaunchExecStrategy = "local" | "ssh";

export type LaneLaunchSshTarget = {
  ip: string;
  username: string;
  vmName: string;
};

export type LaneLaunchContext = {
  laneWorktreePath: string;
  cwd: string;
  execStrategy: LaneLaunchExecStrategy;
  sshTarget?: LaneLaunchSshTarget;
};

/**
 * Thrown when a VM lane is launched but the singleton VM is not in
 * `runtime_ready`. Carries the current phase number + a stable code so the
 * renderer can react with the right CTA (e.g. "Open VM tab").
 */
export class VmNotReadyError extends Error {
  readonly code = "macos-vm-not-ready";
  readonly phase: MacosVmPhaseNumber | null;
  readonly readinessState: string | null;
  constructor(message: string, phase: MacosVmPhaseNumber | null, readinessState: string | null) {
    super(message);
    this.name = "VmNotReadyError";
    this.phase = phase;
    this.readinessState = readinessState;
  }
}

/**
 * Minimal projection of the macOS VM service surface used to compute a VM
 * launch context. Defined here (rather than imported directly) so this module
 * stays free of the macosVmService barrel and is trivially mockable in tests.
 */
export type MacosVmLaunchProvider = {
  getStatus: (args: { laneId?: string | null }) => Promise<MacosVmStatus>;
  getCredentials: (args: { vmName: string }) => Promise<{
    vmName: string;
    username: string | null;
    hasPassword: boolean;
  }>;
};

const GUEST_SHARED_CWD = "/Volumes/My Shared Files";

function ensureDirectoryExists(targetPath: string, message: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(targetPath);
  } catch {
    throw new Error(message);
  }
  if (!stat.isDirectory()) {
    throw new Error(message);
  }
  try {
    return fs.realpathSync(targetPath);
  } catch {
    throw new Error(message);
  }
}

export function resolveLaneLaunchContext(args: {
  laneService: ReturnType<typeof createLaneService>;
  laneId: string;
  requestedCwd?: string | null;
  allowExternalCwd?: boolean;
  purpose: string;
}): LaneLaunchContext {
  const laneId = String(args.laneId ?? "").trim();
  const purpose = args.purpose.trim() || "launch work";
  const lane = args.laneService.getLaneBaseAndBranch(laneId);

  if (lane.runtimePlacement === "macos-vm") {
    return resolveVmLaneLaunchContext({
      laneId,
      purpose,
      worktreePath: lane.worktreePath,
    });
  }

  const { worktreePath } = lane;
  const configuredRoot = typeof worktreePath === "string" ? worktreePath.trim() : "";
  if (!configuredRoot.length) {
    throw new Error(`Lane '${laneId}' has no worktree configured. ADE cannot ${purpose} outside the selected lane.`);
  }

  const unavailableMessage =
    `Lane '${laneId}' worktree is unavailable at '${configuredRoot}'. Restore or recreate the lane before trying to ${purpose}.`;
  const laneRoot = ensureDirectoryExists(path.resolve(configuredRoot), unavailableMessage);

  const requestedCwd = typeof args.requestedCwd === "string" ? args.requestedCwd.trim() : "";
  if (!requestedCwd.length) {
    return {
      laneWorktreePath: laneRoot,
      cwd: laneRoot,
      execStrategy: "local",
    };
  }

  if (args.allowExternalCwd === true && path.isAbsolute(requestedCwd)) {
    return {
      laneWorktreePath: laneRoot,
      cwd: ensureDirectoryExists(
        path.resolve(requestedCwd),
        `Requested cwd '${requestedCwd}' is not an existing directory.`,
      ),
      execStrategy: "local",
    };
  }

  const requestedTarget = path.isAbsolute(requestedCwd)
    ? requestedCwd
    : path.resolve(laneRoot, requestedCwd);

  let resolvedCwd: string;
  try {
    resolvedCwd = resolvePathWithinRoot(laneRoot, requestedTarget);
  } catch (error) {
    if (error instanceof Error && error.message === "Path escapes root") {
      throw new Error(
        `Requested cwd '${requestedCwd}' escapes lane '${laneId}'. ADE only launches work inside the selected lane worktree '${laneRoot}'.`,
      );
    }
    throw error;
  }

  ensureDirectoryExists(
    resolvedCwd,
    `Requested cwd '${requestedCwd}' is not an existing directory inside lane '${laneId}' worktree '${laneRoot}'.`,
  );

  return {
    laneWorktreePath: laneRoot,
    cwd: resolvedCwd,
    execStrategy: "local",
  };
}

/**
 * Pluggable provider used to look up the singleton VM's status + credentials
 * synchronously from the lane launch path. The Electron main process installs
 * a provider during bootstrap so `resolveLaneLaunchContext` can return an SSH
 * launch context for VM lanes. Tests can install a mock.
 */
let macosVmLaunchProvider: MacosVmLaunchProvider | null = null;

export function setMacosVmLaunchProvider(provider: MacosVmLaunchProvider | null): void {
  macosVmLaunchProvider = provider;
}

function pickActiveVmRecord(status: MacosVmStatus) {
  if (status.laneVm) return status.laneVm;
  return status.vms.find((vm) => vm.guestReadiness?.state === "runtime_ready") ?? status.vms[0] ?? null;
}

// VM lanes don't strictly require a host worktree dir to exist for SSH
// routing — the agent runs inside the guest — but we still surface the
// configured path for consumers (banner, transcripts).
function resolveVmLaneRootPath(laneId: string, worktreePath: string): string {
  const configured = typeof worktreePath === "string" ? worktreePath.trim() : "";
  if (!configured.length) return worktreePath ?? "";
  try {
    return ensureDirectoryExists(
      path.resolve(configured),
      `Lane '${laneId}' worktree is unavailable at '${configured}'.`,
    );
  } catch {
    return path.resolve(configured);
  }
}

function resolveVmLaneLaunchContext(args: {
  laneId: string;
  purpose: string;
  worktreePath: string;
}): LaneLaunchContext {
  const provider = macosVmLaunchProvider;
  const laneRoot = resolveVmLaneRootPath(args.laneId, args.worktreePath);

  if (!provider) {
    throw new VmNotReadyError(
      `Mac VM lane '${args.laneId}' cannot ${args.purpose}: macOS VM service is not initialized in this process.`,
      null,
      null,
    );
  }

  // The provider exposes async methods, but the lane launch context API is
  // synchronous. We deopt to throwing for now and require callers to prime
  // the provider state via the placement-changed event subscription.
  const cached = getCachedVmLaunchContextSync(args.laneId);
  if (!cached) {
    throw new VmNotReadyError(
      `Mac VM lane '${args.laneId}' cannot ${args.purpose}: VM status has not been fetched yet. Open the VM tab to start it.`,
      null,
      null,
    );
  }
  if (cached.kind === "not-ready") {
    throw new VmNotReadyError(
      `Mac VM lane '${args.laneId}' cannot ${args.purpose}: VM is not runtime-ready (${cached.readinessState ?? "unknown"}). Finish setup in the VM tab.`,
      cached.phase,
      cached.readinessState,
    );
  }

  return {
    laneWorktreePath: laneRoot,
    cwd: GUEST_SHARED_CWD,
    execStrategy: "ssh",
    sshTarget: cached.sshTarget,
  };
}

type CachedVmLaunchContext =
  | {
      kind: "ready";
      sshTarget: LaneLaunchSshTarget;
      cachedAt: number;
    }
  | {
      kind: "not-ready";
      readinessState: string | null;
      phase: MacosVmPhaseNumber | null;
      cachedAt: number;
    };

const vmLaunchContextCache = new Map<string, CachedVmLaunchContext>();
// Long TTL is intentional: the cached SSH target (IP + username + vmName) is
// stable for the lifetime of a running VM, and lifecycle events (start, stop,
// restart, placement-changed, deleted) drive explicit invalidation via
// `refreshVmLaneLaunchCache` / `invalidateVmLaneLaunchCache`. A short TTL was
// breaking every agent operation that started more than a few seconds after
// the cache was primed — agentChatService / ptyService call this sync helper
// on every turn, and there was no background refresh path.
const VM_LAUNCH_CONTEXT_TTL_MS = 30 * 60_000;

function getCachedVmLaunchContextSync(laneId: string): CachedVmLaunchContext | null {
  const entry = vmLaunchContextCache.get(laneId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > VM_LAUNCH_CONTEXT_TTL_MS) {
    vmLaunchContextCache.delete(laneId);
    return null;
  }
  return entry;
}

/**
 * Prime / refresh the VM launch cache for a lane. Should be called any time
 * the VM lifecycle phase advances (e.g. after a `vm-updated` or
 * `phase-changed` event) so the synchronous `resolveLaneLaunchContext` can
 * return up-to-date SSH targets.
 */
export async function refreshVmLaneLaunchCache(args: {
  laneId: string;
  provider?: MacosVmLaunchProvider | null;
}): Promise<CachedVmLaunchContext> {
  function cache(entry: CachedVmLaunchContext): CachedVmLaunchContext {
    vmLaunchContextCache.set(args.laneId, entry);
    return entry;
  }
  function notReady(
    readinessState: string | null,
    phase: MacosVmPhaseNumber | null,
  ): CachedVmLaunchContext {
    return cache({ kind: "not-ready", readinessState, phase, cachedAt: Date.now() });
  }

  const provider = args.provider ?? macosVmLaunchProvider;
  if (!provider) return notReady(null, null);

  const status = await provider.getStatus({ laneId: args.laneId });
  const record = pickActiveVmRecord(status);
  const readinessState = record?.guestReadiness?.state ?? null;
  const phase = record?.currentPhase ?? null;
  const ip = record?.ipAddress ?? null;
  const vmName = record?.name ?? null;

  if (!record || readinessState !== "runtime_ready" || !ip || !vmName) {
    return notReady(readinessState, phase);
  }

  const credentials = await provider.getCredentials({ vmName }).catch(() => null);
  const username = credentials?.username?.trim() ?? null;
  if (!credentials || !credentials.hasPassword || !username) {
    return notReady(readinessState, phase);
  }

  return cache({
    kind: "ready",
    sshTarget: { ip, username, vmName },
    cachedAt: Date.now(),
  });
}

export function invalidateVmLaneLaunchCache(laneId?: string): void {
  if (laneId) {
    vmLaunchContextCache.delete(laneId);
    return;
  }
  vmLaunchContextCache.clear();
}
