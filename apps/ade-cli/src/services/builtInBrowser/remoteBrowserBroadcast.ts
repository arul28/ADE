import { randomUUID } from "node:crypto";

import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import {
  BUILT_IN_BROWSER_REMOTE_CALL_EVENT,
  type BuiltInBrowserRemoteBroadcastMethod,
  type BuiltInBrowserRemoteCall,
} from "../../../../desktop/src/shared/types/builtInBrowserRemote";

/**
 * Calls the daemon sends to every desktop that holds a pin on this machine at
 * once: a project's tab list (`listTabsForAgent`) and a lane's release.
 *
 * Nobody knows how many desktops there are, so a broadcast waits a short
 * while for answers. The desktops that answered a tab list are remembered:
 * the next list waits for them (a little longer) and ends as soon as they
 * have all answered. When no desktop answered, the next lists are skipped for
 * two minutes, or until a desktop takes a command, so a machine with no other
 * desktop does not pay the wait on every `ade browser status`.
 */

/** How long a broadcast waits when no desktop has answered one before. */
const FIRST_WAIT_MS = 1_200;
/** How long a broadcast waits for the desktops that answered the last ones. */
const KNOWN_WAIT_MS = 3_000;
/** Desktops remembered as answering. */
const ANSWERING_DESKTOP_CAP = 16;
/**
 * After a tab list nobody answered, how long tab lists are skipped. A desktop
 * that takes any command ends the skip at once (`noteDesktopSeen`).
 */
const EMPTY_LIST_SKIP_MS = 2 * 60_000;
/** Tab lists that already ended, kept so a desktop that answers late is waited for next time. */
const FINISHED_LIST_CAP = 32;

export type BroadcastReply = { label: string; ok: boolean; result: unknown };

