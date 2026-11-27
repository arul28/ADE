/**
 * The client-level lifecycle events, in one dependency-free module.
 *
 * Kept apart from `client.ts` so the Electron protocol (which the sandboxed
 * preload bundles) can key its payload type by this map without importing the
 * client, and so the event list exists exactly once: `DaexChatClient.on`
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
export type DaexClientEventMap = {
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
   * runtime (Daex desktop) is not reported. SDK >= 0.4.
   */
  threadLifecycle: { key: string; change: "deleted" | "archived" | "unarchived" };
  /** A provider turn stopped because its current account reached a usage limit. */
  usageLimit: import("./types.js").UsageLimitEvent;
};

/** Every client-level event name, once. See {@link DaexClientEventMap}. */
export const DAEX_CLIENT_EVENTS = ["exit", "transport", "restart", "threadLifecycle", "usageLimit"] as const satisfies ReadonlyArray<
  keyof DaexClientEventMap
>;

/** The client-level event names. See {@link DaexClientEventMap}. */
export type DaexClientEvent = (typeof DAEX_CLIENT_EVENTS)[number];

/** Whether a value is one of {@link DAEX_CLIENT_EVENTS}. */
export function isAdeClientEvent(value: unknown): value is DaexClientEvent {
  return typeof value === "string" && (DAEX_CLIENT_EVENTS as readonly string[]).includes(value);
}

// Pre-Daex names, kept as deprecated aliases so code written against the
// `@ade-dev` packages keeps compiling. Remove them in a future major version.
/** @deprecated Use {@link DAEX_CLIENT_EVENTS}. */
export const ADE_CLIENT_EVENTS = DAEX_CLIENT_EVENTS;
/** @deprecated Use {@link DaexClientEvent}. */
export type AdeClientEvent = DaexClientEvent;
/** @deprecated Use {@link DaexClientEventMap}. */
export type AdeClientEventMap = DaexClientEventMap;
