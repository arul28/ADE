import path from "node:path";
import { randomUUID } from "node:crypto";
import { terminatePidGracefullyAsync } from "../../serviceManager/common";
import type {
  SyncHostConflictPublic,
  SyncHostOwnerKind,
  SyncHostReadinessSnapshot,
  SyncHostRecoveryResult,
  SyncHostRecoveryStep,
  SyncHostRecoveryStepId,
  SyncHostRecoveryStepStatus,
} from "../../../../desktop/src/shared/types/syncHostRecovery";
import {
  SYNC_HOST_CONFLICT_BODY,
  SYNC_HOST_CONFLICT_BODY_DEV,
  SYNC_HOST_CONFLICT_HEADLINE,
  SYNC_HOST_REDACTED_CONFLICT_DETAIL,
} from "../../../../desktop/src/shared/types/syncHostRecovery";
import {
  detectSyncHostSingletonConflict,
  defaultProcessMatchesOwner,
  holdsSyncHostSingleton,
  isSameChannelSyncHostOwner,
  type SyncHostSingletonConflict,
  type SyncHostSingletonOwner,
} from "./syncHostSingleton";

export type SyncHostRecoveryDeps = {
  /**
   * Takes the scan option so the caller, not the injected closure, decides
   * which of its calls pays for the native listener scan.
   */
  detectConflict?: (options: { skipListenerScan: boolean }) => SyncHostSingletonConflict | null;
  holdsLease?: () => boolean;
  pidAlive?: (pid: number) => boolean;
  processMatchesOwner?: (owner: SyncHostSingletonOwner) => boolean | null;
  terminatePid?: (pid: number, socketPath?: string | null) => Promise<void>;
  startSyncHost?: () => Promise<void>;
  restartBrain?: () => Promise<void> | void;
  prove?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  selfPid?: number;
  env?: NodeJS.ProcessEnv;
  waitMs?: number;
  /**
   * Skip the listener scan, which shells out to `lsof` or PowerShell
   * SYNCHRONOUSLY (a 15s budget on Windows). The lock check alone answers the
   * common "the host has not taken its lease yet" case, so the hello path and
   * the per-command failure path pass this; only an explicit diagnose request
   * and a repair's own first diagnosis pay for the full scan (a repair's wait
   * poll never does — see `runSyncHostRecovery`).
   */
  skipListenerScan?: boolean;
};

const operations = new Map<string, SyncHostRecoveryResult>();
const MAX_OPERATION_ID_LENGTH = 128;
let inFlight: Promise<SyncHostRecoveryResult> | null = null;
// Generous: a real repair stops a process, waits for the lease, and restarts a
// service. Short enough that a wedged dependency frees the next tap.
const DEFAULT_MAX_REPAIR_MS = 90_000;
let configured: SyncHostRecoveryDeps = {};

export function configureSyncHostRecovery(deps: SyncHostRecoveryDeps): void {
  configured = { ...configured, ...deps };
}

export function resetSyncHostRecoveryForTests(): void {
  operations.clear();
  configured = {};
  inFlight = null;
}

function defaultPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null | undefined)?.code === "EPERM";
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function classifySyncHostOwnerKind(owner: SyncHostSingletonOwner): SyncHostOwnerKind {
  // A Windows command line quotes every argument and uses backslashes, so a
  // POSIX matcher finds nothing in it (the same trap `looksLikeAdeWindowsSync
  // HostProcess` documents). Normalize once and match separator-agnostically,
  // or this whole classification degrades to "unknown" on Windows and the
  // recovery card stops naming the runtime it wants to stop.
  const raw = owner.commandLine ?? "";
  const command = raw.replace(/"/g, " ").replace(/\\/g, "/");
  if (
    /ade-cli\/(?:dist\/)?cli\.cjs\s+serve(?:\s|$)/i.test(command)
    || /\.ade\/worktrees/i.test(command)
    || /ade-remote-sim/i.test(command)
  ) {
    return "development";
  }
  if (
    /ADE(?: Beta| Alpha)?\.app\/Contents\/MacOS\/ADE/i.test(command)
    // Windows: the installer is per-user (`perMachine: false`), so a real
    // install lives under %LOCALAPPDATA%\Programs\ADE, not Program Files.
    // Keep the machine-wide path too for an admin-installed build.
    || /(?:Programs|Program Files(?: \(x86\))?)\/ADE(?: Beta| Alpha)?\//i.test(command)
    || /\/ADE(?: Beta| Alpha)?\.exe(?:\s|$)/i.test(command)
    // Linux: packaged installs and AppImage runs.
    || /\/opt\/ADE(?: Beta| Alpha)?\//i.test(command)
    || /ADE(?:[-_](?:Beta|Alpha))?[-_][0-9][^/\s]*\.AppImage/i.test(command)
    || (owner.serviceName != null && /com\.ade\.runtime/i.test(owner.serviceName))
  ) {
    return "installed";
  }
  return "unknown";
}

export function ownerLabelForKind(kind: SyncHostOwnerKind): string {
  switch (kind) {
    case "installed":
      return "Installed ADE";
    case "development":
      return "Development runtime";
    case "unknown":
      return "Another ADE runtime";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function projectLabel(projectRoot: string | null | undefined): string | null {
  const root = projectRoot?.trim();
  if (!root) return null;
  const base = path.basename(root);
  return base ? `${base} lane` : null;
}

function technicalDetail(owner: SyncHostSingletonOwner, reason: "lock" | "listener"): string {
  const lines = [
    `reason: ${reason}`,
    owner.pid ? `pid: ${owner.pid}` : null,
    owner.port != null ? `port: ${owner.port}` : null,
    owner.appName ? `app: ${owner.appName}` : null,
    owner.projectRoot ? `project: ${owner.projectRoot}` : null,
    owner.socketPath ? `socket: ${owner.socketPath}` : null,
    owner.commandLine ? `command: ${owner.commandLine}` : null,
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

export function publicConflictFromOwner(
  conflict: SyncHostSingletonConflict,
  env: NodeJS.ProcessEnv = process.env,
): SyncHostConflictPublic {
  const kind = classifySyncHostOwnerKind(conflict.owner);
  const label = projectLabel(conflict.owner.projectRoot);
  const hasStableProcessIdentity = Boolean(
    conflict.owner.processStartedAt
    && Number.isFinite(Date.parse(conflict.owner.processStartedAt)),
  );
  return {
    reason: conflict.reason,
    ownerKind: kind,
    ownerLabel: ownerLabelForKind(kind),
    projectLabel: label,
    impact: label ? `May interrupt ${label}.` : null,
    // A listener scan can identify ADE by command line but cannot establish
    // process birth identity. Keep diagnosis useful in that case, but do not
    // offer a destructive one-tap action without the PID-reuse guard that the
    // recovery flow requires.
    recoveryEligible: hasStableProcessIdentity
      && (kind === "development" || isSameChannelSyncHostOwner(conflict.owner, env)),
    technicalDetail: technicalDetail(conflict.owner, conflict.reason),
  };
}

export function diagnoseSyncHostReadiness(deps: SyncHostRecoveryDeps = {}): SyncHostReadinessSnapshot {
  const skipListenerScan = deps.skipListenerScan ?? configured.skipListenerScan ?? false;
  const detect = deps.detectConflict
    ?? configured.detectConflict
    ?? detectSyncHostSingletonConflict;
  const holds = deps.holdsLease ?? configured.holdsLease ?? holdsSyncHostSingleton;
  const env = deps.env ?? configured.env ?? process.env;
  const conflict = detect({ skipListenerScan });
  if (conflict) {
    const publicConflict = publicConflictFromOwner(conflict, env);
    const isDev = publicConflict.ownerKind === "development";
    return {
      state: "conflict",
      headline: SYNC_HOST_CONFLICT_HEADLINE,
      body: isDev ? SYNC_HOST_CONFLICT_BODY_DEV : SYNC_HOST_CONFLICT_BODY,
      conflict: publicConflict,
      recoveryEligible: publicConflict.recoveryEligible,
    };
  }
  if (holds()) {
    return {
      state: "ready",
      headline: "Connected",
      body: "This machine's project connection is ready.",
      conflict: null,
      recoveryEligible: false,
    };
  }
  return {
    state: "starting",
    headline: "Starting this machine",
    body: "This machine is still starting its project connection.",
    conflict: null,
    recoveryEligible: true,
  };
}

/**
 * The brain can tell an authenticated but unprivileged peer that its project
 * host is unavailable without disclosing PID, socket, command-line, or lane
 * information. Recovery callers receive the full snapshot only after the
 * server has checked their pairing grant.
 */
export function redactSyncHostReadinessSnapshot(
  snapshot: SyncHostReadinessSnapshot,
  canManageRuntime: boolean,
): SyncHostReadinessSnapshot {
  if (canManageRuntime || !snapshot.conflict) {
    return canManageRuntime ? snapshot : { ...snapshot, recoveryEligible: false };
  }
  return {
    ...snapshot,
    headline: SYNC_HOST_CONFLICT_HEADLINE,
    body: SYNC_HOST_CONFLICT_BODY,
    recoveryEligible: false,
    conflict: {
      ...snapshot.conflict,
      ownerKind: "unknown",
      ownerLabel: "Another ADE runtime",
      projectLabel: null,
      impact: null,
      recoveryEligible: false,
      technicalDetail: SYNC_HOST_REDACTED_CONFLICT_DETAIL,
    },
  };
}

function step(
  id: SyncHostRecoveryStepId,
  status: SyncHostRecoveryStepStatus,
  detail?: string,
): SyncHostRecoveryStep {
  return { id, status, ...(detail ? { detail } : {}) };
}

/**
 * The id comes from a remote device, so it is bounded on both length and count:
 * this brain outlives many phones, and an unbounded map keyed by caller input
 * is a slow leak. Oldest-first eviction is right — a replayed id older than the
 * last few repairs deserves a fresh diagnosis, not a cached verdict.
 */
const MAX_TRACKED_OPERATIONS = 32;

function store(result: SyncHostRecoveryResult): SyncHostRecoveryResult {
  operations.delete(result.operationId);
  operations.set(result.operationId, result);
  while (operations.size > MAX_TRACKED_OPERATIONS) {
    const oldest = operations.keys().next();
    if (oldest.done) break;
    operations.delete(oldest.value);
  }
  return result;
}

function sameOwner(
  previous: SyncHostSingletonOwner,
  next: SyncHostSingletonOwner,
): boolean {
  if (previous.pid !== next.pid) return false;
  // A PID by itself is not an identity. Listener-scan owners from older
  // releases may not have either stable field, so refuse to treat two such
  // observations as the same process rather than risking a PID-reuse stop.
  if (!previous.processStartedAt || !next.processStartedAt) return false;
  return previous.processStartedAt === next.processStartedAt;
}

/**
 * Two devices — or one device reconnecting mid-repair — must not open two
 * stop/restart sequences against the same machine. A second caller joins the
 * running repair and sees its outcome.
 */
export function recoverSyncHostConnection(
  args: { operationId?: string; maxRepairMs?: number } & SyncHostRecoveryDeps = {},
): Promise<SyncHostRecoveryResult> {
  if (!inFlight) {
    const run = runSyncHostRecovery(args);
    inFlight = run;
    // The latch tracks the REAL work, never the deadline race below.
    // `Promise.race` only chooses which promise supplies the answer; it does
    // not cancel `runSyncHostRecovery`. Releasing the latch when the deadline
    // wins would let the next caller open a SECOND stop/restart sequence while
    // the first is still inside `terminatePid`/`startSyncHost`/`restartBrain`.
    // A rejection releases it too, and is swallowed here only so this
    // bookkeeping handler never becomes the unhandled one — every caller still
    // receives the rejection through `raceWithDeadline`.
    void run.then(
      () => {
        if (inFlight === run) inFlight = null;
      },
      () => {
        if (inFlight === run) inFlight = null;
      },
    );
  }
  // `startSyncHost`, `restartBrain` and `prove` are injected closures with no
  // deadline of their own. If one never settles, an unbounded join would hang
  // every later tap from every device. Each caller gets its own bound and an
  // honest answer when the repair overruns, while the repair itself keeps
  // running under the latch until it actually settles.
  return raceWithDeadline(inFlight, Math.max(1_000, args.maxRepairMs ?? DEFAULT_MAX_REPAIR_MS), args);
}

function raceWithDeadline(
  work: Promise<SyncHostRecoveryResult>,
  deadlineMs: number,
  args: SyncHostRecoveryDeps,
): Promise<SyncHostRecoveryResult> {
  // A real timer, never the injectable `sleep`: that one is the step-poll hook
  // and tests stub it to resolve immediately, which would make every repair
  // report a timeout. Unref'd so a pending deadline cannot hold the brain open.
  let deadlineTimer: NodeJS.Timeout | null = null;
  const deadline = new Promise<SyncHostRecoveryResult>((resolve) => {
    deadlineTimer = setTimeout(() => {
      resolve({
        operationId: "",
        ok: false,
        status: "failed",
        snapshot: diagnoseSyncHostReadiness({ ...configured, ...args }),
        steps: [],
        message: "Fixing the connection took too long. Try again.",
      });
    }, deadlineMs);
    deadlineTimer.unref?.();
  });
  return Promise.race([work, deadline]).finally(() => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  });
}

async function runSyncHostRecovery(
  args: { operationId?: string } & SyncHostRecoveryDeps = {},
): Promise<SyncHostRecoveryResult> {
  const deps: SyncHostRecoveryDeps = { ...configured, ...args };
  // A caller-supplied id is untrusted input. Cap it so it cannot be used to
  // grow the map with long keys, and ignore anything longer rather than
  // truncating two distinct ids into one.
  const rawId = args.operationId?.trim();
  const existingId = rawId && rawId.length <= MAX_OPERATION_ID_LENGTH ? rawId : undefined;
  if (existingId) {
    const existing = operations.get(existingId);
    // An in-flight repair is joined, never restarted: a second tap must not
    // open a second stop/restart sequence against the same machine.
    if (existing && (existing.status === "running" || existing.status === "restarting")) {
      return existing;
    }
  }

  const operationId = existingId || randomUUID();
  const detect = deps.detectConflict ?? detectSyncHostSingletonConflict;
  // The listener scan spawns `lsof` — or, on Windows, a full-machine
  // `Get-NetTCPConnection` + `Get-CimInstance` on a 15s budget — SYNCHRONOUSLY
  // on the brain's event loop. It is the only way to see a blocker holding the
  // port without a lock file, so the diagnosis and the pre-kill identity
  // recheck pay for it. The wait poll below asks the narrower "has the conflict
  // cleared yet", which the lock check answers on its own.
  const scanOptions = { skipListenerScan: deps.skipListenerScan ?? false };
  const lockOnlyOptions = { skipListenerScan: true };
  const holds = deps.holdsLease ?? holdsSyncHostSingleton;
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  const processMatchesOwner = deps.processMatchesOwner
    ?? ((owner) => defaultProcessMatchesOwner(owner));
  const terminatePid = deps.terminatePid ?? (async (pid, socketPath) => {
    await terminatePidGracefullyAsync(pid, { runtimeSocketPath: socketPath ?? null });
  });
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const selfPid = deps.selfPid ?? process.pid;
  const waitMs = deps.waitMs ?? 8_000;

  const steps: SyncHostRecoveryStep[] = [
    step("diagnose", "active"),
    step("stop", "pending"),
    step("wait", "pending"),
    step("start", "pending"),
    step("restart", "pending"),
    step("prove", "pending"),
  ];

  const setStep = (id: SyncHostRecoveryStepId, status: SyncHostRecoveryStepStatus, detail?: string) => {
    const index = steps.findIndex((entry) => entry.id === id);
    if (index >= 0) steps[index] = step(id, status, detail);
  };

  // One observation, used twice: it decides whether there is anything to stop,
  // and the same conflict becomes the client-facing snapshot. Detecting twice
  // would pay for a second listener scan and could disagree with itself.
  const firstConflict = detect(scanOptions);
  const snapshot0 = diagnoseSyncHostReadiness({ ...deps, detectConflict: () => firstConflict });
  let result: SyncHostRecoveryResult = store({
    operationId,
    ok: false,
    status: "running",
    snapshot: snapshot0,
    steps,
    message: snapshot0.body,
  });

  const finish = (
    status: SyncHostRecoveryResult["status"],
    ok: boolean,
    message: string,
    snapshot: SyncHostReadinessSnapshot,
  ): SyncHostRecoveryResult => {
    result = store({
      operationId,
      ok,
      status,
      snapshot,
      steps: [...steps],
      message,
    });
    return result;
  };

  /**
   * Every way the stop can legitimately not happen, in one place. The first
   * identity check rejects a dead or already-replaced owner; the recheck
   * immediately before the kill closes the PID-reuse window that opens while
   * eligibility is decided. Both are load-bearing: dropping the first turns a
   * dead-owner skip into an ineligible failure.
   */
  const stopBlockingOwner = async (
    conflict: SyncHostSingletonConflict,
  ): Promise<{
    status: SyncHostRecoveryStepStatus;
    detail?: string;
    abort?: "ineligible" | "stop_failed";
  }> => {
    const owner = conflict.owner;
    if (owner.pid === selfPid) {
      return { status: "skipped", detail: "Would have targeted this brain." };
    }
    if (!pidAlive(owner.pid) || processMatchesOwner(owner) !== true) {
      return { status: "skipped", detail: "Owner identity changed before stop." };
    }
    if (!publicConflictFromOwner(conflict, deps.env).recoveryEligible) {
      return {
        status: "skipped",
        detail: "This conflict is not eligible for one-tap stop.",
        abort: "ineligible",
      };
    }
    const rechecked = detect(scanOptions);
    if (
      !rechecked
      || processMatchesOwner(rechecked.owner) !== true
      || !sameOwner(owner, rechecked.owner)
    ) {
      return { status: "skipped", detail: "Owner identity changed before stop." };
    }
    if (rechecked.owner.pid === selfPid) {
      return { status: "skipped", detail: "Would have targeted this brain." };
    }
    try {
      await terminatePid(rechecked.owner.pid, rechecked.owner.socketPath);
      return { status: "done" };
    } catch (error) {
      return {
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
        abort: "stop_failed",
      };
    }
  };

  setStep("diagnose", "done");

  if (firstConflict) {
    const outcome = await stopBlockingOwner(firstConflict);
    setStep("stop", outcome.status, outcome.detail);
    if (outcome.abort === "ineligible") {
      return finish("failed", false, snapshot0.body, snapshot0);
    }
    if (outcome.abort === "stop_failed") {
      return finish(
        "failed",
        false,
        "Couldn't stop the blocking runtime.",
        diagnoseSyncHostReadiness(deps),
      );
    }
  } else {
    setStep("stop", "skipped");
  }

  setStep("wait", "active");
  const deadline = now() + waitMs;
  while (now() < deadline) {
    if (!detect(lockOnlyOptions) && holds()) break;
    await sleep(250);
  }
  setStep("wait", "done");

  if (!holds()) {
    setStep("start", "active");
    if (deps.startSyncHost) {
      try {
        await deps.startSyncHost();
        setStep("start", "done");
      } catch (error) {
        setStep("start", "failed", error instanceof Error ? error.message : String(error));
      }
    } else {
      setStep("start", "skipped");
    }
  } else {
    setStep("start", "skipped");
  }

  // Deliberately NOT gated on a still-detectable conflict. The blocker was
  // just stopped, so `detect()` is normally null by now; requiring it here
  // skipped the restart exactly when `startSyncHost` had failed or returned
  // without the lease — leaving the machine with neither runtime.
  if (!holds()) {
    setStep("restart", "active");
    if (deps.restartBrain) {
      try {
        await deps.restartBrain();
        setStep("restart", "done");
        return finish(
          "restarting",
          false,
          "Restarting this machine's ADE brain. Reconnect if this screen drops.",
          diagnoseSyncHostReadiness(deps),
        );
      } catch (error) {
        setStep("restart", "failed", error instanceof Error ? error.message : String(error));
      }
    } else {
      setStep("restart", "skipped");
    }
  } else {
    setStep("restart", "skipped");
  }

  setStep("prove", "active");
  let proved = holds();
  if (deps.prove) {
    try {
      proved = await deps.prove();
    } catch {
      proved = false;
    }
  }
  const snapshot = diagnoseSyncHostReadiness(deps);
  if (proved && snapshot.state === "ready") {
    setStep("prove", "done");
    return finish("succeeded", true, "Project connection is ready.", snapshot);
  }
  setStep("prove", "failed");
  return finish("failed", false, snapshot.body, snapshot);
}

export function hostUnavailableErrorPayload(snapshot: SyncHostReadinessSnapshot): {
  code: "host_unavailable";
  message: string;
  reason: "conflict" | "starting" | "unavailable";
  conflict: SyncHostConflictPublic | null;
  recoveryEligible: boolean;
  snapshot: SyncHostReadinessSnapshot;
} {
  const reason = snapshot.state === "conflict"
    ? "conflict"
    : snapshot.state === "starting"
      ? "starting"
      : "unavailable";
  return {
    code: "host_unavailable",
    message: snapshot.body,
    reason,
    conflict: snapshot.conflict,
    recoveryEligible: snapshot.recoveryEligible,
    snapshot,
  };
}
