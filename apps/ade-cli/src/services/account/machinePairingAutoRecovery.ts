import type { SyncAccountDirectoryHealth } from "../../../../desktop/src/shared/types";
import type { AccountMachinePairingRefusalCode } from "./accountMachinePublisherService";
import type { MachinePairingRepairResult } from "./machinePairingRepair";

/**
 * Automatic recovery from "this computer is not in your account any more".
 *
 * Both refusals the directory can answer with — `machine_revoked` and
 * `pairing_authentication_required` — are terminal for the heartbeat by design,
 * and until now terminal for the machine too: the ONLY way back was a human
 * finding the "Reconnect this computer" button. A machine whose session is
 * perfectly good and whose owner never removed it (a stale row, a key rotation,
 * a directory hiccup) therefore stayed silently disconnected forever.
 *
 * This runs that same repair on the machine's behalf, on a slow schedule, with
 * a budget that survives restarts. It deliberately does NOT widen what a repair
 * is allowed to do: it calls the identical brain action the button calls, so a
 * genuine removal is refused exactly as it is today and the user-facing state
 * is left untouched.
 */

/**
 * Delays from the start of a refusal episode. Slow on purpose: a repair sends a
 * deliberate pairing registration, and a machine the owner really did remove
 * must not be able to argue about it more than a handful of times a day.
 */
export const PAIRING_AUTO_REPAIR_DELAYS_MS = [60_000, 5 * 60_000, 60 * 60_000] as const;
/**
 * How long the publish leg may report `snapshot_failed` before one repair cycle
 * runs. Long enough that ordinary startup races (no sync scope yet, listener
 * still binding) settle on their own.
 */
export const PAIRING_AUTO_REPAIR_SNAPSHOT_GRACE_MS = 120_000;
const DEFAULT_POLL_MS = 15_000;

/** What put this machine into a recovery episode. */
export type MachinePairingAutoRecoveryTrigger = "refusal" | "snapshot_failed";

type AutoRecoveryLogger = {
  info?: (event: string, meta?: Record<string, unknown>) => void;
  warn?: (event: string, meta?: Record<string, unknown>) => void;
};

/** The slice of the account publisher this loop reads. Nothing is mutated here. */
export type MachinePairingAutoRecoveryPublisher = {
  getPublisherHealth(): SyncAccountDirectoryHealth;
  getMachineRevocation(): { revoked: boolean; revokedAt: string | null };
};

/** The persisted 6-hour allowance, shared with the identity file. */
export type MachinePairingAutoRecoveryBudget = {
  tryConsumePairingAutoRepair(): {
    allowed: boolean;
    countInWindow: number;
    limit: number;
  };
};

export type MachinePairingAutoRecoveryArgs = {
  /** Null while no publisher runs (this brain holds no sync host lease). */
  getPublisher: () => MachinePairingAutoRecoveryPublisher | null;
  runRepair: () => Promise<MachinePairingRepairResult>;
  /**
   * A repair without a session cannot succeed and would burn budget proving it,
   * so the loop simply waits for one.
   */
  hasAccountSession: () => boolean;
  budget: MachinePairingAutoRecoveryBudget;
  logger?: AutoRecoveryLogger;
  /** Test seams. */
  pollMs?: number;
  delaysMs?: readonly number[];
  snapshotGraceMs?: number;
  now?: () => number;
};

export type MachinePairingAutoRecoveryState = {
  trigger: MachinePairingAutoRecoveryTrigger | null;
  attempts: number;
  /** Budget exhausted or the episode ran its single allowed cycle. */
  settled: boolean;
  nextAttemptAtMs: number | null;
};

export type MachinePairingAutoRecovery = {
  start(): void;
  stop(): void;
  /** Run one evaluation immediately; exported for tests and for start(). */
  tick(): Promise<void>;
  getState(): MachinePairingAutoRecoveryState;
};

const REFUSAL_CODES: readonly string[] = [
  "machine_revoked",
  "pairing_authentication_required",
] satisfies readonly AccountMachinePairingRefusalCode[];

/**
 * Which refusal, if any, the last publish attempt ended in.
 *
 * Read from `lastHttpStatus` + `lastHttpReason`, which is where the publisher
 * already records the directory's machine-readable `code`. Nothing new has to
 * be plumbed through the publisher, and an unrecognised code stays unrecognised
 * rather than being guessed at.
 */
function refusalCodeFrom(
  health: SyncAccountDirectoryHealth,
): AccountMachinePairingRefusalCode | null {
  if (health.lastHttpStatus !== 403) return null;
  const reason = health.lastHttpReason;
  return typeof reason === "string" && REFUSAL_CODES.includes(reason)
    ? reason as AccountMachinePairingRefusalCode
    : null;
}

