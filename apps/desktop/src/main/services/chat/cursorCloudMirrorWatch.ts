import {
  CURSOR_CLOUD_MIRROR_BACKOFF_MS,
  nextCursorCloudMirrorDelay,
  type CursorCloudMirrorRefreshResult,
} from "./cursorCloudConversation";

type CursorCloudMirrorWatch = {
  refCount: number;
  timer: ReturnType<typeof setTimeout> | null;
  delayMs: number;
};

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as { unref?: () => void }).unref?.();
}

export function createCursorCloudMirrorWatch(args: {
  refresh: (sessionId: string) => Promise<CursorCloudMirrorRefreshResult>;
}): {
  watch: (input: { sessionId: string; watching: boolean }) => void;
  clearAll: () => void;
} {
  const watches = new Map<string, CursorCloudMirrorWatch>();

  const stopTimer = (watch: CursorCloudMirrorWatch): void => {
    if (!watch.timer) return;
    clearTimeout(watch.timer);
    watch.timer = null;
  };

  const tick = (sessionId: string, delayMs: number): void => {
    const watch = watches.get(sessionId);
    if (!watch || watch.refCount <= 0) return;
    stopTimer(watch);
    const run = async (): Promise<void> => {
      const current = watches.get(sessionId);
      if (!current || current.refCount <= 0) return;
      let result: CursorCloudMirrorRefreshResult = "skipped";
      try {
        result = await args.refresh(sessionId);
      } catch {
        result = "skipped";
      }
      const still = watches.get(sessionId);
      if (!still || still.refCount <= 0) return;
      still.delayMs = nextCursorCloudMirrorDelay(delayMs, result);
      tick(sessionId, still.delayMs);
    };
    if (delayMs <= 0) {
      void run();
      return;
    }
    watch.timer = setTimeout(() => {
      void run();
    }, delayMs);
    unrefTimer(watch.timer);
  };

  const watch = (input: { sessionId: string; watching: boolean }): void => {
    const sessionId = input.sessionId.trim();
    if (!sessionId) return;
    if (!input.watching) {
      const current = watches.get(sessionId);
      if (!current) return;
      current.refCount -= 1;
      if (current.refCount > 0) return;
      stopTimer(current);
      watches.delete(sessionId);
      return;
    }

    let current = watches.get(sessionId);
    if (!current) {
      current = {
        refCount: 0,
        timer: null,
        delayMs: CURSOR_CLOUD_MIRROR_BACKOFF_MS[0],
      };
      watches.set(sessionId, current);
    }
    current.refCount += 1;
    if (current.refCount !== 1) return;
    current.delayMs = CURSOR_CLOUD_MIRROR_BACKOFF_MS[0];
    tick(sessionId, 0);
  };

  const clearAll = (): void => {
    for (const current of watches.values()) stopTimer(current);
    watches.clear();
  };

  return { watch, clearAll };
}