type PendingBroadcast = {
  method: BuiltInBrowserRemoteBroadcastMethod;
  /** Desktops that answered the last tab lists; the wait ends early once they all have. */
  expected: Set<string>;
  taken: Set<string>;
  replies: Map<string, BroadcastReply>;
  resolve: (replies: Map<string, BroadcastReply>) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type RemoteBrowserBroadcaster = ReturnType<typeof createRemoteBrowserBroadcaster>;

export function createRemoteBrowserBroadcaster(args: {
  emitEvent: (payload: Record<string, unknown>) => void;
  logger: Logger;
  /** How long a broadcast waits; tests shorten it. */
  waitMs?: { first: number; known: number } | null;
}) {
  const wait = args.waitMs ?? { first: FIRST_WAIT_MS, known: KNOWN_WAIT_MS };
  const pending = new Map<string, PendingBroadcast>();
  const answering = new Set<string>();
  const finishedLists = new Set<string>();
  let lastEmptyListAt = 0;

  function rememberAnswering(clientId: string): void {
    answering.delete(clientId);
    answering.add(clientId);
    while (answering.size > ANSWERING_DESKTOP_CAP) {
      const oldest = answering.values().next().value;
      if (oldest === undefined) break;
      answering.delete(oldest);
    }
    // A desktop exists after all: the next status asks again.
    lastEmptyListAt = 0;
  }

  function finish(requestId: string): void {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    if (entry.method === "listTabsForAgent") {
      // A desktop that stopped answering is not waited for next time.
      for (const clientId of entry.expected) if (!entry.replies.has(clientId)) answering.delete(clientId);
      finishedLists.add(requestId);
      while (finishedLists.size > FINISHED_LIST_CAP) {
        const oldest = finishedLists.values().next().value;
        if (oldest === undefined) break;
        finishedLists.delete(oldest);
      }
    }
    entry.resolve(entry.replies);
  }

  function send(
    method: BuiltInBrowserRemoteBroadcastMethod,
    input: Record<string, unknown>,
    options: {
      chatSessionId?: string | null;
      laneId?: string | null;
      collection?: "project" | "personal";
      excludeClientIds?: string[];
      waitMs?: number;
    } = {},
  ): Promise<Map<string, BroadcastReply>> {
    const exclude = options.excludeClientIds ?? [];
    const expected = method === "listTabsForAgent"
      ? new Set([...answering].filter((id) => !exclude.includes(id)))
      : new Set<string>();
    const waitMs = options.waitMs ?? (expected.size > 0 ? wait.known : wait.first);
    const call: BuiltInBrowserRemoteCall = {
      requestId: `bbb-${randomUUID()}`,
      method,
      input,
      chatSessionId: options.chatSessionId ?? null,
      laneId: options.laneId ?? null,
      requestedAt: new Date().toISOString(),
      targetClientId: "",
      broadcast: true,
      ...(exclude.length > 0 ? { excludeClientIds: exclude } : {}),
      ...(options.collection ? { collection: options.collection } : {}),
    };
    return new Promise((resolve) => {
      const entry: PendingBroadcast = {
        method,
        expected,
        taken: new Set(),
        replies: new Map(),
        resolve,
        timer: setTimeout(() => finish(call.requestId), waitMs),
      };
      entry.timer.unref?.();
      pending.set(call.requestId, entry);
      try {
        args.emitEvent({ type: BUILT_IN_BROWSER_REMOTE_CALL_EVENT, event: call });
      } catch (error) {
        args.logger.warn("built_in_browser.remote_broadcast_emit_failed", {
          method,
          reason: error instanceof Error ? error.message : String(error),
        });
        finish(call.requestId);
      }
    });
  }

  return {
    send,
    /**
     * A tab list, or nothing when no desktop answered one lately (and none
     * outside `exclude` is known): the wait would only find nobody again.
     */
    async listTabs(
      input: Record<string, unknown>,
      options: { chatSessionId: string | null; laneId: string | null; collection: "project" | "personal"; exclude: string[]; alwaysAsk?: boolean },
    ): Promise<Map<string, BroadcastReply>> {
      const quiet = !options.alwaysAsk
        && ![...answering].some((id) => !options.exclude.includes(id))
        && Date.now() - lastEmptyListAt < EMPTY_LIST_SKIP_MS;
      if (quiet) return new Map();
      const replies = await send("listTabsForAgent", input, {
        chatSessionId: options.chatSessionId,
        laneId: options.laneId,
        collection: options.collection,
        excludeClientIds: options.exclude,
      });
      if (![...replies].some(([clientId, reply]) => reply.ok && !options.exclude.includes(clientId))) {
        lastEmptyListAt = Date.now();
      }
      return replies;
    },
    /** A desktop took a command: it is there, so the next tab list asks again. */
    noteDesktopSeen(): void {
      lastEmptyListAt = 0;
    },
    /** Desktops that answered tab lists lately, most recent last. */
    answeringDesktops: (): string[] => [...answering],
    /**
     * A desktop's reply to a broadcast: `null` when the id is not one, so the
     * caller treats it as a reply to a targeted call.
     */
    reply(
      requestId: string,
      record: Record<string, unknown> & { clientId: string | null; label: string },
    ): { ok: boolean } | null {
      const entry = pending.get(requestId);
      if (!entry) {
        if (!finishedLists.has(requestId)) return null;
        // Too late for that list, but the desktop is there: wait for it next time.
        if (record.clientId) rememberAnswering(record.clientId);
        return { ok: false };
      }
      // Any desktop may answer a broadcast, once.
      const clientId = record.clientId;
      if (!clientId) return { ok: false };
      if (record.phase === "taken") {
        entry.taken.add(clientId);
        return { ok: true };
      }
      if (record.phase !== "done" || entry.replies.has(clientId)) return { ok: false };
      entry.replies.set(clientId, { label: record.label, ok: record.ok === true, result: record.ok === true ? record.result : null });
      if (record.ok === true && entry.method === "listTabsForAgent") rememberAnswering(clientId);
      const waitingOn = [...entry.expected, ...entry.taken].filter((id) => !entry.replies.has(id));
      if (entry.expected.size > 0 && waitingOn.length === 0) finish(requestId);
      return { ok: true };
    },
    dispose(): void {
      for (const requestId of [...pending.keys()]) finish(requestId);
    },
  };
}
