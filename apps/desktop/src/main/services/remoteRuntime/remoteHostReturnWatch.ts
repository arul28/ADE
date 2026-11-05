/**
 * The timers behind "bring a dropped link back when the machine is back".
 * This file only schedules: one watch per target id, a first redial almost at
 * once, the next ones at whatever delay the owner asks for, and a hard stop
 * after the watch window. What a redial is, what its failure means and what
 * the status says are the owner's calls, made through the callbacks.
 */

export type HostReturnWatchCallbacks = {
  /** One redial. Resolves when the machine is back; rejects when the dial failed. */
  attempt(targetId: string): Promise<void>;
  /**
   * The dial failed and the watch is still current. Returns the delay before
   * the next one, or null to stop watching (the owner has already said why).
   */
  onAttemptFailed(targetId: string, error: unknown, attempts: number): number | null;
  /** The watch window ran out. The watch is already stopped. */
  onExpired(targetId: string): void;
};

export type HostReturnWatchTiming = {
  firstAttemptMs: number;
  watchMs: number;
};

type Watch = {
  startedAt: number;
  attempts: number;
  timer: NodeJS.Timeout | null;
};

export class HostReturnWatches {
  private readonly byTargetId = new Map<string, Watch>();

  constructor(
    private readonly callbacks: HostReturnWatchCallbacks,
    private readonly timing: HostReturnWatchTiming,
  ) {}

  has(targetId: string): boolean {
    return this.byTargetId.has(targetId);
  }

  /** Starts (or restarts) the redials for a dropped link. */
  start(targetId: string): void {
    this.stop(targetId);
    const watch: Watch = { startedAt: Date.now(), attempts: 0, timer: null };
    this.byTargetId.set(targetId, watch);
    this.schedule(targetId, watch, this.timing.firstAttemptMs);
  }

  stop(targetId: string): void {
    const watch = this.byTargetId.get(targetId);
    if (!watch) return;
    this.byTargetId.delete(targetId);
    if (watch.timer) clearTimeout(watch.timer);
    watch.timer = null;
  }

  stopAll(): void {
    for (const targetId of [...this.byTargetId.keys()]) this.stop(targetId);
  }

  private schedule(targetId: string, watch: Watch, delayMs: number): void {
    if (this.byTargetId.get(targetId) !== watch) return;
    const remainingMs = watch.startedAt + this.timing.watchMs - Date.now();
    if (remainingMs <= 0) {
      this.stop(targetId);
      this.callbacks.onExpired(targetId);
      return;
    }
    watch.timer = setTimeout(() => {
      watch.timer = null;
      void this.run(targetId, watch);
    }, Math.max(0, Math.min(delayMs, remainingMs)));
    // Never keeps the app alive on its way out.
    watch.timer.unref?.();
  }

  private async run(targetId: string, watch: Watch): Promise<void> {
    if (this.byTargetId.get(targetId) !== watch) return;
    watch.attempts += 1;
    try {
      await this.callbacks.attempt(targetId);
      this.stop(targetId);
    } catch (error) {
      // Disconnected, removed or already reconnected meanwhile.
      if (this.byTargetId.get(targetId) !== watch) return;
      const nextDelayMs = this.callbacks.onAttemptFailed(targetId, error, watch.attempts);
      if (nextDelayMs == null) {
        if (this.byTargetId.get(targetId) === watch) this.stop(targetId);
        return;
      }
      this.schedule(targetId, watch, nextDelayMs);
    }
  }
}