export function createMachinePairingAutoRecovery(
  args: MachinePairingAutoRecoveryArgs,
): MachinePairingAutoRecovery {
  const now = args.now ?? Date.now;
  const log = args.logger;
  const pollMs = Math.max(1_000, Math.floor(args.pollMs ?? DEFAULT_POLL_MS));
  const delays = args.delaysMs?.length ? args.delaysMs : PAIRING_AUTO_REPAIR_DELAYS_MS;
  const snapshotGraceMs = Math.max(0, args.snapshotGraceMs ?? PAIRING_AUTO_REPAIR_SNAPSHOT_GRACE_MS);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;
  let repairInFlight = false;
  let episode: {
    trigger: MachinePairingAutoRecoveryTrigger;
    attempts: number;
    nextAttemptAtMs: number;
    settled: boolean;
  } | null = null;

  const delayFor = (attempt: number): number =>
    delays[Math.min(attempt, delays.length - 1)] ?? delays[delays.length - 1] ?? DEFAULT_POLL_MS;

  const endEpisode = (reason: string): void => {
    if (!episode) return;
    const previous = episode;
    episode = null;
    log?.info?.("account.machine_auto_repair_episode_ended", {
      trigger: previous.trigger,
      attempts: previous.attempts,
      reason,
    });
  };

  const currentTrigger = (
    publisher: MachinePairingAutoRecoveryPublisher,
  ): { trigger: MachinePairingAutoRecoveryTrigger; code: string } | null => {
    const health = publisher.getPublisherHealth();
    const refusal = refusalCodeFrom(health);
    if (refusal && publisher.getMachineRevocation().revoked) {
      return { trigger: "refusal", code: refusal };
    }
    // The publish leg can also fail short of a refusal. A snapshot that cannot
    // be read for minutes on a signed-in machine is the same user-visible
    // "this computer isn't published yet" banner, and one repair cycle is
    // cheaper than leaving it there indefinitely.
    if (
      health.state === "snapshot_failed"
      && health.failingSinceMs != null
      && now() - health.failingSinceMs >= snapshotGraceMs
    ) {
      return { trigger: "snapshot_failed", code: "snapshot_failed" };
    }
    return null;
  };

  const runOneRepair = async (
    trigger: MachinePairingAutoRecoveryTrigger,
    code: string,
  ): Promise<void> => {
    const spend = args.budget.tryConsumePairingAutoRepair();
    if (!spend.allowed) {
      if (episode && !episode.settled) {
        episode.settled = true;
        // Deliberately quiet from here on. The user-facing state is whatever
        // the publisher already reports; the loop simply stops arguing.
        log?.warn?.("account.machine_auto_repair_budget_exhausted", {
          trigger,
          code,
          limit: spend.limit,
        });
      }
      return;
    }
    repairInFlight = true;
    let result: MachinePairingRepairResult | null = null;
    try {
      log?.info?.("account.machine_auto_repair_started", {
        trigger,
        code,
        attempt: (episode?.attempts ?? 0) + 1,
        repairsInWindow: spend.countInWindow,
      });
      result = await args.runRepair();
    } catch (error) {
      log?.warn?.("account.machine_auto_repair_error", {
        trigger,
        code,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      repairInFlight = false;
    }
    if (!episode) return;
    episode.attempts += 1;
    if (result?.repaired) {
      log?.info?.("account.machine_auto_repaired", {
        trigger,
        code,
        attempts: episode.attempts,
        pushRestored: result.pushRestored,
      });
      endEpisode("repaired");
      return;
    }
    log?.warn?.("account.machine_auto_repair_failed", {
      trigger,
      code,
      attempts: episode.attempts,
      state: result?.state ?? "error",
      reasonCode: result?.reasonCode ?? null,
    });
    if (trigger === "snapshot_failed") {
      // One cycle only: a publish leg that cannot read a snapshot is not a
      // pairing problem, and repeating the request will not make it one.
      episode.settled = true;
      return;
    }
    episode.nextAttemptAtMs = now() + delayFor(episode.attempts);
  };

  const tick = async (): Promise<void> => {
    // Deliberately not gated on `stopped`: the scheduler owns the lifecycle, and
    // an explicit tick (tests, a future "check now" action) must still evaluate.
    if (repairInFlight) return;
    const publisher = args.getPublisher();
    if (!publisher) {
      endEpisode("publisher_unavailable");
      return;
    }
    const observed = currentTrigger(publisher);
    if (!observed) {
      endEpisode("recovered");
      return;
    }
    if (!episode || episode.trigger !== observed.trigger) {
      episode = {
        trigger: observed.trigger,
        attempts: 0,
        nextAttemptAtMs: now() + delayFor(0),
        settled: false,
      };
      log?.info?.("account.machine_auto_repair_episode_started", {
        trigger: observed.trigger,
        code: observed.code,
        firstAttemptInMs: delayFor(0),
      });
      return;
    }
    if (episode.settled || now() < episode.nextAttemptAtMs) return;
    if (!args.hasAccountSession()) {
      // Not a failed attempt — nothing was sent — so the budget is untouched
      // and the schedule simply slips until a session exists.
      episode.nextAttemptAtMs = now() + delayFor(episode.attempts);
      return;
    }
    await runOneRepair(observed.trigger, observed.code);
  };

  const schedule = (): void => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      void tick().catch(() => {
        // A recovery loop must never take the brain down with it.
      }).finally(schedule);
    }, pollMs);
    timer.unref?.();
  };

  return {
    start(): void {
      if (!stopped) return;
      stopped = false;
      schedule();
    },
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      episode = null;
    },
    tick,
    getState(): MachinePairingAutoRecoveryState {
      return {
        trigger: episode?.trigger ?? null,
        attempts: episode?.attempts ?? 0,
        settled: episode?.settled ?? false,
        nextAttemptAtMs: episode?.nextAttemptAtMs ?? null,
      };
    },
  };
}
