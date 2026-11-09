/**
 * The bookkeeping behind "a sleeping cloud computer rests quietly". This file
 * only asks and remembers: one question per machine however many calls fail
 * together, two later questions after a dropped link, and which machines rest.
 * What resting does to the link and the status is the owner's call (`rest`).
 */
import type { RemoteRuntimeTarget } from "../../../shared/types/remoteRuntime";

export type CloudAsleepCheckCallbacks = {
  /** Whether the machine is a cloud computer that is asleep. Null at once when it isn't a cloud computer. */
  ask(target: RemoteRuntimeTarget): Promise<boolean> | null;
  /** Still a saved machine the person did not disconnect. */
  stillWanted(target: RemoteRuntimeTarget): boolean;
  /** The machine's link is down with an error, so a later question still has a point. */
  linkIsDown(targetId: string): boolean;
  /** Close the link and show the machine as not connected, with no error. */
  rest(target: RemoteRuntimeTarget): void;
};

export class CloudAsleepChecks {
  /** Machines found asleep: nothing dials one until a person uses it or a later question finds it awake. */
  private readonly restingTargetIds = new Set<string>();
  private readonly runningByTargetId = new Map<string, Promise<boolean>>();
  private readonly followUpsByTargetId = new Map<string, NodeJS.Timeout>();
  /** Goes up each time a machine answers or is connected on purpose; an answer older than that is dropped. */
  private readonly aliveStampByTargetId = new Map<string, number>();

  constructor(
    private readonly callbacks: CloudAsleepCheckCallbacks,
    /**
     * A computer going to sleep closes its link up to a minute before its
     * status says asleep (seen on a real one, 2026-11-09), so the first answer
     * after a dropped link is "no". These are the delays of the later questions.
     */
    private readonly followUpMs: readonly number[],
  ) {}

  isResting(targetId: string): boolean {
    return this.restingTargetIds.has(targetId);
  }

  aliveStamp(targetId: string): number {
    return this.aliveStampByTargetId.get(targetId) ?? 0;
  }

  /** The machine answered, or a person is connecting it: it is not asleep, and an older question is out of date. */
  noteAlive(targetId: string): void {
    this.restingTargetIds.delete(targetId);
    this.aliveStampByTargetId.set(targetId, this.aliveStamp(targetId) + 1);
    const followUp = this.followUpsByTargetId.get(targetId);
    if (followUp) clearTimeout(followUp);
    this.followUpsByTargetId.delete(targetId);
  }

  /** A later question found the machine awake: the next dial may go out. */
  endRest(targetId: string): void {
    this.restingTargetIds.delete(targetId);
  }

  /** Asks about a resting machine again. False when the question fails or the machine is no longer a cloud computer. */
  async stillAsleep(target: RemoteRuntimeTarget): Promise<boolean> {
    return await (this.askSafely(target) ?? false);
  }

  /**
   * A call or a dial failed the way a sleeping cloud computer fails. Rests the
   * machine when it is asleep. Null when nothing was asked (not a cloud computer).
   */
  afterFailure(target: RemoteRuntimeTarget): Promise<boolean> | null {
    const running = this.runningByTargetId.get(target.id);
    if (running) return running;
    const asked = this.askSafely(target);
    if (!asked) return null;
    const stamp = this.aliveStamp(target.id);
    const check = asked.then((asleep) => {
      this.runningByTargetId.delete(target.id);
      // Woken, reconnected, removed or disconnected by hand while the question was out.
      if (this.aliveStamp(target.id) !== stamp || !this.callbacks.stillWanted(target)) return false;
      if (!asleep) {
        this.askAgainLater(target, stamp, 0);
        return false;
      }
      this.rest(target);
      return true;
    });
    this.runningByTargetId.set(target.id, check);
    return check;
  }

  /** Ends every later question at once (the app is quitting). */
  stopAll(): void {
    for (const timer of this.followUpsByTargetId.values()) clearTimeout(timer);
    this.followUpsByTargetId.clear();
  }

  private askSafely(target: RemoteRuntimeTarget): Promise<boolean> | null {
    return this.callbacks.ask(target)?.catch(() => false) ?? null;
  }

  private rest(target: RemoteRuntimeTarget): void {
    this.restingTargetIds.add(target.id);
    this.callbacks.rest(target);
  }

  /** Asked again only while the link is still down and nothing reached the machine. */
  private askAgainLater(target: RemoteRuntimeTarget, stamp: number, asked: number): void {
    const delayMs = this.followUpMs[asked];
    if (delayMs == null || this.followUpsByTargetId.has(target.id)) return;
    const current = () =>
      this.aliveStamp(target.id) === stamp
      && this.callbacks.linkIsDown(target.id)
      && this.callbacks.stillWanted(target);
    const timer = setTimeout(() => {
      this.followUpsByTargetId.delete(target.id);
      if (!current()) return;
      void (this.askSafely(target) ?? Promise.resolve(false)).then((asleep) => {
        if (!current()) return;
        if (asleep) this.rest(target);
        else this.askAgainLater(target, stamp, asked + 1);
      });
    }, delayMs);
    timer.unref?.();
    this.followUpsByTargetId.set(target.id, timer);
  }
}
