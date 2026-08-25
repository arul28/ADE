/**
 * The desktop → brain suspend hop.
 *
 * The account-directory publisher lives in the brain, which is plain Node and
 * therefore never learns a machine is suspending until it is already back (its
 * only native signal is a heartbeat tick that arrived minutes late). The
 * desktop main process DOES get the OS's pre-suspend beat. This bridge carries
 * it across, so the directory records "asleep" while the machine can still say
 * so — which is what lets a phone show "Asleep" with confidence instead of
 * inferring it from silence.
 *
 * Two rules govern everything here:
 *
 *  - It must never delay suspend. The forward is fire-and-forget from the
 *    OS's point of view; the OS hands control back immediately.
 *  - It must be bounded. The pre-suspend window is short and unspecified, so a
 *    hop that hangs is worse than one that gives up.
 *
 * The brain does not depend on this existing. A Linux host has no ADE desktop
 * app at all, and falls back to the gap detector with no loss of correctness —
 * only of precision.
 */

import type {
  MachinePowerEvent,
  MachinePowerSource,
} from "../../../../../ade-cli/src/services/power/machinePowerMonitor";

/** Matches the publisher's own pre-suspend write budget. */
export const MACHINE_POWER_HOP_BUDGET_MS = 2_000;

/**
 * How many times the RESUME hop is attempted.
 *
 * The two halves are not symmetric. A lost suspend costs precision — the gap
 * detector still notices the sleep on the way out. A lost RESUME costs
 * correctness: nothing else clears an announced `asleep` for a nap shorter than
 * the detector's 60-second threshold, so the brain stays pinned asleep, holds
 * every later network failure as "Paused — computer asleep", and reports the
 * next sleep's length as the time since the first one. And the resume hop is
 * the likeliest of the two to fail: it rides a socket that is by definition
 * mid-reconnect a beat after the machine woke, on a two-second budget.
 *
 * So the resume retries and the suspend does not — a suspend that waited on a
 * retry would delay the very thing this file must never delay.
 */
export const MACHINE_POWER_RESUME_HOP_ATTEMPTS = 4;

/** Base backoff between resume attempts; each attempt waits one more step. */
export const MACHINE_POWER_RESUME_HOP_RETRY_MS = 750;

export type MachinePowerTransitionReport = (input: {
  kind: "suspend" | "resume";
  budgetMs: number;
}) => Promise<unknown>;

export type MachinePowerBrainBridgeOptions = {
  powerSource: Pick<MachinePowerSource, "subscribe">;
  /** Sends the transition to the brain. Expected to be an RPC call. */
  report: MachinePowerTransitionReport;
  budgetMs?: number;
  /** Overrides `MACHINE_POWER_RESUME_HOP_ATTEMPTS`. Tests only. */
  resumeAttempts?: number;
  /** Overrides `MACHINE_POWER_RESUME_HOP_RETRY_MS`. Tests only. */
  resumeRetryMs?: number;
  logger?: {
    debug?(message: string, meta?: Record<string, unknown>): void;
    warn?(message: string, meta?: Record<string, unknown>): void;
  };
};

export type MachinePowerBrainBridge = {
  dispose(): void;
  /**
   * The most recent hop, settled or in flight. Nothing in production awaits
   * it — a suspend that waited on a network call would be the bug this file
   * exists to avoid — but a test needs something to hold on to.
   */
  lastHop(): Promise<void> | null;
};

