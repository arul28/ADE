import { settleWithin } from "../shared/utils";

/**
 * The exit of the Pi worker each chat last released, by chat id.
 *
 * A Pi chat's session-file lease is freed only once its worker process has
 * exited, which a dispose allows about 1.5s before killing it. A restart on
 * the same file (a model switch, a tool-policy change) must wait for that
 * exit, or `acquirePiSessionLease` refuses the file as "already owned".
 */
export function createPiWorkerExitTracker(options: { maxWaitMs: number }) {
  const exits = new Map<string, Promise<void>>();
  return {
    /**
     * Releases a worker through `release`, which calls `onExit` once the
     * worker is gone, and remembers the exit for the chat's next launch.
     */
    release(chatId: string, release: (onExit: () => void) => void): void {
      const exit = new Promise<void>((resolve) => release(resolve));
      exits.set(chatId, exit);
      void exit.then(() => {
        if (exits.get(chatId) === exit) exits.delete(chatId);
      });
    },
    /** Waits for the chat's last released worker to exit, at most `maxWaitMs`. */
    async waitForExit(chatId: string): Promise<void> {
      const exit = exits.get(chatId);
      if (exit) await settleWithin(exit, options.maxWaitMs, undefined);
    },
    pending(chatId: string): boolean {
      return exits.has(chatId);
    },
  };
}
