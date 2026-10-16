/**
 * The client-level lifecycle events, in one dependency-free module.
 *
 * Kept apart from `client.ts` so the Electron protocol (which the sandboxed
 * preload bundles) can key its payload type by this map without importing the
 * client, and so the event list exists exactly once: `AdeChatClient.on`
 * validates against it, the Electron bridge subscribes to every name in it,
 * and the IPC payload type is derived from it.
 */

/**
 * Payloads of the client-level events, by name.
 *
 * These are about the RUNTIME, not about any one thread. A thread learns that
 * its runtime died from the synthetic `status` envelope on its own `status`
 * channel; a host learns it here, once.
 */
export type AdeClientEventMap = {
  /**
   * The runtime process this client spawned exited without `dispose()`.
   * `error` is the tail of its stderr, when it wrote any. Not emitted in attach
   * mode, where the client owns no process — watch `transport` there.
   */
  exit: { code: number | null; signal: string | null; error: string | null };
  /**
   * The socket to the runtime closed unexpectedly (`"closed"`), or an
   * `autoRestart` brought it back (`"reconnected"`).
   */
  transport: { state: "closed" | "reconnected"; error: string | null };
  /**
   * One `autoRestart` attempt finished. `attempt` counts from 1 per outage.
   * `final` is true when no further attempt follows for this outage: the
   * attempt succeeded (`ok: true`), or it failed and was the last one
   * `maxAttempts` allows (the client gave up; the runtime stays down until the
   * host creates a new client). SDK >= 0.4.
   */
  restart: { attempt: number; ok: boolean; error: string | null; final: boolean };
  /**
   * A thread left, or came back to, the host's active list through this
   * client: `threads.delete` (`"deleted"`), `threads.archive` (`"archived"`)
   * or `threads.unarchive` (`"unarchived"`). Emitted after the action
   * succeeds, whoever called it: host code in the main process, or a renderer
   * over the Electron bridge. A change made by another client of the same
   * runtime (ADE desktop) is not reported. SDK >= 0.4.
   */
  threadLifecycle: { key: string; change: "deleted" | "archived" | "unarchived" };
};

/** Every client-level event name, once. See {@link AdeClientEventMap}. */
export const ADE_CLIENT_EVENTS = ["exit", "transport", "restart", "threadLifecycle"] as const satisfies ReadonlyArray<
  keyof AdeClientEventMap
>;

/** The client-level event names. See {@link AdeClientEventMap}. */
export type AdeClientEvent = (typeof ADE_CLIENT_EVENTS)[number];

/** Whether a value is one of {@link ADE_CLIENT_EVENTS}. */
export function isAdeClientEvent(value: unknown): value is AdeClientEvent {
  return typeof value === "string" && (ADE_CLIENT_EVENTS as readonly string[]).includes(value);
}