export function createMachinePowerBrainBridge(
  options: MachinePowerBrainBridgeOptions,
): MachinePowerBrainBridge {
  const budgetMs = Math.max(250, Math.floor(options.budgetMs ?? MACHINE_POWER_HOP_BUDGET_MS));
  const resumeAttempts = Math.max(
    1,
    Math.floor(options.resumeAttempts ?? MACHINE_POWER_RESUME_HOP_ATTEMPTS),
  );
  const resumeRetryMs = Math.max(
    0,
    Math.floor(options.resumeRetryMs ?? MACHINE_POWER_RESUME_HOP_RETRY_MS),
  );
  let disposed = false;
  let pending: Promise<void> | null = null;
  /**
   * Which forward is the current one.
   *
   * A resume loop can stay alive for roughly 12 seconds — four attempts on a
   * two-second budget plus 750/1500/2250 ms of backoff — which is more than long
   * enough for the user to shut the lid inside it. Without this, that stale loop
   * keeps going and its next attempt delivers `resume` AFTER the suspend, so the
   * brain writes `awake` and publishes it as the machine goes dark: the phone
   * shows Connected to a sleeping Mac and chat retries stop being held, which is
   * verbatim the bug this file exists to remove. Every forward — including a
   * suspend — bumps this, so a superseded loop stops at its next checkpoint.
   */
  let generation = 0;

  /**
   * Did the brain say it actually carried the announcement?
   *
   * `machine.reportPowerTransition` answers `{accepted}`; a brain with no
   * account-directory publisher answers `{accepted: false, reason}`. A reply
   * that fulfilled but refused is NOT a delivery — treating it as one is what
   * let an unpersisted suspend look landed. Anything else (an older brain that
   * answered nothing, or a shape we do not recognise) counts as delivered, so a
   * version skew cannot turn every hop into a retry storm.
   */
  const acceptedByBrain = (value: unknown): boolean =>
    !(typeof value === "object" && value !== null
      && (value as { accepted?: unknown }).accepted === false);

  const refusalReason = (value: unknown): string | null =>
    typeof value === "object" && value !== null
      && typeof (value as { reason?: unknown }).reason === "string"
      ? (value as { reason: string }).reason
      : null;

  /** One bounded attempt. Resolves true only when the brain actually answered. */
  const attempt = (kind: "suspend" | "resume"): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (delivered: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        timer = null;
        resolve(delivered);
      };
      timer = setTimeout(() => {
        options.logger?.debug?.("power.brain_hop_timed_out", { kind, budgetMs });
        finish(false);
      }, budgetMs);
      timer.unref?.();
      let call: Promise<unknown>;
      try {
        call = options.report({ kind, budgetMs });
      } catch (error) {
        // A brain that is not running yet, or a pool mid-reconnect, is an
        // expected miss on this path — the gap detector still covers it.
        options.logger?.debug?.("power.brain_hop_failed", {
          kind,
          error: error instanceof Error ? error.message : String(error),
        });
        finish(false);
        return;
      }
      void call.then((value: unknown) => {
        if (!acceptedByBrain(value)) {
          options.logger?.debug?.("power.brain_hop_refused", {
            kind,
            reason: refusalReason(value),
          });
          finish(false);
          return;
        }
        finish(true);
      }, (error: unknown) => {
        options.logger?.debug?.("power.brain_hop_failed", {
          kind,
          error: error instanceof Error ? error.message : String(error),
        });
        finish(false);
      });
    });
  };

  const wait = (ms: number): Promise<void> => new Promise<void>((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });

  const forward = (kind: "suspend" | "resume"): void => {
    if (disposed) return;
    generation += 1;
    const myGeneration = generation;
    const superseded = (): boolean => disposed || generation !== myGeneration;
    const attempts = kind === "resume" ? resumeAttempts : 1;
    const run = async (): Promise<void> => {
      for (let index = 0; index < attempts; index += 1) {
        if (superseded()) return;
        if (await attempt(kind)) return;
        if (index + 1 >= attempts) break;
        await wait(resumeRetryMs * (index + 1));
      }
      if (superseded()) return;
      if (attempts > 1) {
        // Worth a warning rather than a debug line: the brain is now holding a
        // sleep state nothing else will clear until the next 60s-plus gap.
        options.logger?.warn?.("power.brain_hop_gave_up", { kind, attempts });
      }
    };
    pending = run();
  };

  const unsubscribe = options.powerSource.subscribe((event: MachinePowerEvent) => {
    if (event.kind === "suspend") forward("suspend");
    else if (event.kind === "resume") forward("resume");
    // Battery and wall-power changes ride the brain's own poll; forwarding
    // them would add directory writes for something no client shows live.
  });

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
    },
    lastHop: () => pending,
  };
}
